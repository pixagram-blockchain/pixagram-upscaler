/**
 * Depixelize worker for {@link WasmDepixelizePool}.
 *
 * Owns one instance of the depixelize module (instantiated from the module the
 * pool compiled once, SIMD or scalar build) and vectorizes one whole image per
 * request: the pixels arrive as a transferred buffer, the SVG goes back as a
 * string or as transferred UTF-8 bytes. Requests run in arrival order.
 *
 * Build target: a module worker, e.g.
 *   new Worker(new URL('./depixelize-worker.js', import.meta.url), { type: 'module' })
 *
 * The glue is imported statically, so a bundler that builds this worker
 * includes it in the worker chunk.
 */
// The depixelize ES-module glue, copied into dist/depixelize by
// `npm run build:depixelize` next to the compiled worker; it is not part of
// the TypeScript sources.
// @ts-ignore: resolved in dist/ (see above)
import { load } from './depixelize/depixelize-wasm.mjs';
const loadEngine = load;
const ctx = self;
let engine = null;
/** Set once the instance trapped: its state can no longer be trusted. */
let trapped = false;
let queue = Promise.resolve();
function reply(msg, transfer = []) {
    ctx.postMessage(msg, transfer);
}
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/** A trap (RuntimeError, e.g. out of memory) can leave the instance inconsistent; a JS `Error` thrown by the glue cannot. */
function isFatal(err) {
    return typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError;
}
async function init(module) {
    try {
        engine = await loadEngine(module);
        reply({ type: 'ready', simd: engine.simd });
    }
    catch (err) {
        reply({ type: 'init-error', error: errorText(err) });
    }
}
function run(req) {
    try {
        if (trapped)
            throw new Error('depixelize worker instance trapped earlier');
        if (!engine)
            throw new Error('worker not initialised');
        const image = { width: req.width, height: req.height, data: new Uint8Array(req.data) };
        if (req.output === 'bytes') {
            // One copy out of WASM memory, then transferred (no second copy).
            const bytes = engine.depixelizeView(image, req.options).slice();
            reply({ type: 'result', id: req.id, ok: true, buffer: bytes.buffer }, [bytes.buffer]);
        }
        else {
            reply({ type: 'result', id: req.id, ok: true, svg: engine.depixelize(image, req.options) });
        }
    }
    catch (err) {
        const fatal = isFatal(err);
        if (fatal)
            trapped = true;
        reply({
            type: 'result',
            id: req.id,
            ok: false,
            error: errorText(err),
            name: err instanceof Error ? err.name : 'Error',
            fatal,
        });
    }
}
ctx.addEventListener('message', (event) => {
    const req = event.data;
    if (req.type === 'init') {
        queue = queue.then(() => init(req.module));
    }
    else if (req.type === 'run') {
        queue = queue.then(() => run(req));
    }
});
//# sourceMappingURL=depixelize-worker.js.map