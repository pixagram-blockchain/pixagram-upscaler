//! Deterministic numeric kernels shared with `depixelize.js`.
//!
//! Everything here uses only `+ − × ÷`, comparisons and integer operations.
//! Those are correctly rounded IEEE-754 operations in every engine (V8, wasm,
//! native), and Rust never contracts `a * b + c` into an FMA, so the JS
//! reference and this crate compute bit-identical values. `atan2`, `sin` and
//! `cos` are avoided on purpose: their last-bit results are implementation
//! specific.

/// Degree-4 minimax polynomial for `atan(a) / a` in `s = a²`, `a ∈ [0, 1]`
/// (max |error| of `atan` ≈ 1.1e-5 rad), evaluated with Estrin's scheme.
const AT0: f64 = 0.9998663291207185;
const AT1: f64 = -0.33030477985595086;
const AT2: f64 = 0.18015927121038314;
const AT3: f64 = -0.08515631565062434;
const AT4: f64 = 0.02084509680032225;
const HALF_PI: f64 = core::f64::consts::FRAC_PI_2;
const PI: f64 = core::f64::consts::PI;

/// The polynomial coefficients followed by π/2 and π.
pub(crate) const ATAN_K: [f64; 7] = [AT0, AT1, AT2, AT3, AT4, HALF_PI, PI];
static ATAN_K_MEM: [f64; 7] = ATAN_K;

/// Reads [`ATAN_K`] through volatile loads, once per hot loop. The values are
/// then opaque to LLVM and stay in locals instead of being re-emitted as
/// literals at every use (engines build each wasm literal from immediates).
#[inline(always)]
pub(crate) fn atan_consts() -> [f64; 7] {
    // SAFETY: plain reads of an initialised static.
    core::array::from_fn(|i| unsafe { core::ptr::read_volatile(&ATAN_K_MEM[i]) })
}

/// `|atan2(cr, dt)|` ∈ [0, π] — same operation sequence as `absAngle` in JS.
/// `k` is [`ATAN_K`] (see [`atan_consts`]).
#[cfg_attr(all(target_arch = "wasm32", target_feature = "simd128"), allow(dead_code))]
#[inline(always)]
pub(crate) fn abs_angle_k(cr: f64, dt: f64, k: &[f64; 7]) -> f64 {
    let ay = if cr < 0.0 { -cr } else { cr };
    let ax = if dt < 0.0 { -dt } else { dt };
    let mx = if ay > ax { ay } else { ax };
    if mx == 0.0 {
        return 0.0;
    }
    let a = (if ay > ax { ax } else { ay }) / mx;
    let s = a * a;
    let s2 = s * s;
    let p = ((k[0] + k[1] * s) + (k[2] + k[3] * s) * s2) + k[4] * (s2 * s2);
    let mut r = p * a;
    if ay > ax {
        r = k[5] - r;
    }
    if dt < 0.0 {
        r = k[6] - r;
    }
    r
}

/// SIMD (`f64x2`) twins: every lane performs exactly the scalar operation
/// sequence, so results are bit-identical.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
pub(crate) mod simd {
    use core::arch::wasm32::*;

    #[inline(always)]
    pub(crate) fn splat(v: f64) -> v128 {
        f64x2_splat(v)
    }

    /// Splatted [`super::ATAN_K`], loaded once per hot loop.
    pub(crate) struct AtanK2([v128; 7]);

    impl AtanK2 {
        #[inline(always)]
        pub(crate) fn load() -> Self {
            let k = super::atan_consts();
            AtanK2(core::array::from_fn(|i| f64x2_splat(k[i])))
        }
    }

    /// Two [`super::abs_angle_k`] at once. The result is never −0 (abs() maps
    /// −0 to +0 where JS may keep −0; sums starting from +0 are unaffected).
    #[inline(always)]
    pub(crate) fn abs_angle2(cr: v128, dt: v128, k: &AtanK2) -> v128 {
        let k = &k.0;
        let ay = f64x2_abs(cr);
        let ax = f64x2_abs(dt);
        let gt = f64x2_gt(ay, ax);
        // pmax/pmin are `b < a ? a : b`-style selects, i.e. exactly the scalar
        // `ay > ax ? ay : ax` / `ay > ax ? ax : ay` (one maxpd/minpd each).
        let mx = f64x2_pmax(ax, ay);
        let mn = f64x2_pmin(ay, ax);
        let a = f64x2_div(mn, mx); // NaN where mx == 0, masked below
        let s = f64x2_mul(a, a);
        let s2 = f64x2_mul(s, s);
        let q0 = f64x2_add(k[0], f64x2_mul(k[1], s));
        let q1 = f64x2_add(k[2], f64x2_mul(k[3], s));
        let p = f64x2_add(f64x2_add(q0, f64x2_mul(q1, s2)), f64x2_mul(k[4], f64x2_mul(s2, s2)));
        let r0 = f64x2_mul(p, a);
        let r1 = v128_bitselect(f64x2_sub(k[5], r0), r0, gt);
        let neg = f64x2_lt(dt, splat(0.0));
        let r2 = v128_bitselect(f64x2_sub(k[6], r1), r1, neg);
        v128_andnot(r2, f64x2_eq(mx, splat(0.0)))
    }

    /// Mulberry32 outputs four at a time. The state is a Weyl counter, so the
    /// lanes hash s + C·(4n + 1 … 4n + 4) directly.
    pub(crate) struct Stream4 {
        s: v128,
        step: v128,
    }

    impl Stream4 {
        #[inline(always)]
        pub(crate) fn new(state: u32) -> Self {
            const C: u32 = super::WEYL;
            let s = i32x4_add(u32x4_splat(state), u32x4(C, C.wrapping_mul(2), C.wrapping_mul(3), C.wrapping_mul(4)));
            Stream4 { s, step: u32x4_splat(C.wrapping_mul(4)) }
        }

        /// The next four raw 32-bit outputs (before scaling by 2⁻³²).
        #[inline(always)]
        pub(crate) fn next(&mut self) -> v128 {
            let a = self.s;
            self.s = i32x4_add(a, self.step);
            let mut t = i32x4_mul(v128_xor(a, u32x4_shr(a, 15)), v128_or(a, u32x4_splat(1)));
            t = v128_xor(i32x4_add(t, i32x4_mul(v128_xor(t, u32x4_shr(t, 7)), v128_or(t, u32x4_splat(61)))), t);
            v128_xor(t, u32x4_shr(t, 14))
        }
    }
}

const WEYL: u32 = 0x6D2B_79F5;

/// Mulberry32 PRNG — identical stream to the JS `mulberry32(seed)`.
pub(crate) struct Mulberry32(u32);

impl Mulberry32 {
    pub(crate) fn new(seed: i32) -> Self {
        Mulberry32(seed as u32)
    }
    /// The raw state (the next output hashes `state + C`).
    #[inline(always)]
    #[allow(dead_code)]
    pub(crate) fn state(&self) -> u32 {
        self.0
    }
    /// Skips `k` outputs in O(1): the state is a Weyl sequence (a counter).
    #[inline(always)]
    pub(crate) fn skip(&mut self, k: usize) {
        self.0 = self.0.wrapping_add(WEYL.wrapping_mul(k as u32));
    }
    #[inline(always)]
    pub(crate) fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(WEYL);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }
}

/// 256 unit directions (x, y), generated by repeated exact rotation (no
/// sin/cos) — the same values as `DIR_X` / `DIR_Y` in JS. Interleaved and
/// 16-byte aligned so a SIMD lane fetches one direction with one load.
#[repr(C, align(16))]
pub(crate) struct DirTable(pub(crate) [[f64; 2]; 256]);

pub(crate) fn direction_table() -> DirTable {
    let (c, s) = (0.9996988186962042_f64, 0.024541228522912288_f64);
    let mut d = [[0.0; 2]; 256];
    let (mut x, mut y) = (1.0_f64, 0.0_f64);
    for e in d.iter_mut() {
        *e = [x, y];
        let nx = x * c - y * s;
        y = x * s + y * c;
        x = nx;
    }
    DirTable(d)
}

/// `Math.round` semantics (round half towards +∞).
#[inline]
pub(crate) fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// Corner patterns of Fig. 7 (¼-pixel units relative to a pixel's top-left
/// corner), expanded to the 8 symmetries and both directions, deduplicated —
/// same construction as the JS `CORNER_PATTERNS`.
pub(crate) fn corner_patterns() -> Vec<Vec<i32>> {
    const BASE: [&[i32]; 5] = [
        &[0, 4, 1, 1, 3, 1, 4, 4],
        &[-1, 3, 1, 1, 3, 1, 4, 4],
        &[-1, 3, 1, 1, 3, 1, 5, 3],
        &[0, 4, 0, 0, 4, 0, 4, 4],
        &[3, 5, 1, 3, 1, 1, 3, 1, 5, 3],
    ];
    let mut out: Vec<Vec<i32>> = Vec::new();
    for p in BASE {
        for s in 0..8 {
            for rev in 0..2 {
                let l = p.len() / 2;
                let mut q = vec![0i32; p.len()];
                for k in 0..l {
                    let (mut dx, mut dy) = (p[2 * k] - 2, p[2 * k + 1] - 2);
                    if s & 4 != 0 {
                        dx = -dx;
                    }
                    for _ in 0..(s & 3) {
                        let t = dx;
                        dx = -dy;
                        dy = t;
                    }
                    let d = if rev == 1 { l - 1 - k } else { k };
                    q[2 * d] = dx + 2;
                    q[2 * d + 1] = dy + 2;
                }
                if !out.contains(&q) {
                    out.push(q);
                }
            }
        }
    }
    out
}
