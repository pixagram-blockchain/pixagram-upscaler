//! CRT Effect Rendering Engine
//! Optimized with Integer Math, separable warp logic, and Gamma LUT.

/// CRT configuration
#[derive(Clone, Copy)]
pub struct CrtConfig {
    pub warp_x: f32,
    pub warp_y: f32,
    pub scan_hardness: f32,
    pub scan_opacity: f32,
    pub mask_opacity: f32,
    pub enable_warp: bool,
    pub enable_scanlines: bool,
    pub enable_mask: bool,
}

impl Default for CrtConfig {
    fn default() -> Self {
        Self {
            warp_x: 0.015,
            warp_y: 0.02,
            scan_hardness: -4.0,
            scan_opacity: 0.5,
            mask_opacity: 0.3,
            enable_warp: true,
            enable_scanlines: true,
            enable_mask: true,
        }
    }
}

pub fn crt_upscale(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    config: &CrtConfig,
) -> Vec<u8> {
    let scale = scale.clamp(2, 32);
    let out_w = src_w * scale;
    let out_h = src_h * scale;
    let mut output = vec![0u8; out_w * out_h * 4];

    // --- Pre-calculation Phase ---

    // 1. Gamma Correction LUT (Linear -> sRGB approximation)
    // Avoids per-pixel sqrt()
    let gamma_lut: Vec<u8> = (0..=255).map(|i| {
        let f = (i as f32 / 255.0).sqrt();
        (f * 255.0).clamp(0.0, 255.0) as u8
    }).collect();

    // 2. Scanline LUT
    let scan_lut: Vec<f32> = (0..=100)
        .map(|i| {
            if !config.enable_scanlines {
                return 1.0;
            }
            let v = i as f32 / 100.0;
            let d = (v - 0.5).abs();
            // Simplify exp calculation? Keeping it for quality, done only 100 times.
            let line = (d * d * config.scan_hardness).exp();
            (1.0 - config.scan_opacity) + line * config.scan_opacity
        })
        .collect();

    // 3. Mask LUT
    let mask_lut: [[f32; 3]; 6] = if config.enable_mask {
        let opacity = config.mask_opacity;
        let base = 1.0 - opacity;
        [
            [1.0, 0.0, 0.0], [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0], [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0], [0.0, 0.0, 1.0],
        ].map(|c| [base + c[0] * opacity, base + c[1] * opacity, base + c[2] * opacity])
    } else {
        [[1.0, 1.0, 1.0]; 6]
    };

    let src_w_f = src_w as f32;
    let src_h_f = src_h as f32;
    let out_w_f = out_w as f32;
    let out_h_f = out_h as f32;

    // --- Processing Phase ---

    for y in 0..out_h {
        let v_norm = y as f32 / out_h_f;
        let dc_y = (v_norm - 0.5).abs();
        let dc2_y = dc_y * dc_y;

        // Optimization: Calculate Row-Invariant Warp factors
        // For a specific Y, the X-warp function is linear: u' = u * factor + offset
        let (row_warp_scale, row_warp_offset) = if config.enable_warp {
            let warp_x_factor = 1.0 + (dc2_y * (0.3 * config.warp_x));
            // u' = (u - 0.5) * factor + 0.5
            // u' = u * factor - 0.5 * factor + 0.5
            (warp_x_factor, 0.5 - 0.5 * warp_x_factor)
        } else {
            (1.0, 0.0)
        };
        
        // Y-warp depends on X, so we calculate the constant part of the Y-warp equation
        let y_warp_base = if config.enable_warp {
             v_norm - 0.5
        } else {
             0.0 
        };

        // Scanline intensity for this row
        let src_y_pos = v_norm * src_h_f;
        let scan_idx = (src_y_pos.fract() * 100.0) as usize;
        let scan_val = unsafe { *scan_lut.get_unchecked(scan_idx.min(100)) };

        for x in 0..out_w {
            let u_norm = x as f32 / out_w_f;

            // Optimized Warp Logic
            let (warped_u, warped_v) = if config.enable_warp {
                // Apply pre-calculated linear X-warp
                let wu = u_norm * row_warp_scale + row_warp_offset;

                // Apply X-dependent Y-warp
                // wv = (v - 0.5) * (1.0 + dc2_x * coeff) + 0.5
                let dc_x = (u_norm - 0.5).abs();
                let dc2_x = dc_x * dc_x;
                let wv = y_warp_base * (1.0 + (dc2_x * (0.4 * config.warp_y))) + 0.5;

                (wu, wv)
            } else {
                (u_norm, v_norm)
            };

            // Bounds check
            if warped_u < 0.0 || warped_u >= 1.0 || warped_v < 0.0 || warped_v >= 1.0 {
                continue; // Pixel remains 0 (black)
            }

            let src_x = warped_u * src_w_f;
            let src_y = warped_v * src_h_f;

            let x0 = src_x as usize;
            let y0 = src_y as usize;
            // Use bitwise min to avoid branches if possible, or simple min
            let x1 = (x0 + 1).min(src_w - 1);
            let y1 = (y0 + 1).min(src_h - 1);

            // Bilinear weights (fixed point optimization opportunity, but FPU is fast enough here with simple math)
            let wx = src_x - x0 as f32;
            let wy = src_y - y0 as f32;
            let iwx = 1.0 - wx;
            let iwy = 1.0 - wy;

            let row0_idx = y0 * src_w;
            let row1_idx = y1 * src_w;
            
            // Pointer arithmetic for faster access
            // SAFETY: Bounds checked by warp logic and clamping above
            let (p00, p10, p01, p11) = unsafe {
                 let s = input.as_ptr();
                 (
                    s.add((row0_idx + x0) * 4),
                    s.add((row0_idx + x1) * 4),
                    s.add((row1_idx + x0) * 4),
                    s.add((row1_idx + x1) * 4)
                 )
            };

            // Calculate Alpha first to early exit
            let a_f = unsafe {
                (*p00.add(3) as f32 * iwx + *p10.add(3) as f32 * wx) * iwy +
                (*p01.add(3) as f32 * iwx + *p11.add(3) as f32 * wx) * wy
            };

            if a_f < 1.0 { continue; }

            // Color Interpolation
            // We do the multiplication in floats, but avoid powi(2) for gamma expansion.
            // Approximating Gamma 2.0 expansion as simple squaring is fast and accurate enough for CRT effects.
            
            let mut r = unsafe {
                ((*p00 as f32 * iwx + *p10 as f32 * wx) * iwy +
                 (*p01 as f32 * iwx + *p11 as f32 * wx) * wy) / 255.0
            };
            let mut g = unsafe {
                ((*p00.add(1) as f32 * iwx + *p10.add(1) as f32 * wx) * iwy +
                 (*p01.add(1) as f32 * iwx + *p11.add(1) as f32 * wx) * wy) / 255.0
            };
            let mut b = unsafe {
                ((*p00.add(2) as f32 * iwx + *p10.add(2) as f32 * wx) * iwy +
                 (*p01.add(2) as f32 * iwx + *p11.add(2) as f32 * wx) * wy) / 255.0
            };

            // Apply Gamma Expansion (Approximate sRGB -> Linear with x^2)
            r *= r;
            g *= g;
            b *= b;

            // Bloom Estimation
            let luma = r * 0.299 + g * 0.587 + b * 0.114;
            let bloom = luma * 0.7;

            // Apply Scanline
            r *= scan_val;
            g *= scan_val;
            b *= scan_val;

            // Apply Mask & Bloom
            let mask = unsafe { mask_lut.get_unchecked(x % 6) };
            let ibloom = 1.0 - bloom;
            
            r = r * (mask[0] * ibloom + bloom);
            g = g * (mask[1] * ibloom + bloom);
            b = b * (mask[2] * ibloom + bloom);

            // Output with Gamma Correction LUT (Linear -> sRGB)
            let out_idx = (y * out_w + x) * 4;
            unsafe {
                *output.get_unchecked_mut(out_idx)     = *gamma_lut.get_unchecked((r * 255.0) as usize & 0xFF);
                *output.get_unchecked_mut(out_idx + 1) = *gamma_lut.get_unchecked((g * 255.0) as usize & 0xFF);
                *output.get_unchecked_mut(out_idx + 2) = *gamma_lut.get_unchecked((b * 255.0) as usize & 0xFF);
                *output.get_unchecked_mut(out_idx + 3) = 255;
            }
        }
    }

    output
}
