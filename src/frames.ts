/**
 * Batches of frames - animated GIF / WebP - processed one frame at a time.
 *
 * Memory is the point. The WASM module keeps the compressed file, ONE source
 * canvas (`width * height` RGBA) and ONE output buffer (shared with every
 * other render call). A frame is decoded and composited onto the canvas,
 * upscaled into the output buffer, handed to you as a zero-copy view, and
 * overwritten by the next frame. Nothing is accumulated, whatever the number
 * of frames or loops:
 *
 *   import init, * as wasm from '@pixagram/upscaler/wasm-anim';
 *   import { upscaleFrames } from '@pixagram/upscaler';
 *
 *   await init();
 *   for (const frame of upscaleFrames(wasm, gifBytes, { effect: 'xbrz', options: { scale: 4 } })) {
 *     // frame.data is valid until the loop continues: draw or copy it now.
 *     ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
 *     await sleep(frame.delay);
 *   }
 *
 * {@link WasmAnimation} is the lower-level handle (step, skip, rewind, render
 * the current frame with any effect); {@link upscaleFrameBatch} runs the same
 * one-frame-at-a-time loop over frames you decode yourself. For playback off
 * the main thread, see `WasmAnimationPool`.
 *
 * The decoder lives in the `anim` build of the module,
 * `@pixagram/upscaler/wasm-anim` (the default `@pixagram/upscaler/wasm` stays
 * small and has no `FrameDecoder`); it carries the upscalers too.
 */

import type { CrtOptions, HexOptions, ImageInput, ImageOutput, XbrzOptions } from './types.js';
import type { RenderArtWasm, WasmFrameDecoder, WasmUpscaleResult } from './wasm-wrapper.js';
import { crtArgs, hexArgs, readWasmOutput, viewWasmOutput, WasmRenderer, xbrzArgs } from './wasm-wrapper.js';

/** How a frame is rendered: an upscaler, or `'none'` for the source frame. */
export type FrameEffect = 'xbrz' | 'crt' | 'hex' | 'none';

/** An effect and its options (`scale` included). */
export type FrameRenderSpec =
  | { effect: 'xbrz'; options?: XbrzOptions }
  | { effect: 'crt'; options?: CrtOptions }
  | { effect: 'hex'; options?: HexOptions }
  | { effect: 'none'; options?: undefined };

/** A rendered frame of an animation. */
export interface RenderedFrame extends ImageOutput {
  /** Index of the frame within its loop. */
  index: number;
  /** How long to show it, in ms (durations under 11 ms play as 100 ms). */
  delay: number;
  /** Which loop it belongs to (0 = first play). */
  loop: number;
}

/** Options for {@link WasmAnimation.open}. */
export interface WasmAnimationOpenOptions {
  /** Refuse canvases larger than this many pixels (default 16 MP). */
  maxPixels?: number;
}

/** `wasm` with the 0.5.0+ `FrameDecoder` export, or a clear error. */
function frameDecoderClass(wasm: RenderArtWasm): NonNullable<RenderArtWasm['FrameDecoder']> {
  const ctor = wasm.FrameDecoder;
  if (typeof ctor !== 'function') {
    throw new Error('this WASM module has no FrameDecoder: use @pixagram/upscaler/wasm-anim (0.5.0+)');
  }
  return ctor;
}

function asBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Renders the current frame of a raw decoder into the module's shared output
 * buffer (or returns the canvas itself for `'none'`). The result object must
 * be read and freed by the caller.
 */
export function renderDecoderFrame(dec: WasmFrameDecoder, spec: FrameRenderSpec): WasmUpscaleResult {
  switch (spec.effect) {
    case 'xbrz':
      return dec.upscale_xbrz(...xbrzArgs(spec.options));
    case 'crt':
      return dec.upscale_crt(...crtArgs(spec.options));
    case 'hex':
      return dec.upscale_hex(...hexArgs(spec.options));
    case 'none':
      return dec.frame();
    default:
      throw new Error(`unknown frame effect: ${(spec as { effect: string }).effect}`);
  }
}

/**
 * An animated (or still) GIF / WebP inside a WASM module, decoded one
 * composited frame at a time. Holds the compressed file and one canvas; call
 * {@link free} when done (a finalizer frees forgotten instances eventually).
 */
export class WasmAnimation {
  private dec: WasmFrameDecoder | null;

  private constructor(
    private readonly wasm: RenderArtWasm,
    dec: WasmFrameDecoder
  ) {
    this.dec = dec;
  }

  /**
   * Parses `data` (copied into WASM memory) and allocates the canvas. Throws
   * on files that are not GIF/WebP, are corrupt before the first frame, or
   * exceed `maxPixels`.
   */
  static open(wasm: RenderArtWasm, data: Uint8Array | ArrayBuffer, options: WasmAnimationOpenOptions = {}): WasmAnimation {
    const Decoder = frameDecoderClass(wasm);
    const max = options.maxPixels;
    const dec = new Decoder(asBytes(data), max !== undefined && max > 0 ? Math.min(0xffffffff, Math.floor(max)) : undefined);
    return new WasmAnimation(wasm, dec);
  }

  private get d(): WasmFrameDecoder {
    if (!this.dec) throw new Error('WasmAnimation freed');
    return this.dec;
  }

  get format(): 'gif' | 'webp' {
    return this.d.format as 'gif' | 'webp';
  }
  /** Canvas size: the size of every source frame. */
  get width(): number {
    return this.d.width;
  }
  get height(): number {
    return this.d.height;
  }
  /** Frames in one loop. */
  get frameCount(): number {
    return this.d.frame_count;
  }
  /** Total plays, 0 = forever. */
  get loopCount(): number {
    return this.d.loop_count;
  }
  /** One loop in ms. */
  get durationMs(): number {
    return this.d.duration_ms;
  }
  /** More than one frame. */
  get animated(): boolean {
    return this.d.animated;
  }
  /** Index of the frame on the canvas (-1 before the first `next()`). */
  get index(): number {
    return this.d.index;
  }
  /** How long to show the current frame, in ms. */
  get delay(): number {
    return this.d.delay_ms;
  }
  /** A frame failed to decode and the loop now ends before it. */
  get truncated(): boolean {
    return this.d.truncated;
  }

  /** Decodes the next frame; `false` at the end of the loop (see {@link rewind}). */
  next(): boolean {
    return this.d.next_frame();
  }

  /** Advances `n` frames without rendering them; returns how many it advanced. */
  skip(n: number): number {
    return this.d.skip_frames(Math.max(0, Math.floor(n)));
  }

  /** Restarts at frame 0 with a transparent canvas. */
  rewind(): void {
    this.d.rewind();
  }

  /**
   * Zero-copy view of the composited source frame. Valid until the next
   * `next()` / `skip()` / `rewind()` / `free()` (or a WASM memory growth).
   */
  frameView(): ImageOutput {
    return viewWasmOutput(this.wasm, this.d.frame());
  }

  /**
   * Renders the current frame and returns a zero-copy view of the module's
   * shared output buffer: valid until the next render call on this module.
   * `'none'` returns {@link frameView}.
   */
  renderView(spec: FrameRenderSpec): ImageOutput {
    return viewWasmOutput(this.wasm, renderDecoderFrame(this.d, spec));
  }

  /** Like {@link renderView}, but copied (into `out` when given). */
  render(spec: FrameRenderSpec, out?: Uint8ClampedArray): ImageOutput {
    return readWasmOutput(this.wasm, renderDecoderFrame(this.d, spec), out);
  }

  /** Releases the decoder (compressed file and canvas). Idempotent. */
  free(): void {
    const d = this.dec;
    this.dec = null;
    d?.free();
  }
}

/** Options for {@link upscaleFrames}. */
export interface UpscaleFramesOptions extends WasmAnimationOpenOptions {
  /**
   * Loops to process (default 1). `Infinity` follows the file: its own loop
   * count, or forever when it loops forever.
   */
  loops?: number;
}

/**
 * Renders every frame of an animation, one at a time, as a generator. Each
 * yielded frame's `data` is a zero-copy view that is valid only until the
 * generator resumes - draw or copy it first. Accepts the encoded file (the
 * decoder is opened and freed here) or an open {@link WasmAnimation} (left
 * open, positioned after the last frame rendered).
 */
export function* upscaleFrames(
  wasm: RenderArtWasm,
  source: Uint8Array | ArrayBuffer | WasmAnimation,
  spec: FrameRenderSpec,
  options: UpscaleFramesOptions = {}
): Generator<RenderedFrame, void, undefined> {
  const owned = !(source instanceof WasmAnimation);
  const anim = source instanceof WasmAnimation ? source : WasmAnimation.open(wasm, source, options);
  try {
    const wanted = options.loops ?? 1;
    const loops = wanted === Infinity ? (anim.loopCount === 0 ? Infinity : anim.loopCount) : Math.max(0, Math.floor(wanted));
    for (let loop = 0; loop < loops; loop++) {
      if (loop > 0) anim.rewind();
      let frames = 0;
      while (anim.next()) {
        frames++;
        const out = anim.renderView(spec);
        yield { data: out.data, width: out.width, height: out.height, index: anim.index, delay: anim.delay, loop };
      }
      if (frames === 0) break; // nothing decodable: never spin
      if (anim.frameCount <= 1) break; // a still image has nothing to loop
    }
  } finally {
    if (owned) anim.free();
  }
}

/**
 * Upscales frames you supply - from any decoder, any iterable or async
 * iterable - one at a time through a {@link WasmRenderer}. `onFrame` receives
 * a zero-copy view of the module's output buffer that is valid until it
 * returns (or until its promise settles); the next frame is not rendered
 * before that. Returns the number of frames processed.
 */
export async function upscaleFrameBatch(
  renderer: WasmRenderer,
  frames: Iterable<ImageInput | ImageData> | AsyncIterable<ImageInput | ImageData>,
  spec: FrameRenderSpec,
  onFrame: (frame: ImageOutput, index: number) => void | Promise<void>
): Promise<number> {
  let index = 0;
  for await (const input of frames as AsyncIterable<ImageInput | ImageData>) {
    let out: ImageOutput;
    switch (spec.effect) {
      case 'xbrz':
        out = renderer.renderXbrzView(input, spec.options);
        break;
      case 'crt':
        out = renderer.renderCrtView(input, spec.options);
        break;
      case 'hex':
        out = renderer.renderHexView(input, spec.options);
        break;
      default:
        out = { data: input.data instanceof Uint8ClampedArray ? input.data : new Uint8ClampedArray(input.data.buffer, input.data.byteOffset, input.data.byteLength), width: input.width, height: input.height };
    }
    await onFrame(out, index++);
  }
  return index;
}
