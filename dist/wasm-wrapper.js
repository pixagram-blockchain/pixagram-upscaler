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
/** Reads the fields of a result and frees the wasm-bindgen wrapper object. */
function takeResult(result) {
    const r = { ptr: result.ptr, len: result.len, width: result.width, height: result.height };
    result.free?.();
    return r;
}
/**
 * Zero-copy view of a result in WASM memory. Valid until the next render call
 * on the same module, or until WASM memory grows (which detaches the buffer).
 */
export function viewWasmOutput(wasm, result) {
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
export function readWasmOutput(wasm, result, out) {
    const r = takeResult(result);
    const view = new Uint8ClampedArray(wasm.get_memory().buffer, r.ptr, r.len);
    let data;
    if (out) {
        if (out.length < r.len) {
            throw new RangeError(`output buffer holds ${out.length} bytes, ${r.len} needed`);
        }
        data = out.length === r.len ? out : out.subarray(0, r.len);
        data.set(view);
    }
    else {
        // Copy so the result survives later renders and memory growth.
        data = new Uint8ClampedArray(view);
    }
    return { data, width: r.width, height: r.height };
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
            return ((parseInt(hex, 16) << 8) | 0xff) >>> 0;
        }
        if (hex.length === 8) {
            return parseInt(hex, 16) >>> 0;
        }
    }
    return defaultValue;
}
/** Convert HexOrientation string to number for WASM */
export function orientationToNumber(orientation) {
    return orientation === 'pointy-top' ? 1 : 0;
}
/** Raw RGBA bytes of an input without copying. */
function bytesOf(input) {
    const d = input.data;
    return d instanceof Uint8Array ? d : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}
/** Integer scale in [min, max]; non-finite values (NaN, undefined) give `def`. */
function clampScale(scale, def, min, max) {
    const s = typeof scale === 'number' && Number.isFinite(scale) ? Math.floor(scale) : def;
    return Math.min(max, Math.max(min, s));
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
    crtResult(input, options) {
        const scale = clampScale(options.scale, 3, 2, 32);
        return this.wasm.crt_upscale_config(bytesOf(input), input.width, input.height, scale, options.warpX ?? 0.015, options.warpY ?? 0.02, options.scanHardness ?? -4.0, options.scanOpacity ?? 0.5, options.maskOpacity ?? 0.3, options.enableWarp !== false, options.enableScanlines !== false, options.enableMask !== false);
    }
    hexResult(input, options) {
        const scale = clampScale(options.scale, 16, 2, 32);
        return this.wasm.hex_upscale_config(bytesOf(input), input.width, input.height, scale, orientationToNumber(options.orientation), options.drawBorders ?? false, colorToRgba(options.borderColor, 0x282828ff), options.borderThickness ?? 1, colorToRgba(options.backgroundColor, 0x00000000));
    }
    xbrzResult(input, options) {
        const scale = clampScale(options.scale, 2, 2, 8);
        return this.wasm.xbrz_upscale_config(bytesOf(input), input.width, input.height, scale, options.equalColorTolerance ?? 30, options.centerDirectionBias ?? 4.0, options.dominantDirectionThreshold ?? 3.6, options.steepDirectionThreshold ?? 2.2);
    }
    /** Render CRT effect (copied; into `out` when given). */
    renderCrt(input, options = {}, out) {
        return readWasmOutput(this.wasm, this.crtResult(input, options), out);
    }
    /** Render hexagonal effect (copied; into `out` when given). */
    renderHex(input, options = {}, out) {
        return readWasmOutput(this.wasm, this.hexResult(input, options), out);
    }
    /** Render xBRZ effect (copied; into `out` when given). */
    renderXbrz(input, options = {}, out) {
        return readWasmOutput(this.wasm, this.xbrzResult(input, options), out);
    }
    /** CRT effect as a zero-copy view (valid until the next render call). */
    renderCrtView(input, options = {}) {
        return viewWasmOutput(this.wasm, this.crtResult(input, options));
    }
    /** Hexagonal effect as a zero-copy view (valid until the next render call). */
    renderHexView(input, options = {}) {
        return viewWasmOutput(this.wasm, this.hexResult(input, options));
    }
    /** xBRZ as a zero-copy view (valid until the next render call). */
    renderXbrzView(input, options = {}) {
        return viewWasmOutput(this.wasm, this.xbrzResult(input, options));
    }
}
//# sourceMappingURL=wasm-wrapper.js.map