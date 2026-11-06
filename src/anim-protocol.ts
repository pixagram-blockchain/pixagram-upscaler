/**
 * Message protocol between {@link WasmAnimationPool} and its animation workers.
 */

import type { AnimationInfo } from './anim-probe.js';
import type { FrameRenderSpec } from './frames.js';

/** How a rendered frame travels back to the page. */
export type FrameOutputKind = 'bitmap' | 'pixels';

/** main thread -> worker */
export type AnimRequest =
  | {
      type: 'init';
      /** Compiled once on the main thread and shared with every worker. */
      module: WebAssembly.Module;
    }
  | {
      type: 'open';
      id: number;
      stream: number;
      /** The encoded GIF / WebP, transferred. */
      data: ArrayBuffer;
      maxPixels?: number;
    }
  | {
      type: 'next';
      id: number;
      stream: number;
      render: FrameRenderSpec;
      /** Frames to decode (composite) without rendering first. */
      skip: number;
      /** At the end of the loop, rewind and return frame 0. */
      wrap: boolean;
      output: FrameOutputKind;
    }
  | { type: 'rewind'; id: number; stream: number }
  | { type: 'close'; stream: number };

/** A rendered frame as the worker sends it. */
export interface FramePayload {
  /** Index within the loop. */
  index: number;
  /** Effective duration in ms. */
  delay: number;
  width: number;
  height: number;
  /** True when the end of the loop was reached and frame 0 decoded again. */
  looped: boolean;
  /** Milliseconds the worker spent on this frame (decode + render + output). */
  cost: number;
  /** output 'bitmap' (transferred). */
  bitmap?: ImageBitmap;
  /** output 'pixels' (transferred RGBA bytes). */
  buffer?: ArrayBuffer;
}

/** worker -> main thread */
export type AnimResponse =
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | { type: 'opened'; id: number; info: Omit<AnimationInfo, 'needsFrameDecoder'> }
  /** `frame: null` at the end of the loop (when not wrapping). */
  | { type: 'frame'; id: number; frame: FramePayload | null }
  | { type: 'rewound'; id: number }
  /**
   * A request failed. `fatal` means the WASM instance may be unusable (it
   * trapped): the pool replaces the worker and its streams are lost.
   */
  | { type: 'error'; id: number; error: string; fatal: boolean };
