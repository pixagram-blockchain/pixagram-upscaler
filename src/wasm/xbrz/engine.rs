//! Band renderer: produces destination rows `[y0 * n, y1 * n)` for source rows
//! `[y0, y1)`, streaming over the image with O(width) ring buffers.
//!
//! Pipeline per source row `y`:
//!
//! 1. **Pixel ring** - padded copies (2 transparent pixels on every side) of
//!    source rows `y-1 ..= y+2`; no access ever needs a bounds branch.
//! 2. **Distance planes** - every colour distance the algorithm can ask for is
//!    between two pixels at most a knight's move apart, so each pair is
//!    computed once per row instead of up to ten times per pixel. [`planes4`]
//!    fills horizontal `H`, vertical `V`, diagonal `D` and anti-diagonal `A`
//!    in one fused pass (four lanes at a time on wasm `simd128`, with an exact
//!    zero shortcut for flat areas). The four knight-move planes (wide
//!    `(2, 1)`, tall `(1, 2)`, each mirrored; [`knights4`]) only pay off where
//!    many pixels blend: they are built for *dense* rows and cached per row,
//!    while sparse rows compute their two knight distances on demand.
//! 3. **Corner pre-pass** - Zenju's `preProcessCorners` for the 2x2 block at
//!    `(x, y)`. Its two gradient sums are plus-shaped stencils over two planes:
//!    `jg = A[x-1,y] + A[x,y-1] + A[x,y+1] + A[x+1,y] + bias * A[x,y]`,
//!    `fk = D[x-1,y] + D[x,y+1] + D[x,y-1] + D[x+1,y] + bias * D[x,y]`
//!    (same operands, same summation order as the reference: bit-identical).
//!    Vectorised and branch-free on `simd128`.
//! 4. **Output** - the first destination row of a band row is expanded (`n`
//!    copies of each pixel) and replicated to the other `n - 1` rows with
//!    `copy_within` (wasm `memory.copy`); then only pixels with a blended
//!    corner run [`blend_pixel`], whose neighbour distances are plane lookups.
//!
//! Semantics are those of Zenju's xBRZ 1.8 `scaleImage` / `blendPixel` with the
//! ARGB colour distance, including his first-column corner bookkeeping (the
//! earlier Rust port stored the bottom-left corner of column 0 in its top-left
//! slot) and his exact-inequality line-shape test.

use super::config::ScalerConfig;
use super::dist::{dist, knights4, planes4, vec_len};
use super::scaler::{Prepared, CORNER, DIAGONAL, SHALLOW, STEEP, STEEP_AND_SHALLOW};

const BLEND_NONE: u32 = 0;
const BLEND_DOMINANT: u32 = 2;

/// Pre-pass result fields for the 2x2 block F G / J K (2 bits each): the blend
/// type of the corner the four pixels share, as seen from each of them.
const SHIFT_F: u32 = 0; // bottom-right corner of F
const SHIFT_G: u32 = 2; // bottom-left corner of G
const SHIFT_J: u32 = 4; // top-right corner of J
const SHIFT_K: u32 = 6; // top-left corner of K

/// Per-pixel corner info (2 bits each), Zenju's `blendInfo` byte.
const C_TL: u32 = 0;
const C_TR: u32 = 2;
const C_BL: u32 = 4;
const C_BR: u32 = 6;

/// Config converted once to the `f32` values the kernels compare against.
#[derive(Clone, Copy)]
pub(crate) struct Params {
    tol: f32,
    bias: f32,
    dominant: f32,
    steep: f32,
}

impl Params {
    pub(crate) fn new(cfg: &ScalerConfig) -> Self {
        Self {
            tol: cfg.equal_color_tolerance as f32,
            bias: cfg.center_direction_bias as f32,
            dominant: cfg.dominant_direction_threshold as f32,
            steep: cfg.steep_direction_threshold as f32,
        }
    }
}

/// Largest supported width / height. Keeps every row index, padded column
/// and packed offset comfortably inside `i32` / `u32`, also on wasm32.
pub(crate) const MAX_DIM: usize = 1 << 28;

/// Read access to the RGBA source, tolerant of any byte alignment. Holds the
/// whole image, or a window of consecutive rows of it (band rendering).
#[derive(Clone, Copy)]
pub(crate) struct Source<'a> {
    bytes: &'a [u8],
    w: usize,
    /// Height of the full image (rows outside `0..h` read as transparent).
    h: usize,
    /// First image row held in `bytes`, and how many rows it holds.
    y_base: usize,
    rows: usize,
}

impl<'a> Source<'a> {
    pub(crate) fn new(bytes: &'a [u8], w: usize, h: usize) -> Self {
        assert!(w <= MAX_DIM && h <= MAX_DIM, "image dimensions exceed {MAX_DIM}");
        assert_eq!(bytes.len(), w * h * 4);
        Self { bytes, w, h, y_base: 0, rows: h }
    }

    /// Rows `[y_base, y_base + bytes.len() / (4w))` of a `w x h` image.
    pub(crate) fn window(bytes: &'a [u8], w: usize, h: usize, y_base: usize) -> Self {
        assert!(w <= MAX_DIM && h <= MAX_DIM, "image dimensions exceed {MAX_DIM}");
        assert!(w > 0 && bytes.len() % (w * 4) == 0);
        let rows = bytes.len() / (w * 4);
        assert!(y_base + rows <= h);
        Self { bytes, w, h, y_base, rows }
    }

    #[inline]
    pub(crate) fn dims(&self) -> (usize, usize) {
        (self.w, self.h)
    }

    /// Writes padded row `y` (`-2 <= y < h + 2`) into `out` (at least `w + 4`
    /// pixels): two transparent pixels, the row, then transparent slack.
    fn load_row(&self, y: isize, out: &mut [u32]) {
        let w = self.w;
        debug_assert!(out.len() >= w + 4);
        if y < 0 || y >= self.h as isize {
            out.fill(0);
            return;
        }
        out[..2].fill(0);
        out[w + 2..].fill(0);
        let r = y as usize;
        assert!(r >= self.y_base && r < self.y_base + self.rows, "row {r} outside the source window");
        let row = &self.bytes[(r - self.y_base) * w * 4..][..w * 4];
        let dst = &mut out[2..w + 2];
        match bytemuck::try_cast_slice::<u8, u32>(row) {
            #[cfg(target_endian = "little")]
            Ok(px) => dst.copy_from_slice(px),
            _ => {
                for (d, s) in dst.iter_mut().zip(row.chunks_exact(4)) {
                    *d = u32::from_le_bytes([s[0], s[1], s[2], s[3]]);
                }
            }
        }
    }
}

/// Row `y` of a 4-slot ring buffer with rows of `width` elements.
#[inline(always)]
fn ring_row<T>(v: &[T], y: isize, width: usize) -> &[T] {
    &v[(y & 3) as usize * width..][..width]
}

#[inline(always)]
fn ring_row_mut<T>(v: &mut [T], y: isize, width: usize) -> &mut [T] {
    &mut v[(y & 3) as usize * width..][..width]
}

/// Plane indices into [`Rings::planes`].
const PD: usize = 0; // (x, y) - (x+1, y+1)
const PA: usize = 1; // (x+1, y) - (x, y+1)
const PH: usize = 2; // (x, y) - (x+1, y)
const PV: usize = 3; // (x, y) - (x, y+1)
const PWD: usize = 4; // wide knight  (x, y) - (x+2, y+1)
const PWA: usize = 5; // wide knight  (x+2, y) - (x, y+1)
const PTD: usize = 6; // tall knight  (x, y) - (x+1, y+2)
const PTA: usize = 7; // tall knight  (x+1, y) - (x, y+2)
const PLANES: usize = 8;

/// A row is "dense" when more than 1 / DENSE_DIV of its pixels blend; then
/// the knight distances come from precomputed planes instead of scalar math.
const DENSE_DIV: usize = 2;

/// O(width) working memory for one band.
struct Rings {
    /// Padded pixel rows, slot `y & 3`, `pw` each (`w + 4` used, the rest is
    /// transparent slack so vector loops need no scalar tail).
    pix: Vec<u32>,
    /// Distance planes, slot `y & 3`, `nw` each (`w + 3` used); index `i`
    /// holds the pair whose (top-)left pixel is at `x = i - 2`.
    planes: [Vec<f32>; PLANES],
    /// Row whose knight planes are in each slot (computed on demand).
    knight_tag: [isize; 4],
    /// Pre-pass results, slot `y & 1`, `bw = w + 1` each (index `k` <-> block
    /// `x = k - 1`).
    blk: Vec<u8>,
    /// Blending pixels of the current row: (padded column, corner info).
    todo: Vec<(u32, u32)>,
    w: usize,
    pw: usize,
    nw: usize,
    bw: usize,
}

/// Scratch memory for a band could not be allocated (very wide images).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ScratchError {
    pub(crate) bytes: usize,
}

/// `vec![value; n]`, but reporting allocation failure instead of aborting.
fn try_vec<T: Clone>(value: T, n: usize) -> Result<Vec<T>, ScratchError> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| ScratchError { bytes: n.saturating_mul(core::mem::size_of::<T>()) })?;
    v.resize(n, value);
    Ok(v)
}

impl Rings {
    /// About 150 bytes per source column; fails cleanly if unavailable.
    fn try_new(w: usize) -> Result<Self, ScratchError> {
        let nw = vec_len(w + 3);
        let pw = nw + 4;
        let bw = w + 1;
        let mut planes: [Vec<f32>; PLANES] = Default::default();
        for p in planes.iter_mut() {
            *p = try_vec(0.0, 4 * nw)?;
        }
        let mut todo = Vec::new();
        todo.try_reserve_exact(w).map_err(|_| ScratchError { bytes: w.saturating_mul(8) })?;
        Ok(Self {
            pix: try_vec(0, 4 * pw)?,
            planes,
            knight_tag: [isize::MIN; 4],
            blk: try_vec(0, 2 * bw)?,
            todo,
            w,
            pw,
            nw,
            bw,
        })
    }

    fn load(&mut self, src: &Source<'_>, y: isize) {
        let pw = self.pw;
        src.load_row(y, ring_row_mut(&mut self.pix, y, pw));
    }

    #[inline(always)]
    fn pix_row(&self, y: isize) -> &[u32] {
        ring_row(&self.pix, y, self.pw)
    }

    #[inline(always)]
    fn plane(&self, k: usize, y: isize) -> &[f32] {
        ring_row(&self.planes[k], y, self.nw)
    }

    /// `D`, `A`, `H`, `V` of row `y` (pixel rows `y`, `y + 1`).
    fn planes_row(&mut self, y: isize) {
        let (pw, nw) = (self.pw, self.nw);
        let r0 = ring_row(&self.pix, y, pw);
        let r1 = ring_row(&self.pix, y + 1, pw);
        let [d, a, h, v, ..] = &mut self.planes;
        planes4(
            r0,
            r1,
            ring_row_mut(d, y, nw),
            ring_row_mut(a, y, nw),
            ring_row_mut(h, y, nw),
            ring_row_mut(v, y, nw),
            self.w + 3,
        );
    }

    /// Knight planes of row `y` (pixel rows `y ..= y + 2`), unless the slot
    /// already holds them.
    fn knights_row(&mut self, y: isize) {
        let slot = (y & 3) as usize;
        if self.knight_tag[slot] == y {
            return;
        }
        self.knight_tag[slot] = y;
        let (pw, nw) = (self.pw, self.nw);
        let r0 = ring_row(&self.pix, y, pw);
        let r1 = ring_row(&self.pix, y + 1, pw);
        let r2 = ring_row(&self.pix, y + 2, pw);
        let [.., wd, wa, td, ta] = &mut self.planes;
        knights4(
            r0,
            r1,
            r2,
            ring_row_mut(wd, y, nw),
            ring_row_mut(wa, y, nw),
            ring_row_mut(td, y, nw),
            ring_row_mut(ta, y, nw),
            self.w + 2,
        );
    }

    /// Corner pre-pass for every 2x2 block whose top-left pixel is in row `y`
    /// (`x = -1 ..= w - 1`). Needs pixel rows `y, y+1` and `D`/`A` rows
    /// `y-1 ..= y+1`.
    fn blocks(&mut self, y: isize, p: &Params) {
        let (pw, nw, bw) = (self.pw, self.nw, self.bw);
        // Trim every row to exactly the span the loop touches so the bounds
        // checks are provably redundant and get eliminated.
        let n = bw + 2;
        let [pd, pa, ..] = &self.planes;
        let rows = BlockRows {
            pf: &ring_row(&self.pix, y, pw)[..n],
            pj: &ring_row(&self.pix, y + 1, pw)[..n],
            am: &ring_row(pa, y - 1, nw)[..n],
            a0: &ring_row(pa, y, nw)[..n],
            ap: &ring_row(pa, y + 1, nw)[..n],
            dm: &ring_row(pd, y - 1, nw)[..n],
            d0: &ring_row(pd, y, nw)[..n],
            dp: &ring_row(pd, y + 1, nw)[..n],
        };
        let slot = (y & 1) as usize * bw;
        let out = &mut self.blk[slot..slot + bw];

        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        let k0 = simd_blocks::run(&rows, out, p);
        #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
        let k0 = 0;
        for k in k0..bw {
            out[k] = block_scalar(&rows, k + 1, p);
        }
    }

    /// Collects the pixels of row `y` with at least one blended corner into
    /// `todo`, skipping 8 pixels at a time where both pre-pass rows are 0.
    fn collect(&mut self, y: isize) {
        let (w, bw) = (self.w, self.bw);
        let bprev = &self.blk[((y - 1) & 1) as usize * bw..][..bw];
        let bcur = &self.blk[(y & 1) as usize * bw..][..bw];
        self.todo.clear();
        let mut x = 0;
        while x < w {
            let k = x + 1;
            if x + 8 <= w {
                let word = |r: &[u8]| u64::from_ne_bytes(r[k - 1..k + 7].try_into().unwrap());
                if (word(bprev) | word(bcur)) == 0 && (bprev[k + 7] | bcur[k + 7]) == 0 {
                    x += 8;
                    continue;
                }
            }
            // Corners of pixel (x, y): TL from block (x-1, y-1).K, TR from
            // (x, y-1).J, BL from (x-1, y).G, BR from (x, y).F.
            let info = (((bprev[k - 1] >> SHIFT_K) & 3) as u32) << C_TL
                | (((bprev[k] >> SHIFT_J) & 3) as u32) << C_TR
                | (((bcur[k - 1] >> SHIFT_G) & 3) as u32) << C_BL
                | (((bcur[k] >> SHIFT_F) & 3) as u32) << C_BR;
            if info != 0 {
                self.todo.push(((x + 2) as u32, info));
            }
            x += 1;
        }
    }
}

/// The eight rows the pre-pass reads, trimmed to `bw + 2` entries.
struct BlockRows<'a> {
    pf: &'a [u32],
    pj: &'a [u32],
    am: &'a [f32],
    a0: &'a [f32],
    ap: &'a [f32],
    dm: &'a [f32],
    d0: &'a [f32],
    dp: &'a [f32],
}

/// Zenju's `preProcessCorners` for the 2x2 block F G / J K whose top-left
/// pixel sits at padded index `i` (block `x = i - 2`).
#[inline(always)]
fn block_scalar(r: &BlockRows<'_>, i: usize, p: &Params) -> u8 {
    let f = r.pf[i];
    let g = r.pf[i + 1];
    let j = r.pj[i];
    let kk = r.pj[i + 1];
    if (f == g && j == kk) || (f == j && g == kk) {
        return 0;
    }
    // Same operands and left-to-right order as the reference:
    //   jg = d(i,f) + d(f,c) + d(n,k) + d(k,h) + bias * d(j,g)
    //   fk = d(e,j) + d(j,o) + d(b,g) + d(g,l) + bias * d(f,k)
    let jg = r.a0[i - 1] + r.am[i] + r.ap[i] + r.a0[i + 1] + p.bias * r.a0[i];
    let fk = r.d0[i - 1] + r.dp[i] + r.dm[i] + r.d0[i + 1] + p.bias * r.d0[i];
    let mut res = 0u8;
    if jg < fk {
        let mode = if p.dominant * jg < fk { 2u8 } else { 1u8 };
        if f != g && f != j {
            res |= mode << SHIFT_F;
        }
        if kk != j && kk != g {
            res |= mode << SHIFT_K;
        }
    } else if fk < jg {
        let mode = if p.dominant * fk < jg { 2u8 } else { 1u8 };
        if j != f && j != kk {
            res |= mode << SHIFT_J;
        }
        if g != f && g != kk {
            res |= mode << SHIFT_G;
        }
    }
    res
}

/// Branch-free pre-pass over four blocks per step. Each lane performs the
/// exact `f32` operations of [`block_scalar`] (computing `jg`/`fk` even for
/// blocks the scalar path skips early, then masking), so results match it
/// bit for bit.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod simd_blocks {
    use core::arch::wasm32::*;

    use super::{BlockRows, Params, SHIFT_F, SHIFT_G, SHIFT_J, SHIFT_K};

    /// Processes blocks `0 .. 4 * floor(out.len() / 4)`; returns the first
    /// block index left for the scalar tail.
    #[inline(always)]
    pub(super) fn run(r: &BlockRows<'_>, out: &mut [u8], p: &Params) -> usize {
        let bw = out.len();
        // Highest element touched for block k is index k + 2 (+3 lanes) and
        // every row holds bw + 2 elements, so k + 4 <= bw stays in bounds.
        assert!(r.pf.len() >= bw + 2 && r.pj.len() >= bw + 2);
        assert!(r.am.len() >= bw + 2 && r.a0.len() >= bw + 2 && r.ap.len() >= bw + 2);
        assert!(r.dm.len() >= bw + 2 && r.d0.len() >= bw + 2 && r.dp.len() >= bw + 2);
        let bias = f32x4_splat(p.bias);
        let dom = f32x4_splat(p.dominant);
        let one = u32x4_splat(1);
        let two = u32x4_splat(2);
        let mut k = 0;
        while k + 4 <= bw {
            let i = k + 1;
            // SAFETY: highest index read is i + 1 + 3 = k + 5 <= bw + 1.
            unsafe {
                let ld = |s: &[u32], o: usize| v128_load(s.as_ptr().add(o) as *const v128);
                let lf = |s: &[f32], o: usize| v128_load(s.as_ptr().add(o) as *const v128);
                let f = ld(r.pf, i);
                let g = ld(r.pf, i + 1);
                let j = ld(r.pj, i);
                let kk = ld(r.pj, i + 1);
                // All four blocks hit the `f == g && j == k` early-out (flat
                // runs, horizontal edges): result is 0 without any float work.
                if !v128_any_true(v128_or(v128_xor(f, g), v128_xor(j, kk))) {
                    v128_store32_lane::<0>(u32x4_splat(0), out.as_mut_ptr().add(k) as *mut u32);
                    k += 4;
                    continue;
                }

                let jg = f32x4_add(
                    f32x4_add(f32x4_add(f32x4_add(lf(r.a0, i - 1), lf(r.am, i)), lf(r.ap, i)), lf(r.a0, i + 1)),
                    f32x4_mul(bias, lf(r.a0, i)),
                );
                let fk = f32x4_add(
                    f32x4_add(f32x4_add(f32x4_add(lf(r.d0, i - 1), lf(r.dp, i)), lf(r.dm, i)), lf(r.d0, i + 1)),
                    f32x4_mul(bias, lf(r.d0, i)),
                );

                let fg = i32x4_eq(f, g);
                let jk = i32x4_eq(j, kk);
                let fj = i32x4_eq(f, j);
                let gk = i32x4_eq(g, kk);
                let keep = v128_not(v128_or(v128_and(fg, jk), v128_and(fj, gk)));

                let lt = f32x4_lt(jg, fk);
                let gt = f32x4_lt(fk, jg);
                let mode_lt = v128_bitselect(two, one, f32x4_lt(f32x4_mul(dom, jg), fk));
                let mode_gt = v128_bitselect(two, one, f32x4_lt(f32x4_mul(dom, fk), jg));

                // F: f != g && f != j        K: k != j && k != g
                // J: j != f && j != k        G: g != f && g != k
                let not = v128_not;
                let m_f = v128_and(lt, v128_and(not(fg), not(fj)));
                let m_k = v128_and(lt, v128_and(not(jk), not(gk)));
                let m_j = v128_and(gt, v128_and(not(fj), not(jk)));
                let m_g = v128_and(gt, v128_and(not(fg), not(gk)));

                let res = v128_or(
                    v128_or(
                        u32x4_shl(v128_and(m_f, mode_lt), SHIFT_F),
                        u32x4_shl(v128_and(m_k, mode_lt), SHIFT_K),
                    ),
                    v128_or(
                        u32x4_shl(v128_and(m_j, mode_gt), SHIFT_J),
                        u32x4_shl(v128_and(m_g, mode_gt), SHIFT_G),
                    ),
                );
                let res = v128_and(res, keep);
                // Lanes are < 256: narrow 32 -> 16 -> 8 bits and store 4 bytes.
                let b16 = u16x8_narrow_i32x4(res, res);
                let b8 = u8x16_narrow_i16x8(b16, b16);
                v128_store32_lane::<0>(b8, out.as_mut_ptr().add(k) as *mut u32);
            }
            k += 4;
        }
        k
    }
}

/// Everything [`blend_pixel`] reads for pixel row `y`: padded pixel rows
/// `y-1 ..= y+1` and the plane rows holding every distance its 3x3 kernel
/// (plus the two knight pairs) can need. `c` is the padded column of the
/// centre pixel (`x + 2`), which is also its plane index.
struct Ctx<'a> {
    pix: [&'a [u32]; 3],
    h: [&'a [f32]; 3],
    v: [&'a [f32]; 2],
    d: [&'a [f32]; 2],
    a: [&'a [f32]; 2],
    wd: [&'a [f32]; 2],
    wa: [&'a [f32]; 2],
    td: &'a [f32],
    ta: &'a [f32],
}

#[inline(always)]
fn at<T: Copy>(row: &[T], c: usize, dx: i32) -> T {
    debug_assert!(((c as i32 + dx) as usize) < row.len());
    // SAFETY: |dx| <= 1 around c = x + 2 with x < w gives an index in
    // [1, w + 2], inside every pixel row (w + 4) and plane row (w + 3); the
    // knight lookups use offsets 0 and -1 only, i.e. indices <= w + 1.
    unsafe { *row.get_unchecked((c as i32 + dx) as usize) }
}

impl Ctx<'_> {
    /// Pixel at offset `(dx, dy)` from the centre.
    #[inline(always)]
    fn px(&self, c: usize, (dx, dy): (i32, i32)) -> u32 {
        at(self.pix[(dy + 1) as usize], c, dx)
    }

    /// Distance between two *adjacent* kernel pixels, read from the plane
    /// that stores it. Offsets are compile-time constants after inlining.
    #[inline(always)]
    fn nd(&self, c: usize, (x1, y1): (i32, i32), (x2, y2): (i32, i32)) -> f32 {
        match (x2 - x1, y2 - y1) {
            (1, 0) => at(self.h[(y1 + 1) as usize], c, x1),
            (-1, 0) => at(self.h[(y2 + 1) as usize], c, x2),
            (0, 1) => at(self.v[(y1 + 1) as usize], c, x1),
            (0, -1) => at(self.v[(y2 + 1) as usize], c, x2),
            (1, 1) => at(self.d[(y1 + 1) as usize], c, x1),
            (-1, -1) => at(self.d[(y2 + 1) as usize], c, x2),
            // A[x, y] = dist((x+1, y), (x, y+1)): top-right / bottom-left pair.
            (-1, 1) => at(self.a[(y1 + 1) as usize], c, x2),
            (1, -1) => at(self.a[(y2 + 1) as usize], c, x1),
            _ => unreachable!(),
        }
    }

    /// `(dist(f, g), dist(h, c))` of the rotated kernel. Both are knight-move
    /// pairs: from the knight planes on dense rows (`PLANES`), else computed.
    ///
    /// Pairs per rotation (pixel offsets from e): R0 f(1,0)-g(-1,1) is a
    /// wide pair of row y, h(0,1)-c(1,-1) a tall pair of row y-1; R1..R3
    /// rotate these (see `rot`), giving the plane/column choices below.
    #[inline(always)]
    fn knights<const R: u8, const PLANES: bool>(&self, c: usize) -> (f32, f32) {
        if PLANES {
            match R {
                0 => (at(self.wa[1], c, -1), at(self.ta, c, 0)),
                1 => (at(self.td, c, 0), at(self.wd[0], c, -1)),
                2 => (at(self.wa[0], c, -1), at(self.ta, c, -1)),
                _ => (at(self.td, c, -1), at(self.wd[1], c, -1)),
            }
        } else {
            let f = self.px(c, rot(R, (1, 0)));
            let g = self.px(c, rot(R, (-1, 1)));
            let h = self.px(c, rot(R, (0, 1)));
            let cc = self.px(c, rot(R, (1, -1)));
            (dist(f, g), dist(h, cc))
        }
    }
}

/// Canonical kernel offset `(dx, dy)` seen under rotation `R`, matching the
/// reference `RotKernel3x3` getters (R=1: f->b, h->f, i->c, ...).
#[inline(always)]
const fn rot(r: u8, (dx, dy): (i32, i32)) -> (i32, i32) {
    match r & 3 {
        0 => (dx, dy),
        1 => (dy, -dx),
        2 => (-dx, -dy),
        _ => (-dy, dx),
    }
}

/// Zenju's `blendPixel` for one rotation of the pixel at padded column `c`.
///
/// All distances are plane lookups (no colour math here), so the decision is
/// evaluated eagerly with non-short-circuit boolean ops: identical result to
/// the reference's short-circuit form, far fewer unpredictable branches.
#[inline(always)]
fn blend_pixel<const R: u8, const PLANES: bool>(
    cx: &Ctx<'_>,
    c: usize,
    info: u32,
    block: &mut [u32],
    tables: &Prepared,
    p: &Params,
) {
    // Corner types after rotating by R: `br` is the corner being blended,
    // `tr` / `bl` its neighbours along the block edges.
    let (br, tr, bl) = match R {
        0 => (info >> C_BR, info >> C_TR, info >> C_BL),
        1 => (info >> C_TR, info >> C_TL, info >> C_BR),
        2 => (info >> C_TL, info >> C_BL, info >> C_TR),
        _ => (info >> C_BL, info >> C_BR, info >> C_TL),
    };
    let (br, tr, bl) = (br & 3, tr & 3, bl & 3);
    if br == BLEND_NONE {
        return;
    }

    let ob = rot(R, (0, -1));
    let oc = rot(R, (1, -1));
    let od = rot(R, (-1, 0));
    let oe = (0, 0);
    let of = rot(R, (1, 0));
    let og = rot(R, (-1, 1));
    let oh = rot(R, (0, 1));
    let oi = rot(R, (1, 1));

    let tol = p.tol;
    // Rules (Zenju): a dominant gradient always line-blends. Otherwise no
    // second blend in an adjacent rotation for this pixel (insular pixels,
    // "mario eyes") - but double blending is allowed for 90deg corners - and
    // no full blend for L-shapes, corner only ("mario mushroom eyes").
    let do_line_blend = if PLANES {
        // Dense rows: every distance is a plane lookup, so evaluate eagerly
        // with non-short-circuit ops - fewer unpredictable branches.
        let insular = (tr != BLEND_NONE) & (cx.nd(c, oe, og) >= tol) | (bl != BLEND_NONE) & (cx.nd(c, oe, oc) >= tol);
        let l_shape = (cx.nd(c, oe, oi) >= tol)
            & (cx.nd(c, og, oh) < tol)
            & (cx.nd(c, oh, oi) < tol)
            & (cx.nd(c, oi, of) < tol)
            & (cx.nd(c, of, oc) < tol);
        (br == BLEND_DOMINANT) | !(insular | l_shape)
    } else {
        // Sparse rows: most decisions settle on the first test; short-circuit.
        (br == BLEND_DOMINANT)
            || !((tr != BLEND_NONE && cx.nd(c, oe, og) >= tol)
                || (bl != BLEND_NONE && cx.nd(c, oe, oc) >= tol)
                || (cx.nd(c, oe, oi) >= tol
                    && cx.nd(c, og, oh) < tol
                    && cx.nd(c, oh, oi) < tol
                    && cx.nd(c, oi, of) < tol
                    && cx.nd(c, of, oc) < tol))
    };

    let f = cx.px(c, of);
    let h = cx.px(c, oh);
    let px = if cx.nd(c, oe, of) <= cx.nd(c, oe, oh) { f } else { h };

    let pattern = if do_line_blend {
        let (fg, hc) = cx.knights::<R, PLANES>(c);
        let e = cx.px(c, (0, 0));
        let g = cx.px(c, og);
        let cc = cx.px(c, oc);
        // Zenju 1.8 tests the line shape with exact pixel inequality.
        let (shallow, steep) = if PLANES {
            (
                (p.steep * fg <= hc) & (e != g) & (cx.px(c, od) != g),
                (p.steep * hc <= fg) & (e != cc) & (cx.px(c, ob) != cc),
            )
        } else {
            (
                p.steep * fg <= hc && e != g && cx.px(c, od) != g,
                p.steep * hc <= fg && e != cc && cx.px(c, ob) != cc,
            )
        };
        [DIAGONAL, STEEP, SHALLOW, STEEP_AND_SHALLOW][(shallow as usize) << 1 | steep as usize]
    } else {
        CORNER
    };
    tables.apply(pattern, R as usize, block, px);
}

/// Writes the first destination row of a band row: `N` copies of each pixel.
fn expand_row<const N: usize>(first: &mut [u32], src: &[u32]) {
    for (cell, &px) in first.chunks_exact_mut(N).zip(src) {
        cell.fill(px);
    }
}

/// Renders source rows `[y0, y1)` at scale `n` into `dst`, which must hold
/// exactly the destination rows `[y0 * n, y1 * n)` (row stride `w * n`).
/// Every cell of `dst` is written, so it may contain stale data.
pub(crate) fn render_band(
    src: &Source<'_>,
    n: usize,
    y0: usize,
    y1: usize,
    p: &Params,
    dst: &mut [u32],
) -> Result<(), ScratchError> {
    let (w, h) = (src.w, src.h);
    assert!((2..=8).contains(&n) && y0 < y1 && y1 <= h && w > 0);
    let out_w = w * n;
    assert_eq!(dst.len(), (y1 - y0) * n * out_w);
    let tables = Prepared::new(n, out_w);
    let expand: fn(&mut [u32], &[u32]) = match n {
        2 => expand_row::<2>,
        3 => expand_row::<3>,
        4 => expand_row::<4>,
        5 => expand_row::<5>,
        6 => expand_row::<6>,
        7 => expand_row::<7>,
        _ => expand_row::<8>,
    };

    let mut rg = Rings::try_new(w)?;
    let (y0, y1) = (y0 as isize, y1 as isize);

    // Prime: pixel rows y0-2 ..= y0+1, planes y0-2 ..= y0, pre-pass row y0-1.
    for y in y0 - 2..=y0 + 1 {
        rg.load(src, y);
    }
    for y in y0 - 2..=y0 {
        rg.planes_row(y);
    }
    rg.blocks(y0 - 1, p);

    for y in y0..y1 {
        // Ring invariants on entry: pixel rows y-2 ..= y+1, planes rows
        // y-2 ..= y, pre-pass row y-1.
        rg.load(src, y + 2);
        rg.planes_row(y + 1);
        rg.blocks(y, p);
        rg.collect(y);
        let dense = rg.todo.len() * DENSE_DIV > w;
        if dense {
            rg.knights_row(y - 1);
            rg.knights_row(y);
        }

        let band_row = (y - y0) as usize;
        let rows = &mut dst[band_row * n * out_w..][..n * out_w];

        // Expand the source row into the first destination row, then copy it
        // down: n*n fills per pixel become n fills + (n-1) memcpys.
        expand(&mut rows[..out_w], &rg.pix_row(y)[2..w + 2]);
        for r in 1..n {
            rows.copy_within(0..out_w, r * out_w);
        }

        if rg.todo.is_empty() {
            continue;
        }
        let cx = Ctx {
            pix: [rg.pix_row(y - 1), rg.pix_row(y), rg.pix_row(y + 1)],
            h: [rg.plane(PH, y - 1), rg.plane(PH, y), rg.plane(PH, y + 1)],
            v: [rg.plane(PV, y - 1), rg.plane(PV, y)],
            d: [rg.plane(PD, y - 1), rg.plane(PD, y)],
            a: [rg.plane(PA, y - 1), rg.plane(PA, y)],
            // Only read when `dense` (they were just ensured above).
            wd: [rg.plane(PWD, y - 1), rg.plane(PWD, y)],
            wa: [rg.plane(PWA, y - 1), rg.plane(PWA, y)],
            td: rg.plane(PTD, y - 1),
            ta: rg.plane(PTA, y - 1),
        };
        if dense {
            blend_row::<true>(&cx, &rg.todo, rows, n, &tables, p);
        } else {
            blend_row::<false>(&cx, &rg.todo, rows, n, &tables, p);
        }
    }
    Ok(())
}

/// Blends every collected pixel of one row (all four rotations, in order).
#[inline(always)]
fn blend_row<const PLANES: bool>(
    cx: &Ctx<'_>,
    todo: &[(u32, u32)],
    rows: &mut [u32],
    n: usize,
    tables: &Prepared,
    p: &Params,
) {
    for &(c, info) in todo {
        let c = c as usize;
        let block = &mut rows[(c - 2) * n..];
        blend_pixel::<0, PLANES>(cx, c, info, block, tables, p);
        blend_pixel::<1, PLANES>(cx, c, info, block, tables, p);
        blend_pixel::<2, PLANES>(cx, c, info, block, tables, p);
        blend_pixel::<3, PLANES>(cx, c, info, block, tables, p);
    }
}
