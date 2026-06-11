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
    return UpscaleResult.__wrap(ret);
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
    return UpscaleResult.__wrap(ret);
}

/**
 * CUT3 upscale with default config
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @returns {UpscaleResult}
 */
export function cut_upscale(data, width, height, scale) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cut_upscale(ptr0, len0, width, height, scale);
    return UpscaleResult.__wrap(ret);
}

/**
 * CUT3 upscale with full config
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @param {boolean} use_dynamic_blend
 * @param {number} blend_min_contrast_edge
 * @param {number} blend_max_contrast_edge
 * @param {number} blend_min_sharpness
 * @param {number} blend_max_sharpness
 * @param {number} static_blend_sharpness
 * @param {boolean} edge_use_fast_luma
 * @param {boolean} soft_edges_sharpening
 * @param {number} soft_edges_sharpening_amount
 * @param {number} hard_edges_search_max_error
 * @param {number} hard_edges_search_max_distance
 * @returns {UpscaleResult}
 */
export function cut_upscale_config(data, width, height, scale, use_dynamic_blend, blend_min_contrast_edge, blend_max_contrast_edge, blend_min_sharpness, blend_max_sharpness, static_blend_sharpness, edge_use_fast_luma, soft_edges_sharpening, soft_edges_sharpening_amount, hard_edges_search_max_error, hard_edges_search_max_distance) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cut_upscale_config(ptr0, len0, width, height, scale, use_dynamic_blend, blend_min_contrast_edge, blend_max_contrast_edge, blend_min_sharpness, blend_max_sharpness, static_blend_sharpness, edge_use_fast_luma, soft_edges_sharpening, soft_edges_sharpening_amount, hard_edges_search_max_error, hard_edges_search_max_distance);
    return UpscaleResult.__wrap(ret);
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
    return UpscaleResult.__wrap(ret);
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
    return UpscaleResult.__wrap(ret);
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
    return UpscaleResult.__wrap(ret);
}

/**
 * XBRZ upscale with full config
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
    return UpscaleResult.__wrap(ret);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_undefined_67b456be8673d3d7: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_memory_fbc4c3e30b409f08: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_throw_1506f2235d1bdba0: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_instanceof_Window_e093be59ee9a8e14: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_static_accessor_GLOBAL_9d53f2689e622ca1: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_a1a35cec07001a8a: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_4c59f6c7ea29a144: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_e70ae9f2eb052253: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
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
const UpscaleResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_upscaleresult_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

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
