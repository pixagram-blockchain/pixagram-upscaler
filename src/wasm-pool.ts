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
import type { WasmPoolRequest, WasmPoolResponse } from './wasm-pool-protocol.js';

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

interface Pending {
  slot: Slot;
  resolve: (buffer: ArrayBuffer | undefined) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  /** Resolves once the worker's WASM instance is ready. */
  ready: Promise<void>;
  /** Set when a band failed or the worker errored: replace before reuse. */
  broken: boolean;
}

type PoolInput = ImageData | { data: Uint8Array | Uint8ClampedArray; width: number; height: number };

/** xBRZ scale as the renderers interpret it: integer 2..8, default 2. */
function sanitizeScale(scale: number | undefined): number {
  const s = typeof scale === 'number' && Number.isFinite(scale) ? Math.floor(scale) : 2;
  return Math.min(8, Math.max(2, s));
}

export class WasmXbrzPool {
  private slots: Slot[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  private constructor(
    private readonly module: WebAssembly.Module,
    private readonly glueUrl: string,
    private readonly make: () => Worker,
    private readonly minRows: number,
    private readonly initTimeoutMs: number
  ) {}

  /** Spawns the workers and waits until every one has instantiated the module. */
  static async create(options: WasmXbrzPoolOptions = {}): Promise<WasmXbrzPool> {
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.min(8, Math.max(1, Math.floor(options.workers ?? hw - 1)));
    const wasmUrl = options.wasmUrl ?? new URL('./wasm/renderart_bg.wasm', import.meta.url);
    const glueUrl = String(options.glueUrl ?? new URL('./wasm/renderart.js', import.meta.url));
    const make =
      options.createWorker ?? (() => new Worker(new URL('./wasm-worker.js', import.meta.url), { type: 'module' }));

    const module = await compile(wasmUrl);
    const pool = new WasmXbrzPool(
      module,
      glueUrl,
      make,
      Math.max(1, options.minRowsPerBand ?? 16),
      options.initTimeoutMs ?? 30000
    );
    for (let i = 0; i < count; i++) pool.slots.push(pool.spawn());
    try {
      await Promise.all(pool.slots.map((s) => s.ready));
    } catch (err) {
      pool.dispose();
      throw err;
    }
    return pool;
  }

  /** Number of workers in the pool. */
  get size(): number {
    return this.slots.length;
  }

  /** Starts a worker, wires its messages, and begins instantiating the module. */
  private spawn(): Slot {
    const worker = this.make();
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    const ready = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    const slot: Slot = { worker, ready, broken: false };
    // Never surface an unobserved rejection; callers await `ready` explicitly.
    ready.catch(() => {});

    const timer = setTimeout(
      () => settle.reject(new Error(`WASM worker did not initialise within ${this.initTimeoutMs} ms`)),
      this.initTimeoutMs
    );
    worker.addEventListener('message', (event: MessageEvent<WasmPoolResponse>) => {
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
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.buffer);
      } else {
        // The instance may be in a bad state (e.g. it trapped): replace it.
        slot.broken = true;
        entry.reject(new Error(msg.error));
      }
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      clearTimeout(timer);
      const err = new Error(event.message || 'WASM worker error');
      slot.broken = true;
      settle.reject(err);
      this.failSlot(slot, err);
    });
    worker.postMessage({ type: 'init', module: this.module, glueUrl: this.glueUrl } satisfies WasmPoolRequest);
    return slot;
  }

  /** Rejects every job still waiting on `slot`. */
  private failSlot(slot: Slot, err: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.slot === slot) {
        this.pending.delete(id);
        entry.reject(err);
      }
    }
  }

  /** Replaces broken workers and waits until every worker is ready. */
  private async healthy(): Promise<void> {
    this.slots = this.slots.map((slot) => {
      if (!slot.broken) return slot;
      this.failSlot(slot, new Error('WASM worker restarted'));
      slot.worker.terminate();
      return this.spawn();
    });
    await Promise.all(this.slots.map((s) => s.ready));
  }

  /**
   * xBRZ-upscales `input` across the pool. Scale is clamped to 2..8 (default 2).
   * The result is copied into `out` when provided (must hold the output).
   * When the returned promise settles - fulfilled or rejected - no worker is
   * still writing into `out`.
   */
  async upscale(input: PoolInput, options: XbrzOptions = {}, out?: Uint8ClampedArray): Promise<ImageOutput> {
    if (this.disposed) throw new Error('WasmXbrzPool disposed');
    const { width: w, height: h } = input;
    const scale = sanitizeScale(options.scale);
    const outW = w * scale;
    const outLen = outW * h * scale * 4;
    const src = input.data;
    if (src.length < w * h * 4) throw new RangeError('input data is smaller than width * height * 4');
    if (out && out.length < outLen) throw new RangeError(`output buffer holds ${out.length} bytes, ${outLen} needed`);
    const data = out ? out.subarray(0, outLen) : new Uint8ClampedArray(outLen);
    if (outLen === 0) return { data, width: outW, height: h * scale };

    await this.healthy();

    // A SharedArrayBuffer-backed `out` (cross-origin isolated pages) is
    // written in place by the workers: no transfer, no assembly copy. Plain
    // results stay non-shared because ImageData rejects shared views.
    const shared =
      typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer ? data.buffer : undefined;

    // Bands: at most a few per worker (load balance), at least minRows rows.
    const maxBands = Math.max(1, Math.floor(h / this.minRows));
    const bands = Math.max(1, Math.min(maxBands, this.slots.length * 2, h));
    const rowsPer = Math.ceil(h / bands);
    const rowBytes = w * 4;
    const outRowBytes = outW * 4 * scale; // destination bytes per source row
    let failed = false;

    const jobs: Promise<void>[] = [];
    let k = 0;
    for (let y0 = 0; y0 < h; y0 += rowsPer, k++) {
      const y1 = Math.min(h, y0 + rowsPer);
      const wy0 = Math.max(0, y0 - 2);
      const wy1 = Math.min(h, y1 + 2);
      // Copy the band's window (with halo) into a transferable buffer.
      const window = new Uint8Array((wy1 - wy0) * rowBytes);
      window.set(new Uint8Array(src.buffer, src.byteOffset + wy0 * rowBytes, window.length));
      const id = this.nextId++;
      const req: WasmPoolRequest = {
        type: 'band',
        id,
        window: window.buffer,
        width: w,
        height: h,
        windowY0: wy0,
        y0,
        y1,
        scale,
        equalColorTolerance: options.equalColorTolerance ?? 30,
        centerDirectionBias: options.centerDirectionBias ?? 4.0,
        dominantDirectionThreshold: options.dominantDirectionThreshold ?? 3.6,
        steepDirectionThreshold: options.steepDirectionThreshold ?? 2.2,
        target: shared,
        targetOffset: shared ? data.byteOffset + y0 * outRowBytes : undefined,
      };
      const slot = this.slots[k % this.slots.length];
      jobs.push(
        new Promise<ArrayBuffer | undefined>((resolve, reject) => {
          this.pending.set(id, { slot, resolve, reject });
          slot.worker.postMessage(req, [window.buffer]);
        }).then(
          (buffer) => {
            if (buffer && !failed) data.set(new Uint8Array(buffer), y0 * outRowBytes);
          },
          (err: Error) => {
            failed = true;
            throw err;
          }
        )
      );
    }
    // Wait for *every* band before settling, so nothing writes into `out`
    // after the caller regains control - even when a band failed.
    const results = await Promise.allSettled(jobs);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected) throw rejected.reason;
    return { data, width: outW, height: h * scale };
  }

  /** Terminates the workers and rejects in-flight jobs. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    const err = new Error('WasmXbrzPool disposed');
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
