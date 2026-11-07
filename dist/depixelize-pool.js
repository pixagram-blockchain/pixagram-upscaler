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
/** The option keys forwarded to the worker (a plain, cloneable copy). */
const OPTION_KEYS = [
    'scale',
    'precision',
    'mode',
    'smooth',
    'iterations',
    'guesses',
    'guessOffset',
    'shading',
    'seed',
    'idPrefix',
];
// Smallest module using v128 (i8x16.splat + popcnt): validates only with
// SIMD. The same probe as depixelize-wasm.mjs.
const SIMD_PROBE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);
/** True when this browser can run WebAssembly SIMD (simd128). */
function simdSupported() {
    try {
        return WebAssembly.validate(SIMD_PROBE);
    }
    catch {
        return false;
    }
}
function cloneOptions(options) {
    const out = {};
    for (const key of OPTION_KEYS) {
        if (options[key] !== undefined)
            out[key] = options[key];
    }
    return out;
}
export class WasmDepixelizePool {
    module;
    make;
    initTimeoutMs;
    slots = [];
    pending = new Map();
    nextId = 1;
    disposed = false;
    simdBuild = false;
    decoder = new TextDecoder();
    constructor(module, make, initTimeoutMs) {
        this.module = module;
        this.make = make;
        this.initTimeoutMs = initTimeoutMs;
    }
    /** Compiles the module, spawns the workers and waits until every one is ready. */
    static async create(options = {}) {
        const requested = Math.floor(options.workers ?? 1);
        const count = Number.isFinite(requested) ? Math.min(8, Math.max(1, requested)) : 1;
        const simd = options.simd ?? simdSupported();
        // Two literal URLs (not a computed path) so bundlers emit both builds.
        const wasmUrl = options.wasmUrl ??
            (simd
                ? new URL('./depixelize/depixelize-simd.wasm', import.meta.url)
                : new URL('./depixelize/depixelize.wasm', import.meta.url));
        const make = options.createWorker ??
            (() => new Worker(new URL('./depixelize-worker.js', import.meta.url), { type: 'module' }));
        const module = await compile(wasmUrl);
        const timeout = options.initTimeoutMs ?? 30000;
        const pool = new WasmDepixelizePool(module, make, timeout > 0 ? timeout : 30000);
        try {
            // Inside the try: if creating a worker throws, the ones already started are terminated.
            for (let i = 0; i < count; i++)
                pool.slots.push(pool.spawn());
            await Promise.all(pool.slots.map((s) => s.ready));
        }
        catch (err) {
            pool.dispose();
            throw err;
        }
        return pool;
    }
    /** Number of workers. */
    get size() {
        return this.slots.length;
    }
    /** True when the workers run the SIMD build. */
    get simd() {
        return this.simdBuild;
    }
    /** Starts a worker, wires its messages, and sends it the module. */
    spawn() {
        const worker = this.make();
        let settle;
        const ready = new Promise((resolve, reject) => (settle = { resolve, reject }));
        const slot = { worker, ready, broken: false, load: 0 };
        // Never surface an unobserved rejection; callers await `ready` explicitly.
        ready.catch(() => { });
        const timer = setTimeout(() => {
            slot.broken = true;
            settle.reject(new Error(`depixelize worker did not initialise within ${this.initTimeoutMs} ms`));
        }, this.initTimeoutMs);
        worker.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'ready') {
                clearTimeout(timer);
                this.simdBuild = msg.simd;
                return settle.resolve();
            }
            if (msg.type === 'init-error') {
                clearTimeout(timer);
                slot.broken = true;
                return settle.reject(new Error(msg.error));
            }
            const entry = this.pending.get(msg.id);
            if (!entry)
                return;
            this.pending.delete(msg.id);
            slot.load--;
            if (msg.ok)
                return entry.resolve(msg);
            const err = msg.name === 'RangeError' ? new RangeError(msg.error) : new Error(msg.error);
            entry.reject(err);
            // A trap may have corrupted the instance: retire the worker now.
            if (msg.fatal)
                this.breakSlot(slot, new Error(`depixelize worker restarted: ${msg.error}`));
        });
        worker.addEventListener('error', (event) => {
            clearTimeout(timer);
            const err = new Error(event.message || 'depixelize worker error');
            settle.reject(err);
            this.breakSlot(slot, err);
        });
        worker.postMessage({ type: 'init', module: this.module });
        return slot;
    }
    /** Marks a worker dead, terminates it and rejects the requests it held. */
    breakSlot(slot, err) {
        slot.broken = true;
        slot.worker.terminate();
        for (const [id, entry] of this.pending) {
            if (entry.slot === slot) {
                this.pending.delete(id);
                entry.reject(err);
            }
        }
        slot.load = 0;
    }
    /** Replaces broken workers and waits until every worker is ready. */
    async healthy() {
        this.slots = this.slots.map((slot) => {
            if (!slot.broken)
                return slot;
            this.breakSlot(slot, new Error('depixelize worker restarted'));
            return this.spawn();
        });
        await Promise.all(this.slots.map((s) => s.ready));
    }
    async run(image, options, output) {
        if (this.disposed)
            throw new Error('WasmDepixelizePool disposed');
        const width = image.width | 0;
        const height = image.height | 0;
        const src = image.data;
        // The same checks, and errors, as the glue.
        if (width <= 0 || height <= 0)
            throw new RangeError('depixelize: image must be at least 1×1');
        if (!src || src.length < width * height * 3)
            throw new RangeError('depixelize: pixel data too short');
        // A copy to transfer (the caller's pixels are not detached). Its length
        // tells RGB from RGBA, as with the glue.
        const bytes = src instanceof Uint8Array || src instanceof Uint8ClampedArray ? src.slice() : Uint8ClampedArray.from(src);
        const opts = cloneOptions(options);
        await this.healthy();
        if (this.disposed)
            throw new Error('WasmDepixelizePool disposed');
        let slot = this.slots[0];
        for (const s of this.slots)
            if (s.load < slot.load)
                slot = s;
        const id = this.nextId++;
        const req = { type: 'run', id, width, height, data: bytes.buffer, options: opts, output };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { slot, resolve, reject });
            slot.load++;
            try {
                slot.worker.postMessage(req, [bytes.buffer]);
            }
            catch (err) {
                // e.g. an option value that cannot be cloned
                this.pending.delete(id);
                slot.load--;
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    /** Vectorizes `image` in a worker; resolves to the SVG document. */
    async depixelize(image, options = {}) {
        const msg = await this.run(image, options, 'string');
        return msg.svg ?? (msg.buffer ? this.decoder.decode(msg.buffer) : '');
    }
    /** Like {@link depixelize}, as UTF-8 bytes (transferred from the worker, no extra copy). */
    async depixelizeBytes(image, options = {}) {
        const msg = await this.run(image, options, 'bytes');
        return msg.buffer ? new Uint8Array(msg.buffer) : new TextEncoder().encode(msg.svg ?? '');
    }
    /** Terminates the workers; in-flight requests reject. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const slot of this.slots) {
            slot.broken = true;
            slot.worker.terminate();
        }
        this.slots = [];
        const err = new Error('WasmDepixelizePool disposed');
        for (const [, entry] of this.pending)
            entry.reject(err);
        this.pending.clear();
    }
}
async function compile(url) {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`failed to fetch ${String(url)}: ${response.status}`);
    if (typeof WebAssembly.compileStreaming === 'function') {
        try {
            return await WebAssembly.compileStreaming(response.clone());
        }
        catch {
            // Wrong MIME type on some servers: fall back to buffering.
        }
    }
    return WebAssembly.compile(await response.arrayBuffer());
}
//# sourceMappingURL=depixelize-pool.js.map