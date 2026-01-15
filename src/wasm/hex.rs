//! Hexagonal Pixel Art Upscaling Engine
//! Optimized with analytical border detection and pre-computed geometry.

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

    #[inline(always)]
    fn pixel_to_hex_fractional(&self, x: f32, y: f32) -> (f32, f32) {
        let adj_x = x - self.offset_x;
        let adj_y = y - self.offset_y;
        
        let q = self.m00 * adj_x + self.m01 * adj_y;
        let r = self.m10 * adj_x + self.m11 * adj_y;
        
        (q, r)
    }

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

    #[inline(always)]
    fn fractional_to_grid(&self, q: f32, r: f32) -> (i32, i32) {
        let (rq, rr) = self.hex_round(q, r);
        match self.orientation {
            HexOrientation::FlatTop => {
                (rq, rr + (rq - (rq & 1)) / 2)
            }
            HexOrientation::PointyTop => {
                (rq + (rr - (rr & 1)) / 2, rr)
            }
        }
    }

    #[inline(always)]
    fn is_in_border(&self, q: f32, r: f32, thickness: f32) -> bool {
        let s = -q - r;
        // Suppress unused warnings by using _ prefix
        let _rq = q.round();
        let _rr = r.round();
        let _rs = s.round(); 

        let (cq, cr) = self.hex_round(q, r);
        let cs = -cq - cr;
        
        let dist = (q - cq as f32).abs()
            .max((r - cr as f32).abs())
            .max((s - cs as f32).abs());

        let thresh = 0.5 - (thickness * 0.55 / self.scale);
        
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

pub fn hex_upscale(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    config: &HexConfig,
) -> Vec<u8> {
    let scale = scale.clamp(2, 32) as u32;
    let geometry = HexGeometry::new(scale, config.orientation);
    let (out_w, out_h) = geometry.output_dimensions(src_w as u32, src_h as u32);
    let mut output = vec![0u8; (out_w * out_h * 4) as usize];

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
    let border_thickness_f = config.border_thickness as f32;

    let src_w_i = src_w as i32;
    let src_h_i = src_h as i32;

    for y in 0..out_h {
        let y_f = y as f32;
        for x in 0..out_w {
            let x_f = x as f32;
            
            let (q, r) = geometry.pixel_to_hex_fractional(x_f, y_f);
            let (hex_col, hex_row) = geometry.fractional_to_grid(q, r);
            let out_idx = ((y * out_w + x) * 4) as usize;

            if hex_col >= 0 && hex_row >= 0 && hex_col < src_w_i && hex_row < src_h_i {
                if check_borders && geometry.is_in_border(q, r, border_thickness_f) {
                    output[out_idx..out_idx+4].copy_from_slice(&border);
                } else {
                    let src_idx = (hex_row as usize * src_w + hex_col as usize) * 4;
                    output[out_idx..out_idx+4].copy_from_slice(&input[src_idx..src_idx+4]);
                }
            } else {
                output[out_idx..out_idx+4].copy_from_slice(&bg);
            }
        }
    }

    output
}
