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
   * Animated (or still) GIF / WebP decoded one composited frame at a time
   * (0.5.0+, only in the `anim` build: `@pixagram/upscaler/wasm-anim`). See
   * {@link WasmFrameDecoder} and the `WasmAnimation` wrapper.
   */
  FrameDecoder?: new (data: Uint8Array, maxPixels?: number) => WasmFrameDecoder;

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

/**
 * The raw `FrameDecoder` class of the WASM module (0.5.0+): one RGBA canvas,
 * one frame decoded and composited at a time. Prefer the `WasmAnimation`
 * wrapper, which adds option defaults and zero-copy views.
 */
export interface WasmFrameDecoder {
  /** `"gif"` or `"webp"`. */
  readonly format: string;
  readonly width: number;
  readonly height: number;
  /** Frames in one loop. */
  readonly frame_count: number;
  /** Total plays, 0 = forever. */
  readonly loop_count: number;
  /** One loop, in ms (sum of the effective delays). */
  readonly duration_ms: number;
  /** More than one frame. */
  readonly animated: boolean;
  /** Frame on the canvas, -1 before the first `next_frame()`. */
  readonly index: number;
  /** Effective duration of the current frame (under 11 ms plays as 100 ms). */
  readonly delay_ms: number;
  /** Declared duration of the current frame. */
  readonly raw_delay_ms: number;
  /** A frame failed to decode and the loop was cut short there. */
  readonly truncated: boolean;
  next_frame(): boolean;
  skip_frames(n: number): number;
  rewind(): void;
  frame(): WasmUpscaleResult;
  upscale_xbrz(
    scale: number,
    equal_color_tolerance: number,
    center_direction_bias: number,
    dominant_direction_threshold: number,
    steep_direction_threshold: number,
  ): WasmUpscaleResult;
  upscale_crt(
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
  upscale_hex(
    scale: number,
    orientation: number,
    draw_borders: boolean,
    border_color: number,
    border_thickness: number,
    background_color: number,
  ): WasmUpscaleResult;
  free(): void;
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

/** `crt_upscale_config` arguments after `data, width, height` (defaults applied). */
export type CrtArgs = [number, number, number, number, number, number, boolean, boolean, boolean];
/** `hex_upscale_config` arguments after `data, width, height` (defaults applied). */
export type HexArgs = [number, number, boolean, number, number, number];
/** `xbrz_upscale_config` arguments after `data, width, height` (defaults applied). */
export type XbrzArgs = [number, number, number, number, number];

/** CRT options as WASM arguments: scale 2..32 (default 3) and the defaults. */
export function crtArgs(options: CrtOptions = {}): CrtArgs {
  return [
    clampScale(options.scale, 3, 2, 32),
    options.warpX ?? 0.015,
    options.warpY ?? 0.02,
    options.scanHardness ?? -4.0,
    options.scanOpacity ?? 0.5,
    options.maskOpacity ?? 0.3,
    options.enableWarp !== false,
    options.enableScanlines !== false,
    options.enableMask !== false,
  ];
}

/** Hex options as WASM arguments: scale 2..32 (default 16) and the defaults. */
export function hexArgs(options: HexOptions = {}): HexArgs {
  return [
    clampScale(options.scale, 16, 2, 32),
    orientationToNumber(options.orientation),
    options.drawBorders ?? false,
    colorToRgba(options.borderColor, 0x282828ff),
    options.borderThickness ?? 1,
    colorToRgba(options.backgroundColor, 0x00000000),
  ];
}

/** xBRZ options as WASM arguments: scale 2..8 (default 2) and the defaults. */
export function xbrzArgs(options: XbrzOptions = {}): XbrzArgs {
  return [
    clampScale(options.scale, 2, 2, 8),
    options.equalColorTolerance ?? 30,
    options.centerDirectionBias ?? 4.0,
    options.dominantDirectionThreshold ?? 3.6,
    options.steepDirectionThreshold ?? 2.2,
  ];
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
    return this.wasm.crt_upscale_config(bytesOf(input), input.width, input.height, ...crtArgs(options));
  }

  private hexResult(input: WasmInput, options: HexOptions): WasmUpscaleResult {
    return this.wasm.hex_upscale_config(bytesOf(input), input.width, input.height, ...hexArgs(options));
  }

  private xbrzResult(input: WasmInput, options: XbrzOptions): WasmUpscaleResult {
    return this.wasm.xbrz_upscale_config(bytesOf(input), input.width, input.height, ...xbrzArgs(options));
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
