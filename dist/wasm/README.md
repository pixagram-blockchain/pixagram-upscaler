# RenderArt

High-performance pixel art rendering engines with WebGL2 GPU acceleration and WebAssembly support.

## Features

- **CRT Effect** - Authentic CRT display simulation with scanlines, shadow mask, and barrel distortion
- **Hexagonal Grid** - Transform pixel art into hexagonal pixel representations
- **xBRZ Upscaling** - Advanced pixel art upscaling algorithm (2x-8x) that preserves sharp edges

All renderers are available in two implementations:
- **GPU (WebGL2)** - High-performance fragment shader-based rendering
- **WASM** - Rust-compiled, SIMD-accelerated WebAssembly (no WebGL2 needed)

Performance features:
- **Non-blocking GPU readback** via `renderAsync()` (PBO + fence)
- **Off-main-thread rendering** via `WorkerRenderer` (OffscreenCanvas in a worker)
- **Optional multi-threaded WASM** via a `rayon` thread pool (opt-in build)

## Installation

```bash
npm install @pixagram/upscaler
```

## Quick Start

```typescript
import { CrtGpuRenderer, HexGpuRenderer, XbrzGpuRenderer } from '@pixagram/upscaler';

// Create a renderer
const crt = CrtGpuRenderer.create();

// Render an image
const result = crt.render(imageData, {
  scale: 3,
  warpX: 0.015,
  warpY: 0.02,
  scanOpacity: 0.5,
  maskOpacity: 0.3,
});

// Use the result
const outputImageData = new ImageData(result.data, result.width, result.height);

// Clean up when done
crt.dispose();
```

## CRT Renderer

Simulates classic CRT display characteristics including barrel distortion, scanlines, and RGB shadow mask.

```typescript
import { CrtGpuRenderer, CRT_PRESETS } from '@pixagram/upscaler';

const renderer = CrtGpuRenderer.create();

// Use default settings
const output = renderer.render(input, { scale: 3 });

// Or use a preset
const output = renderer.render(input, {
  ...CRT_PRESETS.authentic,
  scale: 4,
});

// Available presets: default, authentic, subtle, flat
```

### CRT Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scale` | number | 3 | Output scale factor (2-32) |
| `warpX` | number | 0.015 | Horizontal barrel distortion |
| `warpY` | number | 0.02 | Vertical barrel distortion |
| `scanHardness` | number | -4.0 | Scanline edge sharpness |
| `scanOpacity` | number | 0.5 | Scanline visibility (0-1) |
| `maskOpacity` | number | 0.3 | Shadow mask visibility (0-1) |
| `enableWarp` | boolean | true | Enable barrel distortion |
| `enableScanlines` | boolean | true | Enable scanline effect |
| `enableMask` | boolean | true | Enable shadow mask |

## Hexagonal Renderer

Transforms rectangular pixels into a hexagonal grid pattern.

```typescript
import { HexGpuRenderer, hexGetDimensions, HEX_PRESETS } from '@pixagram/upscaler';

const renderer = HexGpuRenderer.create();

// Get output dimensions before rendering
const dims = hexGetDimensions(inputWidth, inputHeight, 16, 'flat-top');
console.log(`Output: ${dims.width}x${dims.height}`);

// Render
const output = renderer.render(input, {
  scale: 16,
  orientation: 'flat-top',
  drawBorders: true,
  borderColor: '#282828',
});

// Available presets: default, bordered, pointy
```

### Hex Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scale` | number | 16 | Hexagon size (2-32) |
| `orientation` | string | 'flat-top' | 'flat-top' or 'pointy-top' |
| `drawBorders` | boolean | false | Draw borders between hexagons |
| `borderColor` | string/number | '#282828' | Border color |
| `borderThickness` | number | 1 | Border width in pixels |
| `backgroundColor` | string/number | 'transparent' | Background color |

## xBRZ Renderer

Implements the xBRZ pixel art upscaling algorithm, which intelligently interpolates edges while preserving pixel art characteristics.

```typescript
import { XbrzGpuRenderer, XBRZ_PRESETS } from '@pixagram/upscaler';

const renderer = XbrzGpuRenderer.create();

// 4x upscale with default settings
const output = renderer.render(input, { scale: 4 });

// Use sharp preset for crisper edges
const output = renderer.render(input, {
  ...XBRZ_PRESETS.sharp,
  scale: 3,
});

// Available presets: default, sharp, smooth, colorful
```

### xBRZ Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scale` | number | 2 | Scale factor (2-8) |
| `luminanceWeight` | number | 1.0 | Weight for luminance in color comparison |
| `equalColorTolerance` | number | 30 | Tolerance for color equality (0-255) |
| `steepDirectionThreshold` | number | 2.2 | Threshold for steep edge detection |
| `dominantDirectionThreshold` | number | 3.6 | Threshold for dominant direction |

## Asynchronous Rendering

Every GPU renderer now exposes a non-blocking `renderAsync()` alongside the
synchronous `render()`. The synchronous path calls `gl.readPixels`, which stalls
the CPU until the GPU has finished drawing. `renderAsync()` instead reads back
through a Pixel Buffer Object and a fence, polling for completion without
blocking the thread — so the event loop (and your animation frame) stays
responsive while the GPU works.

```javascript
const renderer = XbrzGpuRenderer.create();

// Non-blocking: resolves once the GPU result is ready.
const output = await renderer.renderAsync(input, { scale: 4 });

// You may pass a reusable output buffer to avoid per-frame allocations:
const reuse = new Uint8ClampedArray(input.width * 4 * input.height * 4 * 4);
const out2 = await renderer.renderAsync(input, { scale: 4 }, reuse);
```

Prefer `renderAsync()` in interactive loops; `render()` remains available for
simple one-shot or synchronous-pipeline use.

## Off-Main-Thread Rendering (Web Worker)

`WorkerRenderer` runs the GPU renderers inside a dedicated module worker that
owns its own `OffscreenCanvas` WebGL2 context. Texture upload, drawing and pixel
readback all happen off the main thread, and results are returned as
transferable `ArrayBuffer`s (zero-copy), so even large frames never block the
UI.

```javascript
import { WorkerRenderer } from '@pixagram/upscaler';

const renderer = new WorkerRenderer();

const output = await renderer.xbrz(input, { scale: 4 });
// output: { data: Uint8ClampedArray, width, height }

// also: renderer.crt(input, opts) and renderer.hex(input, opts)

renderer.dispose(); // terminates the worker when you're done
```

The worker entry point is published at `@pixagram/upscaler/render-worker` if you
need to construct the `Worker` yourself (e.g. with a custom bundler URL).
Because the worker uses `OffscreenCanvas`, it requires a browser that supports
OffscreenCanvas WebGL2 contexts (Chromium-based browsers and recent Firefox;
Safari support varies by version).



## WASM (CPU) Rendering

The Rust/WASM module renders on the CPU (SIMD128) and needs no WebGL2. The
simplest way to use it is the `WasmRenderer` wrapper:

```typescript
import init, * as wasm from '@pixagram/upscaler/wasm';
import { WasmRenderer } from '@pixagram/upscaler';

await init();
const renderer = new WasmRenderer(wasm);

// 1. Simplest: a fresh, independent copy of the result.
const out = renderer.renderXbrz(imageData, { scale: 8 });
ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);

// 2. Zero-copy: a view into WASM memory, valid until the next render call.
//    Fastest for "render then draw immediately".
const view = renderer.renderXbrzView(imageData, { scale: 8 });
ctx.putImageData(new ImageData(view.data, view.width, view.height), 0, 0);

// 3. Reusable buffer: copy into memory you own (no allocation per frame).
const buffer = new Uint8ClampedArray(imageData.width * 8 * imageData.height * 8 * 4);
renderer.renderXbrz(imageData, { scale: 8 }, buffer);
```

At high scales the output dominates the cost: a 512x512 source at 8x is a
67 MB image. Measured in Chromium, the zero-copy view took 6-13 ms, a reused
buffer 14-22 ms and a fresh copy 47-53 ms for the same render, so prefer
(2) or (3) in loops. `renderCrt`/`renderHex` (+ `View` variants) work the same
way.

The raw module API is also available: every render function returns
`{ ptr, len, width, height }` locating the pixels in `get_memory().buffer`
(call `result.free()` when done with the result object). Invalid arguments
(input shorter than `width * height * 4`, outputs beyond the 4 GiB WebAssembly
address space, failed allocations) throw a JavaScript `Error` instead of
trapping, so one bad call never leaves the instance unusable.
`release_buffers()` frees the module's output buffer after a one-off large
render.

### Multi-core xBRZ without special headers: `WasmXbrzPool`

`WasmXbrzPool` compiles the module once and runs it in N module workers. Each
worker renders a band of source rows (with the 2-row halo the kernel needs),
so the stacked result is byte-identical to a single-threaded render. It works
on any page: no `SharedArrayBuffer`, no COOP/COEP.

```typescript
import { WasmXbrzPool } from '@pixagram/upscaler';

const pool = await WasmXbrzPool.create();            // hardwareConcurrency - 1 workers
const out = await pool.upscale(imageData, { scale: 4 });
pool.dispose();
```

It pays off for compute-heavy jobs (large or detailed images at 2x-4x) and
keeps the main thread free. At 7x-8x the work is dominated by moving the large
output between threads, so a single-threaded `renderXbrzView` is usually just
as fast there. On a cross-origin isolated page you can pass an `out` array
backed by a `SharedArrayBuffer`; workers then write into it directly.

The band primitive is exported too, if you schedule work yourself:
`xbrz_upscale_band(window, width, height, windowY0, y0, y1, scale, ...)`
renders source rows `[y0, y1)` from a window of rows covering
`[y0 - 2, y1 + 2)`.

## Building from Source

### Prerequisites

- Node.js 18+
- Rust toolchain with the `wasm32-unknown-unknown` target
- wasm-pack (and binaryen's `wasm-opt`; wasm-pack downloads it)
- For the optional multi-threaded build only: a **nightly** Rust toolchain plus
  the `rust-src` component (`rustup component add rust-src --toolchain nightly`).

### Build

```bash
# Install dependencies
npm install

# WASM (SIMD, single-threaded, stable toolchain) + TypeScript
npm run build

# ...plus the optional threaded WASM variant (nightly), as published
npm run build:all

# Individual steps
npm run build:ts
npm run build:wasm
npm run build:wasm:threads

# Rust tests (golden outputs, serial and parallel)
npm test
```

## Multi-threading with `wasm-bindgen-rayon` (optional)

With the `parallel` Cargo feature the xBRZ, CRT and hex kernels split their
output into bands of rows processed on a [`rayon`](https://crates.io/crates/rayon)
pool backed by [`wasm-bindgen-rayon`](https://crates.io/crates/wasm-bindgen-rayon).
Each xBRZ band recomputes its halo, so output is byte-identical to the serial
build. This is a separate artifact, `dist/wasm-threads`
(`@pixagram/upscaler/wasm-threads`); the default `dist/wasm` is unaffected.

`npm run build:wasm:threads` builds it on nightly with
`-Z build-std=panic_abort,std`, the `+atomics,+bulk-memory,+mutable-globals`
target features **and** the shared-memory link flags (`--shared-memory
--import-memory --max-memory=1073741824` plus the TLS / `__heap_base`
exports). Current toolchains no longer add those link flags on their own;
without them the module has atomics but private, unshareable memory, and
`initThreadPool` fails.

To run it:

1. Serve the page (and worker scripts) **cross-origin isolated**:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
2. Call it **from a Web Worker**. The browser main thread may not block on
   atomics, so calling a parallel renderer there spins instead of waiting and
   gains nothing.
3. Initialise the pool once, after `init()`:
   ```javascript
   // inside a module worker
   import init, { initThreadPool, xbrz_upscale } from '@pixagram/upscaler/wasm-threads';
   await init();
   await initThreadPool(navigator.hardwareConcurrency);
   // xbrz_upscale / crt_upscale / hex_upscale now run multi-threaded
   ```

`wasm-bindgen-rayon`'s worker helper imports the package root
(`import('../../..')`), so use a bundler, or a server that maps that directory
URL to `renderart.js`.

Measured from a worker with 2 threads (512x512 source): xBRZ 2x 4.2 -> 2.2 ms,
8x 12.2 -> 5.4 ms. If you cannot set the headers, use `WasmXbrzPool` instead.

## Browser Support

- **GPU Renderers**: Requires WebGL2 (Chrome 56+, Firefox 51+, Safari 15+, Edge 79+)
- **WASM Module**: Requires WebAssembly (all modern browsers)

## Performance

The GPU renderers leverage fragment shaders for parallel pixel processing:

| Renderer | 256x256 → 3x | 512x512 → 3x |
|----------|--------------|--------------|
| CRT GPU | ~2ms | ~5ms |
| HEX GPU | ~3ms | ~8ms |
| xBRZ GPU | ~4ms | ~12ms |

### xBRZ on WASM

Render time only (output left in WASM memory), Node 22 / V8, one thread,
256x256 source. "Before" is the 0.3.6 module:

| Input | 2x before | 2x now | 8x before | 8x now |
|-------|-----------|--------|-----------|--------|
| Gradient art ("clouds") | 2.6 ms | 0.9 ms | 5.6 ms | 2.2 ms |
| Sprites on flat background | 1.7 ms | 0.5 ms | 5.0 ms | 1.4 ms |
| Random palette noise (worst case) | 12.5 ms | 5.5 ms | 17.0 ms | 10 ms |

At 8x a flat image renders within ~10% of the time it takes to `fill` the
same 16.8 MB, so output memory bandwidth, not the algorithm, is now the limit.
See `OPTIMIZATIONS.md` for how this was achieved and verified.

### Optimization notes

- **Async GPU readback.** `renderAsync()` reads pixels back via a Pixel Buffer
  Object plus a fence instead of a blocking `gl.readPixels`, removing the
  GPU→CPU pipeline stall from the hot path. The pack buffer is reused across
  calls. Prefer it in animation loops.
- **WebGL state caching.** The shared context tracks the currently-bound program
  and skips redundant `useProgram` calls, which also removes an
  interleaving hazard when multiple renderers share one context.
- **Off-thread rendering.** `WorkerRenderer` moves all GPU work to a worker with
  its own `OffscreenCanvas`, returning results as transferable buffers so the
  main thread is never blocked.
- **Multi-threaded WASM.** `WasmXbrzPool` (any page) or the optional
  `wasm-threads` build (cross-origin isolated pages, called from a worker).

### Behavioural note: xBRZ quality fix

Upscales of gradient art (neighbouring colours a few levels apart) used to
come out with **square, unblended staircases**. This was most visible at 7x/8x,
where the blocks are large. Two separate causes, both fixed:

- **WASM:** colour distances came from a 15-bit lookup table that rounded each
  channel difference to steps of 16, asymmetrically (`dist(a, b)` could be 0
  while `dist(b, a)` was 16). The corner pre-pass then saw equal gradients and
  skipped blending. The distance is now computed exactly (same formula as the
  GPU shader) and is symmetric.
- **GPU 2x-4x and 7x/8x:** the line-shape test used the colour tolerance where
  Zenju's xBRZ (and this package's own 5x/6x shaders) use exact pixel
  inequality, which turned smooth 2:1 slopes into 45-degree steps.

The Rust engine also now records the first column's bottom-left corner
correctly, which it previously got wrong (a bug inherited from `xbrz-rs`). Pixel
equality on the GPU compares all four channels exactly; the old packed-RGB key
ignored alpha and could not tell some neighbouring colours apart.

Output therefore differs from 0.3.x wherever these cases occur: smoother, and
GPU and WASM now agree to within +-2 levels everywhere except the image
border.

**Image border:** the WASM path treats pixels outside the image as transparent
(Zenju's ARGB mode), while the GPU path repeats the edge pixels
(`CLAMP_TO_EDGE`). Opaque images rendered with WASM therefore get slightly
rounded, partially transparent outer corners. This is unchanged from 0.3.x.

### Behavioural note: hex GPU borders

The hex **GPU** shader's border detection now uses the same analytical
hex-edge-distance test as the WASM implementation, replacing an older
neighbour-sampling approximation. This makes the GPU and WASM borders consistent
with each other and is `O(1)` per pixel rather than `O(thickness²)`. The visual
result of `drawBorders` may differ very slightly from previous versions at the
same `borderThickness`; adjust thickness if you need to match old output
exactly.

## License

MIT
