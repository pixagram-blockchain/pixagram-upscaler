/**
 * WASM band worker for {@link WasmXbrzPool}.
 *
 * Each worker owns its own WebAssembly instance (instantiated from a module the
 * pool compiled once) and renders horizontal bands of an xBRZ upscale. Bands
 * carry their 2-row halo, so they stack byte-identically to a single-threaded
 * render. No SharedArrayBuffer is required; when the pool passes one (page is
 * cross-origin isolated) the band is written straight into it.
 *
 * Build target: a module worker, e.g.
 *   new Worker(new URL('./wasm-worker.js', import.meta.url), { type: 'module' })
 *
 * The wasm-bindgen glue is imported statically, so a bundler that builds this
 * worker includes the glue in the worker chunk. (A runtime `import(url)` made
 * webpack warn "Critical dependency: the request of a dependency is an
 * expression" and fail to load the glue.)
 */

import type { WasmPoolRequest, WasmPoolResponse } from './wasm-pool-protocol.js';
import type { RenderArtWasm } from './wasm-wrapper.js';
// Generated into dist/wasm by `npm run build:wasm`, next to the compiled
// worker; it is not part of the TypeScript sources.
// @ts-ignore: resolved in dist/ (see above)
import * as glueModule from './wasm/renderart.js';

type Glue = RenderArtWasm &
  Required<Pick<RenderArtWasm, 'xbrz_upscale_band'>> & {
    initSync(arg: { module: WebAssembly.Module }): { xbrz_upscale_band?: unknown };
  };

const glue = glueModule as unknown as Glue;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let initialised = false;

function init(module: WebAssembly.Module): void {
  const exports = glue.initSync({ module });
  // A module from an older build (custom `wasmUrl`) may lack the band export.
  if (typeof exports.xbrz_upscale_band !== 'function') {
    throw new Error('WASM module lacks xbrz_upscale_band (rebuild @pixagram/upscaler/wasm)');
  }
  initialised = true;
}

function reply(msg: WasmPoolResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

ctx.addEventListener('message', (event: MessageEvent<WasmPoolRequest>) => {
  const req = event.data;
  if (req.type === 'init') {
    try {
      init(req.module);
      reply({ type: 'ready' });
    } catch (err) {
      reply({ type: 'init-error', error: errorText(err) });
    }
    return;
  }
  if (req.type !== 'band') return;
  try {
    if (!initialised) throw new Error('worker not initialised');
    const r = glue.xbrz_upscale_band(
      new Uint8Array(req.window),
      req.width,
      req.height,
      req.windowY0,
      req.y0,
      req.y1,
      req.scale,
      req.equalColorTolerance,
      req.centerDirectionBias,
      req.dominantDirectionThreshold,
      req.steepDirectionThreshold
    );
    const ptr = r.ptr;
    const len = r.len;
    r.free?.();
    const band = new Uint8Array(glue.get_memory().buffer, ptr, len);
    if (req.target) {
      // Shared output: write in place, nothing to transfer back.
      new Uint8Array(req.target, req.targetOffset, len).set(band);
      reply({ type: 'band', id: req.id, ok: true });
    } else {
      const copy = band.slice();
      reply({ type: 'band', id: req.id, ok: true, buffer: copy.buffer }, [copy.buffer]);
    }
  } catch (err) {
    reply({ type: 'band', id: req.id, ok: false, error: errorText(err) });
  }
});
