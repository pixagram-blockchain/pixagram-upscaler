/**
 * RenderArt WASM Module Wrapper
 *
 * Provides TypeScript type definitions and helper functions
 * for the WebAssembly module.
 *
 * Output handling: every render writes into one buffer owned by the module and
 * reused across calls. Three ways to get the pixels, cheapest first:
 *
 * - `render*View()`   zero-copy view into WASM memory, valid until the next
 *                     render call on the same module (ideal for immediate
 *                     `putImageData` / texture upload);
 * - `render*(..., out)` copy into a caller-owned, reusable buffer (no
 *                     allocation per frame);
 * - `render*(...)`    copy into a freshly allocated array (simplest, safe to
 *                     keep).
 */

import type { CrtOptions, HexOptions, HexOrientation, ImageOutput, XbrzOptions } from './types.js';

/** WASM upscale result structure (a wasm-bindgen object; call `free()` when done). */
export interface WasmUpscaleResult {
  /** Pointer to output data in WASM memory */
  ptr: number;
  /** Length of output data in bytes */
  len: number;
  /** Output width in pixels */
  width: number;
  /** Output height in pixels */
  height: number;
  /** Releases the result object itself (not the pixels). */
  free?(): void;
}

/** Output dimensions returned by `hex_get_dimensions`. */
export interface WasmDimensions {
  width: number;
  height: number;
  free?(): void;
}

/** WASM module interface (the exports of `@pixagram/upscaler/wasm`). */
export interface RenderArtWasm {
  /** Get WASM memory for reading output buffers */
  get_memory(): WebAssembly.Memory;

  /** Drop the module's shared output buffer (memory stays reserved but reusable). */
  release_buffers?(): void;

  /** CRT upscale with default config */
  crt_upscale(data: Uint8Array, width: number, height: number, scale: number): WasmUpscaleResult;

  /** CRT upscale with full config */
  crt_upscale_config(
    data: Uint8Array,
    width: number,
    height: number,
    scale: number,
    warp_x: number,
    warp_y: number,
    scan_hardness: number,
    scan_opacity: number,
    mask_opacity: number,
    enable_warp: boolean,
    enable_scanlines: boolean,
    enable_mask: boolean,
  ): WasmUpscaleResult;

  /** HEX upscale with default config */
  hex_upscale(data: Uint8Array, width: number, height: number, scale: number): WasmUpscaleResult;

  /** HEX upscale with full config */
  hex_upscale_config(
    data: Uint8Array,
    width: number,
    height: number,
    scale: number,
    orientation: number,
    draw_borders: boolean,
    border_color: number,
    border_thickness: number,
    background_color: number,
  ): WasmUpscaleResult;

  /** Get HEX output dimensions */
  hex_get_dimensions(width: number, height: number, scale: number, orientation: number): WasmDimensions;

  /** xBRZ upscale with default config */
  xbrz_upscale(data: Uint8Array, width: number, height: number, scale: number): WasmUpscaleResult;

  /** xBRZ upscale with full config */
  xbrz_upscale_config(
    data: Uint8Array,
    width: number,
    height: number,
    scale: number,
    equal_color_tolerance: number,
    center_direction_bias: number,
    dominant_direction_threshold: number,
    steep_direction_threshold: number,
  ): WasmUpscaleResult;

  /**
   * xBRZ for source rows [y0, y1) only. `window` holds source rows
   * [window_y0, ...) and must cover [y0 - 2, y1 + 2) clipped to the image.
   * Used by {@link WasmXbrzPool}; bands stack byte-identically.
   */
  xbrz_upscale_band?(
    window: Uint8Array,
    width: number,
    height: number,
    window_y0: number,
    y0: number,
    y1: number,
    scale: number,
    equal_color_tolerance: number,
    center_direction_bias: number,
    dominant_direction_threshold: number,
    steep_direction_threshold: number,
  ): WasmUpscaleResult;
}

/** Reads the fields of a result and frees the wasm-bindgen wrapper object. */
function takeResult(result: WasmUpscaleResult): { ptr: number; len: number; width: number; height: number } {
  const r = { ptr: result.ptr, len: result.len, width: result.width, height: result.height };
  result.free?.();
  return r;
}

/**
 * Zero-copy view of a result in WASM memory. Valid until the next render call
 * on the same module, or until WASM memory grows (which detaches the buffer).
 */
export function viewWasmOutput(wasm: RenderArtWasm, result: WasmUpscaleResult): ImageOutput {
  const r = takeResult(result);
  return {
    data: new Uint8ClampedArray(wasm.get_memory().buffer, r.ptr, r.len),
    width: r.width,
    height: r.height,
  };
}

/**
 * Helper to read WASM output into ImageOutput. Copies into `out` when given
 * (must hold at least `len` bytes; no allocation), else into a new array.
 */
export function readWasmOutput(wasm: RenderArtWasm, result: WasmUpscaleResult, out?: Uint8ClampedArray): ImageOutput {
  const r = takeResult(result);
  const view = new Uint8ClampedArray(wasm.get_memory().buffer, r.ptr, r.len);
  let data: Uint8ClampedArray;
  if (out) {
    if (out.length < r.len) {
      throw new RangeError(`output buffer holds ${out.length} bytes, ${r.len} needed`);
    }
    data = out.length === r.len ? out : out.subarray(0, r.len);
    data.set(view);
  } else {
    // Copy so the result survives later renders and memory growth.
    data = new Uint8ClampedArray(view);
  }
  return { data, width: r.width, height: r.height };
}

/** Parse color to RGBA number for WASM */
export function colorToRgba(color: string | number | undefined, defaultValue: number): number {
  if (color === undefined) return defaultValue;
  if (typeof color === 'number') return color;

  if (color === 'transparent') return 0x00000000;

  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 6) {
      return ((parseInt(hex, 16) << 8) | 0xff) >>> 0;
    }
    if (hex.length === 8) {
      return parseInt(hex, 16) >>> 0;
    }
  }

  return defaultValue;
}

/** Convert HexOrientation string to number for WASM */
export function orientationToNumber(orientation: HexOrientation | undefined): number {
  return orientation === 'pointy-top' ? 1 : 0;
}

/** Raw RGBA bytes of an input without copying. */
function bytesOf(input: ImageData | { data: Uint8Array | Uint8ClampedArray; width: number; height: number }): Uint8Array {
  const d = input.data;
  return d instanceof Uint8Array ? d : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

type WasmInput = ImageData | { data: Uint8Array | Uint8ClampedArray; width: number; height: number };

/** Integer scale in [min, max]; non-finite values (NaN, undefined) give `def`. */
function clampScale(scale: number | undefined, def: number, min: number, max: number): number {
  const s = typeof scale === 'number' && Number.isFinite(scale) ? Math.floor(scale) : def;
  return Math.min(max, Math.max(min, s));
}

/**
 * High-level WASM renderer wrapper
 *
 * Provides the same interface as GPU renderers but uses WASM.
 */
export class WasmRenderer {
  private wasm: RenderArtWasm;

  constructor(wasm: RenderArtWasm) {
    this.wasm = wasm;
  }

  private crtResult(input: WasmInput, options: CrtOptions): WasmUpscaleResult {
    const scale = clampScale(options.scale, 3, 2, 32);
    return this.wasm.crt_upscale_config(
      bytesOf(input),
      input.width,
      input.height,
      scale,
      options.warpX ?? 0.015,
      options.warpY ?? 0.02,
      options.scanHardness ?? -4.0,
      options.scanOpacity ?? 0.5,
      options.maskOpacity ?? 0.3,
      options.enableWarp !== false,
      options.enableScanlines !== false,
      options.enableMask !== false,
    );
  }

  private hexResult(input: WasmInput, options: HexOptions): WasmUpscaleResult {
    const scale = clampScale(options.scale, 16, 2, 32);
    return this.wasm.hex_upscale_config(
      bytesOf(input),
      input.width,
      input.height,
      scale,
      orientationToNumber(options.orientation),
      options.drawBorders ?? false,
      colorToRgba(options.borderColor, 0x282828ff),
      options.borderThickness ?? 1,
      colorToRgba(options.backgroundColor, 0x00000000),
    );
  }

  private xbrzResult(input: WasmInput, options: XbrzOptions): WasmUpscaleResult {
    const scale = clampScale(options.scale, 2, 2, 8);
    return this.wasm.xbrz_upscale_config(
      bytesOf(input),
      input.width,
      input.height,
      scale,
      options.equalColorTolerance ?? 30,
      options.centerDirectionBias ?? 4.0,
      options.dominantDirectionThreshold ?? 3.6,
      options.steepDirectionThreshold ?? 2.2,
    );
  }

  /** Render CRT effect (copied; into `out` when given). */
  renderCrt(input: WasmInput, options: CrtOptions = {}, out?: Uint8ClampedArray): ImageOutput {
    return readWasmOutput(this.wasm, this.crtResult(input, options), out);
  }

  /** Render hexagonal effect (copied; into `out` when given). */
  renderHex(input: WasmInput, options: HexOptions = {}, out?: Uint8ClampedArray): ImageOutput {
    return readWasmOutput(this.wasm, this.hexResult(input, options), out);
  }

  /** Render xBRZ effect (copied; into `out` when given). */
  renderXbrz(input: WasmInput, options: XbrzOptions = {}, out?: Uint8ClampedArray): ImageOutput {
    return readWasmOutput(this.wasm, this.xbrzResult(input, options), out);
  }

  /** CRT effect as a zero-copy view (valid until the next render call). */
  renderCrtView(input: WasmInput, options: CrtOptions = {}): ImageOutput {
    return viewWasmOutput(this.wasm, this.crtResult(input, options));
  }

  /** Hexagonal effect as a zero-copy view (valid until the next render call). */
  renderHexView(input: WasmInput, options: HexOptions = {}): ImageOutput {
    return viewWasmOutput(this.wasm, this.hexResult(input, options));
  }

  /** xBRZ as a zero-copy view (valid until the next render call). */
  renderXbrzView(input: WasmInput, options: XbrzOptions = {}): ImageOutput {
    return viewWasmOutput(this.wasm, this.xbrzResult(input, options));
  }
}
