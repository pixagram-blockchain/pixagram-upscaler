/**
 * Render Worker
 *
 * Runs the GPU renderers entirely off the main thread. The WebGL2 context is
 * created here (on an OffscreenCanvas), so texture upload, drawing and pixel
 * readback never block the UI thread.
 *
 * Concurrency: requests may arrive while a previous render is still awaiting
 * its GPU fence. That is safe - all async GPU work inside the renderers is
 * serialized through the shared-context mutex, so overlapping messages simply
 * queue instead of corrupting the shared readback buffer.
 *
 * Build target: a module worker. Instantiate via {@link WorkerRenderer} or:
 *   new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' })
 */
import { CrtGpuRenderer } from './crt-gpu.js';
import { HexGpuRenderer } from './hex-gpu.js';
import { XbrzGpuRenderer } from './xbrz-gpu.js';
import { isImageBitmap } from './gpu-context.js';
// Avoid DOM/WebWorker `self` typing ambiguity when both libs are enabled.
const ctx = self;
let crt = null;
let hex = null;
let xbrz = null;
function reply(message, transfer) {
    ctx.postMessage(message, transfer);
}
async function handleRender(req) {
    let input;
    if (req.bitmap) {
        input = req.bitmap;
    }
    else if (req.buffer) {
        input = {
            data: new Uint8ClampedArray(req.buffer),
            width: req.width,
            height: req.height,
        };
    }
    else {
        throw new Error('Render request carries neither pixel buffer nor bitmap');
    }
    try {
        if (req.output === 'bitmap') {
            // Zero-readback path: the frame never leaves the GPU. The resulting
            // ImageBitmap is transferred to the main thread, again without a copy.
            let bitmap;
            switch (req.effect) {
                case 'crt':
                    crt ??= CrtGpuRenderer.create();
                    bitmap = await crt.renderToBitmap(input, req.options);
                    break;
                case 'hex':
                    hex ??= HexGpuRenderer.create();
                    bitmap = await hex.renderToBitmap(input, req.options);
                    break;
                case 'xbrz':
                    xbrz ??= XbrzGpuRenderer.create();
                    bitmap = await xbrz.renderToBitmap(input, req.options);
                    break;
                default:
                    throw new Error(`Unknown effect: ${req.effect}`);
            }
            reply({ type: 'result', id: req.id, ok: true, width: bitmap.width, height: bitmap.height, bitmap }, [bitmap]);
        }
        else {
            let out;
            switch (req.effect) {
                case 'crt':
                    crt ??= CrtGpuRenderer.create();
                    out = await crt.renderAsync(input, req.options);
                    break;
                case 'hex':
                    hex ??= HexGpuRenderer.create();
                    out = await hex.renderAsync(input, req.options);
                    break;
                case 'xbrz':
                    xbrz ??= XbrzGpuRenderer.create();
                    out = await xbrz.renderAsync(input, req.options);
                    break;
                default:
                    throw new Error(`Unknown effect: ${req.effect}`);
            }
            // The renderer allocates a fresh, exactly-sized Uint8ClampedArray for
            // each result, so its backing store is always a plain (non-shared)
            // ArrayBuffer and is safe to transfer. TypeScript widens `.buffer` to
            // ArrayBufferLike, so we narrow it back here.
            const buffer = out.data.buffer;
            reply({ type: 'result', id: req.id, ok: true, width: out.width, height: out.height, buffer }, [buffer]);
        }
    }
    finally {
        // The input bitmap was transferred to this worker; once uploaded to the
        // GPU it is dead weight, so release it promptly.
        if (isImageBitmap(input))
            input.close();
    }
}
function disposeAll() {
    crt?.dispose();
    hex?.dispose();
    xbrz?.dispose();
    crt = hex = xbrz = null;
}
ctx.addEventListener('message', (event) => {
    const req = event.data;
    if (req.type === 'dispose') {
        disposeAll();
        return;
    }
    if (req.type === 'render') {
        handleRender(req).catch((err) => {
            reply({ type: 'result', id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }, []);
        });
    }
});
//# sourceMappingURL=render-worker.js.map