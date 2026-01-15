/**
 * RenderArt - High-Performance Pixel Art Rendering
 * 
 * A collection of GPU-accelerated (WebGL2) and WASM-powered
 * pixel art upscaling and transformation engines.
 * 
 * @packageDocumentation
 */

// Types
export type {
  ImageInput,
  ImageOutput,
  Renderer,
  CrtOptions,
  HexOptions,
  HexOrientation,
  XbrzOptions,
} from './types.js';

// CRT Renderer
export { CrtGpuRenderer, CRT_PRESETS } from './crt-gpu.js';

// Hexagonal Renderer
export { HexGpuRenderer, HEX_PRESETS, hexGetDimensions } from './hex-gpu.js';

// xBRZ Renderer
export { XbrzGpuRenderer, XBRZ_PRESETS } from './xbrz-gpu.js';

import { CrtGpuRenderer } from './crt-gpu.js';
import { HexGpuRenderer } from './hex-gpu.js';
import { XbrzGpuRenderer } from './xbrz-gpu.js';

/** Convenience factory for creating renderers */
export const createRenderer = {
  /** Create a CRT effect renderer */
  crt: () => CrtGpuRenderer.create(),
  /** Create a hexagonal grid renderer */
  hex: () => HexGpuRenderer.create(),
  /** Create an xBRZ upscaling renderer */
  xbrz: () => XbrzGpuRenderer.create(),
};

/** All available presets */
export { CRT_PRESETS as crtPresets } from './crt-gpu.js';
export { HEX_PRESETS as hexPresets } from './hex-gpu.js';
export { XBRZ_PRESETS as xbrzPresets } from './xbrz-gpu.js';
