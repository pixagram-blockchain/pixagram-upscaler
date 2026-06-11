# RenderArt

High-performance pixel art rendering engines with WebGL2 GPU acceleration and WebAssembly support.

## Features

- **CRT Effect** - Authentic CRT display simulation with scanlines, shadow mask, and barrel distortion
- **Hexagonal Grid** - Transform pixel art into hexagonal pixel representations
- **xBRZ Upscaling** - Advanced pixel art upscaling algorithm (2x-6x) that preserves sharp edges

All renderers are available in two implementations:
- **GPU (WebGL2)** - High-performance fragment shader-based rendering
- **WASM** - Rust-compiled WebAssembly for environments without WebGL2

Performance features:
- **Non-blocking GPU readback** via `renderAsync()` (PBO + fence)
- **Off-main-thread rendering** via `WorkerRenderer` (OffscreenCanvas in a worker)
- **Optional multi-threaded WASM** via a `rayon` thread pool (opt-in build)

## Installation

```bash
npm install renderart
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
| `scale` | number | 2 | Scale factor (2-6) |
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



For environments without WebGL2 support, use the WASM implementation:

```typescript
import init, { crt_upscale, hex_upscale, xbrz_upscale, get_memory } from '@pixagram/upscaler/wasm';

// Initialize WASM module
await init();

// Convert ImageData to Uint8Array
const inputData = new Uint8Array(imageData.data.buffer);

// Render
const result = crt_upscale(inputData, width, height, scale);

// Read output from WASM memory
const memory = get_memory();
const output = new Uint8ClampedArray(
  memory.buffer,
  result.ptr,
  result.len
);

// Create ImageData
const outputImageData = new ImageData(
  new Uint8ClampedArray(output), // Copy the data
  result.width,
  result.height
);
```

## Building from Source

### Prerequisites

- Node.js 18+
- Rust toolchain with `wasm32-unknown-unknown` target
- wasm-pack
- For the multi-threaded WASM build only: a **nightly** Rust toolchain plus the
  `rust-src` component (`rustup component add rust-src --toolchain nightly`).

### Build

```bash
# Install dependencies
npm install

# Build everything (TypeScript + WASM)
npm run build

# Build only TypeScript
npm run build:ts

# Build only WASM (single-threaded, stable toolchain)
npm run build:wasm

# Build the multi-threaded WASM variant (nightly toolchain, see below)
npm run build:threads
```

## Multi-threading (WASM)

The Rust/WASM renderers can run **data-parallel across a thread pool** when
built with the `parallel` Cargo feature. Internally the xBRZ scaler and the CRT
and hex kernels split their output into horizontal stripes and distribute them
over a [`rayon`](https://crates.io/crates/rayon) pool backed by
[`wasm-bindgen-rayon`](https://crates.io/crates/wasm-bindgen-rayon).

This is an **opt-in, separate build artifact**. The default `npm run build`
produces the single-threaded module and needs no special headers — nothing
about the existing setup changes unless you choose the threaded build.

### Building it

```bash
npm run build:threads
```

which expands to a nightly `wasm-pack` invocation with the atomics target
features enabled:

```bash
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals" \
  rustup run nightly wasm-pack build --target web --out-dir dist/wasm \
  -- --features parallel -Z build-std=panic_abort,std
```

### Running it

Threads in WebAssembly are backed by `SharedArrayBuffer`, which browsers only
expose to **cross-origin-isolated** pages. Your server must send both of these
response headers on the HTML document (and the worker script):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Then initialise the pool once, after the module's `init()`, before calling any
render function:

```javascript
import init, { initThreadPool, xbrz_upscale } from '@pixagram/upscaler/wasm';

await init();
if (self.crossOriginIsolated) {
  await initThreadPool(navigator.hardwareConcurrency);
}
// xbrz_upscale / crt_upscale / hex_upscale now run multi-threaded
```

If `crossOriginIsolated` is `false`, skip `initThreadPool` — without the pool the
same build still runs correctly on a single thread.

> **Note on `Cargo.lock`:** removing the old `parking_lot` dependency in favour
> of `std::sync::OnceLock` and adding the optional `rayon` dependencies means
> Cargo will refresh `Cargo.lock` on your first build. This is expected.


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

WASM performance is typically 3-5x slower but provides consistent results across all platforms.

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
- **Multi-threaded WASM.** With the `parallel` feature the xBRZ, CRT and hex
  Rust kernels process output stripes across a `rayon` thread pool (see the
  Multi-threading section). The shared YCbCr distance table now uses a
  thread-safe `OnceLock`.

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
