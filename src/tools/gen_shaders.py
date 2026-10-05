#!/usr/bin/env python3
"""Assemble XBRZ_FRAG_7X / XBRZ_FRAG_8X from the generated weight tables.

Structure mirrors the existing per-scale shaders (identical texture loads,
corner-classification, per-rotation line detection and compositing order),
but the per-destination-subpixel weights come from five const lookup tables
instead of an unrolled dst[N*N] register array: at 7x/8x such an array
(49/64 vec4 temporaries) would spill registers on most GPUs, while the
fragment only ever needs the weight of its own subpixel.

Rotation index maps (canonical bottom-right stamp -> this fragment's
subpixel) follow matrix.rs: one CW90 step maps (i,j) -> (N-1-j, i); the
shader inverts that per block. Verified against the existing 5x shader's
ring layout (e.g. canonical (3,3) lands on ring index 8 = (1,3) in its
90-degree block).
"""

import os

# Directory holding glsl_tables_{7,8}x.txt from gen_xbrz_tables.py and
# receiving frag_{7,8}x.ts (override with XBRZ_WORK_DIR).
WORK_DIR = os.environ.get("XBRZ_WORK_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
os.makedirs(WORK_DIR, exist_ok=True)


BLOCKS = [
    # (name, blendComponent, fg, hc, shallowChecks, steepChecks, doLineBlend adj, blendPix, idx expr)
    dict(
        title="Block 1: bottom-right corner (blendResult.z), 0 deg rotation",
        comp="z",
        fg="DistYCbCr(src[1], src[4])",
        hc="DistYCbCr(src[3], src[8])",
        shallow="(src[0] != src[4]) && (src[5] != src[4])",
        steep="(src[0] != src[8]) && (src[7] != src[8])",
        dlb="(blendResult.z >= BLEND_DOMINANT || !((blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && !IsPixEqual(src[0], src[2]))))",
        pix="(DistYCbCr(src[0], src[1]) <= DistYCbCr(src[0], src[3])) ? src[1] : src[3]",
        idx="p.y * {N} + p.x",
    ),
    dict(
        title="Block 2: top-right corner (blendResult.y), 90 deg rotation",
        comp="y",
        fg="DistYCbCr(src[7], src[2])",
        hc="DistYCbCr(src[1], src[6])",
        shallow="(src[0] != src[2]) && (src[3] != src[2])",
        steep="(src[0] != src[6]) && (src[5] != src[6])",
        dlb="(blendResult.y >= BLEND_DOMINANT || !((blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (IsPixEqual(src[2], src[1]) && IsPixEqual(src[1], src[8]) && IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && !IsPixEqual(src[0], src[8]))))",
        pix="(DistYCbCr(src[0], src[7]) <= DistYCbCr(src[0], src[1])) ? src[7] : src[1]",
        idx="p.x * {N} + ({M} - p.y)",
    ),
    dict(
        title="Block 3: top-left corner (blendResult.x), 180 deg rotation",
        comp="x",
        fg="DistYCbCr(src[5], src[8])",
        hc="DistYCbCr(src[7], src[4])",
        shallow="(src[0] != src[8]) && (src[1] != src[8])",
        steep="(src[0] != src[4]) && (src[3] != src[4])",
        dlb="(blendResult.x >= BLEND_DOMINANT || !((blendResult.w != BLEND_NONE && !IsPixEqual(src[0], src[8])) || (blendResult.y != BLEND_NONE && !IsPixEqual(src[0], src[4])) || (IsPixEqual(src[8], src[7]) && IsPixEqual(src[7], src[6]) && IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && !IsPixEqual(src[0], src[6]))))",
        pix="(DistYCbCr(src[0], src[5]) <= DistYCbCr(src[0], src[7])) ? src[5] : src[7]",
        idx="({M} - p.y) * {N} + ({M} - p.x)",
    ),
    dict(
        title="Block 4: bottom-left corner (blendResult.w), 270 deg rotation",
        comp="w",
        fg="DistYCbCr(src[3], src[6])",
        hc="DistYCbCr(src[5], src[2])",
        shallow="(src[0] != src[6]) && (src[7] != src[6])",
        steep="(src[0] != src[2]) && (src[1] != src[2])",
        dlb="(blendResult.w >= BLEND_DOMINANT || !((blendResult.z != BLEND_NONE && !IsPixEqual(src[0], src[6])) || (blendResult.x != BLEND_NONE && !IsPixEqual(src[0], src[2])) || (IsPixEqual(src[6], src[5]) && IsPixEqual(src[5], src[4]) && IsPixEqual(src[4], src[3]) && IsPixEqual(src[3], src[2]) && !IsPixEqual(src[0], src[4]))))",
        pix="(DistYCbCr(src[0], src[3]) <= DistYCbCr(src[0], src[5])) ? src[3] : src[5]",
        idx="({M} - p.x) * {N} + p.y",
    ),
]

CORNER_CHECKS = """    // Corner (1, 1) - bottom-right
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
"""

SRC_LOADS = """    vec4 src[25];
    src[21] = texture(uTex, t1.xw); src[22] = texture(uTex, t1.yw); src[23] = texture(uTex, t1.zw);
    src[ 6] = texture(uTex, t2.xw); src[ 7] = texture(uTex, t2.yw); src[ 8] = texture(uTex, t2.zw);
    src[ 5] = texture(uTex, t3.xw); src[ 0] = texture(uTex, t3.yw); src[ 1] = texture(uTex, t3.zw);
    src[ 4] = texture(uTex, t4.xw); src[ 3] = texture(uTex, t4.yw); src[ 2] = texture(uTex, t4.zw);
    src[15] = texture(uTex, t5.xw); src[14] = texture(uTex, t5.yw); src[13] = texture(uTex, t5.zw);
    src[19] = texture(uTex, t6.xy); src[18] = texture(uTex, t6.xz); src[17] = texture(uTex, t6.xw);
    src[ 9] = texture(uTex, t7.xy); src[10] = texture(uTex, t7.xz); src[11] = texture(uTex, t7.xw);
"""


def build_shader(n):
    tables = open(os.path.join(WORK_DIR, f"glsl_tables_{n}x.txt")).read().rstrip()
    m = n - 1
    parts = []
    A = parts.append
    A(f"export const XBRZ_FRAG_{n}X = FRAG_HEADER + `")
    A(f"// {n}x per-subpixel blend weights, row-major over the {n}x{n} destination block")
    A("// (index = row * scale + col), canonical rotation = bottom-right corner.")
    A("// Derived from the same cut geometry that yields the hand-written 2x-6x")
    A("// weights: shallow line y = 1 - x/2, steep line x = 1 - y/2, diagonal cut")
    A("// x + y = 3/2, corner = area beyond the circle of radius 1/2 inscribed in")
    A("// the source pixel. Instead of compositing a dst[" + str(n * n) + "] register array like")
    A("// the smaller scales, each fragment looks up the weight of its own subpixel")
    A("// per rotation - identical output, far lower register pressure.")
    A(tables)
    A("")
    A("void main() {")
    A("    vec2 f = fract(vTexCoord * uInputRes);")
    A(f"    // Destination subpixel of the {n}x{n} block this fragment belongs to.")
    A(f"    ivec2 p = min(ivec2(f * {n}.0), ivec2({m}));")
    A("")
    A(SRC_LOADS)
    A("    ivec4 blendResult = ivec4(BLEND_NONE);")
    A("")
    A(CORNER_CHECKS)
    A("    vec4 res = src[0];")
    A("")
    A("    if (IsBlendingNeeded(blendResult)) {")
    first = True
    for b in BLOCKS:
        decl = "float " if first else ""
        decl_b = "bool " if first else ""
        decl_v = "vec4 " if first else ""
        decl_i = "int " if first else ""
        idx = b["idx"].format(N=n, M=m)
        A(f"        // {b['title']}")
        A(f"        {decl}fg = {b['fg']};")
        A(f"        {decl}hc = {b['hc']};")
        A(f"        {decl_b}haveShallowLine = (uSteepDirectionThreshold * fg <= hc) && {b['shallow']};")
        A(f"        {decl_b}haveSteepLine   = (uSteepDirectionThreshold * hc <= fg) && {b['steep']};")
        A(f"        {decl_b}needBlend = (blendResult.{b['comp']} != BLEND_NONE);")
        A(f"        {decl_b}doLineBlend = {b['dlb']};")
        A(f"        {decl_v}blendPix = {b['pix']};")
        A(f"        {decl_i}idx = {idx};")
        A(f"        res = alphaBlend(res, blendPix, needBlend ? (doLineBlend ? (haveShallowLine ? (haveSteepLine ? SS{n}[idx] : SH{n}[idx]) : (haveSteepLine ? ST{n}[idx] : DG{n}[idx])) : CO{n}[idx]) : 0.0);")
        if b is not BLOCKS[-1]:
            A("")
        first = False
    A("    }")
    A("")
    A("    FragColor = res;")
    A("}`;")
    return "\n".join(parts)


for n in (7, 8):
    with open(os.path.join(WORK_DIR, f"frag_{n}x.ts"), "w") as f:
        f.write(build_shader(n) + "\n")
print("emitted frag_7x.ts / frag_8x.ts")
