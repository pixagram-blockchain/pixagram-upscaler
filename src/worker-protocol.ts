/**
 * Shared message protocol for the render worker and its client.
 */

import type { CrtOptions, HexOptions, XbrzOptions } from './types.js';

export type EffectName = 'crt' | 'hex' | 'xbrz';

/**
 * Desired result form.
 * - 'pixels': RGBA bytes (transferred ArrayBuffer) - use when the CPU needs
 *   the data (encoding, WASM post-processing, pixel inspection).
 * - 'bitmap': ImageBitmap (transferred) - no GPU->CPU readback happens at
 *   all; by far the cheapest path when the result is drawn to a canvas.
 */
export type WorkerOutputKind = 'pixels' | 'bitmap';

export interface EffectOptionsMap {
  crt: CrtOptions;
  hex: HexOptions;
  xbrz: XbrzOptions;
}

/** main thread -> worker */
export type WorkerRequest =
  | {
      type: 'render';
      id: number;
      effect: EffectName;
      width: number;
      height: number;
      options: CrtOptions | HexOptions | XbrzOptions;
      /** Desired output form. Defaults to 'pixels'. */
      output?: WorkerOutputKind;
      /** RGBA bytes, transferred to the worker (exactly one of buffer/bitmap is set) */
      buffer?: ArrayBuffer;
      /** Decoded image, transferred to the worker (exactly one of buffer/bitmap is set) */
      bitmap?: ImageBitmap;
    }
  | { type: 'dispose' };

/** worker -> main thread */
export type WorkerResponse =
  | {
      type: 'result';
      id: number;
      ok: true;
      width: number;
      height: number;
      /** RGBA bytes, transferred back to the main thread (output: 'pixels') */
      buffer?: ArrayBuffer;
      /** Rendered frame, transferred back to the main thread (output: 'bitmap') */
      bitmap?: ImageBitmap;
    }
  | { type: 'result'; id: number; ok: false; error: string };
