# RenderArt — Optimization & Multi-threading Changes

This document describes the WebGL, Web Worker, and Rust/WASM multi-threading
work, the reasoning behind each change, and — importantly — what was and was not
verified in this environment.

---

## ⚠️ Verification status (read first)

| Area | Verified here? | How |
|------|----------------|-----|
| TypeScript (all `src/*.ts`) | ✅ Yes | `tsc --noEmit` passes cleanly on the full project |
| Rust serial correctness refactors | ⚠️ Reasoned, **not compiled** | No Rust toolchain was available in this environment |
| Rust `parallel` feature (rayon) | ⚠️ Best-effort, **not compiled** | Provided with exact build/deploy steps; needs a real nightly toolchain to validate |

The TypeScript layer compiles and type-checks. The Rust changes were written
carefully and reviewed line-by-line, but **could not be compiled or run here**,
so they should be built and tested before release. The single-threaded code
paths were kept byte-for-byte equivalent to the originals wherever possible to
minimise risk; the multi-threaded paths are entirely behind the `parallel`
feature flag and do not affect the default build.

---

## 1. WebGL optimizations (TypeScript)

### 1.1 Asynchronous pixel readback (biggest win)

**Problem.** Each renderer called `gl.readPixels` synchronously after drawing.
`readPixels` forces the CPU to wait for the entire GPU pipeline to flush, which
stalls the calling thread on every frame.

**Change.** Added `readPixelsAsync()` to the shared GPU context
(`gpu-context.ts`). It:
1. binds a reusable **Pixel Buffer Object** (`PIXEL_PACK_BUFFER`),
2. issues `readPixels` into the PBO (returns immediately — no CPU stall),
3. inserts a `fenceSync` and polls it with a non-blocking
   `clientWaitSync(..., 0)` loop driven by `setTimeout`,
4. copies the data out with `getBufferSubData` once the fence signals.

Each GPU renderer now exposes `renderAsync()` built on this, in addition to the
original synchronous `render()`. A private `submit()` method holds the shared
draw logic so the two entry points cannot drift apart.

The pack buffer is **grow-only and reused** across calls, and `renderAsync()`
optionally accepts a caller-provided output buffer to avoid per-frame
allocations.

### 1.2 Program-state caching

**Problem.** CRT and hex called `gl.useProgram` on every render. When multiple
renderers share one context this is both redundant work and an *interleaving
hazard* (whichever program was bound last wins).

**Change.** `useProgram(program)` in the shared context tracks the
currently-bound program and skips the GL call when it is already current. All
three renderers route through it, which removes the redundant binds and the
hazard.

### 1.3 Context creation flags / pixel store

Added `preserveDrawingBuffer: false` and set `PACK_ALIGNMENT` / `UNPACK_ALIGNMENT`
to `1` so tightly-packed RGBA readback and upload behave predictably.

### 1.4 Analytical hex border in the GPU shader

**Problem.** The hex **GPU** shader detected borders by sampling neighbouring
hex cells in a loop — `O(thickness²)` work per pixel and an approximation of the
true cell edge.

**Change.** Replaced it with the same closed-form hex-edge-distance test the
Rust/WASM hex renderer already uses (`dist = max(|q-cq|, |r-cr|, |s-cs|)`,
compared against `0.5 - thickness*0.55/scale`). This is `O(1)` per pixel and
makes the GPU and WASM borders **consistent with each other**.

> **Behavioural note.** Because the GPU border model changed from a
> morphological/neighbour approximation to the analytical model, `drawBorders`
> output may differ very slightly at the same `borderThickness`. This is an
> intentional consistency improvement. Adjust thickness if you need pixel-exact
> parity with older output.

### 1.5 What was deliberately left alone

`xbrz-shaders.ts` is already heavily optimized (vertex-shader texcoord
precomputation, per-scale unrolled fragment shaders). Touching it is high-risk
for little gain, so it was not modified.

---

## 2. Off-main-thread rendering (Web Worker)

New files:

- `worker-protocol.ts` — shared request/response message types.
- `render-worker.ts` — a module worker that lazily constructs the GPU renderers
  against its own `OffscreenCanvas` WebGL2 context, runs `renderAsync()`, and
  posts the result back **transferring** the pixel `ArrayBuffer` (zero-copy).
- `worker-client.ts` — `WorkerRenderer`, the main-thread handle with
  `crt()` / `hex()` / `xbrz()` (each returning a `Promise<ImageOutput>`) and
  `dispose()`. Requests are tracked by id; input pixels are copied into a fresh
  transferable buffer so the caller's data is never detached.

Because the heavy work (upload, draw, readback) happens in the worker and only
transferable buffers cross the boundary, the UI thread stays responsive even for
large frames.

Exposed via `package.json` exports: `@pixagram/upscaler/worker` and
`@pixagram/upscaler/render-worker`, and re-exported from the package root.

Requires `OffscreenCanvas` with a WebGL2 context (Chromium and recent Firefox;
Safari varies).

---

## 3. Rust / WASM multi-threading (`parallel` feature)

> All of this is **opt-in** and behind `#[cfg(feature = "parallel")]`. The
> default build is unchanged and needs no special headers or toolchain.

### 3.1 Thread-safe lookup table — `ycbcr_lookup.rs`

The global YCbCr colour-distance table previously used `static mut` plus a
`parking_lot::Once`. The unchecked read path was unsound under threads.

**Change.** Replaced it with `std::sync::OnceLock<YCbCrLookup>`:
- `instance()` → `get_or_init(...)`
- `initialise()` → `let _ = Self::instance();`
- `instance_unchecked()` → `LOOKUP_INSTANCE.get().unwrap_unchecked()`
- `instance_is_initialised()` → `LOOKUP_INSTANCE.get().is_some()`

`OnceLock` is safe for concurrent reads and guarantees single initialisation,
which is exactly what the parallel scaler needs. This also **removed the
`parking_lot` dependency** entirely.

### 3.2 Stripe-relative destination — `xbrz/scaler.rs`

`scale_image` already accepted a `y_range` and recomputed its preprocessing per
stripe (the original author left a comment that this must not share state across
stripes — i.e. it was designed for exactly this). It only needed to address its
destination **relative to the stripe** rather than by absolute `y`:

- assertion is now `destination.len() == dest_width * (y_last - y_first) * SCALE`
- row offset is now `(y - y_first) * SCALE * dest_width`

For the single-stripe (serial) caller `y_first == 0`, so this is identical to
the previous behaviour.

### 3.3 Parallel dispatch — `xbrz/mod.rs`

Added a generic `run_scaler::<P, S, N>()` that:
- **serial** (`not(parallel)`): calls `scale_image(.., 0..src_height)` exactly as
  before;
- **parallel**: initialises the YCbCr table once on the calling thread, then uses
  `rayon`'s `par_chunks_mut(chunk_len)` to hand each worker a **disjoint**
  mutable destination stripe and the matching source `y` range. Stripe height is
  `ceil(src_height / current_num_threads)`.

The chunk length is chosen so each `par_chunks_mut` chunk's length is exactly
what `scale_image`'s assertion expects, including the (smaller) final chunk. The
`Pixel` bound on `scale` / `scale_with_config` / `run_scaler` gained
`+ Send + Sync` (satisfied automatically by the plain-data `Rgba8`).

### 3.4 Parallel CRT and hex — `crt.rs`, `hex.rs`

Both kernels were simple nested `for y { for x { … } }` loops. The per-row body
was extracted into `crt_render_row` / `hex_render_row` and the destination
addressing changed from a global `(y*out_w + x)*4` offset to a row-relative
`x*4`. The per-pixel maths is otherwise **unchanged**.

Each function is then driven by either a serial `for` loop or, under `parallel`,
`output.par_chunks_mut(out_w*4).enumerate().for_each(...)`. Output rows are
independent, so no synchronisation is needed.

### 3.5 Thread-pool export — `lib.rs`

```rust
#[cfg(feature = "parallel")]
pub use wasm_bindgen_rayon::init_thread_pool;
```

This generates the JS `initThreadPool` binding. The `thread_local!`
`SHARED_BUFFER` is fine: the final `update_buffer` runs on the calling
(main) thread after the parallel region returns.

### 3.6 `Cargo.toml`

```toml
[dependencies]
wasm-bindgen = "0.2.92"
bytemuck = "1.24.0"
rayon = { version = "1.10", optional = true }
wasm-bindgen-rayon = { version = "1.2", optional = true }

[features]
default = []
parallel = ["dep:rayon", "dep:wasm-bindgen-rayon"]
large_lut = []
```

- `parking_lot` removed.
- `large_lut` is now a **declared** feature (the code already referenced
  `#[cfg(feature = "large_lut")]`; declaring it silences the unexpected-cfg lint
  and makes the larger 888 table actually selectable).
- `rayon` / `wasm-bindgen-rayon` are optional and only compiled for `parallel`.

> Version pins for `rayon` / `wasm-bindgen-rayon` should be checked against your
> installed `wasm-bindgen` when you build; `wasm-bindgen-rayon` must be
> compatible with the `wasm-bindgen` version in use.

### 3.7 Build & run

See the **Multi-threading (WASM)** section of `README.md`. In short:

```bash
npm run build:threads   # nightly + atomics + build-std + --features parallel
```

Serve cross-origin-isolated (COOP `same-origin`, COEP `require-corp`), then:

```js
await init();
if (self.crossOriginIsolated) await initThreadPool(navigator.hardwareConcurrency);
```

---

## 4. Suggested validation checklist (before release)

1. `npm run build` (stable) — confirm the **default** single-threaded build still
   compiles and produces identical output to the current release.
2. `cargo test` for the xBRZ crate — the existing `ycbcr_lookup` tests should
   still pass with `OnceLock`.
3. Golden-image diff of CRT / hex / xBRZ WASM output before vs after the
   per-row/stripe refactor — expect **identical** bytes in serial mode.
4. `npm run build:threads` on a nightly toolchain — confirm the `parallel`
   feature compiles and links `initThreadPool`.
5. In a cross-origin-isolated page, confirm threaded output matches serial output
   and measure the speedup across core counts.
6. Confirm the hex **GPU** border change is acceptable, or expose a flag to
   restore the previous approximation if pixel-exact parity is required.
