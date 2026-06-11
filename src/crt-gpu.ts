/**
 * CRT GPU Renderer using WebGL2
 * Uses shared GPU context for optimal resource usage
 */

import type { CrtOptions, ImageOutput, Renderer, RenderSource } from './types.js';
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
  createTexture,
  deleteTexture,
  readPixels,
  readPixelsAsync,
  draw,
} from './gpu-context.js';
import { isImageBitmap } from './gpu-context.js';
import type { RenderTarget } from './gpu-context.js';

const PROGRAM_ID = 'crt';

// uFlipY selects the framebuffer orientation:
//   0.0 -> rows come out top-down via readPixels (pixel-array output)
//   1.0 -> image is upright when the framebuffer is presented directly
//          (canvas / ImageBitmap output)
// All effect math operates in input-texture space, so flipping the sampled
// coordinate flips the whole render consistently.
const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 position;
uniform float uFlipY;
out vec2 vUv;

void main() {
    vUv = position * 0.5 + 0.5;
    vUv.y = mix(vUv.y, 1.0 - vUv.y, uFlipY);
    gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec2 uWarp;
uniform float uScanHardness;
uniform float uScanOpacity;
uniform float uMaskOpacity;
uniform int uEnableWarp;
uniform int uEnableScanlines;
uniform int uEnableMask;

in vec2 vUv;
out vec4 outColor;

vec3 toLinear(vec3 c) { return c * c; }
vec3 toSrgb(vec3 c) { return sqrt(c); }

vec2 warp(vec2 uv) {
    if (uEnableWarp == 0) return uv;
    vec2 dc = abs(0.5 - uv);
    vec2 dc2 = dc * dc;
    uv.x -= 0.5; uv.x *= 1.0 + (dc2.y * (0.3 * uWarp.x)); uv.x += 0.5;
    uv.y -= 0.5; uv.y *= 1.0 + (dc2.x * (0.4 * uWarp.y)); uv.y += 0.5;
    return uv;
}

float scanline(float y, float sourceHeight) {
    if (uEnableScanlines == 0) return 1.0;
    float v = fract(y * sourceHeight);
    float d = abs(v - 0.5);
    float line = exp(d * d * uScanHardness);
    return mix(1.0, line, uScanOpacity);
}

vec3 mask(vec2 pos) {
    if (uEnableMask == 0) return vec3(1.0);
    float x = fract(pos.x / 6.0);
    vec3 m = vec3(1.0);
    float step1 = 0.333;
    float step2 = 0.666;
    
    m.r = step(0.0, x) - step(step1, x);
    m.g = step(step1, x) - step(step2, x);
    m.b = step(step2, x) - step(1.0, x);
    
    return mix(vec3(1.0), m, uMaskOpacity);
}

void main() {
    vec2 uv = warp(vUv);
    
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        outColor = vec4(0.0); 
        return;
    }

    vec4 texSample = texture(uTex, uv);
    if (texSample.a == 0.0) {
        outColor = vec4(0.0);
        return;
    }

    vec3 linearColor = toLinear(texSample.rgb);
    ivec2 texSize = textureSize(uTex, 0);
    
    float luma = dot(linearColor, vec3(0.299, 0.587, 0.114));
    float bloom = luma * 0.7;

    float scan = scanline(uv.y, float(texSize.y));
    vec3 m = mask(gl_FragCoord.xy);
    
    vec3 effects = m * scan;
    vec3 finalRGB = linearColor * mix(effects, vec3(1.0), bloom);

    outColor = vec4(toSrgb(finalRGB), texSample.a);
}`;

const UNIFORMS = [
  'uTex', 'uRes', 'uWarp', 'uScanHardness', 'uScanOpacity',
  'uMaskOpacity', 'uEnableWarp', 'uEnableScanlines', 'uEnableMask', 'uFlipY'
];

/** CRT GPU Renderer */
export class CrtGpuRenderer implements Renderer<CrtOptions> {
  private initialized = false;
  private texture: WebGLTexture | null = null;
  private textureSize = { width: 0, height: 0 };
  /** Context generation our GPU resources belong to (see context loss handling). */
  private contextGen = -1;

  static create(): CrtGpuRenderer {
    const renderer = new CrtGpuRenderer();
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

    if (!hasProgram(PROGRAM_ID)) {
      registerProgram(PROGRAM_ID, VERTEX_SHADER, FRAGMENT_SHADER, UNIFORMS);
    }

    // CRT uses LINEAR filtering
    this.texture = createTexture('linear');
    this.textureSize = { width: 0, height: 0 };
    this.contextGen = gen;
  }

  isReady(): boolean {
    return this.initialized && isContextReady();
  }

  /** Submit the draw call (shared by all output paths). Returns output size. */
  private submit(
    input: RenderSource,
    options: CrtOptions,
    target: RenderTarget
  ): { outWidth: number; outHeight: number } {
    if (!this.initialized) throw new Error('Renderer not initialized');
    this.ensureResources();

    const { gl } = getContext();
    const { program, uniforms } = getProgram(PROGRAM_ID);

    const width = input.width;
    const height = input.height;

    const scale = Math.min(32, Math.max(2, options.scale ?? 3));
    const outWidth = width * scale;
    const outHeight = height * scale;

    // Fail fast with a clear message instead of letting an oversized
    // allocation OOM the GPU or lose the context.
    assertOutputSize(outWidth, outHeight);

    useProgram(program);
    bindRenderTarget(outWidth, outHeight, target);

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

    // Set uniforms
    gl.uniform1i(uniforms.get('uTex')!, 0);
    gl.uniform2f(uniforms.get('uRes')!, outWidth, outHeight);
    gl.uniform2f(uniforms.get('uWarp')!, options.warpX ?? 0.015, options.warpY ?? 0.02);
    gl.uniform1f(uniforms.get('uScanHardness')!, options.scanHardness ?? -4.0);
    gl.uniform1f(uniforms.get('uScanOpacity')!, options.scanOpacity ?? 0.5);
    gl.uniform1f(uniforms.get('uMaskOpacity')!, options.maskOpacity ?? 0.3);
    gl.uniform1i(uniforms.get('uEnableWarp')!, options.enableWarp !== false ? 1 : 0);
    gl.uniform1i(uniforms.get('uEnableScanlines')!, options.enableScanlines !== false ? 1 : 0);
    gl.uniform1i(uniforms.get('uEnableMask')!, options.enableMask !== false ? 1 : 0);
    gl.uniform1f(uniforms.get('uFlipY')!, target === 'canvas' ? 1.0 : 0.0);

    draw();

    return { outWidth, outHeight };
  }

  render(input: RenderSource, options: CrtOptions = {}): ImageOutput {
    const { outWidth, outHeight } = this.submit(input, options, 'texture');
    return {
      data: readPixels(outWidth, outHeight),
      width: outWidth,
      height: outHeight,
    };
  }

  /**
   * Non-blocking variant using asynchronous PBO readback. Concurrent calls
   * are safe: GPU work is serialized internally.
   */
  renderAsync(
    input: RenderSource,
    options: CrtOptions = {},
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
  renderToBitmap(input: RenderSource, options: CrtOptions = {}): Promise<ImageBitmap> {
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

export const CRT_PRESETS: Record<string, Partial<CrtOptions>> = {
  default: {},
  authentic: { warpX: 0.02, warpY: 0.025, scanHardness: -6.0, scanOpacity: 0.6, maskOpacity: 0.4 },
  subtle: { warpX: 0.008, warpY: 0.01, scanHardness: -3.0, scanOpacity: 0.3, maskOpacity: 0.15 },
  flat: { warpX: 0, warpY: 0, enableWarp: false, scanHardness: -4.0, scanOpacity: 0.5, maskOpacity: 0.3 },
};
