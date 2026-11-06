/* @ts-self-types="./renderart.d.ts" */

/**
 * Result of dimension calculation (avoids Vec allocation)
 */
export class Dimensions {
    static __wrap(ptr) {
        const obj = Object.create(Dimensions.prototype);
        obj.__wbg_ptr = ptr;
        DimensionsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DimensionsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dimensions_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_dimensions_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_dimensions_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set height(arg0) {
        wasm.__wbg_set_dimensions_height(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set width(arg0) {
        wasm.__wbg_set_dimensions_width(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) Dimensions.prototype[Symbol.dispose] = Dimensions.prototype.free;

/**
 * An animated (or still) GIF or WebP, decoded one composited frame at a time.
 *
 * The decoder keeps the compressed file and exactly one RGBA canvas the size
 * of the image. [`FrameDecoder::next_frame`] decodes the next frame and
 * composites it onto that canvas (disposal and blending as browsers do), so
 * an animation of any length never holds more than one frame. The
 * `upscale_*` methods render the current frame straight from the canvas into
 * the module's shared output buffer - the same single buffer every other
 * render call reuses - so a whole batch of frames is upscaled in the memory
 * of one output frame:
 *
 * ```js
 * const dec = new FrameDecoder(gifBytes);
 * while (dec.next_frame()) {
 *   const r = dec.upscale_xbrz(4, 30, 4, 3.6, 2.2);
 *   // r.ptr / r.len in get_memory().buffer: valid until the next render call.
 *   consume(new Uint8ClampedArray(get_memory().buffer, r.ptr, r.len), r.width, r.height, dec.delay_ms);
 *   r.free();
 * }
 * dec.free();
 * ```
 *
 * `next_frame` returns `false` at the end of a loop; `rewind` starts the
 * next one. Frames are not random-access: they depend on their predecessors.
 */
export class FrameDecoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FrameDecoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_framedecoder_free(ptr, 0);
    }
    /**
     * True when the image has more than one frame.
     * @returns {boolean}
     */
    get animated() {
        const ret = wasm.framedecoder_animated(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * How long browsers show the current frame, in milliseconds (declared
     * durations under 11 ms play as 100 ms).
     * @returns {number}
     */
    get delay_ms() {
        const ret = wasm.framedecoder_delay_ms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Duration of one loop in milliseconds (sum of the effective delays).
     * @returns {number}
     */
    get duration_ms() {
        const ret = wasm.framedecoder_duration_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * `"gif"` or `"webp"`.
     * @returns {string}
     */
    get format() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.framedecoder_format(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Zero-copy view of the current frame (`width x height` RGBA, not
     * premultiplied) in `get_memory().buffer`. Valid until the next
     * `next_frame` / `rewind` / `free`, or a memory growth.
     * @returns {UpscaleResult}
     */
    frame() {
        const ret = wasm.framedecoder_frame(this.__wbg_ptr);
        return UpscaleResult.__wrap(ret);
    }
    /**
     * Frames in one loop (from the headers; lowered if a frame turns out to
     * be undecodable, see `truncated`).
     * @returns {number}
     */
    get frame_count() {
        const ret = wasm.framedecoder_frame_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Canvas height in pixels.
     * @returns {number}
     */
    get height() {
        const ret = wasm.framedecoder_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Index of the frame on the canvas, or -1 before the first `next_frame`.
     * @returns {number}
     */
    get index() {
        const ret = wasm.framedecoder_index(this.__wbg_ptr);
        return ret;
    }
    /**
     * Total number of plays; 0 = loop forever.
     * @returns {number}
     */
    get loop_count() {
        const ret = wasm.framedecoder_loop_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Parses `data` (GIF87a/89a or RIFF WebP, animated or still; copied into
     * the module) and allocates the canvas. No frame is decoded yet.
     * Canvases over `max_pixels` (default 16 MP) are refused.
     * @param {Uint8Array} data
     * @param {number | null} [max_pixels]
     */
    constructor(data, max_pixels) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.framedecoder_new(ptr0, len0, isLikeNone(max_pixels) ? Number.MAX_SAFE_INTEGER : (max_pixels) >>> 0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        FrameDecoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Decodes the next frame onto the canvas. `false` (canvas unchanged) at
     * the end of the loop. Throws only if the first frame cannot be decoded.
     * @returns {boolean}
     */
    next_frame() {
        const ret = wasm.framedecoder_next_frame(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * The current frame's declared duration, in milliseconds.
     * @returns {number}
     */
    get raw_delay_ms() {
        const ret = wasm.framedecoder_raw_delay_ms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Back to the start of the animation: transparent canvas, frame 0 next.
     */
    rewind() {
        const ret = wasm.framedecoder_rewind(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Advances `n` frames without rendering them (each is still composited:
     * frames build on each other). Returns how many were advanced.
     * @param {number} n
     * @returns {number}
     */
    skip_frames(n) {
        const ret = wasm.framedecoder_skip_frames(this.__wbg_ptr, n);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * True once a frame failed to decode and the loop was cut short there.
     * @returns {boolean}
     */
    get truncated() {
        const ret = wasm.framedecoder_truncated(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * CRT effect on the current frame into the shared output buffer
     * (see `crt_upscale_config`).
     * @param {number} scale
     * @param {number} warp_x
     * @param {number} warp_y
     * @param {number} scan_hardness
     * @param {number} scan_opacity
     * @param {number} mask_opacity
     * @param {boolean} enable_warp
     * @param {boolean} enable_scanlines
     * @param {boolean} enable_mask
     * @returns {UpscaleResult}
     */
    upscale_crt(scale, warp_x, warp_y, scan_hardness, scan_opacity, mask_opacity, enable_warp, enable_scanlines, enable_mask) {
        const ret = wasm.framedecoder_upscale_crt(this.__wbg_ptr, scale, warp_x, warp_y, scan_hardness, scan_opacity, mask_opacity, enable_warp, enable_scanlines, enable_mask);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UpscaleResult.__wrap(ret[0]);
    }
    /**
     * Hexagonal effect on the current frame into the shared output buffer
     * (see `hex_upscale_config`).
     * @param {number} scale
     * @param {number} orientation
     * @param {boolean} draw_borders
     * @param {number} border_color
     * @param {number} border_thickness
     * @param {number} background_color
     * @returns {UpscaleResult}
     */
    upscale_hex(scale, orientation, draw_borders, border_color, border_thickness, background_color) {
        const ret = wasm.framedecoder_upscale_hex(this.__wbg_ptr, scale, orientation, draw_borders, border_color, border_thickness, background_color);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UpscaleResult.__wrap(ret[0]);
    }
    /**
     * xBRZ upscale of the current frame into the shared output buffer
     * (see `xbrz_upscale_config`).
     * @param {number} scale
     * @param {number} equal_color_tolerance
     * @param {number} center_direction_bias
     * @param {number} dominant_direction_threshold
     * @param {number} steep_direction_threshold
     * @returns {UpscaleResult}
     */
    upscale_xbrz(scale, equal_color_tolerance, center_direction_bias, dominant_direction_threshold, steep_direction_threshold) {
        const ret = wasm.framedecoder_upscale_xbrz(this.__wbg_ptr, scale, equal_color_tolerance, center_direction_bias, dominant_direction_threshold, steep_direction_threshold);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UpscaleResult.__wrap(ret[0]);
    }
    /**
     * Canvas width in pixels.
     * @returns {number}
     */
    get width() {
        const ret = wasm.framedecoder_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) FrameDecoder.prototype[Symbol.dispose] = FrameDecoder.prototype.free;

/**
 * Result of an upscale operation
 */
export class UpscaleResult {
    static __wrap(ptr) {
        const obj = Object.create(UpscaleResult.prototype);
        obj.__wbg_ptr = ptr;
        UpscaleResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UpscaleResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_upscaleresult_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_upscaleresult_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get len() {
        const ret = wasm.__wbg_get_upscaleresult_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get ptr() {
        const ret = wasm.__wbg_get_upscaleresult_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_upscaleresult_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set height(arg0) {
        wasm.__wbg_set_upscaleresult_height(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set len(arg0) {
        wasm.__wbg_set_upscaleresult_len(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set ptr(arg0) {
        wasm.__wbg_set_upscaleresult_ptr(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set width(arg0) {
        wasm.__wbg_set_upscaleresult_width(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) UpscaleResult.prototype[Symbol.dispose] = UpscaleResult.prototype.free;

/**
 * CRT upscale with default config
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @returns {UpscaleResult}
 */
export function crt_upscale(data, width, height, scale) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.crt_upscale(ptr0, len0, width, height, scale);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return UpscaleResult.__wrap(ret[0]);
}

/**
 * CRT upscale with full config
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @param {number} warp_x
 * @param {number} warp_y
 * @param {number} scan_hardness
 * @param {number} scan_opacity
 * @param {number} mask_opacity
 * @param {boolean} enable_warp
 * @param {boolean} enable_scanlines
 * @param {boolean} enable_mask
 * @returns {UpscaleResult}
 */
export function crt_upscale_config(data, width, height, scale, warp_x, warp_y, scan_hardness, scan_opacity, mask_opacity, enable_warp, enable_scanlines, enable_mask) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.crt_upscale_config(ptr0, len0, width, height, scale, warp_x, warp_y, scan_hardness, scan_opacity, mask_opacity, enable_warp, enable_scanlines, enable_mask);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return UpscaleResult.__wrap(ret[0]);
}

/**
 * Get WASM memory for reading output buffers
 * @returns {any}
 */
export function get_memory() {
    const ret = wasm.get_memory();
    return ret;
}

/**
 * Get HEX output dimensions (no allocation)
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @param {number} orientation
 * @returns {Dimensions}
 */
export function hex_get_dimensions(width, height, scale, orientation) {
    const ret = wasm.hex_get_dimensions(width, height, scale, orientation);
    return Dimensions.__wrap(ret);
}

/**
 * HEX upscale with default config
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @returns {UpscaleResult}
 */
export function hex_upscale(data, width, height, scale) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.hex_upscale(ptr0, len0, width, height, scale);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return UpscaleResult.__wrap(ret[0]);
}

/**
 * HEX upscale with full config
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @param {number} orientation
 * @param {boolean} draw_borders
 * @param {number} border_color
 * @param {number} border_thickness
 * @param {number} background_color
 * @returns {UpscaleResult}
 */
export function hex_upscale_config(data, width, height, scale, orientation, draw_borders, border_color, border_thickness, background_color) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.hex_upscale_config(ptr0, len0, width, height, scale, orientation, draw_borders, border_color, border_thickness, background_color);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return UpscaleResult.__wrap(ret[0]);
}

/**
 * Releases the shared output buffer (e.g. after a one-off large render).
 * The next call allocates again. WebAssembly memory itself never shrinks,
 * but the space becomes reusable by the module.
 */
export function release_buffers() {
    wasm.release_buffers();
}

/**
 * XBRZ upscale with default config
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @returns {UpscaleResult}
 */
export function xbrz_upscale(data, width, height, scale) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.xbrz_upscale(ptr0, len0, width, height, scale);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return UpscaleResult.__wrap(ret[0]);
}

/**
 * Renders only source rows `[y0, y1)` of a `width x height` image: the
 * result holds destination rows `[y0 * scale, y1 * scale)`.
 *
 * `window` carries source rows `[window_y0, window_y0 + window.len() / (4 *
 * width))`, which must cover `[y0 - 2, y1 + 2)` clipped to the image (the
 * kernel's halo). Bands rendered independently - e.g. one per Web Worker -
 * and stacked are byte-identical to a full render. `scale` must be 2..=8.
 * @param {Uint8Array} window
 * @param {number} width
 * @param {number} height
 * @param {number} window_y0
 * @param {number} y0
 * @param {number} y1
 * @param {number} scale
 * @param {number} equal_color_tolerance
 * @param {number} center_direction_bias
 * @param {number} dominant_direction_threshold
 * @param {number} steep_direction_threshold
 * @returns {UpscaleResult}
 */
export function xbrz_upscale_band(window, width, height, window_y0, y0, y1, scale, equal_color_tolerance, center_direction_bias, dominant_direction_threshold, steep_direction_threshold) {
    const ptr0 = passArray8ToWasm0(window, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.xbrz_upscale_band(ptr0, len0, width, height, window_y0, y0, y1, scale, equal_color_tolerance, center_direction_bias, dominant_direction_threshold, steep_direction_threshold);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return UpscaleResult.__wrap(ret[0]);
}

/**
 * XBRZ upscale with full config. `scale` is clamped to 1..=8.
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @param {number} equal_color_tolerance
 * @param {number} center_direction_bias
 * @param {number} dominant_direction_threshold
 * @param {number} steep_direction_threshold
 * @returns {UpscaleResult}
 */
export function xbrz_upscale_config(data, width, height, scale, equal_color_tolerance, center_direction_bias, dominant_direction_threshold, steep_direction_threshold) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.xbrz_upscale_config(ptr0, len0, width, height, scale, equal_color_tolerance, center_direction_bias, dominant_direction_threshold, steep_direction_threshold);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return UpscaleResult.__wrap(ret[0]);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_ef53bc310eb298a0: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_memory_fbc4c3e30b409f08: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_throw_1506f2235d1bdba0: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./renderart_bg.js": import0,
    };
}

const DimensionsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dimensions_free(ptr, 1));
const FrameDecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_framedecoder_free(ptr, 1));
const UpscaleResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_upscaleresult_free(ptr, 1));

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('renderart_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
