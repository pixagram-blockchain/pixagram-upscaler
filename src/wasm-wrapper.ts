/**
 * RenderArt WASM Module Wrapper
 * 
 * Provides TypeScript type definitions and helper functions
 * for the WebAssembly module.
 */

import type { CrtOptions, HexOptions, HexOrientation, ImageOutput, XbrzOptions } from './types.js';

/** WASM upscale result structure */
export interface WasmUpscaleResult {
  /** Pointer to output data in WASM memory */
  ptr: number;
  /** Length of output data in bytes */
  len: number;
  /** Output width in pixels */
  width: number;
  /** Output height in pixels */
  height: number;
}

/** WASM module interface */
export interface RenderArtWasm {
  /** Get WASM memory for reading output buffers */
  get_memory(): WebAssembly.Memory;
  
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
  hex_get_dimensions(width: number, height: number, scale: number, orientation: number): Uint32Array;
  
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
}

/** Helper to read WASM output into ImageOutput */
export function readWasmOutput(wasm: RenderArtWasm, result: WasmUpscaleResult): ImageOutput {
  const memory = wasm.get_memory();
  const data = new Uint8ClampedArray(memory.buffer, result.ptr, result.len);
  
  // Copy the data to avoid issues with WASM memory growth
  return {
    data: new Uint8ClampedArray(data),
    width: result.width,
    height: result.height,
  };
}

/** Parse color to RGBA number for WASM */
export function colorToRgba(color: string | number | undefined, defaultValue: number): number {
  if (color === undefined) return defaultValue;
  if (typeof color === 'number') return color;
  
  if (color === 'transparent') return 0x00000000;
  
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 6) {
      return (parseInt(hex, 16) << 8) | 0xFF;
    }
    if (hex.length === 8) {
      return parseInt(hex, 16);
    }
  }
  
  return defaultValue;
}

/** Convert HexOrientation string to number for WASM */
export function orientationToNumber(orientation: HexOrientation | undefined): number {
  return orientation === 'pointy-top' ? 1 : 0;
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
  
  /** Render CRT effect */
  renderCrt(input: ImageData | { data: Uint8Array; width: number; height: number }, options: CrtOptions = {}): ImageOutput {
    const data = input instanceof ImageData ? new Uint8Array(input.data.buffer) : input.data;
    const { width, height } = input;
    const scale = Math.min(32, Math.max(2, options.scale ?? 3));
    
    const result = this.wasm.crt_upscale_config(
      data,
      width,
      height,
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
    
    return readWasmOutput(this.wasm, result);
  }
  
  /** Render hexagonal effect */
  renderHex(input: ImageData | { data: Uint8Array; width: number; height: number }, options: HexOptions = {}): ImageOutput {
    const data = input instanceof ImageData ? new Uint8Array(input.data.buffer) : input.data;
    const { width, height } = input;
    const scale = Math.min(32, Math.max(2, options.scale ?? 16));
    
    const result = this.wasm.hex_upscale_config(
      data,
      width,
      height,
      scale,
      orientationToNumber(options.orientation),
      options.drawBorders ?? false,
      colorToRgba(options.borderColor, 0x282828FF),
      options.borderThickness ?? 1,
      colorToRgba(options.backgroundColor, 0x00000000),
    );
    
    return readWasmOutput(this.wasm, result);
  }
  
  /** Render xBRZ effect */
  renderXbrz(input: ImageData | { data: Uint8Array; width: number; height: number }, options: XbrzOptions = {}): ImageOutput {
    const data = input instanceof ImageData ? new Uint8Array(input.data.buffer) : input.data;
    const { width, height } = input;
    const scale = Math.min(6, Math.max(2, options.scale ?? 2));
    
    const result = this.wasm.xbrz_upscale_config(
      data,
      width,
      height,
      scale,
      options.equalColorTolerance ?? 30,
      options.centerDirectionBias ?? 4.0,
      options.dominantDirectionThreshold ?? 3.6,
      options.steepDirectionThreshold ?? 2.2,
    );
    
    return readWasmOutput(this.wasm, result);
  }
}
