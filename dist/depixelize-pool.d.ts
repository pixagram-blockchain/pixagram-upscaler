/**
 * WasmDepixelizePool - pixel art to resolution-independent SVG (Kopf &
 * Lischinski, "Depixelizing Pixel Art") off the main thread.
 *
 * The depixelize module is compiled once - the SIMD build when the browser
 * supports WebAssembly SIMD, the scalar build otherwise - and instantiated in
 * N module workers. Each request vectorizes one whole image in the least busy
 * worker and resolves to the SVG document, byte-identical to `depixelize()`
 * from `@pixagram/upscaler/depixelize` (and to depixelize.js) for the same
 * pixels and options.
 *
 *   const pool = await WasmDepixelizePool.create();
 *   const svg = await pool.depixelize(imageData, { scale: 30, smooth: 'fast' });
 *   img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
 *   pool.dispose();
 *
 * Works on any page: no SharedArrayBuffer, no COOP/COEP. The worker and both
 * `.wasm` builds are referenced with `new URL('...', import.meta.url)`, so
 * webpack 5 (and other bundlers that support the pattern) emit them; only the
 * build in use is downloaded.
 *
 * A worker whose instance traps (e.g. out of memory on a huge image) is
 * replaced before the next request; requests it still held reject.
 */
import type { DepixelizeInput, DepixelizeOptions } from './types.js';
export interface WasmDepixelizePoolOptions {
    /**
     * Worker count (default 1, at most 8). A worker vectorizes one image at a
     * time; more workers only help when several images are converted at once.
     */
    workers?: number;
    /**
     * Use the SIMD (true) or scalar (false) build. Default: SIMD when the
     * browser supports it. Ignored when `wasmUrl` is given.
     */
    simd?: boolean;
    /** URL of a depixelize `.wasm` (default: the build shipped in `dist/depixelize`). */
    wasmUrl?: string | URL;
    /**
     * Create workers yourself (e.g. for a bundler-specific worker URL). They must
     * run `@pixagram/upscaler/depixelize-worker`.
     */
    createWorker?: () => Worker;
    /** Fail if a worker has not initialised within this many ms (default 30000). */
    initTimeoutMs?: number;
}
export declare class WasmDepixelizePool {
    private readonly module;
    private readonly make;
    private readonly initTimeoutMs;
    private slots;
    private pending;
    private nextId;
    private disposed;
    private simdBuild;
    private readonly decoder;
    private constructor();
    /** Compiles the module, spawns the workers and waits until every one is ready. */
    static create(options?: WasmDepixelizePoolOptions): Promise<WasmDepixelizePool>;
    /** Number of workers. */
    get size(): number;
    /** True when the workers run the SIMD build. */
    get simd(): boolean;
    /** Starts a worker, wires its messages, and sends it the module. */
    private spawn;
    /** Marks a worker dead, terminates it and rejects the requests it held. */
    private breakSlot;
    /** Replaces broken workers and waits until every worker is ready. */
    private healthy;
    private run;
    /** Vectorizes `image` in a worker; resolves to the SVG document. */
    depixelize(image: DepixelizeInput, options?: DepixelizeOptions): Promise<string>;
    /** Like {@link depixelize}, as UTF-8 bytes (transferred from the worker, no extra copy). */
    depixelizeBytes(image: DepixelizeInput, options?: DepixelizeOptions): Promise<Uint8Array>;
    /** Terminates the workers; in-flight requests reject. */
    dispose(): void;
}
//# sourceMappingURL=depixelize-pool.d.ts.map