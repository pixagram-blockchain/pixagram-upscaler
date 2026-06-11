//! CRT Effect Rendering Engine
//! Optimized with integer math, separable warp logic, gamma LUT, and
//! per-frame precomputed column tables.

use std::sync::OnceLock;

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

/// Gamma correction LUT (linear -> sRGB approximation, `sqrt`).
///
/// Config-independent, so it is built exactly once per process instead of
/// being reallocated as a `Vec<u8>` on every call. Fixed-size array, no heap.
#[inline]
fn gamma_lut() -> &'static [u8; 256] {
    static LUT: OnceLock<[u8; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut lut = [0u8; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            let f = (i as f32 / 255.0).sqrt();
            *v = (f * 255.0).clamp(0.0, 255.0) as u8;
        }
        lut
    })
}

/// Per-output-column values that do not depend on the row:
/// `[0] = u_norm`, `[1] = 1.0 + dc2_x * (0.4 * warp_y)` (the x-dependent
/// factor of the vertical warp). Computed once per frame instead of once per
/// pixel (removes a divide, an abs and two multiplies from the inner loop).
fn build_column_lut(out_w: usize, config: &CrtConfig) -> Vec<[f32; 2]> {
    let out_w_f = out_w as f32;
    (0..out_w)
        .map(|x| {
            let u_norm = x as f32 / out_w_f;
            let ywf = if config.enable_warp {
                let dc_x = (u_norm - 0.5).abs();
                let dc2_x = dc_x * dc_x;
                1.0 + (dc2_x * (0.4 * config.warp_y))
            } else {
                1.0
            };
            [u_norm, ywf]
        })
        .collect()
}

/// Allocating wrapper around [`crt_upscale_into`].
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
    crt_upscale_into(input, src_w, src_h, scale, config, &mut output);
    output
}

/// Renders the CRT effect directly into `output` (length must be
/// `src_w*scale * src_h*scale * 4`). Every output byte is written, so the
/// buffer may safely contain stale data from a previous frame - this is the
/// zero-copy path used by the wasm shared buffer.
pub fn crt_upscale_into(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    config: &CrtConfig,
    output: &mut [u8],
) {
    let scale = scale.clamp(2, 32);
    let out_w = src_w * scale;
    let out_h = src_h * scale;
    assert_eq!(output.len(), out_w * out_h * 4, "output buffer size mismatch");
    assert!(input.len() >= src_w * src_h * 4, "input buffer too small");

    // --- Pre-calculation Phase ---

    // 1. Gamma Correction LUT (process-wide, see gamma_lut()).
    let gamma_lut = gamma_lut();

    // 2. Scanline LUT - fixed-size array on the stack, no allocation.
    let mut scan_lut = [1.0f32; 101];
    if config.enable_scanlines {
        for (i, v) in scan_lut.iter_mut().enumerate() {
            let t = i as f32 / 100.0;
            let d = (t - 0.5).abs();
            let line = (d * d * config.scan_hardness).exp();
            *v = (1.0 - config.scan_opacity) + line * config.scan_opacity;
        }
    }

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

    // 4. Row-invariant per-column table (u_norm and Y-warp factor).
    let col_lut = build_column_lut(out_w, config);

    let src_w_f = src_w as f32;
    let src_h_f = src_h as f32;
    let out_h_f = out_h as f32;

    // --- Processing Phase ---
    //
    // Each output row is independent, so the work is split row-wise. With the
    // `parallel` feature the rows are distributed across the rayon thread pool;
    // otherwise they run sequentially. Both paths call the same `crt_render_row`
    // kernel, so the produced pixels are identical.

    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        output
            .par_chunks_mut(out_w * 4)
            .enumerate()
            .for_each(|(y, row)| {
                crt_render_row(
                    row, y, out_h_f, src_w, src_h, src_w_f, src_h_f,
                    input, config, gamma_lut, &scan_lut, &mask_lut, &col_lut,
                );
            });
    }

    #[cfg(not(feature = "parallel"))]
    {
        for (y, row) in output.chunks_exact_mut(out_w * 4).enumerate() {
            crt_render_row(
                row, y, out_h_f, src_w, src_h, src_w_f, src_h_f,
                input, config, gamma_lut, &scan_lut, &mask_lut, &col_lut,
            );
        }
    }
}

/// Renders a single output row (`row` has length `out_w * 4`) of the CRT effect.
#[inline]
#[allow(clippy::too_many_arguments)]
fn crt_render_row(
    row: &mut [u8],
    y: usize,
    out_h_f: f32,
    src_w: usize,
    src_h: usize,
    src_w_f: f32,
    src_h_f: f32,
    input: &[u8],
    config: &CrtConfig,
    gamma_lut: &[u8; 256],
    scan_lut: &[f32; 101],
    mask_lut: &[[f32; 3]; 6],
    col_lut: &[[f32; 2]],
) {
    let v_norm = y as f32 / out_h_f;
    let dc_y = (v_norm - 0.5).abs();
    let dc2_y = dc_y * dc_y;

    // Row-invariant X-warp factors: u' = u * scale + offset
    let (row_warp_scale, row_warp_offset) = if config.enable_warp {
        let warp_x_factor = 1.0 + (dc2_y * (0.3 * config.warp_x));
        (warp_x_factor, 0.5 - 0.5 * warp_x_factor)
    } else {
        (1.0, 0.0)
    };

    // Y-warp constant part
    let y_warp_base = if config.enable_warp { v_norm - 0.5 } else { 0.0 };

    // Scanline intensity for this row
    let src_y_pos = v_norm * src_h_f;
    let scan_idx = (src_y_pos.fract() * 100.0) as usize;
    let scan_val = scan_lut[scan_idx.min(100)];

    let enable_warp = config.enable_warp;

    // Cycling shadow-mask index instead of `x % 6` per pixel.
    let mut mask_idx = 0usize;

    for (out_px, &[u_norm, ywarp_factor]) in row.chunks_exact_mut(4).zip(col_lut) {
        let mask = mask_lut[mask_idx];
        mask_idx += 1;
        if mask_idx == 6 {
            mask_idx = 0;
        }

        // Warp (the x-dependent factor comes precomputed from col_lut)
        let (warped_u, warped_v) = if enable_warp {
            let wu = u_norm * row_warp_scale + row_warp_offset;
            let wv = y_warp_base * ywarp_factor + 0.5;
            (wu, wv)
        } else {
            (u_norm, v_norm)
        };

        // Out-of-tube pixels are explicitly transparent black so the output
        // buffer never needs pre-zeroing (required for buffer reuse).
        if warped_u < 0.0 || warped_u >= 1.0 || warped_v < 0.0 || warped_v >= 1.0 {
            out_px.copy_from_slice(&[0, 0, 0, 0]);
            continue;
        }

        let src_x = warped_u * src_w_f;
        let src_y = warped_v * src_h_f;

        let x0 = src_x as usize;
        let y0 = src_y as usize;
        let x1 = (x0 + 1).min(src_w - 1);
        let y1 = (y0 + 1).min(src_h - 1);

        // Bilinear weights
        let wx = src_x - x0 as f32;
        let wy = src_y - y0 as f32;
        let iwx = 1.0 - wx;
        let iwy = 1.0 - wy;

        let row0_idx = y0 * src_w;
        let row1_idx = y1 * src_w;

        // SAFETY: x0/x1 < src_w and y0/y1 < src_h by the warp bounds check and
        // the explicit clamping above; input length asserted by the caller.
        let (p00, p10, p01, p11) = unsafe {
            let s = input.as_ptr();
            (
                s.add((row0_idx + x0) * 4),
                s.add((row0_idx + x1) * 4),
                s.add((row1_idx + x0) * 4),
                s.add((row1_idx + x1) * 4),
            )
        };

        // Alpha first for the early exit
        let a_f = unsafe {
            (*p00.add(3) as f32 * iwx + *p10.add(3) as f32 * wx) * iwy
                + (*p01.add(3) as f32 * iwx + *p11.add(3) as f32 * wx) * wy
        };

        if a_f < 1.0 {
            out_px.copy_from_slice(&[0, 0, 0, 0]);
            continue;
        }

        let mut r = unsafe {
            ((*p00 as f32 * iwx + *p10 as f32 * wx) * iwy
                + (*p01 as f32 * iwx + *p11 as f32 * wx) * wy)
                / 255.0
        };
        let mut g = unsafe {
            ((*p00.add(1) as f32 * iwx + *p10.add(1) as f32 * wx) * iwy
                + (*p01.add(1) as f32 * iwx + *p11.add(1) as f32 * wx) * wy)
                / 255.0
        };
        let mut b = unsafe {
            ((*p00.add(2) as f32 * iwx + *p10.add(2) as f32 * wx) * iwy
                + (*p01.add(2) as f32 * iwx + *p11.add(2) as f32 * wx) * wy)
                / 255.0
        };

        // Gamma expansion (approximate sRGB -> linear with x^2)
        r *= r;
        g *= g;
        b *= b;

        // Bloom estimation
        let luma = r * 0.299 + g * 0.587 + b * 0.114;
        let bloom = luma * 0.7;

        // Scanline
        r *= scan_val;
        g *= scan_val;
        b *= scan_val;

        // Mask & bloom
        let ibloom = 1.0 - bloom;

        r *= mask[0] * ibloom + bloom;
        g *= mask[1] * ibloom + bloom;
        b *= mask[2] * ibloom + bloom;

        // Output with gamma correction LUT (linear -> sRGB)
        out_px[0] = gamma_lut[(r * 255.0) as usize & 0xFF];
        out_px[1] = gamma_lut[(g * 255.0) as usize & 0xFF];
        out_px[2] = gamma_lut[(b * 255.0) as usize & 0xFF];
        out_px[3] = 255;
    }
}
