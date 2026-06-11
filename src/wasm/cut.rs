//! CUT3 — Cheap Upscaling Triangulation, level 3 (CPU port).
//!
//! This is a faithful Rust port of the three-pass CUT3 GLSL shaders from
//! "Cheap Upscaling Triangulation", Copyright (c) Filippo Scognamiglio 2024,
//! https://github.com/Swordfish90/cheap-upscaling-triangulation
//!
//! This program is free software: you can redistribute it and/or modify
//! it under the terms of the GNU General Public License as published by
//! the Free Software Foundation, either version 3 of the License, or
//! (at your option) any later version.
//!
//! This program is distributed in the hope that it will be useful,
//! but WITHOUT ANY WARRANTY; without even the implied warranty of
//! MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//! GNU General Public License for more details.
//!
//! You should have received a copy of the GNU General Public License
//! along with this program.  If not, see <https://www.gnu.org/licenses/>.
//!
//! Port notes (kept deliberately close to the GLSL for auditability):
//! - Pass 0 analyses the luma plane of every 2x2 quad, classifies it as
//!   vertical / horizontal / diagonal (the "triangulation"), and measures
//!   soft (anti-aliased) edges. Pass 1 walks along detected hard edges up to
//!   `hard_edges_search_max_distance` texels to derive per-side edge weights.
//!   Pass 2 interpolates the output inside each quad (split into two
//!   triangles for diagonal patterns) using those weights.
//! - The GPU pipeline stores passes 0 and 1 in input-sized RGBA8 render
//!   targets; this port stores them in `u8` buffers quantized the same way
//!   (round(clamp(v)*255)), so the bit-packing nudges in the original
//!   shaders behave identically.
//! - Passes 0/1 index texels directly. In the shaders they sample at
//!   uv*1.00006103515625 with a -0.5 texel bias through a NEAREST sampler,
//!   which resolves to exactly the integer texel for any dimension
//!   <= 16384, so integer indexing is equivalent (and exact).
//! - All arithmetic is f32, matching a WebGL2 highp pipeline.
//! - `edgesWeights` in pass 1 is only partially assigned in the GLSL
//!   (formally undefined for the untouched entries); this port zero-fills
//!   it, which is the behaviour the algorithm relies on.

use std::cell::RefCell;

const EPSILON: f32 = 0.02;

/// Configuration mirroring the CUT3 `#define` block. Defaults match the
/// values shipped in the upstream demo (`src/shaders/cut3.ts`).
#[derive(Clone, Debug)]
pub struct CutConfig {
    /// Blend sharpness follows local contrast instead of being constant.
    pub use_dynamic_blend: bool,
    /// Contrast at which sharpness starts increasing [0,1].
    pub blend_min_contrast_edge: f32,
    /// Contrast at which sharpness stops increasing [0,1].
    pub blend_max_contrast_edge: f32,
    /// Minimum sharpness level [0,1].
    pub blend_min_sharpness: f32,
    /// Maximum sharpness level [0,1].
    pub blend_max_sharpness: f32,
    /// Sharpness used when dynamic blending is disabled [0,1].
    pub static_blend_sharpness: f32,
    /// Use the green channel as a quick luma approximation in edge detection.
    pub edge_use_fast_luma: bool,
    /// Enhance edges wider than one pixel (anti-aliased content).
    pub soft_edges_sharpening: bool,
    /// Maximum size reduction of soft-edge pixels [0,1].
    pub soft_edges_sharpening_amount: f32,
    /// Maximum relative error for a pattern to count as a hard edge [0,1].
    pub hard_edges_search_max_error: f32,
    /// Edge search distance in texels (>=1). Higher values resolve
    /// shallower angles at a linear cost in pass 1.
    pub hard_edges_search_max_distance: u32,
}

impl Default for CutConfig {
    fn default() -> Self {
        CutConfig {
            use_dynamic_blend: true,
            blend_min_contrast_edge: 0.00,
            blend_max_contrast_edge: 0.25,
            blend_min_sharpness: 0.0,
            blend_max_sharpness: 0.75,
            static_blend_sharpness: 0.5,
            edge_use_fast_luma: false,
            soft_edges_sharpening: true,
            soft_edges_sharpening_amount: 1.0,
            hard_edges_search_max_error: 0.25,
            hard_edges_search_max_distance: 4,
        }
    }
}

/// Clamps every field into its valid range so degenerate inputs (e.g.
/// max_contrast <= min_contrast, which would divide by zero) cannot produce
/// NaNs. The TypeScript GPU renderer applies the same normalisation so both
/// implementations see identical parameters.
fn sanitize(cfg: &CutConfig) -> CutConfig {
    let mut c = cfg.clone();
    c.blend_min_contrast_edge = c.blend_min_contrast_edge.clamp(0.0, 1.0);
    c.blend_max_contrast_edge = c
        .blend_max_contrast_edge
        .clamp(c.blend_min_contrast_edge + 1e-4, 1.0001);
    c.blend_min_sharpness = c.blend_min_sharpness.clamp(0.0, 1.0);
    c.blend_max_sharpness = c.blend_max_sharpness.clamp(0.0, 1.0);
    c.static_blend_sharpness = c.static_blend_sharpness.clamp(0.0, 1.0);
    c.soft_edges_sharpening_amount = c.soft_edges_sharpening_amount.clamp(0.0, 1.0);
    c.hard_edges_search_max_error = c.hard_edges_search_max_error.clamp(0.0, 1.0);
    c.hard_edges_search_max_distance = c.hard_edges_search_max_distance.clamp(1, 16);
    c
}

// ---------------------------------------------------------------------------
// Small GLSL-equivalent helpers
// ---------------------------------------------------------------------------

#[inline(always)]
fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

#[inline(always)]
fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// RGBA8 render-target store: round(clamp(v, 0, 1) * 255).
#[inline(always)]
fn quantize8(v: f32) -> u8 {
    (clamp01(v) * 255.0 + 0.5) as u8
}

#[inline(always)]
fn unorm(b: u8) -> f32 {
    b as f32 * (1.0 / 255.0)
}

/// GLSL `quickPackFloats2`: packs two values quantised to 1/12 steps into
/// the high/low nibbles of one channel.
#[inline(always)]
fn quick_pack_floats2(x: f32, y: f32) -> f32 {
    (x * 12.0 + 0.5).floor() * 0.0625 + (y * 12.0 + 0.5).floor() * 0.00390625
}

/// GLSL `quickUnpackFloats2`.
#[inline(always)]
fn quick_unpack_floats2(value: f32) -> [f32; 2] {
    let mut current = value * 16.0;
    let x = current.floor();
    current -= x;
    current *= 16.0;
    let y = current.floor();
    [x / 12.0, y / 12.0]
}

/// GLSL `quickPackBools2`.
#[inline(always)]
fn quick_pack_bools2(a: bool, b: bool) -> f32 {
    (a as u32 as f32) * 0.5 + (b as u32 as f32) * 0.25
}

/// GLSL `quickUnpackBools2`.
#[inline(always)]
fn quick_unpack_bools2(value: f32) -> [bool; 2] {
    let mut current = value * 2.0;
    let x = current.floor();
    current -= x;
    current *= 2.0;
    let y = current.floor();
    [x > 0.5, y > 0.5]
}

/// GLSL `fetchPattern`: decodes the pattern id [-4, 4] stored by pass 0.
#[inline(always)]
fn fetch_pattern(value: f32) -> i32 {
    (value * 8.0 + 0.5) as i32 - 4
}

// ---------------------------------------------------------------------------
// Pass 0 — triangulation & pattern recognition (input-sized)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
struct Quad {
    scores: [f32; 4],
    max_edge_contrast: f32,
    max_score: f32,
}

/// GLSL `quad`: edge scores of a 2x2 luma block (v = [tl, tr, bl, br]).
#[inline]
fn quad(v: [f32; 4]) -> Quad {
    // edges = values.xyzx - values.ywwz
    let e = [v[0] - v[1], v[1] - v[3], v[2] - v[3], v[0] - v[2]];

    let scores = [
        (e[0] + e[2]).abs(),
        (e[3] + e[1]).abs(),
        (e[0] - e[1]).abs().max((e[3] - e[2]).abs()),
        (e[0] + e[3]).abs().max((e[1] + e[2]).abs()),
    ];

    let max_score = scores[0].max(scores[1]).max(scores[2]).max(scores[3]);
    let max_edge_contrast = e[0].abs().max(e[1].abs()).max(e[2].abs()).max(e[3].abs());

    Quad { scores, max_edge_contrast, max_score }
}

/// GLSL `computePattern`.
#[inline]
fn compute_pattern(q: &Quad, neighbors_scores: [f32; 4], search_max_error: f32) -> i32 {
    let s = q.scores;
    let max_orthogonal = s[0].max(s[1]);
    let max_diagonal = s[2].max(s[3]);
    let is_diagonal = max_diagonal > max_orthogonal;

    let a = [
        s[0] + 0.25 * neighbors_scores[0],
        s[1] + 0.25 * neighbors_scores[1],
        s[2] + 0.25 * neighbors_scores[2],
        s[3] + 0.25 * neighbors_scores[3],
    ];

    let threshold = 1.05_f32;
    let mut result = 0i32;

    if !is_diagonal {
        if a[0] > (threshold * a[1]).max(EPSILON) {
            result = 1;
        } else if a[1] > (threshold * a[0]).max(EPSILON) {
            result = 2;
        }
    } else if a[2] > (threshold * a[3]).max(EPSILON) {
        result = 3;
    } else if a[3] > (threshold * a[2]).max(EPSILON) {
        result = 4;
    }

    let error = 2.0 * q.max_edge_contrast - q.max_score;
    if error > search_max_error * (0.5 + 0.5 * q.max_edge_contrast) {
        result = -result;
    }

    result
}

/// GLSL `softEdgeWeight`.
#[inline]
fn soft_edge_weight(a: f32, b: f32, c: f32, d: f32) -> f32 {
    let diff = (b - c).abs();
    let mut result = 0.0f32;
    result += clamp01(diff / ((a - c).abs() + EPSILON));
    result -= clamp01(diff / ((b - d).abs() + EPSILON));
    (2.0 * result).clamp(-1.0, 1.0)
}

/// Runs pass 0 over the whole image. `lumas` is the precomputed luma plane
/// (identical to evaluating `luma()` per fetch, since luma is pure per
/// texel); `out` receives RGBA8 data exactly as the GPU render target would.
fn pass0(lumas: &[f32], w: usize, h: usize, cfg: &CutConfig, out: &mut [u8]) {
    let wi = w as i64;
    let hi = h as i64;
    let l = |x: i64, y: i64| -> f32 {
        let xc = x.clamp(0, wi - 1) as usize;
        let yc = y.clamp(0, hi - 1) as usize;
        lumas[yc * w + xc]
    };

    for y in 0..h as i64 {
        for x in 0..w as i64 {
            // Sample layout around (x, y) = c05 (see pass 0 vertex shader):
            //        c01 c02
            //  c04   c05 c06   c07
            //  c08   c09 c10   c11
            //        c13 c14
            let l01 = l(x, y - 1);
            let l02 = l(x + 1, y - 1);
            let l04 = l(x - 1, y);
            let l05 = l(x, y);
            let l06 = l(x + 1, y);
            let l07 = l(x + 2, y);
            let l08 = l(x - 1, y + 1);
            let l09 = l(x, y + 1);
            let l10 = l(x + 1, y + 1);
            let l11 = l(x + 2, y + 1);
            let l13 = l(x, y + 2);
            let l14 = l(x + 1, y + 2);

            let quads = [
                quad([l05, l06, l09, l10]),
                quad([l01, l02, l05, l06]),
                quad([l06, l07, l10, l11]),
                quad([l09, l10, l13, l14]),
                quad([l04, l05, l08, l09]),
            ];

            // findPattern(quads[5]): centre quad adjusted by the four
            // neighbouring quads' scores.
            let adj = [
                quads[1].scores[0] + quads[2].scores[0] + quads[3].scores[0] + quads[4].scores[0],
                quads[1].scores[1] + quads[2].scores[1] + quads[3].scores[1] + quads[4].scores[1],
                quads[1].scores[2] + quads[2].scores[2] + quads[3].scores[2] + quads[4].scores[2],
                quads[1].scores[3] + quads[2].scores[3] + quads[3].scores[3] + quads[4].scores[3],
            ];
            let mut pattern =
                compute_pattern(&quads[0], adj, cfg.hard_edges_search_max_error);

            // Neighbour-connection analysis.
            let mv = [l05, l06, l09, l10];
            let me = [
                (mv[0] - mv[1]).abs(),
                (mv[1] - mv[3]).abs(),
                (mv[2] - mv[3]).abs(),
                (mv[0] - mv[2]).abs(),
            ];
            let max_me = me[0].max(me[1]).max(me[2]).max(me[3]);
            let conn = [
                me[0] >= 0.5 * max_me,
                me[1] >= 0.5 * max_me,
                me[2] >= 0.5 * max_me,
                me[3] >= 0.5 * max_me,
            ];

            let zero = [0.0f32; 4];
            let np = [
                compute_pattern(&quads[1], zero, cfg.hard_edges_search_max_error)
                    * conn[0] as i32,
                compute_pattern(&quads[2], zero, cfg.hard_edges_search_max_error)
                    * conn[1] as i32,
                compute_pattern(&quads[3], zero, cfg.hard_edges_search_max_error)
                    * conn[2] as i32,
                compute_pattern(&quads[4], zero, cfg.hard_edges_search_max_error)
                    * conn[3] as i32,
            ];

            let vertical = np[0] == 1 || np[2] == 1;
            let horizontal = np[1] == 2 || np[3] == 2;
            let corner = vertical && horizontal;
            let opposite_of = if pattern == 3 { 4 } else { 3 };
            let opposite = np.iter().any(|&p| p == opposite_of);
            let is_triangle = pattern >= 3;

            let reject =
                (is_triangle && (opposite || corner)) || !conn.iter().any(|&c| c);

            let mut rg = 0.0f32;
            let mut rb = 0.0f32;
            if cfg.soft_edges_sharpening {
                let se = [
                    soft_edge_weight(l04, l05, l06, l07),
                    soft_edge_weight(l02, l06, l10, l14),
                    soft_edge_weight(l08, l09, l10, l11),
                    soft_edge_weight(l01, l05, l09, l13),
                ];
                rg = quick_pack_floats2(se[0] * 0.5 + 0.5, se[1] * 0.5 + 0.5);
                rb = quick_pack_floats2(se[2] * 0.5 + 0.5, se[3] * 0.5 + 0.5);
            }

            if pattern > 0 && reject {
                pattern = -pattern;
            }

            let o = ((y as usize) * w + x as usize) * 4;
            out[o] = quantize8((pattern + 4) as f32 / 8.0);
            out[o + 1] = quantize8(rg);
            out[o + 2] = quantize8(rb);
            out[o + 3] = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Pass 1 — hard-edge search (input-sized)
// ---------------------------------------------------------------------------

/// GLSL `walk`: follows a run of same-pattern texels in one direction,
/// accumulating distance; diagonal patterns terminate the run and decide the
/// edge's sign.
#[inline]
fn walk(
    buf_a: &[u8],
    w: i64,
    h: i64,
    x: i64,
    y: i64,
    dx: i64,
    dy: i64,
    results: [f32; 2],
    continue_pattern: i32,
    max_distance: u32,
    step: f32,
    hstep: f32,
) -> [f32; 2] {
    let mut result = [0.0f32, 0.0];
    for i in 1..=max_distance as i64 {
        let sx = (x + dx * i).clamp(0, w - 1) as usize;
        let sy = (y + dy * i).clamp(0, h - 1) as usize;
        let current = fetch_pattern(unorm(buf_a[(sy * w as usize + sx) * 4]));

        if current == 3 {
            result[1] = results[0];
        } else if current == 4 {
            result[1] = results[1];
        }

        if current == 3 || current == 4 {
            result[0] += hstep;
        } else if current == continue_pattern {
            result[0] += step;
        }

        if current != continue_pattern {
            break;
        }
    }
    result
}

/// GLSL `blendWeights`.
#[inline]
fn blend_weights(
    d1: [f32; 2],
    d2: [f32; 2],
    max_double_distance: f32,
    max_distance: f32,
) -> f32 {
    let total = d1[0] + d2[0];

    if total <= EPSILON {
        0.0
    } else if total <= max_double_distance {
        let d1_ratio = d1[0] / total;
        if d1[0] < d2[0] {
            mix(d1[1], 0.0, 2.0 * d1_ratio)
        } else {
            mix(0.0, d2[1], (d1_ratio - 0.5) * 2.0)
        }
    } else if d1[0] <= max_distance {
        mix(d1[1], 0.0, d1[0] / max_distance)
    } else if d2[0] <= max_distance {
        mix(d2[1], 0.0, d2[0] / max_distance)
    } else {
        0.0
    }
}

fn pass1(buf_a: &[u8], w: usize, h: usize, cfg: &CutConfig, out: &mut [u8]) {
    let d = cfg.hard_edges_search_max_distance;
    let step = 0.5 / d as f32;
    let hstep = step * 0.5;
    // Note: integer division, exactly as in the GLSL constant expression.
    let max_double_distance = d as f32 * step;
    let max_distance = step * (d / 2) as f32 + hstep;

    let wi = w as i64;
    let hi = h as i64;

    for y in 0..hi {
        for x in 0..wi {
            let idx = ((y as usize) * w + x as usize) * 4;
            let prev = [
                unorm(buf_a[idx]),
                unorm(buf_a[idx + 1]),
                unorm(buf_a[idx + 2]),
            ];
            let pattern = fetch_pattern(prev[0]);

            let mut result_n = [0.0f32; 2];
            let mut result_s = [0.0f32; 2];
            let mut result_w = [0.0f32; 2];
            let mut result_e = [0.0f32; 2];

            if pattern == 1 || pattern == 3 || pattern == 4 {
                result_n = walk(buf_a, wi, hi, x, y, 0, -1, [-1.0, 1.0], 1, d, step, hstep);
                result_s = walk(buf_a, wi, hi, x, y, 0, 1, [1.0, -1.0], 1, d, step, hstep);
            }
            if pattern == 2 || pattern == 3 || pattern == 4 {
                result_w = walk(buf_a, wi, hi, x, y, -1, 0, [-1.0, 1.0], 2, d, step, hstep);
                result_e = walk(buf_a, wi, hi, x, y, 1, 0, [1.0, -1.0], 2, d, step, hstep);
            }

            // edgesWeights[i] = [near.x, near.y, far.x, far.y]; zero-filled
            // (the GLSL leaves untouched entries undefined and relies on
            // them reading as zero).
            let mut ew = [[0.0f32; 4]; 4];
            if pattern == 1 {
                ew[0] = [result_n[0], result_n[1], result_s[0] + step, result_s[1]];
                ew[2] = [result_n[0] + step, result_n[1], result_s[0], result_s[1]];
            } else if pattern == 2 {
                ew[3] = [result_w[0], result_w[1], result_e[0] + step, result_e[1]];
                ew[1] = [result_w[0] + step, result_w[1], result_e[0], result_e[1]];
            } else if pattern == 3 {
                ew[0] = [result_n[0], result_n[1], hstep, 1.0];
                ew[2] = [hstep, -1.0, result_s[0], result_s[1]];
                ew[3] = [result_w[0], result_w[1], hstep, 1.0];
                ew[1] = [hstep, -1.0, result_e[0], result_e[1]];
            } else if pattern == 4 {
                ew[0] = [result_n[0], result_n[1], hstep, -1.0];
                ew[2] = [hstep, 1.0, result_s[0], result_s[1]];
                ew[3] = [result_w[0], result_w[1], hstep, -1.0];
                ew[1] = [hstep, 1.0, result_e[0], result_e[1]];
            }

            let mut edges = [
                blend_weights([ew[0][0], ew[0][1]], [ew[0][2], ew[0][3]], max_double_distance, max_distance),
                blend_weights([ew[1][0], ew[1][1]], [ew[1][2], ew[1][3]], max_double_distance, max_distance),
                blend_weights([ew[2][0], ew[2][1]], [ew[2][2], ew[2][3]], max_double_distance, max_distance),
                blend_weights([ew[3][0], ew[3][1]], [ew[3][2], ew[3][3]], max_double_distance, max_distance),
            ];

            if cfg.soft_edges_sharpening {
                let s01 = quick_unpack_floats2(prev[1] + 0.001953125);
                let s23 = quick_unpack_floats2(prev[2] + 0.001953125);
                let amount = 2.0 * cfg.soft_edges_sharpening_amount;
                let soft = [
                    amount * (s01[0] - 0.5),
                    amount * (s01[1] - 0.5),
                    amount * (s23[0] - 0.5),
                    amount * (s23[1] - 0.5),
                ];
                for i in 0..4 {
                    // mix(soft, edges, step(EPSILON, abs(edges)))
                    if edges[i].abs() < EPSILON {
                        edges[i] = soft[i];
                    }
                }
            }

            let original_pattern = pattern.abs();
            if original_pattern == 3 {
                edges = [-edges[0], edges[3], -edges[2], edges[1]];
            }

            out[idx] = quantize8(quick_pack_bools2(original_pattern >= 3, original_pattern == 3));
            out[idx + 1] = quantize8(quick_pack_floats2(edges[0] * 0.5 + 0.5, edges[1] * 0.5 + 0.5));
            out[idx + 2] = quantize8(quick_pack_floats2(edges[2] * 0.5 + 0.5, edges[3] * 0.5 + 0.5));
            out[idx + 3] = 255;
        }
    }
}

// ---------------------------------------------------------------------------
// Pass 2 — interpolation (output-sized)
// ---------------------------------------------------------------------------

/// Pass 2 luma is intentionally the quick green-channel approximation
/// (see `luma()` in cut3_pass_2.frag.glsl).
#[inline(always)]
fn luma_quick(rgb: [f32; 3]) -> f32 {
    rgb[1]
}

#[inline]
fn sharpness(l1: f32, l2: f32, cfg: &CutConfig, blend_diff_inv: f32) -> f32 {
    if cfg.use_dynamic_blend {
        let luma_diff = (l1 - l2).abs();
        let contrast = clamp01((luma_diff - cfg.blend_min_contrast_edge) * blend_diff_inv);
        mix(cfg.blend_min_sharpness * 0.5, cfg.blend_max_sharpness * 0.5, contrast)
    } else {
        cfg.static_blend_sharpness * 0.5
    }
}

/// GLSL `adjustMidpoint`.
#[inline]
fn adjust_midpoint(x: f32, mid_point: f32) -> f32 {
    let mut result = 0.0f32;
    result += clamp01(x / mid_point);
    result += clamp01((x - mid_point) / (1.0 - mid_point));
    0.5 * result
}

/// GLSL `blend`.
#[inline]
fn blend(
    a: [f32; 3],
    b: [f32; 3],
    t: f32,
    mid_point: f32,
    base_sharpness: f32,
    cfg: &CutConfig,
    blend_diff_inv: f32,
) -> [f32; 3] {
    let sh = base_sharpness * sharpness(luma_quick(a), luma_quick(b), cfg, blend_diff_inv);
    let mut nt = adjust_midpoint(t, mid_point);
    nt = clamp01((nt - sh) / (1.0 - 2.0 * sh));
    [mix(a[0], b[0], nt), mix(a[1], b[1], nt), mix(a[2], b[2], nt)]
}

#[allow(clippy::too_many_arguments)]
fn pass2(
    input: &[u8],
    buf_b: &[u8],
    w: usize,
    h: usize,
    out_w: usize,
    out_h: usize,
    cfg: &CutConfig,
    out: &mut [u8],
) {
    let blend_diff_inv = 1.0 / (cfg.blend_max_contrast_edge - cfg.blend_min_contrast_edge);
    let wi = w as i64;
    let hi = h as i64;

    let rgb_at = |x: i64, y: i64| -> [f32; 3] {
        let xc = x.clamp(0, wi - 1) as usize;
        let yc = y.clamp(0, hi - 1) as usize;
        let i = (yc * w + xc) * 4;
        [unorm(input[i]), unorm(input[i + 1]), unorm(input[i + 2])]
    };

    let inv_out_w = 1.0 / out_w as f32;
    let inv_out_h = 1.0 / out_h as f32;
    let wf = w as f32;
    let hf = h as f32;

    for oy in 0..out_h {
        // Matches the vertex/fragment coordinate maths:
        //   coords = uv * 1.00006103515625
        //   screenCoords = coords * textureSize - 0.5
        let vy = (oy as f32 + 0.5) * inv_out_h * 1.00006103515625;
        let scy = vy * hf - 0.5;
        let fy = scy.floor();
        let py_base = scy - fy; // fract(screenCoords.y)
        let iy = fy as i64;

        // Everything derived from the source quad (colours, flags, edge
        // weights) is a pure function of (ix, iy); within a row iy is fixed,
        // so cache it and refresh only when ix changes. The maths below is
        // bit-identical to evaluating it per pixel.
        let mut cached_ix = i64::MIN;
        let mut c_p0 = [0.0f32; 3];
        let mut c_p1 = [0.0f32; 3];
        let mut c_p2 = [0.0f32; 3];
        let mut c_p3 = [0.0f32; 3];
        let mut c_ew = [0.0f32; 4];
        let mut c_triangle = false;
        let mut c_flip = false;

        for ox in 0..out_w {
            let vx = (ox as f32 + 0.5) * inv_out_w * 1.00006103515625;
            let scx = vx * wf - 0.5;
            let fx = scx.floor();
            let mut px = scx - fx; // fract(screenCoords.x)
            let py = py_base;
            let ix = fx as i64;

            if ix != cached_ix {
                cached_ix = ix;

                // 2x2 source quad (NEAREST + CLAMP_TO_EDGE sampling of
                // c05/c06/c09/c10) and the pass-1 flags at c05.
                c_p0 = rgb_at(ix, iy);
                c_p1 = rgb_at(ix + 1, iy);
                c_p2 = rgb_at(ix, iy + 1);
                c_p3 = rgb_at(ix + 1, iy + 1);

                let bi = ((iy.clamp(0, hi - 1) as usize) * w
                    + ix.clamp(0, wi - 1) as usize)
                    * 4;
                let flags_pixel =
                    [unorm(buf_b[bi]), unorm(buf_b[bi + 1]), unorm(buf_b[bi + 2])];

                // parseFlags
                let e01 = quick_unpack_floats2(flags_pixel[1] + 0.001953125);
                let e23 = quick_unpack_floats2(flags_pixel[2] + 0.001953125);
                c_ew = [
                    e01[0].clamp(EPSILON, 1.0 - EPSILON),
                    e01[1].clamp(EPSILON, 1.0 - EPSILON),
                    e23[0].clamp(EPSILON, 1.0 - EPSILON),
                    e23[1].clamp(EPSILON, 1.0 - EPSILON),
                ];
                let bools = quick_unpack_bools2(flags_pixel[0] + 0.125);
                c_triangle = bools[0];
                c_flip = bools[1];

                if c_flip {
                    std::mem::swap(&mut c_p0, &mut c_p1);
                    std::mem::swap(&mut c_p2, &mut c_p3);
                }
            }

            let (mut p0, mut p1, mut p2, mut p3) = (c_p0, c_p1, c_p2, c_p3);
            let mut ew = c_ew;
            let triangle = c_triangle;

            if c_flip {
                px = 1.0 - px;
            }

            // pattern()
            let mut pxc = [px, py];
            let first_triangle = triangle && pxc[0] + pxc[1] <= 1.0;
            let second_triangle = triangle && !first_triangle;

            if second_triangle {
                pxc = [1.0 - pxc[1], 1.0 - pxc[0]];
                let (q0, q1, q2, q3) = (p3, p1, p2, p0);
                p0 = q0;
                p1 = q1;
                p2 = q2;
                p3 = q3;
                // edgeWeights = 1.0 - edgeWeights.yxwz
                ew = [1.0 - ew[1], 1.0 - ew[0], 1.0 - ew[3], 1.0 - ew[2]];
            }

            let mid_points;
            if triangle {
                let coords_sum = pxc[0] + pxc[1];
                let denom = ew[3] * pxc[0] + ew[0] * pxc[1];
                // denom == 0 only when both fract() coordinates are exactly
                // zero (measure-zero; the GLSL would produce NaN here).
                let m0 = if denom > 0.0 { ew[0] * ew[3] * coords_sum / denom } else { 0.5 };
                let m1 = 0.5 + 0.5 * (-ew[0] + ew[1] - ew[2] + ew[3]).clamp(-1.0, 1.0);
                mid_points = [m0, m1];
                pxc = [coords_sum, if coords_sum > 0.0 { pxc[1] / coords_sum } else { 0.0 }];
            } else {
                mid_points = [mix(ew[0], ew[2], pxc[1]), mix(ew[3], ew[1], pxc[0])];
            }

            let weights = [pxc[0], pxc[0], pxc[1]];
            let mids = [mid_points[0], mid_points[0], mid_points[1]];
            let base_sharp = [1.0, 1.0, if triangle { 0.0 } else { 1.0 }];
            let (q2, q3) = if triangle { (p0, p2) } else { (p2, p3) };

            let top = blend(p0, p1, weights[0], mids[0], base_sharp[0], cfg, blend_diff_inv);
            let bottom = blend(q2, q3, weights[1], mids[1], base_sharp[1], cfg, blend_diff_inv);
            let final_rgb = blend(top, bottom, weights[2], mids[2], base_sharp[2], cfg, blend_diff_inv);

            let o = (oy * out_w + ox) * 4;
            out[o] = quantize8(final_rgb[0]);
            out[o + 1] = quantize8(final_rgb[1]);
            out[o + 2] = quantize8(final_rgb[2]);
            out[o + 3] = 255;
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

thread_local! {
    /// Reused scratch: luma plane + two input-sized RGBA8 pass buffers.
    static SCRATCH: RefCell<(Vec<f32>, Vec<u8>, Vec<u8>)> =
        const { RefCell::new((Vec::new(), Vec::new(), Vec::new())) };
}

/// CUT3 upscale into a caller-provided buffer of exactly
/// `src_w * scale * src_h * scale * 4` bytes. Every output byte is written
/// (alpha is always 255, matching the original shaders), so the buffer does
/// not need to be zeroed. `scale == 1` copies the input with alpha forced
/// to 255.
pub fn cut_upscale_into(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    config: &CutConfig,
    output: &mut [u8],
) {
    let scale = scale.clamp(1, 32);
    let out_w = src_w * scale;
    let out_h = src_h * scale;
    assert_eq!(output.len(), out_w * out_h * 4, "output buffer size mismatch");
    assert!(input.len() >= src_w * src_h * 4, "input buffer too small");
    assert!(
        src_w <= 16384 && src_h <= 16384,
        "input dimensions exceed CUT3 coordinate range"
    );

    let cfg = sanitize(config);

    if scale == 1 {
        for (o, i) in output.chunks_exact_mut(4).zip(input.chunks_exact(4)) {
            o[0] = i[0];
            o[1] = i[1];
            o[2] = i[2];
            o[3] = 255;
        }
        return;
    }

    SCRATCH.with(|cell| {
        let (lumas, buf_a, buf_b) = &mut *cell.borrow_mut();
        let n = src_w * src_h;
        lumas.resize(n, 0.0);
        buf_a.resize(n * 4, 0);
        buf_b.resize(n * 4, 0);

        // Luma plane (pass 0's `luma()` per texel).
        if cfg.edge_use_fast_luma {
            for (l, px) in lumas.iter_mut().zip(input.chunks_exact(4)) {
                *l = unorm(px[1]);
            }
        } else {
            for (l, px) in lumas.iter_mut().zip(input.chunks_exact(4)) {
                *l = unorm(px[0]) * 0.299 + unorm(px[1]) * 0.587 + unorm(px[2]) * 0.114;
            }
        }

        pass0(lumas, src_w, src_h, &cfg, buf_a);
        pass1(buf_a, src_w, src_h, &cfg, buf_b);
        pass2(input, buf_b, src_w, src_h, out_w, out_h, &cfg, output);
    });
}

/// Allocating wrapper around [`cut_upscale_into`].
pub fn cut_upscale(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    config: &CutConfig,
) -> Vec<u8> {
    let scale = scale.clamp(1, 32);
    let mut output = vec![0u8; src_w * scale * src_h * scale * 4];
    cut_upscale_into(input, src_w, src_h, scale, config, &mut output);
    output
}

#[cfg(test)]
mod test {
    use super::*;

    /// A constant-colour image must upscale to the same constant colour:
    /// every blend interpolates between identical pixels.
    #[test]
    fn constant_image_is_preserved() {
        let (w, h) = (9usize, 7usize);
        let mut img = Vec::with_capacity(w * h * 4);
        for _ in 0..w * h {
            img.extend_from_slice(&[120, 200, 40, 255]);
        }
        let out = cut_upscale(&img, w, h, 4, &CutConfig::default());
        for px in out.chunks_exact(4) {
            assert_eq!(px, &[120, 200, 40, 255]);
        }
    }

    /// Pack/unpack round-trips through 8-bit storage for every code point.
    ///
    /// Exception: (8, 0) packs to exactly 0.5, which hits the 127.5
    /// rounding tie of unorm8 storage; the unpack nudge then reads the low
    /// digit as 1 instead of 0. This is inherited from the upstream GLSL
    /// (any tie-rounding direction mis-decodes this single code point) and
    /// amounts to a 1/12 error on one edge weight in a rare configuration,
    /// so the port reproduces it rather than diverging.
    #[test]
    fn pack_roundtrip_through_u8() {
        for a in 0..=12u32 {
            for b in 0..=12u32 {
                let packed = quick_pack_floats2(a as f32 / 12.0, b as f32 / 12.0);
                let stored = unorm(quantize8(packed));
                let un = quick_unpack_floats2(stored + 0.001953125);
                if (a, b) == (8, 0) {
                    assert!((un[0] - 8.0 / 12.0).abs() < 1e-6);
                    assert!((un[1] - 1.0 / 12.0).abs() < 1e-6);
                    continue;
                }
                assert!((un[0] - a as f32 / 12.0).abs() < 1e-6, "a={a} b={b}");
                assert!((un[1] - b as f32 / 12.0).abs() < 1e-6, "a={a} b={b}");
            }
        }
        for p in -4i32..=4 {
            let stored = unorm(quantize8((p + 4) as f32 / 8.0));
            assert_eq!(fetch_pattern(stored), p, "pattern {p}");
        }
        for t in [false, true] {
            for f in [false, true] {
                let stored = unorm(quantize8(quick_pack_bools2(t, f)));
                let un = quick_unpack_bools2(stored + 0.125);
                assert_eq!(un, [t, f]);
            }
        }
    }
}
