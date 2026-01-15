# RenderArt

High-performance pixel art rendering engines with WebGL2 GPU acceleration and WebAssembly support.

## Features

- **CRT Effect** - Authentic CRT display simulation with scanlines, shadow mask, and barrel distortion
- **Hexagonal Grid** - Transform pixel art into hexagonal pixel representations
- **xBRZ Upscaling** - Advanced pixel art upscaling algorithm (2x-6x) that preserves sharp edges

All renderers are available in two implementations:
- **GPU (WebGL2)** - High-performance fragment shader-based rendering
- **WASM** - Rust-compiled WebAssembly for environments without WebGL2

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

## WASM Module

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

### Build

```bash
# Install dependencies
npm install

# Build everything (TypeScript + WASM)
npm run build

# Build only TypeScript
npm run build:ts

# Build only WASM
npm run build:wasm
```

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

## License

MIT
