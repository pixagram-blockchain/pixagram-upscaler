/**
 * CRT GPU Renderer using WebGL2
 * * Optimized with Shared Context Management and Smart Resizing
 */

import type { CrtOptions, ImageInput, ImageOutput, Renderer } from './types.js';

// Vertex shader
const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 position;
out vec2 vUv;

void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}`;

// Fragment shader
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

/** Shared resources interface */
interface CrtResources {
  gl: WebGL2RenderingContext;
  canvas: OffscreenCanvas;
  program: WebGLProgram;
  texture: WebGLTexture;
  uniforms: Record<string, WebGLUniformLocation | null>;
  capacity: { width: number; height: number }; // Current max dimensions
  refCount: number;
}

/** CRT GPU Renderer */
export class CrtGpuRenderer implements Renderer<CrtOptions> {
  // Static shared resources to prevent context limits
  private static resources: CrtResources | null = null;
  
  private initialized = false;

  static create(): CrtGpuRenderer {
    const renderer = new CrtGpuRenderer();
    renderer.init();
    return renderer;
  }

  private init(): void {
    if (this.initialized) return;

    // Initialize shared resources if they don't exist
    if (!CrtGpuRenderer.resources) {
      if (typeof OffscreenCanvas === 'undefined') {
        throw new Error('OffscreenCanvas not supported');
      }

      const canvas = new OffscreenCanvas(256, 256); // Start small
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        desynchronized: true,
        powerPreference: 'high-performance',
        antialias: false,
      });

      if (!gl) throw new Error('WebGL2 not supported');

      const vs = this.createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = this.createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('Shader program link failed: ' + gl.getProgramInfoLog(program));
      }

      gl.useProgram(program);
      gl.deleteShader(vs); // Clean up shaders after link
      gl.deleteShader(fs);

      const uniforms = {
        uTex: gl.getUniformLocation(program, 'uTex'),
        uRes: gl.getUniformLocation(program, 'uRes'),
        uWarp: gl.getUniformLocation(program, 'uWarp'),
        uScanHardness: gl.getUniformLocation(program, 'uScanHardness'),
        uScanOpacity: gl.getUniformLocation(program, 'uScanOpacity'),
        uMaskOpacity: gl.getUniformLocation(program, 'uMaskOpacity'),
        uEnableWarp: gl.getUniformLocation(program, 'uEnableWarp'),
        uEnableScanlines: gl.getUniformLocation(program, 'uEnableScanlines'),
        uEnableMask: gl.getUniformLocation(program, 'uEnableMask'),
      };

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      CrtGpuRenderer.resources = {
        gl,
        canvas,
        program,
        texture,
        uniforms,
        capacity: { width: 0, height: 0 },
        refCount: 0
      };
    }

    CrtGpuRenderer.resources.refCount++;
    this.initialized = true;
  }

  private createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile failed: ' + info);
    }
    return shader;
  }

  isReady(): boolean {
    return this.initialized && CrtGpuRenderer.resources !== null && !CrtGpuRenderer.resources.gl.isContextLost();
  }

  render(input: ImageInput | ImageData, options: CrtOptions = {}): ImageOutput {
    if (!this.initialized || !CrtGpuRenderer.resources) throw new Error('Renderer not initialized');

    const { gl, canvas, uniforms, texture, capacity } = CrtGpuRenderer.resources;
    
    if (gl.isContextLost()) throw new Error('WebGL context lost');

    const data = input instanceof ImageData ? input.data : input.data;
    const width = input.width;
    const height = input.height;

    const scale = Math.min(32, Math.max(2, options.scale ?? 3));
    const outWidth = width * scale;
    const outHeight = height * scale;

    gl.useProgram(CrtGpuRenderer.resources.program);

    // 1. Smart Resize: Only grow canvas if output is larger than current capacity
    if (outWidth > capacity.width || outHeight > capacity.height) {
        canvas.width = Math.max(capacity.width, outWidth);
        canvas.height = Math.max(capacity.height, outHeight);
        CrtGpuRenderer.resources.capacity = { width: canvas.width, height: canvas.height };
    }
    
    // Always update viewport to the actual desired output size (might be smaller than canvas)
    gl.viewport(0, 0, outWidth, outHeight);

    // 2. Texture Upload: Use texSubImage2D if texture capacity allows, otherwise reallocate
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Since we reuse the texture for varying input sizes, we check input dimensions vs texture capacity.
    // However, input size usually matches texture logic. For simplicity in this shared model,
    // we just reallocate if the input size changes, which is common in single-renderer flow.
    // Optimization: If width/height matches previous render, use SubImage.
    
    // Note: We don't track texture capacity separately from canvas capacity in this simplifiction,
    // but typically input images are smaller. We'll simply reallocate texture storage if dimensions change.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);

    // Update Uniforms
    gl.uniform2f(uniforms.uRes, outWidth, outHeight);
    gl.uniform2f(uniforms.uWarp, options.warpX ?? 0.015, options.warpY ?? 0.02);
    gl.uniform1f(uniforms.uScanHardness, options.scanHardness ?? -4.0);
    gl.uniform1f(uniforms.uScanOpacity, options.scanOpacity ?? 0.5);
    gl.uniform1f(uniforms.uMaskOpacity, options.maskOpacity ?? 0.3);
    gl.uniform1i(uniforms.uEnableWarp, options.enableWarp !== false ? 1 : 0);
    gl.uniform1i(uniforms.uEnableScanlines, options.enableScanlines !== false ? 1 : 0);
    gl.uniform1i(uniforms.uEnableMask, options.enableMask !== false ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Read pixels from the viewport area only
    const pixels = new Uint8ClampedArray(outWidth * outHeight * 4);
    gl.readPixels(0, 0, outWidth, outHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    return {
      data: pixels,
      width: outWidth,
      height: outHeight,
    };
  }

  dispose(): void {
    if (this.initialized && CrtGpuRenderer.resources) {
      CrtGpuRenderer.resources.refCount--;
      
      // Only destroy WebGL context if no one else is using it
      if (CrtGpuRenderer.resources.refCount <= 0) {
        const { gl, texture, program } = CrtGpuRenderer.resources;
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
        // Extensions/Buffers are auto-cleaned by context loss usually, 
        // but strict cleanup helps.
        CrtGpuRenderer.resources = null;
      }
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

