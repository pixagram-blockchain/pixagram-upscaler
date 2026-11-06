/**
 * Batches of frames - animated GIF / WebP - processed one frame at a time.
 *
 * Memory is the point. The WASM module keeps the compressed file, ONE source
 * canvas (`width * height` RGBA) and ONE output buffer (shared with every
 * other render call). A frame is decoded and composited onto the canvas,
 * upscaled into the output buffer, handed to you as a zero-copy view, and
 * overwritten by the next frame. Nothing is accumulated, whatever the number
 * of frames or loops:
 *
 *   import init, * as wasm from '@pixagram/upscaler/wasm-anim';
 *   import { upscaleFrames } from '@pixagram/upscaler';
 *
 *   await init();
 *   for (const frame of upscaleFrames(wasm, gifBytes, { effect: 'xbrz', options: { scale: 4 } })) {
 *     // frame.data is valid until the loop continues: draw or copy it now.
 *     ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
 *     await sleep(frame.delay);
 *   }
 *
 * {@link WasmAnimation} is the lower-level handle (step, skip, rewind, render
 * the current frame with any effect); {@link upscaleFrameBatch} runs the same
 * one-frame-at-a-time loop over frames you decode yourself. For playback off
 * the main thread, see `WasmAnimationPool`.
 *
 * The decoder lives in the `anim` build of the module,
 * `@pixagram/upscaler/wasm-anim` (the default `@pixagram/upscaler/wasm` stays
 * small and has no `FrameDecoder`); it carries the upscalers too.
 */
import type { CrtOptions, HexOptions, ImageInput, ImageOutput, XbrzOptions } from './types.js';
import type { RenderArtWasm, WasmFrameDecoder, WasmUpscaleResult } from './wasm-wrapper.js';
import { WasmRenderer } from './wasm-wrapper.js';
/** How a frame is rendered: an upscaler, or `'none'` for the source frame. */
export type FrameEffect = 'xbrz' | 'crt' | 'hex' | 'none';
/** An effect and its options (`scale` included). */
export type FrameRenderSpec = {
    effect: 'xbrz';
    options?: XbrzOptions;
} | {
    effect: 'crt';
    options?: CrtOptions;
} | {
    effect: 'hex';
    options?: HexOptions;
} | {
    effect: 'none';
    options?: undefined;
};
/** A rendered frame of an animation. */
export interface RenderedFrame extends ImageOutput {
    /** Index of the frame within its loop. */
    index: number;
    /** How long to show it, in ms (durations under 11 ms play as 100 ms). */
    delay: number;
    /** Which loop it belongs to (0 = first play). */
    loop: number;
}
/** Options for {@link WasmAnimation.open}. */
export interface WasmAnimationOpenOptions {
    /** Refuse canvases larger than this many pixels (default 16 MP). */
    maxPixels?: number;
}
/**
 * Renders the current frame of a raw decoder into the module's shared output
 * buffer (or returns the canvas itself for `'none'`). The result object must
 * be read and freed by the caller.
 */
export declare function renderDecoderFrame(dec: WasmFrameDecoder, spec: FrameRenderSpec): WasmUpscaleResult;
/**
 * An animated (or still) GIF / WebP inside a WASM module, decoded one
 * composited frame at a time. Holds the compressed file and one canvas; call
 * {@link free} when done (a finalizer frees forgotten instances eventually).
 */
export declare class WasmAnimation {
    private readonly wasm;
    private dec;
    private constructor();
    /**
     * Parses `data` (copied into WASM memory) and allocates the canvas. Throws
     * on files that are not GIF/WebP, are corrupt before the first frame, or
     * exceed `maxPixels`.
     */
    static open(wasm: RenderArtWasm, data: Uint8Array | ArrayBuffer, options?: WasmAnimationOpenOptions): WasmAnimation;
    private get d();
    get format(): 'gif' | 'webp';
    /** Canvas size: the size of every source frame. */
    get width(): number;
    get height(): number;
    /** Frames in one loop. */
    get frameCount(): number;
    /** Total plays, 0 = forever. */
    get loopCount(): number;
    /** One loop in ms. */
    get durationMs(): number;
    /** More than one frame. */
    get animated(): boolean;
    /** Index of the frame on the canvas (-1 before the first `next()`). */
    get index(): number;
    /** How long to show the current frame, in ms. */
    get delay(): number;
    /** A frame failed to decode and the loop now ends before it. */
    get truncated(): boolean;
    /** Decodes the next frame; `false` at the end of the loop (see {@link rewind}). */
    next(): boolean;
    /** Advances `n` frames without rendering them; returns how many it advanced. */
    skip(n: number): number;
    /** Restarts at frame 0 with a transparent canvas. */
    rewind(): void;
    /**
     * Zero-copy view of the composited source frame. Valid until the next
     * `next()` / `skip()` / `rewind()` / `free()` (or a WASM memory growth).
     */
    frameView(): ImageOutput;
    /**
     * Renders the current frame and returns a zero-copy view of the module's
     * shared output buffer: valid until the next render call on this module.
     * `'none'` returns {@link frameView}.
     */
    renderView(spec: FrameRenderSpec): ImageOutput;
    /** Like {@link renderView}, but copied (into `out` when given). */
    render(spec: FrameRenderSpec, out?: Uint8ClampedArray): ImageOutput;
    /** Releases the decoder (compressed file and canvas). Idempotent. */
    free(): void;
}
/** Options for {@link upscaleFrames}. */
export interface UpscaleFramesOptions extends WasmAnimationOpenOptions {
    /**
     * Loops to process (default 1). `Infinity` follows the file: its own loop
     * count, or forever when it loops forever.
     */
    loops?: number;
}
/**
 * Renders every frame of an animation, one at a time, as a generator. Each
 * yielded frame's `data` is a zero-copy view that is valid only until the
 * generator resumes - draw or copy it first. Accepts the encoded file (the
 * decoder is opened and freed here) or an open {@link WasmAnimation} (left
 * open, positioned after the last frame rendered).
 */
export declare function upscaleFrames(wasm: RenderArtWasm, source: Uint8Array | ArrayBuffer | WasmAnimation, spec: FrameRenderSpec, options?: UpscaleFramesOptions): Generator<RenderedFrame, void, undefined>;
/**
 * Upscales frames you supply - from any decoder, any iterable or async
 * iterable - one at a time through a {@link WasmRenderer}. `onFrame` receives
 * a zero-copy view of the module's output buffer that is valid until it
 * returns (or until its promise settles); the next frame is not rendered
 * before that. Returns the number of frames processed.
 */
export declare function upscaleFrameBatch(renderer: WasmRenderer, frames: Iterable<ImageInput | ImageData> | AsyncIterable<ImageInput | ImageData>, spec: FrameRenderSpec, onFrame: (frame: ImageOutput, index: number) => void | Promise<void>): Promise<number>;
//# sourceMappingURL=frames.d.ts.map