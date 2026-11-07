//! SVG writer — the Rust twin of `renderSvg` in depixelize.js (same bytes).
//!
//! Geometry is written in pixel units: `viewBox` = image size, `width` /
//! `height` = size × scale. Points are rounded to a decimal grid of 10^−p px;
//! paths use one absolute `M` per subpath, then relative `h v l q` between
//! rounded points (exact deltas, no drift) in minified syntax. Curve segments
//! use one canonical rounded quad each (see [`canon_quad`]), so every region
//! sharing a curve draws identical geometry at any precision.

use crate::math::js_round;
use crate::optimize::{node_pt, seg_a, seg_c};
use crate::pipeline::{Curve, Loop, PixelData};
use std::fmt::Write as _;

// ---- number formatting ----------------------------------------------------------------------

const POW10: [i64; 9] = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000];

#[inline]
fn push_uint(out: &mut Vec<u8>, mut v: u64) {
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    out.extend_from_slice(&buf[i..]);
}

/// The integer `k` as the decimal k·10^−p, trailing zeros dropped; `bare`
/// omits the leading zero (".5"). Same as `ByteWriter.fixed` in JS.
fn push_fixed(out: &mut Vec<u8>, k: i64, p: usize, bare: bool) {
    if k < 0 {
        out.push(b'-');
    }
    let a = k.unsigned_abs();
    let g = POW10[p] as u64;
    let (ip, mut fp) = (a / g, a % g);
    if ip != 0 || !bare || fp == 0 {
        push_uint(out, ip);
    }
    if fp == 0 {
        return;
    }
    let mut d = p;
    while fp % 10 == 0 {
        fp /= 10;
        d -= 1;
    }
    out.push(b'.');
    let mut buf = [0u8; 20];
    for j in (0..d).rev() {
        buf[j] = b'0' + (fp % 10) as u8;
        fp /= 10;
    }
    out.extend_from_slice(&buf[..d]);
}

/// `String(v)` for any f64 (ECMAScript Number::toString) — used for the
/// option string that seeds the SVG id hash.
pub(crate) fn push_js_num(out: &mut Vec<u8>, v: f64) {
    if v.is_nan() {
        out.extend_from_slice(b"NaN");
        return;
    }
    if v.is_infinite() {
        out.extend_from_slice(if v > 0.0 { b"Infinity" } else { b"-Infinity" });
        return;
    }
    if v == 0.0 {
        out.push(b'0'); // also −0
        return;
    }
    let a = v.abs();
    if v.fract() == 0.0 && a < 9.0e15 {
        if v < 0.0 {
            out.push(b'-');
        }
        push_uint(out, a as u64);
        return;
    }
    let mut s = String::new();
    if (1e-6..1e21).contains(&a) {
        // Rust's Display is shortest round-trip in plain notation, like JS here.
        let _ = write!(s, "{v}");
    } else {
        // JS uses exponent notation outside that range ("1e-7", "1e+21").
        let _ = write!(s, "{v:e}");
        if let Some(p) = s.find('e') {
            if !s[p + 1..].starts_with('-') {
                s.insert(p + 1, '+');
            }
        }
    }
    out.extend_from_slice(s.as_bytes());
}

const HEX: &[u8; 16] = b"0123456789abcdef";

#[inline]
fn push_hex(out: &mut Vec<u8>, c: u32) {
    out.push(b'#');
    for sh in [20, 16, 12, 8, 4, 0] {
        out.push(HEX[((c >> sh) & 15) as usize]);
    }
}

/// FNV-1a over size, colour keys and the option string — `hashId` in JS.
pub(crate) fn hash_id(pd: &PixelData, opt_string: &[u16]) -> String {
    let mut h: u32 = 0x811c_9dc5;
    let mut mix = |v: u32| {
        h ^= v;
        h = h.wrapping_mul(0x0100_0193);
    };
    mix(pd.w as u32);
    mix(pd.h as u32);
    for &k in &pd.key {
        mix(k);
    }
    for &u in opt_string {
        mix(u as u32);
    }
    const D: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buf = Vec::with_capacity(10);
    loop {
        buf.push(D[(h % 36) as usize]);
        h /= 36;
        if h == 0 {
            break;
        }
    }
    buf.reverse();
    let mut id = String::with_capacity(buf.len() + 4);
    id.push_str("dpx");
    id.push_str(std::str::from_utf8(&buf).unwrap_or(""));
    id.push('-');
    id
}

/// Coarsest decimal grid (in pixels) that keeps every point within ¼ output
/// pixel at `scale` — `autoPrecision` in JS.
pub(crate) fn auto_precision(scale: f64) -> usize {
    let (mut p, mut t) = (0, 1.0);
    while t < 2.0 * scale && p < 6 {
        t *= 10.0;
        p += 1;
    }
    p
}

// ---- path encoding ------------------------------------------------------------------------

/// Path data state. Positions are integers in "fine" units of ¼ grid step
/// (grid = 10^−p px), because canonical control points can fall on ½ or ¼
/// steps. Same algorithm and output as `PathEncoder` in JS.
struct PathEnc {
    p: usize,
    g: f64,
    f: i64,
    cmd: u8,
    fresh: bool,
    dot: bool,
    x: i64,
    y: i64,
    sx: i64,
    sy: i64,
}

impl PathEnc {
    fn new(p: usize) -> Self {
        PathEnc { p, g: POW10[p] as f64, f: 4 * POW10[p], cmd: 0, fresh: false, dot: false, x: 0, y: 0, sx: 0, sy: 0 }
    }
    #[inline]
    fn begin(&mut self) {
        self.cmd = 0;
        self.fresh = false;
        self.dot = false;
    }
    /// Fine units of the grid point nearest to `v` (pixels).
    #[inline]
    fn q(&self, v: f64) -> i64 {
        4 * js_round(v * self.g) as i64
    }
    #[inline]
    fn letter(&mut self, out: &mut Vec<u8>, c: u8) {
        out.push(c);
        self.cmd = c;
        self.fresh = true;
    }
    #[inline]
    fn op(&mut self, out: &mut Vec<u8>, c: u8) {
        if self.cmd != c {
            self.letter(out, c);
        }
    }
    /// Number `k` (fine units) = 25k·10^−(p+2) px, minified.
    fn num(&mut self, out: &mut Vec<u8>, k: i64) {
        let a = k.abs();
        let frac = a % self.f != 0;
        let bare_dot = frac && a < self.f;
        if self.fresh {
            self.fresh = false;
        } else if k >= 0 && !(bare_dot && self.dot) {
            out.push(b' ');
        }
        push_fixed(out, k * 25, self.p + 2, true);
        self.dot = frac;
    }
    fn move_to(&mut self, out: &mut Vec<u8>, fx: i64, fy: i64) {
        self.letter(out, b'M');
        self.num(out, fx);
        self.num(out, fy);
        self.x = fx;
        self.sx = fx;
        self.y = fy;
        self.sy = fy;
    }
    fn line_to(&mut self, out: &mut Vec<u8>, fx: i64, fy: i64) {
        let (dx, dy) = (fx - self.x, fy - self.y);
        if dx == 0 && dy == 0 {
            return;
        }
        if dy == 0 {
            self.op(out, b'h');
            self.num(out, dx);
        } else if dx == 0 {
            self.op(out, b'v');
            self.num(out, dy);
        } else {
            self.op(out, b'l');
            self.num(out, dx);
            self.num(out, dy);
        }
        self.x = fx;
        self.y = fy;
    }
    fn quad_to(&mut self, out: &mut Vec<u8>, kx: i64, ky: i64, fx: i64, fy: i64) {
        let (cx, cy) = (self.x, self.y);
        if kx == cx && ky == cy && fx == cx && fy == cy {
            return;
        }
        self.op(out, b'q');
        self.num(out, kx - cx);
        self.num(out, ky - cy);
        self.num(out, fx - cx);
        self.num(out, fy - cy);
        self.x = fx;
        self.y = fy;
    }
    fn close(&mut self, out: &mut Vec<u8>) {
        self.letter(out, b'z');
        self.x = self.sx;
        self.y = self.sy;
    }
}

/// Canonical rounded quad of control point `s` (fine units): endpoints A, C
/// and node point Q on the grid, and the control point K = (4Q − A − C)/2
/// that makes the quad pass exactly through Q at its middle. Every region
/// draws exact halves or wholes of this quad, so shared edges and T-junctions
/// stay watertight at any precision.
#[derive(Clone, Copy)]
struct Canon {
    a: (i64, i64),
    c: (i64, i64),
    q: (i64, i64),
    k: (i64, i64),
}

#[inline]
fn canon_quad(pe: &PathEnc, c: &Curve, x: &[f64], y: &[f64], s: usize) -> Canon {
    let (ax, ay) = seg_a(c, x, y, s);
    let (cx, cy) = seg_c(c, x, y, s);
    let (qx, qy) = node_pt(c, x, y, s);
    let a = (pe.q(ax), pe.q(ay));
    let cc = (pe.q(cx), pe.q(cy));
    let q = (pe.q(qx), pe.q(qy));
    let k = ((4 * q.0 - a.0 - cc.0) / 2, (4 * q.1 - a.1 - cc.1) / 2);
    Canon { a, c: cc, q, k }
}

// ---- writer --------------------------------------------------------------------------------

struct Batch {
    members: Vec<usize>,
    boxes: Vec<[i64; 4]>,
    last: usize,
}

pub(crate) struct SvgWriter<'a> {
    pd: &'a PixelData,
    scale: f64,
    sigma: f64,
    id: &'a str,
    pe: PathEnc,
    out: Vec<u8>,
    hc: Vec<i32>,
    hj: Vec<i32>,
    hd: Vec<i8>,
}

impl<'a> SvgWriter<'a> {
    /// `out` is cleared and reused (its capacity is kept).
    pub(crate) fn new(pd: &'a PixelData, scale: f64, sigma: f64, precision: usize, id: &'a str, mut out: Vec<u8>) -> Self {
        out.clear();
        out.reserve(4096 + pd.loop_slots.len() * 12 + pd.n * 2);
        SvgWriter { pd, scale, sigma, id, pe: PathEnc::new(precision), out, hc: Vec::new(), hj: Vec::new(), hd: Vec::new() }
    }

    #[inline]
    fn raw(&mut self, b: &[u8]) {
        self.out.extend_from_slice(b);
    }

    pub(crate) fn render(mut self) -> Vec<u8> {
        let pd = self.pd;
        self.raw(b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"");
        push_fixed(&mut self.out, js_round(pd.w as f64 * self.scale * 10.0) as i64, 1, false);
        self.raw(b"\" height=\"");
        push_fixed(&mut self.out, js_round(pd.h as f64 * self.scale * 10.0) as i64, 1, false);
        self.raw(b"\" viewBox=\"0 0 ");
        push_uint(&mut self.out, pd.w as u64);
        self.raw(b" ");
        push_uint(&mut self.out, pd.h as u64);
        self.raw(b"\">");
        let exact = !pd.opaque;
        // Painter's order: by outer area, largest first (ties by region id).
        let mut order: Vec<usize> = (0..pd.r_count).filter(|&r| pd.r_kind[r] != 2).collect();
        order.sort_by(|&a, &b| {
            let d = pd.r_area[b] - pd.r_area[a];
            if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap() } else { a.cmp(&b) }
        });
        let mut batch_of = vec![-1i32; pd.r_count];
        let mut batches: Vec<Batch> = Vec::new();
        if self.sigma > 0.0 {
            let d = (3.0 * self.sigma).ceil() as i64 + 2;
            for (oi, &r) in order.iter().enumerate() {
                if pd.r_multi[r] == 0 || pd.r_kind[r] != 0 {
                    continue;
                }
                let bb = self.bbox(r);
                let mut b = 0;
                while b < batches.len() {
                    let clash = batches[b]
                        .boxes
                        .iter()
                        .any(|q| bb[0] - d <= q[2] && q[0] <= bb[2] + d && bb[1] - d <= q[3] && q[1] <= bb[3] + d);
                    if !clash {
                        break;
                    }
                    b += 1;
                }
                if b == batches.len() {
                    batches.push(Batch { members: Vec::new(), boxes: Vec::new(), last: 0 });
                }
                batches[b].members.push(r);
                batches[b].boxes.push(bb);
                batches[b].last = oi;
                batch_of[r] = b as i32;
            }
            if !batches.is_empty() {
                self.raw(b"<defs><filter id=\"");
                self.raw(self.id.as_bytes());
                self.raw(b"f\" x=\"-10%\" y=\"-10%\" width=\"120%\" height=\"120%\" color-interpolation-filters=\"sRGB\"><feGaussianBlur stdDeviation=\"");
                push_fixed(&mut self.out, js_round(self.sigma * 1000.0) as i64, 3, false);
                self.raw(b"\"/><feComponentTransfer><feFuncA type=\"linear\" slope=\"40\"/></feComponentTransfer></filter></defs>");
            }
        }
        self.raw(b"<g stroke-width=\"1.2\" stroke-linejoin=\"round\"");
        if exact {
            self.raw(b" fill-rule=\"evenodd\"");
        }
        self.raw(b">");
        for (oi, &r) in order.iter().enumerate() {
            if batch_of[r] >= 0 {
                let b = batch_of[r] as usize;
                if batches[b].last == oi {
                    self.smooth_batch(&batches[b], b);
                }
                continue;
            }
            if pd.r_multi[r] != 0 {
                self.cell_region(r);
                continue;
            }
            let p0 = pd.r_pix[pd.r_start[r] as usize] as usize;
            self.paint(pd.rgb[p0], pd.alpha[p0]);
            self.raw(b" d=\"");
            self.pe.begin();
            self.region_path(r, exact);
            self.raw(b"\"/>");
        }
        self.raw(b"</g></svg>");
        self.out
    }

    /// Opening of a `<path>` filled (and seam-stroked) with one colour.
    fn paint(&mut self, rgb: u32, a: u8) {
        self.raw(b"<path fill=\"");
        push_hex(&mut self.out, rgb);
        if a == 255 {
            self.raw(b"\" stroke=\"");
            push_hex(&mut self.out, rgb);
            self.raw(b"\" vector-effect=\"non-scaling-stroke\"");
        } else {
            self.raw(b"\" fill-opacity=\"");
            push_fixed(&mut self.out, js_round(a as f64 / 2.55) as i64, 2, false);
            self.raw(b"\"");
        }
    }

    fn region_path(&mut self, r: usize, exact: bool) {
        let pd = self.pd;
        for t in pd.r_loop_start[r]..pd.r_loop_start[r + 1] {
            let l = &pd.loops[pd.r_loops[t as usize] as usize];
            if exact || l.area > 0.0 {
                self.emit_loop(l);
            }
        }
    }

    fn bbox(&self, r: usize) -> [i64; 4] {
        let pd = self.pd;
        let w = pd.w;
        let (mut x0, mut y0, mut x1, mut y1) = (w as i64, pd.h as i64, 0i64, 0i64);
        for p in pd.r_start[r]..pd.r_start[r + 1] {
            let i = pd.r_pix[p as usize] as usize;
            let (x, y) = ((i % w) as i64, (i / w) as i64);
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
        }
        [x0, y0, x1, y1]
    }

    /// Smooth multi-colour regions: the pixels (horizontal runs, one path per
    /// colour) are blurred and renormalised by the filter, and masked by the
    /// region outlines.
    fn smooth_batch(&mut self, b: &Batch, bi: usize) {
        let pd = self.pd;
        let w = pd.w;
        self.raw(b"<mask id=\"");
        self.raw(self.id.as_bytes());
        self.raw(b"m");
        push_uint(&mut self.out, bi as u64);
        self.raw(b"\"><path fill=\"#fff\" stroke=\"#fff\" vector-effect=\"non-scaling-stroke\" fill-rule=\"evenodd\" d=\"");
        self.pe.begin();
        for &r in &b.members {
            self.region_path(r, true);
        }
        self.raw(b"\"/></mask><g mask=\"url(#");
        self.raw(self.id.as_bytes());
        self.raw(b"m");
        push_uint(&mut self.out, bi as u64);
        self.raw(b")\"><g filter=\"url(#");
        self.raw(self.id.as_bytes());
        self.raw(b"f)\" stroke=\"none\">");
        let (mut x0, mut y0, mut x1, mut y1) = (w as i64, pd.h as i64, 0i64, 0i64);
        for q in &b.boxes {
            x0 = x0.min(q[0]);
            y0 = y0.min(q[1]);
            x1 = x1.max(q[2]);
            y1 = y1.max(q[3]);
        }
        // Invisible margin: makes the filter and mask regions cover the outlines.
        self.raw(b"<rect x=\"");
        push_fixed(&mut self.out, x0 - 2, 0, false);
        self.raw(b"\" y=\"");
        push_fixed(&mut self.out, y0 - 2, 0, false);
        self.raw(b"\" width=\"");
        push_uint(&mut self.out, (x1 - x0 + 5) as u64);
        self.raw(b"\" height=\"");
        push_uint(&mut self.out, (y1 - y0 + 5) as u64);
        self.raw(b"\" fill=\"none\"/>");
        // Runs of equal colour per row (colour, x, y, length), grouped by colour (stable).
        let mut runs: Vec<(u32, u32, u32, u32, u32)> = Vec::new();
        for &r in &b.members {
            let (a, e) = (pd.r_start[r] as usize, pd.r_start[r + 1] as usize);
            let mut p = a;
            while p < e {
                let i = pd.r_pix[p] as usize;
                let c = pd.rgb[i];
                let y = i / w;
                let mut q = p + 1;
                while q < e && pd.r_pix[q] == pd.r_pix[q - 1] + 1 && pd.rgb[pd.r_pix[q] as usize] == c && pd.r_pix[q] as usize / w == y {
                    q += 1;
                }
                runs.push((c, runs.len() as u32, (i % w) as u32, y as u32, (q - p) as u32));
                p = q;
            }
        }
        runs.sort_unstable_by_key(|r| (r.0, r.1));
        let f = self.pe.f;
        let mut k = 0;
        while k < runs.len() {
            let c = runs[k].0;
            self.raw(b"<path fill=\"");
            push_hex(&mut self.out, c);
            self.raw(b"\" d=\"");
            self.pe.begin();
            while k < runs.len() && runs[k].0 == c {
                let (_, _, rx, ry, rl) = runs[k];
                let (x, y, len) = (rx as i64 * f, ry as i64 * f, rl as i64 * f);
                let out = &mut self.out;
                self.pe.move_to(out, x, y);
                self.pe.line_to(out, x + len, y);
                self.pe.line_to(out, x + len, y + f);
                self.pe.line_to(out, x, y + f);
                self.pe.close(out);
                k += 1;
            }
            self.raw(b"\"/>");
        }
        self.raw(b"</g></g>");
    }

    /// Multi-colour region, flat: every pixel cell, with its visible edges
    /// replaced by the shared curve pieces.
    fn cell_region(&mut self, r: usize) {
        let pd = self.pd;
        for p in pd.r_start[r]..pd.r_start[r + 1] {
            let i = pd.r_pix[p as usize] as usize;
            self.paint(pd.rgb[i], pd.alpha[i]);
            self.raw(b" d=\"");
            self.pe.begin();
            self.cell_path(i);
            self.raw(b"\"/>");
        }
    }

    fn cell_path(&mut self, i: usize) {
        let pd = self.pd;
        let (base, n) = (i * 8, pd.cell_n[i] as usize);
        let v0 = pd.cell_v[base] as usize;
        let (fx, fy) = (self.pe.q(pd.qx[v0]), self.pe.q(pd.qy[v0]));
        self.pe.move_to(&mut self.out, fx, fy);
        for k in 0..n {
            let s = base + k;
            let e = pd.edge_of[s];
            if e < 0 {
                let v1 = pd.cell_v[base + if k + 1 == n { 0 } else { k + 1 }] as usize;
                let (fx, fy) = (self.pe.q(pd.qx[v1]), self.pe.q(pd.qy[v1]));
                self.pe.line_to(&mut self.out, fx, fy);
                continue;
            }
            let ci = pd.curve_of[e as usize] as usize;
            let c = pd.curves[ci];
            let j = pd.idx_of[e as usize] as usize;
            let d: i32 = if pd.cell_v[s] == pd.c_nodes[c.off + j] { 1 } else { -1 };
            let mut a = if d > 0 { j } else { j + 1 };
            if c.closed && a == c.n {
                a = 0;
            }
            self.run(&c, a, 1, d);
        }
        self.pe.close(&mut self.out);
    }

    /// One boundary loop: a cyclic list of visible half-edges, emitted as runs
    /// along the shared curves.
    fn emit_loop(&mut self, l: &Loop) {
        let pd = self.pd;
        let m = l.len;
        self.hc.clear();
        self.hj.clear();
        self.hd.clear();
        for t in 0..m {
            let s = pd.loop_slots[l.start + t] as usize;
            let e = pd.edge_of[s] as usize;
            let c = pd.curve_of[e];
            let j = pd.idx_of[e];
            let cv = &pd.curves[c as usize];
            self.hc.push(c);
            self.hj.push(j);
            self.hd.push(if pd.cell_v[s] == pd.c_nodes[cv.off + j as usize] { 1 } else { -1 });
        }
        let cont = |hc: &[i32], hj: &[i32], hd: &[i8], a: usize, b: usize| -> bool {
            if hc[a] != hc[b] || hd[a] != hd[b] {
                return false;
            }
            let c = &pd.curves[hc[a] as usize];
            let mut j = hj[a] + hd[a] as i32;
            if c.closed {
                let n = c.n as i32;
                if j < 0 {
                    j += n;
                } else if j >= n {
                    j -= n;
                }
            }
            j == hj[b]
        };
        let mut s0 = usize::MAX;
        for t in 0..m {
            if !cont(&self.hc, &self.hj, &self.hd, if t == 0 { m - 1 } else { t - 1 }, t) {
                s0 = t;
                break;
            }
        }
        if s0 == usize::MAX {
            let c = pd.curves[self.hc[0] as usize];
            self.full_curve(&c);
            return;
        }
        let (mut t, mut first) = (s0, true);
        loop {
            let mut cnt = 1;
            while cnt < m {
                let b = (t + cnt) % m;
                if b == s0 || !cont(&self.hc, &self.hj, &self.hd, (t + cnt - 1) % m, b) {
                    break;
                }
                cnt += 1;
            }
            let c = pd.curves[self.hc[t] as usize];
            let d = self.hd[t] as i32;
            let mut a0 = if d > 0 { self.hj[t] as usize } else { self.hj[t] as usize + 1 };
            if c.closed && a0 == c.n {
                a0 = 0;
            }
            if first {
                let (x, y) = pd.curve_xy(&c);
                let (px, py) = node_pt(&c, x, y, a0);
                let (fx, fy) = (self.pe.q(px), self.pe.q(py));
                self.pe.move_to(&mut self.out, fx, fy);
                first = false;
            }
            self.run(&c, a0, cnt, d);
            t = (t + cnt) % m;
            if t == s0 {
                break;
            }
        }
        self.pe.close(&mut self.out);
    }

    /// A loop made of one complete closed curve.
    fn full_curve(&mut self, c: &Curve) {
        let (x, y) = self.pd.curve_xy(c);
        if c.border {
            let (fx, fy) = (self.pe.q(x[0]), self.pe.q(y[0]));
            self.pe.move_to(&mut self.out, fx, fy);
            self.run(c, 0, c.n, 1);
            self.pe.close(&mut self.out);
            return;
        }
        let (ax, ay) = seg_a(c, x, y, 0);
        let (fx, fy) = (self.pe.q(ax), self.pe.q(ay));
        self.pe.move_to(&mut self.out, fx, fy);
        for s in 0..c.n {
            let k = canon_quad(&self.pe, c, x, y, s);
            self.pe.quad_to(&mut self.out, k.k.0, k.k.1, k.c.0, k.c.1);
        }
        self.pe.close(&mut self.out);
    }

    /// Emits `cnt` edges of curve `c` from control point `a` in direction `d`
    /// (±1). Edge k runs from Q_k to Q_(k+1): the second half of quad k, then
    /// the first half of quad k+1.
    fn run(&mut self, c: &Curve, a: usize, cnt: usize, d: i32) {
        let (x, y) = self.pd.curve_xy(c);
        let (n, closed, mm) = (c.n as i64, c.closed, c.m as i64);
        if c.border || (!closed && n == 1) {
            // Straight pieces; collinear points are merged.
            let (mut lx, mut ly) = (x[a], y[a]);
            let (mut px, mut py, mut has) = (lx, ly, false);
            for t in 1..=cnt as i64 {
                let mut k = a as i64 + d as i64 * t;
                if closed {
                    k %= mm;
                    if k < 0 {
                        k += mm;
                    }
                }
                let (qx, qy) = (x[k as usize], y[k as usize]);
                if has && ((px - lx) * (qy - py) - (py - ly) * (qx - px)).abs() > 1e-9 {
                    let (fx, fy) = (self.pe.q(px), self.pe.q(py));
                    self.pe.line_to(&mut self.out, fx, fy);
                    lx = px;
                    ly = py;
                }
                px = qx;
                py = qy;
                has = true;
            }
            if has {
                let (fx, fy) = (self.pe.q(px), self.pe.q(py));
                self.pe.line_to(&mut self.out, fx, fy);
            }
            return;
        }
        let has = |s: i64| closed || (1..n).contains(&s);
        let wrap = |s: i64| (if closed { ((s % n) + n) % n } else { s }) as usize;
        let (a, cnt) = (a as i64, cnt as i64);
        let out = &mut self.out;
        let pe = &mut self.pe;
        if d > 0 {
            if has(a) {
                let k = canon_quad(pe, c, x, y, wrap(a));
                pe.quad_to(out, (k.k.0 + k.c.0) / 2, (k.k.1 + k.c.1) / 2, k.c.0, k.c.1);
            }
            for t in 1..cnt {
                let k = canon_quad(pe, c, x, y, wrap(a + t));
                pe.quad_to(out, k.k.0, k.k.1, k.c.0, k.c.1);
            }
            if has(a + cnt) {
                let k = canon_quad(pe, c, x, y, wrap(a + cnt));
                pe.quad_to(out, (k.a.0 + k.k.0) / 2, (k.a.1 + k.k.1) / 2, k.q.0, k.q.1);
            }
        } else {
            if has(a) {
                let k = canon_quad(pe, c, x, y, wrap(a));
                pe.quad_to(out, (k.a.0 + k.k.0) / 2, (k.a.1 + k.k.1) / 2, k.a.0, k.a.1);
            }
            for t in 1..cnt {
                let k = canon_quad(pe, c, x, y, wrap(a - t));
                pe.quad_to(out, k.k.0, k.k.1, k.a.0, k.a.1);
            }
            if has(a - cnt) {
                let k = canon_quad(pe, c, x, y, wrap(a - cnt));
                pe.quad_to(out, (k.k.0 + k.c.0) / 2, (k.k.1 + k.c.1) / 2, k.q.0, k.q.1);
            }
        }
    }
}
