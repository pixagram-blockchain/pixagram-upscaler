/**
 * Animation worker for {@link WasmAnimationPool}.
 *
 * Owns a WebAssembly instance (instantiated from the module the pool compiled
 * once) and any number of open animations, each a `FrameDecoder`: the
 * compressed file plus one canvas. A `next` request decodes one frame,
 * renders it into the instance's single shared output buffer and ships it to
 * the page - as an ImageBitmap, or as transferred RGBA bytes - before the
 * next request is looked at. However many animations are open, and however
 * long they are, the worker holds one output frame.
 *
 * Requests are handled strictly in order (bitmap creation is the only await),
 * so a stream's frames, rewinds and close never overtake each other.
 *
 * Build target: a module worker, e.g.
 *   new Worker(new URL('./anim-worker.js', import.meta.url), { type: 'module' })
 */
import { renderDecoderFrame } from './frames.js';
// The `anim` build of the module (FrameDecoder), generated into dist/wasm-anim
// by `npm run build:wasm:anim` next to the compiled worker; it is not part of
// the TypeScript sources.
// @ts-ignore: resolved in dist/ (see above)
import * as glueModule from './wasm-anim/renderart.js';
const glue = glueModule;
const ctx = self;
let initialised = false;
const streams = new Map();
let queue = Promise.resolve();
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function reply(msg, transfer = []) {
    ctx.postMessage(msg, transfer);
}
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/** A trap (RuntimeError) can leave the instance inconsistent; a JS `Error` thrown by a binding cannot. */
function isFatal(err) {
    return typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError;
}
function decoder(stream) {
    const dec = streams.get(stream);
    if (!dec)
        throw new Error(`animation ${stream} is not open`);
    return dec;
}
async function nextFrame(req) {
    const t0 = now();
    const dec = decoder(req.stream);
    let looped = false;
    if (req.skip > 0)
        dec.skip_frames(req.skip);
    if (!dec.next_frame()) {
        if (!req.wrap)
            return reply({ type: 'frame', id: req.id, frame: null });
        dec.rewind();
        looped = true;
        if (!dec.next_frame())
            return reply({ type: 'frame', id: req.id, frame: null });
    }
    const r = renderDecoderFrame(dec, req.render);
    const { ptr, len, width, height } = r;
    r.free?.();
    // A view into WASM memory: valid until the next WASM call, and none happens
    // before the output below has been taken (the queue serialises requests).
    const view = new Uint8ClampedArray(glue.get_memory().buffer, ptr, len);
    const frame = { index: dec.index, delay: dec.delay_ms, width, height, looped, cost: 0 };
    const transfer = [];
    if (req.output === 'bitmap' && typeof createImageBitmap === 'function' && width > 0 && height > 0) {
        frame.bitmap = await createImageBitmap(new ImageData(view, width, height));
        transfer.push(frame.bitmap);
    }
    else {
        const copy = view.slice();
        frame.buffer = copy.buffer;
        transfer.push(copy.buffer);
    }
    frame.cost = now() - t0;
    reply({ type: 'frame', id: req.id, frame }, transfer);
}
async function handle(req) {
    if (req.type === 'close') {
        const dec = streams.get(req.stream);
        streams.delete(req.stream);
        dec?.free();
        return;
    }
    if (req.type === 'init')
        return; // handled synchronously below
    try {
        if (!initialised)
            throw new Error('worker not initialised');
        switch (req.type) {
            case 'open': {
                const Decoder = glue.FrameDecoder;
                if (typeof Decoder !== 'function')
                    throw new Error('WASM module lacks FrameDecoder');
                const dec = new Decoder(new Uint8Array(req.data), req.maxPixels);
                streams.get(req.stream)?.free();
                streams.set(req.stream, dec);
                reply({
                    type: 'opened',
                    id: req.id,
                    info: {
                        format: dec.format,
                        width: dec.width,
                        height: dec.height,
                        frameCount: dec.frame_count,
                        loopCount: dec.loop_count,
                        durationMs: dec.duration_ms,
                        animated: dec.animated,
                    },
                });
                return;
            }
            case 'next':
                return await nextFrame(req);
            case 'rewind':
                decoder(req.stream).rewind();
                return reply({ type: 'rewound', id: req.id });
        }
    }
    catch (err) {
        reply({ type: 'error', id: req.id, error: errorText(err), fatal: isFatal(err) });
    }
}
ctx.addEventListener('message', (event) => {
    const req = event.data;
    if (req.type === 'init') {
        try {
            glue.initSync({ module: req.module });
            if (typeof glue.FrameDecoder !== 'function') {
                throw new Error('WASM module lacks FrameDecoder (rebuild @pixagram/upscaler/wasm)');
            }
            initialised = true;
            reply({ type: 'ready' });
        }
        catch (err) {
            reply({ type: 'init-error', error: errorText(err) });
        }
        return;
    }
    queue = queue.then(() => handle(req));
});
//# sourceMappingURL=anim-worker.js.map