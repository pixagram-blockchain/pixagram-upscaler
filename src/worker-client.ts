/**
 * WorkerRenderer - main-thread client for the render worker.
 *
 * Offloads CRT / Hex / xBRZ rendering to a dedicated worker so the UI thread
 * stays responsive. Input pixels are copied into a transferable buffer (the
 * caller's data is never detached); results are transferred back zero-copy.
 *
 * Example:
 *   const r = new WorkerRenderer();
 *   const out = await r.xbrz(imageData, { scale: 4 });
 *   // ... use out.data / out.width / out.height
 *   r.dispose();
 */

import type { CrtOptions, HexOptions, ImageInput, ImageOutput, XbrzOptions } from './types.js';
import type { EffectName, WorkerRequest, WorkerResponse } from './worker-protocol.js';

interface Pending {
  resolve: (out: ImageOutput) => void;
  reject: (err: Error) => void;
}

export interface WorkerRendererOptions {
  /**
   * Provide a custom Worker (e.g. when your bundler needs a specific worker
   * URL). When omitted, a module worker is created from the bundled
   * render-worker entry.
   */
  worker?: Worker;
}

export class WorkerRenderer {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  constructor(options: WorkerRendererOptions = {}) {
    this.worker =
      options.worker ??
      new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });

    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type !== 'result') return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve({ data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height });
      } else {
        entry.reject(new Error(msg.error));
      }
    });

    this.worker.addEventListener('error', (event: ErrorEvent) => {
      const err = new Error(event.message || 'Render worker error');
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
    });
  }

  private run(
    effect: EffectName,
    input: ImageInput | ImageData,
    options: CrtOptions | HexOptions | XbrzOptions
  ): Promise<ImageOutput> {
    if (this.disposed) return Promise.reject(new Error('WorkerRenderer disposed'));

    const id = this.nextId++;
    // Copy into a fresh transferable buffer so the caller's data is untouched.
    const src = input.data;
    const copy = new Uint8Array(src.length);
    copy.set(src);

    const request: WorkerRequest = {
      type: 'render',
      id,
      effect,
      width: input.width,
      height: input.height,
      options,
      buffer: copy.buffer,
    };

    return new Promise<ImageOutput>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request, [copy.buffer]);
    });
  }

  /** Render the CRT effect on the worker thread. */
  crt(input: ImageInput | ImageData, options: CrtOptions = {}): Promise<ImageOutput> {
    return this.run('crt', input, options);
  }

  /** Render the hexagonal effect on the worker thread. */
  hex(input: ImageInput | ImageData, options: HexOptions = {}): Promise<ImageOutput> {
    return this.run('hex', input, options);
  }

  /** Render the xBRZ upscale on the worker thread. */
  xbrz(input: ImageInput | ImageData, options: XbrzOptions = {}): Promise<ImageOutput> {
    return this.run('xbrz', input, options);
  }

  /** Terminate the worker and reject any in-flight requests. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.worker.postMessage({ type: 'dispose' } satisfies WorkerRequest);
    } catch {
      /* worker may already be gone */
    }
    this.worker.terminate();
    const err = new Error('WorkerRenderer disposed');
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}
