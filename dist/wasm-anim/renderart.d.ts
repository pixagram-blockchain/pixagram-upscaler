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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Zero-copy view of the current frame (`width x height` RGBA, not
     * premultiplied) in `get_memory().buffer`. Valid until the next
     * `next_frame` / `rewind` / `free`, or a memory growth.
     */
    frame(): UpscaleResult;
    /**
     * Parses `data` (GIF87a/89a or RIFF WebP, animated or still; copied into
     * the module) and allocates the canvas. No frame is decoded yet.
     * Canvases over `max_pixels` (default 16 MP) are refused.
     */
    constructor(data: Uint8Array, max_pixels?: number | null);
    /**
     * Decodes the next frame onto the canvas. `false` (canvas unchanged) at
     * the end of the loop. Throws only if the first frame cannot be decoded.
     */
    next_frame(): boolean;
    /**
     * Back to the start of the animation: transparent canvas, frame 0 next.
     */
    rewind(): void;
    /**
     * Advances `n` frames without rendering them (each is still composited:
     * frames build on each other). Returns how many were advanced.
     */
    skip_frames(n: number): number;
    /**
     * CRT effect on the current frame into the shared output buffer
     * (see `crt_upscale_config`).
     */
    upscale_crt(scale: number, warp_x: number, warp_y: number, scan_hardness: number, scan_opacity: number, mask_opacity: number, enable_warp: boolean, enable_scanlines: boolean, enable_mask: boolean): UpscaleResult;
    /**
     * Hexagonal effect on the current frame into the shared output buffer
     * (see `hex_upscale_config`).
     */
    upscale_hex(scale: number, orientation: number, draw_borders: boolean, border_color: number, border_thickness: number, background_color: number): UpscaleResult;
    /**
     * xBRZ upscale of the current frame into the shared output buffer
     * (see `xbrz_upscale_config`).
     */
    upscale_xbrz(scale: number, equal_color_tolerance: number, center_direction_bias: number, dominant_direction_threshold: number, steep_direction_threshold: number): UpscaleResult;
    /**
     * True when the image has more than one frame.
     */
    readonly animated: boolean;
    /**
     * How long browsers show the current frame, in milliseconds (declared
     * durations under 11 ms play as 100 ms).
     */
    readonly delay_ms: number;
    /**
     * Duration of one loop in milliseconds (sum of the effective delays).
     */
    readonly duration_ms: number;
    /**
     * `"gif"` or `"webp"`.
     */
    readonly format: string;
    /**
     * Frames in one loop (from the headers; lowered if a frame turns out to
     * be undecodable, see `truncated`).
     */
    readonly frame_count: number;
    /**
     * Canvas height in pixels.
     */
    readonly height: number;
    /**
     * Index of the frame on the canvas, or -1 before the first `next_frame`.
     */
    readonly index: number;
    /**
     * Total number of plays; 0 = loop forever.
     */
    readonly loop_count: number;
    /**
     * The current frame's declared duration, in milliseconds.
     */
    readonly raw_delay_ms: number;
    /**
     * True once a frame failed to decode and the loop was cut short there.
     */
    readonly truncated: boolean;
    /**
     * Canvas width in pixels.
     */
    readonly width: number;
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
 * Releases the shared output buffer (e.g. after a one-off large render).
 * The next call allocates again. WebAssembly memory itself never shrinks,
 * but the space becomes reusable by the module.
 */
export function release_buffers(): void;

/**
 * XBRZ upscale with default config
 */
export function xbrz_upscale(data: Uint8Array, width: number, height: number, scale: number): UpscaleResult;

/**
 * Renders only source rows `[y0, y1)` of a `width x height` image: the
 * result holds destination rows `[y0 * scale, y1 * scale)`.
 *
 * `window` carries source rows `[window_y0, window_y0 + window.len() / (4 *
 * width))`, which must cover `[y0 - 2, y1 + 2)` clipped to the image (the
 * kernel's halo). Bands rendered independently - e.g. one per Web Worker -
 * and stacked are byte-identical to a full render. `scale` must be 2..=8.
 */
export function xbrz_upscale_band(window: Uint8Array, width: number, height: number, window_y0: number, y0: number, y1: number, scale: number, equal_color_tolerance: number, center_direction_bias: number, dominant_direction_threshold: number, steep_direction_threshold: number): UpscaleResult;

/**
 * XBRZ upscale with full config. `scale` is clamped to 1..=8.
 */
export function xbrz_upscale_config(data: Uint8Array, width: number, height: number, scale: number, equal_color_tolerance: number, center_direction_bias: number, dominant_direction_threshold: number, steep_direction_threshold: number): UpscaleResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_dimensions_free: (a: number, b: number) => void;
    readonly __wbg_framedecoder_free: (a: number, b: number) => void;
    readonly __wbg_get_dimensions_height: (a: number) => number;
    readonly __wbg_get_dimensions_width: (a: number) => number;
    readonly __wbg_get_upscaleresult_height: (a: number) => number;
    readonly __wbg_get_upscaleresult_width: (a: number) => number;
    readonly __wbg_set_dimensions_height: (a: number, b: number) => void;
    readonly __wbg_set_dimensions_width: (a: number, b: number) => void;
    readonly __wbg_set_upscaleresult_height: (a: number, b: number) => void;
    readonly __wbg_set_upscaleresult_width: (a: number, b: number) => void;
    readonly __wbg_upscaleresult_free: (a: number, b: number) => void;
    readonly crt_upscale: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly crt_upscale_config: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number];
    readonly framedecoder_animated: (a: number) => number;
    readonly framedecoder_delay_ms: (a: number) => number;
    readonly framedecoder_duration_ms: (a: number) => number;
    readonly framedecoder_format: (a: number) => [number, number];
    readonly framedecoder_frame: (a: number) => number;
    readonly framedecoder_frame_count: (a: number) => number;
    readonly framedecoder_height: (a: number) => number;
    readonly framedecoder_index: (a: number) => number;
    readonly framedecoder_loop_count: (a: number) => number;
    readonly framedecoder_new: (a: number, b: number, c: number) => [number, number, number];
    readonly framedecoder_next_frame: (a: number) => [number, number, number];
    readonly framedecoder_raw_delay_ms: (a: number) => number;
    readonly framedecoder_rewind: (a: number) => [number, number];
    readonly framedecoder_skip_frames: (a: number, b: number) => [number, number, number];
    readonly framedecoder_truncated: (a: number) => number;
    readonly framedecoder_upscale_crt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly framedecoder_upscale_hex: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly framedecoder_upscale_xbrz: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly framedecoder_width: (a: number) => number;
    readonly hex_get_dimensions: (a: number, b: number, c: number, d: number) => number;
    readonly hex_upscale: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly hex_upscale_config: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly xbrz_upscale: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly xbrz_upscale_band: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly xbrz_upscale_config: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly __wbg_get_upscaleresult_len: (a: number) => number;
    readonly __wbg_get_upscaleresult_ptr: (a: number) => number;
    readonly __wbg_set_upscaleresult_len: (a: number, b: number) => void;
    readonly __wbg_set_upscaleresult_ptr: (a: number, b: number) => void;
    readonly release_buffers: () => void;
    readonly get_memory: () => any;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
