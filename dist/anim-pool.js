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
function closeBitmap(bmp) {
    try {
        bmp?.close();
    }
    catch {
        /* already detached */
    }
}
/** One open animation in a pool worker. */
export class AnimationStream {
    pool;
    slot;
    id;
    info;
    render;
    closedFlag = false;
    inFlight = Promise.resolve();
    /** @internal Created by {@link WasmAnimationPool.open}. */
    constructor(pool, slot, id, info, 
    /** Effect used when `next()` is not given one. */
    render) {
        this.pool = pool;
        this.slot = slot;
        this.id = id;
        this.info = info;
        this.render = render;
    }
    get format() {
        return this.info.format;
    }
    get width() {
        return this.info.width;
    }
    get height() {
        return this.info.height;
    }
    get frameCount() {
        return this.info.frameCount;
    }
    /** Total plays, 0 = forever. */
    get loopCount() {
        return this.info.loopCount;
    }
    get durationMs() {
        return this.info.durationMs;
    }
    get animated() {
        return this.info.animated;
    }
    /** True after close(), or once the hosting worker died. */
    get closed() {
        return this.closedFlag || this.slot.broken;
    }
    check() {
        if (this.closedFlag)
            throw new Error('AnimationStream closed');
        if (this.slot.broken)
            throw new Error('animation worker restarted: reopen the stream');
    }
    /**
     * Decodes and renders the next frame in the worker. Resolves to `null` at
     * the end of the loop (unless `wrap`). Calls are queued: frames arrive in
     * order, one request at a time.
     */
    next(options = {}) {
        const run = async () => {
            if (this.closedFlag)
                return null;
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
            if (msg.type !== 'frame')
                throw new Error(`unexpected reply: ${msg.type}`);
            const f = msg.frame;
            if (!f)
                return null;
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
    rewind() {
        const run = async () => {
            this.check();
            await this.pool.request(this.slot, { type: 'rewind', id: 0, stream: this.id });
        };
        const p = this.inFlight.then(run, run);
        this.inFlight = p.catch(() => undefined);
        return p;
    }
    /** Frees the worker-side decoder. Pending `next()` calls resolve to null. */
    close() {
        if (this.closedFlag)
            return;
        this.closedFlag = true;
        this.pool.release(this.slot, this.id);
    }
}
export class WasmAnimationPool {
    module;
    make;
    initTimeoutMs;
    slots = [];
    pending = new Map();
    nextId = 1;
    nextStream = 1;
    disposed = false;
    constructor(module, make, initTimeoutMs) {
        this.module = module;
        this.make = make;
        this.initTimeoutMs = initTimeoutMs;
    }
    /** Spawns the workers and waits until every one has instantiated the module. */
    static async create(options = {}) {
        const count = Math.min(4, Math.max(1, Math.floor(options.workers ?? 1)));
        const wasmUrl = options.wasmUrl ?? new URL('./wasm-anim/renderart_bg.wasm', import.meta.url);
        const make = options.createWorker ?? (() => new Worker(new URL('./anim-worker.js', import.meta.url), { type: 'module' }));
        const module = await compile(wasmUrl);
        const pool = new WasmAnimationPool(module, make, options.initTimeoutMs ?? 30000);
        for (let i = 0; i < count; i++)
            pool.slots.push(pool.spawn());
        try {
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
    /** Number of open streams across all workers. */
    get streamCount() {
        let n = 0;
        for (const s of this.slots)
            n += s.streams.size;
        return n;
    }
    spawn() {
        const worker = this.make();
        let settle;
        const ready = new Promise((resolve, reject) => (settle = { resolve, reject }));
        const slot = { worker, ready, broken: false, streams: new Set() };
        ready.catch(() => { });
        const timer = setTimeout(() => settle.reject(new Error(`animation worker did not initialise within ${this.initTimeoutMs} ms`)), this.initTimeoutMs);
        worker.addEventListener('message', (event) => {
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
                if (msg.type === 'frame')
                    closeBitmap(msg.frame?.bitmap);
                return;
            }
            this.pending.delete(msg.id);
            if (msg.type === 'error') {
                if (msg.fatal)
                    this.breakSlot(slot, new Error(msg.error));
                entry.reject(new Error(msg.error));
            }
            else {
                entry.resolve(msg);
            }
        });
        worker.addEventListener('error', (event) => {
            clearTimeout(timer);
            const err = new Error(event.message || 'animation worker error');
            settle.reject(err);
            this.breakSlot(slot, err);
        });
        worker.postMessage({ type: 'init', module: this.module });
        return slot;
    }
    /** Marks a worker dead: its streams are lost, its pending requests fail. */
    breakSlot(slot, err) {
        slot.broken = true;
        for (const [id, entry] of this.pending) {
            if (entry.slot === slot) {
                this.pending.delete(id);
                entry.reject(err);
            }
        }
    }
    /** Replaces broken workers; waits until every worker is ready. */
    async healthy() {
        this.slots = this.slots.map((slot) => {
            if (!slot.broken)
                return slot;
            this.breakSlot(slot, new Error('animation worker restarted'));
            slot.worker.terminate();
            return this.spawn();
        });
        await Promise.all(this.slots.map((s) => s.ready));
    }
    /** @internal Sends a request to `slot` and resolves with its reply. */
    request(slot, req, transfer = []) {
        if (this.disposed)
            return Promise.reject(new Error('WasmAnimationPool disposed'));
        if (slot.broken)
            return Promise.reject(new Error('animation worker restarted: reopen the stream'));
        const id = this.nextId++;
        req.id = id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { slot, resolve, reject });
            slot.worker.postMessage(req, transfer);
        });
    }
    /** @internal Called by {@link AnimationStream.close}. */
    release(slot, stream) {
        slot.streams.delete(stream);
        if (this.disposed || slot.broken)
            return;
        slot.worker.postMessage({ type: 'close', stream });
    }
    /**
     * Opens an animated (or still) GIF / WebP in the least busy worker. The
     * bytes are copied (yours are not detached). Rejects on files that are not
     * GIF/WebP, are corrupt before the first frame, or exceed `maxPixels`.
     */
    async open(data, render, options = {}) {
        if (this.disposed)
            throw new Error('WasmAnimationPool disposed');
        await this.healthy();
        let slot = this.slots[0];
        for (const s of this.slots)
            if (s.streams.size < slot.streams.size)
                slot = s;
        const src = data instanceof Uint8Array ? data : new Uint8Array(data);
        const copy = src.slice();
        const stream = this.nextStream++;
        slot.streams.add(stream);
        try {
            const msg = await this.request(slot, {
                type: 'open',
                id: 0,
                stream,
                data: copy.buffer,
                maxPixels: options.maxPixels && options.maxPixels > 0 ? Math.floor(options.maxPixels) : undefined,
            }, [copy.buffer]);
            if (msg.type !== 'opened')
                throw new Error(`unexpected reply: ${msg.type}`);
            return new AnimationStream(this, slot, stream, msg.info, render);
        }
        catch (err) {
            slot.streams.delete(stream);
            throw err;
        }
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
        const err = new Error('WasmAnimationPool disposed');
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
//# sourceMappingURL=anim-pool.js.map