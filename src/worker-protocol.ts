/**
 * Shared message protocol for the render worker and its client.
 */

import type { CrtOptions, HexOptions, XbrzOptions } from './types.js';

export type EffectName = 'crt' | 'hex' | 'xbrz';

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
      /** RGBA bytes, transferred to the worker */
      buffer: ArrayBuffer;
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
      /** RGBA bytes, transferred back to the main thread */
      buffer: ArrayBuffer;
    }
  | { type: 'result'; id: number; ok: false; error: string };
