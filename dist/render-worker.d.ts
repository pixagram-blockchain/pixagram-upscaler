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
export {};
//# sourceMappingURL=render-worker.d.ts.map