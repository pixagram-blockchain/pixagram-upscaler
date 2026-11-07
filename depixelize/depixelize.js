// depixelize.js — Resolution-independent vectorization of pixel art.
// Implementation of Kopf & Lischinski, "Depixelizing Pixel Art" (SIGGRAPH 2011).
// Single file, zero dependencies, browser + Node.
//
//   const svg   = depixelize(imageData, opts);        // SVG document (string)
//   const bytes = depixelizeBytes(imageData, opts);   // same, UTF-8 bytes
//
// Options:
//   scale        40      output size: SVG width/height = image size × scale
//   precision    'auto'  decimals of the coordinates (pixel units). 'auto' picks
//                        the coarsest grid that keeps every point within ¼ output
//                        pixel at `scale`: 2 decimals at scale 40, 1 at scale 4.
//   mode         'auto'  'cell'  — a region is a group of similar pixels (as in
//                                  the paper); colour varies smoothly inside it
//                        'shape' — a region is a group of identical pixels;
//                                  every colour boundary becomes a curve
//                        'auto'  — per region: banded shading stays crisp,
//                                  gradients / dither / noise are smoothed
//   smooth       true    optimise the curve control points (paper §3.4):
//                        true   — the paper's random relaxation
//                        'fast' — deterministic pattern search on the same
//                                 energy (f32; one f32x4 per visit in the SIMD
//                                 build): about as smooth, a fraction of the work
//                        false  — keep the control points on the pixel lattice
//   iterations   20      relaxation sweeps (fast: the maximum; usually fewer)
//   guesses      20      random candidates per control point per sweep
//   guessOffset  0.05    max displacement of one candidate (pixels); the fast
//                        mode's steps are 2×, 1× and ½× this
//   shading      0.7     σ (pixels) of the edge-aware colour interpolation used
//                        inside multi-colour regions; 0 = flat cells
//   seed         1       PRNG seed — output is deterministic
//   idPrefix     —       prefix for the ids inside the SVG (default: a hash)
//
// Pipeline (one stage function each, see the section headers below)
//   1. Pixels → similarity graph (hqx YUV thresholds, alpha aware); crossing
//      diagonals resolved by the curves / sparse pixels / islands heuristics.
//   2. Reshaped pixel cells: the simplified generalised Voronoi diagram pasted
//      together from per-corner templates; nodes on the ¼-pixel lattice.
//   3. Regions: connected pixels rendered as one area.
//   4. Visible edges, chained into boundary loops and into curves that are
//      SHARED by the two regions they separate (T-junction rules).
//   5. Quadratic B-splines through the node lattice; corner patterns (Fig. 7)
//      excluded; control points optimised by random relaxation (or, opt-in,
//      a pattern search) of E = ∫|κ| ds + |p − p̂|⁴ (∫|κ| ds = the control
//      polygon's turning angles).
//   6. SVG in pixel units (viewBox), assembled from the shared curve pieces so
//      neighbours meet exactly; multi-colour regions get an edge-aware Gaussian
//      colour interpolation.
//
// Data model: one Graph of flat typed arrays (struct of arrays) with CSR
// indexing — curves, loops and regions are offset ranges into shared buffers,
// so stages pass views (subarray) instead of copies. The Rust/WebAssembly build
// (pkg/depixelize-wasm.mjs) uses the same layout and produces byte-identical
// output; all floating-point work is deterministic (no Math.atan2/sin/cos).

'use strict';

// ============================================================================
// Constants
// ============================================================================
const ALPHA_CUT    = 16;    // alpha below this counts as fully transparent
const SHADING_DIST = 100;   // YUV distance up to which a visible edge is a "shading" edge
const FRAGMENT     = 3;     // similar-colour groups up to this size may be absorbed…
const ABSORB_DIST  = 40;    // …into an edge-adjacent group within this YUV distance
const MAX_SCALE    = 1e6;
const MAX_PRECISION = 6;
const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;

// Which node terminates a cell side that arrives at a pixel corner, indexed
// [cornerType * 4 + direction]. Corner types: 0 = no diagonal through the
// corner, 1 = TL–BR diagonal kept, 2 = TR–BL diagonal kept. A chamfered corner
// C is replaced by two nodes (slot 0 / slot 1):
//   type 1: a = C + (¼, −¼), b = C + (−¼, ¼)     type 2: a = C + (−¼, −¼), b = C + (¼, ¼)
const E_SLOT = new Uint8Array([
  0, 0, 0, 0,
  0, 0, 1, 1,
  0, 1, 1, 0,
]);

const DEFAULTS = Object.freeze({
  scale: 40, mode: 'auto', smooth: true, iterations: 20, guesses: 20,
  guessOffset: 0.05, shading: 0.7, seed: 1, precision: 'auto',
});

// ============================================================================
// Small reusable helpers
// ============================================================================
/** Copy of typed array `a`, grown to length n. */
function grow(a, n) { const b = new a.constructor(n); b.set(a); return b; }

/** Growable typed array with amortised O(1) push; view() is a zero-copy subarray. */
class List {
  constructor(Type, cap = 64) { this.a = new Type(cap); this.n = 0; }
  push(v) { if (this.n === this.a.length) this.a = grow(this.a, this.n * 2); this.a[this.n++] = v; }
  view() { return this.a.subarray(0, this.n); }
}

/** Stable bucket sort of items 0..n−1 by key[i] ∈ [0, buckets) → CSR { start, items }. */
function csr(key, n, buckets) {
  const start = new Int32Array(buckets + 1);
  for (let i = 0; i < n; i++) start[key[i] + 1]++;
  for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
  const items = new Int32Array(n), fill = start.slice(0, buckets);
  for (let i = 0; i < n; i++) items[fill[key[i]]++] = i;
  return { start, items };
}

/** Reusable flood-fill scratch: visit stamps, an explicit stack, 8 neighbour slots. */
class Scratch {
  constructor(N) { this.mark = new Uint32Array(N); this.stamp = 0; this.stack = new Int32Array(N + 8); this.nbs = new Int32Array(8); }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Deterministic math kernels. Only + − × ÷ and comparisons, which are correctly
// rounded IEEE-754 operations in every engine — so this file and the Rust build
// agree to the last bit (Math.atan2/sin/cos are not guaranteed to).
// ============================================================================
// |atan2(cr, dt)| ∈ [0, π]: octant reduction to a = min/max ∈ [0, 1] and a
// degree-4 minimax polynomial for atan(a)/a in s = a² (Estrin's scheme; max
// error 1.1e-5 rad — far below anything visible, and cheap).
const AT0 = 0.9998663291207185, AT1 = -0.33030477985595086, AT2 = 0.18015927121038314,
      AT3 = -0.08515631565062434, AT4 = 0.02084509680032225;
const HALF_PI = 1.5707963267948966, PI = 3.141592653589793;
function absAngle(cr, dt) {
  const ay = cr < 0 ? -cr : cr, ax = dt < 0 ? -dt : dt;
  const mx = ay > ax ? ay : ax;
  if (mx === 0) return 0;
  const a = (ay > ax ? ax : ay) / mx, s = a * a, s2 = s * s;
  let r = (((AT0 + AT1 * s) + (AT2 + AT3 * s) * s2) + AT4 * (s2 * s2)) * a;
  if (ay > ax) r = HALF_PI - r;
  if (dt < 0) r = PI - r;
  return r;
}

// 256 unit directions for the random candidates, generated by repeated exact
// rotation (no sin/cos), identical in every implementation.
const DIR_X = new Float64Array(256), DIR_Y = new Float64Array(256);
(() => {
  const c = 0.9996988186962042, s = 0.024541228522912288;
  let x = 1, y = 0;
  for (let k = 0; k < 256; k++) {
    DIR_X[k] = x; DIR_Y[k] = y;
    const nx = x * c - y * s;
    y = x * s + y * c; x = nx;
  }
})();

// absAngle in single precision, for the fast mode. Math.fround after every
// operation gives IEEE f32 results (an f64 + − × ÷ of f32 values, rounded
// once more to f32, is the correctly rounded f32 result), i.e. exactly what
// Rust's f32 and wasm's f32x4 compute.
const f32 = Math.fround;
const AT0f = f32(AT0), AT1f = f32(AT1), AT2f = f32(AT2), AT3f = f32(AT3), AT4f = f32(AT4),
      HALF_PIf = f32(HALF_PI), PIf = f32(PI);
function absAngle32(cr, dt) {
  const ay = Math.abs(cr), ax = Math.abs(dt), up = ay > ax;
  const mx = up ? ay : ax;
  if (mx === 0) return 0;
  const a = f32((up ? ax : ay) / mx), s = f32(a * a), s2 = f32(s * s);
  let r = f32(f32(f32(f32(AT0f + f32(AT1f * s)) + f32(f32(AT2f + f32(AT3f * s)) * s2)) + f32(AT4f * f32(s2 * s2))) * a);
  if (up) r = f32(HALF_PIf - r);
  if (dt < 0) r = f32(PIf - r);
  return r;
}
// |turning angle| of the control polygon at b. For a uniform quadratic
// B-spline the segment around control point b is a parabola whose tangent
// turns monotonically from (P_b − P_a) to (P_c − P_b), so ∫|κ| ds over that
// segment equals this angle exactly.
function turn(x, y, a, b, c) {
  const ux = x[b] - x[a], uy = y[b] - y[a], vx = x[c] - x[b], vy = y[c] - y[b];
  return absAngle(ux * vy - uy * vx, ux * vx + uy * vy);
}

// Corner patterns of Fig. 7 in ¼-pixel units relative to the pixel's top-left
// corner, expanded to all 8 symmetries and both traversal directions (48
// variants) — the tips of one-pixel-wide features, whose curvature is
// intentional. Bucketed by (lattice phase of the first point, first step) so
// a node is only tested against the ≤ 3 patterns that can start there.
const CORNER = (() => {
  const base = [
    [0, 4, 1, 1, 3, 1, 4, 4],
    [-1, 3, 1, 1, 3, 1, 4, 4],
    [-1, 3, 1, 1, 3, 1, 5, 3],
    [0, 4, 0, 0, 4, 0, 4, 4],
    [3, 5, 1, 3, 1, 1, 3, 1, 5, 3],
  ];
  const seen = new Set(), pats = [];
  for (const p of base) for (let s = 0; s < 8; s++) for (let rev = 0; rev < 2; rev++) {
    const L = p.length >> 1, q = new Int32Array(p.length);
    for (let k = 0; k < L; k++) {
      let dx = p[2 * k] - 2, dy = p[2 * k + 1] - 2;
      if (s & 4) dx = -dx;
      for (let r = 0; r < (s & 3); r++) { const t = dx; dx = -dy; dy = t; }
      const d = rev ? L - 1 - k : k;
      q[2 * d] = dx + 2; q[2 * d + 1] = dy + 2;
    }
    const key = q.join(',');
    if (!seen.has(key)) { seen.add(key); pats.push(q); }
  }
  const keys = new Int32Array(pats.length);
  for (let i = 0; i < pats.length; i++) {
    const p = pats[i];
    keys[i] = cornerKey(p[0], p[1], p[2] - p[0], p[3] - p[1]);
  }
  const { start, items } = csr(keys, pats.length, 16 * 81);
  return { pats, start, items };
})();
function cornerKey(x, y, dx, dy) {
  if (dx < -4 || dx > 4 || dy < -4 || dy > 4) return -1;
  return ((x & 3) * 4 + (y & 3)) * 81 + (dx + 4) * 9 + (dy + 4);
}

// ============================================================================
// Graph: the whole pipeline state as flat typed arrays (struct of arrays).
// Every field is created here so the object keeps one shape.
// ============================================================================
class Graph {
  constructor(w, h) {
    this.w = w; this.h = h; this.N = w * h;
    // pixels
    this.rgb = null; this.alpha = null; this.key = null; this.yuv = null; this.opaque = true;
    // similarity graph: 4 forward bits per pixel (1 = +x, 2 = +y, 4 = SE, 8 = NE)
    this.neigh = null;
    // cells: nodes (2 per pixel corner, ¼-px lattice), polygons of ≤ 8 edges per pixel
    this.ctype = null; this.nodeCount = 0; this.nodeX = null; this.nodeY = null;
    this.cellV = null; this.cellNb = null; this.cellN = null; this.cellTwin = null;
    // regions (CSR: pixels of region r = rPix[rStart[r] .. rStart[r+1]])
    this.R = 0; this.region = null; this.rStart = null; this.rPix = null; this.rMulti = null; this.rKind = null;
    // visible edges + node incidence (CSR)
    this.E = 0; this.edgeOf = null; this.eU = null; this.eV = null; this.eP = null; this.eQ = null;
    this.bdeg = null; this.bStart = null; this.bInc = null;
    // boundary loops (CSR): half-edge slots of loop l = loopSlots[loopStart[l] .. loopStart[l+1]]
    this.L = 0; this.loopSlots = null; this.loopStart = null; this.loopRegion = null; this.loopArea = null;
    this.rLoopStart = null; this.rLoops = null; this.rArea = null;
    // curves (CSR): nodes of curve c = cNodes[cOff[c] ..], cN[c] edges (+1 node if open)
    this.C = 0; this.cOff = null; this.cEOff = null; this.cN = null; this.cClosed = null; this.cBorder = null;
    this.cNodes = null; this.cEdges = null; this.cx = null; this.cy = null; this.cEx = null;
    this.curveOf = null; this.idxOf = null; this.join1 = null; this.join2 = null;
    this.att0 = null; this.att0j = null; this.att1 = null; this.att1j = null; this.attached = null;
    // rendered node positions
    this.qx = null; this.qy = null;
    // fast-mode statistics: control-point visits, sweeps run
    this.relaxVisits = 0; this.relaxSweeps = 0;
  }
}

/** Runs the geometric pipeline (stages 1–5); returns the Graph. */
function analyze(width, height, data, o) {
  const w = width | 0, h = height | 0;
  if (w <= 0 || h <= 0) throw new RangeError('depixelize: image must be at least 1×1');
  if (!data || data.length < w * h * 3) throw new RangeError('depixelize: pixel data too short');
  const g = new Graph(w, h);
  readPixels(g, data);
  buildSimilarity(g);
  resolveCrossings(g);
  buildCells(g);
  buildRegions(g, o.mode);
  buildBoundaries(g);
  traceLoops(g);
  buildCurves(g);
  detectCorners(g);
  if (o.smooth === 'fast') optimizeFast(g, o); else if (o.smooth) optimize(g, o);
  finalize(g);
  return g;
}

// ============================================================================
// 1. Pixels and similarity
// ============================================================================
function readPixels(g, data) {
  const N = g.N, stride = data.length >= N * 4 ? 4 : 3;
  const rgb = g.rgb = new Uint32Array(N);
  const alpha = g.alpha = new Uint8Array(N);
  const key = g.key = new Uint32Array(N);      // exact colour identity, 0 = transparent
  const yuv = g.yuv = new Int16Array(N * 3);
  let opaque = true;
  for (let i = 0, j = 0; i < N; i++, j += stride) {
    const a = stride === 4 ? data[j + 3] : 255;
    if (a < 255) opaque = false;
    if (a < ALPHA_CUT) continue;
    const r = data[j], gr = data[j + 1], b = data[j + 2];
    const c = (r << 16) | (gr << 8) | b;
    rgb[i] = c; alpha[i] = a;
    key[i] = ((c << 8) | a) >>> 0;
    const y = (77 * r + 150 * gr + 29 * b) >> 8;    // ~0.299r + 0.587g + 0.114b
    yuv[i * 3] = y;
    yuv[i * 3 + 1] = (126 * (b - y)) >> 8;          // ~0.492 (b − y)
    yuv[i * 3 + 2] = (224 * (r - y)) >> 8;          // ~0.877 (r − y)
  }
  g.opaque = opaque;
}

function similar(g, i, j) {
  const A = g.alpha, ai = A[i], aj = A[j];
  if (ai === 0 || aj === 0) return ai === aj;
  const da = ai - aj; if (da > 32 || da < -32) return false;
  const Y = g.yuv, p = i * 3, q = j * 3;
  const dy = Y[p] - Y[q];         if (dy > 48 || dy < -48) return false;
  const du = Y[p + 1] - Y[q + 1]; if (du > 7 || du < -7) return false;
  const dv = Y[p + 2] - Y[q + 2]; if (dv > 6 || dv < -6) return false;
  return true;
}

function yuvDist(g, i, j) {
  const A = g.alpha;
  if (A[i] === 0 || A[j] === 0) return A[i] === A[j] ? 0 : 1e9;
  const Y = g.yuv, p = i * 3, q = j * 3;
  const dy = Y[p] - Y[q], du = Y[p + 1] - Y[q + 1], dv = Y[p + 2] - Y[q + 2], da = A[i] - A[j];
  return Math.sqrt(dy * dy + du * du + dv * dv + da * da);
}

function buildSimilarity(g) {
  const { w, h } = g, neigh = g.neigh = new Uint8Array(g.N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let n = 0;
    if (x + 1 < w && similar(g, i, i + 1)) n |= 1;
    if (y + 1 < h && similar(g, i, i + w)) n |= 2;
    if (x + 1 < w && y + 1 < h && similar(g, i, i + w + 1)) n |= 4;
    if (x + 1 < w && y > 0 && similar(g, i, i - w + 1)) n |= 8;
    neigh[i] = n;
  }
}

/** Writes the similarity-graph neighbours of pixel i into out; returns their count. */
function neighbors(g, i, out) {
  const w = g.w, h = g.h, neigh = g.neigh;
  const x = i % w, y = (i / w) | 0, n = neigh[i];
  let c = 0;
  if (n & 1) out[c++] = i + 1;
  if (n & 2) out[c++] = i + w;
  if (n & 4) out[c++] = i + w + 1;
  if (n & 8) out[c++] = i - w + 1;
  if (x > 0 && (neigh[i - 1] & 1)) out[c++] = i - 1;
  if (y > 0 && (neigh[i - w] & 2)) out[c++] = i - w;
  if (x > 0 && y > 0 && (neigh[i - w - 1] & 4)) out[c++] = i - w - 1;
  if (x > 0 && y + 1 < h && (neigh[i + w - 1] & 8)) out[c++] = i + w - 1;
  return c;
}

function degree(g, i) {
  const w = g.w, h = g.h, neigh = g.neigh;
  const x = i % w, y = (i / w) | 0, n = neigh[i];
  let d = (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1);
  if (x > 0 && (neigh[i - 1] & 1)) d++;
  if (y > 0 && (neigh[i - w] & 2)) d++;
  if (x > 0 && y > 0 && (neigh[i - w - 1] & 4)) d++;
  if (x > 0 && y + 1 < h && (neigh[i + w - 1] & 8)) d++;
  return d;
}

function removeEdge(g, a, b) {
  const w = g.w, neigh = g.neigh;
  const dx = (b % w) - (a % w), dy = ((b / w) | 0) - ((a / w) | 0);
  if      (dx ===  1 && dy ===  0) neigh[a] &= ~1;
  else if (dx ===  0 && dy ===  1) neigh[a] &= ~2;
  else if (dx ===  1 && dy ===  1) neigh[a] &= ~4;
  else if (dx ===  1 && dy === -1) neigh[a] &= ~8;
  else if (dx === -1 && dy ===  0) neigh[b] &= ~1;
  else if (dx ===  0 && dy === -1) neigh[b] &= ~2;
  else if (dx === -1 && dy === -1) neigh[b] &= ~4;
  else if (dx === -1 && dy ===  1) neigh[b] &= ~8;
}

// ---- crossing diagonals (paper §3.2) ------------------------------------------
function resolveCrossings(g) {
  const { w, h, neigh } = g, ambiguous = new List(Int32Array);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const tl = y * w + x, tr = tl + 1, bl = tl + w, br = bl + 1;
    if (!(neigh[tl] & 4) || !(neigh[bl] & 8)) continue;
    const card = (neigh[tl] & 1 ? 1 : 0) + (neigh[bl] & 1 ? 1 : 0) +
                 (neigh[tl] & 2 ? 1 : 0) + (neigh[tr] & 2 ? 1 : 0);
    if (card === 4) {                 // flat shaded block: both diagonals are redundant
      neigh[tl] &= ~4; neigh[bl] &= ~8;
    } else if (card === 0) {          // genuinely ambiguous: decided by the heuristics
      ambiguous.push(tl); ambiguous.push(br); ambiguous.push(bl); ambiguous.push(tr);
    } else {
      // Partially connected block (possible because similarity is not
      // transitive). Keep the closer pair so the graph stays planar.
      const d1 = yuvDist(g, tl, br), d2 = yuvDist(g, bl, tr);
      if (d1 >= d2) neigh[tl] &= ~4;
      if (d2 >= d1) neigh[bl] &= ~8;
    }
  }
  if (!ambiguous.n) return;
  const blocks = ambiguous.view(), sc = new Scratch(g.N);
  const weight = (a, b) => curveLength(g, sc, a, b) + sparsity(g, sc, a, b) + island(g, a, b);
  for (let k = 0; k < blocks.length; k += 4) {
    const a1 = blocks[k], b1 = blocks[k + 1], a2 = blocks[k + 2], b2 = blocks[k + 3];
    const w1 = weight(a1, b1), w2 = weight(a2, b2);
    if (w1 <= w2) removeEdge(g, a1, b1);      // tie: both removed
    if (w2 <= w1) removeEdge(g, a2, b2);
  }
}

// Heuristic "curves": length of the valence-2 curve the diagonal belongs to.
function curveLength(g, sc, a, b) {
  const mark = sc.mark, stk = sc.stack, nbs = sc.nbs, s = ++sc.stamp;
  mark[a] = s; mark[b] = s;
  let sp = 0, count = 2;
  stk[sp++] = a; stk[sp++] = b;
  while (sp) {
    const n = stk[--sp];
    if (degree(g, n) !== 2) continue;
    const nc = neighbors(g, n, nbs);
    for (let k = 0; k < nc; k++) {
      const m = nbs[k];
      if (mark[m] !== s) { mark[m] = s; count++; stk[sp++] = m; }
    }
  }
  return count;
}

// Heuristic "sparse pixels": minus the size of the component in an 8×8 window.
function sparsity(g, sc, a, b) {
  const w = g.w, mark = sc.mark, stk = sc.stack, nbs = sc.nbs, s = ++sc.stamp;
  const x0 = Math.min(a % w, b % w) - 3, y0 = Math.min((a / w) | 0, (b / w) | 0) - 3;
  mark[a] = s; mark[b] = s;
  let sp = 0, count = 2;
  stk[sp++] = a; stk[sp++] = b;
  while (sp) {
    const n = stk[--sp], nc = neighbors(g, n, nbs);
    for (let k = 0; k < nc; k++) {
      const m = nbs[k];
      if (mark[m] === s) continue;
      const mx = (m % w) - x0, my = ((m / w) | 0) - y0;
      if (mx >= 0 && mx < 8 && my >= 0 && my < 8) { mark[m] = s; count++; stk[sp++] = m; }
    }
  }
  return -count;
}

// Heuristic "islands": keep the diagonal that would otherwise strand a pixel.
function island(g, a, b) {
  return (degree(g, a) === 1 || degree(g, b) === 1) ? 5 : 0;
}

// ============================================================================
// 2. Reshaped cells (paper §3.2, simplified Voronoi diagram)
// Nodes: two slots per pixel corner, id = corner * 2 + slot, coordinates in
// ¼-pixel units. Cell polygons run clockwise on screen (y down); edge k goes
// from vertex k to vertex k+1 and cellNb holds the pixel across it (−1 =
// outside the image).
// ============================================================================
function buildCells(g) {
  const { w, h, N, neigh } = g;
  const CW = w + 1, CH = h + 1;
  const ctype = g.ctype = new Uint8Array(CW * CH);
  for (let cy = 1; cy < h; cy++) for (let cx = 1; cx < w; cx++) {
    const tl = (cy - 1) * w + cx - 1;
    if (neigh[tl] & 4) ctype[cy * CW + cx] = 1;
    else if (neigh[tl + w] & 8) ctype[cy * CW + cx] = 2;
  }
  const NN = g.nodeCount = CW * CH * 2;
  const X = g.nodeX = new Int32Array(NN), Y = g.nodeY = new Int32Array(NN);
  for (let cy = 0, c = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++, c++) {
    const t = ctype[c], x4 = cx * 4, y4 = cy * 4, n = c * 2;
    if (t === 0)      { X[n] = x4;     Y[n] = y4;     X[n + 1] = x4;     Y[n + 1] = y4; }
    else if (t === 1) { X[n] = x4 + 1; Y[n] = y4 - 1; X[n + 1] = x4 - 1; Y[n + 1] = y4 + 1; }
    else              { X[n] = x4 - 1; Y[n] = y4 - 1; X[n + 1] = x4 + 1; Y[n + 1] = y4 + 1; }
  }
  const V = g.cellV = new Int32Array(N * 8);
  const NB = g.cellNb = new Int32Array(N * 8);
  const CN = g.cellN = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, base = i * 8;
    const c00 = y * CW + x, c10 = c00 + 1, c01 = c00 + CW, c11 = c01 + 1;
    const t00 = ctype[c00] * 4, t10 = ctype[c10] * 4, t01 = ctype[c01] * 4, t11 = ctype[c11] * 4;
    const a0 = 2 * c00 + E_SLOT[t00 + DOWN],  a1 = 2 * c00 + E_SLOT[t00 + RIGHT];
    const b0 = 2 * c10 + E_SLOT[t10 + LEFT],  b1 = 2 * c10 + E_SLOT[t10 + DOWN];
    const d0 = 2 * c11 + E_SLOT[t11 + UP],    d1 = 2 * c11 + E_SLOT[t11 + LEFT];
    const e0 = 2 * c01 + E_SLOT[t01 + RIGHT], e1 = 2 * c01 + E_SLOT[t01 + UP];
    let k = 0;
    V[base] = a0;
    if (a1 !== a0) { NB[base + k] = i - w - 1; V[base + ++k] = a1; }   // chamfer, NW neighbour
    NB[base + k++] = y > 0 ? i - w : -1;                               // top side
    V[base + k] = b0;
    if (b1 !== b0) { NB[base + k] = i - w + 1; V[base + ++k] = b1; }   // chamfer, NE
    NB[base + k++] = x < w - 1 ? i + 1 : -1;                           // right side
    V[base + k] = d0;
    if (d1 !== d0) { NB[base + k] = i + w + 1; V[base + ++k] = d1; }   // chamfer, SE
    NB[base + k++] = y < h - 1 ? i + w : -1;                           // bottom side
    V[base + k] = e0;
    if (e1 !== e0) { NB[base + k] = i + w - 1; V[base + ++k] = e1; }   // chamfer, SW
    NB[base + k++] = x > 0 ? i - 1 : -1;                               // left side
    CN[i] = k;
  }
  // Twin slot of every interior cell edge (same edge, opposite direction).
  const TW = g.cellTwin = new Int8Array(N * 8).fill(-1);
  for (let i = 0; i < N; i++) {
    const base = i * 8, n = CN[i];
    for (let k = 0; k < n; k++) {
      const nb = NB[base + k];
      if (nb < 0) continue;
      const u = V[base + k], v = V[base + (k + 1 === n ? 0 : k + 1)];
      const nbase = nb * 8, nn = CN[nb];
      for (let t = 0; t < nn; t++) {
        if (V[nbase + t] === v && V[nbase + (t + 1 === nn ? 0 : t + 1)] === u) { TW[base + k] = t; break; }
      }
      if (TW[base + k] < 0) throw new Error('depixelize: inconsistent cell graph');
    }
  }
}

// ============================================================================
// 3. Regions
// ============================================================================
/** Connected components of the similarity graph (exact: same colour too). */
function components(g, exact, sc) {
  const N = g.N, key = g.key, stack = sc.stack, nbs = sc.nbs;
  const comp = new Int32Array(N).fill(-1), sizes = new List(Int32Array), first = new List(Int32Array);
  let id = 0;
  for (let i = 0; i < N; i++) {
    if (comp[i] >= 0) continue;
    const ki = key[i];
    let sp = 0, size = 0;
    stack[sp++] = i; comp[i] = id;
    while (sp) {
      const n = stack[--sp];
      size++;
      const nc = neighbors(g, n, nbs);
      for (let k = 0; k < nc; k++) {
        const m = nbs[k];
        if (comp[m] < 0 && (!exact || key[m] === ki)) { comp[m] = id; stack[sp++] = m; }
      }
    }
    sizes.push(size); first.push(i); id++;
  }
  return { comp, count: id, sizes: sizes.view(), first: first.view() };
}

// Noise suppression (auto/cell): tiny groups of pixels whose colour is only
// slightly off from an edge-adjacent group are merged into it, so they are
// shaded smoothly instead of becoming isolated cells. Real pixel-art
// features (an eye, a highlight) are far more distinct and are kept.
function absorbFragments(g, sim) {
  const N = g.N, comp = sim.comp, NB = g.cellNb, CN = g.cellN, S = sim.count;
  const parent = new Int32Array(S), size = Int32Array.from(sim.sizes);
  for (let c = 0; c < S; c++) parent[c] = c;
  const find = c => { while (parent[c] !== c) c = parent[c] = parent[parent[c]]; return c; };
  const bestD = new Float64Array(S), bestC = new Int32Array(S);
  for (let pass = 0; pass < 4; pass++) {
    bestD.fill(Infinity); bestC.fill(-1);
    let any = false;
    for (let i = 0; i < N; i++) {
      const c = find(comp[i]);
      if (size[c] > FRAGMENT) continue;
      for (let k = 0, base = i * 8; k < CN[i]; k++) {
        const nb = NB[base + k];
        if (nb < 0) continue;
        const o = find(comp[nb]);
        if (o === c) continue;
        const d = yuvDist(g, i, nb);
        if (d < bestD[c] || (d === bestD[c] && size[o] > size[bestC[c]])) { bestD[c] = d; bestC[c] = o; }
      }
    }
    for (let c = 0; c < S; c++) {
      if (parent[c] !== c || size[c] > FRAGMENT || bestC[c] < 0 || bestD[c] > ABSORB_DIST) continue;
      const o = find(bestC[c]);
      if (o === c) continue;
      parent[c] = o; size[o] += size[c]; any = true;
    }
    if (!any) break;
  }
  const map = new Int32Array(S).fill(-1), out = new Int32Array(N);
  const sizes = new List(Int32Array), first = new List(Int32Array);
  let n = 0;
  for (let i = 0; i < N; i++) {
    const r = find(comp[i]);
    if (map[r] < 0) { map[r] = n++; sizes.push(0); first.push(i); }
    out[i] = map[r]; sizes.a[map[r]]++;
  }
  return { comp: out, count: n, sizes: sizes.view(), first: first.view() };
}

function buildRegions(g, mode) {
  const N = g.N, sc = new Scratch(0);
  sc.stack = new Int32Array(N + 8);
  const sim = mode === 'shape' ? null : absorbFragments(g, components(g, false, sc));
  let region, count;
  if (mode === 'cell') {
    region = sim.comp; count = sim.count;
  } else {
    const ex = components(g, true, sc);
    if (mode === 'shape') {
      region = ex.comp; count = ex.count;
    } else {
      // auto: a group of similar pixels stays one smoothly shaded region
      // unless it is made of large flat patches (banded shading), in which
      // case each patch gets its own crisp outline.
      const S = sim.count, K = new Int32Array(S), parts = new Int32Array(S), small = new Int32Array(S);
      for (let i = 0; i < N; i++) K[sim.comp[i]]++;
      for (let e = 0; e < ex.count; e++) {
        const s = sim.comp[ex.first[e]];
        parts[s]++;
        if (ex.sizes[e] < 3) small[s] += ex.sizes[e];
      }
      region = new Int32Array(N);
      for (let i = 0; i < N; i++) {
        const s = sim.comp[i];
        const crisp = parts[s] === 1 || (K[s] >= 4 * parts[s] && small[s] * 4 <= K[s]);
        region[i] = crisp ? ex.comp[i] : ex.count + s;
      }
      count = ex.count + S;
    }
  }
  // Renumber regions in order of first pixel; CSR region → pixels.
  const map = new Int32Array(count).fill(-1);
  let R = 0;
  for (let i = 0; i < N; i++) if (map[region[i]] < 0) map[region[i]] = R++;
  const reg = g.region = new Int32Array(N);
  for (let i = 0; i < N; i++) reg[i] = map[region[i]];
  g.R = R;
  const { start, items } = csr(reg, N, R);
  g.rStart = start; g.rPix = items;
  const multi = g.rMulti = new Uint8Array(R);
  const kind = g.rKind = new Uint8Array(R);      // 0 opaque, 1 translucent, 2 transparent
  const key = g.key, alpha = g.alpha;
  for (let r = 0; r < R; r++) {
    const k0 = key[items[start[r]]];
    let m = 0, minA = 255;
    for (let p = start[r]; p < start[r + 1]; p++) {
      const i = items[p];
      if (key[i] !== k0) m = 1;
      if (alpha[i] < minA) minA = alpha[i];
    }
    multi[r] = m;
    kind[r] = minA === 0 ? 2 : minA < 255 ? 1 : 0;
  }
}

// ============================================================================
// 4. Visible edges, boundary loops, curves
// ============================================================================
function buildBoundaries(g) {
  const N = g.N, V = g.cellV, NB = g.cellNb, CN = g.cellN, TW = g.cellTwin, reg = g.region;
  const edgeOf = g.edgeOf = new Int32Array(N * 8).fill(-1);
  const eU = new List(Int32Array, 256), eV = new List(Int32Array, 256);
  const eP = new List(Int32Array, 256), eQ = new List(Int32Array, 256);
  for (let i = 0; i < N; i++) {
    const base = i * 8, n = CN[i], ri = reg[i];
    for (let k = 0; k < n; k++) {
      const s = base + k;
      if (edgeOf[s] >= 0) continue;
      const nb = NB[s];
      if (nb >= 0 && reg[nb] === ri) continue;
      const e = eU.n;
      eU.push(V[s]); eV.push(V[base + (k + 1 === n ? 0 : k + 1)]); eP.push(i); eQ.push(nb);
      edgeOf[s] = e;
      if (nb >= 0) edgeOf[nb * 8 + TW[s]] = e;
    }
  }
  const E = g.E = eU.n;
  g.eU = eU.view(); g.eV = eV.view(); g.eP = eP.view(); g.eQ = eQ.view();
  // Node → incident edges (CSR over the 2E edge ends, in edge order).
  const NN = g.nodeCount, ends = new Int32Array(2 * E);
  for (let e = 0; e < E; e++) { ends[2 * e] = g.eU[e]; ends[2 * e + 1] = g.eV[e]; }
  const { start, items } = csr(ends, 2 * E, NN);
  for (let k = 0; k < items.length; k++) items[k] >>= 1;
  g.bStart = start; g.bInc = items;
  const deg = g.bdeg = new Uint8Array(NN);
  for (let v = 0; v < NN; v++) deg[v] = start[v + 1] - start[v];
}

// Next visible half-edge after half-edge s (slot = pixel * 8 + k) along the
// boundary of s's region: rotate around the end vertex through the region's
// own cells until a visible edge is found.
function nextBoundary(g, s) {
  const NB = g.cellNb, CN = g.cellN, TW = g.cellTwin, EO = g.edgeOf;
  let p = s >> 3, q = (s & 7) + 1;
  if (q === CN[p]) q = 0;
  for (let guard = 0; guard < 32; guard++) {
    const t = (p << 3) + q;
    if (EO[t] >= 0) return t;
    const tw = TW[t];
    p = NB[t]; q = tw + 1;
    if (q === CN[p]) q = 0;
  }
  throw new Error('depixelize: boundary rotation failed');
}

function traceLoops(g) {
  const N = g.N, V = g.cellV, CN = g.cellN, EO = g.edgeOf, X = g.nodeX, Y = g.nodeY, reg = g.region;
  const seen = new Uint8Array(N * 8), limit = 2 * g.E + 8;
  const slots = new List(Int32Array, 1024), start = new List(Int32Array), region = new List(Int32Array);
  const area = new List(Float64Array);
  start.push(0);
  for (let i = 0; i < N; i++) {
    const n = CN[i];
    for (let k = 0; k < n; k++) {
      const s0 = i * 8 + k;
      if (EO[s0] < 0 || seen[s0]) continue;
      let a = 0, s = s0, guard = 0;
      do {
        seen[s] = 1; slots.push(s);
        const p = s >> 3, q = s & 7;
        const v0 = V[s], v1 = V[(p << 3) + (q + 1 === CN[p] ? 0 : q + 1)];
        a += X[v0] * Y[v1] - X[v1] * Y[v0];
        s = nextBoundary(g, s);
        if (++guard > limit) throw new Error('depixelize: boundary trace failed');
      } while (s !== s0);
      start.push(slots.n); region.push(reg[i]); area.push(a / 32);   // px²
    }
  }
  g.L = region.n;
  g.loopSlots = slots.view(); g.loopStart = start.view(); g.loopRegion = region.view(); g.loopArea = area.view();
  const { start: rs, items } = csr(g.loopRegion, g.L, g.R);
  g.rLoopStart = rs; g.rLoops = items;
  // Outer area of each region (sum of its positive loops) for paint order.
  const rArea = g.rArea = new Float64Array(g.R);
  for (let l = 0; l < g.L; l++) if (g.loopArea[l] > 0) rArea[g.loopRegion[l]] += g.loopArea[l];
}

// ---- curves (paper §3.3) --------------------------------------------------------
function isShading(g, e) {
  const q = g.eQ[e];
  return q >= 0 && yuvDist(g, g.eP[e], q) <= SHADING_DIST ? 1 : 0;
}

// Direction leaving v along visible edge e, looking up to two edges ahead.
function dirFrom(g, v, e, D, o) {
  const eU = g.eU, eV = g.eV, X = g.nodeX, Y = g.nodeY;
  const u = eU[e] === v ? eV[e] : eU[e];
  let tx = X[u], ty = Y[u];
  if (g.bdeg[u] === 2) {
    const s = g.bStart[u], a = g.bInc[s], e2 = a === e ? g.bInc[s + 1] : a;
    const u2 = eU[e2] === u ? eV[e2] : eU[e2];
    tx = X[u2]; ty = Y[u2];
  }
  D[o] = tx - X[v]; D[o + 1] = ty - Y[v];
}

// T-junctions: at every 3-way junction pick the two edges that continue.
function chooseJoins(g) {
  const NN = g.nodeCount, deg = g.bdeg, st = g.bStart, inc = g.bInc, eQ = g.eQ;
  const j1 = g.join1 = new Int32Array(NN).fill(-1);
  const j2 = g.join2 = new Int32Array(NN).fill(-1);
  const D = new Float64Array(6);
  const cos2 = (a, b) => (D[a] * D[b] + D[a + 1] * D[b + 1]) /
    Math.sqrt((D[a] * D[a] + D[a + 1] * D[a + 1]) * (D[b] * D[b] + D[b + 1] * D[b + 1]) || 1);
  for (let v = 0; v < NN; v++) {
    if (deg[v] !== 3) continue;
    const s = st[v], ea = inc[s], eb = inc[s + 1], ec = inc[s + 2];
    const ba = eQ[ea] < 0, bb = eQ[eb] < 0, bc = eQ[ec] < 0;
    let p, q;
    if (ba || bb || bc) {                           // the image frame continues
      if (ba && bb) { p = ea; q = eb; } else if (ba && bc) { p = ea; q = ec; } else { p = eb; q = ec; }
    } else {
      const sa = isShading(g, ea), sb = isShading(g, eb), sc = isShading(g, ec);
      if (sa + sb + sc === 1) {                     // contour edges continue through
        if (sa) { p = eb; q = ec; } else if (sb) { p = ea; q = ec; } else { p = ea; q = eb; }
      } else {                                      // straightest pair continues
        dirFrom(g, v, ea, D, 0); dirFrom(g, v, eb, D, 2); dirFrom(g, v, ec, D, 4);
        const cab = cos2(0, 2), cac = cos2(0, 4), cbc = cos2(2, 4);
        if (cab <= cac && cab <= cbc) { p = ea; q = eb; }
        else if (cac <= cbc) { p = ea; q = ec; }
        else { p = eb; q = ec; }
      }
    }
    j1[v] = p; j2[v] = q;
  }
}

function buildCurves(g) {
  chooseJoins(g);
  const E = g.E, eU = g.eU, eV = g.eV, eQ = g.eQ, X = g.nodeX, Y = g.nodeY;
  const NN = g.nodeCount, deg = g.bdeg, st = g.bStart, inc = g.bInc, j1 = g.join1, j2 = g.join2;
  // Every edge lies on exactly one curve: ≤ E curves, E edges, ≤ 2E nodes.
  const cOff = g.cOff = new Int32Array(E), cEOff = g.cEOff = new Int32Array(E), cN = g.cN = new Int32Array(E);
  const cClosed = g.cClosed = new Uint8Array(E), cBorder = g.cBorder = new Uint8Array(E);
  const nodes = g.cNodes = new Int32Array(2 * E), edges = g.cEdges = new Int32Array(E);
  const curveOf = g.curveOf = new Int32Array(E).fill(-1), idxOf = g.idxOf = new Int32Array(E);
  let C = 0, nTop = 0, eTop = 0;
  const terminal = (v, e) => deg[v] !== 2 && j1[v] !== e && j2[v] !== e;
  const nextEdge = (v, e) => {
    if (deg[v] === 2) { const a = inc[st[v]]; return a === e ? inc[st[v] + 1] : a; }
    return j1[v] === e ? j2[v] : j2[v] === e ? j1[v] : -1;
  };
  const chain = (v0, e0, closed) => {
    const id = C++, off = nTop, eoff = eTop;
    let v = v0, e = e0;
    nodes[nTop++] = v0;
    for (;;) {
      const u = eU[e] === v ? eV[e] : eU[e];
      curveOf[e] = id; idxOf[e] = eTop - eoff; edges[eTop++] = e;
      if (closed) {
        const ne = nextEdge(u, e);
        if (ne === e0) break;
        nodes[nTop++] = u;
        if (ne < 0 || curveOf[ne] >= 0) { closed = false; break; }   // defensive
        v = u; e = ne;
      } else {
        nodes[nTop++] = u;
        if (terminal(u, e)) break;
        const ne = nextEdge(u, e);
        if (ne < 0 || curveOf[ne] >= 0) break;
        v = u; e = ne;
      }
    }
    cOff[id] = off; cEOff[id] = eoff; cN[id] = eTop - eoff;
    cClosed[id] = closed ? 1 : 0; cBorder[id] = eQ[edges[eoff]] < 0 ? 1 : 0;
  };
  for (let v = 0; v < NN; v++) {
    const d = deg[v];
    if (d === 0 || d === 2) continue;
    for (let k = st[v]; k < st[v + 1]; k++) {
      const e = inc[k];
      if (curveOf[e] < 0 && terminal(v, e)) chain(v, e, false);
    }
  }
  for (let e = 0; e < E; e++) if (curveOf[e] < 0) chain(eU[e], e, true);
  g.C = C;
  // Control points start on the node lattice (which also keeps the original
  // positions p̂: no copy needed).
  const cx = g.cx = new Float64Array(nTop), cy = g.cy = new Float64Array(nTop);
  for (let k = 0; k < nTop; k++) { cx[k] = X[nodes[k]] * 0.25; cy[k] = Y[nodes[k]] * 0.25; }
  g.cEx = new Uint8Array(nTop);
  attachCurves(g);
}

// A curve that ends on a T-junction is attached to the curve passing through
// it, so that its end follows that curve exactly.
function attachCurves(g) {
  const C = g.C, deg = g.bdeg, j1 = g.join1, j2 = g.join2, curveOf = g.curveOf, idxOf = g.idxOf;
  const cOff = g.cOff, cEOff = g.cEOff, cN = g.cN, nodes = g.cNodes, edges = g.cEdges;
  const att0 = g.att0 = new Int32Array(C).fill(-1), att1 = g.att1 = new Int32Array(C).fill(-1);
  const att0j = g.att0j = new Int32Array(C), att1j = g.att1j = new Int32Array(C);
  const attached = new List(Int32Array);
  for (let c = 0; c < C; c++) {
    if (g.cClosed[c] || g.cBorder[c]) continue;
    const off = cOff[c], n = cN[c], eoff = cEOff[c];
    for (let end = 0; end < 2; end++) {
      const v = end ? nodes[off + n] : nodes[off];
      if (deg[v] !== 3 || j1[v] < 0) continue;
      const e = end ? edges[eoff + n - 1] : edges[eoff];
      if (e === j1[v] || e === j2[v]) continue;
      const h = curveOf[j1[v]];
      if (g.cBorder[h]) continue;
      const je = idxOf[j1[v]];
      let jn = nodes[cOff[h] + je] === v ? je : je + 1;
      if (g.cClosed[h] && jn === cN[h]) jn = 0;
      if (end) { att1[c] = h; att1j[c] = jn; } else { att0[c] = h; att0j[c] = jn; }
    }
    if (att0[c] >= 0 || att1[c] >= 0) attached.push(c);
  }
  g.attached = attached.view();
}

/** Marks the control points that lie inside a corner pattern (Fig. 7). */
function detectCorners(g) {
  const X = g.nodeX, Y = g.nodeY, { pats, start, items } = CORNER;
  for (let c = 0; c < g.C; c++) {
    if (g.cBorder[c]) continue;
    const closed = g.cClosed[c] === 1, M = g.cN[c] + (closed ? 0 : 1), off = g.cOff[c];
    const nodes = g.cNodes.subarray(off, off + M), ex = g.cEx.subarray(off, off + M);
    const sEnd = closed ? M : M - 1;
    for (let s = 0; s < sEnd; s++) {
      const n0 = nodes[s], n1 = nodes[s + 1 === M ? 0 : s + 1], x0 = X[n0], y0 = Y[n0];
      const b = cornerKey(x0, y0, X[n1] - x0, Y[n1] - y0);
      if (b < 0) continue;
      for (let t = start[b]; t < start[b + 1]; t++) {
        const pat = pats[items[t]], L = pat.length >> 1;
        if (L > M || (!closed && s + L > M)) continue;
        const ox = x0 - pat[0], oy = y0 - pat[1];   // points 0 and 1 match by the bucket key
        let k = 2;
        for (; k < L; k++) {
          let idx = s + k; if (idx >= M) idx -= M;
          if (X[nodes[idx]] - pat[2 * k] !== ox || Y[nodes[idx]] - pat[2 * k + 1] !== oy) break;
        }
        if (k === L) for (let q = 1; q < L - 1; q++) { let idx = s + q; if (idx >= M) idx -= M; ex[idx] = 1; }
      }
    }
  }
}

// ============================================================================
// 5. Curve geometry and optimisation (paper §3.4)
// Control points P0..Pn for an open curve with n edges (P0, Pn sit on
// junctions), P0..P(n−1) for a closed one. The quadratic B-spline is split
// into one Bézier segment per interior control point s: A_s → (P_s) → C_s.
// Every control point k also has a "node point" Q_k on the curve; the piece
// of curve between Q_k and Q_(k+1) belongs to edge k, which is what lets two
// regions share the same geometry for the same edge.
// ============================================================================
function segA(g, c, s, o) {
  const x = g.cx, y = g.cy, b = g.cOff[c];
  if (!g.cClosed[c] && s === 1) { o[0] = x[b]; o[1] = y[b]; return; }
  const p = s === 0 ? g.cN[c] - 1 : s - 1;
  o[0] = (x[b + p] + x[b + s]) * 0.5; o[1] = (y[b + p] + y[b + s]) * 0.5;
}
function segC(g, c, s, o) {
  const x = g.cx, y = g.cy, b = g.cOff[c], n = g.cN[c];
  if (!g.cClosed[c] && s === n - 1) { o[0] = x[b + n]; o[1] = y[b + n]; return; }
  const q = s === n - 1 ? 0 : s + 1;
  o[0] = (x[b + s] + x[b + q]) * 0.5; o[1] = (y[b + s] + y[b + q]) * 0.5;
}
const _A = new Float64Array(2), _C = new Float64Array(2);
function nodePt(g, c, k, o) {
  const x = g.cx, y = g.cy, b = g.cOff[c], n = g.cN[c];
  if (g.cBorder[c] || (!g.cClosed[c] && (k === 0 || k === n))) { o[0] = x[b + k]; o[1] = y[b + k]; return; }
  segA(g, c, k, _A); segC(g, c, k, _C);
  o[0] = (_A[0] + 2 * x[b + k] + _C[0]) * 0.25;
  o[1] = (_A[1] + 2 * y[b + k] + _C[1]) * 0.25;
}

// Energy of control point i of the curve at offset `off` (paper eq. 2–4):
// smoothness of the three segments it influences (corner-pattern segments
// excluded) + |p − p̂|⁴. Returns early with some value ≥ bound once the
// (non-decreasing) partial sum reaches it — same decision, less work.
function nodeEnergy(g, off, n, closed, i, bound) {
  const x = g.cx, y = g.cy, ex = g.cEx, p = off + i, v = g.cNodes[p];
  const dx = x[p] - g.nodeX[v] * 0.25, dy = y[p] - g.nodeY[v] * 0.25, d2 = dx * dx + dy * dy, d4 = d2 * d2;
  if (d4 >= bound) return d4;
  let E = 0;
  if (closed) {
    for (let d = -1; d <= 1; d++) {
      let j = i + d; if (j < 0) j += n; else if (j >= n) j -= n;
      if (ex[off + j]) continue;
      E += turn(x, y, off + (j === 0 ? n - 1 : j - 1), off + j, off + (j === n - 1 ? 0 : j + 1));
      if (E >= bound) return E;
    }
  } else {
    const lo = i > 1 ? i - 1 : 1, hi = i < n - 1 ? i + 1 : n - 1;
    for (let j = lo; j <= hi; j++) {
      if (ex[off + j]) continue;
      E += turn(x, y, off + j - 1, off + j, off + j + 1);
      if (E >= bound) return E;
    }
  }
  return E + d4;
}

/** Curves whose control points are optimised (not on the image border, ≥ 1 movable point). */
function liveCurves(g) {
  const live = new List(Int32Array);
  for (let c = 0; c < g.C; c++) if (!g.cBorder[c] && (g.cClosed[c] ? g.cN[c] >= 3 : g.cN[c] >= 2)) live.push(c);
  return live.view();
}

function optimize(g, o) {
  const iters = o.iterations, guesses = o.guesses, reach = o.guessOffset;
  if (!iters || !guesses || !(reach > 0)) return;
  const rand = mulberry32(o.seed);
  const curves = liveCurves(g), x = g.cx, y = g.cy;
  for (let it = 0; it < iters; it++) {
    updateAttachments(g);
    for (let ci = 0; ci < curves.length; ci++) {
      const c = curves[ci], off = g.cOff[c], n = g.cN[c], closed = g.cClosed[c] === 1;
      for (let i = closed ? 0 : 1; i < n; i++) {
        const p = off + i, x0 = x[p], y0 = y[p];
        let best = nodeEnergy(g, off, n, closed, i, Infinity), bx = x0, by = y0;
        for (let k = 0; k < guesses; k++) {
          const r = rand() * reach, d = (rand() * 256) | 0;
          x[p] = x0 + r * DIR_X[d]; y[p] = y0 + r * DIR_Y[d];
          const e = nodeEnergy(g, off, n, closed, i, best);
          if (e < best) { best = e; bx = x[p]; by = y[p]; }
        }
        x[p] = bx; y[p] = by;
      }
    }
  }
}

// ---- Fast mode (smooth: 'fast') ------------------------------------------------
// A deterministic pattern search on the same energy instead of random guesses.
// One visit scores four positions of a node — where it is (lane 0) and three
// trial moves 120° apart (lanes 1–3) — which is exactly one f32x4 vector in the
// SIMD build. The best strict improvement wins (lowest lane on ties); otherwise
// the step halves, and once the smallest step fails the node sleeps until a
// node next to it moves. Odd sweeps turn the pattern by 60°, so two visits
// probe six directions. Steps are 2g, g, g/2 (g = guessOffset); a woken node
// restarts at g. Everything is IEEE f32 in coordinates relative to the
// node (small numbers, full precision); the Rust scalar and SIMD kernels
// reproduce it bit for bit.
const FAST_LEVELS = 3, FAST_WAKE = 2;    // state byte: 0 asleep, s = 1..3 awake with step STEP[s]
const R3 = Math.fround(0.8660254037844386);                     // √3 / 2
const PAT_X = new Float32Array([1, -0.5, -0.5, 0.5, -1, 0.5]);  // pattern 0: 0°, 120°, 240°
const PAT_Y = new Float32Array([0, R3, -R3, R3, 0, -R3]);       // pattern 1: 60°, 180°, 300°

// One visit of the fast mode: the energy of the node at four positions —
// lane 0 where it is, lanes 1–3 moved by h in the directions of pattern `pat`
// — and the winner: the lowest strictly better lane, 0 if none. Inputs in
// F[0..10], all f32 values relative to the node: a1 / b1 = previous / next
// node, ul = edge into a1, vr = edge out of b1, home = lattice position, h;
// t = active turning angles (bit 0 at the previous node, bit 1 here, bit 2 at
// the next). The winner's offset is left in F[11], F[12]. Sum order: angles
// i−1, i, i+1, then |d|⁴; a lane stops early once its (non-decreasing)
// partial sum reaches the best so far — same decision as the full sum.
function fastVisit(F, t, pat) {
  const a1x = F[0], a1y = F[1], b1x = F[2], b1y = F[3], ulx = F[4], uly = F[5],
        vrx = F[6], vry = F[7], hx = F[8], hy = F[9], h = F[10];
  let best = Infinity, won = 0;
  for (let k = 0; k < 4; k++) {
    let ox = 0, oy = 0;
    if (k) { ox = f32(h * PAT_X[pat + k - 1]); oy = f32(h * PAT_Y[pat + k - 1]); }
    const dx = f32(ox - hx), dy = f32(oy - hy), d2 = f32(f32(dx * dx) + f32(dy * dy)), d4 = f32(d2 * d2);
    if (d4 >= best) continue;
    const ax = f32(ox - a1x), ay = f32(oy - a1y), bx = f32(b1x - ox), by = f32(b1y - oy);
    let E = 0, j = 0;
    for (; j < 3; j++) {               // one absAngle32 call site, so V8 inlines it
      if (!((t >> j) & 1)) continue;
      let cr, dt;
      if (j === 0) { cr = f32(f32(ulx * ay) - f32(uly * ax)); dt = f32(f32(ulx * ax) + f32(uly * ay)); }
      else if (j === 1) { cr = f32(f32(ax * by) - f32(ay * bx)); dt = f32(f32(ax * bx) + f32(ay * by)); }
      else { cr = f32(f32(bx * vry) - f32(by * vrx)); dt = f32(f32(bx * vrx) + f32(by * vry)); }
      E = f32(E + absAngle32(cr, dt));
      if (E >= best) break;
    }
    if (j < 3) continue;
    E = f32(E + d4);
    if (E < best) { best = E; won = k; F[11] = ox; F[12] = oy; }
  }
  return won;
}

function optimizeFast(g, o) {
  const sweeps = o.iterations, g0 = Math.min(o.guessOffset, 1000);
  if (!sweeps || !(g0 > 0)) return;
  const x = g.cx, y = g.cy, ex = g.cEx, X = g.nodeX, Y = g.nodeY, nodes = g.cNodes, att = g.attached;
  const STEP = new Float32Array(FAST_LEVELS + 1);   // stores round to f32
  for (let s = 1; s <= FAST_LEVELS; s++) STEP[s] = (2 * g0) / (1 << (s - 1));
  const live = liveCurves(g), isLive = new Uint8Array(g.C), state = new Uint8Array(x.length), F = new Float64Array(13);
  for (let ci = 0; ci < live.length; ci++) {
    const c = live[ci], off = g.cOff[c], n = g.cN[c];
    isLive[c] = 1;
    for (let i = g.cClosed[c] ? 0 : 1; i < n; i++) state[off + i] = 1;
  }
  let visits = 0, s = 0;
  for (; s < sweeps; s++) {
    // T-junction ends follow the curves they sit on; wake the two nodes next
    // to an end that moved.
    for (let k = 0; k < att.length; k++) {
      const c = att[k], off = g.cOff[c], n = g.cN[c], e = off + n;
      const x0 = x[off], y0 = y[off], x1 = x[e], y1 = y[e];
      updateOne(g, c);
      if (!isLive[c]) continue;
      if (x[off] !== x0 || y[off] !== y0) { wake(state, off + 1); if (n > 2) wake(state, off + 2); }
      if (x[e] !== x1 || y[e] !== y1) { wake(state, e - 1); if (n > 2) wake(state, e - 2); }
    }
    let awake = false;
    const pat = (s & 1) * 3;
    for (let ci = 0; ci < live.length; ci++) {
      const c = live[ci], off = g.cOff[c], n = g.cN[c], closed = g.cClosed[c] === 1;
      for (let i = closed ? 0 : 1; i < n; i++) {
        const p = off + i, st = state[p];
        if (st === 0) continue;
        awake = true; visits++;
        let im1 = i - 1, im2 = i - 2, ip1 = i + 1, ip2 = i + 2;
        if (closed) { if (im1 < 0) im1 += n; if (im2 < 0) im2 += n; if (ip1 >= n) ip1 -= n; if (ip2 >= n) ip2 -= n; }
        const A1 = off + im1, B1 = off + ip1;
        // which of the three turning angles count: bit 0 at i−1, bit 1 at i, bit 2 at i+1
        let t = ex[p] ? 0 : 2;
        if ((closed || i > 1) && !ex[A1]) t |= 1;
        if ((closed || i < n - 1) && !ex[B1]) t |= 4;
        const x0 = x[p], y0 = y[p], v = nodes[p];
        F[0] = f32(x[A1] - x0); F[1] = f32(y[A1] - y0); F[2] = f32(x[B1] - x0); F[3] = f32(y[B1] - y0);
        if (t & 1) { const A2 = off + im2; F[4] = f32(x[A1] - x[A2]); F[5] = f32(y[A1] - y[A2]); }
        if (t & 4) { const B2 = off + ip2; F[6] = f32(x[B2] - x[B1]); F[7] = f32(y[B2] - y[B1]); }
        F[8] = f32(X[v] * 0.25 - x0); F[9] = f32(Y[v] * 0.25 - y0); F[10] = STEP[st];
        if (fastVisit(F, t, pat)) {
          x[p] = x0 + F[11]; y[p] = y0 + F[12];
          if (closed) { wake(state, off + im2); wake(state, A1); wake(state, B1); wake(state, off + ip2); }
          else for (let j = i > 2 ? i - 2 : 1, je = i + 2 < n ? i + 2 : n - 1; j <= je; j++) wake(state, off + j);
        } else state[p] = st < FAST_LEVELS ? st + 1 : 0;
      }
    }
    if (!awake) break;
  }
  g.relaxVisits = visits; g.relaxSweeps = s;
}
function wake(state, p) { if (state[p] === 0) state[p] = FAST_WAKE; }
function updateOne(g, c) {
  const x = g.cx, y = g.cy, off = g.cOff[c], T = _T;
  if (g.att0[c] >= 0) { nodePt(g, g.att0[c], g.att0j[c], T); x[off] = T[0]; y[off] = T[1]; }
  if (g.att1[c] >= 0) { const p = off + g.cN[c]; nodePt(g, g.att1[c], g.att1j[c], T); x[p] = T[0]; y[p] = T[1]; }
}

const _T = new Float64Array(2);
function updateAttachments(g) {
  const at = g.attached, x = g.cx, y = g.cy, T = _T;
  let delta = 0;
  for (let k = 0; k < at.length; k++) {
    const c = at[k], off = g.cOff[c];
    if (g.att0[c] >= 0) {
      nodePt(g, g.att0[c], g.att0j[c], T);
      delta = Math.max(delta, Math.abs(T[0] - x[off]) + Math.abs(T[1] - y[off]));
      x[off] = T[0]; y[off] = T[1];
    }
    if (g.att1[c] >= 0) {
      const p = off + g.cN[c];
      nodePt(g, g.att1[c], g.att1j[c], T);
      delta = Math.max(delta, Math.abs(T[0] - x[p]) + Math.abs(T[1] - y[p]));
      x[p] = T[0]; y[p] = T[1];
    }
  }
  return delta;
}

// Settle attachments and compute the rendered position of every node.
function finalize(g) {
  for (let p = 0; p < 64; p++) if (updateAttachments(g) < 1e-12) break;
  const NN = g.nodeCount, X = g.nodeX, Y = g.nodeY;
  const qx = g.qx = new Float64Array(NN), qy = g.qy = new Float64Array(NN);
  for (let v = 0; v < NN; v++) { qx[v] = X[v] * 0.25; qy[v] = Y[v] * 0.25; }
  for (let c = 0; c < g.C; c++) {
    const off = g.cOff[c], M = g.cN[c] + (g.cClosed[c] ? 0 : 1);
    for (let k = 0; k < M; k++) { nodePt(g, c, k, _T); qx[g.cNodes[off + k]] = _T[0]; qy[g.cNodes[off + k]] = _T[1]; }
  }
}

// ============================================================================
// 6. SVG
// The document is written as bytes into one growable buffer. Geometry is in
// pixel units (viewBox = image size; width/height = size × scale), rounded to
// `precision` decimals; paths use relative commands between rounded points,
// so shared curves stay exact and numbers stay small.
// ============================================================================
// 10^0 … 10^8: path numbers use up to MAX_PRECISION + 2 decimals (¼ grid steps).
const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];

/** Growable ASCII byte buffer with number formatting. */
class ByteWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.n = 0; this.tmp = new Uint8Array(24); }
  reserve(k) { if (this.n + k > this.buf.length) this.buf = grow(this.buf, Math.max(this.buf.length * 2, this.n + k)); }
  byte(c) { if (this.n === this.buf.length) this.reserve(1); this.buf[this.n++] = c; }
  ascii(s) { this.reserve(s.length); for (let i = 0; i < s.length; i++) this.buf[this.n++] = s.charCodeAt(i); }
  /** Non-negative integer. */
  uint(v) {
    const t = this.tmp;
    let i = 24;
    do { const q = Math.floor(v / 10); t[--i] = 48 + (v - q * 10); v = q; } while (v > 0);
    this.reserve(24 - i);
    while (i < 24) this.buf[this.n++] = t[i++];
  }
  /** Integer k as the decimal k·10^−p (trailing zeros dropped; `bare`: ".5" instead of "0.5"). */
  fixed(k, p, bare) {
    if (k < 0) { this.byte(45); k = -k; }
    const G = POW10[p];
    let ip = Math.floor(k / G), fp = k - ip * G;
    if (fp < 0) { ip--; fp += G; } else if (fp >= G) { ip++; fp -= G; }
    if (ip !== 0 || !bare || fp === 0) this.uint(ip);
    if (fp === 0) return;
    let d = p;
    while (fp % 10 === 0) { fp /= 10; d--; }
    this.reserve(d + 1);
    this.buf[this.n++] = 46;
    const t = this.tmp;
    for (let j = d - 1; j >= 0; j--) { const q = Math.floor(fp / 10); t[j] = 48 + (fp - q * 10); fp = q; }
    for (let j = 0; j < d; j++) this.buf[this.n++] = t[j];
  }
  hex(c) {
    const H = '0123456789abcdef';
    this.reserve(7);
    this.buf[this.n++] = 35;
    for (let sh = 20; sh >= 0; sh -= 4) this.buf[this.n++] = H.charCodeAt((c >> sh) & 15);
  }
  view() { return this.buf.subarray(0, this.n); }
}

/**
 * Path data on a ByteWriter. Points are rounded to the precision grid
 * (10^−p px); curve control points may fall on ½ or ¼ grid steps (see
 * `canonQuad`), so positions are kept as integers in "fine" units of ¼ step.
 * Absolute M per subpath, then relative h / v / l / q: deltas of rounded
 * points are exact, so nothing drifts. Minified syntax: implicit command
 * repetition, no leading zeros, separators only where needed.
 */
class PathEncoder {
  constructor(w, p) {
    this.w = w; this.p = p; this.G = POW10[p]; this.F = 4 * POW10[p];
    this.cmd = 0; this.fresh = false; this.dot = false;
    this.x = 0; this.y = 0; this.sx = 0; this.sy = 0;
  }
  begin() { this.cmd = 0; this.fresh = false; this.dot = false; }
  /** Fine units of the grid point nearest to v (pixels). */
  q(v) { return 4 * Math.round(v * this.G); }
  letter(c) { this.w.byte(c); this.cmd = c; this.fresh = true; }
  op(c) { if (this.cmd !== c) this.letter(c); }
  /** Number k (fine units) = k / (4·10^p) px = 25k·10^−(p+2). */
  num(k) {
    const a = k < 0 ? -k : k, frac = a % this.F !== 0, bareDot = frac && a < this.F;
    if (this.fresh) this.fresh = false;
    else if (!(k < 0) && !(bareDot && this.dot)) this.w.byte(32);
    this.w.fixed(k * 25, this.p + 2, true);
    this.dot = frac;
  }
  moveTo(fx, fy) {
    this.letter(77);                       // M (always explicit)
    this.num(fx); this.num(fy);
    this.x = this.sx = fx; this.y = this.sy = fy;
  }
  lineTo(fx, fy) {
    const dx = fx - this.x, dy = fy - this.y;
    if (dx === 0 && dy === 0) return;
    if (dy === 0) { this.op(104); this.num(dx); }                    // h
    else if (dx === 0) { this.op(118); this.num(dy); }               // v
    else { this.op(108); this.num(dx); this.num(dy); }               // l
    this.x = fx; this.y = fy;
  }
  quadTo(kx, ky, fx, fy) {
    const cx = this.x, cy = this.y;
    if (kx === cx && ky === cy && fx === cx && fy === cy) return;
    this.op(113);                                                    // q
    this.num(kx - cx); this.num(ky - cy); this.num(fx - cx); this.num(fy - cy);
    this.x = fx; this.y = fy;
  }
  close() { this.letter(122); this.x = this.sx; this.y = this.sy; }   // z
}

/** Coarsest decimal grid (in pixels) keeping every point within ¼ output pixel. */
function autoPrecision(scale) {
  let p = 0, t = 1;
  while (t < 2 * scale && p < MAX_PRECISION) { t *= 10; p++; }
  return p;
}

function hashId(g, key) {
  let h = 0x811c9dc5;
  const mix = v => { h ^= v; h = Math.imul(h, 0x01000193); };
  mix(g.w); mix(g.h);
  const k = g.key;
  for (let i = 0; i < k.length; i++) mix(k[i]);
  for (let i = 0; i < key.length; i++) mix(key.charCodeAt(i));
  return 'dpx' + (h >>> 0).toString(36) + '-';
}

function renderSvg(g, o) {
  const S = o.scale, sigma = o.shading, id = o.idPrefix || hashId(g, o.key);
  const out = new ByteWriter(4096 + g.E * 24 + g.N * 2), pe = new PathEncoder(out, o.precision);
  out.ascii('<svg xmlns="http://www.w3.org/2000/svg" width="');
  out.fixed(Math.round(g.w * S * 10), 1, false);
  out.ascii('" height="');
  out.fixed(Math.round(g.h * S * 10), 1, false);
  out.ascii('" viewBox="0 0 '); out.uint(g.w); out.byte(32); out.uint(g.h); out.ascii('">');

  const exact = !g.opaque;           // holes must be cut when something is see-through
  // Painter's order: by outer area, largest first (ties by region id).
  const order = new List(Int32Array);
  for (let r = 0; r < g.R; r++) if (g.rKind[r] !== 2) order.push(r);
  const byArea = order.view().sort((a, b) => g.rArea[b] - g.rArea[a] || a - b);

  // Multi-colour regions get smooth shading. Regions whose blurs cannot
  // interact share one mask + filter (a batch), which keeps the number of
  // offscreen layers small; a batch is painted at its last member's slot,
  // with holes cut, so painter's order stays valid.
  const batchOf = new Int32Array(g.R).fill(-1), batches = [];
  if (sigma > 0) {
    const D = Math.ceil(3 * sigma) + 2;
    for (let oi = 0; oi < byArea.length; oi++) {
      const r = byArea[oi];
      if (!g.rMulti[r] || g.rKind[r] !== 0) continue;
      const bb = regionBox(g, r);
      let b = 0;
      for (; b < batches.length; b++) {
        const boxes = batches[b].boxes;
        let ok = true;
        for (let q = 0; q < boxes.length; q += 4) {
          if (bb[0] - D <= boxes[q + 2] && boxes[q] <= bb[2] + D && bb[1] - D <= boxes[q + 3] && boxes[q + 1] <= bb[3] + D) { ok = false; break; }
        }
        if (ok) break;
      }
      if (b === batches.length) batches.push({ members: [], boxes: [], last: -1 });
      const B = batches[b];
      B.members.push(r); B.boxes.push(bb[0], bb[1], bb[2], bb[3]); B.last = oi;
      batchOf[r] = b;
    }
    if (batches.length) {
      out.ascii('<defs><filter id="'); out.ascii(id);
      out.ascii('f" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="');
      out.fixed(Math.round(sigma * 1000), 3, false);
      out.ascii('"/><feComponentTransfer><feFuncA type="linear" slope="40"/></feComponentTransfer></filter></defs>');
    }
  }
  // Every opaque fill is also stroked with its own colour, ~1.2 screen pixels
  // wide at any zoom (non-scaling stroke): a region painted later then covers
  // the anti-aliased seam of the one below, so no background shows through.
  out.ascii('<g stroke-width="1.2" stroke-linejoin="round"'); if (exact) out.ascii(' fill-rule="evenodd"'); out.ascii('>');
  const scratch = new LoopScratch();
  for (let oi = 0; oi < byArea.length; oi++) {
    const r = byArea[oi];
    if (batchOf[r] >= 0) {
      const B = batches[batchOf[r]];
      if (B.last === oi) smoothBatch(g, out, pe, scratch, B, id, batchOf[r]);
      continue;
    }
    if (g.rMulti[r]) { cellRegion(g, out, pe, r); continue; }
    const p0 = g.rPix[g.rStart[r]];
    paint(out, g.rgb[p0], g.alpha[p0]);
    out.ascii(' d="'); pe.begin(); regionPath(g, pe, scratch, r, exact); out.ascii('"/>');
  }
  out.ascii('</g></svg>');
  return out.view();
}

/** Opening of a <path> filled (and seam-stroked) with one colour. */
function paint(out, rgb, a) {
  out.ascii('<path fill="'); out.hex(rgb);
  if (a === 255) { out.ascii('" stroke="'); out.hex(rgb); out.ascii('" vector-effect="non-scaling-stroke"'); }
  else { out.ascii('" fill-opacity="'); out.fixed(Math.round(a / 2.55), 2, false); out.byte(34); }
}

function regionBox(g, r) {
  const w = g.w, pix = g.rPix;
  let x0 = w, y0 = g.h, x1 = 0, y1 = 0;
  for (let p = g.rStart[r]; p < g.rStart[r + 1]; p++) {
    const i = pix[p], x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function regionPath(g, pe, scratch, r, exact) {
  for (let t = g.rLoopStart[r]; t < g.rLoopStart[r + 1]; t++) {
    const l = g.rLoops[t];
    if (exact || g.loopArea[l] > 0) loopPath(g, pe, scratch, l);
  }
}

// Smooth multi-colour regions: the pixels are blurred and renormalised (an
// edge-aware Gaussian interpolation, since only the region's own pixels
// contribute) and masked by the region outline. The mask is stroked so the
// region slightly overlaps whatever was painted before it (no seams). Pixels
// are drawn as horizontal runs, one path per colour.
function smoothBatch(g, out, pe, scratch, B, id, b) {
  const w = g.w, pix = g.rPix, rgb = g.rgb;
  out.ascii('<mask id="'); out.ascii(id); out.byte(109); out.uint(b);
  out.ascii('"><path fill="#fff" stroke="#fff" vector-effect="non-scaling-stroke" fill-rule="evenodd" d="');
  pe.begin();
  for (const r of B.members) regionPath(g, pe, scratch, r, true);
  out.ascii('"/></mask><g mask="url(#'); out.ascii(id); out.byte(109); out.uint(b);
  out.ascii(')"><g filter="url(#'); out.ascii(id); out.ascii('f)" stroke="none">');
  let x0 = w, y0 = g.h, x1 = 0, y1 = 0;
  const bx = B.boxes;
  for (let q = 0; q < bx.length; q += 4) {
    if (bx[q] < x0) x0 = bx[q]; if (bx[q + 1] < y0) y0 = bx[q + 1];
    if (bx[q + 2] > x1) x1 = bx[q + 2]; if (bx[q + 3] > y1) y1 = bx[q + 3];
  }
  // Invisible margin: makes the filter and mask regions cover the outlines.
  out.ascii('<rect x="'); out.fixed(x0 - 2, 0, false); out.ascii('" y="'); out.fixed(y0 - 2, 0, false);
  out.ascii('" width="'); out.uint(x1 - x0 + 5); out.ascii('" height="'); out.uint(y1 - y0 + 5); out.ascii('" fill="none"/>');
  // Runs of equal colour per row, grouped by colour (stable).
  const runC = new List(Uint32Array), runX = new List(Int32Array), runY = new List(Int32Array), runL = new List(Int32Array);
  for (const r of B.members) {
    const a = g.rStart[r], e = g.rStart[r + 1];
    for (let p = a; p < e;) {
      const i = pix[p], c = rgb[i], y = (i / w) | 0;
      let q = p + 1;
      while (q < e && pix[q] === pix[q - 1] + 1 && rgb[pix[q]] === c && ((pix[q] / w) | 0) === y) q++;
      runC.push(c); runX.push(i % w); runY.push(y); runL.push(q - p);
      p = q;
    }
  }
  const nr = runC.n, rc = runC.a, rx = runX.a, ry = runY.a, rl = runL.a;
  const sorted = new Int32Array(nr);
  for (let k = 0; k < nr; k++) sorted[k] = k;
  sorted.sort((u, v) => rc[u] - rc[v] || u - v);
  for (let k = 0; k < nr;) {
    const c = rc[sorted[k]];
    out.ascii('<path fill="'); out.hex(c); out.ascii('" d="');
    pe.begin();
    for (; k < nr && rc[sorted[k]] === c; k++) {
      const t = sorted[k], F = pe.F, x = rx[t] * F, y = ry[t] * F, len = rl[t] * F;
      pe.moveTo(x, y); pe.lineTo(x + len, y); pe.lineTo(x + len, y + F); pe.lineTo(x, y + F); pe.close();
    }
    out.ascii('"/>');
  }
  out.ascii('</g></g>');
}

// Multi-colour region, flat: every pixel cell is drawn, with its visible
// edges replaced by the shared curve pieces.
function cellRegion(g, out, pe, r) {
  for (let p = g.rStart[r]; p < g.rStart[r + 1]; p++) {
    const i = g.rPix[p];
    paint(out, g.rgb[i], g.alpha[i]);
    out.ascii(' d="'); pe.begin(); cellPath(g, pe, i); out.ascii('"/>');
  }
}

function cellPath(g, pe, i) {
  const base = i * 8, n = g.cellN[i], V = g.cellV, EO = g.edgeOf, qx = g.qx, qy = g.qy;
  pe.moveTo(pe.q(qx[V[base]]), pe.q(qy[V[base]]));
  for (let k = 0; k < n; k++) {
    const s = base + k, e = EO[s];
    if (e < 0) {
      const v1 = V[base + (k + 1 === n ? 0 : k + 1)];
      pe.lineTo(pe.q(qx[v1]), pe.q(qy[v1]));
      continue;
    }
    const c = g.curveOf[e], j = g.idxOf[e], d = V[s] === g.cNodes[g.cOff[c] + j] ? 1 : -1;
    let a = d > 0 ? j : j + 1;
    if (g.cClosed[c] && a === g.cN[c]) a = 0;
    curveRun(g, pe, c, a, 1, d);
  }
  pe.close();
}

/** Per-loop scratch for the half-edge → (curve, edge index, direction) mapping. */
class LoopScratch {
  constructor() { this.hc = new Int32Array(64); this.hj = new Int32Array(64); this.hd = new Int8Array(64); }
  ensure(m) {
    if (this.hc.length >= m) return;
    const cap = Math.max(m, this.hc.length * 2);
    this.hc = new Int32Array(cap); this.hj = new Int32Array(cap); this.hd = new Int8Array(cap);
  }
}

// Canonical rounded quad of control point s of curve c, in fine units:
// endpoints A_s, C_s and node point Q_s rounded to the grid, and the control
// point K = (4Q − A − C)/2 that makes the quad pass exactly through Q at its
// middle. Every region draws exact halves or wholes of this one quad, so
// shared edges and T-junctions (whose attached curve ends exactly at Q) stay
// watertight at any precision. Layout: ax ay cx cy qx qy kx ky.
const _K = new Float64Array(8);
function canonQuad(g, pe, c, s) {
  const K = _K;
  segA(g, c, s, _P); K[0] = pe.q(_P[0]); K[1] = pe.q(_P[1]);
  segC(g, c, s, _P); K[2] = pe.q(_P[0]); K[3] = pe.q(_P[1]);
  nodePt(g, c, s, _P); K[4] = pe.q(_P[0]); K[5] = pe.q(_P[1]);
  K[6] = (4 * K[4] - K[0] - K[2]) / 2; K[7] = (4 * K[5] - K[1] - K[3]) / 2;
  return K;
}
// Halves of the canonical quad (de Casteljau at t = ½).
function firstHalf(pe, K, rev) {         // A → Q (rev: Q → A)
  const kx = (K[0] + K[6]) / 2, ky = (K[1] + K[7]) / 2;
  if (rev) pe.quadTo(kx, ky, K[0], K[1]); else pe.quadTo(kx, ky, K[4], K[5]);
}
function secondHalf(pe, K, rev) {        // Q → C (rev: C → Q)
  const kx = (K[6] + K[2]) / 2, ky = (K[7] + K[3]) / 2;
  if (rev) pe.quadTo(kx, ky, K[4], K[5]); else pe.quadTo(kx, ky, K[2], K[3]);
}

// One boundary loop: a cyclic list of visible half-edges, emitted as runs
// along the shared curves.
const _P = new Float64Array(2);
function loopPath(g, pe, sc, l) {
  const slots = g.loopSlots.subarray(g.loopStart[l], g.loopStart[l + 1]), m = slots.length;
  const EO = g.edgeOf, CO = g.curveOf, IO = g.idxOf, V = g.cellV, nodes = g.cNodes, cOff = g.cOff;
  sc.ensure(m);
  const hc = sc.hc, hj = sc.hj, hd = sc.hd;
  for (let t = 0; t < m; t++) {
    const s = slots[t], e = EO[s], c = CO[e], j = IO[e];
    hc[t] = c; hj[t] = j; hd[t] = V[s] === nodes[cOff[c] + j] ? 1 : -1;
  }
  const cont = (a, b) => {
    if (hc[a] !== hc[b] || hd[a] !== hd[b]) return false;
    const c = hc[a], n = g.cN[c];
    let j = hj[a] + hd[a];
    if (g.cClosed[c]) { if (j < 0) j += n; else if (j >= n) j -= n; }
    return j === hj[b];
  };
  let s0 = -1;
  for (let t = 0; t < m; t++) if (!cont(t === 0 ? m - 1 : t - 1, t)) { s0 = t; break; }
  if (s0 < 0) { fullCurve(g, pe, hc[0]); return; }
  let t = s0, first = true;
  do {
    let cnt = 1;
    while (cnt < m) {
      const b = (t + cnt) % m;
      if (b === s0 || !cont((t + cnt - 1) % m, b)) break;
      cnt++;
    }
    const c = hc[t], d = hd[t];
    let a0 = d > 0 ? hj[t] : hj[t] + 1;
    if (g.cClosed[c] && a0 === g.cN[c]) a0 = 0;
    if (first) { nodePt(g, c, a0, _P); pe.moveTo(pe.q(_P[0]), pe.q(_P[1])); first = false; }
    curveRun(g, pe, c, a0, cnt, d);
    t = (t + cnt) % m;
  } while (t !== s0);
  pe.close();
}

// A loop made of one complete closed curve.
function fullCurve(g, pe, c) {
  const x = g.cx, y = g.cy, b = g.cOff[c], n = g.cN[c];
  if (g.cBorder[c]) {
    pe.moveTo(pe.q(x[b]), pe.q(y[b]));
    curveRun(g, pe, c, 0, n, 1);
    pe.close();
    return;
  }
  segA(g, c, 0, _P);
  pe.moveTo(pe.q(_P[0]), pe.q(_P[1]));
  for (let s = 0; s < n; s++) { const K = canonQuad(g, pe, c, s); pe.quadTo(K[6], K[7], K[2], K[3]); }
  pe.close();
}

// Emit `cnt` edges of curve c starting at control point a, direction d (±1).
// Edge k runs from Q_k to Q_(k+1): the second half of quad k, then the first
// half of quad k+1 — so a run is half a quad, whole quads, half a quad.
function curveRun(g, pe, c, a, cnt, d) {
  const x = g.cx, y = g.cy, b = g.cOff[c], n = g.cN[c], closed = g.cClosed[c] === 1, M = n + (closed ? 0 : 1);
  if (g.cBorder[c] || (!closed && n === 1)) {
    // Straight pieces (image frame, or a single edge between two junctions);
    // collinear points are merged.
    let lx = x[b + a], ly = y[b + a], px = lx, py = ly, has = false;
    for (let t = 1; t <= cnt; t++) {
      let k = a + d * t;
      if (closed) { k %= M; if (k < 0) k += M; }
      const qx = x[b + k], qy = y[b + k];
      if (has && Math.abs((px - lx) * (qy - py) - (py - ly) * (qx - px)) > 1e-9) {
        pe.lineTo(pe.q(px), pe.q(py)); lx = px; ly = py;
      }
      px = qx; py = qy; has = true;
    }
    if (has) pe.lineTo(pe.q(px), pe.q(py));
    return;
  }
  const has = s => closed || (s >= 1 && s <= n - 1);
  const wrap = s => closed ? ((s % n) + n) % n : s;
  if (d > 0) {
    if (has(a)) secondHalf(pe, canonQuad(g, pe, c, wrap(a)), false);
    for (let t = 1; t < cnt; t++) { const K = canonQuad(g, pe, c, wrap(a + t)); pe.quadTo(K[6], K[7], K[2], K[3]); }
    if (has(a + cnt)) firstHalf(pe, canonQuad(g, pe, c, wrap(a + cnt)), false);
  } else {
    if (has(a)) firstHalf(pe, canonQuad(g, pe, c, wrap(a)), true);
    for (let t = 1; t < cnt; t++) { const K = canonQuad(g, pe, c, wrap(a - t)); pe.quadTo(K[6], K[7], K[0], K[1]); }
    if (has(a - cnt)) secondHalf(pe, canonQuad(g, pe, c, wrap(a - cnt)), true);
  }
}

// ============================================================================
// Public API
// ============================================================================
/** Options with defaults applied and every value normalised (see the header). */
function normalize(opts = {}) {
  const o = {};
  for (const k in DEFAULTS) o[k] = opts[k] !== undefined && opts[k] !== null ? opts[k] : DEFAULTS[k];
  const scale = +o.scale > 0 ? Math.min(+o.scale, MAX_SCALE) : DEFAULTS.scale;
  const prec = o.precision === 'auto' ? autoPrecision(scale)
    : Math.min(MAX_PRECISION, Math.max(0, Math.trunc(+o.precision) || 0));
  return {
    key: [o.scale, o.mode, o.shading, o.smooth, o.iterations, o.guesses, o.guessOffset, o.seed, o.precision].join('|'),
    idPrefix: opts.idPrefix ? String(opts.idPrefix) : '',
    mode: o.mode === 'cell' || o.mode === 'shape' ? o.mode : 'auto',
    smooth: o.smooth === 'fast' ? 'fast' : o.smooth !== false,
    iterations: Math.max(0, o.iterations | 0),
    guesses: Math.max(0, o.guesses | 0),
    guessOffset: +o.guessOffset,
    seed: o.seed | 0,
    scale,
    shading: Math.min(1000, Math.max(0, +o.shading || 0)),
    precision: prec,
  };
}

/** Vectorizes `image` ({ width, height, data: RGBA or RGB bytes }); returns the SVG as UTF-8 bytes. */
function depixelizeBytes(image, opts) {
  const o = normalize(opts);
  return renderSvg(analyze(image.width, image.height, image.data, o), o);
}

let utf8 = null;
/** Vectorizes `image`; returns the SVG document as a string. */
function depixelize(image, opts) {
  const bytes = depixelizeBytes(image, opts);
  if (typeof TextDecoder !== 'undefined') return (utf8 || (utf8 = new TextDecoder())).decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { depixelize, depixelizeBytes, DEFAULTS, normalize, analyze, renderSvg, Graph };
}
if (typeof window !== 'undefined') { window.depixelize = depixelize; window.depixelizeBytes = depixelizeBytes; }
