/**
 * xBRZ GPU Renderer using WebGL2
 * Uses shared GPU context for optimal resource usage
 * 
 * High-performance xBRZ pixel art scaling using fragment shaders.
 * Based on Hyllian's xBRZ algorithm with RGBA alpha support.
 */

import type { ImageInput, ImageOutput, Renderer, XbrzOptions } from './types.js';
import {
  acquireContext,
  releaseContext,
  isContextReady,
  getContext,
  registerProgram,
  hasProgram,
  getProgram,
  ensureCanvasSize,
  setViewport,
  createTexture,
  deleteTexture,
  readPixels,
  draw,
  clear,
} from './gpu-context.js';
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
  private currentScale = 0;

  static create(): XbrzGpuRenderer {
    const renderer = new XbrzGpuRenderer();
    renderer.init();
    return renderer;
  }

  private init(): void {
    if (this.initialized) return;

    acquireContext();

    // Register programs for each scale factor
    for (const scale of SCALES) {
      const programId = `${PROGRAM_PREFIX}_${scale}x`;
      if (!hasProgram(programId)) {
        registerProgram(programId, XBRZ_VERTEX_SHADER, SHADERS[scale], UNIFORMS);
      }
    }

    // xBRZ uses NEAREST filtering
    this.texture = createTexture('nearest');
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized && isContextReady();
  }

  render(input: ImageInput | ImageData, options: XbrzOptions = {}): ImageOutput {
    if (!this.initialized || !this.texture) throw new Error('Renderer not initialized');

    const { gl } = getContext();

    const data = input instanceof ImageData ? input.data : input.data;
    const width = input.width;
    const height = input.height;

    const scale = Math.min(6, Math.max(2, options.scale ?? 2)) as 2 | 3 | 4 | 5 | 6;
    const outWidth = width * scale;
    const outHeight = height * scale;

    const programId = `${PROGRAM_PREFIX}_${scale}x`;
    const { program, uniforms } = getProgram(programId);

    // Only switch program if scale changed
    if (this.currentScale !== scale) {
      gl.useProgram(program);
      gl.uniform1i(uniforms.get('uTex')!, 0);
      this.currentScale = scale;
    }

    ensureCanvasSize(outWidth, outHeight);
    setViewport(outWidth, outHeight);

    // Set uniforms
    gl.uniform2f(uniforms.get('uInputRes')!, width, height);
    gl.uniform1f(uniforms.get('uCenterDirectionBias')!, options.centerDirectionBias ?? 4.0);
    gl.uniform1f(uniforms.get('uEqualColorTolerance')!, (options.equalColorTolerance ?? 30) / 255.0);
    gl.uniform1f(uniforms.get('uSteepDirectionThreshold')!, options.steepDirectionThreshold ?? 2.2);
    gl.uniform1f(uniforms.get('uDominantDirectionThreshold')!, options.dominantDirectionThreshold ?? 3.6);

    // Upload texture with smart sub-image update
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.textureSize.width !== width || this.textureSize.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.textureSize = { width, height };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    clear();
    draw();

    return {
      data: readPixels(outWidth, outHeight),
      width: outWidth,
      height: outHeight,
    };
  }

  dispose(): void {
    if (this.initialized) {
      if (this.texture) {
        deleteTexture(this.texture);
        this.texture = null;
      }
      this.textureSize = { width: 0, height: 0 };
      this.currentScale = 0;
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
