# Optimizations

This document describes the optimizations that are actually present in the
codebase, how they were verified, and what they measure. (An earlier version
of this file described several changes that had not in fact landed; the code
is the ground truth, and this revision matches it.)

## GPU path: crash fixes

The WebGL2 renderers previously crashed under load for four compounding
reasons, all fixed in `gpu-context.ts` and the three renderers.

**Unbounded render target.** Output used the shared OffscreenCanvas
backbuffer with a grow-only sizing strategy and no validation against the
device's limits. A 256×256 hex render at scale 32 requests a ~12,300×14,200
buffer (~700 MB), and because the canvas kept the maximum of every width and
every height ever rendered, a wide render followed by a tall one pinned a
giant rectangle permanently. This was the primary source of GPU OOM and
context loss. Pixel readback now renders into an FBO-backed texture sized
exactly to the current output, reallocated only when dimensions change, and
the canvas backbuffer stays at 1×1 on that path. All renderers validate
output dimensions against the real GL limits (`MAX_TEXTURE_SIZE`,
`MAX_RENDERBUFFER_SIZE`, `MAX_VIEWPORT_DIMS`) up front via
`assertOutputSize()` and throw a descriptive error instead of taking the
driver down. `getMaxOutputDimension()` is exported so applications can clamp
a scale factor before rendering.

**No context-loss handling.** A lost context previously left stale programs
and textures cached forever. The context now registers
`webglcontextlost`/`webglcontextrestored` handlers (with `preventDefault()`,
which is required for the browser to restore at all), bumps a generation
counter, and clears every cached GPU object. Renderers compare their stored
generation in `ensureResources()` and lazily recompile programs and recreate
textures after a restore. The fence-polling loop in `readPixelsAsync` also
checks `isContextLost()` so a loss rejects promptly instead of spinning
forever.

**Concurrent async renders corrupted the shared pack buffer.** Two
overlapping `renderAsync` calls shared one `PIXEL_PACK_BUFFER`; the second
call's `bufferData` orphaned the first call's pending readback. All async
GPU work is now serialized through `runExclusive()`, a promise-chain mutex in
the shared context. Concurrent calls (for example several messages hitting
the render worker at once) simply queue.

## GPU path: ImageBitmap I/O

Renderers accept `ImageBitmap` (and `ImageData`) as input in addition to raw
RGBA arrays; the browser uploads bitmaps to the texture directly, often
without a CPU copy. More importantly, each renderer gains
`renderToBitmap()`, which draws into the canvas backbuffer at exact size and
hands it off via `transferToImageBitmap()` with no GPU→CPU readback at all.
When the result is going to be drawn rather than inspected, this removes the
single most expensive and stall-prone step of the pipeline. A `uFlipY`
vertex-shader uniform selects the framebuffer orientation (0.0 for top-down
`readPixels` output, 1.0 for direct presentation); it is applied to the
sampled coordinate before any neighbor taps are derived, so the effect math
of all three algorithms is unaffected. The worker protocol exposes this as
`output: 'bitmap'`, with the resulting `ImageBitmap` transferred zero-copy,
and `WorkerRenderer` adds `crtToBitmap`/`hexToBitmap`/`xbrzToBitmap`.
`trimMemory()` releases the render target, pack buffer and canvas backbuffer
without destroying the context. `WorkerRenderer` is now exported from the
package index.

## Rust/WASM kernels

Every kernel change was verified byte-for-byte against the original
implementation: `src/wasm/golden_tests.rs` hashes the output of each kernel
(FNV-1a) over a matrix of seeded pseudo-random inputs, sizes, scales and
configurations, with the expected hashes captured from the pre-optimization
code. All tests pass, so output is provably identical.

The xBRZ YCbCr lookup replaced a `static mut` initialized through
`parking_lot::Once` (undefined behavior under current Rust rules, and the
crate's only dependency besides wasm-bindgen) with `std::sync::OnceLock`,
and added a const-evaluated `i/255.0` table that removes two float divides
from `dist()`, which runs ten-plus times per source pixel. The scaler's
`blend_pixel` lazily memoizes `dist(e,g)` and `dist(e,c)`, each of which
could be computed twice per call, preserving exact short-circuit semantics.
`pixel.rs` fixes a `todo!()` panic in `Rgb8::gradient` and derives
`bytemuck` traits so the previous hand-rolled `align_to`/`from_raw_parts`
casts could be replaced with safe `cast_slice`.

CRT moved its gamma table from a per-call `Vec` to a process-wide
`OnceLock`, builds its scanline table on the stack, and precomputes a
per-frame column LUT carrying the normalized u and Y-warp factor per output
column, removing a divide and several multiplies per pixel. Hex gained the
same column-LUT treatment for the axial transform, a source-cell cache that
skips bounds checks and fetches within a hexagon's span, and border testing
against precomputed rounded coordinates, eliminating a redundant `hex_round`
(three `round()` calls) per border pixel.

All three kernels expose `*_into` variants that write every byte of a
caller-provided buffer, and the wasm exports in `lib.rs` route through a
thread-local buffer via `with_buffer`, so steady-state rendering performs no
heap allocation and no output memcpy. The previous code allocated a fresh
output `Vec` per call and then copied it wholesale into the shared buffer.

Measured on native x86-64 (release, `cargo run --release --example bench`,
256×256 input), original versus optimized with buffer reuse: hex ×12 with
borders 599.1 → 405.4 ms (−32%), xBRZ ×4 12.6 → 10.8 ms (−14%), xBRZ ×2
10.9 → 9.1 ms (−17%), CRT ×4 46.9 → 45.0 ms (−4%). CRT is bound by bilinear
filtering and three float divides per pixel whose order cannot be changed
without altering output bits; relaxing exact-output parity (reciprocal
multiplication, precomputed bilinear weights) would yield roughly another
15–20% there.

Regenerating goldens after an intentional behavior change:
`GOLDEN_CAPTURE=1 cargo test golden -- --nocapture`, then paste the printed
constants into `golden_tests.rs`.

## CUT3 — Cheap Upscaling Triangulation (new effect)

The package now ships CUT3, a three-pass content-adaptive upscaler ported
from "Cheap Upscaling Triangulation" by Filippo Scognamiglio
(https://github.com/Swordfish90/cheap-upscaling-triangulation). Pass 0
triangulates the luma plane of every 2×2 quad and measures soft
(anti-aliased) edges; pass 1 walks along hard edges up to a configurable
distance to derive per-side blend weights; pass 2 interpolates the output
inside each quad, splitting diagonal quads into two triangles. The result
keeps axis-aligned edges pixel-sharp while turning diagonal staircases into
clean slopes, and re-sharpens anti-aliased content.

**Licensing — important.** The upstream project is GPL-3.0; the ported
files (`src/cut-shaders.ts`, `src/cut-gpu.ts`, `src/wasm/cut.rs`) are
derivative works and carry the GPL-3.0 header. This package's manifest
currently declares MIT, and MIT and GPL-3.0 cannot both apply to the
combined distributed work: shipping CUT3 means the package as distributed
must comply with GPL-3.0 (or the CUT3 files must be split into a separate,
GPL-licensed optional package, or a different license obtained from the
author). This needs a deliberate decision before the next publish.

Both implementations land behind the same API as the other effects:
`CutGpuRenderer` / `createRenderer.cut()` with `render`, `renderAsync`,
`renderToBitmap` on the GPU side (three WebGL2 programs, two renderer-owned
input-sized RGBA8 intermediates, final pass through the shared render
target so context-loss recovery, the async fence readback and the zero-copy
ImageBitmap path all work unchanged), `WorkerRenderer.cut` /
`cutToBitmap` off the main thread, and `cut_upscale` /
`cut_upscale_config` in the WASM module with `WasmRenderer.renderCut`.
Options mirror the upstream `#define` block (defaults identical to the
upstream demo); both sides apply the same parameter sanitation so a given
option set means the same thing on GPU and CPU.

Port notes worth knowing. Intermediate passes are stored in RGBA8 exactly
as upstream's render targets, including on the CPU (quantized u8 buffers),
because the algorithm's bit-packing nudges (+1/512, +0.125) are tuned for
8-bit storage. The GLSL's formally-undefined partially-assigned
`edgesWeights` array is explicitly zero-filled (the behavior the algorithm
relies on). One inherited quirk is documented and asserted in
`cut.rs` tests: the packed code point (8,0) lands exactly on the 127.5
unorm8 rounding tie and decodes with a 1/12 error on one edge weight —
true of the original on any GPU as well. The CPU port indexes passes 0/1
with integers (proven equivalent to the shader coordinate math for
dimensions ≤ 16384) and replicates the float coordinate math in pass 2,
with a per-quad cache so flag parsing and quad fetches amortize across the
scale² output pixels of each source cell (103.8 → 77.2 ms at 256² ×4,
byte-identical output per the golden tests).

CPU cost on the bench machine: cut3 256×256 ×4 = 77.2 ms (vs xBRZ ×4
10.8 ms — CUT3 does roughly an order of magnitude more arithmetic per
output pixel; the GPU path is the intended interactive route). The CUT
golden hashes are self-captured from this port (there is no pre-existing
CPU reference), locking behavior for future refactors. The six GPU shaders
validate and link clean under glslangValidator as GLSL ES 3.00.
