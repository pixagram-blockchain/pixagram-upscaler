/**
 * xBRZ GPU Renderer using WebGL2
 * Uses shared GPU context for optimal resource usage
 *
 * High-performance xBRZ pixel art scaling using fragment shaders.
 * Based on Hyllian's xBRZ algorithm with RGBA alpha support.
 */

import type { ImageOutput, Renderer, RenderSource, XbrzOptions } from './types.js';
import {
  acquireContext,
  releaseContext,
  isContextReady,
  getContext,
  getContextGeneration,
  registerProgram,
  hasProgram,
  getProgram,
  useProgram,
  assertOutputSize,
  bindRenderTarget,
  transferBitmap,
  runExclusive,
  isImageBitmap,
  createTexture,
  deleteTexture,
  readPixels,
  readPixelsAsync,
  draw,
  clear,
} from './gpu-context.js';
import type { RenderTarget } from './gpu-context.js';
import {
  XBRZ_VERTEX_SHADER,
  XBRZ_FRAG_2X,
  XBRZ_FRAG_3X,
  XBRZ_FRAG_4X,
  XBRZ_FRAG_5X,
  XBRZ_FRAG_6X,
} from './xbrz-shaders.js';

const PROGRAM_PREFIX = 'xbrz';
const SCALES = [2, 3, 4, 5, 6] as const;

const UNIFORMS = [
  'uTex',
  'uInputRes',
  'uCenterDirectionBias',
  'uEqualColorTolerance',
  'uSteepDirectionThreshold',
  'uDominantDirectionThreshold',
  'uFlipY',
];

const SHADERS: Record<number, string> = {
  2: XBRZ_FRAG_2X,
  3: XBRZ_FRAG_3X,
  4: XBRZ_FRAG_4X,
  5: XBRZ_FRAG_5X,
  6: XBRZ_FRAG_6X,
};

/** xBRZ GPU Renderer */
export class XbrzGpuRenderer implements Renderer<XbrzOptions> {
  private initialized = false;
  private texture: WebGLTexture | null = null;
  private textureSize = { width: 0, height: 0 };
  /** Context generation our GPU resources belong to (see context loss handling). */
  private contextGen = -1;

  static create(): XbrzGpuRenderer {
    const renderer = new XbrzGpuRenderer();
    renderer.init();
    return renderer;
  }

  private init(): void {
    if (this.initialized) return;
    acquireContext();
    this.ensureResources();
    this.initialized = true;
  }

  /**
   * (Re)creates GPU resources. Called on init and again after the WebGL
   * context was lost and restored - the shared program cache is cleared on
   * loss, so registerProgram recompiles, and our input texture is recreated.
   */
  private ensureResources(): void {
    const gen = getContextGeneration();
    if (this.contextGen === gen && this.texture) return;

    // Register programs for each scale factor
    for (const scale of SCALES) {
      const programId = `${PROGRAM_PREFIX}_${scale}x`;
      if (!hasProgram(programId)) {
        registerProgram(programId, XBRZ_VERTEX_SHADER, SHADERS[scale], UNIFORMS);
      }
    }

    // xBRZ uses NEAREST filtering
    this.texture = createTexture('nearest');
    this.textureSize = { width: 0, height: 0 };
    this.contextGen = gen;
  }

  isReady(): boolean {
    return this.initialized && isContextReady();
  }

  /**
   * Submit the draw call. Shared by all output paths.
   * Returns the output dimensions.
   */
  private submit(
    input: RenderSource,
    options: XbrzOptions,
    target: RenderTarget
  ): { outWidth: number; outHeight: number } {
    if (!this.initialized) throw new Error('Renderer not initialized');
    this.ensureResources();

    const { gl } = getContext();

    const width = input.width;
    const height = input.height;

    const scale = Math.min(6, Math.max(2, options.scale ?? 2)) as 2 | 3 | 4 | 5 | 6;
    const outWidth = width * scale;
    const outHeight = height * scale;

    // Fail fast with a clear message instead of letting an oversized
    // allocation OOM the GPU or lose the context.
    assertOutputSize(outWidth, outHeight);

    const programId = `${PROGRAM_PREFIX}_${scale}x`;
    const { program, uniforms } = getProgram(programId);

    // Bind program (no-op when already current) and the sampler unit.
    useProgram(program);
    gl.uniform1i(uniforms.get('uTex')!, 0);

    bindRenderTarget(outWidth, outHeight, target);

    // Set uniforms
    gl.uniform2f(uniforms.get('uInputRes')!, width, height);
    gl.uniform1f(uniforms.get('uCenterDirectionBias')!, options.centerDirectionBias ?? 4.0);
    gl.uniform1f(uniforms.get('uEqualColorTolerance')!, (options.equalColorTolerance ?? 30) / 255.0);
    gl.uniform1f(uniforms.get('uSteepDirectionThreshold')!, options.steepDirectionThreshold ?? 2.2);
    gl.uniform1f(uniforms.get('uDominantDirectionThreshold')!, options.dominantDirectionThreshold ?? 3.6);
    gl.uniform1f(uniforms.get('uFlipY')!, target === 'canvas' ? 1.0 : 0.0);

    // Upload input (raw RGBA bytes, ImageData, or ImageBitmap - the latter is
    // uploaded by the browser directly, often without a CPU copy).
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const sameSize = this.textureSize.width === width && this.textureSize.height === height;
    if (isImageBitmap(input)) {
      if (sameSize) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, input);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
      }
    } else {
      const data = input.data;
      if (sameSize) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
    }
    if (!sameSize) this.textureSize = { width, height };

    clear();
    draw();

    return { outWidth, outHeight };
  }

  render(input: RenderSource, options: XbrzOptions = {}): ImageOutput {
    const { outWidth, outHeight } = this.submit(input, options, 'texture');
    return {
      data: readPixels(outWidth, outHeight),
      width: outWidth,
      height: outHeight,
    };
  }

  /**
   * Non-blocking variant: the GPU keeps working while we await readback.
   * Ideal inside a Web Worker. An optional reusable buffer can be supplied
   * to avoid per-call allocations. Concurrent calls are safe: GPU work is
   * serialized internally.
   */
  renderAsync(
    input: RenderSource,
    options: XbrzOptions = {},
    out?: Uint8ClampedArray
  ): Promise<ImageOutput> {
    return runExclusive(async () => {
      const { outWidth, outHeight } = this.submit(input, options, 'texture');
      const data = await readPixelsAsync(outWidth, outHeight, out);
      return { data, width: outWidth, height: outHeight };
    });
  }

  /**
   * Render straight to an ImageBitmap with no GPU->CPU readback at all.
   * This is by far the cheapest path when the result is going to be drawn
   * to a canvas / used as a texture: the backbuffer is handed over zero-copy.
   */
  renderToBitmap(input: RenderSource, options: XbrzOptions = {}): Promise<ImageBitmap> {
    return runExclusive(() => {
      this.submit(input, options, 'canvas');
      return transferBitmap();
    });
  }

  dispose(): void {
    if (this.initialized) {
      if (this.texture) {
        deleteTexture(this.texture);
        this.texture = null;
      }
      this.textureSize = { width: 0, height: 0 };
      releaseContext();
      this.initialized = false;
    }
  }
}

export const XBRZ_PRESETS: Record<string, Partial<XbrzOptions>> = {
  default: {},
  sharp: {
    centerDirectionBias: 4.0,
    equalColorTolerance: 20,
    steepDirectionThreshold: 2.0,
    dominantDirectionThreshold: 3.2,
  },
  smooth: {
    centerDirectionBias: 4.0,
    equalColorTolerance: 40,
    steepDirectionThreshold: 2.4,
    dominantDirectionThreshold: 4.0,
  },
  standard: {
    centerDirectionBias: 4.0,
    equalColorTolerance: 30,
    steepDirectionThreshold: 2.2,
    dominantDirectionThreshold: 3.6,
  },
};
