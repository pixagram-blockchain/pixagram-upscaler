//! Perceptual colour distance used by xBRZ, plus the per-row "distance plane"
//! kernel that feeds the corner pre-pass.
//!
//! The distance is Zenju's Rec.2020 YCbCr metric with ARGB alpha weighting,
//! evaluated **exactly** in `f32` on the channel differences (the same formula
//! the GPU shader's `DistYCbCr` evaluates). Earlier versions used a 15-bit
//! (5:5:5) lookup table that rounded every channel difference to steps of 16,
//! asymmetrically: `dist(a, b)` could be 0 while `dist(b, a)` was 16. On
//! gradient art (neighbouring colours ~10 apart) that collapsed the corner
//! pre-pass to `jg == fk` and silently disabled blending, leaving square
//! staircases. The exact metric is symmetric and has no table to build.
//!
//! Every operation below is IEEE-754 single precision, with no fused
//! multiply-add and a fixed evaluation order, so the scalar path, the
//! wasm `simd128` path and native builds produce bit-identical results.

const K_R: f32 = 0.2627;
const K_B: f32 = 0.0593;
const K_G: f32 = 1.0 - K_B - K_R;
const SCALE_B: f32 = 0.5 / (1.0 - K_B);
const SCALE_R: f32 = 0.5 / (1.0 - K_R);

/// `i / 255` for every alpha byte, evaluated at compile time with the same
/// correctly rounded `f32` division the runtime path used to perform.
static ALPHA_UNORM: [f32; 256] = {
    let mut t = [0.0f32; 256];
    let mut i = 0;
    while i < 256 {
        t[i] = i as f32 / 255.0;
        i += 1;
    }
    t
};

/// YCbCr distance of two RGBA pixels (`u32`, red in the low byte), weighted by
/// alpha exactly like Zenju's `ColorDistanceARGB`:
/// `min(a1, a2) * d + 255 * |a1 - a2|` with `a` normalised to `[0, 1]`.
///
/// Symmetric (`dist(p, q) == dist(q, p)` bit-for-bit) and `dist(p, p) == 0`.
#[inline(always)]
pub(crate) fn dist(p: u32, q: u32) -> f32 {
    let dr = ((p & 0xFF) as i32 - (q & 0xFF) as i32) as f32;
    let dg = (((p >> 8) & 0xFF) as i32 - ((q >> 8) & 0xFF) as i32) as f32;
    let db = (((p >> 16) & 0xFF) as i32 - ((q >> 16) & 0xFF) as i32) as f32;

    let y = K_R * dr + K_G * dg + K_B * db;
    let cb = SCALE_B * (db - y);
    let cr = SCALE_R * (dr - y);
    let d = (y * y + cb * cb + cr * cr).sqrt();

    let (pa, qa) = (p >> 24, q >> 24);
    if (pa & qa) == 255 {
        // Both opaque (the common case, and perfectly predictable on opaque
        // art): `1 * d + 255 * 0` is exactly d.
        return d;
    }
    let a1 = ALPHA_UNORM[pa as usize];
    let a2 = ALPHA_UNORM[qa as usize];
    let lt = a1 < a2;
    let amin = if lt { a1 } else { a2 };
    let adiff = if lt { a2 - a1 } else { a1 - a2 };
    amin * d + 255.0 * adiff
}

/// Number of elements the plane kernels actually write for a logical length
/// `n`: the SIMD build rounds up to whole vectors (no scalar tail), so plane
/// rows must be allocated with at least this many entries and pixel rows
/// with `vec_len(n) + 2` (+1 more for the knight kernel's `+2` offsets).
#[inline]
pub(crate) const fn vec_len(n: usize) -> usize {
    if cfg!(all(target_arch = "wasm32", target_feature = "simd128")) {
        (n + 3) & !3
    } else {
        n
    }
}

/// Neighbour planes of one row from two padded pixel rows `r0` (row y) and
/// `r1` (row y + 1), for `i < vec_len(n)`:
///
/// * `d[i] = dist(r0[i],   r1[i+1])`  diagonal      (x, y) - (x+1, y+1)
/// * `a[i] = dist(r0[i+1], r1[i])`    anti-diagonal (x+1, y) - (x, y+1)
/// * `h[i] = dist(r0[i],   r0[i+1])`  horizontal    (x, y) - (x+1, y)
/// * `v[i] = dist(r0[i],   r1[i])`    vertical      (x, y) - (x, y+1)
pub(crate) fn planes4(r0: &[u32], r1: &[u32], d: &mut [f32], a: &mut [f32], h: &mut [f32], v: &mut [f32], n: usize) {
    let m = vec_len(n);
    assert!(r0.len() > m && r1.len() > m);
    assert!(d.len() >= m && a.len() >= m && h.len() >= m && v.len() >= m);
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    // SAFETY: bounds asserted above (reads up to index m, writes below m).
    unsafe {
        simd::planes4(r0, r1, d, a, h, v, m);
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    for i in 0..m {
        let (p, pr, q, qr) = (r0[i], r0[i + 1], r1[i], r1[i + 1]);
        d[i] = dist(p, qr);
        a[i] = dist(pr, q);
        h[i] = dist(p, pr);
        v[i] = dist(p, q);
    }
}

/// Knight-move planes of one row from padded pixel rows `r0`, `r1`, `r2`
/// (rows y, y+1, y+2), for `i < vec_len(n)`:
///
/// * `wd[i] = dist(r0[i],   r1[i+2])`  wide  (x, y) - (x+2, y+1)
/// * `wa[i] = dist(r0[i+2], r1[i])`    wide  (x+2, y) - (x, y+1)
/// * `td[i] = dist(r0[i],   r2[i+1])`  tall  (x, y) - (x+1, y+2)
/// * `ta[i] = dist(r0[i+1], r2[i])`    tall  (x+1, y) - (x, y+2)
#[allow(clippy::too_many_arguments)]
pub(crate) fn knights4(
    r0: &[u32],
    r1: &[u32],
    r2: &[u32],
    wd: &mut [f32],
    wa: &mut [f32],
    td: &mut [f32],
    ta: &mut [f32],
    n: usize,
) {
    let m = vec_len(n);
    assert!(r0.len() > m + 1 && r1.len() > m + 1 && r2.len() > m);
    assert!(wd.len() >= m && wa.len() >= m && td.len() >= m && ta.len() >= m);
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    // SAFETY: bounds asserted above (reads up to index m + 1, writes below m).
    unsafe {
        simd::knights4(r0, r1, r2, wd, wa, td, ta, m);
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    for i in 0..m {
        wd[i] = dist(r0[i], r1[i + 2]);
        wa[i] = dist(r0[i + 2], r1[i]);
        td[i] = dist(r0[i], r2[i + 1]);
        ta[i] = dist(r0[i + 1], r2[i]);
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod simd {
    use core::arch::wasm32::*;

    use super::{K_B, K_G, K_R, SCALE_B, SCALE_R};

    /// Four lanes of [`super::dist`], operation for operation.
    #[inline(always)]
    fn dist4(p: v128, q: v128) -> v128 {
        let m = u32x4_splat(0xFF);
        let ch = |s: u32| {
            let a = v128_and(u32x4_shr(p, s), m);
            let b = v128_and(u32x4_shr(q, s), m);
            f32x4_convert_i32x4(i32x4_sub(a, b))
        };
        let dr = ch(0);
        let dg = ch(8);
        let db = ch(16);

        let y = f32x4_add(
            f32x4_add(f32x4_mul(f32x4_splat(K_R), dr), f32x4_mul(f32x4_splat(K_G), dg)),
            f32x4_mul(f32x4_splat(K_B), db),
        );
        let cb = f32x4_mul(f32x4_splat(SCALE_B), f32x4_sub(db, y));
        let cr = f32x4_mul(f32x4_splat(SCALE_R), f32x4_sub(dr, y));
        let d = f32x4_sqrt(f32x4_add(
            f32x4_add(f32x4_mul(y, y), f32x4_mul(cb, cb)),
            f32x4_mul(cr, cr),
        ));

        let pa = u32x4_shr(p, 24);
        let qa = u32x4_shr(q, 24);
        if u32x4_all_true(i32x4_eq(v128_and(pa, qa), u32x4_splat(255))) {
            return d;
        }
        // Per lane: opaque pairs still evaluate to exactly `d` below
        // (1 * d + 255 * 0), so mixing lanes is bit-identical to scalar.
        let k255 = f32x4_splat(255.0);
        let a1 = f32x4_div(f32x4_convert_u32x4(pa), k255);
        let a2 = f32x4_div(f32x4_convert_u32x4(qa), k255);
        let lt = f32x4_lt(a1, a2);
        let amin = v128_bitselect(a1, a2, lt);
        let adiff = v128_bitselect(f32x4_sub(a2, a1), f32x4_sub(a1, a2), lt);
        f32x4_add(f32x4_mul(amin, d), f32x4_mul(k255, adiff))
    }

    #[inline(always)]
    unsafe fn ld(s: &[u32], i: usize) -> v128 {
        v128_load(s.as_ptr().add(i) as *const v128)
    }

    #[inline(always)]
    unsafe fn st(s: &mut [f32], i: usize, v: v128) {
        v128_store(s.as_mut_ptr().add(i) as *mut v128, v)
    }

    /// Distance of one lane-pair vector, short-circuiting equal pairs to the
    /// exact `+0.0` that `dist4` would produce.
    #[inline(always)]
    fn pair(p: v128, q: v128) -> v128 {
        if v128_any_true(v128_xor(p, q)) {
            dist4(p, q)
        } else {
            f32x4_splat(0.0)
        }
    }

    /// # Safety
    /// `r0`, `r1` hold more than `m` pixels; outputs hold at least `m`;
    /// `m` is a multiple of 4.
    #[inline(always)]
    pub(super) unsafe fn planes4(
        r0: &[u32],
        r1: &[u32],
        d: &mut [f32],
        a: &mut [f32],
        h: &mut [f32],
        v: &mut [f32],
        m: usize,
    ) {
        let zero = f32x4_splat(0.0);
        let mut i = 0;
        while i < m {
            let p = ld(r0, i);
            let pr = ld(r0, i + 1);
            let q = ld(r1, i);
            let qr = ld(r1, i + 1);
            // Flat areas (most of a pixel-art image): when all eight pixels
            // are equal every distance is exactly dist(p, p) = +0.0.
            let any = v128_or(v128_or(v128_xor(p, pr), v128_xor(p, q)), v128_xor(p, qr));
            if !v128_any_true(any) {
                st(d, i, zero);
                st(a, i, zero);
                st(h, i, zero);
                st(v, i, zero);
            } else {
                st(d, i, dist4(p, qr));
                st(a, i, dist4(pr, q));
                st(h, i, dist4(p, pr));
                st(v, i, dist4(p, q));
            }
            i += 4;
        }
    }

    /// # Safety
    /// `r0`, `r1` hold more than `m + 1` pixels and `r2` more than `m`;
    /// outputs hold at least `m`; `m` is a multiple of 4.
    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    pub(super) unsafe fn knights4(
        r0: &[u32],
        r1: &[u32],
        r2: &[u32],
        wd: &mut [f32],
        wa: &mut [f32],
        td: &mut [f32],
        ta: &mut [f32],
        m: usize,
    ) {
        let mut i = 0;
        while i < m {
            let p = ld(r0, i);
            let p1 = ld(r0, i + 1);
            let p2 = ld(r0, i + 2);
            let q = ld(r1, i);
            let q2 = ld(r1, i + 2);
            let s = ld(r2, i);
            let s1 = ld(r2, i + 1);
            st(wd, i, pair(p, q2));
            st(wa, i, pair(p2, q));
            st(td, i, pair(p, s1));
            st(ta, i, pair(p1, s));
            i += 4;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(r: u8, g: u8, b: u8, a: u8) -> u32 {
        u32::from_le_bytes([r, g, b, a])
    }

    /// The reference formula, written independently in f64 for comparison.
    fn dist_f64(p: [u8; 4], q: [u8; 4]) -> f64 {
        let dr = p[0] as f64 - q[0] as f64;
        let dg = p[1] as f64 - q[1] as f64;
        let db = p[2] as f64 - q[2] as f64;
        let (kr, kb) = (0.2627, 0.0593);
        let kg = 1.0 - kb - kr;
        let y = kr * dr + kg * dg + kb * db;
        let cb = 0.5 / (1.0 - kb) * (db - y);
        let cr = 0.5 / (1.0 - kr) * (dr - y);
        let d = (y * y + cb * cb + cr * cr).sqrt();
        let (a1, a2) = (p[3] as f64 / 255.0, q[3] as f64 / 255.0);
        a1.min(a2) * d + 255.0 * (a1 - a2).abs()
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 16) as u32
        }
    }

    #[test]
    fn symmetric_exact_and_accurate() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..200_000 {
            let p = rng.next();
            let q = if rng.next() & 3 == 0 { p ^ (rng.next() & 0x0F0F_0F0F) } else { rng.next() };
            let (p, q) = if rng.next() & 1 == 0 { (p | 0xFF00_0000, q | 0xFF00_0000) } else { (p, q) };
            let d1 = dist(p, q);
            let d2 = dist(q, p);
            assert_eq!(d1.to_bits(), d2.to_bits(), "asymmetric for {p:08x} {q:08x}");
            let r = dist_f64(p.to_le_bytes(), q.to_le_bytes());
            assert!((d1 as f64 - r).abs() <= 1e-3 * (1.0 + r), "{p:08x} {q:08x}: {d1} vs {r}");
        }
        assert_eq!(dist(px(10, 20, 30, 255), px(10, 20, 30, 255)), 0.0);
        assert_eq!(dist(px(10, 20, 30, 0), px(200, 1, 3, 0)), 0.0);
        assert_eq!(dist(px(0, 0, 0, 0), px(9, 9, 9, 255)), 255.0);
    }

    /// The regression behind the "squared" 7x/8x output: neighbouring gradient
    /// colours ~10 apart must be at a non-zero, order-independent distance.
    #[test]
    fn small_gradient_steps_are_not_collapsed() {
        let m = px(76, 66, 114, 255);
        let d = px(66, 54, 104, 255);
        let a = dist(m, d);
        assert_eq!(a, dist(d, m));
        assert!((a - 11.4).abs() < 0.3, "{a}");
    }

    #[test]
    fn plane_kernels_match_scalar_dist() {
        let mut rng = Rng(42);
        for n in [1usize, 3, 4, 5, 8, 13, 64, 67] {
            let m = vec_len(n);
            let row = |rng: &mut Rng| -> Vec<u32> {
                (0..m + 3).map(|i| if i % 5 == 0 { 0xFF10_2030 } else { rng.next() }).collect()
            };
            let r0 = row(&mut rng);
            let mut r1 = row(&mut rng);
            let r2 = row(&mut rng);
            // equal runs exercise the zero shortcuts
            for i in (0..m + 3).step_by(3) {
                r1[i] = r0[i];
            }
            let mut o: Vec<Vec<f32>> = (0..8).map(|_| vec![1.0f32; m]).collect();
            let [d, a, h, v, wd, wa, td, ta] = &mut o[..] else { unreachable!() };
            planes4(&r0, &r1, d, a, h, v, n);
            knights4(&r0, &r1, &r2, wd, wa, td, ta, n);
            for i in 0..n {
                let b = |x: f32| x.to_bits();
                assert_eq!(b(d[i]), b(dist(r0[i], r1[i + 1])));
                assert_eq!(b(a[i]), b(dist(r0[i + 1], r1[i])));
                assert_eq!(b(h[i]), b(dist(r0[i], r0[i + 1])));
                assert_eq!(b(v[i]), b(dist(r0[i], r1[i])));
                assert_eq!(b(wd[i]), b(dist(r0[i], r1[i + 2])));
                assert_eq!(b(wa[i]), b(dist(r0[i + 2], r1[i])));
                assert_eq!(b(td[i]), b(dist(r0[i], r2[i + 1])));
                assert_eq!(b(ta[i]), b(dist(r0[i + 1], r2[i])));
            }
        }
    }
}
