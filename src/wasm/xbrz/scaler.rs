//! xBRZ blend tables (2x..8x) and the pre-rotated, stride-resolved form the
//! engine applies.
//!
//! For the canonical rotation (blend corner at the bottom-right of the N x N
//! destination block) each edge shape lists the destination cells it covers
//! and the coverage `M / N` to blend the new colour in with. 2x..6x are
//! Zenju's hand-derived tables; 7x and 8x extend the same cut geometry
//! (`tools/gen_xbrz_tables.py` reproduces every 2x..6x constant from it).
//!
//! Instead of monomorphising every scale x rotation x shape into straight-line
//! code (that was ~250 KB of wasm), each band resolves the tables once into
//! flat `(offset, weights)` lists for its output stride; applying a shape is
//! then a short loop. Gradients divide by the constant `N` with an exact
//! reciprocal multiply (see [`Entry::new`]).
//!
//! Pixels are `u32` in little-endian RGBA order (red in the low byte).

/// Edge shapes, in the order the engine indexes them.
pub(crate) const SHALLOW: usize = 0;
pub(crate) const STEEP: usize = 1;
pub(crate) const STEEP_AND_SHALLOW: usize = 2;
pub(crate) const DIAGONAL: usize = 3;
pub(crate) const CORNER: usize = 4;
pub(crate) const PATTERNS: usize = 5;

/// One canonical table cell: blend `m / n` into (row `i`, column `j`);
/// `n == 1` means overwrite with the colour (Zenju's `= col`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Cell {
    pub(crate) i: u8,
    pub(crate) j: u8,
    pub(crate) m: u8,
    pub(crate) n: u8,
}

const fn c(i: u8, j: u8, m: u8, n: u8) -> Cell {
    Cell { i, j, m, n }
}

// Generated from the verified 2x..8x blend tables (scaler.rs macros);
// each entry is (row, col, M, N): blend M/N of the colour into the cell,
// with N == 1 meaning "set" (overwrite with the colour verbatim).
const T2_SHALLOW: &[Cell] = &[c(1, 0, 1, 4), c(1, 1, 3, 4)];
const T2_STEEP: &[Cell] = &[c(0, 1, 1, 4), c(1, 1, 3, 4)];
const T2_STEEP_AND_SHALLOW: &[Cell] = &[c(1, 0, 1, 4), c(0, 1, 1, 4), c(1, 1, 5, 6)];
const T2_DIAGONAL: &[Cell] = &[c(1, 1, 1, 2)];
const T2_CORNER: &[Cell] = &[c(1, 1, 21, 100)];
const T3_SHALLOW: &[Cell] = &[c(2, 0, 1, 4), c(1, 2, 1, 4), c(2, 1, 3, 4), c(2, 2, 1, 1)];
const T3_STEEP: &[Cell] = &[c(0, 2, 1, 4), c(2, 1, 1, 4), c(1, 2, 3, 4), c(2, 2, 1, 1)];
const T3_STEEP_AND_SHALLOW: &[Cell] = &[c(2, 0, 1, 4), c(0, 2, 1, 4), c(2, 1, 3, 4), c(1, 2, 3, 4), c(2, 2, 1, 1)];
const T3_DIAGONAL: &[Cell] = &[c(1, 2, 1, 8), c(2, 1, 1, 8), c(2, 2, 7, 8)];
const T3_CORNER: &[Cell] = &[c(2, 2, 45, 100)];
const T4_SHALLOW: &[Cell] = &[c(3, 0, 1, 4), c(2, 2, 1, 4), c(3, 1, 3, 4), c(2, 3, 3, 4), c(3, 2, 1, 1), c(3, 3, 1, 1)];
const T4_STEEP: &[Cell] = &[c(0, 3, 1, 4), c(2, 2, 1, 4), c(1, 3, 3, 4), c(3, 2, 3, 4), c(2, 3, 1, 1), c(3, 3, 1, 1)];
const T4_STEEP_AND_SHALLOW: &[Cell] = &[c(3, 1, 3, 4), c(1, 3, 3, 4), c(3, 0, 1, 4), c(0, 3, 1, 4), c(2, 2, 1, 3), c(3, 3, 1, 1), c(3, 2, 1, 1), c(2, 3, 1, 1)];
const T4_DIAGONAL: &[Cell] = &[c(3, 2, 1, 2), c(2, 3, 1, 2), c(3, 3, 1, 1)];
const T4_CORNER: &[Cell] = &[c(3, 3, 68, 100), c(3, 2, 9, 100), c(2, 3, 9, 100)];
const T5_SHALLOW: &[Cell] = &[c(4, 0, 1, 4), c(3, 2, 1, 4), c(2, 4, 1, 4), c(4, 1, 3, 4), c(3, 3, 3, 4), c(4, 2, 1, 1), c(4, 3, 1, 1), c(4, 4, 1, 1), c(3, 4, 1, 1)];
const T5_STEEP: &[Cell] = &[c(0, 4, 1, 4), c(2, 3, 1, 4), c(4, 2, 1, 4), c(1, 4, 3, 4), c(3, 3, 3, 4), c(2, 4, 1, 1), c(3, 4, 1, 1), c(4, 4, 1, 1), c(4, 3, 1, 1)];
const T5_STEEP_AND_SHALLOW: &[Cell] = &[c(0, 4, 1, 4), c(2, 3, 1, 4), c(1, 4, 3, 4), c(4, 0, 1, 4), c(3, 2, 1, 4), c(4, 1, 3, 4), c(3, 3, 2, 3), c(2, 4, 1, 1), c(3, 4, 1, 1), c(4, 4, 1, 1), c(4, 2, 1, 1), c(4, 3, 1, 1)];
const T5_DIAGONAL: &[Cell] = &[c(4, 2, 1, 8), c(3, 3, 1, 8), c(2, 4, 1, 8), c(4, 3, 7, 8), c(3, 4, 7, 8), c(4, 4, 1, 1)];
const T5_CORNER: &[Cell] = &[c(4, 4, 86, 100), c(4, 3, 23, 100), c(3, 4, 23, 100)];
const T6_SHALLOW: &[Cell] = &[c(5, 0, 1, 4), c(4, 2, 1, 4), c(3, 4, 1, 4), c(5, 1, 3, 4), c(4, 3, 3, 4), c(3, 5, 3, 4), c(5, 2, 1, 1), c(5, 3, 1, 1), c(5, 4, 1, 1), c(5, 5, 1, 1), c(4, 4, 1, 1), c(4, 5, 1, 1)];
const T6_STEEP: &[Cell] = &[c(0, 5, 1, 4), c(2, 4, 1, 4), c(4, 3, 1, 4), c(1, 5, 3, 4), c(3, 4, 3, 4), c(5, 3, 3, 4), c(2, 5, 1, 1), c(3, 5, 1, 1), c(4, 5, 1, 1), c(5, 5, 1, 1), c(4, 4, 1, 1), c(5, 4, 1, 1)];
const T6_STEEP_AND_SHALLOW: &[Cell] = &[c(0, 5, 1, 4), c(2, 4, 1, 4), c(1, 5, 3, 4), c(3, 4, 3, 4), c(5, 0, 1, 4), c(4, 2, 1, 4), c(5, 1, 3, 4), c(4, 3, 3, 4), c(2, 5, 1, 1), c(3, 5, 1, 1), c(4, 5, 1, 1), c(5, 5, 1, 1), c(4, 4, 1, 1), c(5, 4, 1, 1), c(5, 2, 1, 1), c(5, 3, 1, 1)];
const T6_DIAGONAL: &[Cell] = &[c(5, 3, 1, 2), c(4, 4, 1, 2), c(3, 5, 1, 2), c(4, 5, 1, 1), c(5, 5, 1, 1), c(5, 4, 1, 1)];
const T6_CORNER: &[Cell] = &[c(5, 5, 97, 100), c(4, 5, 42, 100), c(5, 4, 42, 100), c(5, 3, 6, 100), c(3, 5, 6, 100)];
const T7_SHALLOW: &[Cell] = &[c(6, 0, 1, 4), c(5, 2, 1, 4), c(4, 4, 1, 4), c(3, 6, 1, 4), c(6, 1, 3, 4), c(5, 3, 3, 4), c(4, 5, 3, 4), c(6, 2, 1, 1), c(6, 3, 1, 1), c(6, 4, 1, 1), c(6, 5, 1, 1), c(6, 6, 1, 1), c(5, 4, 1, 1), c(5, 5, 1, 1), c(5, 6, 1, 1), c(4, 6, 1, 1)];
const T7_STEEP: &[Cell] = &[c(0, 6, 1, 4), c(2, 5, 1, 4), c(4, 4, 1, 4), c(6, 3, 1, 4), c(1, 6, 3, 4), c(3, 5, 3, 4), c(5, 4, 3, 4), c(2, 6, 1, 1), c(3, 6, 1, 1), c(4, 6, 1, 1), c(5, 6, 1, 1), c(6, 6, 1, 1), c(4, 5, 1, 1), c(5, 5, 1, 1), c(6, 5, 1, 1), c(6, 4, 1, 1)];
const T7_STEEP_AND_SHALLOW: &[Cell] = &[c(0, 6, 1, 4), c(2, 5, 1, 4), c(1, 6, 3, 4), c(3, 5, 3, 4), c(6, 0, 1, 4), c(5, 2, 1, 4), c(6, 1, 3, 4), c(5, 3, 3, 4), c(4, 4, 1, 3), c(2, 6, 1, 1), c(3, 6, 1, 1), c(4, 6, 1, 1), c(5, 6, 1, 1), c(6, 6, 1, 1), c(6, 2, 1, 1), c(6, 3, 1, 1), c(6, 4, 1, 1), c(6, 5, 1, 1), c(5, 4, 1, 1), c(5, 5, 1, 1), c(4, 5, 1, 1)];
const T7_DIAGONAL: &[Cell] = &[c(6, 3, 1, 8), c(5, 4, 1, 8), c(4, 5, 1, 8), c(3, 6, 1, 8), c(6, 4, 7, 8), c(5, 5, 7, 8), c(4, 6, 7, 8), c(6, 5, 1, 1), c(5, 6, 1, 1), c(6, 6, 1, 1)];
const T7_CORNER: &[Cell] = &[c(6, 6, 1, 1), c(6, 5, 65, 100), c(5, 6, 65, 100), c(6, 4, 16, 100), c(4, 6, 16, 100)];
const T8_SHALLOW: &[Cell] = &[c(7, 0, 1, 4), c(6, 2, 1, 4), c(5, 4, 1, 4), c(4, 6, 1, 4), c(7, 1, 3, 4), c(6, 3, 3, 4), c(5, 5, 3, 4), c(4, 7, 3, 4), c(7, 2, 1, 1), c(7, 3, 1, 1), c(7, 4, 1, 1), c(7, 5, 1, 1), c(7, 6, 1, 1), c(7, 7, 1, 1), c(6, 4, 1, 1), c(6, 5, 1, 1), c(6, 6, 1, 1), c(6, 7, 1, 1), c(5, 6, 1, 1), c(5, 7, 1, 1)];
const T8_STEEP: &[Cell] = &[c(0, 7, 1, 4), c(2, 6, 1, 4), c(4, 5, 1, 4), c(6, 4, 1, 4), c(1, 7, 3, 4), c(3, 6, 3, 4), c(5, 5, 3, 4), c(7, 4, 3, 4), c(2, 7, 1, 1), c(3, 7, 1, 1), c(4, 7, 1, 1), c(5, 7, 1, 1), c(6, 7, 1, 1), c(7, 7, 1, 1), c(4, 6, 1, 1), c(5, 6, 1, 1), c(6, 6, 1, 1), c(7, 6, 1, 1), c(6, 5, 1, 1), c(7, 5, 1, 1)];
const T8_STEEP_AND_SHALLOW: &[Cell] = &[c(0, 7, 1, 4), c(2, 6, 1, 4), c(4, 5, 1, 4), c(1, 7, 3, 4), c(3, 6, 3, 4), c(7, 0, 1, 4), c(6, 2, 1, 4), c(5, 4, 1, 4), c(7, 1, 3, 4), c(6, 3, 3, 4), c(5, 5, 5, 6), c(2, 7, 1, 1), c(3, 7, 1, 1), c(4, 7, 1, 1), c(5, 7, 1, 1), c(6, 7, 1, 1), c(7, 7, 1, 1), c(7, 2, 1, 1), c(7, 3, 1, 1), c(7, 4, 1, 1), c(7, 5, 1, 1), c(7, 6, 1, 1), c(6, 4, 1, 1), c(6, 5, 1, 1), c(6, 6, 1, 1), c(5, 6, 1, 1), c(4, 6, 1, 1)];
const T8_DIAGONAL: &[Cell] = &[c(7, 4, 1, 2), c(6, 5, 1, 2), c(5, 6, 1, 2), c(4, 7, 1, 2), c(7, 5, 1, 1), c(6, 6, 1, 1), c(5, 7, 1, 1), c(7, 6, 1, 1), c(6, 7, 1, 1), c(7, 7, 1, 1)];
const T8_CORNER: &[Cell] = &[c(7, 7, 1, 1), c(7, 6, 84, 100), c(6, 7, 84, 100), c(7, 5, 31, 100), c(5, 7, 31, 100), c(6, 6, 6, 100), c(7, 4, 4, 100), c(4, 7, 4, 100)];

/// Canonical tables indexed `[scale - 2][pattern]`.
pub(crate) const TABLES: [[&[Cell]; PATTERNS]; 7] = [
    [T2_SHALLOW, T2_STEEP, T2_STEEP_AND_SHALLOW, T2_DIAGONAL, T2_CORNER],
    [T3_SHALLOW, T3_STEEP, T3_STEEP_AND_SHALLOW, T3_DIAGONAL, T3_CORNER],
    [T4_SHALLOW, T4_STEEP, T4_STEEP_AND_SHALLOW, T4_DIAGONAL, T4_CORNER],
    [T5_SHALLOW, T5_STEEP, T5_STEEP_AND_SHALLOW, T5_DIAGONAL, T5_CORNER],
    [T6_SHALLOW, T6_STEEP, T6_STEEP_AND_SHALLOW, T6_DIAGONAL, T6_CORNER],
    [T7_SHALLOW, T7_STEEP, T7_STEEP_AND_SHALLOW, T7_DIAGONAL, T7_CORNER],
    [T8_SHALLOW, T8_STEEP, T8_STEEP_AND_SHALLOW, T8_DIAGONAL, T8_CORNER],
];

/// Real cell of canonical `(i, j)` under rotation `r` (multiples of 90 degrees
/// clockwise); Zenju's `MatrixRotation`: each step maps `(i, j) -> (n-1-j, i)`.
#[inline]
pub(crate) const fn rotate_index(i: usize, j: usize, n: usize, r: usize) -> (usize, usize) {
    match r & 3 {
        0 => (i, j),
        1 => (n - 1 - j, i),
        2 => (n - 1 - i, n - 1 - j),
        _ => (j, n - 1 - i),
    }
}

/// A table cell resolved for one rotation and output stride.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Entry {
    /// Offset from the block's top-left pixel.
    off: u32,
    /// Blend weights `m` and `n - m`; unused for a plain write.
    m: u32,
    nm: u32,
    /// `ceil(2^32 / n)`, or 0 for a plain write. For every numerator the
    /// gradient can produce (`v <= 255 * n`, `n <= 100`) the identity
    /// `(v * magic) >> 32 == v / n` holds exactly: the excess
    /// `v * (magic*n - 2^32) / (n * 2^32) < v / 2^32 < 1/n` never crosses an
    /// integer boundary. `tests::reciprocal_division_is_exact` checks it.
    magic: u32,
}

impl Entry {
    fn new(cell: Cell, n_block: usize, rot: usize, stride: usize) -> Self {
        let (i, j) = rotate_index(cell.i as usize, cell.j as usize, n_block, rot);
        let off = (i * stride + j) as u32;
        if cell.n == 1 {
            return Self { off, m: 0, nm: 0, magic: 0 };
        }
        let n = cell.n as u64;
        Self {
            off,
            m: cell.m as u32,
            nm: (cell.n - cell.m) as u32,
            magic: ((1u64 << 32) + n - 1).checked_div(n).unwrap() as u32,
        }
    }

    #[inline(always)]
    fn div(&self, v: u32) -> u32 {
        ((v as u64 * self.magic as u64) >> 32) as u32
    }

    /// Zenju's `gradientARGB(front, back)` with weight `m / n`:
    /// alpha-weighted mix, exact integer arithmetic.
    #[inline(always)]
    fn gradient(&self, front: u32, back: u32) -> u32 {
        let fa = front >> 24;
        let ba = back >> 24;
        if (fa & ba) == 255 {
            // Both opaque: the 255 weights cancel exactly.
            let ch = |s: u32| self.div(((front >> s) & 0xFF) * self.m + ((back >> s) & 0xFF) * self.nm);
            return ch(0) | (ch(8) << 8) | (ch(16) << 16) | 0xFF00_0000;
        }
        let wf = fa * self.m;
        let wb = ba * self.nm;
        let ws = wf + wb;
        if ws == 0 {
            return 0;
        }
        let alpha = self.div(ws) << 24;
        // One side fully transparent (sprite borders): the colour sum
        // collapses exactly to the other side's channels.
        if wb == 0 {
            return (front & 0x00FF_FFFF) | alpha;
        }
        if wf == 0 {
            return (back & 0x00FF_FFFF) | alpha;
        }
        let ch = |s: u32| (((front >> s) & 0xFF) * wf + ((back >> s) & 0xFF) * wb) / ws;
        ch(0) | (ch(8) << 8) | (ch(16) << 16) | alpha
    }
}

/// All shapes of one scale, resolved for every rotation and an output stride.
pub(crate) struct Prepared {
    entries: Vec<Entry>,
    /// `[pattern][rotation]` -> `(start, end)` into `entries`.
    ranges: [[(u16, u16); 4]; PATTERNS],
}

impl Prepared {
    pub(crate) fn new(n: usize, stride: usize) -> Self {
        assert!((2..=8).contains(&n) && stride >= n);
        let tables = &TABLES[n - 2];
        let mut entries = Vec::with_capacity(4 * tables.iter().map(|t| t.len()).sum::<usize>());
        let mut ranges = [[(0u16, 0u16); 4]; PATTERNS];
        for (p, cells) in tables.iter().enumerate() {
            for (rot, range) in ranges[p].iter_mut().enumerate() {
                let start = entries.len() as u16;
                entries.extend(cells.iter().map(|&cell| Entry::new(cell, n, rot, stride)));
                *range = (start, entries.len() as u16);
            }
        }
        Self { entries, ranges }
    }

    /// Blends `col` into the block with shape `pattern` under rotation `rot`.
    /// `block` must span `(n - 1) * stride + n` pixels from the block origin.
    #[inline(always)]
    pub(crate) fn apply(&self, pattern: usize, rot: usize, block: &mut [u32], col: u32) {
        let (s, e) = self.ranges[pattern][rot & 3];
        for en in &self.entries[s as usize..e as usize] {
            debug_assert!((en.off as usize) < block.len());
            // SAFETY: off = i * stride + j with i, j < n, and the caller passes
            // a block spanning (n - 1) * stride + n cells.
            let dst = unsafe { block.get_unchecked_mut(en.off as usize) };
            *dst = if en.magic == 0 { col } else { en.gradient(col, *dst) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference `gradient_rgba` of the original port, with compile-time-free
    /// integer division, as the oracle.
    fn oracle(front: u32, back: u32, m: u32, n: u32) -> u32 {
        let (fa, ba) = (front >> 24, back >> 24);
        if fa == 255 && ba == 255 {
            let ch = |s: u32| (((front >> s) & 0xFF) * m + ((back >> s) & 0xFF) * (n - m)) / n;
            return ch(0) | ch(8) << 8 | ch(16) << 16 | 0xFF00_0000;
        }
        let wf = fa * m;
        let wb = ba * (n - m);
        let ws = wf + wb;
        if ws == 0 {
            return 0;
        }
        let ch = |s: u32| (((front >> s) & 0xFF) * wf + ((back >> s) & 0xFF) * wb) / ws;
        ch(0) | ch(8) << 8 | ch(16) << 16 | (ws / n) << 24
    }

    fn weights() -> Vec<(u32, u32)> {
        let mut w: Vec<(u32, u32)> = TABLES
            .iter()
            .flatten()
            .flat_map(|t| t.iter())
            .filter(|c| c.n != 1)
            .map(|c| (c.m as u32, c.n as u32))
            .collect();
        w.sort_unstable();
        w.dedup();
        w
    }

    #[test]
    fn reciprocal_division_is_exact() {
        for (_, n) in weights() {
            let e = Entry::new(c(0, 0, 1, n as u8), 2, 0, 2);
            for v in 0..=255 * n {
                assert_eq!(e.div(v), v / n, "v={v} n={n}");
            }
        }
    }

    #[test]
    fn gradient_matches_oracle() {
        let mut s = 0x2545_F491_4F6C_DD1Du64;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s as u32
        };
        for (m, n) in weights() {
            let e = Entry::new(c(0, 0, m as u8, n as u8), 2, 0, 2);
            // every opaque channel pair
            for f in 0..256u32 {
                for b in 0..256u32 {
                    let (front, back) = (0xFF00_0000 | f * 0x0001_0101, 0xFF00_0000 | b * 0x0001_0101);
                    assert_eq!(e.gradient(front, back), oracle(front, back, m, n));
                }
            }
            // every alpha pair, random colours
            for fa in 0..256u32 {
                for ba in 0..256u32 {
                    let front = (rnd() & 0x00FF_FFFF) | fa << 24;
                    let back = (rnd() & 0x00FF_FFFF) | ba << 24;
                    assert_eq!(e.gradient(front, back), oracle(front, back, m, n), "{front:08x} {back:08x} {m}/{n}");
                }
            }
        }
    }

    #[test]
    fn tables_are_in_bounds_and_distinct() {
        for (k, t) in TABLES.iter().enumerate() {
            let n = k + 2;
            for cells in t.iter() {
                let mut seen = std::collections::HashSet::new();
                for c in cells.iter() {
                    assert!((c.i as usize) < n && (c.j as usize) < n);
                    assert!(c.n == 1 || (0 < c.m && c.m < c.n));
                    assert!(seen.insert((c.i, c.j)));
                }
            }
        }
    }

    #[test]
    fn rotate_index_matches_recursive_definition() {
        fn rec(i: usize, j: usize, n: usize, r: usize) -> (usize, usize) {
            if r == 0 { (i, j) } else { rec(n - 1 - j, i, n, r - 1) }
        }
        for n in 2..=8 {
            for r in 0..4 {
                for i in 0..n {
                    for j in 0..n {
                        assert_eq!(rotate_index(i, j, n, r), rec(i, j, n, r));
                    }
                }
            }
        }
    }
}
