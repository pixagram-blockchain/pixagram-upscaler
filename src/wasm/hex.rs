//! Hexagonal Pixel Art Upscaling Engine
//! Optimized with analytical border detection, per-frame column tables,
//! single hex-round per pixel, and source-cell caching.

/// Hexagon orientation
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexOrientation {
    FlatTop = 0,
    PointyTop = 1,
}

/// HEX configuration
#[derive(Clone)]
pub struct HexConfig {
    pub orientation: HexOrientation,
    pub draw_borders: bool,
    pub border_color: u32,
    pub border_thickness: usize,
    pub background_color: u32,
}

impl Default for HexConfig {
    fn default() -> Self {
        Self {
            orientation: HexOrientation::FlatTop,
            draw_borders: false,
            border_color: 0x282828FF,
            border_thickness: 1,
            background_color: 0x00000000,
        }
    }
}

struct HexGeometry {
    orientation: HexOrientation,
    scale: f32,
    m00: f32, m01: f32,
    m10: f32, m11: f32,
    offset_x: f32,
    offset_y: f32,
}

impl HexGeometry {
    fn new(scale: u32, orientation: HexOrientation) -> Self {
        let size = scale.max(2) as f32;
        let sqrt3 = 3.0_f32.sqrt();

        let (offset_x, offset_y) = match orientation {
            HexOrientation::FlatTop => (size, size * sqrt3 * 0.5),
            HexOrientation::PointyTop => (size * sqrt3 * 0.5, size),
        };

        let (m00, m01, m10, m11) = match orientation {
            HexOrientation::FlatTop => (
                2.0 / 3.0 / size,
                0.0,
                -1.0 / 3.0 / size,
                sqrt3 / 3.0 / size
            ),
            HexOrientation::PointyTop => (
                sqrt3 / 3.0 / size,
                -1.0 / 3.0 / size,
                0.0,
                2.0 / 3.0 / size
            ),
        };

        Self {
            orientation,
            scale: size,
            m00, m01, m10, m11,
            offset_x, offset_y,
        }
    }

    fn output_dimensions(&self, input_width: u32, input_height: u32) -> (u32, u32) {
        let w = (input_width as f32) - 1.0;
        let h = (input_height as f32) - 1.0;
        let size = self.scale;
        let sqrt3 = 3.0_f32.sqrt();

        match self.orientation {
            HexOrientation::FlatTop => {
                let h_spacing = size * 1.5;
                let v_spacing = size * sqrt3;
                let cell_w = size * 2.0;
                let cell_h = size * sqrt3;

                let out_w = w * h_spacing + cell_w;
                let out_h = h * v_spacing + cell_h + (size * sqrt3 * 0.5);

                (out_w.ceil() as u32, out_h.ceil() as u32)
            }
            HexOrientation::PointyTop => {
                let h_spacing = size * sqrt3;
                let v_spacing = size * 1.5;
                let cell_w = size * sqrt3;
                let cell_h = size * 2.0;

                let out_w = w * h_spacing + cell_w + (size * sqrt3 * 0.5);
                let out_h = h * v_spacing + cell_h;

                (out_w.ceil() as u32, out_h.ceil() as u32)
            }
        }
    }

    /// Round fractional axial coordinates to the containing hex cell.
    #[inline(always)]
    fn hex_round(&self, q: f32, r: f32) -> (i32, i32) {
        let s = -q - r;
        let mut qi = q.round();
        let mut ri = r.round();
        let si = s.round();

        let q_diff = (qi - q).abs();
        let r_diff = (ri - r).abs();
        let s_diff = (si - s).abs();

        if q_diff > r_diff && q_diff > s_diff {
            qi = -ri - si;
        } else if r_diff > s_diff {
            ri = -qi - si;
        }

        (qi as i32, ri as i32)
    }

    /// Rounded axial (cube) -> offset grid (col, row).
    #[inline(always)]
    fn rounded_to_grid(&self, rq: i32, rr: i32) -> (i32, i32) {
        match self.orientation {
            HexOrientation::FlatTop => (rq, rr + (rq - (rq & 1)) / 2),
            HexOrientation::PointyTop => (rq + (rr - (rr & 1)) / 2, rr),
        }
    }

    /// Analytical hexagon edge-distance test against the *already rounded*
    /// cell center. The previous version re-ran `hex_round` (plus three dead
    /// `round()` calls) for every border-checked pixel; the rounded center is
    /// now computed once per pixel and shared with the grid lookup.
    #[inline(always)]
    fn is_in_border(&self, q: f32, r: f32, rq: i32, rr: i32, thresh: f32) -> bool {
        let s = -q - r;
        let cs = -rq - rr;

        let dist = (q - rq as f32).abs()
            .max((r - rr as f32).abs())
            .max((s - cs as f32).abs());

        dist > thresh
    }
}

pub fn get_output_dimensions(
    src_w: usize,
    src_h: usize,
    scale: usize,
    orientation: &HexOrientation,
) -> (usize, usize) {
    let scale = scale.clamp(2, 32) as u32;
    let geometry = HexGeometry::new(scale, *orientation);
    let (out_w, out_h) = geometry.output_dimensions(src_w as u32, src_h as u32);
    (out_w as usize, out_h as usize)
}

/// Allocating wrapper around [`hex_upscale_into`].
pub fn hex_upscale(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    config: &HexConfig,
) -> Vec<u8> {
    let (out_w, out_h) = get_output_dimensions(src_w, src_h, scale, &config.orientation);
    let mut output = vec![0u8; out_w * out_h * 4];
    hex_upscale_into(input, src_w, src_h, scale, config, &mut output);
    output
}

/// Renders the hex effect directly into `output` (length must match
/// [`get_output_dimensions`] `* 4`). Every output byte is written, so the
/// buffer may safely contain stale data from a previous frame - this is the
/// zero-copy path used by the wasm shared buffer.
pub fn hex_upscale_into(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    config: &HexConfig,
    output: &mut [u8],
) {
    let scale = scale.clamp(2, 32) as u32;
    let geometry = HexGeometry::new(scale, config.orientation);
    let (out_w, out_h) = geometry.output_dimensions(src_w as u32, src_h as u32);
    let out_w = out_w as usize;
    let out_h = out_h as usize;
    assert_eq!(output.len(), out_w * out_h * 4, "output buffer size mismatch");
    assert!(input.len() >= src_w * src_h * 4, "input buffer too small");

    let bg = [
        ((config.background_color >> 24) & 0xFF) as u8,
        ((config.background_color >> 16) & 0xFF) as u8,
        ((config.background_color >> 8) & 0xFF) as u8,
        (config.background_color & 0xFF) as u8,
    ];

    let border = [
        ((config.border_color >> 24) & 0xFF) as u8,
        ((config.border_color >> 16) & 0xFF) as u8,
        ((config.border_color >> 8) & 0xFF) as u8,
        (config.border_color & 0xFF) as u8,
    ];

    let check_borders = config.draw_borders && config.border_thickness > 0;
    // Hoisted: was recomputed for every border-checked pixel.
    let border_thresh = 0.5 - (config.border_thickness as f32 * 0.55 / geometry.scale);

    let src_w_i = src_w as i32;
    let src_h_i = src_h as i32;

    // Per-frame column table: `q` and `r` are affine in x, so the x-dependent
    // products `m00*adj_x` / `m10*adj_x` are computed once per frame instead
    // of once per pixel. Per pixel this leaves a single add for each axis
    // (identical float results: same products, same addition order).
    let col_lut: Vec<[f32; 2]> = (0..out_w)
        .map(|x| {
            let adj_x = x as f32 - geometry.offset_x;
            [geometry.m00 * adj_x, geometry.m10 * adj_x]
        })
        .collect();

    // Each output row is independent. With the `parallel` feature rows are
    // distributed across the rayon thread pool; otherwise they run serially.
    // Both paths call the same `hex_render_row` kernel for identical output.
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        output
            .par_chunks_mut(out_w * 4)
            .enumerate()
            .for_each(|(y, row)| {
                hex_render_row(
                    row, y, &geometry, input, src_w, src_w_i, src_h_i,
                    &bg, &border, check_borders, border_thresh, &col_lut,
                );
            });
    }

    #[cfg(not(feature = "parallel"))]
    {
        for (y, row) in output.chunks_exact_mut(out_w * 4).enumerate() {
            hex_render_row(
                row, y, &geometry, input, src_w, src_w_i, src_h_i,
                &bg, &border, check_borders, border_thresh, &col_lut,
            );
        }
    }
}

/// Renders a single output row (`row` has length `out_w * 4`) of the hex effect.
#[inline]
#[allow(clippy::too_many_arguments)]
fn hex_render_row(
    row: &mut [u8],
    y: usize,
    geometry: &HexGeometry,
    input: &[u8],
    src_w: usize,
    src_w_i: i32,
    src_h_i: i32,
    bg: &[u8; 4],
    border: &[u8; 4],
    check_borders: bool,
    border_thresh: f32,
    col_lut: &[[f32; 2]],
) {
    let adj_y = y as f32 - geometry.offset_y;
    // Row-invariant halves of the affine map.
    let q_row = geometry.m01 * adj_y;
    let r_row = geometry.m11 * adj_y;

    // Source-cell cache: consecutive pixels along a row usually fall in the
    // same hexagon (a span of ~1.5x scale pixels), so the bounds check and
    // source fetch are done once per cell instead of once per pixel.
    let mut last_cell = (i32::MIN, i32::MIN);
    let mut cell_color = *bg;
    let mut cell_in_bounds = false;

    for (px, lut) in row.chunks_exact_mut(4).zip(col_lut) {
        let q = lut[0] + q_row;
        let r = lut[1] + r_row;

        // One hex_round per pixel, shared by the grid lookup and border test.
        let (rq, rr) = geometry.hex_round(q, r);

        if (rq, rr) != last_cell {
            last_cell = (rq, rr);
            let (hex_col, hex_row) = geometry.rounded_to_grid(rq, rr);
            cell_in_bounds =
                hex_col >= 0 && hex_row >= 0 && hex_col < src_w_i && hex_row < src_h_i;
            if cell_in_bounds {
                let src_idx = (hex_row as usize * src_w + hex_col as usize) * 4;
                cell_color.copy_from_slice(&input[src_idx..src_idx + 4]);
            }
        }

        if cell_in_bounds {
            if check_borders && geometry.is_in_border(q, r, rq, rr, border_thresh) {
                px.copy_from_slice(border);
            } else {
                px.copy_from_slice(&cell_color);
            }
        } else {
            px.copy_from_slice(bg);
        }
    }
}
