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
    crt_upscale_config(data: Uint8Array, width: number, height: number, scale: number, warp_x: number, warp_y: number, scan_hardness: number, scan_opacity: number, mask_opacity: number, enable_warp: boolean, enable_scanlines: boolean, enable_mask: boolean): WasmUpscaleResult;
    /** HEX upscale with default config */
    hex_upscale(data: Uint8Array, width: number, height: number, scale: number): WasmUpscaleResult;
    /** HEX upscale with full config */
    hex_upscale_config(data: Uint8Array, width: number, height: number, scale: number, orientation: number, draw_borders: boolean, border_color: number, border_thickness: number, background_color: number): WasmUpscaleResult;
    /** Get HEX output dimensions */
    hex_get_dimensions(width: number, height: number, scale: number, orientation: number): WasmDimensions;
    /** xBRZ upscale with default config */
    xbrz_upscale(data: Uint8Array, width: number, height: number, scale: number): WasmUpscaleResult;
    /** xBRZ upscale with full config */
    xbrz_upscale_config(data: Uint8Array, width: number, height: number, scale: number, equal_color_tolerance: number, center_direction_bias: number, dominant_direction_threshold: number, steep_direction_threshold: number): WasmUpscaleResult;
    /**
     * xBRZ for source rows [y0, y1) only. `window` holds source rows
     * [window_y0, ...) and must cover [y0 - 2, y1 + 2) clipped to the image.
     * Used by {@link WasmXbrzPool}; bands stack byte-identically.
     */
    xbrz_upscale_band?(window: Uint8Array, width: number, height: number, window_y0: number, y0: number, y1: number, scale: number, equal_color_tolerance: number, center_direction_bias: number, dominant_direction_threshold: number, steep_direction_threshold: number): WasmUpscaleResult;
}
/**
 * Zero-copy view of a result in WASM memory. Valid until the next render call
 * on the same module, or until WASM memory grows (which detaches the buffer).
 */
export declare function viewWasmOutput(wasm: RenderArtWasm, result: WasmUpscaleResult): ImageOutput;
/**
 * Helper to read WASM output into ImageOutput. Copies into `out` when given
 * (must hold at least `len` bytes; no allocation), else into a new array.
 */
export declare function readWasmOutput(wasm: RenderArtWasm, result: WasmUpscaleResult, out?: Uint8ClampedArray): ImageOutput;
/** Parse color to RGBA number for WASM */
export declare function colorToRgba(color: string | number | undefined, defaultValue: number): number;
/** Convert HexOrientation string to number for WASM */
export declare function orientationToNumber(orientation: HexOrientation | undefined): number;
type WasmInput = ImageData | {
    data: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
};
/**
 * High-level WASM renderer wrapper
 *
 * Provides the same interface as GPU renderers but uses WASM.
 */
export declare class WasmRenderer {
    private wasm;
    constructor(wasm: RenderArtWasm);
    private crtResult;
    private hexResult;
    private xbrzResult;
    /** Render CRT effect (copied; into `out` when given). */
    renderCrt(input: WasmInput, options?: CrtOptions, out?: Uint8ClampedArray): ImageOutput;
    /** Render hexagonal effect (copied; into `out` when given). */
    renderHex(input: WasmInput, options?: HexOptions, out?: Uint8ClampedArray): ImageOutput;
    /** Render xBRZ effect (copied; into `out` when given). */
    renderXbrz(input: WasmInput, options?: XbrzOptions, out?: Uint8ClampedArray): ImageOutput;
    /** CRT effect as a zero-copy view (valid until the next render call). */
    renderCrtView(input: WasmInput, options?: CrtOptions): ImageOutput;
    /** Hexagonal effect as a zero-copy view (valid until the next render call). */
    renderHexView(input: WasmInput, options?: HexOptions): ImageOutput;
    /** xBRZ as a zero-copy view (valid until the next render call). */
    renderXbrzView(input: WasmInput, options?: XbrzOptions): ImageOutput;
}
export {};
//# sourceMappingURL=wasm-wrapper.d.ts.map