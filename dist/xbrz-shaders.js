/**
 * xBRZ Shader Constants
 * Separated from renderer for cleaner code organization
 */
export const XBRZ_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 position;
uniform vec2 uInputRes;
// uFlipY: 0.0 -> orientation for top-down readPixels output;
//         1.0 -> orientation for direct canvas / ImageBitmap presentation.
// Applied before the neighbour taps are derived, so the whole 5x5 kernel
// stays consistent in input-texture space.
uniform float uFlipY;

out vec2 vTexCoord;
out vec4 t1;
out vec4 t2;
out vec4 t3;
out vec4 t4;
out vec4 t5;
out vec4 t6;
out vec4 t7;

void main() {
    vTexCoord = position * 0.5 + 0.5;
    vTexCoord.y = mix(vTexCoord.y, 1.0 - vTexCoord.y, uFlipY);
    gl_Position = vec4(position, 0.0, 1.0);

    vec2 ps = vec2(1.0) / uInputRes;
    float dx = ps.x;
    float dy = ps.y;

    // Pre-calculate texture lookups
    t1 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, -2.0 * dy);
    t2 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, -dy);
    t3 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, 0.0);
    t4 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, dy);
    t5 = vTexCoord.xxxy + vec4(-dx, 0.0, dx, 2.0 * dy);
    t6 = vTexCoord.xyyy + vec4(-2.0 * dx, -dy, 0.0, dy);
    t7 = vTexCoord.xyyy + vec4( 2.0 * dx, -dy, 0.0, dy);
}`;
const FRAG_HEADER = `#version 300 es
precision highp float;

uniform sampler2D uTex;
uniform vec2 uInputRes;
uniform float uEqualColorTolerance;
uniform float uCenterDirectionBias;
uniform float uSteepDirectionThreshold;
uniform float uDominantDirectionThreshold;

in vec2 vTexCoord;
in vec4 t1, t2, t3, t4, t5, t6, t7;
out vec4 FragColor;

#define BLEND_NONE 0
#define BLEND_NORMAL 1
#define BLEND_DOMINANT 2
#define LUMINANCE_WEIGHT 1.0

float DistYCbCr(vec4 pixA, vec4 pixB) {
    const vec3 w = vec3(0.2627, 0.6780, 0.0593);
    const float scaleB = 0.5 / (1.0 - w.b);
    const float scaleR = 0.5 / (1.0 - w.r);
    vec3 diff = pixA.rgb - pixB.rgb;
    float Y = dot(diff, w);
    float Cb = scaleB * (diff.b - Y);
    float Cr = scaleR * (diff.r - Y);
    float rgbDist = sqrt(((LUMINANCE_WEIGHT * Y) * (LUMINANCE_WEIGHT * Y)) + (Cb * Cb) + (Cr * Cr));
    
    // Factor in alpha difference (matching Rust implementation)
    // Weight RGB distance by minimum alpha, add alpha difference as penalty
    float a1 = pixA.a;
    float a2 = pixB.a;
    if (a1 < a2) {
        return a1 * rgbDist + (a2 - a1);
    } else {
        return a2 * rgbDist + (a1 - a2);
    }
}

// Exact pixel identity (all four channels). Texel values are exact multiples
// of 1/255, so vec4 equality is exact; it replaces a reduce(rgb) packing that
// ignored alpha and, near 65536 in f32, could not tell apart colours one blue
// step apart. Matches the Rust engine's whole-pixel comparisons.
//
// IsPixEqual below is the *tolerance* test (Zenju's eq()), used by the
// insular-pixel / L-shape rules; the line-shape test uses exact identity.
bool IsPixEqual(vec4 pixA, vec4 pixB) {
    return (DistYCbCr(pixA, pixB) < uEqualColorTolerance);
}

bool IsBlendingNeeded(ivec4 blend) {
    return (blend.x != BLEND_NONE || blend.y != BLEND_NONE || blend.z != BLEND_NONE || blend.w != BLEND_NONE);
}

// Alpha-weighted blend matching Rust's gradient_rgba function
// front = pixel to blend towards, back = current pixel, t = blend factor (M/N in Rust)
vec4 alphaBlend(vec4 back, vec4 front, float t) {
    // If no blending requested, return back unchanged
    if (t < 0.001) {
        return back;
    }
    
    // Weight by alpha: front contributes (front.a * t), back contributes (back.a * (1-t))
    float weight_front = front.a * t;
    float weight_back = back.a * (1.0 - t);
    float weight_sum = weight_front + weight_back;
    
    if (weight_sum < 0.001) {
        return vec4(0.0);
    }
    
    // RGB is weighted by alpha contribution
    vec3 rgb = (front.rgb * weight_front + back.rgb * weight_back) / weight_sum;
    // Alpha is the sum of weights (matches Rust: weight_sum / N, but we're already normalized)
    float alpha = weight_sum;
    
    return vec4(rgb, alpha);
}

`;
export const XBRZ_FRAG_2X = FRAG_HEADER + `
#define M_PI 3.1415926535897932384626433832795

// ScalePixel now takes vec4 arrays to preserve Alpha
void ScalePixel(ivec4 blend, vec4 k[9], inout vec4 dst[4]) {
    // Original xBRZ: dist(f,g) and dist(h,c) for line detection
    float fg = DistYCbCr(k[1], k[4]);  // dist(f, g)
    float hc = DistYCbCr(k[3], k[8]);  // dist(h, c)
    // shallow_line: neq(e,g) && neq(d,g), steep_line: neq(e,c) && neq(b,c)
    bool haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (k[0] != k[4]) && (k[5] != k[4]);
    bool haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (k[0] != k[8]) && (k[7] != k[8]);
    bool needBlend = (blend.z != BLEND_NONE);
    bool doLineBlend = (blend.z >= BLEND_DOMINANT ||
        !((blend.y != BLEND_NONE && !IsPixEqual(k[0], k[4])) ||
          (blend.w != BLEND_NONE && !IsPixEqual(k[0], k[8])) ||
          (IsPixEqual(k[4], k[3]) && IsPixEqual(k[3], k[2]) && IsPixEqual(k[2], k[1]) && IsPixEqual(k[1], k[8]) && !IsPixEqual(k[0], k[2]))));

    vec4 blendPix = (DistYCbCr(k[0], k[1]) <= DistYCbCr(k[0], k[3])) ? k[1] : k[3];
    dst[1] = alphaBlend(dst[1], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.25 : 0.00);
    dst[2] = alphaBlend(dst[2], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 5.0/6.0 : 0.75) : ((haveSteepLine) ? 0.75 : 0.50)) : 1.0 - (M_PI/4.0)) : 0.00);
    dst[3] = alphaBlend(dst[3], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.25 : 0.00);
}

void main() {
    vec4 src[25]; // vec4 for Alpha
    src[21] = texture(uTex, t1.xw); src[22] = texture(uTex, t1.yw); src[23] = texture(uTex, t1.zw);
    src[ 6] = texture(uTex, t2.xw); src[ 7] = texture(uTex, t2.yw); src[ 8] = texture(uTex, t2.zw);
    src[ 5] = texture(uTex, t3.xw); src[ 0] = texture(uTex, t3.yw); src[ 1] = texture(uTex, t3.zw);
    src[ 4] = texture(uTex, t4.xw); src[ 3] = texture(uTex, t4.yw); src[ 2] = texture(uTex, t4.zw);
    src[15] = texture(uTex, t5.xw); src[14] = texture(uTex, t5.yw); src[13] = texture(uTex, t5.zw);
    src[19] = texture(uTex, t6.xy); src[18] = texture(uTex, t6.xz); src[17] = texture(uTex, t6.xw);
    src[ 9] = texture(uTex, t7.xy); src[10] = texture(uTex, t7.xz); src[11] = texture(uTex, t7.xw);


    ivec4 blendResult = ivec4(BLEND_NONE);

    // Corner Checks use full vec4 for proper alpha handling
    if (!((src[0] == src[1] && src[3] == src[2]) || (src[0] == src[3] && src[1] == src[2]))) {
        float d1 = DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + DistYCbCr(src[14], src[2]) + DistYCbCr(src[2], src[10]) + (uCenterDirectionBias * DistYCbCr(src[3], src[1]));
        float d2 = DistYCbCr(src[5], src[3]) + DistYCbCr(src[3], src[13]) + DistYCbCr(src[7], src[1]) + DistYCbCr(src[1], src[11]) + (uCenterDirectionBias * DistYCbCr(src[0], src[2]));
        blendResult.z = ((d1 < d2) && (src[0] != src[1]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[5] == src[0] && src[4] == src[3]) || (src[5] == src[4] && src[0] == src[3]))) {
        float d1 = DistYCbCr(src[17], src[5]) + DistYCbCr(src[5], src[7]) + DistYCbCr(src[15], src[3]) + DistYCbCr(src[3], src[1]) + (uCenterDirectionBias * DistYCbCr(src[4], src[0]));
        float d2 = DistYCbCr(src[18], src[4]) + DistYCbCr(src[4], src[14]) + DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + (uCenterDirectionBias * DistYCbCr(src[5], src[3]));
        blendResult.w = ((d1 > d2) && (src[0] != src[5]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[7] == src[8] && src[0] == src[1]) || (src[7] == src[0] && src[8] == src[1]))) {
        float d1 = DistYCbCr(src[5], src[7]) + DistYCbCr(src[7], src[23]) + DistYCbCr(src[3], src[1]) + DistYCbCr(src[1], src[9]) + (uCenterDirectionBias * DistYCbCr(src[0], src[8]));
        float d2 = DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + DistYCbCr(src[22], src[8]) + DistYCbCr(src[8], src[10]) + (uCenterDirectionBias * DistYCbCr(src[7], src[1]));
        blendResult.y = ((d1 > d2) && (src[0] != src[7]) && (src[0] != src[1])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[6] == src[7] && src[5] == src[0]) || (src[6] == src[5] && src[7] == src[0]))) {
        float d1 = DistYCbCr(src[18], src[6]) + DistYCbCr(src[6], src[22]) + DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + (uCenterDirectionBias * DistYCbCr(src[5], src[7]));
        float d2 = DistYCbCr(src[19], src[5]) + DistYCbCr(src[5], src[3]) + DistYCbCr(src[21], src[7]) + DistYCbCr(src[7], src[1]) + (uCenterDirectionBias * DistYCbCr(src[6], src[0]));
        blendResult.x = ((d1 < d2) && (src[0] != src[5]) && (src[0] != src[7])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }

    vec4 dst[4];
    dst[0] = src[0]; dst[1] = src[0]; dst[2] = src[0]; dst[3] = src[0];

    if (IsBlendingNeeded(blendResult)) {
        vec4 k[9]; vec4 tempDst3;
        // 0 deg
        k[0]=src[0]; k[1]=src[1]; k[2]=src[2]; k[3]=src[3]; k[4]=src[4]; k[5]=src[5]; k[6]=src[6]; k[7]=src[7]; k[8]=src[8];
        ScalePixel(blendResult, k, dst);
        // 90 deg
        k[1]=src[7]; k[2]=src[8]; k[3]=src[1]; k[4]=src[2]; k[5]=src[3]; k[6]=src[4]; k[7]=src[5]; k[8]=src[6];
        tempDst3 = dst[3]; dst[3] = dst[2]; dst[2] = dst[1]; dst[1] = dst[0]; dst[0] = tempDst3;
        ScalePixel(blendResult.wxyz, k, dst);
        // 180 deg
        k[1]=src[5]; k[2]=src[6]; k[3]=src[7]; k[4]=src[8]; k[5]=src[1]; k[6]=src[2]; k[7]=src[3]; k[8]=src[4];
        tempDst3 = dst[3]; dst[3] = dst[2]; dst[2] = dst[1]; dst[1] = dst[0]; dst[0] = tempDst3;
        ScalePixel(blendResult.zwxy, k, dst);
        // 270 deg
        k[1]=src[3]; k[2]=src[4]; k[3]=src[5]; k[4]=src[6]; k[5]=src[7]; k[6]=src[8]; k[7]=src[1]; k[8]=src[2];
        tempDst3 = dst[3]; dst[3] = dst[2]; dst[2] = dst[1]; dst[1] = dst[0]; dst[0] = tempDst3;
        ScalePixel(blendResult.yzwx, k, dst);
        // Rotate back
        tempDst3 = dst[3]; dst[3] = dst[2]; dst[2] = dst[1]; dst[1] = dst[0]; dst[0] = tempDst3;
    }

    vec2 f = step(0.5, fract(vTexCoord * uInputRes));
    vec4 res = mix(mix(dst[0], dst[1], f.x), mix(dst[3], dst[2], f.x), f.y);
    FragColor = res;
}`;
export const XBRZ_FRAG_3X = FRAG_HEADER + `
const float one_third = 1.0 / 3.0;
const float two_third = 2.0 / 3.0;

void ScalePixel(ivec4 blend, vec4 k[9], inout vec4 dst[9]) {
    // Original xBRZ: dist(f,g) and dist(h,c) for line detection
    float fg = DistYCbCr(k[1], k[4]);  // dist(f, g)
    float hc = DistYCbCr(k[3], k[8]);  // dist(h, c)
    // shallow_line: neq(e,g) && neq(d,g), steep_line: neq(e,c) && neq(b,c)
    bool haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (k[0] != k[4]) && (k[5] != k[4]);
    bool haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (k[0] != k[8]) && (k[7] != k[8]);
    bool needBlend = (blend.z != BLEND_NONE);
    bool doLineBlend = (blend.z >= BLEND_DOMINANT || !((blend.y != BLEND_NONE && !IsPixEqual(k[0], k[4])) || (blend.w != BLEND_NONE && !IsPixEqual(k[0], k[8])) || (IsPixEqual(k[4], k[3]) && IsPixEqual(k[3], k[2]) && IsPixEqual(k[2], k[1]) && IsPixEqual(k[1], k[8]) && !IsPixEqual(k[0], k[2]))));
    
    vec4 blendPix = (DistYCbCr(k[0], k[1]) <= DistYCbCr(k[0], k[3])) ? k[1] : k[3];
    dst[1] = alphaBlend(dst[1], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 0.750 : ((haveShallowLine) ? 0.250 : 0.125)) : 0.000);
    dst[2] = alphaBlend(dst[2], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.4545939598) : 0.000);
    dst[3] = alphaBlend(dst[3], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 0.750 : ((haveSteepLine) ? 0.250 : 0.125)) : 0.000);
    dst[4] = alphaBlend(dst[4], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
    dst[8] = alphaBlend(dst[8], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
}

void main() {
    vec4 src[25]; // vec4
    src[21] = texture(uTex, t1.xw); src[22] = texture(uTex, t1.yw); src[23] = texture(uTex, t1.zw);
    src[ 6] = texture(uTex, t2.xw); src[ 7] = texture(uTex, t2.yw); src[ 8] = texture(uTex, t2.zw);
    src[ 5] = texture(uTex, t3.xw); src[ 0] = texture(uTex, t3.yw); src[ 1] = texture(uTex, t3.zw);
    src[ 4] = texture(uTex, t4.xw); src[ 3] = texture(uTex, t4.yw); src[ 2] = texture(uTex, t4.zw);
    src[15] = texture(uTex, t5.xw); src[14] = texture(uTex, t5.yw); src[13] = texture(uTex, t5.zw);
    src[19] = texture(uTex, t6.xy); src[18] = texture(uTex, t6.xz); src[17] = texture(uTex, t6.xw);
    src[ 9] = texture(uTex, t7.xy); src[10] = texture(uTex, t7.xz); src[11] = texture(uTex, t7.xw);

    
    ivec4 blendResult = ivec4(BLEND_NONE);

    // Corner Check Logic
    if (!((src[0] == src[1] && src[3] == src[2]) || (src[0] == src[3] && src[1] == src[2]))) {
        float d1 = DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + DistYCbCr(src[14], src[2]) + DistYCbCr(src[2], src[10]) + (uCenterDirectionBias * DistYCbCr(src[3], src[1]));
        float d2 = DistYCbCr(src[5], src[3]) + DistYCbCr(src[3], src[13]) + DistYCbCr(src[7], src[1]) + DistYCbCr(src[1], src[11]) + (uCenterDirectionBias * DistYCbCr(src[0], src[2]));
        blendResult.z = ((d1 < d2) && (src[0] != src[1]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[5] == src[0] && src[4] == src[3]) || (src[5] == src[4] && src[0] == src[3]))) {
        float d1 = DistYCbCr(src[17], src[5]) + DistYCbCr(src[5], src[7]) + DistYCbCr(src[15], src[3]) + DistYCbCr(src[3], src[1]) + (uCenterDirectionBias * DistYCbCr(src[4], src[0]));
        float d2 = DistYCbCr(src[18], src[4]) + DistYCbCr(src[4], src[14]) + DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + (uCenterDirectionBias * DistYCbCr(src[5], src[3]));
        blendResult.w = ((d1 > d2) && (src[0] != src[5]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[7] == src[8] && src[0] == src[1]) || (src[7] == src[0] && src[8] == src[1]))) {
        float d1 = DistYCbCr(src[5], src[7]) + DistYCbCr(src[7], src[23]) + DistYCbCr(src[3], src[1]) + DistYCbCr(src[1], src[9]) + (uCenterDirectionBias * DistYCbCr(src[0], src[8]));
        float d2 = DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + DistYCbCr(src[22], src[8]) + DistYCbCr(src[8], src[10]) + (uCenterDirectionBias * DistYCbCr(src[7], src[1]));
        blendResult.y = ((d1 > d2) && (src[0] != src[7]) && (src[0] != src[1])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[6] == src[7] && src[5] == src[0]) || (src[6] == src[5] && src[7] == src[0]))) {
        float d1 = DistYCbCr(src[18], src[6]) + DistYCbCr(src[6], src[22]) + DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + (uCenterDirectionBias * DistYCbCr(src[5], src[7]));
        float d2 = DistYCbCr(src[19], src[5]) + DistYCbCr(src[5], src[3]) + DistYCbCr(src[21], src[7]) + DistYCbCr(src[7], src[1]) + (uCenterDirectionBias * DistYCbCr(src[6], src[0]));
        blendResult.x = ((d1 < d2) && (src[0] != src[5]) && (src[0] != src[7])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }

    vec4 dst[9];
    for(int i=0; i<9; i++) dst[i] = src[0];

    if (IsBlendingNeeded(blendResult)) {
        vec4 k[9];
        vec4 tempDst8, tempDst7;
        
        // 0 deg
        k[8]=src[8]; k[7]=src[7]; k[6]=src[6]; k[5]=src[5]; k[4]=src[4]; k[3]=src[3]; k[2]=src[2]; k[1]=src[1]; k[0]=src[0];
        ScalePixel(blendResult, k, dst);
        // 90 deg
        k[8]=src[6]; k[7]=src[5]; k[6]=src[4]; k[5]=src[3]; k[4]=src[2]; k[3]=src[1]; k[2]=src[8]; k[1]=src[7];
        tempDst8=dst[8]; tempDst7=dst[7]; dst[8]=dst[6]; dst[7]=dst[5]; dst[6]=dst[4]; dst[5]=dst[3]; dst[4]=dst[2]; dst[3]=dst[1]; dst[2]=tempDst8; dst[1]=tempDst7;
        ScalePixel(blendResult.wxyz, k, dst);
        // 180 deg
        k[8]=src[4]; k[7]=src[3]; k[6]=src[2]; k[5]=src[1]; k[4]=src[8]; k[3]=src[7]; k[2]=src[6]; k[1]=src[5];
        tempDst8=dst[8]; tempDst7=dst[7]; dst[8]=dst[6]; dst[7]=dst[5]; dst[6]=dst[4]; dst[5]=dst[3]; dst[4]=dst[2]; dst[3]=dst[1]; dst[2]=tempDst8; dst[1]=tempDst7;
        ScalePixel(blendResult.zwxy, k, dst);
        // 270 deg
        k[8]=src[2]; k[7]=src[1]; k[6]=src[8]; k[5]=src[7]; k[4]=src[6]; k[3]=src[5]; k[2]=src[4]; k[1]=src[3];
        tempDst8=dst[8]; tempDst7=dst[7]; dst[8]=dst[6]; dst[7]=dst[5]; dst[6]=dst[4]; dst[5]=dst[3]; dst[4]=dst[2]; dst[3]=dst[1]; dst[2]=tempDst8; dst[1]=tempDst7;
        ScalePixel(blendResult.yzwx, k, dst);
        // Rotate back
        tempDst8=dst[8]; tempDst7=dst[7]; dst[8]=dst[6]; dst[7]=dst[5]; dst[6]=dst[4]; dst[5]=dst[3]; dst[4]=dst[2]; dst[3]=dst[1]; dst[2]=tempDst8; dst[1]=tempDst7;
    }

    vec2 f = fract(vTexCoord * uInputRes);
    vec4 res = mix(mix(dst[6], mix(dst[7], dst[8], step(two_third, f.x)), step(one_third, f.x)),
                   mix(mix(dst[5], mix(dst[0], dst[1], step(two_third, f.x)), step(one_third, f.x)),
                       mix(dst[4], mix(dst[3], dst[2], step(two_third, f.x)), step(one_third, f.x)), step(two_third, f.y)), step(one_third, f.y));

    FragColor = res;
}`;
export const XBRZ_FRAG_4X = FRAG_HEADER + `
void main() {
    vec2 f = fract(vTexCoord * uInputRes);
    vec4 src[25]; // vec4
    src[21] = texture(uTex, t1.xw); src[22] = texture(uTex, t1.yw); src[23] = texture(uTex, t1.zw);
    src[ 6] = texture(uTex, t2.xw); src[ 7] = texture(uTex, t2.yw); src[ 8] = texture(uTex, t2.zw);
    src[ 5] = texture(uTex, t3.xw); src[ 0] = texture(uTex, t3.yw); src[ 1] = texture(uTex, t3.zw);
    src[ 4] = texture(uTex, t4.xw); src[ 3] = texture(uTex, t4.yw); src[ 2] = texture(uTex, t4.zw);
    src[15] = texture(uTex, t5.xw); src[14] = texture(uTex, t5.yw); src[13] = texture(uTex, t5.zw);
    src[19] = texture(uTex, t6.xy); src[18] = texture(uTex, t6.xz); src[17] = texture(uTex, t6.xw);
    src[ 9] = texture(uTex, t7.xy); src[10] = texture(uTex, t7.xz); src[11] = texture(uTex, t7.xw);


    ivec4 blendResult = ivec4(BLEND_NONE);

    // 4 Corner Checks
    if (!((src[0] == src[1] && src[3] == src[2]) || (src[0] == src[3] && src[1] == src[2]))) {
        float d1 = DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + DistYCbCr(src[14], src[2]) + DistYCbCr(src[2], src[10]) + (uCenterDirectionBias * DistYCbCr(src[3], src[1]));
        float d2 = DistYCbCr(src[5], src[3]) + DistYCbCr(src[3], src[13]) + DistYCbCr(src[7], src[1]) + DistYCbCr(src[1], src[11]) + (uCenterDirectionBias * DistYCbCr(src[0], src[2]));
        blendResult.z = ((d1 < d2) && (src[0] != src[1]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[5] == src[0] && src[4] == src[3]) || (src[5] == src[4] && src[0] == src[3]))) {
        float d1 = DistYCbCr(src[17], src[5]) + DistYCbCr(src[5], src[7]) + DistYCbCr(src[15], src[3]) + DistYCbCr(src[3], src[1]) + (uCenterDirectionBias * DistYCbCr(src[4], src[0]));
        float d2 = DistYCbCr(src[18], src[4]) + DistYCbCr(src[4], src[14]) + DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + (uCenterDirectionBias * DistYCbCr(src[5], src[3]));
        blendResult.w = ((d1 > d2) && (src[0] != src[5]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[7] == src[8] && src[0] == src[1]) || (src[7] == src[0] && src[8] == src[1]))) {
        float d1 = DistYCbCr(src[5], src[7]) + DistYCbCr(src[7], src[23]) + DistYCbCr(src[3], src[1]) + DistYCbCr(src[1], src[9]) + (uCenterDirectionBias * DistYCbCr(src[0], src[8]));
        float d2 = DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + DistYCbCr(src[22], src[8]) + DistYCbCr(src[8], src[10]) + (uCenterDirectionBias * DistYCbCr(src[7], src[1]));
        blendResult.y = ((d1 > d2) && (src[0] != src[7]) && (src[0] != src[1])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    if (!((src[6] == src[7] && src[5] == src[0]) || (src[6] == src[5] && src[7] == src[0]))) {
        float d1 = DistYCbCr(src[18], src[6]) + DistYCbCr(src[6], src[22]) + DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + (uCenterDirectionBias * DistYCbCr(src[5], src[7]));
        float d2 = DistYCbCr(src[19], src[5]) + DistYCbCr(src[5], src[3]) + DistYCbCr(src[21], src[7]) + DistYCbCr(src[7], src[1]) + (uCenterDirectionBias * DistYCbCr(src[6], src[0]));
        blendResult.x = ((d1 < d2) && (src[0] != src[5]) && (src[0] != src[7])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }

    vec4 dst[16];
    for (int i=0; i<16; i++) dst[i] = src[0];

    if (IsBlendingNeeded(blendResult)) {
        // Block 1: bottom-right corner (blendResult.z), 0° rotation
        // Original xBRZ: dist(f,g) and dist(h,c) for line detection
        float fg = DistYCbCr(src[1], src[4]);  // dist(f, g)
        float hc = DistYCbCr(src[3], src[8]);  // dist(h, c)
        // shallow_line: neq(e,g) && neq(d,g), steep_line: neq(e,c) && neq(b,c)
        bool haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[4]) && (src[5] != src[4]);
        bool haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[8]) && (src[7] != src[8]);
        bool needBlend = (blendResult.z != BLEND_NONE);
        bool doLineBlend = (blendResult.z >= BLEND_DOMINANT || !((blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && !IsPixEqual(src[0], src[2]))));
        vec4 blendPix = (DistYCbCr(src[0], src[1]) <= DistYCbCr(src[0], src[3])) ? src[1] : src[3];
        dst[2] = alphaBlend(dst[2], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 1.0/3.0 : 0.25) : ((haveSteepLine) ? 0.25 : 0.00)) : 0.00);
        dst[9] = alphaBlend(dst[9], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.25 : 0.00);
        dst[10] = alphaBlend(dst[10], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.75 : 0.00);
        dst[11] = alphaBlend(dst[11], blendPix, (needBlend) ? ((doLineBlend) ? ((haveSteepLine) ? 1.00 : ((haveShallowLine) ? 0.75 : 0.50)) : 0.08677704501) : 0.00);
        dst[12] = alphaBlend(dst[12], blendPix, (needBlend) ? ((doLineBlend) ? 1.00 : 0.6848532563) : 0.00);
        dst[13] = alphaBlend(dst[13], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? 1.00 : ((haveSteepLine) ? 0.75 : 0.50)) : 0.08677704501) : 0.00);
        dst[14] = alphaBlend(dst[14], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.75 : 0.00);
        dst[15] = alphaBlend(dst[15], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.25 : 0.00);

        // Block 2: top-right corner (blendResult.y), 90 deg CW rotation
        // After rotation: f=src[7], g=src[2], h=src[1], c=src[6], d=src[3], b=src[5]
        fg = DistYCbCr(src[7], src[2]);  // dist(rotated f, rotated g)
        hc = DistYCbCr(src[1], src[6]);  // dist(rotated h, rotated c)
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[2]) && (src[3] != src[2]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[6]) && (src[5] != src[6]);
        needBlend = (blendResult.y != BLEND_NONE);
        doLineBlend = (blendResult.y >= BLEND_DOMINANT || !((blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && !IsPixEqual(src[0], src[8]))));
        blendPix = (DistYCbCr(src[0], src[7]) <= DistYCbCr(src[0], src[1])) ? src[7] : src[1];
        dst[1] = alphaBlend(dst[1], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 1.0/3.0 : 0.25) : ((haveSteepLine) ? 0.25 : 0.00)) : 0.00);
        dst[6] = alphaBlend(dst[6], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.25 : 0.00);
        dst[7] = alphaBlend(dst[7], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.75 : 0.00);
        dst[8] = alphaBlend(dst[8], blendPix, (needBlend) ? ((doLineBlend) ? ((haveSteepLine) ? 1.00 : ((haveShallowLine) ? 0.75 : 0.50)) : 0.08677704501) : 0.00);
        dst[9] = alphaBlend(dst[9], blendPix, (needBlend) ? ((doLineBlend) ? 1.00 : 0.6848532563) : 0.00);
        dst[10] = alphaBlend(dst[10], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? 1.00 : ((haveSteepLine) ? 0.75 : 0.50)) : 0.08677704501) : 0.00);
        dst[11] = alphaBlend(dst[11], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.75 : 0.00);
        dst[12] = alphaBlend(dst[12], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.25 : 0.00);

        // Block 3: top-left corner (blendResult.x), 180 deg rotation
        // After rotation: f=src[5], g=src[8], h=src[7], c=src[4], d=src[1], b=src[3]
        fg = DistYCbCr(src[5], src[8]);  // dist(rotated f, rotated g)
        hc = DistYCbCr(src[7], src[4]);  // dist(rotated h, rotated c)
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[8]) && (src[1] != src[8]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[4]) && (src[3] != src[4]);
        needBlend = (blendResult.x != BLEND_NONE);
        doLineBlend = (blendResult.x >= BLEND_DOMINANT || !((blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && !IsPixEqual(src[0], src[6]))));
        blendPix = (DistYCbCr(src[0], src[5]) <= DistYCbCr(src[0], src[7])) ? src[5] : src[7];
        dst[0] = alphaBlend(dst[0], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 1.0/3.0 : 0.25) : ((haveSteepLine) ? 0.25 : 0.00)) : 0.00);
        dst[15] = alphaBlend(dst[15], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.25 : 0.00);
        dst[4] = alphaBlend(dst[4], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.75 : 0.00);
        dst[5] = alphaBlend(dst[5], blendPix, (needBlend) ? ((doLineBlend) ? ((haveSteepLine) ? 1.00 : ((haveShallowLine) ? 0.75 : 0.50)) : 0.08677704501) : 0.00);
        dst[6] = alphaBlend(dst[6], blendPix, (needBlend) ? ((doLineBlend) ? 1.00 : 0.6848532563) : 0.00);
        dst[7] = alphaBlend(dst[7], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? 1.00 : ((haveSteepLine) ? 0.75 : 0.50)) : 0.08677704501) : 0.00);
        dst[8] = alphaBlend(dst[8], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.75 : 0.00);
        dst[9] = alphaBlend(dst[9], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.25 : 0.00);

        // Block 4: bottom-left corner (blendResult.w), 270 deg rotation
        // After rotation: f=src[3], g=src[6], h=src[5], c=src[2], d=src[7], b=src[1]
        fg = DistYCbCr(src[3], src[6]);  // dist(rotated f, rotated g)
        hc = DistYCbCr(src[5], src[2]);  // dist(rotated h, rotated c)
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[6]) && (src[7] != src[6]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[2]) && (src[1] != src[2]);
        needBlend = (blendResult.w != BLEND_NONE);
        doLineBlend = (blendResult.w >= BLEND_DOMINANT || !((blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && !IsPixEqual(src[0], src[4]))));
        blendPix = (DistYCbCr(src[0], src[3]) <= DistYCbCr(src[0], src[5])) ? src[3] : src[5];
        dst[3] = alphaBlend(dst[3], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 1.0/3.0 : 0.25) : ((haveSteepLine) ? 0.25 : 0.00)) : 0.00);
        dst[12] = alphaBlend(dst[12], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.25 : 0.00);
        dst[13] = alphaBlend(dst[13], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.75 : 0.00);
        dst[14] = alphaBlend(dst[14], blendPix, (needBlend) ? ((doLineBlend) ? ((haveSteepLine) ? 1.00 : ((haveShallowLine) ? 0.75 : 0.50)) : 0.08677704501) : 0.00);
        dst[15] = alphaBlend(dst[15], blendPix, (needBlend) ? ((doLineBlend) ? 1.00 : 0.6848532563) : 0.00);
        dst[4] = alphaBlend(dst[4], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? 1.00 : ((haveSteepLine) ? 0.75 : 0.50)) : 0.08677704501) : 0.00);
        dst[5] = alphaBlend(dst[5], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.75 : 0.00);
        dst[6] = alphaBlend(dst[6], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.25 : 0.00);
    }

    vec4 res = mix(mix(mix(mix(dst[6], dst[7], step(0.25, f.x)), mix(dst[8], dst[9], step(0.75, f.x)), step(0.50, f.x)),
                       mix(mix(dst[5], dst[0], step(0.25, f.x)), mix(dst[1], dst[10], step(0.75, f.x)), step(0.50, f.x)), step(0.25, f.y)),
                   mix(mix(mix(dst[4], dst[3], step(0.25, f.x)), mix(dst[2], dst[11], step(0.75, f.x)), step(0.50, f.x)),
                       mix(mix(dst[15], dst[14], step(0.25, f.x)), mix(dst[13], dst[12], step(0.75, f.x)), step(0.50, f.x)), step(0.75, f.y)), step(0.50, f.y));

    FragColor = res;
}`;
export const XBRZ_FRAG_5X = FRAG_HEADER + `
const float one_fifth = 1.0 / 5.0;
const float two_fifth = 2.0 / 5.0;
const float three_fifth = 3.0 / 5.0;
const float four_fifth = 4.0 / 5.0;

void main() {
    vec2 f = fract(vTexCoord * uInputRes);
    vec4 src[25];
    src[21] = texture(uTex, t1.xw); src[22] = texture(uTex, t1.yw); src[23] = texture(uTex, t1.zw);
    src[ 6] = texture(uTex, t2.xw); src[ 7] = texture(uTex, t2.yw); src[ 8] = texture(uTex, t2.zw);
    src[ 5] = texture(uTex, t3.xw); src[ 0] = texture(uTex, t3.yw); src[ 1] = texture(uTex, t3.zw);
    src[ 4] = texture(uTex, t4.xw); src[ 3] = texture(uTex, t4.yw); src[ 2] = texture(uTex, t4.zw);
    src[15] = texture(uTex, t5.xw); src[14] = texture(uTex, t5.yw); src[13] = texture(uTex, t5.zw);
    src[19] = texture(uTex, t6.xy); src[18] = texture(uTex, t6.xz); src[17] = texture(uTex, t6.xw);
    src[ 9] = texture(uTex, t7.xy); src[10] = texture(uTex, t7.xz); src[11] = texture(uTex, t7.xw);


    ivec4 blendResult = ivec4(BLEND_NONE);

    // Corner (1, 1) - bottom-right
    if (!((src[0] == src[1] && src[3] == src[2]) || (src[0] == src[3] && src[1] == src[2]))) {
        float d1 = DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + DistYCbCr(src[14], src[2]) + DistYCbCr(src[2], src[10]) + (uCenterDirectionBias * DistYCbCr(src[3], src[1]));
        float d2 = DistYCbCr(src[5], src[3]) + DistYCbCr(src[3], src[13]) + DistYCbCr(src[7], src[1]) + DistYCbCr(src[1], src[11]) + (uCenterDirectionBias * DistYCbCr(src[0], src[2]));
        blendResult.z = ((d1 < d2) && (src[0] != src[1]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (0, 1) - bottom-left
    if (!((src[5] == src[0] && src[4] == src[3]) || (src[5] == src[4] && src[0] == src[3]))) {
        float d1 = DistYCbCr(src[17], src[5]) + DistYCbCr(src[5], src[7]) + DistYCbCr(src[15], src[3]) + DistYCbCr(src[3], src[1]) + (uCenterDirectionBias * DistYCbCr(src[4], src[0]));
        float d2 = DistYCbCr(src[18], src[4]) + DistYCbCr(src[4], src[14]) + DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + (uCenterDirectionBias * DistYCbCr(src[5], src[3]));
        blendResult.w = ((d1 > d2) && (src[0] != src[5]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (1, 0) - top-right
    if (!((src[7] == src[8] && src[0] == src[1]) || (src[7] == src[0] && src[8] == src[1]))) {
        float d1 = DistYCbCr(src[5], src[7]) + DistYCbCr(src[7], src[23]) + DistYCbCr(src[3], src[1]) + DistYCbCr(src[1], src[9]) + (uCenterDirectionBias * DistYCbCr(src[0], src[8]));
        float d2 = DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + DistYCbCr(src[22], src[8]) + DistYCbCr(src[8], src[10]) + (uCenterDirectionBias * DistYCbCr(src[7], src[1]));
        blendResult.y = ((d1 > d2) && (src[0] != src[7]) && (src[0] != src[1])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (0, 0) - top-left
    if (!((src[6] == src[7] && src[5] == src[0]) || (src[6] == src[5] && src[7] == src[0]))) {
        float d1 = DistYCbCr(src[18], src[6]) + DistYCbCr(src[6], src[22]) + DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + (uCenterDirectionBias * DistYCbCr(src[5], src[7]));
        float d2 = DistYCbCr(src[19], src[5]) + DistYCbCr(src[5], src[3]) + DistYCbCr(src[21], src[7]) + DistYCbCr(src[7], src[1]) + (uCenterDirectionBias * DistYCbCr(src[6], src[0]));
        blendResult.x = ((d1 < d2) && (src[0] != src[5]) && (src[0] != src[7])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }

    vec4 dst[25];
    for (int i = 0; i < 25; i++) dst[i] = src[0];

    if (IsBlendingNeeded(blendResult)) {
        // Block 1: bottom-right corner (blendResult.z), 0 deg rotation
        float fg = DistYCbCr(src[1], src[4]);
        float hc = DistYCbCr(src[3], src[8]);
        bool haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[4]) && (src[5] != src[4]);
        bool haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[8]) && (src[7] != src[8]);
        bool needBlend = (blendResult.z != BLEND_NONE);
        bool doLineBlend = (blendResult.z >= BLEND_DOMINANT || !((blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && !IsPixEqual(src[0], src[2]))));
        vec4 blendPix = (DistYCbCr(src[0], src[1]) <= DistYCbCr(src[0], src[3])) ? src[1] : src[3];
        dst[ 1] = alphaBlend(dst[ 1], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[ 2] = alphaBlend(dst[ 2], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 2.0/3.0 : 0.750) : ((haveSteepLine) ? 0.750 : 0.125)) : 0.000);
        dst[ 3] = alphaBlend(dst[ 3], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[ 9] = alphaBlend(dst[ 9], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.750 : 0.000);
        dst[10] = alphaBlend(dst[10], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 1.000 : ((haveShallowLine) ? 0.250 : 0.125)) : 0.000);
        dst[11] = alphaBlend(dst[11], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.2306749731) : 0.000);
        dst[12] = alphaBlend(dst[12], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.8631434088) : 0.000);
        dst[13] = alphaBlend(dst[13], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.2306749731) : 0.000);
        dst[14] = alphaBlend(dst[14], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 1.000 : ((haveSteepLine) ? 0.250 : 0.125)) : 0.000);
        dst[15] = alphaBlend(dst[15], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.750 : 0.000);
        dst[16] = alphaBlend(dst[16], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[24] = alphaBlend(dst[24], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);

        // Block 2: top-right corner (blendResult.y), 90 deg rotation
        fg = DistYCbCr(src[7], src[2]);
        hc = DistYCbCr(src[1], src[6]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[2]) && (src[3] != src[2]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[6]) && (src[5] != src[6]);
        needBlend = (blendResult.y != BLEND_NONE);
        doLineBlend = (blendResult.y >= BLEND_DOMINANT || !((blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && !IsPixEqual(src[0], src[8]))));
        blendPix = (DistYCbCr(src[0], src[7]) <= DistYCbCr(src[0], src[1])) ? src[7] : src[1];
        dst[ 7] = alphaBlend(dst[ 7], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[ 8] = alphaBlend(dst[ 8], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 2.0/3.0 : 0.750) : ((haveSteepLine) ? 0.750 : 0.125)) : 0.000);
        dst[ 1] = alphaBlend(dst[ 1], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[21] = alphaBlend(dst[21], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.750 : 0.000);
        dst[22] = alphaBlend(dst[22], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 1.000 : ((haveShallowLine) ? 0.250 : 0.125)) : 0.000);
        dst[23] = alphaBlend(dst[23], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.2306749731) : 0.000);
        dst[24] = alphaBlend(dst[24], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.8631434088) : 0.000);
        dst[ 9] = alphaBlend(dst[ 9], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.2306749731) : 0.000);
        dst[10] = alphaBlend(dst[10], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 1.000 : ((haveSteepLine) ? 0.250 : 0.125)) : 0.000);
        dst[11] = alphaBlend(dst[11], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.750 : 0.000);
        dst[12] = alphaBlend(dst[12], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[20] = alphaBlend(dst[20], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);

        // Block 3: top-left corner (blendResult.x), 180 deg rotation
        fg = DistYCbCr(src[5], src[8]);
        hc = DistYCbCr(src[7], src[4]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[8]) && (src[1] != src[8]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[4]) && (src[3] != src[4]);
        needBlend = (blendResult.x != BLEND_NONE);
        doLineBlend = (blendResult.x >= BLEND_DOMINANT || !((blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && !IsPixEqual(src[0], src[6]))));
        blendPix = (DistYCbCr(src[0], src[5]) <= DistYCbCr(src[0], src[7])) ? src[5] : src[7];
        dst[ 5] = alphaBlend(dst[ 5], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[ 6] = alphaBlend(dst[ 6], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 2.0/3.0 : 0.750) : ((haveSteepLine) ? 0.750 : 0.125)) : 0.000);
        dst[ 7] = alphaBlend(dst[ 7], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[17] = alphaBlend(dst[17], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.750 : 0.000);
        dst[18] = alphaBlend(dst[18], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 1.000 : ((haveShallowLine) ? 0.250 : 0.125)) : 0.000);
        dst[19] = alphaBlend(dst[19], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.2306749731) : 0.000);
        dst[20] = alphaBlend(dst[20], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.8631434088) : 0.000);
        dst[21] = alphaBlend(dst[21], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.2306749731) : 0.000);
        dst[22] = alphaBlend(dst[22], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 1.000 : ((haveSteepLine) ? 0.250 : 0.125)) : 0.000);
        dst[23] = alphaBlend(dst[23], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.750 : 0.000);
        dst[24] = alphaBlend(dst[24], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[16] = alphaBlend(dst[16], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);

        // Block 4: bottom-left corner (blendResult.w), 270 deg rotation
        fg = DistYCbCr(src[3], src[6]);
        hc = DistYCbCr(src[5], src[2]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[6]) && (src[7] != src[6]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[2]) && (src[1] != src[2]);
        needBlend = (blendResult.w != BLEND_NONE);
        doLineBlend = (blendResult.w >= BLEND_DOMINANT || !((blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && !IsPixEqual(src[0], src[4]))));
        blendPix = (DistYCbCr(src[0], src[3]) <= DistYCbCr(src[0], src[5])) ? src[3] : src[5];
        dst[ 3] = alphaBlend(dst[ 3], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[ 4] = alphaBlend(dst[ 4], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? ((haveSteepLine) ? 2.0/3.0 : 0.750) : ((haveSteepLine) ? 0.750 : 0.125)) : 0.000);
        dst[ 5] = alphaBlend(dst[ 5], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[13] = alphaBlend(dst[13], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.750 : 0.000);
        dst[14] = alphaBlend(dst[14], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 1.000 : ((haveShallowLine) ? 0.250 : 0.125)) : 0.000);
        dst[15] = alphaBlend(dst[15], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.2306749731) : 0.000);
        dst[16] = alphaBlend(dst[16], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.8631434088) : 0.000);
        dst[17] = alphaBlend(dst[17], blendPix, (needBlend) ? ((doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.875 : 1.000) : 0.2306749731) : 0.000);
        dst[18] = alphaBlend(dst[18], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 1.000 : ((haveSteepLine) ? 0.250 : 0.125)) : 0.000);
        dst[19] = alphaBlend(dst[19], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.750 : 0.000);
        dst[20] = alphaBlend(dst[20], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[12] = alphaBlend(dst[12], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
    }

    // Output pixel mapping for 5x5 grid:
    // 20|21|22|23|24
    // 19|06|07|08|09
    // 18|05|00|01|10
    // 17|04|03|02|11
    // 16|15|14|13|12
    vec4 res = mix(
        mix(dst[20], mix(mix(dst[21], dst[22], step(0.40, f.x)), mix(dst[23], dst[24], step(0.80, f.x)), step(0.60, f.x)), step(0.20, f.x)),
        mix(
            mix(
                mix(dst[19], mix(mix(dst[ 6], dst[ 7], step(0.40, f.x)), mix(dst[ 8], dst[ 9], step(0.80, f.x)), step(0.60, f.x)), step(0.20, f.x)),
                mix(dst[18], mix(mix(dst[ 5], dst[ 0], step(0.40, f.x)), mix(dst[ 1], dst[10], step(0.80, f.x)), step(0.60, f.x)), step(0.20, f.x)),
                step(0.40, f.y)
            ),
            mix(
                mix(dst[17], mix(mix(dst[ 4], dst[ 3], step(0.40, f.x)), mix(dst[ 2], dst[11], step(0.80, f.x)), step(0.60, f.x)), step(0.20, f.x)),
                mix(dst[16], mix(mix(dst[15], dst[14], step(0.40, f.x)), mix(dst[13], dst[12], step(0.80, f.x)), step(0.60, f.x)), step(0.20, f.x)),
                step(0.80, f.y)
            ),
            step(0.60, f.y)
        ),
        step(0.20, f.y)
    );

    FragColor = res;
}`;
export const XBRZ_FRAG_6X = FRAG_HEADER + `
const float one_sixth = 1.0 / 6.0;
const float two_sixth = 2.0 / 6.0;
const float four_sixth = 4.0 / 6.0;
const float five_sixth = 5.0 / 6.0;

void main() {
    vec2 f = fract(vTexCoord * uInputRes);
    vec4 src[25];
    src[21] = texture(uTex, t1.xw); src[22] = texture(uTex, t1.yw); src[23] = texture(uTex, t1.zw);
    src[ 6] = texture(uTex, t2.xw); src[ 7] = texture(uTex, t2.yw); src[ 8] = texture(uTex, t2.zw);
    src[ 5] = texture(uTex, t3.xw); src[ 0] = texture(uTex, t3.yw); src[ 1] = texture(uTex, t3.zw);
    src[ 4] = texture(uTex, t4.xw); src[ 3] = texture(uTex, t4.yw); src[ 2] = texture(uTex, t4.zw);
    src[15] = texture(uTex, t5.xw); src[14] = texture(uTex, t5.yw); src[13] = texture(uTex, t5.zw);
    src[19] = texture(uTex, t6.xy); src[18] = texture(uTex, t6.xz); src[17] = texture(uTex, t6.xw);
    src[ 9] = texture(uTex, t7.xy); src[10] = texture(uTex, t7.xz); src[11] = texture(uTex, t7.xw);


    ivec4 blendResult = ivec4(BLEND_NONE);

    // Corner (1, 1) - bottom-right
    if (!((src[0] == src[1] && src[3] == src[2]) || (src[0] == src[3] && src[1] == src[2]))) {
        float d1 = DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + DistYCbCr(src[14], src[2]) + DistYCbCr(src[2], src[10]) + (uCenterDirectionBias * DistYCbCr(src[3], src[1]));
        float d2 = DistYCbCr(src[5], src[3]) + DistYCbCr(src[3], src[13]) + DistYCbCr(src[7], src[1]) + DistYCbCr(src[1], src[11]) + (uCenterDirectionBias * DistYCbCr(src[0], src[2]));
        blendResult.z = ((d1 < d2) && (src[0] != src[1]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (0, 1) - bottom-left
    if (!((src[5] == src[0] && src[4] == src[3]) || (src[5] == src[4] && src[0] == src[3]))) {
        float d1 = DistYCbCr(src[17], src[5]) + DistYCbCr(src[5], src[7]) + DistYCbCr(src[15], src[3]) + DistYCbCr(src[3], src[1]) + (uCenterDirectionBias * DistYCbCr(src[4], src[0]));
        float d2 = DistYCbCr(src[18], src[4]) + DistYCbCr(src[4], src[14]) + DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + (uCenterDirectionBias * DistYCbCr(src[5], src[3]));
        blendResult.w = ((d1 > d2) && (src[0] != src[5]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (1, 0) - top-right
    if (!((src[7] == src[8] && src[0] == src[1]) || (src[7] == src[0] && src[8] == src[1]))) {
        float d1 = DistYCbCr(src[5], src[7]) + DistYCbCr(src[7], src[23]) + DistYCbCr(src[3], src[1]) + DistYCbCr(src[1], src[9]) + (uCenterDirectionBias * DistYCbCr(src[0], src[8]));
        float d2 = DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + DistYCbCr(src[22], src[8]) + DistYCbCr(src[8], src[10]) + (uCenterDirectionBias * DistYCbCr(src[7], src[1]));
        blendResult.y = ((d1 > d2) && (src[0] != src[7]) && (src[0] != src[1])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (0, 0) - top-left
    if (!((src[6] == src[7] && src[5] == src[0]) || (src[6] == src[5] && src[7] == src[0]))) {
        float d1 = DistYCbCr(src[18], src[6]) + DistYCbCr(src[6], src[22]) + DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + (uCenterDirectionBias * DistYCbCr(src[5], src[7]));
        float d2 = DistYCbCr(src[19], src[5]) + DistYCbCr(src[5], src[3]) + DistYCbCr(src[21], src[7]) + DistYCbCr(src[7], src[1]) + (uCenterDirectionBias * DistYCbCr(src[6], src[0]));
        blendResult.x = ((d1 < d2) && (src[0] != src[5]) && (src[0] != src[7])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }

    vec4 dst[36];
    for (int i = 0; i < 36; i++) dst[i] = src[0];

    if (IsBlendingNeeded(blendResult)) {
        // Block 1: bottom-right corner (blendResult.z), 0 deg rotation
        float fg = DistYCbCr(src[1], src[4]);
        float hc = DistYCbCr(src[3], src[8]);
        bool haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[4]) && (src[5] != src[4]);
        bool haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[8]) && (src[7] != src[8]);
        bool needBlend = (blendResult.z != BLEND_NONE);
        bool doLineBlend = (blendResult.z >= BLEND_DOMINANT || !((blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && !IsPixEqual(src[0], src[2]))));
        vec4 blendPix = (DistYCbCr(src[0], src[1]) <= DistYCbCr(src[0], src[3])) ? src[1] : src[3];
        dst[10] = alphaBlend(dst[10], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[11] = alphaBlend(dst[11], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 0.750 : ((haveShallowLine) ? 0.250 : 0.000)) : 0.000);
        dst[12] = alphaBlend(dst[12], blendPix, (needBlend && doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.500 : 1.000) : 0.000);
        dst[13] = alphaBlend(dst[13], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 0.750 : ((haveSteepLine) ? 0.250 : 0.000)) : 0.000);
        dst[14] = alphaBlend(dst[14], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[25] = alphaBlend(dst[25], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[26] = alphaBlend(dst[26], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.750 : 0.000);
        dst[27] = alphaBlend(dst[27], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 1.000 : 0.000);
        dst[28] = alphaBlend(dst[28], blendPix, (needBlend) ? ((doLineBlend) ? ((haveSteepLine) ? 1.000 : ((haveShallowLine) ? 0.750 : 0.500)) : 0.05652034508) : 0.000);
        dst[29] = alphaBlend(dst[29], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.4236372243) : 0.000);
        dst[30] = alphaBlend(dst[30], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.9711013910) : 0.000);
        dst[31] = alphaBlend(dst[31], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.4236372243) : 0.000);
        dst[32] = alphaBlend(dst[32], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? 1.000 : ((haveSteepLine) ? 0.750 : 0.500)) : 0.05652034508) : 0.000);
        dst[33] = alphaBlend(dst[33], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 1.000 : 0.000);
        dst[34] = alphaBlend(dst[34], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.750 : 0.000);
        dst[35] = alphaBlend(dst[35], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);

        // Block 2: top-right corner (blendResult.y), 90 deg rotation
        fg = DistYCbCr(src[7], src[2]);
        hc = DistYCbCr(src[1], src[6]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[2]) && (src[3] != src[2]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[6]) && (src[5] != src[6]);
        needBlend = (blendResult.y != BLEND_NONE);
        doLineBlend = (blendResult.y >= BLEND_DOMINANT || !((blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && !IsPixEqual(src[0], src[8]))));
        blendPix = (DistYCbCr(src[0], src[7]) <= DistYCbCr(src[0], src[1])) ? src[7] : src[1];
        dst[ 7] = alphaBlend(dst[ 7], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[ 8] = alphaBlend(dst[ 8], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 0.750 : ((haveShallowLine) ? 0.250 : 0.000)) : 0.000);
        dst[ 9] = alphaBlend(dst[ 9], blendPix, (needBlend && doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.500 : 1.000) : 0.000);
        dst[10] = alphaBlend(dst[10], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 0.750 : ((haveSteepLine) ? 0.250 : 0.000)) : 0.000);
        dst[11] = alphaBlend(dst[11], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[20] = alphaBlend(dst[20], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[21] = alphaBlend(dst[21], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.750 : 0.000);
        dst[22] = alphaBlend(dst[22], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 1.000 : 0.000);
        dst[23] = alphaBlend(dst[23], blendPix, (needBlend) ? ((doLineBlend) ? ((haveSteepLine) ? 1.000 : ((haveShallowLine) ? 0.750 : 0.500)) : 0.05652034508) : 0.000);
        dst[24] = alphaBlend(dst[24], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.4236372243) : 0.000);
        dst[25] = alphaBlend(dst[25], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.9711013910) : 0.000);
        dst[26] = alphaBlend(dst[26], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.4236372243) : 0.000);
        dst[27] = alphaBlend(dst[27], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? 1.000 : ((haveSteepLine) ? 0.750 : 0.500)) : 0.05652034508) : 0.000);
        dst[28] = alphaBlend(dst[28], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 1.000 : 0.000);
        dst[29] = alphaBlend(dst[29], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.750 : 0.000);
        dst[30] = alphaBlend(dst[30], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);

        // Block 3: top-left corner (blendResult.x), 180 deg rotation
        fg = DistYCbCr(src[5], src[8]);
        hc = DistYCbCr(src[7], src[4]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[8]) && (src[1] != src[8]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[4]) && (src[3] != src[4]);
        needBlend = (blendResult.x != BLEND_NONE);
        doLineBlend = (blendResult.x >= BLEND_DOMINANT || !((blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && !IsPixEqual(src[0], src[6]))));
        blendPix = (DistYCbCr(src[0], src[5]) <= DistYCbCr(src[0], src[7])) ? src[5] : src[7];
        dst[ 4] = alphaBlend(dst[ 4], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[ 5] = alphaBlend(dst[ 5], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 0.750 : ((haveShallowLine) ? 0.250 : 0.000)) : 0.000);
        dst[ 6] = alphaBlend(dst[ 6], blendPix, (needBlend && doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.500 : 1.000) : 0.000);
        dst[ 7] = alphaBlend(dst[ 7], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 0.750 : ((haveSteepLine) ? 0.250 : 0.000)) : 0.000);
        dst[ 8] = alphaBlend(dst[ 8], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[35] = alphaBlend(dst[35], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[16] = alphaBlend(dst[16], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.750 : 0.000);
        dst[17] = alphaBlend(dst[17], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 1.000 : 0.000);
        dst[18] = alphaBlend(dst[18], blendPix, (needBlend) ? ((doLineBlend) ? ((haveSteepLine) ? 1.000 : ((haveShallowLine) ? 0.750 : 0.500)) : 0.05652034508) : 0.000);
        dst[19] = alphaBlend(dst[19], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.4236372243) : 0.000);
        dst[20] = alphaBlend(dst[20], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.9711013910) : 0.000);
        dst[21] = alphaBlend(dst[21], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.4236372243) : 0.000);
        dst[22] = alphaBlend(dst[22], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? 1.000 : ((haveSteepLine) ? 0.750 : 0.500)) : 0.05652034508) : 0.000);
        dst[23] = alphaBlend(dst[23], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 1.000 : 0.000);
        dst[24] = alphaBlend(dst[24], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.750 : 0.000);
        dst[25] = alphaBlend(dst[25], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);

        // Block 4: bottom-left corner (blendResult.w), 270 deg rotation
        fg = DistYCbCr(src[3], src[6]);
        hc = DistYCbCr(src[5], src[2]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[6]) && (src[7] != src[6]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[2]) && (src[1] != src[2]);
        needBlend = (blendResult.w != BLEND_NONE);
        doLineBlend = (blendResult.w >= BLEND_DOMINANT || !((blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && !IsPixEqual(src[0], src[4]))));
        blendPix = (DistYCbCr(src[0], src[3]) <= DistYCbCr(src[0], src[5])) ? src[3] : src[5];
        dst[13] = alphaBlend(dst[13], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[14] = alphaBlend(dst[14], blendPix, (needBlend && doLineBlend) ? ((haveSteepLine) ? 0.750 : ((haveShallowLine) ? 0.250 : 0.000)) : 0.000);
        dst[15] = alphaBlend(dst[15], blendPix, (needBlend && doLineBlend) ? ((!haveShallowLine && !haveSteepLine) ? 0.500 : 1.000) : 0.000);
        dst[ 4] = alphaBlend(dst[ 4], blendPix, (needBlend && doLineBlend) ? ((haveShallowLine) ? 0.750 : ((haveSteepLine) ? 0.250 : 0.000)) : 0.000);
        dst[ 5] = alphaBlend(dst[ 5], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
        dst[30] = alphaBlend(dst[30], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.250 : 0.000);
        dst[31] = alphaBlend(dst[31], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 0.750 : 0.000);
        dst[32] = alphaBlend(dst[32], blendPix, (needBlend && doLineBlend && haveSteepLine) ? 1.000 : 0.000);
        dst[33] = alphaBlend(dst[33], blendPix, (needBlend) ? ((doLineBlend) ? ((haveSteepLine) ? 1.000 : ((haveShallowLine) ? 0.750 : 0.500)) : 0.05652034508) : 0.000);
        dst[34] = alphaBlend(dst[34], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.4236372243) : 0.000);
        dst[35] = alphaBlend(dst[35], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.9711013910) : 0.000);
        dst[16] = alphaBlend(dst[16], blendPix, (needBlend) ? ((doLineBlend) ? 1.000 : 0.4236372243) : 0.000);
        dst[17] = alphaBlend(dst[17], blendPix, (needBlend) ? ((doLineBlend) ? ((haveShallowLine) ? 1.000 : ((haveSteepLine) ? 0.750 : 0.500)) : 0.05652034508) : 0.000);
        dst[18] = alphaBlend(dst[18], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 1.000 : 0.000);
        dst[19] = alphaBlend(dst[19], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.750 : 0.000);
        dst[20] = alphaBlend(dst[20], blendPix, (needBlend && doLineBlend && haveShallowLine) ? 0.250 : 0.000);
    }

    // Output pixel mapping for 6x6 grid:
    // 20|21|22|23|24|25
    // 19|06|07|08|09|26
    // 18|05|00|01|10|27
    // 17|04|03|02|11|28
    // 16|15|14|13|12|29
    // 35|34|33|32|31|30
    vec4 res = mix(
        mix(
            mix(
                mix(mix(dst[20], dst[21], step(one_sixth, f.x)), dst[22], step(two_sixth, f.x)),
                mix(mix(dst[23], dst[24], step(four_sixth, f.x)), dst[25], step(five_sixth, f.x)),
                step(0.50, f.x)
            ),
            mix(
                mix(mix(dst[19], dst[ 6], step(one_sixth, f.x)), dst[ 7], step(two_sixth, f.x)),
                mix(mix(dst[ 8], dst[ 9], step(four_sixth, f.x)), dst[26], step(five_sixth, f.x)),
                step(0.50, f.x)
            ),
            step(one_sixth, f.y)
        ),
        mix(
            mix(
                mix(mix(dst[18], dst[ 5], step(one_sixth, f.x)), dst[ 0], step(two_sixth, f.x)),
                mix(mix(dst[ 1], dst[10], step(four_sixth, f.x)), dst[27], step(five_sixth, f.x)),
                step(0.50, f.x)
            ),
            mix(
                mix(
                    mix(
                        mix(mix(dst[17], dst[ 4], step(one_sixth, f.x)), dst[ 3], step(two_sixth, f.x)),
                        mix(mix(dst[ 2], dst[11], step(four_sixth, f.x)), dst[28], step(five_sixth, f.x)),
                        step(0.50, f.x)
                    ),
                    mix(
                        mix(mix(dst[16], dst[15], step(one_sixth, f.x)), dst[14], step(two_sixth, f.x)),
                        mix(mix(dst[13], dst[12], step(four_sixth, f.x)), dst[29], step(five_sixth, f.x)),
                        step(0.50, f.x)
                    ),
                    step(four_sixth, f.y)
                ),
                mix(
                    mix(mix(dst[35], dst[34], step(one_sixth, f.x)), dst[33], step(two_sixth, f.x)),
                    mix(mix(dst[32], dst[31], step(four_sixth, f.x)), dst[30], step(five_sixth, f.x)),
                    step(0.50, f.x)
                ),
                step(five_sixth, f.y)
            ),
            step(0.50, f.y)
        ),
        step(two_sixth, f.y)
    );

    FragColor = res;
}`;
export const XBRZ_FRAG_7X = FRAG_HEADER + `
// 7x per-subpixel blend weights, row-major over the 7x7 destination block
// (index = row * scale + col), canonical rotation = bottom-right corner.
// Derived from the same cut geometry that yields the hand-written 2x-6x
// weights: shallow line y = 1 - x/2, steep line x = 1 - y/2, diagonal cut
// x + y = 3/2, corner = area beyond the circle of radius 1/2 inscribed in
// the source pixel. Instead of compositing a dst[49] register array like
// the smaller scales, each fragment looks up the weight of its own subpixel
// per rotation - identical output, far lower register pressure.
// shallow line
const float SH7[49] = float[49](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25,
    0.0, 0.0, 0.0, 0.0, 0.25, 0.75, 1.0,
    0.0, 0.0, 0.25, 0.75, 1.0, 1.0, 1.0,
    0.25, 0.75, 1.0, 1.0, 1.0, 1.0, 1.0
);
// steep line
const float ST7[49] = float[49](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.75,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.75, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.25, 1.0, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.75, 1.0, 1.0,
    0.0, 0.0, 0.0, 0.25, 1.0, 1.0, 1.0
);
// steep + shallow (exact union)
const float SS7[49] = float[49](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.75,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.75, 1.0,
    0.0, 0.0, 0.0, 0.0, 1.0/3.0, 1.0, 1.0,
    0.0, 0.0, 0.25, 0.75, 1.0, 1.0, 1.0,
    0.25, 0.75, 1.0, 1.0, 1.0, 1.0, 1.0
);
// 45-degree diagonal
const float DG7[49] = float[49](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.125,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.125, 0.875,
    0.0, 0.0, 0.0, 0.0, 0.125, 0.875, 1.0,
    0.0, 0.0, 0.0, 0.125, 0.875, 1.0, 1.0
);
// rounded corner
const float CO7[49] = float[49](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1594908733,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.6483411570,
    0.0, 0.0, 0.0, 0.0, 0.1594908733, 0.6483411570, 1.0
);

void main() {
    vec2 f = fract(vTexCoord * uInputRes);
    // Destination subpixel of the 7x7 block this fragment belongs to.
    ivec2 p = min(ivec2(f * 7.0), ivec2(6));

    vec4 src[25];
    src[21] = texture(uTex, t1.xw); src[22] = texture(uTex, t1.yw); src[23] = texture(uTex, t1.zw);
    src[ 6] = texture(uTex, t2.xw); src[ 7] = texture(uTex, t2.yw); src[ 8] = texture(uTex, t2.zw);
    src[ 5] = texture(uTex, t3.xw); src[ 0] = texture(uTex, t3.yw); src[ 1] = texture(uTex, t3.zw);
    src[ 4] = texture(uTex, t4.xw); src[ 3] = texture(uTex, t4.yw); src[ 2] = texture(uTex, t4.zw);
    src[15] = texture(uTex, t5.xw); src[14] = texture(uTex, t5.yw); src[13] = texture(uTex, t5.zw);
    src[19] = texture(uTex, t6.xy); src[18] = texture(uTex, t6.xz); src[17] = texture(uTex, t6.xw);
    src[ 9] = texture(uTex, t7.xy); src[10] = texture(uTex, t7.xz); src[11] = texture(uTex, t7.xw);

    ivec4 blendResult = ivec4(BLEND_NONE);

    // Corner (1, 1) - bottom-right
    if (!((src[0] == src[1] && src[3] == src[2]) || (src[0] == src[3] && src[1] == src[2]))) {
        float d1 = DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + DistYCbCr(src[14], src[2]) + DistYCbCr(src[2], src[10]) + (uCenterDirectionBias * DistYCbCr(src[3], src[1]));
        float d2 = DistYCbCr(src[5], src[3]) + DistYCbCr(src[3], src[13]) + DistYCbCr(src[7], src[1]) + DistYCbCr(src[1], src[11]) + (uCenterDirectionBias * DistYCbCr(src[0], src[2]));
        blendResult.z = ((d1 < d2) && (src[0] != src[1]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (0, 1) - bottom-left
    if (!((src[5] == src[0] && src[4] == src[3]) || (src[5] == src[4] && src[0] == src[3]))) {
        float d1 = DistYCbCr(src[17], src[5]) + DistYCbCr(src[5], src[7]) + DistYCbCr(src[15], src[3]) + DistYCbCr(src[3], src[1]) + (uCenterDirectionBias * DistYCbCr(src[4], src[0]));
        float d2 = DistYCbCr(src[18], src[4]) + DistYCbCr(src[4], src[14]) + DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + (uCenterDirectionBias * DistYCbCr(src[5], src[3]));
        blendResult.w = ((d1 > d2) && (src[0] != src[5]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (1, 0) - top-right
    if (!((src[7] == src[8] && src[0] == src[1]) || (src[7] == src[0] && src[8] == src[1]))) {
        float d1 = DistYCbCr(src[5], src[7]) + DistYCbCr(src[7], src[23]) + DistYCbCr(src[3], src[1]) + DistYCbCr(src[1], src[9]) + (uCenterDirectionBias * DistYCbCr(src[0], src[8]));
        float d2 = DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + DistYCbCr(src[22], src[8]) + DistYCbCr(src[8], src[10]) + (uCenterDirectionBias * DistYCbCr(src[7], src[1]));
        blendResult.y = ((d1 > d2) && (src[0] != src[7]) && (src[0] != src[1])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (0, 0) - top-left
    if (!((src[6] == src[7] && src[5] == src[0]) || (src[6] == src[5] && src[7] == src[0]))) {
        float d1 = DistYCbCr(src[18], src[6]) + DistYCbCr(src[6], src[22]) + DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + (uCenterDirectionBias * DistYCbCr(src[5], src[7]));
        float d2 = DistYCbCr(src[19], src[5]) + DistYCbCr(src[5], src[3]) + DistYCbCr(src[21], src[7]) + DistYCbCr(src[7], src[1]) + (uCenterDirectionBias * DistYCbCr(src[6], src[0]));
        blendResult.x = ((d1 < d2) && (src[0] != src[5]) && (src[0] != src[7])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }

    vec4 res = src[0];

    if (IsBlendingNeeded(blendResult)) {
        // Block 1: bottom-right corner (blendResult.z), 0 deg rotation
        float fg = DistYCbCr(src[1], src[4]);
        float hc = DistYCbCr(src[3], src[8]);
        bool haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[4]) && (src[5] != src[4]);
        bool haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[8]) && (src[7] != src[8]);
        bool needBlend = (blendResult.z != BLEND_NONE);
        bool doLineBlend = (blendResult.z >= BLEND_DOMINANT || !((blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && !IsPixEqual(src[0], src[2]))));
        vec4 blendPix = (DistYCbCr(src[0], src[1]) <= DistYCbCr(src[0], src[3])) ? src[1] : src[3];
        int idx = p.y * 7 + p.x;
        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS7[idx] : SH7[idx]) : (haveSteepLine ? ST7[idx] : DG7[idx])) : CO7[idx]) : 0.0);

        // Block 2: top-right corner (blendResult.y), 90 deg rotation
        fg = DistYCbCr(src[7], src[2]);
        hc = DistYCbCr(src[1], src[6]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[2]) && (src[3] != src[2]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[6]) && (src[5] != src[6]);
        needBlend = (blendResult.y != BLEND_NONE);
        doLineBlend = (blendResult.y >= BLEND_DOMINANT || !((blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && !IsPixEqual(src[0], src[8]))));
        blendPix = (DistYCbCr(src[0], src[7]) <= DistYCbCr(src[0], src[1])) ? src[7] : src[1];
        idx = p.x * 7 + (6 - p.y);
        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS7[idx] : SH7[idx]) : (haveSteepLine ? ST7[idx] : DG7[idx])) : CO7[idx]) : 0.0);

        // Block 3: top-left corner (blendResult.x), 180 deg rotation
        fg = DistYCbCr(src[5], src[8]);
        hc = DistYCbCr(src[7], src[4]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[8]) && (src[1] != src[8]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[4]) && (src[3] != src[4]);
        needBlend = (blendResult.x != BLEND_NONE);
        doLineBlend = (blendResult.x >= BLEND_DOMINANT || !((blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && !IsPixEqual(src[0], src[6]))));
        blendPix = (DistYCbCr(src[0], src[5]) <= DistYCbCr(src[0], src[7])) ? src[5] : src[7];
        idx = (6 - p.y) * 7 + (6 - p.x);
        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS7[idx] : SH7[idx]) : (haveSteepLine ? ST7[idx] : DG7[idx])) : CO7[idx]) : 0.0);

        // Block 4: bottom-left corner (blendResult.w), 270 deg rotation
        fg = DistYCbCr(src[3], src[6]);
        hc = DistYCbCr(src[5], src[2]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[6]) && (src[7] != src[6]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[2]) && (src[1] != src[2]);
        needBlend = (blendResult.w != BLEND_NONE);
        doLineBlend = (blendResult.w >= BLEND_DOMINANT || !((blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && !IsPixEqual(src[0], src[4]))));
        blendPix = (DistYCbCr(src[0], src[3]) <= DistYCbCr(src[0], src[5])) ? src[3] : src[5];
        idx = (6 - p.x) * 7 + p.y;
        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS7[idx] : SH7[idx]) : (haveSteepLine ? ST7[idx] : DG7[idx])) : CO7[idx]) : 0.0);
    }

    FragColor = res;
}`;
export const XBRZ_FRAG_8X = FRAG_HEADER + `
// 8x per-subpixel blend weights, row-major over the 8x8 destination block
// (index = row * scale + col), canonical rotation = bottom-right corner.
// Derived from the same cut geometry that yields the hand-written 2x-6x
// weights: shallow line y = 1 - x/2, steep line x = 1 - y/2, diagonal cut
// x + y = 3/2, corner = area beyond the circle of radius 1/2 inscribed in
// the source pixel. Instead of compositing a dst[64] register array like
// the smaller scales, each fragment looks up the weight of its own subpixel
// per rotation - identical output, far lower register pressure.
// shallow line
const float SH8[64] = float[64](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 0.75,
    0.0, 0.0, 0.0, 0.0, 0.25, 0.75, 1.0, 1.0,
    0.0, 0.0, 0.25, 0.75, 1.0, 1.0, 1.0, 1.0,
    0.25, 0.75, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
);
// steep line
const float ST8[64] = float[64](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.75,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.75, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 1.0, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.75, 1.0, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.25, 1.0, 1.0, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.75, 1.0, 1.0, 1.0
);
// steep + shallow (exact union)
const float SS8[64] = float[64](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.75,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.75, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 1.0, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.25, 5.0/6.0, 1.0, 1.0,
    0.0, 0.0, 0.25, 0.75, 1.0, 1.0, 1.0, 1.0,
    0.25, 0.75, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
);
// 45-degree diagonal
const float DG8[64] = float[64](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.0,
    0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0
);
// rounded corner
const float CO8[64] = float[64](
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0420662858,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3050418943,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0601234175, 0.8396448040,
    0.0, 0.0, 0.0, 0.0, 0.0420662858, 0.3050418943, 0.8396448040, 1.0
);

void main() {
    vec2 f = fract(vTexCoord * uInputRes);
    // Destination subpixel of the 8x8 block this fragment belongs to.
    ivec2 p = min(ivec2(f * 8.0), ivec2(7));

    vec4 src[25];
    src[21] = texture(uTex, t1.xw); src[22] = texture(uTex, t1.yw); src[23] = texture(uTex, t1.zw);
    src[ 6] = texture(uTex, t2.xw); src[ 7] = texture(uTex, t2.yw); src[ 8] = texture(uTex, t2.zw);
    src[ 5] = texture(uTex, t3.xw); src[ 0] = texture(uTex, t3.yw); src[ 1] = texture(uTex, t3.zw);
    src[ 4] = texture(uTex, t4.xw); src[ 3] = texture(uTex, t4.yw); src[ 2] = texture(uTex, t4.zw);
    src[15] = texture(uTex, t5.xw); src[14] = texture(uTex, t5.yw); src[13] = texture(uTex, t5.zw);
    src[19] = texture(uTex, t6.xy); src[18] = texture(uTex, t6.xz); src[17] = texture(uTex, t6.xw);
    src[ 9] = texture(uTex, t7.xy); src[10] = texture(uTex, t7.xz); src[11] = texture(uTex, t7.xw);

    ivec4 blendResult = ivec4(BLEND_NONE);

    // Corner (1, 1) - bottom-right
    if (!((src[0] == src[1] && src[3] == src[2]) || (src[0] == src[3] && src[1] == src[2]))) {
        float d1 = DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + DistYCbCr(src[14], src[2]) + DistYCbCr(src[2], src[10]) + (uCenterDirectionBias * DistYCbCr(src[3], src[1]));
        float d2 = DistYCbCr(src[5], src[3]) + DistYCbCr(src[3], src[13]) + DistYCbCr(src[7], src[1]) + DistYCbCr(src[1], src[11]) + (uCenterDirectionBias * DistYCbCr(src[0], src[2]));
        blendResult.z = ((d1 < d2) && (src[0] != src[1]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (0, 1) - bottom-left
    if (!((src[5] == src[0] && src[4] == src[3]) || (src[5] == src[4] && src[0] == src[3]))) {
        float d1 = DistYCbCr(src[17], src[5]) + DistYCbCr(src[5], src[7]) + DistYCbCr(src[15], src[3]) + DistYCbCr(src[3], src[1]) + (uCenterDirectionBias * DistYCbCr(src[4], src[0]));
        float d2 = DistYCbCr(src[18], src[4]) + DistYCbCr(src[4], src[14]) + DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + (uCenterDirectionBias * DistYCbCr(src[5], src[3]));
        blendResult.w = ((d1 > d2) && (src[0] != src[5]) && (src[0] != src[3])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (1, 0) - top-right
    if (!((src[7] == src[8] && src[0] == src[1]) || (src[7] == src[0] && src[8] == src[1]))) {
        float d1 = DistYCbCr(src[5], src[7]) + DistYCbCr(src[7], src[23]) + DistYCbCr(src[3], src[1]) + DistYCbCr(src[1], src[9]) + (uCenterDirectionBias * DistYCbCr(src[0], src[8]));
        float d2 = DistYCbCr(src[6], src[0]) + DistYCbCr(src[0], src[2]) + DistYCbCr(src[22], src[8]) + DistYCbCr(src[8], src[10]) + (uCenterDirectionBias * DistYCbCr(src[7], src[1]));
        blendResult.y = ((d1 > d2) && (src[0] != src[7]) && (src[0] != src[1])) ? (((uDominantDirectionThreshold * d2) < d1) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }
    // Corner (0, 0) - top-left
    if (!((src[6] == src[7] && src[5] == src[0]) || (src[6] == src[5] && src[7] == src[0]))) {
        float d1 = DistYCbCr(src[18], src[6]) + DistYCbCr(src[6], src[22]) + DistYCbCr(src[4], src[0]) + DistYCbCr(src[0], src[8]) + (uCenterDirectionBias * DistYCbCr(src[5], src[7]));
        float d2 = DistYCbCr(src[19], src[5]) + DistYCbCr(src[5], src[3]) + DistYCbCr(src[21], src[7]) + DistYCbCr(src[7], src[1]) + (uCenterDirectionBias * DistYCbCr(src[6], src[0]));
        blendResult.x = ((d1 < d2) && (src[0] != src[5]) && (src[0] != src[7])) ? (((uDominantDirectionThreshold * d1) < d2) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
    }

    vec4 res = src[0];

    if (IsBlendingNeeded(blendResult)) {
        // Block 1: bottom-right corner (blendResult.z), 0 deg rotation
        float fg = DistYCbCr(src[1], src[4]);
        float hc = DistYCbCr(src[3], src[8]);
        bool haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[4]) && (src[5] != src[4]);
        bool haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[8]) && (src[7] != src[8]);
        bool needBlend = (blendResult.z != BLEND_NONE);
        bool doLineBlend = (blendResult.z >= BLEND_DOMINANT || !((blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && !IsPixEqual(src[0], src[2]))));
        vec4 blendPix = (DistYCbCr(src[0], src[1]) <= DistYCbCr(src[0], src[3])) ? src[1] : src[3];
        int idx = p.y * 8 + p.x;
        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS8[idx] : SH8[idx]) : (haveSteepLine ? ST8[idx] : DG8[idx])) : CO8[idx]) : 0.0);

        // Block 2: top-right corner (blendResult.y), 90 deg rotation
        fg = DistYCbCr(src[7], src[2]);
        hc = DistYCbCr(src[1], src[6]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[2]) && (src[3] != src[2]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[6]) && (src[5] != src[6]);
        needBlend = (blendResult.y != BLEND_NONE);
        doLineBlend = (blendResult.y >= BLEND_DOMINANT || !((blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && !IsPixEqual(src[0], src[8]))));
        blendPix = (DistYCbCr(src[0], src[7]) <= DistYCbCr(src[0], src[1])) ? src[7] : src[1];
        idx = p.x * 8 + (7 - p.y);
        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS8[idx] : SH8[idx]) : (haveSteepLine ? ST8[idx] : DG8[idx])) : CO8[idx]) : 0.0);

        // Block 3: top-left corner (blendResult.x), 180 deg rotation
        fg = DistYCbCr(src[5], src[8]);
        hc = DistYCbCr(src[7], src[4]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[8]) && (src[1] != src[8]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[4]) && (src[3] != src[4]);
        needBlend = (blendResult.x != BLEND_NONE);
        doLineBlend = (blendResult.x >= BLEND_DOMINANT || !((blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && !IsPixEqual(src[0], src[6]))));
        blendPix = (DistYCbCr(src[0], src[5]) <= DistYCbCr(src[0], src[7])) ? src[5] : src[7];
        idx = (7 - p.y) * 8 + (7 - p.x);
        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS8[idx] : SH8[idx]) : (haveSteepLine ? ST8[idx] : DG8[idx])) : CO8[idx]) : 0.0);

        // Block 4: bottom-left corner (blendResult.w), 270 deg rotation
        fg = DistYCbCr(src[3], src[6]);
        hc = DistYCbCr(src[5], src[2]);
        haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && (src[0] != src[6]) && (src[7] != src[6]);
        haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && (src[0] != src[2]) && (src[1] != src[2]);
        needBlend = (blendResult.w != BLEND_NONE);
        doLineBlend = (blendResult.w >= BLEND_DOMINANT || !((blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && !IsPixEqual(src[0], src[4]))));
        blendPix = (DistYCbCr(src[0], src[3]) <= DistYCbCr(src[0], src[5])) ? src[3] : src[5];
        idx = (7 - p.x) * 8 + p.y;
        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS8[idx] : SH8[idx]) : (haveSteepLine ? ST8[idx] : DG8[idx])) : CO8[idx]) : 0.0);
    }

    FragColor = res;
}`;
//# sourceMappingURL=xbrz-shaders.js.map