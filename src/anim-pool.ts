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
import type { AnimRequest, AnimResponse, FrameOutputKind, FramePayload } from './anim-protocol.js';
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

interface Pending {
  slot: Slot;
  resolve: (msg: AnimResponse) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  ready: Promise<void>;
  broken: boolean;
  streams: Set<number>;
}

function closeBitmap(bmp: ImageBitmap | undefined): void {
  try {
    bmp?.close();
  } catch {
    /* already detached */
  }
}

/** One open animation in a pool worker. */
export class AnimationStream {
  private closedFlag = false;
  private inFlight: Promise<unknown> = Promise.resolve();

  /** @internal Created by {@link WasmAnimationPool.open}. */
  constructor(
    private readonly pool: WasmAnimationPool,
    private readonly slot: Slot,
    readonly id: number,
    readonly info: AnimationStreamInfo,
    /** Effect used when `next()` is not given one. */
    public render: FrameRenderSpec
  ) {}

  get format(): 'gif' | 'webp' {
    return this.info.format;
  }
  get width(): number {
    return this.info.width;
  }
  get height(): number {
    return this.info.height;
  }
  get frameCount(): number {
    return this.info.frameCount;
  }
  /** Total plays, 0 = forever. */
  get loopCount(): number {
    return this.info.loopCount;
  }
  get durationMs(): number {
    return this.info.durationMs;
  }
  get animated(): boolean {
    return this.info.animated;
  }
  /** True after close(), or once the hosting worker died. */
  get closed(): boolean {
    return this.closedFlag || this.slot.broken;
  }

  private check(): void {
    if (this.closedFlag) throw new Error('AnimationStream closed');
    if (this.slot.broken) throw new Error('animation worker restarted: reopen the stream');
  }

  /**
   * Decodes and renders the next frame in the worker. Resolves to `null` at
   * the end of the loop (unless `wrap`). Calls are queued: frames arrive in
   * order, one request at a time.
   */
  next(options: NextFrameOptions = {}): Promise<AnimationFrame | null> {
    const run = async (): Promise<AnimationFrame | null> => {
      if (this.closedFlag) return null;
      this.check();
      const msg = await this.pool.request(this.slot, {
        type: 'next',
        id: 0,
        stream: this.id,
        render: options.render ?? this.render,
        skip: Math.max(0, Math.floor(options.skip ?? 0)),
        wrap: !!options.wrap,
        output: options.output ?? 'bitmap',
      });
      if (msg.type !== 'frame') throw new Error(`unexpected reply: ${msg.type}`);
      const f: FramePayload | null = msg.frame;
      if (!f) return null;
      if (this.closedFlag) {
        // Closed while the frame was in flight: nobody will consume it.
        closeBitmap(f.bitmap);
        return null;
      }
      return {
        index: f.index,
        delay: f.delay,
        width: f.width,
        height: f.height,
        looped: f.looped,
        cost: f.cost,
        bitmap: f.bitmap,
        data: f.buffer ? new Uint8ClampedArray(f.buffer) : undefined,
      };
    };
    const p = this.inFlight.then(run, run);
    this.inFlight = p.catch(() => undefined);
    return p;
  }

  /** Back to frame 0 with a transparent canvas. */
  rewind(): Promise<void> {
    const run = async (): Promise<void> => {
      this.check();
      await this.pool.request(this.slot, { type: 'rewind', id: 0, stream: this.id });
    };
    const p = this.inFlight.then(run, run);
    this.inFlight = p.catch(() => undefined);
    return p;
  }

  /** Frees the worker-side decoder. Pending `next()` calls resolve to null. */
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.pool.release(this.slot, this.id);
  }
}

export class WasmAnimationPool {
  private slots: Slot[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private nextStream = 1;
  private disposed = false;

  private constructor(
    private readonly module: WebAssembly.Module,
    private readonly make: () => Worker,
    private readonly initTimeoutMs: number
  ) {}

  /** Spawns the workers and waits until every one has instantiated the module. */
  static async create(options: WasmAnimationPoolOptions = {}): Promise<WasmAnimationPool> {
    const count = Math.min(4, Math.max(1, Math.floor(options.workers ?? 1)));
    const wasmUrl = options.wasmUrl ?? new URL('./wasm-anim/renderart_bg.wasm', import.meta.url);
    const make =
      options.createWorker ?? (() => new Worker(new URL('./anim-worker.js', import.meta.url), { type: 'module' }));
    const module = await compile(wasmUrl);
    const pool = new WasmAnimationPool(module, make, options.initTimeoutMs ?? 30000);
    for (let i = 0; i < count; i++) pool.slots.push(pool.spawn());
    try {
      await Promise.all(pool.slots.map((s) => s.ready));
    } catch (err) {
      pool.dispose();
      throw err;
    }
    return pool;
  }

  /** Number of workers. */
  get size(): number {
    return this.slots.length;
  }

  /** Number of open streams across all workers. */
  get streamCount(): number {
    let n = 0;
    for (const s of this.slots) n += s.streams.size;
    return n;
  }

  private spawn(): Slot {
    const worker = this.make();
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    const ready = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    const slot: Slot = { worker, ready, broken: false, streams: new Set() };
    ready.catch(() => {});
    const timer = setTimeout(
      () => settle.reject(new Error(`animation worker did not initialise within ${this.initTimeoutMs} ms`)),
      this.initTimeoutMs
    );
    worker.addEventListener('message', (event: MessageEvent<AnimResponse>) => {
      const msg = event.data;
      if (msg.type === 'ready') {
        clearTimeout(timer);
        return settle.resolve();
      }
      if (msg.type === 'init-error') {
        clearTimeout(timer);
        slot.broken = true;
        return settle.reject(new Error(msg.error));
      }
      const entry = this.pending.get(msg.id);
      if (!entry) {
        // Nobody waits for it (pool disposed mid-flight): free its bitmap.
        if (msg.type === 'frame') closeBitmap(msg.frame?.bitmap);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error') {
        if (msg.fatal) this.breakSlot(slot, new Error(msg.error));
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg);
      }
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      clearTimeout(timer);
      const err = new Error(event.message || 'animation worker error');
      settle.reject(err);
      this.breakSlot(slot, err);
    });
    worker.postMessage({ type: 'init', module: this.module } satisfies AnimRequest);
    return slot;
  }

  /** Marks a worker dead: its streams are lost, its pending requests fail. */
  private breakSlot(slot: Slot, err: Error): void {
    slot.broken = true;
    for (const [id, entry] of this.pending) {
      if (entry.slot === slot) {
        this.pending.delete(id);
        entry.reject(err);
      }
    }
  }

  /** Replaces broken workers; waits until every worker is ready. */
  private async healthy(): Promise<void> {
    this.slots = this.slots.map((slot) => {
      if (!slot.broken) return slot;
      this.breakSlot(slot, new Error('animation worker restarted'));
      slot.worker.terminate();
      return this.spawn();
    });
    await Promise.all(this.slots.map((s) => s.ready));
  }

  /** @internal Sends a request to `slot` and resolves with its reply. */
  request(slot: Slot, req: Exclude<AnimRequest, { type: 'init' } | { type: 'close' }>, transfer: Transferable[] = []): Promise<AnimResponse> {
    if (this.disposed) return Promise.reject(new Error('WasmAnimationPool disposed'));
    if (slot.broken) return Promise.reject(new Error('animation worker restarted: reopen the stream'));
    const id = this.nextId++;
    req.id = id;
    return new Promise<AnimResponse>((resolve, reject) => {
      this.pending.set(id, { slot, resolve, reject });
      slot.worker.postMessage(req, transfer);
    });
  }

  /** @internal Called by {@link AnimationStream.close}. */
  release(slot: Slot, stream: number): void {
    slot.streams.delete(stream);
    if (this.disposed || slot.broken) return;
    slot.worker.postMessage({ type: 'close', stream } satisfies AnimRequest);
  }

  /**
   * Opens an animated (or still) GIF / WebP in the least busy worker. The
   * bytes are copied (yours are not detached). Rejects on files that are not
   * GIF/WebP, are corrupt before the first frame, or exceed `maxPixels`.
   */
  async open(data: Uint8Array | ArrayBuffer, render: FrameRenderSpec, options: AnimationOpenOptions = {}): Promise<AnimationStream> {
    if (this.disposed) throw new Error('WasmAnimationPool disposed');
    await this.healthy();
    let slot = this.slots[0];
    for (const s of this.slots) if (s.streams.size < slot.streams.size) slot = s;
    const src = data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = src.slice();
    const stream = this.nextStream++;
    slot.streams.add(stream);
    try {
      const msg = await this.request(
        slot,
        {
          type: 'open',
          id: 0,
          stream,
          data: copy.buffer,
          maxPixels: options.maxPixels && options.maxPixels > 0 ? Math.floor(options.maxPixels) : undefined,
        },
        [copy.buffer]
      );
      if (msg.type !== 'opened') throw new Error(`unexpected reply: ${msg.type}`);
      return new AnimationStream(this, slot, stream, msg.info, render);
    } catch (err) {
      slot.streams.delete(stream);
      throw err;
    }
  }

  /** Terminates the workers; in-flight requests reject. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      slot.broken = true;
      slot.worker.terminate();
    }
    this.slots = [];
    const err = new Error('WasmAnimationPool disposed');
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}

async function compile(url: string | URL): Promise<WebAssembly.Module> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to fetch ${String(url)}: ${response.status}`);
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(response.clone());
    } catch {
      // Wrong MIME type on some servers: fall back to buffering.
    }
  }
  return WebAssembly.compile(await response.arrayBuffer());
}
