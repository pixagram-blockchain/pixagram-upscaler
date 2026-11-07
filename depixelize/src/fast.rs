//! Fast smoothing ([`Smooth::Fast`](crate::Smooth::Fast)): a deterministic
//! pattern search on the paper's energy, in IEEE single precision — the twin of
//! `optimizeFast` / `fastVisit` in depixelize.js (bit-identical results).
//!
//! A visit scores one control point at four positions: where it is (lane 0)
//! and three trial moves 120° apart (lanes 1–3), i.e. exactly one `f32x4`
//! with simd128. The lowest strictly better lane wins; otherwise the step
//! halves (2g, g, g/2 with g = guess offset), and once the smallest step
//! fails the point sleeps until a neighbour — or the T-junction end next to
//! it — moves; a woken point restarts at g. Odd sweeps turn the pattern by
//! 60°, so two visits probe six directions. All coordinates are relative to
//! the visited point: small numbers, so f32 keeps ~1e-7 px precision.
//!
//! The simd128 kernel is branch-free per lane and leans on bit operations:
//!
//! * `|x|` is an AND with `0x7FFF_FFFF`;
//! * the octant fold-backs `π/2 − r` and `π − r` are a sign flip (XOR with
//!   the compare mask's sign bit) plus an AND-masked constant — no selects;
//! * the 0/0 lane of a degenerate angle is cleared with one ANDNOT;
//! * the winner is `ctz(bitmask(e == min(e)))`: a horizontal min (two
//!   shuffle + `pmin` steps), one compare, `i32x4.bitmask`, trailing zeros. Lane 0
//!   holding the minimum yields 0 = stay, which is also the scalar rule
//!   "first lane strictly below the current energy".

use crate::math::ATAN_K;
use crate::pipeline::{Curve, PixelData};

/// Step levels: state byte 0 = asleep, s = 1..=LEVELS awake with step `2g / 2^(s−1)`.
const LEVELS: usize = 3;
/// State of a woken point (step g).
const WAKE: u8 = 2;
/// √3 / 2 rounded to f32 exactly as `Math.fround(0.8660254037844386)`.
const R3: f32 = 0.866_025_403_784_438_6_f64 as f32;
/// Trial directions of lanes 1–3: pattern 0 at 0°, 120°, 240°; pattern 1 at 60°, 180°, 300°.
const PAT_X: [f32; 6] = [1.0, -0.5, -0.5, 0.5, -1.0, 0.5];
const PAT_Y: [f32; 6] = [0.0, R3, -R3, R3, 0.0, -R3];
/// [`ATAN_K`] rounded to f32 (`Math.fround` of the same doubles).
const K32: [f32; 7] = [
    ATAN_K[0] as f32,
    ATAN_K[1] as f32,
    ATAN_K[2] as f32,
    ATAN_K[3] as f32,
    ATAN_K[4] as f32,
    ATAN_K[5] as f32,
    ATAN_K[6] as f32,
];

/// Everything a visit needs, as f32 relative to the visited point `P`:
/// `a1` = previous point, `b1` = next point, `ul` = edge into `a1`, `vr` =
/// edge out of `b1`, `h` = lattice home; `t` = active turning angles (bit 0
/// at the previous point, bit 1 at `P`, bit 2 at the next one).
#[derive(Clone, Copy, Default)]
struct Visit {
    a1x: f32,
    a1y: f32,
    b1x: f32,
    b1y: f32,
    ulx: f32,
    uly: f32,
    vrx: f32,
    vry: f32,
    hx: f32,
    hy: f32,
    t: u32,
}

impl PixelData {
    /// Moves the ends of T-junction curve `ci` onto its host curves.
    #[inline]
    fn update_one(&mut self, ci: usize) {
        let c = self.curves[ci];
        for (att, j, i) in [(c.att0, c.att0j, c.off), (c.att1, c.att1j, c.off + c.n)] {
            if att >= 0 {
                let h = self.curves[att as usize];
                let (hx, hy) = self.curve_xy(&h);
                let (tx, ty) = crate::optimize::node_pt(&h, hx, hy, j);
                self.cx[i] = tx;
                self.cy[i] = ty;
            }
        }
    }

    /// Fast smoothing: at most `sweeps` sweeps over the awake control points.
    pub(crate) fn optimize_fast(&mut self, sweeps: i32, guess_offset: f64) {
        let sweeps = sweeps.max(0) as usize;
        if sweeps == 0 || !(guess_offset > 0.0) {
            return;
        }
        let g0 = guess_offset.min(1000.0);
        let mut step = [0f32; LEVELS + 1];
        for (s, v) in step.iter_mut().enumerate().skip(1) {
            *v = ((2.0 * g0) / f64::from(1u32 << (s - 1))) as f32;
        }
        let live: Vec<usize> = (0..self.curves.len()).filter(|&c| self.curves[c].is_live()).collect();
        let mut is_live = vec![false; self.curves.len()];
        let mut state = vec![0u8; self.cx.len()];
        for &ci in &live {
            let c = self.curves[ci];
            is_live[ci] = true;
            state[c.off + usize::from(!c.closed)..c.off + c.n].fill(1);
        }
        let k = Consts::load();
        for s in 0..sweeps {
            // T-junction ends follow the curves they sit on; wake the two
            // points next to an end that moved.
            for t in 0..self.attached.len() {
                let ci = self.attached[t] as usize;
                let c = self.curves[ci];
                let (i0, i1) = (c.off, c.off + c.n);
                let before = [self.cx[i0], self.cy[i0], self.cx[i1], self.cy[i1]];
                self.update_one(ci);
                if !is_live[ci] {
                    continue;
                }
                if self.cx[i0] != before[0] || self.cy[i0] != before[1] {
                    wake(&mut state, i0 + 1);
                    if c.n > 2 {
                        wake(&mut state, i0 + 2);
                    }
                }
                if self.cx[i1] != before[2] || self.cy[i1] != before[3] {
                    wake(&mut state, i1 - 1);
                    if c.n > 2 {
                        wake(&mut state, i1 - 2);
                    }
                }
            }
            let pat = (s & 1) * 3;
            let mut awake = false;
            for &ci in &live {
                let c = self.curves[ci];
                let r = c.off..c.off + c.m;
                awake |= sweep_curve(
                    &c,
                    &mut self.cx[r.clone()],
                    &mut self.cy[r.clone()],
                    &self.cox[r.clone()],
                    &self.coy[r.clone()],
                    &self.cex[r.clone()],
                    &mut state[r],
                    &step,
                    pat,
                    &k,
                );
            }
            if !awake {
                break;
            }
        }
    }
}

impl Curve {
    /// Optimised curves: not on the image border, at least one movable point.
    #[inline]
    pub(crate) fn is_live(&self) -> bool {
        !self.border && if self.closed { self.n >= 3 } else { self.n >= 2 }
    }
}

#[inline(always)]
fn wake(state: &mut [u8], p: usize) {
    if state[p] == 0 {
        state[p] = WAKE;
    }
}

/// One sweep over the awake points of one curve; true if any was awake.
/// Kept out of line (see `relax_curve`).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn sweep_curve(
    c: &Curve,
    x: &mut [f64],
    y: &mut [f64],
    hx: &[f64],
    hy: &[f64],
    ex: &[u8],
    state: &mut [u8],
    step: &[f32; LEVELS + 1],
    pat: usize,
    k: &Consts,
) -> bool {
    let n = c.n;
    let mut awake = false;
    for i in usize::from(!c.closed)..n {
        let s = state[i];
        if s == 0 {
            continue;
        }
        awake = true;
        let (im1, im2, ip1, ip2) = if c.closed {
            let im1 = if i == 0 { n - 1 } else { i - 1 };
            let ip1 = if i == n - 1 { 0 } else { i + 1 };
            (im1, if im1 == 0 { n - 1 } else { im1 - 1 }, ip1, if ip1 == n - 1 { 0 } else { ip1 + 1 })
        } else {
            (i - 1, i.wrapping_sub(2), i + 1, i + 2)
        };
        let mut t = if ex[i] == 0 { 2 } else { 0 };
        if (c.closed || i > 1) && ex[im1] == 0 {
            t |= 1;
        }
        if (c.closed || i < n - 1) && ex[ip1] == 0 {
            t |= 4;
        }
        let (x0, y0) = (x[i], y[i]);
        let mut v = Visit {
            a1x: (x[im1] - x0) as f32,
            a1y: (y[im1] - y0) as f32,
            b1x: (x[ip1] - x0) as f32,
            b1y: (y[ip1] - y0) as f32,
            hx: (hx[i] - x0) as f32,
            hy: (hy[i] - y0) as f32,
            t,
            ..Visit::default()
        };
        if t & 1 != 0 {
            v.ulx = (x[im1] - x[im2]) as f32;
            v.uly = (y[im1] - y[im2]) as f32;
        }
        if t & 4 != 0 {
            v.vrx = (x[ip2] - x[ip1]) as f32;
            v.vry = (y[ip2] - y[ip1]) as f32;
        }
        let h = step[s as usize];
        let won = visit(&v, h, pat, k);
        if won != 0 {
            let q = pat + won - 1;
            x[i] = x0 + f64::from(h * PAT_X[q]);
            y[i] = y0 + f64::from(h * PAT_Y[q]);
            if c.closed {
                for j in [im2, im1, ip1, ip2] {
                    wake(state, j);
                }
            } else {
                for j in i.saturating_sub(2).max(1)..=(i + 2).min(n - 1) {
                    wake(state, j);
                }
            }
        } else {
            state[i] = if usize::from(s) < LEVELS { s + 1 } else { 0 };
        }
    }
    awake
}

// ---- scalar kernel (native, and wasm without simd128) ----------------------------------------

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
struct Consts;

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
impl Consts {
    #[inline(always)]
    fn load() -> Self {
        Consts
    }
}

/// `|atan2(cr, dt)|` in f32 — the operation sequence of `absAngle32` in JS.
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(always)]
fn abs_angle32(cr: f32, dt: f32) -> f32 {
    let k = &K32;
    let ay = cr.abs();
    let ax = dt.abs();
    let up = ay > ax;
    let mx = if up { ay } else { ax };
    if mx == 0.0 {
        return 0.0;
    }
    let a = (if up { ax } else { ay }) / mx;
    let s = a * a;
    let s2 = s * s;
    let mut r = (((k[0] + k[1] * s) + (k[2] + k[3] * s) * s2) + k[4] * (s2 * s2)) * a;
    if up {
        r = k[5] - r;
    }
    if dt < 0.0 {
        r = k[6] - r;
    }
    r
}

/// Winning lane (0 = stay). Lanes are scored in order with early exit, like
/// `fastVisit` in JS: a lane stops once its non-decreasing partial sum reaches
/// the best energy so far, which decides exactly as the full sum would.
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(always)]
fn visit(v: &Visit, h: f32, pat: usize, _k: &Consts) -> usize {
    let mut best = f32::INFINITY;
    let mut won = 0;
    'lanes: for lane in 0..4 {
        let (ox, oy) = if lane == 0 { (0.0, 0.0) } else { (h * PAT_X[pat + lane - 1], h * PAT_Y[pat + lane - 1]) };
        let dx = ox - v.hx;
        let dy = oy - v.hy;
        let d2 = dx * dx + dy * dy;
        let d4 = d2 * d2;
        if d4 >= best {
            continue;
        }
        let ax = ox - v.a1x;
        let ay = oy - v.a1y;
        let bx = v.b1x - ox;
        let by = v.b1y - oy;
        let mut e = 0.0_f32;
        if v.t & 1 != 0 {
            e += abs_angle32(v.ulx * ay - v.uly * ax, v.ulx * ax + v.uly * ay);
            if e >= best {
                continue 'lanes;
            }
        }
        if v.t & 2 != 0 {
            e += abs_angle32(ax * by - ay * bx, ax * bx + ay * by);
            if e >= best {
                continue 'lanes;
            }
        }
        if v.t & 4 != 0 {
            e += abs_angle32(bx * v.vry - by * v.vrx, bx * v.vrx + by * v.vry);
            if e >= best {
                continue 'lanes;
            }
        }
        e += d4;
        if e < best {
            best = e;
            won = lane;
        }
    }
    won
}

// ---- simd128 kernel: one f32x4 per visit -------------------------------------------------------

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::*;

/// Splatted constants, built once per call from volatile loads so engines
/// keep them in registers instead of rebuilding `v128.const` at every use.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
struct Consts {
    at: [v128; 5],
    half_pi: v128,
    pi: v128,
    sign: v128,
    magnitude: v128,
    zero: v128,
    /// Lane offsets per pattern: `[0, dir1, dir2, dir3]` (× h → the four positions).
    px: [v128; 2],
    py: [v128; 2],
}

/// The constants as bit patterns: K32, PAT_X, R3, then the sign / magnitude masks.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
static CONSTS_BITS: [u32; 16] = [
    K32[0].to_bits(),
    K32[1].to_bits(),
    K32[2].to_bits(),
    K32[3].to_bits(),
    K32[4].to_bits(),
    K32[5].to_bits(),
    K32[6].to_bits(),
    PAT_X[0].to_bits(),
    PAT_X[1].to_bits(),
    PAT_X[2].to_bits(),
    PAT_X[3].to_bits(),
    PAT_X[4].to_bits(),
    PAT_X[5].to_bits(),
    R3.to_bits(),
    0x8000_0000,
    0x7FFF_FFFF,
];

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
impl Consts {
    #[inline(always)]
    fn load() -> Self {
        // SAFETY: plain reads of an initialised static.
        let b: [u32; 16] = core::array::from_fn(|i| unsafe { core::ptr::read_volatile(&CONSTS_BITS[i]) });
        let f = |i: usize| f32::from_bits(b[i]);
        let (r3, sign) = (f(13), b[14]);
        let zero = f32::from_bits(b[14] & b[15]); // +0
        Consts {
            at: core::array::from_fn(|i| f32x4_splat(f(i))),
            half_pi: f32x4_splat(f(5)),
            pi: f32x4_splat(f(6)),
            sign: u32x4_splat(sign),
            magnitude: u32x4_splat(b[15]),
            zero: f32x4_splat(zero),
            px: [f32x4(zero, f(7), f(8), f(9)), f32x4(zero, f(10), f(11), f(12))],
            py: [f32x4(zero, zero, r3, f32::from_bits(r3.to_bits() ^ sign)), f32x4(zero, r3, zero, f32::from_bits(r3.to_bits() ^ sign))],
        }
    }
}

/// Four `abs_angle32` at once (same rounding per lane; never −0).
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline(always)]
fn abs_angle4(cr: v128, dt: v128, k: &Consts) -> v128 {
    let ay = v128_and(cr, k.magnitude); // |cr|: clear the sign bit
    let ax = v128_and(dt, k.magnitude);
    let up = f32x4_gt(ay, ax);
    // pmax / pmin are the selects `ay > ax ? ay : ax` / `ay > ax ? ax : ay`.
    let mx = f32x4_pmax(ax, ay);
    let mn = f32x4_pmin(ay, ax);
    let a = f32x4_div(mn, mx); // NaN where mx == 0 — cleared at the end
    let s = f32x4_mul(a, a);
    let s2 = f32x4_mul(s, s);
    let q0 = f32x4_add(k.at[0], f32x4_mul(k.at[1], s));
    let q1 = f32x4_add(k.at[2], f32x4_mul(k.at[3], s));
    let p = f32x4_add(f32x4_add(q0, f32x4_mul(q1, s2)), f32x4_mul(k.at[4], f32x4_mul(s2, s2)));
    let r = f32x4_mul(p, a);
    // up ? π/2 − r : r  ==  (r ^ (up & SIGN)) + (up & π/2)   (−r + c is c − r exactly)
    let r = f32x4_add(v128_xor(r, v128_and(up, k.sign)), v128_and(up, k.half_pi));
    // dt < 0 ? π − r : r
    let neg = f32x4_lt(dt, k.zero);
    let r = f32x4_add(v128_xor(r, v128_and(neg, k.sign)), v128_and(neg, k.pi));
    v128_andnot(r, f32x4_eq(mx, k.zero))
}

/// Winning lane (0 = stay): the four energies in one vector, then
/// `ctz(bitmask(e == min(e)))`.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline(always)]
fn visit(v: &Visit, h: f32, pat: usize, k: &Consts) -> usize {
    let hv = f32x4_splat(h);
    let ox = f32x4_mul(hv, k.px[pat / 3]); // lane 0: h·0 = +0
    let oy = f32x4_mul(hv, k.py[pat / 3]);
    let dx = f32x4_sub(ox, f32x4_splat(v.hx));
    let dy = f32x4_sub(oy, f32x4_splat(v.hy));
    let d2 = f32x4_add(f32x4_mul(dx, dx), f32x4_mul(dy, dy));
    let d4 = f32x4_mul(d2, d2);
    let ax = f32x4_sub(ox, f32x4_splat(v.a1x));
    let ay = f32x4_sub(oy, f32x4_splat(v.a1y));
    let bx = f32x4_sub(f32x4_splat(v.b1x), ox);
    let by = f32x4_sub(f32x4_splat(v.b1y), oy);
    // e = ((+0 + t0) + t1) + t2 + d⁴ — the scalar order (+0 + t == t exactly).
    let mut e = k.zero;
    if v.t & 1 != 0 {
        let (ux, uy) = (f32x4_splat(v.ulx), f32x4_splat(v.uly));
        let cr = f32x4_sub(f32x4_mul(ux, ay), f32x4_mul(uy, ax));
        let dt = f32x4_add(f32x4_mul(ux, ax), f32x4_mul(uy, ay));
        e = f32x4_add(e, abs_angle4(cr, dt, k));
    }
    if v.t & 2 != 0 {
        let cr = f32x4_sub(f32x4_mul(ax, by), f32x4_mul(ay, bx));
        let dt = f32x4_add(f32x4_mul(ax, bx), f32x4_mul(ay, by));
        e = f32x4_add(e, abs_angle4(cr, dt, k));
    }
    if v.t & 4 != 0 {
        let (wx, wy) = (f32x4_splat(v.vrx), f32x4_splat(v.vry));
        let cr = f32x4_sub(f32x4_mul(bx, wy), f32x4_mul(by, wx));
        let dt = f32x4_add(f32x4_mul(bx, wx), f32x4_mul(by, wy));
        e = f32x4_add(e, abs_angle4(cr, dt, k));
    }
    let e = f32x4_add(e, d4);
    let m = f32x4_pmin(e, i32x4_shuffle::<1, 0, 3, 2>(e, e));
    let m = f32x4_pmin(m, i32x4_shuffle::<2, 3, 0, 1>(m, m));
    i32x4_bitmask(f32x4_eq(e, m)).trailing_zeros() as usize
}
