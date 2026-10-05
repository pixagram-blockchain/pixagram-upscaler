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
 */

import type { WasmPoolRequest, WasmPoolResponse } from './wasm-pool-protocol.js';
import type { RenderArtWasm } from './wasm-wrapper.js';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let wasm: (RenderArtWasm & Required<Pick<RenderArtWasm, 'xbrz_upscale_band'>>) | null = null;

async function init(module: WebAssembly.Module, glueUrl: string): Promise<void> {
  // The glue path is only known at runtime (bundlers may relocate it).
  const glue = (await import(/* @vite-ignore */ glueUrl)) as {
    initSync(arg: { module: WebAssembly.Module }): unknown;
  } & RenderArtWasm;
  glue.initSync({ module });
  if (typeof glue.xbrz_upscale_band !== 'function') {
    throw new Error('WASM module lacks xbrz_upscale_band (rebuild @pixagram/upscaler/wasm)');
  }
  wasm = glue as typeof wasm;
}

function reply(msg: WasmPoolResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

ctx.addEventListener('message', (event: MessageEvent<WasmPoolRequest>) => {
  const req = event.data;
  if (req.type === 'init') {
    init(req.module, req.glueUrl).then(
      () => reply({ type: 'ready' }),
      (err: unknown) => reply({ type: 'init-error', error: err instanceof Error ? err.message : String(err) })
    );
    return;
  }
  if (req.type !== 'band') return;
  try {
    if (!wasm) throw new Error('worker not initialised');
    const r = wasm.xbrz_upscale_band(
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
    const band = new Uint8Array(wasm.get_memory().buffer, ptr, len);
    if (req.target) {
      // Shared output: write in place, nothing to transfer back.
      new Uint8Array(req.target, req.targetOffset, len).set(band);
      reply({ type: 'band', id: req.id, ok: true });
    } else {
      const copy = band.slice();
      reply({ type: 'band', id: req.id, ok: true, buffer: copy.buffer }, [copy.buffer]);
    }
  } catch (err) {
    reply({ type: 'band', id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
