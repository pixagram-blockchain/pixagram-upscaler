//! Curve geometry and the random-relaxation optimiser (paper §3.4).
//!
//! The candidate stream, energy formula and acceptance rule are those of
//! depixelize.js, so the optimised control points are bit-identical. The work
//! is reorganised for throughput, without changing any decision:
//!
//! * a control point whose energy is exactly 0 cannot be improved (energies
//!   are ≥ 0 and acceptance needs `e < best`), so its candidates are skipped —
//!   the PRNG is a Weyl counter and is advanced in O(1);
//! * otherwise all candidates are drawn first, their energies are computed as
//!   one dense batch (independent dependency chains; two candidates per
//!   `f64x2` with simd128), then accepted sequentially in draw order with the
//!   same `<` comparisons. Each energy is the exact JS value, so the result is
//!   identical to the JS early-exit loop;
//! * with simd128 the PRNG yields four outputs per `i32x4` step (its state is
//!   a Weyl counter, so lanes are independent) and candidate directions come
//!   from an interleaved (x, y) table — one 16-byte load per candidate.

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
use crate::math::{abs_angle_k, atan_consts};
use crate::math::{direction_table, DirTable, Mulberry32};
use crate::pipeline::{Curve, PixelData};

// ---- B-spline geometry (same formulas as segA / segC / nodePt in JS) ---------------------
#[inline]
pub(crate) fn seg_a(c: &Curve, x: &[f64], y: &[f64], s: usize) -> (f64, f64) {
    if !c.closed && s == 1 {
        return (x[0], y[0]);
    }
    let p = if s == 0 { c.n - 1 } else { s - 1 };
    ((x[p] + x[s]) * 0.5, (y[p] + y[s]) * 0.5)
}

#[inline]
pub(crate) fn seg_c(c: &Curve, x: &[f64], y: &[f64], s: usize) -> (f64, f64) {
    let n = c.n;
    if !c.closed && s == n - 1 {
        return (x[n], y[n]);
    }
    let q = if s == n - 1 { 0 } else { s + 1 };
    ((x[s] + x[q]) * 0.5, (y[s] + y[q]) * 0.5)
}

/// Point of the smooth curve associated with control point `k`.
#[inline]
pub(crate) fn node_pt(c: &Curve, x: &[f64], y: &[f64], k: usize) -> (f64, f64) {
    if c.border || (!c.closed && (k == 0 || k == c.n)) {
        return (x[k], y[k]);
    }
    let (ax, ay) = seg_a(c, x, y, k);
    let (cx, cy) = seg_c(c, x, y, k);
    ((ax + 2.0 * x[k] + cx) * 0.25, (ay + 2.0 * y[k] + cy) * 0.25)
}

impl PixelData {
    #[inline]
    pub(crate) fn curve_xy(&self, c: &Curve) -> (&[f64], &[f64]) {
        (&self.cx[c.off..c.off + c.m], &self.cy[c.off..c.off + c.m])
    }

    /// Moves the ends of T-junction curves onto their host curves; returns the
    /// largest change (Manhattan), like `_updateAttachments`.
    pub(crate) fn update_attachments(&mut self) -> f64 {
        let mut delta = 0.0_f64;
        for t in 0..self.attached.len() {
            let ci = self.attached[t] as usize;
            let c = self.curves[ci];
            if c.att0 >= 0 {
                let h = self.curves[c.att0 as usize];
                let (hx, hy) = self.curve_xy(&h);
                let (tx, ty) = node_pt(&h, hx, hy, c.att0j);
                let i = c.off;
                delta = delta.max((tx - self.cx[i]).abs() + (ty - self.cy[i]).abs());
                self.cx[i] = tx;
                self.cy[i] = ty;
            }
            if c.att1 >= 0 {
                let h = self.curves[c.att1 as usize];
                let (hx, hy) = self.curve_xy(&h);
                let (tx, ty) = node_pt(&h, hx, hy, c.att1j);
                let i = c.off + c.n;
                delta = delta.max((tx - self.cx[i]).abs() + (ty - self.cy[i]).abs());
                self.cx[i] = tx;
                self.cy[i] = ty;
            }
        }
        delta
    }

    /// Settles attachments and computes the rendered position of every node.
    pub(crate) fn finalize(&mut self) {
        for _ in 0..64 {
            if self.update_attachments() < 1e-12 {
                break;
            }
        }
        let nn = self.node_count;
        let mut qx = vec![0f64; nn];
        let mut qy = vec![0f64; nn];
        for v in 0..nn {
            qx[v] = self.node_x[v] as f64 * 0.25;
            qy[v] = self.node_y[v] as f64 * 0.25;
        }
        for c in &self.curves {
            let (x, y) = (&self.cx[c.off..c.off + c.m], &self.cy[c.off..c.off + c.m]);
            for k in 0..c.m {
                let (px, py) = node_pt(c, x, y, k);
                let v = self.c_nodes[c.off + k] as usize;
                qx[v] = px;
                qy[v] = py;
            }
        }
        self.qx = qx;
        self.qy = qy;
    }

    pub(crate) fn optimize(&mut self, iterations: i32, guesses: i32, offset: f64, seed: i32) {
        let iters = iterations.max(0) as usize;
        let guesses = guesses.max(0) as usize;
        if iters == 0 || guesses == 0 || !(offset > 0.0) {
            return;
        }
        let mut rng = Mulberry32::new(seed);
        let dir = direction_table();
        let mut sc = Scratch::new(guesses);
        let live: Vec<Curve> = self
            .curves
            .iter()
            .filter(|c| !c.border && if c.closed { c.n >= 3 } else { c.n >= 2 })
            .copied()
            .collect();
        for _ in 0..iters {
            self.update_attachments();
            for c in &live {
                let r = c.off..c.off + c.m;
                relax_curve(
                    c,
                    &mut self.cx[r.clone()],
                    &mut self.cy[r.clone()],
                    &self.cox[r.clone()],
                    &self.coy[r.clone()],
                    &self.cex[r],
                    &mut rng,
                    &dir,
                    &mut sc,
                    guesses,
                    offset,
                );
            }
        }
    }
}

/// Everything the energy of control point i needs except the candidate itself.
/// Terms: t0 = turn at i−1, t1 = turn at i, t2 = turn at i+1 (in that order,
/// as in JS); each is present only if it exists and is not a corner pattern.
#[derive(Clone, Copy)]
struct Ctx {
    t0: bool,
    t1: bool,
    t2: bool,
    // t0: u = P[i-1] − P[i-2] (constant), v = P[i] − P[i-1]
    u0x: f64,
    u0y: f64,
    // P[i-1] and P[i+1]
    mx: f64,
    my: f64,
    px: f64,
    py: f64,
    // t2: u = P[i+1] − P[i], v = P[i+2] − P[i+1] (constant)
    v2x: f64,
    v2y: f64,
    // original position (positional term)
    ox: f64,
    oy: f64,
}

impl Ctx {
    #[inline(always)]
    fn new(c: &Curve, x: &[f64], y: &[f64], ox: &[f64], oy: &[f64], ex: &[u8], i: usize) -> Ctx {
        let n = c.n;
        let (im1, im2, ip1, ip2, t0, t2) = if c.closed {
            let im1 = if i == 0 { n - 1 } else { i - 1 };
            let im2 = if im1 == 0 { n - 1 } else { im1 - 1 };
            let ip1 = if i == n - 1 { 0 } else { i + 1 };
            let ip2 = if ip1 == n - 1 { 0 } else { ip1 + 1 };
            (im1, im2, ip1, ip2, ex[im1] == 0, ex[ip1] == 0)
        } else {
            let t0 = i >= 2 && ex[i - 1] == 0;
            let t2 = i + 1 < n && ex[i + 1] == 0;
            (i - 1, i.saturating_sub(2), i + 1, (i + 2).min(n), t0, t2)
        };
        Ctx {
            t0,
            t1: ex[i] == 0,
            t2,
            u0x: x[im1] - x[im2],
            u0y: y[im1] - y[im2],
            mx: x[im1],
            my: y[im1],
            px: x[ip1],
            py: y[ip1],
            v2x: x[ip2] - x[ip1],
            v2y: y[ip2] - y[ip1],
            ox: ox[i],
            oy: oy[i],
        }
    }

    /// Energy of the candidate (xi, yi); returns early with a value ≥ `bound`
    /// when the candidate cannot beat it (all terms are ≥ 0). Scalar build only
    /// (the SIMD build has its own two-lane kernel).
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    #[inline(always)]
    fn energy(&self, xi: f64, yi: f64, bound: f64, k: &[f64; 7]) -> f64 {
        let dx = xi - self.ox;
        let dy = yi - self.oy;
        let d2 = dx * dx + dy * dy;
        let d4 = d2 * d2;
        if d4 >= bound {
            return d4;
        }
        let mut e = 0.0_f64;
        if self.t0 {
            let vx = xi - self.mx;
            let vy = yi - self.my;
            e += abs_angle_k(self.u0x * vy - self.u0y * vx, self.u0x * vx + self.u0y * vy, k);
            if e >= bound {
                return e;
            }
        }
        if self.t1 {
            let ux = xi - self.mx;
            let uy = yi - self.my;
            let vx = self.px - xi;
            let vy = self.py - yi;
            e += abs_angle_k(ux * vy - uy * vx, ux * vx + uy * vy, k);
            if e >= bound {
                return e;
            }
        }
        if self.t2 {
            let ux = self.px - xi;
            let uy = self.py - yi;
            e += abs_angle_k(ux * self.v2y - uy * self.v2x, ux * self.v2x + uy * self.v2y, k);
            if e >= bound {
                return e;
            }
        }
        e + d4
    }
}

/// Scratch buffers for one node: `guesses` candidates followed by the
/// current position (so its energy is computed in the same batch), padded to
/// an even length.
pub(crate) struct Scratch {
    cx: Vec<f64>,
    cy: Vec<f64>,
    e: Vec<f64>,
}

impl Scratch {
    pub(crate) fn new(guesses: usize) -> Self {
        let slots = guesses + 1;
        let len = slots + (slots & 1);
        Scratch { cx: vec![0.0; len], cy: vec![0.0; len], e: vec![0.0; len] }
    }
}

impl Ctx {
    /// True when the energy at (x0, y0) is exactly 0 — then no candidate can
    /// be accepted. A turn is exactly 0 when cross = 0 and dot ≥ 0 (sufficient
    /// condition; anything else falls through to the exact computation).
    #[inline(always)]
    fn at_rest(&self, x0: f64, y0: f64) -> bool {
        let dx = x0 - self.ox;
        let dy = y0 - self.oy;
        let d2 = dx * dx + dy * dy;
        if d2 * d2 != 0.0 {
            return false;
        }
        let flat = |cr: f64, dt: f64| cr == 0.0 && !(dt < 0.0);
        if self.t0 {
            let vx = x0 - self.mx;
            let vy = y0 - self.my;
            if !flat(self.u0x * vy - self.u0y * vx, self.u0x * vx + self.u0y * vy) {
                return false;
            }
        }
        if self.t1 {
            let ux = x0 - self.mx;
            let uy = y0 - self.my;
            let vx = self.px - x0;
            let vy = self.py - y0;
            if !flat(ux * vy - uy * vx, ux * vx + uy * vy) {
                return false;
            }
        }
        if self.t2 {
            let ux = self.px - x0;
            let uy = self.py - y0;
            if !flat(ux * self.v2y - uy * self.v2x, ux * self.v2x + uy * self.v2y) {
                return false;
            }
        }
        true
    }
}

/// Relaxes all control points of one curve. Kept out of line so that engines
/// with tiered wasm compilers optimise it early (it is called many times).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn relax_curve(
    c: &Curve,
    x: &mut [f64],
    y: &mut [f64],
    ox: &[f64],
    oy: &[f64],
    ex: &[u8],
    rng: &mut Mulberry32,
    dir: &DirTable,
    sc: &mut Scratch,
    guesses: usize,
    off: f64,
) {
    let (lo, hi) = (if c.closed { 0 } else { 1 }, c.n - 1);
    let slots = guesses + 1;
    for i in lo..=hi {
        let ctx = Ctx::new(c, x, y, ox, oy, ex, i);
        let (x0, y0) = (x[i], y[i]);
        if ctx.at_rest(x0, y0) {
            // Energy 0: no candidate can satisfy e < best; keep the stream in step.
            rng.skip(2 * guesses);
            continue;
        }
        draw(rng, sc, x0, y0, off, dir, guesses);
        sc.cx[guesses] = x0;
        sc.cy[guesses] = y0;
        if slots & 1 == 1 {
            sc.cx[slots] = x0;
            sc.cy[slots] = y0;
        }
        let len = sc.cx.len();
        match (ctx.t0, ctx.t1, ctx.t2) {
            (false, false, false) => energies::<false, false, false>(&ctx, &sc.cx, &sc.cy, &mut sc.e[..len]),
            (false, false, true) => energies::<false, false, true>(&ctx, &sc.cx, &sc.cy, &mut sc.e[..len]),
            (false, true, false) => energies::<false, true, false>(&ctx, &sc.cx, &sc.cy, &mut sc.e[..len]),
            (false, true, true) => energies::<false, true, true>(&ctx, &sc.cx, &sc.cy, &mut sc.e[..len]),
            (true, false, false) => energies::<true, false, false>(&ctx, &sc.cx, &sc.cy, &mut sc.e[..len]),
            (true, false, true) => energies::<true, false, true>(&ctx, &sc.cx, &sc.cy, &mut sc.e[..len]),
            (true, true, false) => energies::<true, true, false>(&ctx, &sc.cx, &sc.cy, &mut sc.e[..len]),
            (true, true, true) => energies::<true, true, true>(&ctx, &sc.cx, &sc.cy, &mut sc.e[..len]),
        }
        // Sequential acceptance in draw order, exactly as in JS.
        let (mut best, mut bx, mut by) = (sc.e[guesses], x0, y0);
        for g in 0..guesses {
            let e = sc.e[g];
            if e < best {
                best = e;
                bx = sc.cx[g];
                by = sc.cy[g];
            }
        }
        x[i] = bx;
        y[i] = by;
    }
}

/// Draws `guesses` candidates around (x0, y0): r = rand()·off, k = ⌊rand()·256⌋.
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn draw(rng: &mut Mulberry32, sc: &mut Scratch, x0: f64, y0: f64, off: f64, dir: &DirTable, guesses: usize) {
    for g in 0..guesses {
        let r = rng.next() * off;
        let k = ((rng.next() * 256.0) as usize) & 255;
        sc.cx[g] = x0 + r * dir.0[k][0];
        sc.cy[g] = y0 + r * dir.0[k][1];
    }
}

/// SIMD draw: two candidates per step of a four-lane PRNG stream. rand()·off
/// is formed exactly as in JS ((u / 2³²) · off); ⌊rand()·256⌋ is the top byte
/// of the raw output.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn draw(rng: &mut Mulberry32, sc: &mut Scratch, x0: f64, y0: f64, off: f64, dir: &DirTable, guesses: usize) {
    use crate::math::simd::Stream4;
    use core::arch::wasm32::*;
    const INV32: f64 = 1.0 / 4_294_967_296.0;
    let (x0v, y0v, offv, inv) = (f64x2_splat(x0), f64x2_splat(y0), f64x2_splat(off), f64x2_splat(INV32));
    let pairs = guesses / 2;
    let mut st = Stream4::new(rng.state());
    let base = dir.0.as_ptr();
    for (xc, yc) in sc.cx[..2 * pairs].chunks_exact_mut(2).zip(sc.cy[..2 * pairs].chunks_exact_mut(2)) {
        let o = st.next(); // [r_g, k_g, r_g+1, k_g+1]
        let ru = i32x4_shuffle::<0, 2, 0, 2>(o, o);
        let r = f64x2_mul(f64x2_mul(f64x2_convert_low_u32x4(ru), inv), offv);
        let kk = u32x4_shr(o, 24);
        // SAFETY: kk lanes are < 256; each chunk holds exactly two f64.
        unsafe {
            let d0 = v128_load(base.add(u32x4_extract_lane::<1>(kk) as usize) as *const v128);
            let d1 = v128_load(base.add(u32x4_extract_lane::<3>(kk) as usize) as *const v128);
            let cxv = f64x2_add(x0v, f64x2_mul(r, i64x2_shuffle::<0, 2>(d0, d1)));
            let cyv = f64x2_add(y0v, f64x2_mul(r, i64x2_shuffle::<1, 3>(d0, d1)));
            v128_store(xc.as_mut_ptr() as *mut v128, cxv);
            v128_store(yc.as_mut_ptr() as *mut v128, cyv);
        }
    }
    rng.skip(4 * pairs);
    if guesses & 1 == 1 {
        let g = guesses - 1;
        let r = rng.next() * off;
        let k = ((rng.next() * 256.0) as usize) & 255;
        sc.cx[g] = x0 + r * dir.0[k][0];
        sc.cy[g] = y0 + r * dir.0[k][1];
    }
}

/// Exact energies of all slots (scalar build). Iterations are independent, so
/// the CPU overlaps their dependency chains.
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(always)]
fn energies<const T0: bool, const T1: bool, const T2: bool>(ctx: &Ctx, cx: &[f64], cy: &[f64], out: &mut [f64]) {
    let c = Ctx { t0: T0, t1: T1, t2: T2, ..*ctx };
    let k = atan_consts();
    for ((o, &xi), &yi) in out.iter_mut().zip(cx).zip(cy) {
        *o = c.energy(xi, yi, f64::INFINITY, &k);
    }
}

/// Exact energies of all slots, two per `f64x2`; each lane repeats the scalar
/// operation sequence (t0 + t1 + t2, then + d⁴).
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline(always)]
fn energies<const T0: bool, const T1: bool, const T2: bool>(ctx: &Ctx, cx: &[f64], cy: &[f64], out: &mut [f64]) {
    use crate::math::simd::{abs_angle2, splat, AtanK2};
    use core::arch::wasm32::*;
    let k = AtanK2::load();
    let (oxv, oyv) = (splat(ctx.ox), splat(ctx.oy));
    let (mxv, myv, pxv, pyv) = (splat(ctx.mx), splat(ctx.my), splat(ctx.px), splat(ctx.py));
    let (u0x, u0y, v2x, v2y) = (splat(ctx.u0x), splat(ctx.u0y), splat(ctx.v2x), splat(ctx.v2y));
    for ((xc, yc), oc) in cx.chunks_exact(2).zip(cy.chunks_exact(2)).zip(out.chunks_exact_mut(2)) {
        // SAFETY: each chunk holds exactly two f64 (16 bytes); wasm loads need no alignment.
        let (xi, yi) = unsafe { (v128_load(xc.as_ptr() as *const v128), v128_load(yc.as_ptr() as *const v128)) };
        let dx = f64x2_sub(xi, oxv);
        let dy = f64x2_sub(yi, oyv);
        let d2 = f64x2_add(f64x2_mul(dx, dx), f64x2_mul(dy, dy));
        let d4 = f64x2_mul(d2, d2);
        // e = t0 + t1 + t2 in this order (JS starts from +0, and +0 + t == t
        // because abs_angle2 never returns −0).
        let mut e = splat(0.0);
        let mut first = true;
        let mut add = |t: v128| {
            e = if first { t } else { f64x2_add(e, t) };
            first = false;
        };
        if T0 {
            let vx = f64x2_sub(xi, mxv);
            let vy = f64x2_sub(yi, myv);
            let cr = f64x2_sub(f64x2_mul(u0x, vy), f64x2_mul(u0y, vx));
            let dt = f64x2_add(f64x2_mul(u0x, vx), f64x2_mul(u0y, vy));
            add(abs_angle2(cr, dt, &k));
        }
        if T1 {
            let ux = f64x2_sub(xi, mxv);
            let uy = f64x2_sub(yi, myv);
            let vx = f64x2_sub(pxv, xi);
            let vy = f64x2_sub(pyv, yi);
            let cr = f64x2_sub(f64x2_mul(ux, vy), f64x2_mul(uy, vx));
            let dt = f64x2_add(f64x2_mul(ux, vx), f64x2_mul(uy, vy));
            add(abs_angle2(cr, dt, &k));
        }
        if T2 {
            let ux = f64x2_sub(pxv, xi);
            let uy = f64x2_sub(pyv, yi);
            let cr = f64x2_sub(f64x2_mul(ux, v2y), f64x2_mul(uy, v2x));
            let dt = f64x2_add(f64x2_mul(ux, v2x), f64x2_mul(uy, v2y));
            add(abs_angle2(cr, dt, &k));
        }
        // SAFETY: the output chunk holds exactly two f64.
        unsafe { v128_store(oc.as_mut_ptr() as *mut v128, f64x2_add(e, d4)) };
    }
}
