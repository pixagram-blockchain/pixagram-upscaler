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
import { crtArgs, hexArgs, readWasmOutput, viewWasmOutput, xbrzArgs } from './wasm-wrapper.js';
/** `wasm` with the 0.5.0+ `FrameDecoder` export, or a clear error. */
function frameDecoderClass(wasm) {
    const ctor = wasm.FrameDecoder;
    if (typeof ctor !== 'function') {
        throw new Error('this WASM module has no FrameDecoder: use @pixagram/upscaler/wasm-anim (0.5.0+)');
    }
    return ctor;
}
function asBytes(data) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}
/**
 * Renders the current frame of a raw decoder into the module's shared output
 * buffer (or returns the canvas itself for `'none'`). The result object must
 * be read and freed by the caller.
 */
export function renderDecoderFrame(dec, spec) {
    switch (spec.effect) {
        case 'xbrz':
            return dec.upscale_xbrz(...xbrzArgs(spec.options));
        case 'crt':
            return dec.upscale_crt(...crtArgs(spec.options));
        case 'hex':
            return dec.upscale_hex(...hexArgs(spec.options));
        case 'none':
            return dec.frame();
        default:
            throw new Error(`unknown frame effect: ${spec.effect}`);
    }
}
/**
 * An animated (or still) GIF / WebP inside a WASM module, decoded one
 * composited frame at a time. Holds the compressed file and one canvas; call
 * {@link free} when done (a finalizer frees forgotten instances eventually).
 */
export class WasmAnimation {
    wasm;
    dec;
    constructor(wasm, dec) {
        this.wasm = wasm;
        this.dec = dec;
    }
    /**
     * Parses `data` (copied into WASM memory) and allocates the canvas. Throws
     * on files that are not GIF/WebP, are corrupt before the first frame, or
     * exceed `maxPixels`.
     */
    static open(wasm, data, options = {}) {
        const Decoder = frameDecoderClass(wasm);
        const max = options.maxPixels;
        const dec = new Decoder(asBytes(data), max !== undefined && max > 0 ? Math.min(0xffffffff, Math.floor(max)) : undefined);
        return new WasmAnimation(wasm, dec);
    }
    get d() {
        if (!this.dec)
            throw new Error('WasmAnimation freed');
        return this.dec;
    }
    get format() {
        return this.d.format;
    }
    /** Canvas size: the size of every source frame. */
    get width() {
        return this.d.width;
    }
    get height() {
        return this.d.height;
    }
    /** Frames in one loop. */
    get frameCount() {
        return this.d.frame_count;
    }
    /** Total plays, 0 = forever. */
    get loopCount() {
        return this.d.loop_count;
    }
    /** One loop in ms. */
    get durationMs() {
        return this.d.duration_ms;
    }
    /** More than one frame. */
    get animated() {
        return this.d.animated;
    }
    /** Index of the frame on the canvas (-1 before the first `next()`). */
    get index() {
        return this.d.index;
    }
    /** How long to show the current frame, in ms. */
    get delay() {
        return this.d.delay_ms;
    }
    /** A frame failed to decode and the loop now ends before it. */
    get truncated() {
        return this.d.truncated;
    }
    /** Decodes the next frame; `false` at the end of the loop (see {@link rewind}). */
    next() {
        return this.d.next_frame();
    }
    /** Advances `n` frames without rendering them; returns how many it advanced. */
    skip(n) {
        return this.d.skip_frames(Math.max(0, Math.floor(n)));
    }
    /** Restarts at frame 0 with a transparent canvas. */
    rewind() {
        this.d.rewind();
    }
    /**
     * Zero-copy view of the composited source frame. Valid until the next
     * `next()` / `skip()` / `rewind()` / `free()` (or a WASM memory growth).
     */
    frameView() {
        return viewWasmOutput(this.wasm, this.d.frame());
    }
    /**
     * Renders the current frame and returns a zero-copy view of the module's
     * shared output buffer: valid until the next render call on this module.
     * `'none'` returns {@link frameView}.
     */
    renderView(spec) {
        return viewWasmOutput(this.wasm, renderDecoderFrame(this.d, spec));
    }
    /** Like {@link renderView}, but copied (into `out` when given). */
    render(spec, out) {
        return readWasmOutput(this.wasm, renderDecoderFrame(this.d, spec), out);
    }
    /** Releases the decoder (compressed file and canvas). Idempotent. */
    free() {
        const d = this.dec;
        this.dec = null;
        d?.free();
    }
}
/**
 * Renders every frame of an animation, one at a time, as a generator. Each
 * yielded frame's `data` is a zero-copy view that is valid only until the
 * generator resumes - draw or copy it first. Accepts the encoded file (the
 * decoder is opened and freed here) or an open {@link WasmAnimation} (left
 * open, positioned after the last frame rendered).
 */
export function* upscaleFrames(wasm, source, spec, options = {}) {
    const owned = !(source instanceof WasmAnimation);
    const anim = source instanceof WasmAnimation ? source : WasmAnimation.open(wasm, source, options);
    try {
        const wanted = options.loops ?? 1;
        const loops = wanted === Infinity ? (anim.loopCount === 0 ? Infinity : anim.loopCount) : Math.max(0, Math.floor(wanted));
        for (let loop = 0; loop < loops; loop++) {
            if (loop > 0)
                anim.rewind();
            let frames = 0;
            while (anim.next()) {
                frames++;
                const out = anim.renderView(spec);
                yield { data: out.data, width: out.width, height: out.height, index: anim.index, delay: anim.delay, loop };
            }
            if (frames === 0)
                break; // nothing decodable: never spin
            if (anim.frameCount <= 1)
                break; // a still image has nothing to loop
        }
    }
    finally {
        if (owned)
            anim.free();
    }
}
/**
 * Upscales frames you supply - from any decoder, any iterable or async
 * iterable - one at a time through a {@link WasmRenderer}. `onFrame` receives
 * a zero-copy view of the module's output buffer that is valid until it
 * returns (or until its promise settles); the next frame is not rendered
 * before that. Returns the number of frames processed.
 */
export async function upscaleFrameBatch(renderer, frames, spec, onFrame) {
    let index = 0;
    for await (const input of frames) {
        let out;
        switch (spec.effect) {
            case 'xbrz':
                out = renderer.renderXbrzView(input, spec.options);
                break;
            case 'crt':
                out = renderer.renderCrtView(input, spec.options);
                break;
            case 'hex':
                out = renderer.renderHexView(input, spec.options);
                break;
            default:
                out = { data: input.data instanceof Uint8ClampedArray ? input.data : new Uint8ClampedArray(input.data.buffer, input.data.byteOffset, input.data.byteLength), width: input.width, height: input.height };
        }
        await onFrame(out, index++);
    }
    return index;
}
//# sourceMappingURL=frames.js.map