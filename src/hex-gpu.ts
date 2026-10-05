/**
 * Hexagonal GPU Renderer using WebGL2
 * Uses shared GPU context for optimal resource usage
 */

import type { HexOptions, HexOrientation, ImageOutput, Renderer, RenderSource } from './types.js';
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

const PROGRAM_ID = 'hex';

// uFlipY: 0.0 -> orientation for top-down readPixels output;
//         1.0 -> orientation for direct canvas / ImageBitmap presentation.
const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 position;
uniform float uFlipY;
out vec2 vUv;

void main() {
    vUv = position * 0.5 + 0.5;
    vUv.y = mix(vUv.y, 1.0 - vUv.y, uFlipY);
    gl_Position = vec4(position, 0.0, 1.0);
}`;

// Border detection uses an analytical hexagon edge-distance test (O(1)),
// matching the WASM implementation, instead of an O(thickness^2) neighbour
// sampling loop. Fractional axial coordinates are computed once and reused
// for both the grid lookup and the border test.
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

vec2 hexRound(vec2 axial) {
    float q = axial.x;
    float r = axial.y;
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

// Fractional axial coordinates for a pixel (offset already subtracted).
vec2 hexAxial(vec2 pos, float scale, int orientation) {
    if (orientation == 0) {
        float q = (2.0/3.0 * pos.x) / scale;
        float r = (-1.0/3.0 * pos.x + SQRT3/3.0 * pos.y) / scale;
        return vec2(q, r);
    } else {
        float q = (SQRT3/3.0 * pos.x - 1.0/3.0 * pos.y) / scale;
        float r = (2.0/3.0 * pos.y) / scale;
        return vec2(q, r);
    }
}

// Rounded axial (cube) -> offset grid (col, row).
vec2 gridFromRounded(vec2 a, int orientation) {
    if (orientation == 0) {
        float col = a.x;
        float row = a.y + (a.x - mod(a.x, 2.0)) / 2.0;
        if (mod(a.x, 2.0) != 0.0 && a.x < 0.0) row -= 1.0;
        return vec2(col, row);
    } else {
        float col = a.x + (a.y - mod(a.y, 2.0)) / 2.0;
        float row = a.y;
        if (mod(a.y, 2.0) != 0.0 && a.y < 0.0) col -= 1.0;
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
    vec2 axial = hexAxial(adjustedPos, uScale, uOrientation);
    vec2 rounded = hexRound(axial);
    vec2 hexCoord = gridFromRounded(rounded, uOrientation);

    if (hexCoord.x < 0.0 || hexCoord.y < 0.0 ||
        hexCoord.x >= uInputRes.x || hexCoord.y >= uInputRes.y) {
        outColor = uBackgroundColor;
        return;
    }

    if (uDrawBorders == 1 && uBorderThickness > 0.0) {
        float s = -axial.x - axial.y;
        float cs = -rounded.x - rounded.y;
        float dist = max(max(abs(axial.x - rounded.x), abs(axial.y - rounded.y)), abs(s - cs));
        float thresh = 0.5 - (uBorderThickness * 0.55 / uScale);
        if (dist > thresh) {
            outColor = uBorderColor;
            return;
        }
    }

    vec2 texCoord = (hexCoord + 0.5) / uInputRes;
    outColor = texture(uTex, texCoord);
}`;

const UNIFORMS = [
  'uTex', 'uOutputRes', 'uInputRes', 'uScale', 'uOrientation',
  'uDrawBorders', 'uBorderColor', 'uBorderThickness', 'uBackgroundColor', 'uFlipY'
];

function parseColor(
  color: string | number | undefined,
  defaultColor: [number, number, number, number]
): [number, number, number, number] {
  if (color === undefined) return defaultColor;
  if (typeof color === 'number') {
    return [
      ((color >> 24) & 0xFF) / 255,
      ((color >> 16) & 0xFF) / 255,
      ((color >> 8) & 0xFF) / 255,
      (color & 0xFF) / 255
    ];
  }
  if (color === 'transparent') return [0, 0, 0, 0];
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        1
      ];
    }
    if (hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        parseInt(hex.slice(6, 8), 16) / 255
      ];
    }
  }
  return defaultColor;
}

export function hexGetDimensions(
  srcWidth: number,
  srcHeight: number,
  scale: number,
  orientation: HexOrientation = 'flat-top'
): { width: number; height: number } {
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

/** Hex GPU Renderer */
export class HexGpuRenderer implements Renderer<HexOptions> {
  private initialized = false;
  private texture: WebGLTexture | null = null;
  private textureSize = { width: 0, height: 0 };
  /** Context generation our GPU resources belong to (see context loss handling). */
  private contextGen = -1;

  static create(): HexGpuRenderer {
    const renderer = new HexGpuRenderer();
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

    // Hex uses NEAREST filtering
    this.texture = createTexture('nearest');
    this.textureSize = { width: 0, height: 0 };
    this.contextGen = gen;
  }

  isReady(): boolean {
    return this.initialized && isContextReady();
  }

  /** Submit the draw call (shared by all output paths). Returns output size. */
  private submit(
    input: RenderSource,
    options: HexOptions,
    target: RenderTarget
  ): { outWidth: number; outHeight: number } {
    if (!this.initialized) throw new Error('Renderer not initialized');
    this.ensureResources();

    const { gl } = getContext();
    const { program, uniforms } = getProgram(PROGRAM_ID);

    const width = input.width;
    const height = input.height;

    const scale = Math.min(32, Math.max(2, options.scale ?? 16));
    const orientation: HexOrientation = options.orientation ?? 'flat-top';
    const { width: outWidth, height: outHeight } = hexGetDimensions(width, height, scale, orientation);

    // Fail fast with a clear message instead of letting an oversized
    // allocation OOM the GPU or lose the context. Hex output grows fast:
    // a 256x256 input at scale 32 is ~12000x14000 pixels.
    assertOutputSize(outWidth, outHeight);

    useProgram(program);
    bindRenderTarget(outWidth, outHeight, target);

    // Set uniforms
    gl.uniform1i(uniforms.get('uTex')!, 0);
    gl.uniform2f(uniforms.get('uOutputRes')!, outWidth, outHeight);
    gl.uniform2f(uniforms.get('uInputRes')!, width, height);
    gl.uniform1f(uniforms.get('uScale')!, scale);
    gl.uniform1i(uniforms.get('uOrientation')!, orientation === 'flat-top' ? 0 : 1);
    gl.uniform1i(uniforms.get('uDrawBorders')!, options.drawBorders ? 1 : 0);
    gl.uniform1f(uniforms.get('uBorderThickness')!, options.borderThickness ?? 1);

    const borderColor = parseColor(options.borderColor, [0.16, 0.16, 0.16, 1]);
    gl.uniform4f(uniforms.get('uBorderColor')!, ...borderColor);

    const bgColor = parseColor(options.backgroundColor, [0, 0, 0, 0]);
    gl.uniform4f(uniforms.get('uBackgroundColor')!, ...bgColor);
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

  render(input: RenderSource, options: HexOptions = {}): ImageOutput {
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
    options: HexOptions = {},
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
  renderToBitmap(input: RenderSource, options: HexOptions = {}): Promise<ImageBitmap> {
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

export const HEX_PRESETS: Record<string, Partial<HexOptions>> = {
  default: {},
  bordered: { drawBorders: true, borderColor: '#282828', borderThickness: 1 },
  pointy: { orientation: 'pointy-top', drawBorders: false },
};
