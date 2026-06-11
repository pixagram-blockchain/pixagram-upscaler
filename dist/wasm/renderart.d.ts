/* tslint:disable */
/* eslint-disable */

/**
 * Result of dimension calculation (avoids Vec allocation)
 */
export class Dimensions {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    height: number;
    width: number;
}

/**
 * Result of an upscale operation
 */
export class UpscaleResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    height: number;
    len: number;
    ptr: number;
    width: number;
}

/**
 * CRT upscale with default config
 */
export function crt_upscale(data: Uint8Array, width: number, height: number, scale: number): UpscaleResult;

/**
 * CRT upscale with full config
 */
export function crt_upscale_config(data: Uint8Array, width: number, height: number, scale: number, warp_x: number, warp_y: number, scan_hardness: number, scan_opacity: number, mask_opacity: number, enable_warp: boolean, enable_scanlines: boolean, enable_mask: boolean): UpscaleResult;

/**
 * CUT3 upscale with default config
 */
export function cut_upscale(data: Uint8Array, width: number, height: number, scale: number): UpscaleResult;

/**
 * CUT3 upscale with full config
 */
export function cut_upscale_config(data: Uint8Array, width: number, height: number, scale: number, use_dynamic_blend: boolean, blend_min_contrast_edge: number, blend_max_contrast_edge: number, blend_min_sharpness: number, blend_max_sharpness: number, static_blend_sharpness: number, edge_use_fast_luma: boolean, soft_edges_sharpening: boolean, soft_edges_sharpening_amount: number, hard_edges_search_max_error: number, hard_edges_search_max_distance: number): UpscaleResult;

/**
 * Get WASM memory for reading output buffers
 */
export function get_memory(): any;

/**
 * Get HEX output dimensions (no allocation)
 */
export function hex_get_dimensions(width: number, height: number, scale: number, orientation: number): Dimensions;

/**
 * HEX upscale with default config
 */
export function hex_upscale(data: Uint8Array, width: number, height: number, scale: number): UpscaleResult;

/**
 * HEX upscale with full config
 */
export function hex_upscale_config(data: Uint8Array, width: number, height: number, scale: number, orientation: number, draw_borders: boolean, border_color: number, border_thickness: number, background_color: number): UpscaleResult;

/**
 * XBRZ upscale with default config
 */
export function xbrz_upscale(data: Uint8Array, width: number, height: number, scale: number): UpscaleResult;

/**
 * XBRZ upscale with full config
 */
export function xbrz_upscale_config(data: Uint8Array, width: number, height: number, scale: number, equal_color_tolerance: number, center_direction_bias: number, dominant_direction_threshold: number, steep_direction_threshold: number): UpscaleResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_dimensions_free: (a: number, b: number) => void;
    readonly __wbg_get_dimensions_height: (a: number) => number;
    readonly __wbg_get_dimensions_width: (a: number) => number;
    readonly __wbg_get_upscaleresult_height: (a: number) => number;
    readonly __wbg_get_upscaleresult_width: (a: number) => number;
    readonly __wbg_set_dimensions_height: (a: number, b: number) => void;
    readonly __wbg_set_dimensions_width: (a: number, b: number) => void;
    readonly __wbg_set_upscaleresult_height: (a: number, b: number) => void;
    readonly __wbg_set_upscaleresult_width: (a: number, b: number) => void;
    readonly __wbg_upscaleresult_free: (a: number, b: number) => void;
    readonly crt_upscale: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly crt_upscale_config: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => number;
    readonly cut_upscale: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly cut_upscale_config: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => number;
    readonly hex_get_dimensions: (a: number, b: number, c: number, d: number) => number;
    readonly hex_upscale: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly hex_upscale_config: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly xbrz_upscale: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly xbrz_upscale_config: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly __wbg_get_upscaleresult_len: (a: number) => number;
    readonly __wbg_get_upscaleresult_ptr: (a: number) => number;
    readonly __wbg_set_upscaleresult_len: (a: number, b: number) => void;
    readonly __wbg_set_upscaleresult_ptr: (a: number, b: number) => void;
    readonly get_memory: () => any;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
