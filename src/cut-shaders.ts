/**
 * CUT3 WebGL2 Shaders — Cheap Upscaling Triangulation, level 3.
 *
 * Ported to GLSL ES 3.00 from the original THREE.js shaders in
 * "Cheap Upscaling Triangulation", Copyright (c) Filippo Scognamiglio 2024,
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
 *
 * Port notes:
 * - The upstream compile-time `#define` configuration block is exposed as
 *   uniforms instead, so a single program per pass serves every option
 *   combination (branching on uniforms is uniform control flow — cheap).
 *   Derived constants (STEP, HSTEP, MAX_DOUBLE_DISTANCE, MAX_DISTANCE,
 *   blendDiffInv) are computed on the CPU, including the upstream
 *   *integer* division in MAX_DISTANCE.
 * - THREE.js built-ins (uv / position / matrices) are replaced by the
 *   shared fullscreen-triangle convention used by every renderer in this
 *   package; uFlipY exists only in the final pass.
 * - `precision highp float` everywhere: WebGL2 guarantees fragment highp,
 *   and it removes lowp/mediump variance across mobile GPUs (the upstream
 *   `quickUnpackFloats2` intermediates exceed the guaranteed lowp range).
 * - `edgesWeights` in pass 1 is explicitly zero-initialised: the upstream
 *   GLSL leaves untouched entries formally undefined and relies on
 *   zero-fill behaviour.
 * - Passes 0 and 1 render input-sized data buffers and must be attached to
 *   RGBA8 targets with NEAREST/CLAMP_TO_EDGE sampling: the bit-packing
 *   maths depends on 8-bit quantisation.
 */

/** Pass 0 vertex shader: per-fragment neighbour coordinates. */
export const CUT_PASS0_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 position;
uniform vec2 uTextureSize;

out vec2 c01;
out vec2 c02;
out vec2 c04;
out vec2 c05;
out vec2 c06;
out vec2 c07;
out vec2 c08;
out vec2 c09;
out vec2 c10;
out vec2 c11;
out vec2 c13;
out vec2 c14;

void main() {
  vec2 vUv = position * 0.5 + 0.5;
  vec2 coords = vUv * 1.00006103515625;
  vec2 screenCoords = coords * uTextureSize - vec2(0.5);
  c01 = (screenCoords + vec2(+0.0, -1.0)) / uTextureSize;
  c02 = (screenCoords + vec2(+1.0, -1.0)) / uTextureSize;
  c04 = (screenCoords + vec2(-1.0, +0.0)) / uTextureSize;
  c05 = (screenCoords + vec2(+0.0, +0.0)) / uTextureSize;
  c06 = (screenCoords + vec2(+1.0, +0.0)) / uTextureSize;
  c07 = (screenCoords + vec2(+2.0, +0.0)) / uTextureSize;
  c08 = (screenCoords + vec2(-1.0, +1.0)) / uTextureSize;
  c09 = (screenCoords + vec2(+0.0, +1.0)) / uTextureSize;
  c10 = (screenCoords + vec2(+1.0, +1.0)) / uTextureSize;
  c11 = (screenCoords + vec2(+2.0, +1.0)) / uTextureSize;
  c13 = (screenCoords + vec2(+0.0, +2.0)) / uTextureSize;
  c14 = (screenCoords + vec2(+1.0, +2.0)) / uTextureSize;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

/** Pass 0 fragment shader: triangulation + pattern recognition. */
export const CUT_PASS0_FRAGMENT = `#version 300 es
precision highp float;

#define EPSILON 0.02

uniform sampler2D uTex0;
uniform float uSearchMaxError;      // HARD_EDGES_SEARCH_MAX_ERROR
uniform float uEdgeUseFastLuma;     // EDGE_USE_FAST_LUMA (0.0 / 1.0)
uniform float uSoftEdgesSharpening; // SOFT_EDGES_SHARPENING (0.0 / 1.0)

in vec2 c01;
in vec2 c02;
in vec2 c04;
in vec2 c05;
in vec2 c06;
in vec2 c07;
in vec2 c08;
in vec2 c09;
in vec2 c10;
in vec2 c11;
in vec2 c13;
in vec2 c14;

out vec4 fragColor;

float maxOf(vec4 values) {
  return max(max(values.x, values.y), max(values.z, values.w));
}

float luma(vec3 v) {
  if (uEdgeUseFastLuma > 0.5) {
    return v.g;
  }
  return dot(v, vec3(0.299, 0.587, 0.114));
}

float quickPackBools2(bvec2 values) {
  return dot(vec2(values), vec2(0.5, 0.25));
}

float quickPackFloats2(vec2 values) {
  return dot(floor(values * vec2(12.0) + vec2(0.5)), vec2(0.0625, 0.00390625));
}

struct Quad {
  vec4 scores;
  float maxEdgeContrast;
  float maxScore;
};

Quad quad(vec4 values) {
  vec4 edges = values.xyzx - values.ywwz;

  vec4 scores = vec4(
    abs(edges.x + edges.z),
    abs(edges.w + edges.y),
    max(abs(edges.x - edges.y), abs(edges.w - edges.z)),
    max(abs(edges.x + edges.w), abs(edges.y + edges.z))
  );

  Quad result;
  result.scores = scores;
  result.maxScore = maxOf(scores);
  result.maxEdgeContrast = maxOf(abs(edges));
  return result;
}

int computePattern(Quad q, vec4 neighborsScores) {
  vec4 scores = q.scores;
  float maxOrthogonal = max(scores.x, scores.y);
  float maxDiagonal = max(scores.z, scores.w);

  bool isDiagonal = maxDiagonal > maxOrthogonal;

  vec4 adjustedScores = scores + 0.25 * neighborsScores;

  int result = 0;
  float threshold = 1.05;

  if (!isDiagonal) {
    if (adjustedScores.x > max(threshold * adjustedScores.y, EPSILON)) {
      result = 1;
    } else if (adjustedScores.y > max(threshold * adjustedScores.x, EPSILON)) {
      result = 2;
    }
  } else {
    if (adjustedScores.z > max(threshold * adjustedScores.w, EPSILON)) {
      result = 3;
    } else if (adjustedScores.w > max(threshold * adjustedScores.z, EPSILON)) {
      result = 4;
    }
  }

  float error = 2.0 * q.maxEdgeContrast - q.maxScore;
  if (error > uSearchMaxError * (0.5 + 0.5 * q.maxEdgeContrast)) {
    result = -result;
  }

  return result;
}

int findPattern(Quad q) {
  return computePattern(q, vec4(0.0));
}

int findPatternAdjusted(Quad quads[5]) {
  vec4 adjustments = vec4(0.0);
  adjustments += quads[1].scores;
  adjustments += quads[2].scores;
  adjustments += quads[3].scores;
  adjustments += quads[4].scores;
  return computePattern(quads[0], adjustments);
}

float softEdgeWeight(float a, float b, float c, float d) {
  float result = 0.0;
  float diff = abs(b - c);
  result += clamp(diff / (abs(a - c) + EPSILON), 0.0, 1.0);
  result -= clamp(diff / (abs(b - d) + EPSILON), 0.0, 1.0);
  return clamp(2.0 * result, -1.0, 1.0);
}

void main() {
  vec3 t01 = texture(uTex0, c01).rgb;
  vec3 t02 = texture(uTex0, c02).rgb;
  vec3 t04 = texture(uTex0, c04).rgb;
  vec3 t05 = texture(uTex0, c05).rgb;
  vec3 t06 = texture(uTex0, c06).rgb;
  vec3 t07 = texture(uTex0, c07).rgb;
  vec3 t08 = texture(uTex0, c08).rgb;
  vec3 t09 = texture(uTex0, c09).rgb;
  vec3 t10 = texture(uTex0, c10).rgb;
  vec3 t11 = texture(uTex0, c11).rgb;
  vec3 t13 = texture(uTex0, c13).rgb;
  vec3 t14 = texture(uTex0, c14).rgb;

  float l01 = luma(t01);
  float l02 = luma(t02);
  float l04 = luma(t04);
  float l05 = luma(t05);
  float l06 = luma(t06);
  float l07 = luma(t07);
  float l08 = luma(t08);
  float l09 = luma(t09);
  float l10 = luma(t10);
  float l11 = luma(t11);
  float l13 = luma(t13);
  float l14 = luma(t14);

  Quad quads[5];
  quads[0] = quad(vec4(l05, l06, l09, l10));
  quads[1] = quad(vec4(l01, l02, l05, l06));
  quads[2] = quad(vec4(l06, l07, l10, l11));
  quads[3] = quad(vec4(l09, l10, l13, l14));
  quads[4] = quad(vec4(l04, l05, l08, l09));

  int pattern = findPatternAdjusted(quads);

  vec4 mainValues = vec4(l05, l06, l09, l10);
  vec4 mainEdges = abs(mainValues.xyzx - mainValues.ywwz);
  bvec4 neighborConnections = greaterThanEqual(mainEdges, vec4(0.5 * maxOf(mainEdges)));

  ivec4 neighborPatterns = ivec4(
    findPattern(quads[1]),
    findPattern(quads[2]),
    findPattern(quads[3]),
    findPattern(quads[4])
  );
  neighborPatterns *= ivec4(neighborConnections);

  bool vertical = any(equal(neighborPatterns.xz, ivec2(1)));
  bool horizontal = any(equal(neighborPatterns.yw, ivec2(2)));
  bool corner = vertical && horizontal;
  bool opposite = any(equal(neighborPatterns, ivec4(pattern == 3 ? 4 : 3)));
  bool isTriangle = pattern >= 3;

  bool reject = (isTriangle && (opposite || corner)) || !any(neighborConnections);

  vec4 result = vec4(0.0);

  if (uSoftEdgesSharpening > 0.5) {
    vec4 softEdges = vec4(
      softEdgeWeight(l04, l05, l06, l07),
      softEdgeWeight(l02, l06, l10, l14),
      softEdgeWeight(l08, l09, l10, l11),
      softEdgeWeight(l01, l05, l09, l13)
    );

    result.y = quickPackFloats2(softEdges.xy * 0.5 + vec2(0.5));
    result.z = quickPackFloats2(softEdges.zw * 0.5 + vec2(0.5));
  }

  if (pattern > 0 && reject) {
    pattern = -pattern;
  }

  result.x = float(pattern + 4) / 8.0;
  fragColor = result;
}
`;

/** Pass 1 vertex shader. */
export const CUT_PASS1_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 position;
uniform vec2 uTextureSize;

out vec2 passCoords;
out vec2 dc;

void main() {
  vec2 vUv = position * 0.5 + 0.5;
  vec2 coords = vUv * 1.00006103515625;
  vec2 screenCoords = coords * uTextureSize - vec2(0.5);
  passCoords = screenCoords / uTextureSize;
  dc = vec2(1.0) / uTextureSize;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

/** Pass 1 fragment shader: hard-edge search. */
export const CUT_PASS1_FRAGMENT = `#version 300 es
precision highp float;

#define EPSILON 0.02

uniform sampler2D uPreviousPass;
uniform float uStep;                     // 0.5 / D
uniform float uHstep;                    // uStep / 2
uniform float uMaxDoubleDistance;        // D * uStep
uniform float uMaxDistance;              // uStep * floor(D / 2) + uHstep
uniform int uSearchMaxDistance;          // HARD_EDGES_SEARCH_MAX_DISTANCE
uniform float uSoftEdgesSharpening;      // SOFT_EDGES_SHARPENING (0.0 / 1.0)
uniform float uSoftEdgesSharpeningAmount;

in vec2 passCoords;
in vec2 dc;

out vec4 fragColor;

float quickPackBools2(bvec2 values) {
  return dot(vec2(values), vec2(0.5, 0.25));
}

float quickPackFloats2(vec2 values) {
  return dot(floor(values * vec2(12.0) + vec2(0.5)), vec2(0.0625, 0.00390625));
}

vec2 quickUnpackFloats2(float value) {
  vec2 result = vec2(0.0);
  float current = value;

  current *= 16.0;
  result.x = floor(current);
  current -= result.x;

  current *= 16.0;
  result.y = floor(current);
  current -= result.y;

  return result / 12.0;
}

int fetchPattern(float value) {
  return int(value * 8.0 + 0.5) - 4;
}

vec2 walk(vec2 baseCoords, vec2 direction, vec2 results, int continuePattern) {
  vec2 result = vec2(0.0, 0.0);
  for (int i = 1; i <= uSearchMaxDistance; i++) {
    vec2 coords = baseCoords + direction * float(i);
    int currentPattern = fetchPattern(texture(uPreviousPass, coords).x);

    if (currentPattern == 3) {
      result.y = results.x;
    } else if (currentPattern == 4) {
      result.y = results.y;
    }

    if (currentPattern == 3 || currentPattern == 4) {
      result.x += uHstep;
    } else if (currentPattern == continuePattern) {
      result.x += uStep;
    }

    if (currentPattern != continuePattern) { break; }
  }
  return result;
}

float blendWeights(vec2 d1, vec2 d2) {
  float result = 0.0;

  float totalDistance = d1.x + d2.x;
  float d1Ratio = d1.x / totalDistance;

  if (totalDistance <= EPSILON) {
    result = 0.0;
  } else if (totalDistance <= uMaxDoubleDistance) {
    result = (d1.x < d2.x) ? mix(d1.y, 0.0, 2.0 * d1Ratio) : mix(0.0, d2.y, (d1Ratio - 0.5) * 2.0);
  } else if (d1.x <= uMaxDistance) {
    result = mix(d1.y, 0.0, d1.x / uMaxDistance);
  } else if (d2.x <= uMaxDistance) {
    result = mix(d2.y, 0.0, d2.x / uMaxDistance);
  }

  return result;
}

void main() {
  vec4 previousPassPixel = texture(uPreviousPass, passCoords);
  int pattern = fetchPattern(previousPassPixel.x);

  vec2 resultN = vec2(0.0, 0.0);
  vec2 resultS = vec2(0.0, 0.0);
  vec2 resultW = vec2(0.0, 0.0);
  vec2 resultE = vec2(0.0, 0.0);

  if (pattern == 1 || pattern == 3 || pattern == 4) {
    resultN = walk(passCoords, vec2(0.0, -dc.y), vec2(-1.0, +1.0), 1);
    resultS = walk(passCoords, vec2(0.0, +dc.y), vec2(+1.0, -1.0), 1);
  }
  if (pattern == 2 || pattern == 3 || pattern == 4) {
    resultW = walk(passCoords, vec2(-dc.x, 0.0), vec2(-1.0, +1.0), 2);
    resultE = walk(passCoords, vec2(+dc.x, 0.0), vec2(+1.0, -1.0), 2);
  }

  // Explicitly zero-initialised (the original leaves untouched entries
  // formally undefined and relies on them reading as zero).
  vec4 edgesWeights[4] = vec4[4](vec4(0.0), vec4(0.0), vec4(0.0), vec4(0.0));

  if (pattern == 1) {
    edgesWeights[0] = vec4(resultN, resultS + vec2(uStep, 0.0));
    edgesWeights[2] = vec4(resultN + vec2(uStep, 0.0), resultS);
  } else if (pattern == 2) {
    edgesWeights[3] = vec4(resultW, resultE + vec2(uStep, 0.0));
    edgesWeights[1] = vec4(resultW + vec2(uStep, 0.0), resultE);
  } else if (pattern == 3) {
    edgesWeights[0] = vec4(resultN, vec2(uHstep, 1.0));
    edgesWeights[2] = vec4(vec2(uHstep, -1.0), resultS);
    edgesWeights[3] = vec4(resultW, vec2(uHstep, 1.0));
    edgesWeights[1] = vec4(vec2(uHstep, -1.0), resultE);
  } else if (pattern == 4) {
    edgesWeights[0] = vec4(resultN, vec2(uHstep, -1.0));
    edgesWeights[2] = vec4(vec2(uHstep, 1.0), resultS);
    edgesWeights[3] = vec4(resultW, vec2(uHstep, -1.0));
    edgesWeights[1] = vec4(vec2(uHstep, 1.0), resultE);
  }

  vec4 edges = vec4(
    blendWeights(edgesWeights[0].xy, edgesWeights[0].zw),
    blendWeights(edgesWeights[1].xy, edgesWeights[1].zw),
    blendWeights(edgesWeights[2].xy, edgesWeights[2].zw),
    blendWeights(edgesWeights[3].xy, edgesWeights[3].zw)
  );

  if (uSoftEdgesSharpening > 0.5) {
    vec4 softEdges = 2.0 * uSoftEdgesSharpeningAmount * vec4(
      quickUnpackFloats2(previousPassPixel.y + 0.001953125) - vec2(0.5),
      quickUnpackFloats2(previousPassPixel.z + 0.001953125) - vec2(0.5)
    );

    edges = mix(softEdges, edges, step(vec4(EPSILON), abs(edges)));
  }

  int originalPattern = pattern >= 0 ? pattern : -pattern;
  if (originalPattern == 3) {
    edges = vec4(-edges.x, edges.w, -edges.z, edges.y);
  }

  fragColor = vec4(
    quickPackBools2(bvec2(originalPattern >= 3, originalPattern == 3)),
    quickPackFloats2(edges.xy * 0.5 + vec2(0.5)),
    quickPackFloats2(edges.zw * 0.5 + vec2(0.5)),
    1.0
  );
}
`;

/** Pass 2 vertex shader (the only pass that supports vertical flipping). */
export const CUT_PASS2_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 position;
uniform vec2 uTextureSize;
// uFlipY: 0.0 -> orientation for top-down readPixels output;
//         1.0 -> orientation for direct canvas / ImageBitmap presentation.
// Flipping the sampling coordinates flips lookups into both the source
// image and the pass-1 data texture consistently.
uniform float uFlipY;

out vec2 screenCoords;
out vec2 passCoords;
out vec2 c05;
out vec2 c06;
out vec2 c09;
out vec2 c10;

void main() {
  vec2 vUv = position * 0.5 + 0.5;
  vUv.y = mix(vUv.y, 1.0 - vUv.y, uFlipY);
  vec2 coords = vUv * 1.00006103515625;
  screenCoords = coords * uTextureSize - vec2(0.5);
  c05 = (screenCoords + vec2(+0.0, +0.0)) / uTextureSize;
  c06 = (screenCoords + vec2(+1.0, +0.0)) / uTextureSize;
  c09 = (screenCoords + vec2(+0.0, +1.0)) / uTextureSize;
  c10 = (screenCoords + vec2(+1.0, +1.0)) / uTextureSize;
  passCoords = c05;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

/** Pass 2 fragment shader: triangulated interpolation to output size. */
export const CUT_PASS2_FRAGMENT = `#version 300 es
precision highp float;

#define EPSILON 0.02

uniform sampler2D uTex0;
uniform sampler2D uPreviousPass;
uniform float uUseDynamicBlend;     // USE_DYNAMIC_BLEND (0.0 / 1.0)
uniform float uBlendMinContrastEdge;
uniform float uBlendDiffInv;        // 1 / (BLEND_MAX_CONTRAST_EDGE - BLEND_MIN_CONTRAST_EDGE)
uniform float uBlendMinSharpness;
uniform float uBlendMaxSharpness;
uniform float uStaticBlendSharpness;

in vec2 screenCoords;
in vec2 passCoords;
in vec2 c05;
in vec2 c06;
in vec2 c09;
in vec2 c10;

out vec4 fragColor;

// Pass 2 deliberately uses the quick green-channel luma (only feeds the
// dynamic blend contrast estimate).
float luma(vec3 v) {
  return v.g;
}

struct Pixels {
  vec3 p0;
  vec3 p1;
  vec3 p2;
  vec3 p3;
};

struct Pattern {
  Pixels pixels;
  vec3 weights;
  vec3 midPoints;
  vec3 baseSharpness;
};

struct Flags {
  bool flip;
  bool triangle;
  vec4 edgeWeight;
};

vec2 quickUnpackFloats2(float value) {
  vec2 result = vec2(0.0);
  float current = value;

  current *= 16.0;
  result.x = floor(current);
  current -= result.x;

  current *= 16.0;
  result.y = floor(current);
  current -= result.y;

  return result / 12.0;
}

bvec2 quickUnpackBools2(float value) {
  vec2 result = vec2(0.0);
  float current = value;

  current *= 2.0;
  result.x = floor(current);
  current -= result.x;

  current *= 2.0;
  result.y = floor(current);
  current -= result.y;

  return greaterThan(result, vec2(0.5));
}

Flags parseFlags(vec3 flagsPixel) {
  Flags flags;
  flags.edgeWeight = clamp(
    vec4(quickUnpackFloats2(flagsPixel.y + 0.001953125), quickUnpackFloats2(flagsPixel.z + 0.001953125)),
    EPSILON,
    1.0 - EPSILON
  );
  bvec2 boolFlags = quickUnpackBools2(flagsPixel.x + 0.125);
  flags.triangle = boolFlags.x;
  flags.flip = boolFlags.y;
  return flags;
}

float sharpness(float l1, float l2) {
  float result;
  if (uUseDynamicBlend > 0.5) {
    float lumaDiff = abs(l1 - l2);
    float contrast = clamp((lumaDiff - uBlendMinContrastEdge) * uBlendDiffInv, 0.0, 1.0);
    result = mix(uBlendMinSharpness * 0.5, uBlendMaxSharpness * 0.5, contrast);
  } else {
    result = uStaticBlendSharpness * 0.5;
  }
  return result;
}

float adjustMidpoint(float x, float midPoint) {
  float result = 0.0;
  result += clamp(x / midPoint, 0.0, 1.0);
  result += clamp((x - midPoint) / (1.0 - midPoint), 0.0, 1.0);
  return 0.5 * result;
}

vec3 blend(vec3 a, vec3 b, float t, float midPoint, float baseSharpness) {
  float sharp = baseSharpness * sharpness(luma(a), luma(b));
  float nt = adjustMidpoint(t, midPoint);
  nt = clamp((nt - sharp) / (1.0 - 2.0 * sharp), 0.0, 1.0);
  return mix(a, b, nt);
}

Pattern makePattern(Pixels pixels, vec4 edgeWeights, bool triangle, vec2 pxCoords) {
  Pattern result;

  bool firstTriangle = triangle && pxCoords.x + pxCoords.y <= 1.0;
  bool secondTriangle = triangle && !firstTriangle;

  vec2 midPoints = vec2(0.0);

  if (secondTriangle) {
    pxCoords = vec2(1.0 - pxCoords.y, 1.0 - pxCoords.x);
    pixels = Pixels(pixels.p3, pixels.p1, pixels.p2, pixels.p0);
    edgeWeights = vec4(1.0) - edgeWeights.yxwz;
  }

  if (triangle) {
    float coordsSum = pxCoords.x + pxCoords.y;
    midPoints = vec2(
      edgeWeights.x * edgeWeights.w * coordsSum / (edgeWeights.w * pxCoords.x + edgeWeights.x * pxCoords.y),
      0.5 + 0.5 * clamp(-edgeWeights.x + edgeWeights.y - edgeWeights.z + edgeWeights.w, -1.0, 1.0)
    );
    pxCoords = vec2(coordsSum, pxCoords.y / coordsSum);
  } else {
    midPoints = vec2(
      mix(edgeWeights.x, edgeWeights.z, pxCoords.y),
      mix(edgeWeights.w, edgeWeights.y, pxCoords.x)
    );
  }

  result.weights = pxCoords.xxy;
  result.midPoints = midPoints.xxy;
  result.baseSharpness = vec3(1.0, 1.0, float(!triangle));
  result.pixels = Pixels(
    pixels.p0,
    pixels.p1,
    triangle ? pixels.p0 : pixels.p2,
    triangle ? pixels.p2 : pixels.p3
  );

  return result;
}

void main() {
  vec3 t05 = texture(uTex0, c05).rgb;
  vec3 t06 = texture(uTex0, c06).rgb;
  vec3 t09 = texture(uTex0, c09).rgb;
  vec3 t10 = texture(uTex0, c10).rgb;

  vec3 flagsPixel = texture(uPreviousPass, passCoords).xyz;
  Flags flags = parseFlags(flagsPixel);
  Pixels pixels = Pixels(t05, t06, t09, t10);

  vec2 pxCoords = fract(screenCoords);
  vec4 edges = flags.edgeWeight;

  if (flags.flip) {
    pixels = Pixels(pixels.p1, pixels.p0, pixels.p3, pixels.p2);
    pxCoords.x = 1.0 - pxCoords.x;
  }

  Pattern pat = makePattern(pixels, edges, flags.triangle, pxCoords);

  vec3 final = blend(
    blend(pat.pixels.p0, pat.pixels.p1, pat.weights.x, pat.midPoints.x, pat.baseSharpness.x),
    blend(pat.pixels.p2, pat.pixels.p3, pat.weights.y, pat.midPoints.y, pat.baseSharpness.y),
    pat.weights.z,
    pat.midPoints.z,
    pat.baseSharpness.z
  );

  fragColor = vec4(final.rgb, 1.0);
}
`;
