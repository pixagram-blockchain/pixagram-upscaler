/**
 * Render Worker
 *
 * Runs the GPU renderers entirely off the main thread. The WebGL2 context is
 * created here (on an OffscreenCanvas), so texture upload, drawing and pixel
 * readback never block the UI thread.
 *
 * Build target: a module worker. Instantiate via {@link WorkerRenderer} or:
 *   new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' })
 */

import { CrtGpuRenderer } from './crt-gpu.js';
import { HexGpuRenderer } from './hex-gpu.js';
import { XbrzGpuRenderer } from './xbrz-gpu.js';
import type { ImageInput } from './types.js';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.js';

// Avoid DOM/WebWorker `self` typing ambiguity when both libs are enabled.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let crt: CrtGpuRenderer | null = null;
let hex: HexGpuRenderer | null = null;
let xbrz: XbrzGpuRenderer | null = null;

function reply(message: WorkerResponse, transfer: Transferable[]): void {
  ctx.postMessage(message, transfer);
}

async function handleRender(req: Extract<WorkerRequest, { type: 'render' }>): Promise<void> {
  const input: ImageInput = {
    data: new Uint8ClampedArray(req.buffer),
    width: req.width,
    height: req.height,
  };

  let out;
  switch (req.effect) {
    case 'crt':
      crt ??= CrtGpuRenderer.create();
      out = await crt.renderAsync(input, req.options);
      break;
    case 'hex':
      hex ??= HexGpuRenderer.create();
      out = await hex.renderAsync(input, req.options);
      break;
    case 'xbrz':
      xbrz ??= XbrzGpuRenderer.create();
      out = await xbrz.renderAsync(input, req.options);
      break;
    default:
      throw new Error(`Unknown effect: ${(req as { effect: string }).effect}`);
  }

  // The renderer allocates a fresh, exactly-sized Uint8ClampedArray for each
  // result, so its backing store is always a plain (non-shared) ArrayBuffer and
  // is safe to transfer. TypeScript widens `.buffer` to ArrayBufferLike, so we
  // narrow it back here.
  const buffer = out.data.buffer as ArrayBuffer;
  reply(
    { type: 'result', id: req.id, ok: true, width: out.width, height: out.height, buffer },
    [buffer]
  );
}

function disposeAll(): void {
  crt?.dispose();
  hex?.dispose();
  xbrz?.dispose();
  crt = hex = xbrz = null;
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (req.type === 'dispose') {
    disposeAll();
    return;
  }
  if (req.type === 'render') {
    handleRender(req).catch((err: unknown) => {
      reply(
        { type: 'result', id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) },
        []
      );
    });
  }
});
