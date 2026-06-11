/**
 * WorkerRenderer - main-thread client for the render worker.
 *
 * Offloads CRT / Hex / xBRZ rendering to a dedicated worker so the UI thread
 * stays responsive.
 *
 * Inputs: raw pixels / ImageData are copied into a transferable buffer (the
 * caller's data is never detached). An ImageBitmap input is transferred
 * as-is - zero-copy, but it is consumed (unusable on the main thread
 * afterwards); pass `await createImageBitmap(bitmap)` if you need to keep it.
 *
 * Outputs: the pixel methods (crt/hex/xbrz) transfer RGBA bytes back
 * zero-copy. The *ToBitmap methods skip GPU->CPU readback entirely and
 * transfer an ImageBitmap, which is the fastest way to get a result you are
 * going to draw:
 *
 *   const r = new WorkerRenderer();
 *   const bmp = await r.xbrzToBitmap(imageData, { scale: 4 });
 *   canvasCtx.transferFromImageBitmap?.(bmp) ?? canvasCtx.drawImage(bmp, 0, 0);
 *   r.dispose();
 */
import { isImageBitmap } from './gpu-context.js';
export class WorkerRenderer {
    worker;
    pending = new Map();
    nextId = 1;
    disposed = false;
    constructor(options = {}) {
        this.worker =
            options.worker ??
                new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
        this.worker.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type !== 'result')
                return;
            const entry = this.pending.get(msg.id);
            if (!entry)
                return;
            this.pending.delete(msg.id);
            if (!msg.ok) {
                entry.reject(new Error(msg.error));
            }
            else if (msg.bitmap) {
                entry.resolve(msg.bitmap);
            }
            else if (msg.buffer) {
                entry.resolve({ data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height });
            }
            else {
                entry.reject(new Error('Malformed worker response: no buffer or bitmap'));
            }
        });
        this.worker.addEventListener('error', (event) => {
            const err = new Error(event.message || 'Render worker error');
            for (const [, entry] of this.pending)
                entry.reject(err);
            this.pending.clear();
        });
    }
    run(effect, input, options, output) {
        if (this.disposed)
            return Promise.reject(new Error('WorkerRenderer disposed'));
        const id = this.nextId++;
        const request = {
            type: 'render',
            id,
            effect,
            width: input.width,
            height: input.height,
            options,
            output,
        };
        const transfer = [];
        if (isImageBitmap(input)) {
            // Zero-copy: ownership of the bitmap moves to the worker.
            request.bitmap = input;
            transfer.push(input);
        }
        else {
            // Copy into a fresh transferable buffer so the caller's data is untouched.
            const src = input.data;
            const copy = new Uint8Array(src.length);
            copy.set(src);
            request.buffer = copy.buffer;
            transfer.push(copy.buffer);
        }
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage(request, transfer);
        });
    }
    /** Render the CRT effect on the worker thread. */
    crt(input, options = {}) {
        return this.run('crt', input, options, 'pixels');
    }
    /** Render the hexagonal effect on the worker thread. */
    hex(input, options = {}) {
        return this.run('hex', input, options, 'pixels');
    }
    /** Render the xBRZ upscale on the worker thread. */
    xbrz(input, options = {}) {
        return this.run('xbrz', input, options, 'pixels');
    }
    /** Render the CUT3 upscaler on the worker thread. */
    cut(input, options = {}) {
        return this.run('cut', input, options, 'pixels');
    }
    /** CRT effect with ImageBitmap output (no GPU->CPU readback). */
    crtToBitmap(input, options = {}) {
        return this.run('crt', input, options, 'bitmap');
    }
    /** Hexagonal effect with ImageBitmap output (no GPU->CPU readback). */
    hexToBitmap(input, options = {}) {
        return this.run('hex', input, options, 'bitmap');
    }
    /** xBRZ upscale with ImageBitmap output (no GPU->CPU readback). */
    xbrzToBitmap(input, options = {}) {
        return this.run('xbrz', input, options, 'bitmap');
    }
    /** Render CUT3 to an ImageBitmap (zero GPU->CPU readback). */
    cutToBitmap(input, options = {}) {
        return this.run('cut', input, options, 'bitmap');
    }
    /** Terminate the worker and reject any in-flight requests. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        try {
            this.worker.postMessage({ type: 'dispose' });
        }
        catch {
            /* worker may already be gone */
        }
        this.worker.terminate();
        const err = new Error('WorkerRenderer disposed');
        for (const [, entry] of this.pending)
            entry.reject(err);
        this.pending.clear();
    }
}
//# sourceMappingURL=worker-client.js.map