/**
 * Message protocol between {@link WasmDepixelizePool} and its workers.
 */

import type { DepixelizeOptions } from './types.js';

/** How a worker returns the SVG: a string, or transferred UTF-8 bytes. */
export type DepixelizeOutputKind = 'string' | 'bytes';

/** main thread -> worker */
export type DepixelizeRequest =
  | {
      type: 'init';
      /** Compiled once on the main thread and shared with every worker. */
      module: WebAssembly.Module;
    }
  | {
      type: 'run';
      id: number;
      width: number;
      height: number;
      /** RGBA or RGB pixels (a copy), transferred. */
      data: ArrayBuffer;
      options: DepixelizeOptions;
      output: DepixelizeOutputKind;
    };

/** worker -> main thread */
export type DepixelizeResponse =
  | {
      type: 'ready';
      /** The instance is the SIMD build. */
      simd: boolean;
    }
  | { type: 'init-error'; error: string }
  | {
      type: 'result';
      id: number;
      ok: true;
      /** output 'string' */
      svg?: string;
      /** output 'bytes': the SVG as UTF-8, transferred. */
      buffer?: ArrayBuffer;
    }
  | {
      type: 'result';
      id: number;
      ok: false;
      error: string;
      /** `Error.name` in the worker (`RangeError` for invalid images). */
      name: string;
      /** The instance trapped and must not be used again. */
      fatal: boolean;
    };
