/**
 * Hexagonal GPU Renderer using WebGL2
 * Optimized with Shared Context Management and Smart Resizing
 */

import type { HexOptions, HexOrientation, ImageInput, ImageOutput, Renderer } from './types.js';

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
uniform vec2 uOutputRes;
uniform vec2 uInputRes;
uniform float uScale;
uniform int uOrientation;
uniform int uDrawBorders;
uniform vec4 uBorderColor;
uniform float uBorderThickness;
uniform vec4 uBackgroundColor;

in vec2 vUv;
out vec4 outColor;

const float SQRT3 = 1.732050808;

vec2 hexRound(vec2 uv) {
    float q = uv.x;
    float r = uv.y;
    float s = -q - r;

    float qi = round(q);
    float ri = round(r);
    float si = round(s);

    float q_diff = abs(qi - q);
    float r_diff = abs(ri - r);
    float s_diff = abs(si - s);

    if (q_diff > r_diff && q_diff > s_diff) {
        qi = -ri - si;
    } else if (r_diff > s_diff) {
        ri = -qi - si;
    }
    
    return vec2(qi, ri);
}

vec2 pixelToHex(vec2 pos, float scale, int orientation) {
    vec2 axial;
    if (orientation == 0) {
        float q = (2.0/3.0 * pos.x) / scale;
        float r = (-1.0/3.0 * pos.x + SQRT3/3.0 * pos.y) / scale;
        axial = hexRound(vec2(q, r));
        float col = axial.x;
        float row = axial.y + (axial.x - mod(axial.x, 2.0)) / 2.0;
        if (mod(axial.x, 2.0) != 0.0 && axial.x < 0.0) row -= 1.0;
        return vec2(col, row);
    } else {
        float q = (SQRT3/3.0 * pos.x - 1.0/3.0 * pos.y) / scale;
        float r = (2.0/3.0 * pos.y) / scale;
        axial = hexRound(vec2(q, r));
        float col = axial.x + (axial.y - mod(axial.y, 2.0)) / 2.0;
        float row = axial.y;
        if (mod(axial.y, 2.0) != 0.0 && axial.y < 0.0) col -= 1.0;
        return vec2(col, row);
    }
}

void main() {
    vec2 pixelPos = vUv * uOutputRes;
    vec2 offset;
    if (uOrientation == 0) {
        offset = vec2(uScale, uScale * SQRT3 * 0.5);
    } else {
        offset = vec2(uScale * SQRT3 * 0.5, uScale);
    }

    vec2 adjustedPos = pixelPos - offset;
    vec2 hexCoord = pixelToHex(adjustedPos, uScale, uOrientation);
    
    if (hexCoord.x < 0.0 || hexCoord.y < 0.0 || 
        hexCoord.x >= uInputRes.x || hexCoord.y >= uInputRes.y) {
        outColor = uBackgroundColor;
        return;
    }
    
    if (uDrawBorders == 1 && uBorderThickness > 0.0) {
        float t = uBorderThickness;
        bool isBorder = false;
        
        for (float dy = -t; dy <= t; dy += 1.0) {
            for (float dx = -t; dx <= t; dx += 1.0) {
                if (dx == 0.0 && dy == 0.0) continue;
                if (isBorder) break;
                vec2 neighborHex = pixelToHex(pixelPos + vec2(dx, dy) - offset, uScale, uOrientation);
                if (neighborHex != hexCoord) isBorder = true;
            }
        }
        if (isBorder) {
            outColor = uBorderColor;
            return;
        }
    }
    
    vec2 texCoord = (hexCoord + 0.5) / uInputRes;
    outColor = texture(uTex, texCoord);
}`;

function parseColor(color: string | number | undefined, defaultColor: [number, number, number, number]): [number, number, number, number] {
  if (color === undefined) return defaultColor;
  if (typeof color === 'number') {
    return [((color >> 24) & 0xFF) / 255, ((color >> 16) & 0xFF) / 255, ((color >> 8) & 0xFF) / 255, (color & 0xFF) / 255];
  }
  if (color === 'transparent') return [0, 0, 0, 0];
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 6) {
      return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, 1];
    }
    if (hex.length === 8) {
      return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, parseInt(hex.slice(6, 8), 16) / 255];
    }
  }
  return defaultColor;
}

export function hexGetDimensions(srcWidth: number, srcHeight: number, scale: number, orientation: HexOrientation = 'flat-top'): { width: number; height: number } {
  const SQRT3 = 1.732050808;
  if (orientation === 'flat-top') {
    const hSpacing = scale * 1.5;
    const vSpacing = scale * SQRT3;
    const cellWidth = scale * 2;
    const cellHeight = scale * SQRT3;
    return {
      width: Math.ceil((srcWidth - 1) * hSpacing + cellWidth),
      height: Math.ceil((srcHeight - 1) * vSpacing + cellHeight + (scale * SQRT3 * 0.5)),
    };
  } else {
    const hSpacing = scale * SQRT3;
    const vSpacing = scale * 1.5;
    const cellWidth = scale * SQRT3;
    const cellHeight = scale * 2;
    return {
      width: Math.ceil((srcWidth - 1) * hSpacing + cellWidth + (scale * SQRT3 * 0.5)),
      height: Math.ceil((srcHeight - 1) * vSpacing + cellHeight),
    };
  }
}

interface HexResources {
  gl: WebGL2RenderingContext;
  canvas: OffscreenCanvas;
  program: WebGLProgram;
  texture: WebGLTexture;
  uniforms: Record<string, WebGLUniformLocation | null>;
  capacity: { width: number; height: number };
  refCount: number;
}

export class HexGpuRenderer implements Renderer<HexOptions> {
  private static resources: HexResources | null = null;
  private initialized = false;

  static create(): HexGpuRenderer {
    const renderer = new HexGpuRenderer();
    renderer.init();
    return renderer;
  }

  private init(): void {
    if (this.initialized) return;

    if (!HexGpuRenderer.resources) {
        if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas not supported');

        const canvas = new OffscreenCanvas(1, 1);
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
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(program));

        gl.useProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        const uniforms = {
            uTex: gl.getUniformLocation(program, 'uTex'),
            uOutputRes: gl.getUniformLocation(program, 'uOutputRes'),
            uInputRes: gl.getUniformLocation(program, 'uInputRes'),
            uScale: gl.getUniformLocation(program, 'uScale'),
            uOrientation: gl.getUniformLocation(program, 'uOrientation'),
            uDrawBorders: gl.getUniformLocation(program, 'uDrawBorders'),
            uBorderColor: gl.getUniformLocation(program, 'uBorderColor'),
            uBorderThickness: gl.getUniformLocation(program, 'uBorderThickness'),
            uBackgroundColor: gl.getUniformLocation(program, 'uBackgroundColor'),
        };
        
        gl.uniform1i(uniforms.uTex, 0);
        
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        HexGpuRenderer.resources = {
            gl, canvas, program, texture, uniforms,
            capacity: { width: 0, height: 0 },
            refCount: 0
        };
    }

    HexGpuRenderer.resources.refCount++;
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
    return this.initialized && !!HexGpuRenderer.resources && !HexGpuRenderer.resources.gl.isContextLost();
  }

  render(input: ImageInput | ImageData, options: HexOptions = {}): ImageOutput {
    if (!this.initialized || !HexGpuRenderer.resources) throw new Error('Renderer not initialized');
    
    const { gl, canvas, uniforms, texture, capacity } = HexGpuRenderer.resources;
    if (gl.isContextLost()) throw new Error('WebGL context lost');

    const data = input instanceof ImageData ? input.data : input.data;
    const width = input.width;
    const height = input.height;

    const scale = Math.min(32, Math.max(2, options.scale ?? 16));
    const orientation: HexOrientation = options.orientation ?? 'flat-top';
    const { width: outWidth, height: outHeight } = hexGetDimensions(width, height, scale, orientation);

    gl.useProgram(HexGpuRenderer.resources.program);

    // Smart Resize
    if (outWidth > capacity.width || outHeight > capacity.height) {
        canvas.width = Math.max(capacity.width, outWidth);
        canvas.height = Math.max(capacity.height, outHeight);
        HexGpuRenderer.resources.capacity = { width: canvas.width, height: canvas.height };
    }
    gl.viewport(0, 0, outWidth, outHeight);

    gl.uniform2f(uniforms.uOutputRes, outWidth, outHeight);
    gl.uniform2f(uniforms.uInputRes, width, height);
    gl.uniform1f(uniforms.uScale, scale);
    gl.uniform1i(uniforms.uOrientation, orientation === 'flat-top' ? 0 : 1);
    gl.uniform1i(uniforms.uDrawBorders, options.drawBorders ? 1 : 0);
    gl.uniform1f(uniforms.uBorderThickness, options.borderThickness ?? 1);

    const borderColor = parseColor(options.borderColor, [0.16, 0.16, 0.16, 1]);
    gl.uniform4f(uniforms.uBorderColor, ...borderColor);
    const bgColor = parseColor(options.backgroundColor, [0, 0, 0, 0]);
    gl.uniform4f(uniforms.uBackgroundColor, ...bgColor);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pixels = new Uint8ClampedArray(outWidth * outHeight * 4);
    gl.readPixels(0, 0, outWidth, outHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    return { data: pixels, width: outWidth, height: outHeight };
  }

  dispose(): void {
    if (this.initialized && HexGpuRenderer.resources) {
        HexGpuRenderer.resources.refCount--;
        if (HexGpuRenderer.resources.refCount <= 0) {
            const { gl, texture, program } = HexGpuRenderer.resources;
            gl.deleteTexture(texture);
            gl.deleteProgram(program);
            HexGpuRenderer.resources = null;
        }
        this.initialized = false;
    }
  }
}

export const HEX_PRESETS: Record<string, Partial<HexOptions>> = {
  default: {},
  bordered: { drawBorders: true, borderColor: '#282828', borderThickness: 1 },
  pointy: { orientation: 'pointy-top', drawBorders: false },
};
