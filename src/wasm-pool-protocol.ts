/**
 * Message protocol between {@link WasmXbrzPool} and its band workers.
 */

/** main thread -> worker */
export type WasmPoolRequest =
  | {
      type: 'init';
      /** Compiled once on the main thread and shared with every worker. */
      module: WebAssembly.Module;
      /** URL of the wasm-bindgen glue (`renderart.js`). */
      glueUrl: string;
    }
  | {
      type: 'band';
      id: number;
      /** Source rows [windowY0, windowY0 + window rows), transferred. */
      window: ArrayBuffer;
      width: number;
      height: number;
      windowY0: number;
      /** Source rows to render: [y0, y1). */
      y0: number;
      y1: number;
      scale: number;
      equalColorTolerance: number;
      centerDirectionBias: number;
      dominantDirectionThreshold: number;
      steepDirectionThreshold: number;
      /** Optional shared output (caller-provided SharedArrayBuffer). */
      target?: SharedArrayBuffer;
      targetOffset?: number;
    };

/** worker -> main thread */
export type WasmPoolResponse =
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | { type: 'band'; id: number; ok: true; buffer?: ArrayBuffer }
  | { type: 'band'; id: number; ok: false; error: string };
