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

import type { DepixelizeRequest, DepixelizeResponse } from './depixelize-protocol.js';
import type { DepixelizeOptions } from './types.js';
// The depixelize ES-module glue, copied into dist/depixelize by
// `npm run build:depixelize` next to the compiled worker; it is not part of
// the TypeScript sources.
// @ts-ignore: resolved in dist/ (see above)
import { load } from './depixelize/depixelize-wasm.mjs';

/** The part of the glue's `Engine` used here (see depixelize-wasm.d.ts). */
interface Engine {
  readonly simd: boolean;
  depixelize(image: { width: number; height: number; data: Uint8Array }, opts?: DepixelizeOptions): string;
  depixelizeView(image: { width: number; height: number; data: Uint8Array }, opts?: DepixelizeOptions): Uint8Array;
}

const loadEngine = load as (source: WebAssembly.Module) => Promise<Engine>;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let engine: Engine | null = null;
/** Set once the instance trapped: its state can no longer be trusted. */
let trapped = false;
let queue: Promise<void> = Promise.resolve();

function reply(msg: DepixelizeResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A trap (RuntimeError, e.g. out of memory) can leave the instance inconsistent; a JS `Error` thrown by the glue cannot. */
function isFatal(err: unknown): boolean {
  return typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError;
}

async function init(module: WebAssembly.Module): Promise<void> {
  try {
    engine = await loadEngine(module);
    reply({ type: 'ready', simd: engine.simd });
  } catch (err) {
    reply({ type: 'init-error', error: errorText(err) });
  }
}

function run(req: Extract<DepixelizeRequest, { type: 'run' }>): void {
  try {
    if (trapped) throw new Error('depixelize worker instance trapped earlier');
    if (!engine) throw new Error('worker not initialised');
    const image = { width: req.width, height: req.height, data: new Uint8Array(req.data) };
    if (req.output === 'bytes') {
      // One copy out of WASM memory, then transferred (no second copy).
      const bytes = engine.depixelizeView(image, req.options).slice();
      reply({ type: 'result', id: req.id, ok: true, buffer: bytes.buffer }, [bytes.buffer]);
    } else {
      reply({ type: 'result', id: req.id, ok: true, svg: engine.depixelize(image, req.options) });
    }
  } catch (err) {
    const fatal = isFatal(err);
    if (fatal) trapped = true;
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

ctx.addEventListener('message', (event: MessageEvent<DepixelizeRequest>) => {
  const req = event.data;
  if (req.type === 'init') {
    queue = queue.then(() => init(req.module));
  } else if (req.type === 'run') {
    queue = queue.then(() => run(req));
  }
});
