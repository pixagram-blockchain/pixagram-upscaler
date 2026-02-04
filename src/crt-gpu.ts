/**
 * CRT GPU Renderer using WebGL2
 * Uses shared GPU context for optimal resource usage
 */

import type { CrtOptions, ImageInput, ImageOutput, Renderer } from './types.js';
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
} from './gpu-context.js';

const PROGRAM_ID = 'crt';

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 position;
out vec2 vUv;

void main() {
    vUv = position * 0.5 + 0.5;
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
  'uMaskOpacity', 'uEnableWarp', 'uEnableScanlines', 'uEnableMask'
];

/** CRT GPU Renderer */
export class CrtGpuRenderer implements Renderer<CrtOptions> {
  private initialized = false;
  private texture: WebGLTexture | null = null;
  private textureSize = { width: 0, height: 0 };

  static create(): CrtGpuRenderer {
    const renderer = new CrtGpuRenderer();
    renderer.init();
    return renderer;
  }

  private init(): void {
    if (this.initialized) return;

    acquireContext();
    
    // Register program if not already registered
    if (!hasProgram(PROGRAM_ID)) {
      registerProgram(PROGRAM_ID, VERTEX_SHADER, FRAGMENT_SHADER, UNIFORMS);
    }

    // Create dedicated texture (CRT uses LINEAR filtering)
    this.texture = createTexture('linear');
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized && isContextReady();
  }

  render(input: ImageInput | ImageData, options: CrtOptions = {}): ImageOutput {
    if (!this.initialized || !this.texture) throw new Error('Renderer not initialized');

    const { gl } = getContext();
    const { program, uniforms } = getProgram(PROGRAM_ID);

    const data = input instanceof ImageData ? input.data : input.data;
    const width = input.width;
    const height = input.height;

    const scale = Math.min(32, Math.max(2, options.scale ?? 3));
    const outWidth = width * scale;
    const outHeight = height * scale;

    gl.useProgram(program);

    // Ensure canvas is large enough
    ensureCanvasSize(outWidth, outHeight);
    setViewport(outWidth, outHeight);

    // Upload texture
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.textureSize.width !== width || this.textureSize.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.textureSize = { width, height };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

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
