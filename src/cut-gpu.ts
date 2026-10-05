/**
 * CUT3 GPU Renderer using WebGL2 — Cheap Upscaling Triangulation, level 3.
 *
 * Three-pass content-adaptive upscaler: pass 0 triangulates the luma plane
 * of every 2x2 quad and detects soft edges, pass 1 walks along hard edges
 * to refine per-side weights, pass 2 interpolates the output inside each
 * quad / triangle. Passes 0 and 1 render to input-sized RGBA8 textures
 * owned by this renderer; the final pass uses the shared render target so
 * every output path (readPixels / async readback / ImageBitmap transfer)
 * works exactly like the other renderers.
 *
 * Ported from "Cheap Upscaling Triangulation",
 * Copyright (c) Filippo Scognamiglio 2024,
 * https://github.com/Swordfish90/cheap-upscaling-triangulation
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import type { CutOptions, ImageOutput, Renderer, RenderSource } from './types.js';
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
  CUT_PASS0_VERTEX,
  CUT_PASS0_FRAGMENT,
  CUT_PASS1_VERTEX,
  CUT_PASS1_FRAGMENT,
  CUT_PASS2_VERTEX,
  CUT_PASS2_FRAGMENT,
} from './cut-shaders.js';

const P0 = 'cut3_p0';
const P1 = 'cut3_p1';
const P2 = 'cut3_p2';

const P0_UNIFORMS = ['uTextureSize', 'uTex0', 'uSearchMaxError', 'uEdgeUseFastLuma', 'uSoftEdgesSharpening'];
const P1_UNIFORMS = [
  'uTextureSize',
  'uPreviousPass',
  'uStep',
  'uHstep',
  'uMaxDoubleDistance',
  'uMaxDistance',
  'uSearchMaxDistance',
  'uSoftEdgesSharpening',
  'uSoftEdgesSharpeningAmount',
];
const P2_UNIFORMS = [
  'uTextureSize',
  'uTex0',
  'uPreviousPass',
  'uUseDynamicBlend',
  'uBlendMinContrastEdge',
  'uBlendDiffInv',
  'uBlendMinSharpness',
  'uBlendMaxSharpness',
  'uStaticBlendSharpness',
  'uFlipY',
];

/**
 * Fully-resolved CUT3 parameters. The same normalisation lives in the Rust
 * implementation (`sanitize` in cut.rs) so the WASM and GPU paths always
 * agree on what a given option set means.
 */
interface ResolvedCutOptions {
  scale: number;
  useDynamicBlend: boolean;
  blendMinContrastEdge: number;
  blendMaxContrastEdge: number;
  blendMinSharpness: number;
  blendMaxSharpness: number;
  staticBlendSharpness: number;
  edgeUseFastLuma: boolean;
  softEdgesSharpening: boolean;
  softEdgesSharpeningAmount: number;
  hardEdgesSearchMaxError: number;
  hardEdgesSearchMaxDistance: number;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Defaults match the upstream demo's `#define` block. */
export function resolveCutOptions(options: CutOptions): ResolvedCutOptions {
  const minContrast = clampNum(options.blendMinContrastEdge ?? 0.0, 0, 1);
  const maxContrast = clampNum(options.blendMaxContrastEdge ?? 0.25, minContrast + 1e-4, 1.0001);
  return {
    scale: Math.round(clampNum(options.scale ?? 3, 1, 32)),
    useDynamicBlend: options.useDynamicBlend !== false,
    blendMinContrastEdge: minContrast,
    blendMaxContrastEdge: maxContrast,
    blendMinSharpness: clampNum(options.blendMinSharpness ?? 0.0, 0, 1),
    blendMaxSharpness: clampNum(options.blendMaxSharpness ?? 0.75, 0, 1),
    staticBlendSharpness: clampNum(options.staticBlendSharpness ?? 0.5, 0, 1),
    edgeUseFastLuma: options.edgeUseFastLuma === true,
    softEdgesSharpening: options.softEdgesSharpening !== false,
    softEdgesSharpeningAmount: clampNum(options.softEdgesSharpeningAmount ?? 1.0, 0, 1),
    hardEdgesSearchMaxError: clampNum(options.hardEdgesSearchMaxError ?? 0.25, 0, 1),
    hardEdgesSearchMaxDistance: Math.round(clampNum(options.hardEdgesSearchMaxDistance ?? 4, 1, 16)),
  };
}

/** CUT3 GPU Renderer */
export class CutGpuRenderer implements Renderer<CutOptions> {
  private initialized = false;
  private inputTexture: WebGLTexture | null = null;
  private inputSize = { width: 0, height: 0 };
  /** Input-sized RGBA8 targets for pass 0 and pass 1 output. */
  private passTextures: (WebGLTexture | null)[] = [null, null];
  private passFbos: (WebGLFramebuffer | null)[] = [null, null];
  private passSize = { width: 0, height: 0 };
  /** Context generation our GPU resources belong to (see context loss handling). */
  private contextGen = -1;

  static create(): CutGpuRenderer {
    const renderer = new CutGpuRenderer();
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
   * loss, so registerProgram recompiles, and the textures/FBOs are
   * recreated.
   */
  private ensureResources(): void {
    const gen = getContextGeneration();
    if (this.contextGen === gen && this.inputTexture) return;

    if (!hasProgram(P0)) registerProgram(P0, CUT_PASS0_VERTEX, CUT_PASS0_FRAGMENT, P0_UNIFORMS);
    if (!hasProgram(P1)) registerProgram(P1, CUT_PASS1_VERTEX, CUT_PASS1_FRAGMENT, P1_UNIFORMS);
    if (!hasProgram(P2)) registerProgram(P2, CUT_PASS2_VERTEX, CUT_PASS2_FRAGMENT, P2_UNIFORMS);

    const { gl } = getContext();

    // The data textures must be NEAREST + CLAMP_TO_EDGE: the algorithm's
    // bit-packing depends on un-filtered 8-bit fetches, and the edge walk
    // relies on clamped over-reads at the borders.
    this.inputTexture = createTexture('nearest');
    this.inputSize = { width: 0, height: 0 };

    for (let i = 0; i < 2; i++) {
      this.passTextures[i] = createTexture('nearest');
      const fbo = gl.createFramebuffer();
      if (!fbo) throw new Error('Failed to create CUT3 pass framebuffer');
      this.passFbos[i] = fbo;
    }
    this.passSize = { width: 0, height: 0 };

    this.contextGen = gen;
  }

  /** (Re)allocates the two intermediate render targets at input size. */
  private ensurePassTargets(width: number, height: number): void {
    if (this.passSize.width === width && this.passSize.height === height) return;
    const { gl } = getContext();

    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.passTextures[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.passFbos[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.passTextures[i], 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`CUT3 pass target incomplete (status 0x${status.toString(16)}) at ${width}x${height}`);
      }
    }

    this.passSize = { width, height };
  }

  isReady(): boolean {
    return this.initialized && isContextReady();
  }

  /**
   * Submit the three passes. Shared by all output paths.
   * Returns the output dimensions.
   */
  private submit(
    input: RenderSource,
    options: CutOptions,
    target: RenderTarget
  ): { outWidth: number; outHeight: number } {
    if (!this.initialized) throw new Error('Renderer not initialized');
    this.ensureResources();

    const { gl } = getContext();

    const width = input.width;
    const height = input.height;
    const opts = resolveCutOptions(options);

    const outWidth = width * opts.scale;
    const outHeight = height * opts.scale;

    // Fail fast with a clear message instead of letting an oversized
    // allocation OOM the GPU or lose the context. The input-sized
    // intermediates must fit too.
    assertOutputSize(width, height);
    assertOutputSize(outWidth, outHeight);

    // Derived pass-1 constants. floor() on the half distance reproduces the
    // upstream *integer* division in
    //   MAX_DISTANCE = STEP * float(HARD_EDGES_SEARCH_MAX_DISTANCE / 2) + HSTEP
    const d = opts.hardEdgesSearchMaxDistance;
    const step = 0.5 / d;
    const hstep = step * 0.5;
    const maxDoubleDistance = d * step;
    const maxDistance = step * Math.floor(d / 2) + hstep;
    const blendDiffInv = 1.0 / (opts.blendMaxContrastEdge - opts.blendMinContrastEdge);

    // Upload input (raw RGBA bytes, ImageData, or ImageBitmap - the latter
    // is uploaded by the browser directly, often without a CPU copy).
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
    const sameSize = this.inputSize.width === width && this.inputSize.height === height;
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
    if (!sameSize) this.inputSize = { width, height };

    this.ensurePassTargets(width, height);

    // ---- Pass 0: input -> pattern/soft-edge data (input-sized) ----
    {
      const { program, uniforms } = getProgram(P0);
      useProgram(program);
      gl.uniform1i(uniforms.get('uTex0')!, 0);
      gl.uniform2f(uniforms.get('uTextureSize')!, width, height);
      gl.uniform1f(uniforms.get('uSearchMaxError')!, opts.hardEdgesSearchMaxError);
      gl.uniform1f(uniforms.get('uEdgeUseFastLuma')!, opts.edgeUseFastLuma ? 1.0 : 0.0);
      gl.uniform1f(uniforms.get('uSoftEdgesSharpening')!, opts.softEdgesSharpening ? 1.0 : 0.0);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.passFbos[0]);
      gl.viewport(0, 0, width, height);
      clear();
      draw();
    }

    // ---- Pass 1: edge search (input-sized) ----
    {
      const { program, uniforms } = getProgram(P1);
      useProgram(program);
      gl.uniform1i(uniforms.get('uPreviousPass')!, 0);
      gl.uniform2f(uniforms.get('uTextureSize')!, width, height);
      gl.uniform1f(uniforms.get('uStep')!, step);
      gl.uniform1f(uniforms.get('uHstep')!, hstep);
      gl.uniform1f(uniforms.get('uMaxDoubleDistance')!, maxDoubleDistance);
      gl.uniform1f(uniforms.get('uMaxDistance')!, maxDistance);
      gl.uniform1i(uniforms.get('uSearchMaxDistance')!, d);
      gl.uniform1f(uniforms.get('uSoftEdgesSharpening')!, opts.softEdgesSharpening ? 1.0 : 0.0);
      gl.uniform1f(uniforms.get('uSoftEdgesSharpeningAmount')!, opts.softEdgesSharpeningAmount);

      gl.bindTexture(gl.TEXTURE_2D, this.passTextures[0]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.passFbos[1]);
      gl.viewport(0, 0, width, height);
      clear();
      draw();
    }

    // ---- Pass 2: interpolation to the output target ----
    {
      const { program, uniforms } = getProgram(P2);
      useProgram(program);
      gl.uniform1i(uniforms.get('uTex0')!, 0);
      gl.uniform1i(uniforms.get('uPreviousPass')!, 1);
      gl.uniform2f(uniforms.get('uTextureSize')!, width, height);
      gl.uniform1f(uniforms.get('uUseDynamicBlend')!, opts.useDynamicBlend ? 1.0 : 0.0);
      gl.uniform1f(uniforms.get('uBlendMinContrastEdge')!, opts.blendMinContrastEdge);
      gl.uniform1f(uniforms.get('uBlendDiffInv')!, blendDiffInv);
      gl.uniform1f(uniforms.get('uBlendMinSharpness')!, opts.blendMinSharpness);
      gl.uniform1f(uniforms.get('uBlendMaxSharpness')!, opts.blendMaxSharpness);
      gl.uniform1f(uniforms.get('uStaticBlendSharpness')!, opts.staticBlendSharpness);
      gl.uniform1f(uniforms.get('uFlipY')!, target === 'canvas' ? 1.0 : 0.0);

      gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.passTextures[1]);
      gl.activeTexture(gl.TEXTURE0);

      bindRenderTarget(outWidth, outHeight, target);
      clear();
      draw();
    }

    return { outWidth, outHeight };
  }

  render(input: RenderSource, options: CutOptions = {}): ImageOutput {
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
    options: CutOptions = {},
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
  renderToBitmap(input: RenderSource, options: CutOptions = {}): Promise<ImageBitmap> {
    return runExclusive(() => {
      this.submit(input, options, 'canvas');
      return transferBitmap();
    });
  }

  dispose(): void {
    if (this.initialized) {
      const { gl } = getContext();
      if (this.inputTexture) {
        deleteTexture(this.inputTexture);
        this.inputTexture = null;
      }
      for (let i = 0; i < 2; i++) {
        const tex = this.passTextures[i];
        if (tex) deleteTexture(tex);
        this.passTextures[i] = null;
        const fbo = this.passFbos[i];
        if (fbo && !gl.isContextLost()) gl.deleteFramebuffer(fbo);
        this.passFbos[i] = null;
      }
      this.inputSize = { width: 0, height: 0 };
      this.passSize = { width: 0, height: 0 };
      releaseContext();
      this.initialized = false;
    }
  }
}

/**
 * Presets. 'default' is the upstream demo configuration; the others are
 * reasonable variations of the documented parameters.
 */
export const CUT_PRESETS: Record<string, Partial<CutOptions>> = {
  default: {},
  /** Crisper edges: full sharpness range, stricter hard-edge acceptance. */
  sharp: {
    blendMaxSharpness: 1.0,
    blendMaxContrastEdge: 0.2,
    hardEdgesSearchMaxError: 0.2,
  },
  /** Softer look: gentler sharpening, wider contrast ramp. */
  smooth: {
    blendMaxSharpness: 0.5,
    blendMaxContrastEdge: 0.5,
    softEdgesSharpeningAmount: 0.5,
  },
  /** Resolves shallower edge angles (more pass-1 work). */
  precise: {
    hardEdgesSearchMaxDistance: 8,
  },
};
