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
import type { CrtOptions, HexOptions, ImageOutput, RenderSource, XbrzOptions } from './types.js';
export interface WorkerRendererOptions {
    /**
     * Provide a custom Worker (e.g. when your bundler needs a specific worker
     * URL). When omitted, a module worker is created from the bundled
     * render-worker entry.
     */
    worker?: Worker;
}
export declare class WorkerRenderer {
    private worker;
    private pending;
    private nextId;
    private disposed;
    constructor(options?: WorkerRendererOptions);
    private run;
    /** Render the CRT effect on the worker thread. */
    crt(input: RenderSource, options?: CrtOptions): Promise<ImageOutput>;
    /** Render the hexagonal effect on the worker thread. */
    hex(input: RenderSource, options?: HexOptions): Promise<ImageOutput>;
    /** Render the xBRZ upscale on the worker thread. */
    xbrz(input: RenderSource, options?: XbrzOptions): Promise<ImageOutput>;
    /** CRT effect with ImageBitmap output (no GPU->CPU readback). */
    crtToBitmap(input: RenderSource, options?: CrtOptions): Promise<ImageBitmap>;
    /** Hexagonal effect with ImageBitmap output (no GPU->CPU readback). */
    hexToBitmap(input: RenderSource, options?: HexOptions): Promise<ImageBitmap>;
    /** xBRZ upscale with ImageBitmap output (no GPU->CPU readback). */
    xbrzToBitmap(input: RenderSource, options?: XbrzOptions): Promise<ImageBitmap>;
    /** Terminate the worker and reject any in-flight requests. */
    dispose(): void;
}
//# sourceMappingURL=worker-client.d.ts.map