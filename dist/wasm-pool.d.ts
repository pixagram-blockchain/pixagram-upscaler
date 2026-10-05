/**
 * WasmXbrzPool - multi-core xBRZ on the CPU, without SharedArrayBuffer.
 *
 * The WASM module is compiled once and instantiated in N module workers. An
 * upscale is split into horizontal bands of source rows; each worker renders
 * its bands (with a 2-row halo, so the result is byte-identical to a
 * single-threaded render) and the bands are stacked into one image.
 *
 * Works on any page: no COOP/COEP headers needed. On a cross-origin isolated
 * page you may pass an `out` array backed by a SharedArrayBuffer; workers then
 * write straight into it and the main thread does no assembly copy.
 *
 * A worker whose band fails (e.g. its WASM instance trapped) is replaced with
 * a fresh one before the next job, so one bad call never poisons the pool.
 *
 *   const pool = await WasmXbrzPool.create();
 *   const out = await pool.upscale(imageData, { scale: 4 });
 *   ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
 *   pool.dispose();
 */
import type { ImageOutput, XbrzOptions } from './types.js';
export interface WasmXbrzPoolOptions {
    /** Worker count (default: hardwareConcurrency - 1, clamped to 1..8). */
    workers?: number;
    /** URL of `renderart_bg.wasm` (default: the copy shipped next to this file). */
    wasmUrl?: string | URL;
    /** URL of the wasm-bindgen glue `renderart.js` (default: shipped copy). */
    glueUrl?: string | URL;
    /** Create workers yourself (e.g. for a bundler-specific worker URL). */
    createWorker?: () => Worker;
    /** Minimum source rows per band (default 16): smaller jobs use fewer workers. */
    minRowsPerBand?: number;
    /** Fail if a worker has not initialised within this many ms (default 30000). */
    initTimeoutMs?: number;
}
type PoolInput = ImageData | {
    data: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
};
export declare class WasmXbrzPool {
    private readonly module;
    private readonly glueUrl;
    private readonly make;
    private readonly minRows;
    private readonly initTimeoutMs;
    private slots;
    private pending;
    private nextId;
    private disposed;
    private constructor();
    /** Spawns the workers and waits until every one has instantiated the module. */
    static create(options?: WasmXbrzPoolOptions): Promise<WasmXbrzPool>;
    /** Number of workers in the pool. */
    get size(): number;
    /** Starts a worker, wires its messages, and begins instantiating the module. */
    private spawn;
    /** Rejects every job still waiting on `slot`. */
    private failSlot;
    /** Replaces broken workers and waits until every worker is ready. */
    private healthy;
    /**
     * xBRZ-upscales `input` across the pool. Scale is clamped to 2..8 (default 2).
     * The result is copied into `out` when provided (must hold the output).
     * When the returned promise settles - fulfilled or rejected - no worker is
     * still writing into `out`.
     */
    upscale(input: PoolInput, options?: XbrzOptions, out?: Uint8ClampedArray): Promise<ImageOutput>;
    /** Terminates the workers and rejects in-flight jobs. */
    dispose(): void;
}
export {};
//# sourceMappingURL=wasm-pool.d.ts.map