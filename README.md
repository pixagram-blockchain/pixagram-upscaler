# RenderArt

High-performance pixel art rendering engines with WebGL2 GPU acceleration and WebAssembly support.

## Features

- **CRT Effect** - Authentic CRT display simulation with scanlines, shadow mask, and barrel distortion
- **Hexagonal Grid** - Transform pixel art into hexagonal pixel representations
- **xBRZ Upscaling** - Advanced pixel art upscaling algorithm (2x-8x) that preserves sharp edges

All renderers are available in two implementations:
- **GPU (WebGL2)** - High-performance fragment shader-based rendering
- **WASM** - Rust-compiled, SIMD-accelerated WebAssembly (no WebGL2 needed)

Animated images:
- **Animated GIF and WebP** decoded and upscaled **one frame at a time**: a
  batch of any length runs in the memory of one frame (see
  [Animated GIF and WebP](#animated-gif-and-webp))

Vector output:
- **Depixelize** - pixel art to a resolution-independent SVG (Kopf &
  Lischinski, *Depixelizing Pixel Art*), in WebAssembly (SIMD or scalar
  build), in the current thread or in a worker pool (see
  [Depixelize: pixel art to SVG](#depixelize-pixel-art-to-svg))

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

The worker and the `.wasm` file are referenced with
`new URL('…', import.meta.url)`, so webpack 5 emits both with your bundle and
there is nothing to configure. (In 0.4.0 the worker loaded the WASM glue from
a runtime URL, which webpack reported as "Critical dependency: the request of
a dependency is an expression" and could not load at runtime; 0.4.1 imports
it statically.)

It pays off for compute-heavy jobs (large or detailed images at 2x-4x) and
keeps the main thread free. At 7x-8x the work is dominated by moving the large
output between threads, so a single-threaded `renderXbrzView` is usually just
as fast there. On a cross-origin isolated page you can pass an `out` array
backed by a `SharedArrayBuffer`; workers then write into it directly.

The band primitive is exported too, if you schedule work yourself:
`xbrz_upscale_band(window, width, height, windowY0, y0, y1, scale, ...)`
renders source rows `[y0, y1)` from a window of rows covering
`[y0 - 2, y1 + 2)`.

## Animated GIF and WebP

A batch of frames is processed one frame at a time. The decoder keeps the
compressed file and **one** RGBA canvas; each step decodes the next frame,
composites it onto that canvas (disposal and blending as browsers do), and the
upscaler renders it into the module's single shared output buffer - the same
buffer every other render call reuses. Nothing is accumulated, so 10 frames or
10,000 (or an endless loop) cost the same memory: one source frame plus one
output frame.

The decoder ships in its own build of the module, `@pixagram/upscaler/wasm-anim`
(about 300 KB, 110 KB gzipped, against 63 KB / 26 KB for `@pixagram/upscaler/wasm`,
which is unchanged and has no decoder). It includes the upscalers too.

### Off the main thread: `WasmAnimationPool`

The usual way to play an animation. Workers decode and upscale; the page
receives one `ImageBitmap` per request:

```javascript
import { WasmAnimationPool } from '@pixagram/upscaler';

const pool = await WasmAnimationPool.create();           // 1 worker by default
const stream = await pool.open(gifBytes, { effect: 'xbrz', options: { scale: 4 } });

let frame;
while ((frame = await stream.next({ wrap: true }))) {    // wrap: loop forever
  canvasCtx.transferFromImageBitmap(frame.bitmap);       // or drawImage + close()
  await new Promise((r) => setTimeout(r, frame.delay));
}
stream.close();
pool.dispose();
```

- `stream.next({ render, skip, wrap, output })`: `render` changes the effect or
  scale for this frame; `skip` decodes frames without rendering them (to catch
  up after falling behind - frames build on each other, so they are still
  decoded); `output: 'pixels'` returns RGBA bytes instead of a bitmap.
- `stream.info`: `format`, `width`, `height`, `frameCount`, `loopCount` (total
  plays, 0 = forever), `durationMs`, `animated`.
- Effects: `'xbrz'`, `'crt'`, `'hex'` (same options as the renderers above) or
  `'none'` (the composited source frame).
- `stream.close()` frees the worker-side decoder; a frame still in flight
  resolves to `null` and is closed for you.

### In the current thread: `WasmAnimation` and `upscaleFrames`

```javascript
import init, * as wasm from '@pixagram/upscaler/wasm-anim';
import { upscaleFrames, WasmAnimation } from '@pixagram/upscaler';

await init();

// Generator: each frame's data is a zero-copy view, valid until the loop continues.
for (const f of upscaleFrames(wasm, webpBytes, { effect: 'crt', options: { scale: 6 } })) {
  ctx.putImageData(new ImageData(f.data, f.width, f.height), 0, 0);
}

// Step by step.
const anim = WasmAnimation.open(wasm, gifBytes, { maxPixels: 4 * 1024 * 1024 });
while (anim.next()) {
  const src = anim.frameView();                          // composited source frame
  const out = anim.renderView({ effect: 'hex', options: { scale: 8 } });
  // anim.index, anim.delay
}
anim.rewind();                                           // next loop
anim.free();
```

`upscaleFrameBatch(renderer, frames, spec, onFrame)` runs the same loop over
frames you decode yourself (any iterable or async iterable of RGBA frames),
with a `WasmRenderer`.

The raw module class is `FrameDecoder` (`next_frame`, `skip_frames`, `rewind`,
`frame`, `upscale_xbrz`, `upscale_crt`, `upscale_hex`, plus getters).

### Probing without decoding

```javascript
import { probeAnimation } from '@pixagram/upscaler';

probeAnimation(bytes);
// { format: 'gif', width, height, frameCount, loopCount, durationMs, animated, needsFrameDecoder }
// null for anything that is not a GIF / WebP
```

Header-only (image data is skipped, not decoded), so it is cheap enough for
layout code. `needsFrameDecoder` is true for every GIF and for WebP files with
the animation flag, which still-image WebP decoders (libwebp's `WebPDecode`)
refuse even when they hold a single frame.

### What browsers do, and what this does

Frames match Chrome's own decoder (`ImageDecoder`): bit-exact for GIF; for
WebP exact against libwebp's animation decoder, and within the rounding of
Chrome's premultiplied pipeline against Chrome. `examples/anim-crosscheck`
re-runs that comparison (and the memory and pool checks) in a browser.

- GIF canvas: the logical screen, enlarged to fit the first frame (as
  Chromium). It starts transparent; the background colour is ignored.
  "Restore to background" clears to transparent, "restore to previous" puts
  back what the frame covered. Indices past the colour table are opaque black.
  Interlaced frames are supported.
- WebP: the canvas is cleared to transparent at the start of every loop (the
  ANIM background colour is a hint browsers ignore); blending is libwebp's
  non-premultiplied "over"; the dispose flag clears the frame rectangle.
- Durations under 11 ms play as 100 ms (`delay`; the declared value is
  `raw_delay_ms` on the raw class).
- Loop counts are total plays: a GIF without a NETSCAPE2.0 block plays once,
  NETSCAPE `n` plays `n + 1` times, WebP ANIM `n` plays `n` times, 0 = forever.
- A frame that fails to decode after the first ends the loop at the last good
  frame (`truncated` becomes true and `frameCount` drops), leaving the canvas
  as it was. Canvases above `maxPixels` (default 16 MP) are refused.

## Depixelize: pixel art to SVG

`@pixagram/upscaler/depixelize` vectorizes pixel art: it implements Kopf &
Lischinski, *Depixelizing Pixel Art* (SIGGRAPH 2011) - a similarity graph of
the pixels, reshaped pixel cells, and quadratic B-spline boundaries whose
control points are optimised for smoothness. The upscalers above produce a
bigger bitmap; depixelize produces an SVG that renders sharply at any size.

It is a separate WebAssembly module written in Rust (the `depixelize/` folder
of this repository), in a SIMD (`simd128`) and a scalar build; `init()` picks
the SIMD build when the browser supports it. Both builds produce
byte-identical SVG, also identical to the JavaScript reference implementation
`depixelize/depixelize.js`.

```javascript
import { init, depixelize } from '@pixagram/upscaler/depixelize';

await init();                                            // depixelize-simd.wasm, or depixelize.wasm
const svg = depixelize(imageData, { scale: 30 });        // SVG document (string)
const quick = depixelize(imageData, { scale: 30, smooth: 'fast' });

img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
```

The input is an `ImageData` or any `{ width, height, data }` with RGBA (or
RGB) bytes. The SVG's `viewBox` is the image size in pixels; its `width` and
`height` are the image size times `scale`.

### Off the main thread: `WasmDepixelizePool`

A 256x256 image takes about 0.13 s in the SIMD build (0.03 s with
`smooth: 'fast'`), so large images are best converted in a worker. The pool
compiles the module once and runs it in module workers:

```javascript
import { WasmDepixelizePool } from '@pixagram/upscaler';

const pool = await WasmDepixelizePool.create();          // 1 worker by default
const svg = await pool.depixelize(imageData, { scale: 30, smooth: 'fast' });
const bytes = await pool.depixelizeBytes(imageData);     // UTF-8 bytes, transferred from the worker
pool.dispose();
```

- `create({ workers, simd, wasmUrl, createWorker, initTimeoutMs })`: up to 8
  workers (each converts one image at a time, so more only help with several
  images in flight); `simd: false` forces the scalar build; `pool.simd` tells
  which build runs.
- Like the other pools it works on any page (no `SharedArrayBuffer`, no
  COOP/COEP), and the worker and both `.wasm` builds are referenced with
  `new URL('…', import.meta.url)`, so webpack 5 emits them with your bundle.
  Only the build in use is downloaded.
- Invalid images reject with a `RangeError`. A worker whose instance traps
  (out of memory on a huge image) is replaced before the next request.

### Depixelize options

| Option | Default | Description |
|--------|---------|-------------|
| `scale` | 40 | Output size: SVG `width`/`height` = image size x scale |
| `precision` | `'auto'` | Decimals of the coordinates, in pixels (0-6). `'auto'`: the coarsest grid that keeps every point within 1/4 output pixel |
| `mode` | `'auto'` | `'cell'`: regions of similar pixels, as in the paper (colour varies smoothly inside). `'shape'`: regions of identical pixels (every colour boundary is a curve). `'auto'`: per region; banded shading stays crisp, gradients and dither are smoothed |
| `smooth` | `true` | Curve smoothing. `true`: the paper's random relaxation. `'fast'`: a deterministic pattern search on the same energy, about as smooth with 6-13x less smoothing time. `false`: off |
| `iterations` | 20 | Relaxation sweeps (the maximum in fast mode) |
| `guesses` | 20 | Random candidates per control point per sweep (paper mode) |
| `guessOffset` | 0.05 | Maximum displacement of one candidate, in pixels |
| `shading` | 0.7 | Sigma, in pixels, of the colour interpolation inside multi-colour regions; 0 = flat cells |
| `seed` | 1 | PRNG seed; the output is deterministic |
| `idPrefix` | hash | Prefix for the ids inside the SVG |

### More

- `load()` returns an independent engine. `depixelizeBytes()` returns the SVG
  as UTF-8 bytes, `depixelizeView()` as a zero-copy view of WASM memory, and
  `input(width, height)` a view of the module's pixel buffer to fill in place.
  Types: `@pixagram/upscaler/depixelize` ships its own declarations; the
  package root exports `DepixelizeOptions` and `DepixelizeInput`.
- In Node, `await init()` reads the `.wasm` next to the module.
- `dist/depixelize/depixelize-wasm.inline.js` is a classic `<script>` with
  both builds embedded (`await DepixelizeWasm.init()`), for pages without a
  bundler or opened from disk.
- `examples/depixelize-demo.html` is the browser demo in one file: open it
  from disk, drop a PNG, compare the engines.
- Algorithm, output format, fast smoothing and the byte-identity guarantees:
  [`depixelize/README.md`](depixelize/README.md).

## Building from Source

### Prerequisites

- Node.js 18+
- Rust toolchain with the `wasm32-unknown-unknown` target
- wasm-pack (and binaryen's `wasm-opt`; wasm-pack downloads it)
- For the optional multi-threaded build only: a **nightly** Rust toolchain plus
  the `rust-src` component (`rustup component add rust-src --toolchain nightly`).
- For depixelize: Rust 1.85 or newer, and binaryen's `wasm-opt` (version 121
  or newer) on `PATH` or given as `WASM_OPT=/path/to/wasm-opt`. Without it the
  modules are built but not post-optimised (the SIMD build runs about 20%
  slower).

### Build

```bash
# Install dependencies
npm install

# WASM (SIMD, single-threaded, stable toolchain), the animation build
# (dist/wasm-anim), depixelize (dist/depixelize) + TypeScript
npm run build

# ...plus the optional threaded WASM variant (nightly), as published
npm run build:all

# Individual steps
npm run build:ts
npm run build:wasm
npm run build:wasm:anim
npm run build:wasm:threads
npm run build:depixelize   # also regenerates examples/depixelize-demo.html

# Rust tests (golden outputs, serial and parallel; depixelize goldens)
npm test

# depixelize: golden tests, then depixelize.js against both WebAssembly
# builds, byte for byte
npm run test:depixelize
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
- **Depixelize**: SIMD build in Chrome / Edge 91+, Firefox 89+, Safari 16.4+
  and Node 16.4+; the scalar build everywhere else (chosen automatically). The
  inline `<script>` bundle needs `DecompressionStream` (Chrome 80+, Firefox
  113+, Safari 16.4+).
- **WasmXbrzPool / WasmAnimationPool / WasmDepixelizePool**: module workers (Chrome 80+, Firefox 114+, Safari 15+)

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

### Depixelize on WASM

Median ms per image, `{ scale: 30 }`, Node 22 / V8 on a 2.7 GHz Xeon, one
thread (`node depixelize/bench/bench.mjs`). For each `smooth` setting the
three engines produce the same SVG:

| Image | `smooth` | depixelize.js | WASM scalar | WASM SIMD |
|-------|----------|---------------|-------------|-----------|
| Sprite sheet 128x128 | `true` | 143 | 63 | 31.5 |
| | `'fast'` | 27.3 | 10.4 | 7.8 |
| Noisy photo 96x96 | `true` | 127 | 58 | 29.2 |
| | `'fast'` | 39.2 | 15.2 | 10.4 |
| Sprite sheet 256x256 | `true` | 606 | 252 | 129 |
| | `'fast'` | 104 | 36 | 28.3 |

The module's memory grows to about 320 bytes per input pixel (21 MB at
256x256) and is reused by later calls.

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
