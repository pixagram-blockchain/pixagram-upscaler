//! Geometric pipeline: similarity graph → reshaped cells → regions → shared
//! boundary curves. A line-by-line port of `PixelData` in depixelize.js; every
//! loop runs in the same order and every float is computed with the same
//! operation sequence, which is what makes the output byte-identical.

use crate::math::corner_patterns;

pub(crate) const ALPHA_CUT: u8 = 16;
const SHADING_DIST: f64 = 100.0;
const FRAGMENT: i32 = 3;
const ABSORB_DIST: f64 = 40.0;
const UP: usize = 0;
const RIGHT: usize = 1;
const DOWN: usize = 2;
const LEFT: usize = 3;
/// Node slot that ends a cell side arriving at a pixel corner,
/// `[corner_type * 4 + direction]` (see the JS for the geometry).
const E_SLOT: [u8; 12] = [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0];

/// How pixels are grouped into regions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    /// Per region: banded shading stays crisp, gradients/dither/noise are smoothed.
    #[default]
    Auto,
    /// A region is a group of similar pixels (as in the paper).
    Cell,
    /// A region is a group of identical pixels.
    Shape,
}

/// A chain of visible edges. Control points live in the shared `cx/cy/cox/coy/cex`
/// arrays at `off .. off + m`.
#[derive(Clone, Copy)]
pub(crate) struct Curve {
    pub closed: bool,
    pub border: bool,
    /// Number of edges.
    pub n: usize,
    /// Offset of the control points in the shared arrays.
    pub off: usize,
    /// Number of control points (`n` when closed, `n + 1` when open).
    pub m: usize,
    /// Offset of the curve's `n` edge ids in `c_edges`.
    pub eoff: usize,
    pub att0: i32,
    pub att0j: usize,
    pub att1: i32,
    pub att1j: usize,
}

pub(crate) struct Loop {
    pub start: usize,
    pub len: usize,
    pub area: f64,
}

struct Comps {
    comp: Vec<i32>,
    count: usize,
    sizes: Vec<i32>,
    first: Vec<i32>,
}

pub(crate) type Res<T> = Result<T, &'static str>;

#[derive(Default)]
pub(crate) struct PixelData {
    pub w: usize,
    pub h: usize,
    pub n: usize,
    pub rgb: Vec<u32>,
    pub alpha: Vec<u8>,
    pub key: Vec<u32>,
    yuv: Vec<i16>,
    pub opaque: bool,
    neigh: Vec<u8>,
    // reshaped cells
    pub node_count: usize,
    pub node_x: Vec<i32>,
    pub node_y: Vec<i32>,
    pub cell_v: Vec<i32>,
    cell_nb: Vec<i32>,
    pub cell_n: Vec<u8>,
    cell_twin: Vec<i8>,
    // regions
    pub region: Vec<i32>,
    pub r_count: usize,
    pub r_start: Vec<i32>,
    pub r_pix: Vec<i32>,
    pub r_multi: Vec<u8>,
    pub r_kind: Vec<u8>,
    // visible edges
    pub edge_of: Vec<i32>,
    pub e_count: usize,
    e_u: Vec<i32>,
    e_v: Vec<i32>,
    e_p: Vec<i32>,
    e_q: Vec<i32>,
    bdeg: Vec<u8>,
    b_start: Vec<i32>,
    b_inc: Vec<i32>,
    // boundary loops
    pub loops: Vec<Loop>,
    pub loop_slots: Vec<i32>,
    pub r_loop_start: Vec<u32>,
    pub r_loops: Vec<u32>,
    pub r_area: Vec<f64>,
    // curves
    join1: Vec<i32>,
    join2: Vec<i32>,
    pub curve_of: Vec<i32>,
    pub idx_of: Vec<i32>,
    pub curves: Vec<Curve>,
    pub c_nodes: Vec<i32>,
    c_edges: Vec<i32>,
    pub cx: Vec<f64>,
    pub cy: Vec<f64>,
    pub cox: Vec<f64>,
    pub coy: Vec<f64>,
    pub cex: Vec<u8>,
    pub attached: Vec<u32>,
    // rendered node positions
    pub qx: Vec<f64>,
    pub qy: Vec<f64>,
}

impl PixelData {
    pub(crate) fn new(w: usize, h: usize, data: &[u8], mode: Mode) -> Res<Self> {
        let mut pd = PixelData { w, h, n: w * h, ..Default::default() };
        pd.read_pixels(data);
        pd.build_similarity_graph();
        pd.remove_diagonals();
        pd.build_cells()?;
        pd.build_regions(mode);
        pd.build_boundaries();
        pd.trace_loops()?;
        pd.build_curves();
        pd.detect_corners();
        Ok(pd)
    }

    // ---- pixels -------------------------------------------------------------------
    fn read_pixels(&mut self, data: &[u8]) {
        let n = self.n;
        let stride = if data.len() >= n * 4 { 4 } else { 3 };
        self.rgb = vec![0; n];
        self.alpha = vec![0; n];
        self.key = vec![0; n];
        self.yuv = vec![0; n * 3];
        let mut opaque = true;
        for i in 0..n {
            let j = i * stride;
            let a = if stride == 4 { data[j + 3] } else { 255 };
            if a < 255 {
                opaque = false;
            }
            if a < ALPHA_CUT {
                continue;
            }
            let (r, g, b) = (data[j] as i32, data[j + 1] as i32, data[j + 2] as i32);
            let c = ((r << 16) | (g << 8) | b) as u32;
            self.rgb[i] = c;
            self.alpha[i] = a;
            self.key[i] = (c << 8) | a as u32;
            let y = (77 * r + 150 * g + 29 * b) >> 8;
            self.yuv[i * 3] = y as i16;
            self.yuv[i * 3 + 1] = ((126 * (b - y)) >> 8) as i16;
            self.yuv[i * 3 + 2] = ((224 * (r - y)) >> 8) as i16;
        }
        self.opaque = opaque;
    }

    #[inline]
    fn similar(&self, i: usize, j: usize) -> bool {
        let (ai, aj) = (self.alpha[i], self.alpha[j]);
        if ai == 0 || aj == 0 {
            return ai == aj;
        }
        let da = ai as i32 - aj as i32;
        if !(-32..=32).contains(&da) {
            return false;
        }
        let (p, q) = (i * 3, j * 3);
        let y = &self.yuv;
        let dy = y[p] as i32 - y[q] as i32;
        if !(-48..=48).contains(&dy) {
            return false;
        }
        let du = y[p + 1] as i32 - y[q + 1] as i32;
        if !(-7..=7).contains(&du) {
            return false;
        }
        let dv = y[p + 2] as i32 - y[q + 2] as i32;
        (-6..=6).contains(&dv)
    }

    pub(crate) fn yuv_dist(&self, i: usize, j: usize) -> f64 {
        let (ai, aj) = (self.alpha[i], self.alpha[j]);
        if ai == 0 || aj == 0 {
            return if ai == aj { 0.0 } else { 1e9 };
        }
        let (p, q) = (i * 3, j * 3);
        let y = &self.yuv;
        let dy = (y[p] - y[q]) as i32;
        let du = (y[p + 1] - y[q + 1]) as i32;
        let dv = (y[p + 2] - y[q + 2]) as i32;
        let da = ai as i32 - aj as i32;
        ((dy * dy + du * du + dv * dv + da * da) as f64).sqrt()
    }

    // ---- similarity graph -----------------------------------------------------------
    // 4 forward bits per pixel: 1 = +x, 2 = +y, 4 = +x+y (SE), 8 = +x−y (NE).
    fn build_similarity_graph(&mut self) {
        let (w, h) = (self.w, self.h);
        let mut neigh = vec![0u8; self.n];
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let mut b = 0u8;
                if x + 1 < w && self.similar(i, i + 1) {
                    b |= 1;
                }
                if y + 1 < h && self.similar(i, i + w) {
                    b |= 2;
                }
                if x + 1 < w && y + 1 < h && self.similar(i, i + w + 1) {
                    b |= 4;
                }
                if x + 1 < w && y > 0 && self.similar(i, i - w + 1) {
                    b |= 8;
                }
                neigh[i] = b;
            }
        }
        self.neigh = neigh;
    }

    #[inline]
    fn px_neighbors(&self, i: usize, out: &mut [usize; 8]) -> usize {
        let (w, h, ng) = (self.w, self.h, &self.neigh);
        let (x, y, b) = (i % w, i / w, ng[i]);
        let mut c = 0;
        if b & 1 != 0 {
            out[c] = i + 1;
            c += 1;
        }
        if b & 2 != 0 {
            out[c] = i + w;
            c += 1;
        }
        if b & 4 != 0 {
            out[c] = i + w + 1;
            c += 1;
        }
        if b & 8 != 0 {
            out[c] = i - w + 1;
            c += 1;
        }
        if x > 0 && ng[i - 1] & 1 != 0 {
            out[c] = i - 1;
            c += 1;
        }
        if y > 0 && ng[i - w] & 2 != 0 {
            out[c] = i - w;
            c += 1;
        }
        if x > 0 && y > 0 && ng[i - w - 1] & 4 != 0 {
            out[c] = i - w - 1;
            c += 1;
        }
        if x > 0 && y + 1 < h && ng[i + w - 1] & 8 != 0 {
            out[c] = i + w - 1;
            c += 1;
        }
        c
    }

    #[inline]
    fn px_degree(&self, i: usize) -> u32 {
        let (w, h, ng) = (self.w, self.h, &self.neigh);
        let (x, y, b) = (i % w, i / w, ng[i]);
        let mut d = (b & 1) as u32 + ((b >> 1) & 1) as u32 + ((b >> 2) & 1) as u32 + ((b >> 3) & 1) as u32;
        if x > 0 && ng[i - 1] & 1 != 0 {
            d += 1;
        }
        if y > 0 && ng[i - w] & 2 != 0 {
            d += 1;
        }
        if x > 0 && y > 0 && ng[i - w - 1] & 4 != 0 {
            d += 1;
        }
        if x > 0 && y + 1 < h && ng[i + w - 1] & 8 != 0 {
            d += 1;
        }
        d
    }

    fn rm_px_edge(&mut self, a: usize, b: usize) {
        let w = self.w as isize;
        let dx = (b as isize % w) - (a as isize % w);
        let dy = (b as isize / w) - (a as isize / w);
        let ng = &mut self.neigh;
        match (dx, dy) {
            (1, 0) => ng[a] &= !1,
            (0, 1) => ng[a] &= !2,
            (1, 1) => ng[a] &= !4,
            (1, -1) => ng[a] &= !8,
            (-1, 0) => ng[b] &= !1,
            (0, -1) => ng[b] &= !2,
            (-1, -1) => ng[b] &= !4,
            (-1, 1) => ng[b] &= !8,
            _ => {}
        }
    }

    // ---- crossing diagonals (paper §3.2) ------------------------------------------------
    fn remove_diagonals(&mut self) {
        let (w, h) = (self.w, self.h);
        let mut amb: Vec<usize> = Vec::new();
        for y in 0..h.saturating_sub(1) {
            for x in 0..w.saturating_sub(1) {
                let tl = y * w + x;
                let (tr, bl) = (tl + 1, tl + w);
                let br = bl + 1;
                let ng = &self.neigh;
                if ng[tl] & 4 == 0 || ng[bl] & 8 == 0 {
                    continue;
                }
                let card = (ng[tl] & 1 != 0) as u32
                    + (ng[bl] & 1 != 0) as u32
                    + (ng[tl] & 2 != 0) as u32
                    + (ng[tr] & 2 != 0) as u32;
                if card == 4 {
                    self.neigh[tl] &= !4;
                    self.neigh[bl] &= !8;
                } else if card == 0 {
                    amb.extend_from_slice(&[tl, br, bl, tr]);
                } else {
                    let d1 = self.yuv_dist(tl, br);
                    let d2 = self.yuv_dist(bl, tr);
                    if d1 >= d2 {
                        self.neigh[tl] &= !4;
                    }
                    if d2 >= d1 {
                        self.neigh[bl] &= !8;
                    }
                }
            }
        }
        if !amb.is_empty() {
            self.apply_heuristics(&amb);
        }
    }

    fn apply_heuristics(&mut self, flat: &[usize]) {
        let mut hs = Heur { mark: vec![0; self.n], stamp: 0, stk: vec![0; self.n + 8] };
        for q in flat.chunks_exact(4) {
            let (a1, b1, a2, b2) = (q[0], q[1], q[2], q[3]);
            let w1 = self.h_curve(&mut hs, a1, b1) + self.h_sparse(&mut hs, a1, b1) + self.h_island(a1, b1);
            let w2 = self.h_curve(&mut hs, a2, b2) + self.h_sparse(&mut hs, a2, b2) + self.h_island(a2, b2);
            if w1 <= w2 {
                self.rm_px_edge(a1, b1);
            }
            if w2 <= w1 {
                self.rm_px_edge(a2, b2);
            }
        }
    }

    fn h_curve(&self, hs: &mut Heur, a: usize, b: usize) -> i64 {
        hs.stamp += 1;
        let s = hs.stamp;
        hs.mark[a] = s;
        hs.mark[b] = s;
        let mut nbs = [0usize; 8];
        let (mut sp, mut count) = (2usize, 2i64);
        hs.stk[0] = a;
        hs.stk[1] = b;
        while sp > 0 {
            sp -= 1;
            let n = hs.stk[sp];
            if self.px_degree(n) != 2 {
                continue;
            }
            let nc = self.px_neighbors(n, &mut nbs);
            for &m in &nbs[..nc] {
                if hs.mark[m] != s {
                    hs.mark[m] = s;
                    count += 1;
                    hs.stk[sp] = m;
                    sp += 1;
                }
            }
        }
        count
    }

    fn h_sparse(&self, hs: &mut Heur, a: usize, b: usize) -> i64 {
        let w = self.w as i64;
        hs.stamp += 1;
        let s = hs.stamp;
        let x0 = (a as i64 % w).min(b as i64 % w) - 3;
        let y0 = (a as i64 / w).min(b as i64 / w) - 3;
        hs.mark[a] = s;
        hs.mark[b] = s;
        let mut nbs = [0usize; 8];
        let (mut sp, mut count) = (2usize, 2i64);
        hs.stk[0] = a;
        hs.stk[1] = b;
        while sp > 0 {
            sp -= 1;
            let n = hs.stk[sp];
            let nc = self.px_neighbors(n, &mut nbs);
            for &m in &nbs[..nc] {
                if hs.mark[m] == s {
                    continue;
                }
                let mx = m as i64 % w - x0;
                let my = m as i64 / w - y0;
                if (0..8).contains(&mx) && (0..8).contains(&my) {
                    hs.mark[m] = s;
                    count += 1;
                    hs.stk[sp] = m;
                    sp += 1;
                }
            }
        }
        -count
    }

    fn h_island(&self, a: usize, b: usize) -> i64 {
        if self.px_degree(a) == 1 || self.px_degree(b) == 1 { 5 } else { 0 }
    }

    // ---- reshaped cells (simplified generalised Voronoi diagram) --------------------------
    fn build_cells(&mut self) -> Res<()> {
        let (w, h, n) = (self.w, self.h, self.n);
        let (cw, ch) = (w + 1, h + 1);
        let mut ctype = vec![0u8; cw * ch];
        for cy in 1..h {
            for cx in 1..w {
                let tl = (cy - 1) * w + cx - 1;
                if self.neigh[tl] & 4 != 0 {
                    ctype[cy * cw + cx] = 1;
                } else if self.neigh[tl + w] & 8 != 0 {
                    ctype[cy * cw + cx] = 2;
                }
            }
        }
        let nn = cw * ch * 2;
        let (mut nx, mut ny) = (vec![0i32; nn], vec![0i32; nn]);
        let mut c = 0;
        for cy in 0..ch {
            for cx in 0..cw {
                let (x4, y4, k) = (cx as i32 * 4, cy as i32 * 4, c * 2);
                match ctype[c] {
                    0 => {
                        nx[k] = x4;
                        ny[k] = y4;
                        nx[k + 1] = x4;
                        ny[k + 1] = y4;
                    }
                    1 => {
                        nx[k] = x4 + 1;
                        ny[k] = y4 - 1;
                        nx[k + 1] = x4 - 1;
                        ny[k + 1] = y4 + 1;
                    }
                    _ => {
                        nx[k] = x4 - 1;
                        ny[k] = y4 - 1;
                        nx[k + 1] = x4 + 1;
                        ny[k + 1] = y4 + 1;
                    }
                }
                c += 1;
            }
        }
        let mut vv = vec![0i32; n * 8];
        let mut nb = vec![0i32; n * 8];
        let mut cn = vec![0u8; n];
        let slot = |corner: usize, t: u8, dir: usize| (2 * corner + E_SLOT[t as usize * 4 + dir] as usize) as i32;
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let base = i * 8;
                let c00 = y * cw + x;
                let (c10, c01) = (c00 + 1, c00 + cw);
                let c11 = c01 + 1;
                let (t00, t10, t01, t11) = (ctype[c00], ctype[c10], ctype[c01], ctype[c11]);
                let (a0, a1) = (slot(c00, t00, DOWN), slot(c00, t00, RIGHT));
                let (b0, b1) = (slot(c10, t10, LEFT), slot(c10, t10, DOWN));
                let (d0, d1) = (slot(c11, t11, UP), slot(c11, t11, LEFT));
                let (e0, e1) = (slot(c01, t01, RIGHT), slot(c01, t01, UP));
                let ii = i as i32;
                let wi = w as i32;
                let mut k = 0usize;
                vv[base] = a0;
                if a1 != a0 {
                    nb[base + k] = ii - wi - 1;
                    k += 1;
                    vv[base + k] = a1;
                }
                nb[base + k] = if y > 0 { ii - wi } else { -1 };
                k += 1;
                vv[base + k] = b0;
                if b1 != b0 {
                    nb[base + k] = ii - wi + 1;
                    k += 1;
                    vv[base + k] = b1;
                }
                nb[base + k] = if x < w - 1 { ii + 1 } else { -1 };
                k += 1;
                vv[base + k] = d0;
                if d1 != d0 {
                    nb[base + k] = ii + wi + 1;
                    k += 1;
                    vv[base + k] = d1;
                }
                nb[base + k] = if y < h - 1 { ii + wi } else { -1 };
                k += 1;
                vv[base + k] = e0;
                if e1 != e0 {
                    nb[base + k] = ii + wi - 1;
                    k += 1;
                    vv[base + k] = e1;
                }
                nb[base + k] = if x > 0 { ii - 1 } else { -1 };
                k += 1;
                cn[i] = k as u8;
            }
        }
        let mut tw = vec![-1i8; n * 8];
        for i in 0..n {
            let (base, cnt) = (i * 8, cn[i] as usize);
            for k in 0..cnt {
                let o = nb[base + k];
                if o < 0 {
                    continue;
                }
                let o = o as usize;
                let u = vv[base + k];
                let v = vv[base + if k + 1 == cnt { 0 } else { k + 1 }];
                let (obase, ocnt) = (o * 8, cn[o] as usize);
                for t in 0..ocnt {
                    if vv[obase + t] == v && vv[obase + if t + 1 == ocnt { 0 } else { t + 1 }] == u {
                        tw[base + k] = t as i8;
                        break;
                    }
                }
                if tw[base + k] < 0 {
                    return Err("inconsistent cell graph");
                }
            }
        }
        self.node_count = nn;
        self.node_x = nx;
        self.node_y = ny;
        self.cell_v = vv;
        self.cell_nb = nb;
        self.cell_n = cn;
        self.cell_twin = tw;
        Ok(())
    }

    // ---- regions ------------------------------------------------------------------------
    fn components(&self, exact: bool) -> Comps {
        let n = self.n;
        let mut comp = vec![-1i32; n];
        let mut stack = vec![0usize; n];
        let mut nbs = [0usize; 8];
        let (mut sizes, mut first) = (Vec::new(), Vec::new());
        let mut id = 0i32;
        for i in 0..n {
            if comp[i] >= 0 {
                continue;
            }
            let ki = self.key[i];
            let (mut sp, mut size) = (1usize, 0i32);
            stack[0] = i;
            comp[i] = id;
            while sp > 0 {
                sp -= 1;
                let p = stack[sp];
                size += 1;
                let nc = self.px_neighbors(p, &mut nbs);
                for &m in &nbs[..nc] {
                    if comp[m] < 0 && (!exact || self.key[m] == ki) {
                        comp[m] = id;
                        stack[sp] = m;
                        sp += 1;
                    }
                }
            }
            sizes.push(size);
            first.push(i as i32);
            id += 1;
        }
        Comps { comp, count: id as usize, sizes, first }
    }

    /// Noise suppression (auto/cell): tiny similar-colour groups whose colour is
    /// only slightly off from an edge-adjacent group are merged into it.
    fn absorb_fragments(&self, sim: Comps) -> Comps {
        let (n, cnt) = (self.n, sim.count);
        let comp = &sim.comp;
        let mut parent: Vec<usize> = (0..cnt).collect();
        fn find(parent: &mut [usize], mut c: usize) -> usize {
            while parent[c] != c {
                parent[c] = parent[parent[c]];
                c = parent[c];
            }
            c
        }
        let mut size = sim.sizes.clone();
        for _pass in 0..4 {
            let mut best_d = vec![f64::INFINITY; cnt];
            let mut best_c = vec![-1i32; cnt];
            let mut any = false;
            for i in 0..n {
                let c = find(&mut parent, comp[i] as usize);
                if size[c] > FRAGMENT {
                    continue;
                }
                let base = i * 8;
                for k in 0..self.cell_n[i] as usize {
                    let o = self.cell_nb[base + k];
                    if o < 0 {
                        continue;
                    }
                    let oc = find(&mut parent, comp[o as usize] as usize);
                    if oc == c {
                        continue;
                    }
                    let d = self.yuv_dist(i, o as usize);
                    if d < best_d[c] || (d == best_d[c] && size[oc] > size[best_c[c] as usize]) {
                        best_d[c] = d;
                        best_c[c] = oc as i32;
                    }
                }
            }
            for c in 0..cnt {
                if parent[c] != c || size[c] > FRAGMENT || best_c[c] < 0 || best_d[c] > ABSORB_DIST {
                    continue;
                }
                let o = find(&mut parent, best_c[c] as usize);
                if o == c {
                    continue;
                }
                parent[c] = o;
                size[o] += size[c];
                any = true;
            }
            if !any {
                break;
            }
        }
        let mut map = vec![-1i32; cnt];
        let mut out = vec![0i32; n];
        let (mut sizes, mut first) = (Vec::new(), Vec::new());
        let mut m = 0i32;
        for i in 0..n {
            let r = find(&mut parent, comp[i] as usize);
            if map[r] < 0 {
                map[r] = m;
                m += 1;
                sizes.push(0);
                first.push(i as i32);
            }
            out[i] = map[r];
            sizes[map[r] as usize] += 1;
        }
        Comps { comp: out, count: m as usize, sizes, first }
    }

    fn build_regions(&mut self, mode: Mode) {
        let n = self.n;
        let sim = if mode == Mode::Shape { None } else { Some(self.absorb_fragments(self.components(false))) };
        let (region, count): (Vec<i32>, usize) = match mode {
            Mode::Cell => {
                let s = sim.unwrap();
                (s.comp, s.count)
            }
            Mode::Shape => {
                let ex = self.components(true);
                (ex.comp, ex.count)
            }
            Mode::Auto => {
                let sim = sim.unwrap();
                let ex = self.components(true);
                let sc = sim.count;
                let (mut k, mut parts, mut small) = (vec![0i32; sc], vec![0i32; sc], vec![0i32; sc]);
                for i in 0..n {
                    k[sim.comp[i] as usize] += 1;
                }
                for e in 0..ex.count {
                    let s = sim.comp[ex.first[e] as usize] as usize;
                    parts[s] += 1;
                    if ex.sizes[e] < 3 {
                        small[s] += ex.sizes[e];
                    }
                }
                let region = (0..n)
                    .map(|i| {
                        let s = sim.comp[i] as usize;
                        let crisp = parts[s] == 1 || (k[s] >= 4 * parts[s] && small[s] * 4 <= k[s]);
                        if crisp { ex.comp[i] } else { ex.count as i32 + s as i32 }
                    })
                    .collect::<Vec<i32>>();
                (region, ex.count + sc)
            }
        };
        let mut map = vec![-1i32; count];
        let mut r_count = 0i32;
        for &r in &region {
            if map[r as usize] < 0 {
                map[r as usize] = r_count;
                r_count += 1;
            }
        }
        let rc = r_count as usize;
        let reg: Vec<i32> = region.iter().map(|&r| map[r as usize]).collect();
        let mut start = vec![0i32; rc + 1];
        for &r in &reg {
            start[r as usize + 1] += 1;
        }
        for r in 0..rc {
            start[r + 1] += start[r];
        }
        let mut pix = vec![0i32; n];
        let mut fill: Vec<i32> = start[..rc].to_vec();
        for (i, &r) in reg.iter().enumerate() {
            pix[fill[r as usize] as usize] = i as i32;
            fill[r as usize] += 1;
        }
        let (mut multi, mut kind) = (vec![0u8; rc], vec![0u8; rc]);
        for r in 0..rc {
            let k0 = self.key[pix[start[r] as usize] as usize];
            let (mut m, mut min_a) = (0u8, 255u8);
            for p in start[r]..start[r + 1] {
                let i = pix[p as usize] as usize;
                if self.key[i] != k0 {
                    m = 1;
                }
                min_a = min_a.min(self.alpha[i]);
            }
            multi[r] = m;
            kind[r] = if min_a == 0 {
                2
            } else if min_a < 255 {
                1
            } else {
                0
            };
        }
        self.region = reg;
        self.r_count = rc;
        self.r_start = start;
        self.r_pix = pix;
        self.r_multi = multi;
        self.r_kind = kind;
    }

    // ---- visible edges ----------------------------------------------------------------------
    fn build_boundaries(&mut self) {
        let n = self.n;
        let mut edge_of = vec![-1i32; n * 8];
        let (mut eu, mut ev, mut ep, mut eq) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for i in 0..n {
            let (base, cnt, ri) = (i * 8, self.cell_n[i] as usize, self.region[i]);
            for k in 0..cnt {
                let s = base + k;
                if edge_of[s] >= 0 {
                    continue;
                }
                let o = self.cell_nb[s];
                if o >= 0 && self.region[o as usize] == ri {
                    continue;
                }
                let e = eu.len() as i32;
                eu.push(self.cell_v[s]);
                ev.push(self.cell_v[base + if k + 1 == cnt { 0 } else { k + 1 }]);
                ep.push(i as i32);
                eq.push(o);
                edge_of[s] = e;
                if o >= 0 {
                    edge_of[o as usize * 8 + self.cell_twin[s] as usize] = e;
                }
            }
        }
        let ec = eu.len();
        let nn = self.node_count;
        let mut deg = vec![0u8; nn];
        for e in 0..ec {
            deg[eu[e] as usize] += 1;
            deg[ev[e] as usize] += 1;
        }
        let mut st = vec![0i32; nn + 1];
        for v in 0..nn {
            st[v + 1] = st[v] + deg[v] as i32;
        }
        let mut inc = vec![0i32; 2 * ec];
        let mut fp: Vec<i32> = st[..nn].to_vec();
        for e in 0..ec {
            let (u, v) = (eu[e] as usize, ev[e] as usize);
            inc[fp[u] as usize] = e as i32;
            fp[u] += 1;
            inc[fp[v] as usize] = e as i32;
            fp[v] += 1;
        }
        self.edge_of = edge_of;
        self.e_count = ec;
        self.e_u = eu;
        self.e_v = ev;
        self.e_p = ep;
        self.e_q = eq;
        self.bdeg = deg;
        self.b_start = st;
        self.b_inc = inc;
    }

    /// Next visible half-edge after `s` (slot = pixel * 8 + k) along its region's boundary.
    #[inline]
    fn next_boundary(&self, s: usize) -> Res<usize> {
        let (mut p, mut q) = (s >> 3, (s & 7) + 1);
        if q == self.cell_n[p] as usize {
            q = 0;
        }
        for _ in 0..32 {
            let t = (p << 3) + q;
            if self.edge_of[t] >= 0 {
                return Ok(t);
            }
            let tw = self.cell_twin[t] as usize;
            p = self.cell_nb[t] as usize;
            q = tw + 1;
            if q == self.cell_n[p] as usize {
                q = 0;
            }
        }
        Err("boundary rotation failed")
    }

    fn trace_loops(&mut self) -> Res<()> {
        let n = self.n;
        let mut seen = vec![false; n * 8];
        let limit = 2 * self.e_count + 8;
        let mut owner: Vec<u32> = Vec::new();
        for i in 0..n {
            for k in 0..self.cell_n[i] as usize {
                let s0 = i * 8 + k;
                if self.edge_of[s0] < 0 || seen[s0] {
                    continue;
                }
                let start = self.loop_slots.len();
                let (mut area, mut s, mut guard) = (0i64, s0, 0usize);
                loop {
                    seen[s] = true;
                    self.loop_slots.push(s as i32);
                    let (p, q) = (s >> 3, s & 7);
                    let v0 = self.cell_v[s] as usize;
                    let v1 = self.cell_v[(p << 3) + if q + 1 == self.cell_n[p] as usize { 0 } else { q + 1 }] as usize;
                    area += self.node_x[v0] as i64 * self.node_y[v1] as i64 - self.node_x[v1] as i64 * self.node_y[v0] as i64;
                    s = self.next_boundary(s)?;
                    guard += 1;
                    if guard > limit {
                        return Err("boundary trace failed");
                    }
                    if s == s0 {
                        break;
                    }
                }
                owner.push(self.region[i] as u32);
                self.loops.push(Loop { start, len: self.loop_slots.len() - start, area: area as f64 / 32.0 });
            }
        }
        let rc = self.r_count;
        let mut rs = vec![0u32; rc + 1];
        for &r in &owner {
            rs[r as usize + 1] += 1;
        }
        for r in 0..rc {
            rs[r + 1] += rs[r];
        }
        let mut rl = vec![0u32; owner.len()];
        let mut fill: Vec<u32> = rs[..rc].to_vec();
        for (l, &r) in owner.iter().enumerate() {
            rl[fill[r as usize] as usize] = l as u32;
            fill[r as usize] += 1;
        }
        let mut r_area = vec![0f64; rc];
        for (l, &r) in owner.iter().enumerate() {
            if self.loops[l].area > 0.0 {
                r_area[r as usize] += self.loops[l].area;
            }
        }
        self.r_loop_start = rs;
        self.r_loops = rl;
        self.r_area = r_area;
        Ok(())
    }

    // ---- curves (paper §3.3) -----------------------------------------------------------------
    fn is_shading(&self, e: usize) -> u32 {
        let q = self.e_q[e];
        (q >= 0 && self.yuv_dist(self.e_p[e] as usize, q as usize) <= SHADING_DIST) as u32
    }

    fn dir_from(&self, v: usize, e: usize) -> (f64, f64) {
        let other = |e: usize, v: usize| if self.e_u[e] as usize == v { self.e_v[e] as usize } else { self.e_u[e] as usize };
        let u = other(e, v);
        let (mut tx, mut ty) = (self.node_x[u], self.node_y[u]);
        if self.bdeg[u] == 2 {
            let s = self.b_start[u] as usize;
            let a = self.b_inc[s] as usize;
            let e2 = if a == e { self.b_inc[s + 1] as usize } else { a };
            let u2 = other(e2, u);
            tx = self.node_x[u2];
            ty = self.node_y[u2];
        }
        ((tx - self.node_x[v]) as f64, (ty - self.node_y[v]) as f64)
    }

    fn build_curves(&mut self) {
        let (ec, nn) = (self.e_count, self.node_count);
        let mut j1 = vec![-1i32; nn];
        let mut j2 = vec![-1i32; nn];
        let cos2 = |a: (f64, f64), b: (f64, f64)| {
            let p = (a.0 * a.0 + a.1 * a.1) * (b.0 * b.0 + b.1 * b.1);
            (a.0 * b.0 + a.1 * b.1) / (if p != 0.0 { p } else { 1.0 }).sqrt()
        };
        for v in 0..nn {
            if self.bdeg[v] != 3 {
                continue;
            }
            let s = self.b_start[v] as usize;
            let (ea, eb, ecc) = (self.b_inc[s] as usize, self.b_inc[s + 1] as usize, self.b_inc[s + 2] as usize);
            let (ba, bb, bc) = (self.e_q[ea] < 0, self.e_q[eb] < 0, self.e_q[ecc] < 0);
            let (p, q) = if ba || bb || bc {
                if ba && bb {
                    (ea, eb)
                } else if ba && bc {
                    (ea, ecc)
                } else {
                    (eb, ecc)
                }
            } else {
                let (sa, sb, sc) = (self.is_shading(ea), self.is_shading(eb), self.is_shading(ecc));
                if sa + sb + sc == 1 {
                    if sa == 1 {
                        (eb, ecc)
                    } else if sb == 1 {
                        (ea, ecc)
                    } else {
                        (ea, eb)
                    }
                } else {
                    let (da, db, dc) = (self.dir_from(v, ea), self.dir_from(v, eb), self.dir_from(v, ecc));
                    let (cab, cac, cbc) = (cos2(da, db), cos2(da, dc), cos2(db, dc));
                    if cab <= cac && cab <= cbc {
                        (ea, eb)
                    } else if cac <= cbc {
                        (ea, ecc)
                    } else {
                        (eb, ecc)
                    }
                }
            };
            j1[v] = p as i32;
            j2[v] = q as i32;
        }

        let mut curve_of = vec![-1i32; ec];
        let mut idx_of = vec![0i32; ec];
        let mut curves: Vec<Curve> = Vec::new();
        let (mut c_nodes, mut c_edges, mut cx, mut cy) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let deg = &self.bdeg;
        let (st, inc, eu, ev, eq) = (&self.b_start, &self.b_inc, &self.e_u, &self.e_v, &self.e_q);
        let terminal = |v: usize, e: i32| deg[v] != 2 && j1[v] != e && j2[v] != e;
        let next_edge = |v: usize, e: i32| -> i32 {
            if deg[v] == 2 {
                let a = inc[st[v] as usize];
                return if a == e { inc[st[v] as usize + 1] } else { a };
            }
            if j1[v] == e {
                j2[v]
            } else if j2[v] == e {
                j1[v]
            } else {
                -1
            }
        };
        let mut nodes: Vec<i32> = Vec::new();
        let mut edges: Vec<i32> = Vec::new();
        let mut make = |v0: usize, e0: i32, mut closed: bool, curve_of: &mut Vec<i32>, idx_of: &mut Vec<i32>| {
            nodes.clear();
            edges.clear();
            let id = curves.len() as i32;
            let (mut v, mut e) = (v0, e0);
            nodes.push(v0 as i32);
            loop {
                let eu_ = eu[e as usize] as usize;
                let u = if eu_ == v { ev[e as usize] as usize } else { eu_ };
                curve_of[e as usize] = id;
                idx_of[e as usize] = edges.len() as i32;
                edges.push(e);
                if closed {
                    let ne = next_edge(u, e);
                    if ne == e0 {
                        break;
                    }
                    nodes.push(u as i32);
                    if ne < 0 || curve_of[ne as usize] >= 0 {
                        closed = false;
                        break;
                    }
                    v = u;
                    e = ne;
                } else {
                    nodes.push(u as i32);
                    if terminal(u, e) {
                        break;
                    }
                    let ne = next_edge(u, e);
                    if ne < 0 || curve_of[ne as usize] >= 0 {
                        break;
                    }
                    v = u;
                    e = ne;
                }
            }
            let off = c_nodes.len();
            let eoff = c_edges.len();
            c_edges.extend_from_slice(&edges);
            for &nd in &nodes {
                c_nodes.push(nd);
                cx.push(self.node_x[nd as usize] as f64 * 0.25);
                cy.push(self.node_y[nd as usize] as f64 * 0.25);
            }
            curves.push(Curve {
                closed,
                border: eq[edges[0] as usize] < 0,
                n: edges.len(),
                off,
                m: nodes.len(),
                eoff,
                att0: -1,
                att0j: 0,
                att1: -1,
                att1j: 0,
            });
        };
        for v in 0..nn {
            let d = deg[v];
            if d == 0 || d == 2 {
                continue;
            }
            for &e in &inc[st[v] as usize..st[v + 1] as usize] {
                if curve_of[e as usize] < 0 && terminal(v, e) {
                    make(v, e, false, &mut curve_of, &mut idx_of);
                }
            }
        }
        for e in 0..ec {
            if curve_of[e] < 0 {
                make(eu[e] as usize, e as i32, true, &mut curve_of, &mut idx_of);
            }
        }

        // Curves ending on a T-junction follow the curve passing through it.
        let mut attached = Vec::new();
        for ci in 0..curves.len() {
            let c = curves[ci];
            if c.closed || c.border {
                continue;
            }
            let mut cc = c;
            for end in 0..2 {
                let v = c_nodes[c.off + if end == 1 { c.n } else { 0 }] as usize;
                if deg[v] != 3 || j1[v] < 0 {
                    continue;
                }
                let e = c_edges[c.eoff + if end == 1 { c.n - 1 } else { 0 }];
                if e == j1[v] || e == j2[v] {
                    continue;
                }
                let hid = curve_of[j1[v] as usize] as usize;
                let h = curves[hid];
                if h.border {
                    continue;
                }
                let je = idx_of[j1[v] as usize] as usize;
                let mut jn = if c_nodes[h.off + je] as usize == v { je } else { je + 1 };
                if h.closed && jn == h.n {
                    jn = 0;
                }
                if end == 1 {
                    cc.att1 = hid as i32;
                    cc.att1j = jn;
                } else {
                    cc.att0 = hid as i32;
                    cc.att0j = jn;
                }
            }
            if cc.att0 >= 0 || cc.att1 >= 0 {
                curves[ci] = cc;
                attached.push(ci as u32);
            }
        }
        let total = c_nodes.len();
        self.cox = cx.clone();
        self.coy = cy.clone();
        self.cx = cx;
        self.cy = cy;
        self.c_nodes = c_nodes;
        self.c_edges = c_edges;
        self.cex = vec![0u8; total];
        self.curves = curves;
        self.curve_of = curve_of;
        self.idx_of = idx_of;
        self.attached = attached;
        self.join1 = j1;
        self.join2 = j2;
    }

    fn detect_corners(&mut self) {
        // Patterns are bucketed by (start node mod 4, first step), so each start
        // node only tries the few patterns that can match it. Marks are
        // idempotent, so the visiting order does not matter.
        let pats = corner_patterns();
        const NB: usize = 16 * 81;
        let key = |x: i32, y: i32, dx: i32, dy: i32| -> Option<usize> {
            if !(-4..=4).contains(&dx) || !(-4..=4).contains(&dy) {
                return None;
            }
            Some((((x & 3) * 4 + (y & 3)) * 81 + (dx + 4) * 9 + (dy + 4)) as usize)
        };
        let mut start = vec![0u32; NB + 1];
        let pkeys: Vec<Option<usize>> = pats.iter().map(|p| key(p[0], p[1], p[2] - p[0], p[3] - p[1])).collect();
        for k in pkeys.iter().flatten() {
            start[k + 1] += 1;
        }
        for b in 0..NB {
            start[b + 1] += start[b];
        }
        let mut fill = start.clone();
        let mut items = vec![0u32; start[NB] as usize];
        for (pi, k) in pkeys.iter().enumerate() {
            if let Some(k) = *k {
                items[fill[k] as usize] = pi as u32;
                fill[k] += 1;
            }
        }
        for c in &self.curves {
            if c.border {
                continue;
            }
            let (off, m) = (c.off, c.m);
            let nodes = &self.c_nodes[off..off + m];
            let ex = &mut self.cex[off..off + m];
            let s_end = if c.closed { m } else { m.saturating_sub(1) };
            for s in 0..s_end {
                let n0 = nodes[s] as usize;
                let n1 = nodes[if s + 1 == m { 0 } else { s + 1 }] as usize;
                let (x0, y0) = (self.node_x[n0], self.node_y[n0]);
                let Some(b) = key(x0, y0, self.node_x[n1] - x0, self.node_y[n1] - y0) else { continue };
                for &pi in &items[start[b] as usize..start[b + 1] as usize] {
                    let pat = &pats[pi as usize];
                    let l = pat.len() / 2;
                    if l > m || (!c.closed && s + l > m) {
                        continue;
                    }
                    // points 0 and 1 match by construction of the bucket key
                    let (ox, oy) = (x0 - pat[0], y0 - pat[1]);
                    let mut k = 2;
                    while k < l {
                        let mut idx = s + k;
                        if idx >= m {
                            idx -= m;
                        }
                        let nk = nodes[idx] as usize;
                        if self.node_x[nk] - pat[2 * k] != ox || self.node_y[nk] - pat[2 * k + 1] != oy {
                            break;
                        }
                        k += 1;
                    }
                    if k == l {
                        for t in 1..l - 1 {
                            let mut idx = s + t;
                            if idx >= m {
                                idx -= m;
                            }
                            ex[idx] = 1;
                        }
                    }
                }
            }
        }
    }
}

struct Heur {
    mark: Vec<u32>,
    stamp: u32,
    stk: Vec<usize>,
}
