# Optimizations

This document describes the optimizations that are actually present in the
codebase, how they were verified, and what they measure. (An earlier version
of this file described several changes that had not in fact landed; the code
is the ground truth, and this revision matches it.)

## xBRZ WASM engine (rewrite)

The xBRZ kernel was rewritten around one idea: every colour distance the
algorithm can ask for is between two pixels at most a knight's move apart, so
each distance can be computed once per row instead of up to ten times per
pixel. Output is defined by a *minimal-change reference*: the original port
with only three corrections (exact colour distance, Zenju's exact-inequality
line test, Zenju's first-column corner bookkeeping). The new engine reproduces
that reference byte for byte.

### Structure (`src/wasm/xbrz/engine.rs`)

- **Streaming bands, O(width) memory.** Ring buffers hold padded source rows
  (two transparent pixels on every side, so nothing needs a bounds branch),
  distance planes and corner decisions. `render_band(y0, y1)` produces any
  band of output rows; bands carry their own 2-row halo and stack
  byte-identically. That one primitive serves the serial path, the rayon
  stripes (previously broken: every stripe hit a length assert and panicked),
  the `xbrz_upscale_band` export and `WasmXbrzPool`.
- **Distance planes.** Per row, `H`/`V`/`D`/`A` neighbour distances are
  computed in one fused SIMD pass: four lanes, shared loads, and an exact zero
  shortcut when all eight pixels are equal (the common flat-area case).
  Knight-move planes are computed only on *dense* rows (more than half the
  pixels blend) and are cached per row. Sparse rows compute the two knight
  distances on demand.
- **Corner pre-pass as a stencil.** Zenju's `jg`/`fk` gradient sums are
  plus-shaped stencils over the `A`/`D` planes, evaluated with exactly the
  reference operands and summation order (f32 is not associative). Four
  blocks per step, branch-free, with a zero shortcut for flat runs.
- **Output.** The first destination row of each band row is expanded (N copies
  of each pixel) and `copy_within`-replicated to the other N-1 rows
  (`memory.copy`). Only pixels with a blended corner reach `blend_pixel`;
  runs of 8 non-blending pixels are skipped with one 64-bit test per row.
- **Data-driven blend tables.** The 2x..8x shapes are const `(row, col, M, N)`
  tables, resolved once per band into flat offset lists for the output stride
  and rotation. This replaces ~250 KB of monomorphised straight-line code with
  a short loop. Divisions by the constant N use an exact reciprocal multiply,
  proven exhaustive in the tests. `blend_pixel` is generic only over the
  rotation, and evaluates eagerly on dense rows and short-circuits on sparse
  ones (measured best for each regime).

### Decisions backed by measurement

- Knight planes on *every* row made gradient and sprite art 30-80% slower
  (eight unfused passes for few line blends). Never computing them made noisy
  art ~10% slower. The 50% dense-row threshold is at parity or better on
  every input.
- A branch-free scalar distance (alpha via table) mispredicted less on random
  alpha but cost 3-5% on opaque art. The final version keeps an
  opaque fast path.
- The SIMD path and the scalar path run the same IEEE operations per lane, with
  no FMA contraction, so native, wasm-scalar and wasm-SIMD outputs are
  bit-identical.

### Verification

- Differential fuzzing against the frozen reference: 70k+ random cases over 5
  image families (palette with alpha, gradient bands, random RGBA, sprites,
  near-ties), sizes 1..67, scales 1..8 and random configs. Includes band
  splits with minimal halo windows and the rayon build. Mutation checks: a
  single f32 reassociation, a `<`/`<=` swap in the SIMD pre-pass and a wrong
  knight-plane row are each caught.
- The actual wasm binaries (SIMD and scalar) are checked against a 12k-case
  reference corpus in Node.
- `GOLDEN_XBRZ` was re-captured from the reference build, not the engine
  (scales 1..8 plus a gradient regression image). The CRT and HEX goldens are
  unchanged.
- In headless Chromium (SwiftShader WebGL2) the GPU shaders and the wasm
  engine agree to within +-2 levels in the image interior at all scales.

### Results

Render-only, Node 22 / V8, 256x256 source, single thread:

| | 2x | 4x | 8x |
|---|---|---|---|
| gradient art | 2.61 -> 0.93 ms | 2.97 -> 1.24 ms | 5.56 -> 2.17 ms |
| sprites | 1.72 -> 0.52 ms | 2.12 -> 0.71 ms | 4.98 -> 1.40 ms |
| random noise | 12.5 -> 5.5 ms | 13.7 -> 6.5 ms | 17.0 -> 9.9 ms |

The wasm binary went from 260 KB to 63 KB. At 8x a flat image renders within
~10% of a bare 16.8 MB `fill`. The next lever is the caller: copying a 67 MB
result into a fresh array costs 4-8x the render, so `WasmRenderer` now offers
zero-copy views and reusable output buffers.

### Build pipeline

`npm run build` produces the SIMD single-threaded module on the stable
toolchain. The old default build went through the nightly atomics build,
which produced a module with private, unshareable memory: atomics on, but no
working thread pool. `npm run build:wasm:threads` (and `build:all`) emits the
optional rayon variant to `dist/wasm-threads` with the shared-memory link
flags it needs. That variant measured 2x on 2 threads when called from a
worker.

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

(Superseded by the xBRZ rewrite above: the YCbCr lookup table, `OnceLock`
and per-call distance memoisation described in earlier revisions are gone;
the distance is computed exactly and shared through the distance planes.)

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
