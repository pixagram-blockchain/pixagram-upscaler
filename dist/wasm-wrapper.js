/**
 * RenderArt WASM Module Wrapper
 *
 * Provides TypeScript type definitions and helper functions
 * for the WebAssembly module.
 */
/** Helper to read WASM output into ImageOutput */
export function readWasmOutput(wasm, result) {
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
export function colorToRgba(color, defaultValue) {
    if (color === undefined)
        return defaultValue;
    if (typeof color === 'number')
        return color;
    if (color === 'transparent')
        return 0x00000000;
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
export function orientationToNumber(orientation) {
    return orientation === 'pointy-top' ? 1 : 0;
}
/**
 * High-level WASM renderer wrapper
 *
 * Provides the same interface as GPU renderers but uses WASM.
 */
export class WasmRenderer {
    wasm;
    constructor(wasm) {
        this.wasm = wasm;
    }
    /** Render CRT effect */
    renderCrt(input, options = {}) {
        const data = input instanceof ImageData ? new Uint8Array(input.data.buffer) : input.data;
        const { width, height } = input;
        const scale = Math.min(32, Math.max(2, options.scale ?? 3));
        const result = this.wasm.crt_upscale_config(data, width, height, scale, options.warpX ?? 0.015, options.warpY ?? 0.02, options.scanHardness ?? -4.0, options.scanOpacity ?? 0.5, options.maskOpacity ?? 0.3, options.enableWarp !== false, options.enableScanlines !== false, options.enableMask !== false);
        return readWasmOutput(this.wasm, result);
    }
    /** Render hexagonal effect */
    renderHex(input, options = {}) {
        const data = input instanceof ImageData ? new Uint8Array(input.data.buffer) : input.data;
        const { width, height } = input;
        const scale = Math.min(32, Math.max(2, options.scale ?? 16));
        const result = this.wasm.hex_upscale_config(data, width, height, scale, orientationToNumber(options.orientation), options.drawBorders ?? false, colorToRgba(options.borderColor, 0x282828FF), options.borderThickness ?? 1, colorToRgba(options.backgroundColor, 0x00000000));
        return readWasmOutput(this.wasm, result);
    }
    /** Render xBRZ effect */
    renderXbrz(input, options = {}) {
        const data = input instanceof ImageData ? new Uint8Array(input.data.buffer) : input.data;
        const { width, height } = input;
        const scale = Math.min(6, Math.max(2, options.scale ?? 2));
        const result = this.wasm.xbrz_upscale_config(data, width, height, scale, options.equalColorTolerance ?? 30, options.centerDirectionBias ?? 4.0, options.dominantDirectionThreshold ?? 3.6, options.steepDirectionThreshold ?? 2.2);
        return readWasmOutput(this.wasm, result);
    }
    /** Render CUT3 (Cheap Upscaling Triangulation) upscale */
    renderCut(input, options = {}) {
        const data = input instanceof ImageData ? new Uint8Array(input.data.buffer) : input.data;
        const { width, height } = input;
        const scale = Math.min(32, Math.max(1, options.scale ?? 3));
        const result = this.wasm.cut_upscale_config(data, width, height, scale, options.useDynamicBlend !== false, options.blendMinContrastEdge ?? 0.0, options.blendMaxContrastEdge ?? 0.25, options.blendMinSharpness ?? 0.0, options.blendMaxSharpness ?? 0.75, options.staticBlendSharpness ?? 0.5, options.edgeUseFastLuma === true, options.softEdgesSharpening !== false, options.softEdgesSharpeningAmount ?? 1.0, options.hardEdgesSearchMaxError ?? 0.25, options.hardEdgesSearchMaxDistance ?? 4);
        return readWasmOutput(this.wasm, result);
    }
}
//# sourceMappingURL=wasm-wrapper.js.map