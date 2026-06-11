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
    crt_upscale_config(data: Uint8Array, width: number, height: number, scale: number, warp_x: number, warp_y: number, scan_hardness: number, scan_opacity: number, mask_opacity: number, enable_warp: boolean, enable_scanlines: boolean, enable_mask: boolean): WasmUpscaleResult;
    /** HEX upscale with default config */
    hex_upscale(data: Uint8Array, width: number, height: number, scale: number): WasmUpscaleResult;
    /** HEX upscale with full config */
    hex_upscale_config(data: Uint8Array, width: number, height: number, scale: number, orientation: number, draw_borders: boolean, border_color: number, border_thickness: number, background_color: number): WasmUpscaleResult;
    /** Get HEX output dimensions */
    hex_get_dimensions(width: number, height: number, scale: number, orientation: number): Uint32Array;
    /** xBRZ upscale with default config */
    xbrz_upscale(data: Uint8Array, width: number, height: number, scale: number): WasmUpscaleResult;
    /** xBRZ upscale with full config */
    xbrz_upscale_config(data: Uint8Array, width: number, height: number, scale: number, equal_color_tolerance: number, center_direction_bias: number, dominant_direction_threshold: number, steep_direction_threshold: number): WasmUpscaleResult;
}
/** Helper to read WASM output into ImageOutput */
export declare function readWasmOutput(wasm: RenderArtWasm, result: WasmUpscaleResult): ImageOutput;
/** Parse color to RGBA number for WASM */
export declare function colorToRgba(color: string | number | undefined, defaultValue: number): number;
/** Convert HexOrientation string to number for WASM */
export declare function orientationToNumber(orientation: HexOrientation | undefined): number;
/**
 * High-level WASM renderer wrapper
 *
 * Provides the same interface as GPU renderers but uses WASM.
 */
export declare class WasmRenderer {
    private wasm;
    constructor(wasm: RenderArtWasm);
    /** Render CRT effect */
    renderCrt(input: ImageData | {
        data: Uint8Array;
        width: number;
        height: number;
    }, options?: CrtOptions): ImageOutput;
    /** Render hexagonal effect */
    renderHex(input: ImageData | {
        data: Uint8Array;
        width: number;
        height: number;
    }, options?: HexOptions): ImageOutput;
    /** Render xBRZ effect */
    renderXbrz(input: ImageData | {
        data: Uint8Array;
        width: number;
        height: number;
    }, options?: XbrzOptions): ImageOutput;
}
//# sourceMappingURL=wasm-wrapper.d.ts.map