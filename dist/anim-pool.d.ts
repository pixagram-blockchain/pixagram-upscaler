/**
 * WasmAnimationPool - animated GIF / WebP decoded and upscaled off the main
 * thread, one frame at a time.
 *
 * The WASM module is compiled once and instantiated in a few module workers.
 * Each open animation (an {@link AnimationStream}) lives in one worker as the
 * compressed file plus one canvas; every {@link AnimationStream.next} decodes
 * exactly one frame there, renders it with the requested effect and transfers
 * it to the page (an ImageBitmap by default). Frames are never accumulated on
 * either side: the page holds the frame it shows and, briefly, the next one.
 *
 *   const pool = await WasmAnimationPool.create();
 *   const stream = await pool.open(gifBytes, { effect: 'xbrz', options: { scale: 4 } });
 *   for (;;) {
 *     const frame = await stream.next({ wrap: true });   // loops forever
 *     if (!frame) break;
 *     canvasCtx.transferFromImageBitmap(frame.bitmap);    // or drawImage + close()
 *     await sleep(frame.delay);
 *   }
 *   stream.close();
 *   pool.dispose();
 *
 * Works on any page: no SharedArrayBuffer, no COOP/COEP. The workers run the
 * `anim` build of the module (`dist/wasm-anim`), which the page itself never
 * has to load. The worker and the `.wasm` file are referenced with
 * `new URL('...', import.meta.url)`, so webpack 5 (and other bundlers that
 * support the pattern) emit both.
 *
 * A worker whose WASM instance traps is replaced before the next `open`; the
 * streams it hosted reject further calls (reopen them).
 */
import type { AnimationInfo } from './anim-probe.js';
import type { AnimRequest, AnimResponse, FrameOutputKind } from './anim-protocol.js';
import type { FrameRenderSpec } from './frames.js';
export interface WasmAnimationPoolOptions {
    /** Worker count (default 1, at most 4): streams are spread across them. */
    workers?: number;
    /**
     * URL of the `anim` build's `renderart_bg.wasm` (default: the copy shipped
     * in `dist/wasm-anim`; the default `dist/wasm` module has no FrameDecoder).
     */
    wasmUrl?: string | URL;
    /**
     * Create workers yourself (e.g. for a bundler-specific worker URL). They must
     * run `@pixagram/upscaler/anim-worker`.
     */
    createWorker?: () => Worker;
    /** Fail if a worker has not initialised within this many ms (default 30000). */
    initTimeoutMs?: number;
}
export interface AnimationOpenOptions {
    /** Refuse canvases over this many pixels (default 16 MP). */
    maxPixels?: number;
}
export interface NextFrameOptions {
    /** Effect for this frame (default: the stream's {@link AnimationStream.render}). */
    render?: FrameRenderSpec;
    /**
     * Decode (composite) this many frames without rendering them first - to
     * catch up after falling behind. Frames depend on their predecessors, so
     * skipping still decodes; it only saves the render and the transfer.
     */
    skip?: number;
    /** At the end of the loop, rewind and return frame 0 (`looped: true`). */
    wrap?: boolean;
    /** 'bitmap' (default) or 'pixels'. */
    output?: FrameOutputKind;
}
/** A frame delivered to the page. */
export interface AnimationFrame {
    /** Index within the loop. */
    index: number;
    /** How long to show it, in ms (durations under 11 ms play as 100 ms). */
    delay: number;
    width: number;
    height: number;
    /** True when this request wrapped around to frame 0. */
    looped: boolean;
    /** Milliseconds the worker spent producing it. */
    cost: number;
    /** output 'bitmap': yours to draw, transfer or close(). */
    bitmap?: ImageBitmap;
    /** output 'pixels' (or no createImageBitmap in the worker): RGBA bytes. */
    data?: Uint8ClampedArray;
}
/** Header facts of an open animation. */
export type AnimationStreamInfo = Omit<AnimationInfo, 'needsFrameDecoder'>;
interface Slot {
    worker: Worker;
    ready: Promise<void>;
    broken: boolean;
    streams: Set<number>;
}
/** One open animation in a pool worker. */
export declare class AnimationStream {
    private readonly pool;
    private readonly slot;
    readonly id: number;
    readonly info: AnimationStreamInfo;
    /** Effect used when `next()` is not given one. */
    render: FrameRenderSpec;
    private closedFlag;
    private inFlight;
    /** @internal Created by {@link WasmAnimationPool.open}. */
    constructor(pool: WasmAnimationPool, slot: Slot, id: number, info: AnimationStreamInfo, 
    /** Effect used when `next()` is not given one. */
    render: FrameRenderSpec);
    get format(): 'gif' | 'webp';
    get width(): number;
    get height(): number;
    get frameCount(): number;
    /** Total plays, 0 = forever. */
    get loopCount(): number;
    get durationMs(): number;
    get animated(): boolean;
    /** True after close(), or once the hosting worker died. */
    get closed(): boolean;
    private check;
    /**
     * Decodes and renders the next frame in the worker. Resolves to `null` at
     * the end of the loop (unless `wrap`). Calls are queued: frames arrive in
     * order, one request at a time.
     */
    next(options?: NextFrameOptions): Promise<AnimationFrame | null>;
    /** Back to frame 0 with a transparent canvas. */
    rewind(): Promise<void>;
    /** Frees the worker-side decoder. Pending `next()` calls resolve to null. */
    close(): void;
}
export declare class WasmAnimationPool {
    private readonly module;
    private readonly make;
    private readonly initTimeoutMs;
    private slots;
    private pending;
    private nextId;
    private nextStream;
    private disposed;
    private constructor();
    /** Spawns the workers and waits until every one has instantiated the module. */
    static create(options?: WasmAnimationPoolOptions): Promise<WasmAnimationPool>;
    /** Number of workers. */
    get size(): number;
    /** Number of open streams across all workers. */
    get streamCount(): number;
    private spawn;
    /** Marks a worker dead: its streams are lost, its pending requests fail. */
    private breakSlot;
    /** Replaces broken workers; waits until every worker is ready. */
    private healthy;
    /** @internal Sends a request to `slot` and resolves with its reply. */
    request(slot: Slot, req: Exclude<AnimRequest, {
        type: 'init';
    } | {
        type: 'close';
    }>, transfer?: Transferable[]): Promise<AnimResponse>;
    /** @internal Called by {@link AnimationStream.close}. */
    release(slot: Slot, stream: number): void;
    /**
     * Opens an animated (or still) GIF / WebP in the least busy worker. The
     * bytes are copied (yours are not detached). Rejects on files that are not
     * GIF/WebP, are corrupt before the first frame, or exceed `maxPixels`.
     */
    open(data: Uint8Array | ArrayBuffer, render: FrameRenderSpec, options?: AnimationOpenOptions): Promise<AnimationStream>;
    /** Terminates the workers; in-flight requests reject. */
    dispose(): void;
}
export {};
//# sourceMappingURL=anim-pool.d.ts.map