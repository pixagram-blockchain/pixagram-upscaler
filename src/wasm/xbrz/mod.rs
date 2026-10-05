//! xBRZ: a high quality pixel-art upscaler preserving sharp edges.
//!
//! Algorithm by [Zenju](https://sourceforge.net/projects/xbrz/) (xBRZ 1.8),
//! originally ported to Rust as `xbrz-rs`; this module is a restructured,
//! streaming implementation of the same algorithm (see `engine.rs`) with:
//!
//! * the exact YCbCr colour distance instead of a lossy lookup table (see
//!   `dist.rs` - the table caused unblended, "squared" staircases),
//! * Zenju's exact-inequality line-shape test and first-column corner
//!   handling (both deviated in the earlier port),
//! * 7x and 8x tables derived from the same cut geometry as 2x..6x.

use self::engine::{render_band, Params, Source};
pub(crate) use self::engine::{ScratchError, MAX_DIM};

pub use self::config::ScalerConfig;

pub mod config;
mod dist;
mod engine;
mod scaler;

/// Upscale an RGBA image by an integer `factor` (1..=8).
///
/// `source` holds `src_width * src_height` RGBA pixels (4 bytes each, rows top
/// to bottom). Returns `src_width * factor * src_height * factor * 4` bytes.
///
/// # Panics
/// If `source.len() != src_width * src_height * 4` or `factor` is not in 1..=8.
pub fn scale_rgba_config(
    source: &[u8],
    src_width: usize,
    src_height: usize,
    factor: usize,
    config: &ScalerConfig,
) -> Vec<u8> {
    let mut destination = vec![0u8; src_width * src_height * factor * factor * 4];
    scale_rgba_config_into(source, src_width, src_height, factor, config, &mut destination);
    destination
}

/// Like [`scale_rgba_config`] but writes into `destination`
/// (`src_width * factor * src_height * factor * 4` bytes). Every byte is
/// written, so the buffer may hold stale data. A 4-byte aligned buffer is
/// written in place; an unaligned one goes through a temporary.
pub fn scale_rgba_config_into(
    source: &[u8],
    src_width: usize,
    src_height: usize,
    factor: usize,
    config: &ScalerConfig,
    destination: &mut [u8],
) {
    assert!((1..=8).contains(&factor), "xBRZ factor must be in 1..=8");
    assert_eq!(source.len(), src_width * src_height * 4);
    assert_eq!(destination.len(), src_width * src_height * factor * factor * 4);
    if destination.is_empty() {
        return;
    }
    let res = match bytemuck::try_cast_slice_mut::<u8, u32>(destination) {
        Ok(dst) => scale_into_u32(source, src_width, src_height, factor, config, dst),
        Err(_) => {
            let mut tmp = vec![0u32; destination.len() / 4];
            let r = scale_into_u32(source, src_width, src_height, factor, config, &mut tmp);
            destination.copy_from_slice(bytemuck::cast_slice(&tmp));
            r
        }
    };
    res.expect("xBRZ scratch allocation failed");
}

/// Core entry point: `dst` holds `w*factor * h*factor` RGBA pixels as `u32`
/// (native layout of the byte buffer; red is byte 0).
pub(crate) fn scale_into_u32(
    source: &[u8],
    w: usize,
    h: usize,
    factor: usize,
    config: &ScalerConfig,
    dst: &mut [u32],
) -> Result<(), ScratchError> {
    assert_eq!(source.len(), w * h * 4);
    assert_eq!(dst.len(), w * h * factor * factor);
    if dst.is_empty() {
        return Ok(());
    }
    if factor == 1 {
        // Plain copy, already in byte order.
        for (d, s) in dst.iter_mut().zip(source.chunks_exact(4)) {
            *d = u32::from_ne_bytes([s[0], s[1], s[2], s[3]]);
        }
        return Ok(());
    }
    let src = Source::new(source, w, h);
    let p = Params::new(config);
    run(&src, factor, &p, dst)?;
    // The kernels build pixels as little-endian RGBA words.
    #[cfg(target_endian = "big")]
    for px in dst.iter_mut() {
        *px = px.swap_bytes();
    }
    Ok(())
}

/// Runs the scaler over the whole image.
///
/// With the `parallel` feature the destination is split into bands of whole
/// source rows, processed on the rayon pool. Each band owns a disjoint `&mut`
/// chunk of the output and recomputes its two-row halo of distances and
/// corner decisions, so bands are independent and the result is
/// byte-identical to the serial path.
fn run(src: &Source<'_>, n: usize, p: &Params, dst: &mut [u32]) -> Result<(), ScratchError> {
    #[allow(unused_variables)]
    let (w, h) = src.dims();

    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        let threads = rayon::current_num_threads().max(1);
        if threads > 1 && h >= 8 {
            // Several bands per thread for load balancing (edge density varies
            // a lot across an image); at least 4 rows to amortise the halo.
            let rows = (h / (threads * 4)).max(4);
            return dst
                .par_chunks_mut(rows * n * w * n)
                .enumerate()
                .try_for_each(|(i, chunk)| {
                    let y0 = i * rows;
                    let y1 = (y0 + rows).min(h);
                    render_band(src, n, y0, y1, p, chunk)
                });
        }
    }

    render_band(src, n, 0, h, p, dst)
}

/// Renders only source rows `[y0, y1)` of a `w x h` image into `dst`
/// (exactly the destination rows `[y0*factor, y1*factor)`, as `u32` pixels).
///
/// `window` holds source rows `[window_y0, window_y0 + window.len() / (4w))`;
/// it must cover the band's halo `[y0 - 2, y1 + 2)` clipped to the image.
/// Bands rendered separately and stacked are byte-identical to a full render.
#[allow(clippy::too_many_arguments)]
pub(crate) fn scale_band_into_u32(
    window: &[u8],
    w: usize,
    h: usize,
    window_y0: usize,
    factor: usize,
    y0: usize,
    y1: usize,
    config: &ScalerConfig,
    dst: &mut [u32],
) -> Result<(), ScratchError> {
    assert!((2..=8).contains(&factor));
    assert!(y0 < y1 && y1 <= h);
    let src = Source::window(window, w, h, window_y0);
    let p = Params::new(config);
    render_band(&src, factor, y0, y1, &p, dst)?;
    #[cfg(target_endian = "big")]
    for px in dst.iter_mut() {
        *px = px.swap_bytes();
    }
    Ok(())
}

// ============================================================================
// Public API for lib.rs
// ============================================================================

#[allow(clippy::too_many_arguments)]
fn make_config(
    equal_color_tolerance: f64,
    center_direction_bias: f64,
    dominant_direction_threshold: f64,
    steep_direction_threshold: f64,
) -> ScalerConfig {
    ScalerConfig {
        equal_color_tolerance,
        center_direction_bias,
        dominant_direction_threshold,
        steep_direction_threshold,
    }
}

/// xBRZ upscale returning a new buffer. `scale` is clamped to 1..=8.
#[allow(clippy::too_many_arguments)]
pub fn xbrz_upscale(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    equal_color_tolerance: f64,
    center_direction_bias: f64,
    dominant_direction_threshold: f64,
    steep_direction_threshold: f64,
) -> Vec<u8> {
    let scale = scale.clamp(1, 8);
    let config = make_config(
        equal_color_tolerance,
        center_direction_bias,
        dominant_direction_threshold,
        steep_direction_threshold,
    );
    scale_rgba_config(input, src_w, src_h, scale, &config)
}

/// Fallible [`xbrz_upscale_into`] for the wasm boundary: `output` must be the
/// exact size and 4-byte aligned; scratch allocation failure is reported.
#[allow(clippy::too_many_arguments)]
pub(crate) fn try_xbrz_upscale_into(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    equal_color_tolerance: f64,
    center_direction_bias: f64,
    dominant_direction_threshold: f64,
    steep_direction_threshold: f64,
    output: &mut [u32],
) -> Result<(), ScratchError> {
    let config = make_config(
        equal_color_tolerance,
        center_direction_bias,
        dominant_direction_threshold,
        steep_direction_threshold,
    );
    scale_into_u32(input, src_w, src_h, scale.clamp(1, 8), &config, output)
}

/// Like [`xbrz_upscale`] but writes into a caller-provided buffer of exactly
/// `src_w * scale * src_h * scale * 4` bytes (every byte is written).
#[allow(clippy::too_many_arguments)]
pub fn xbrz_upscale_into(
    input: &[u8],
    src_w: usize,
    src_h: usize,
    scale: usize,
    equal_color_tolerance: f64,
    center_direction_bias: f64,
    dominant_direction_threshold: f64,
    steep_direction_threshold: f64,
    output: &mut [u8],
) {
    let scale = scale.clamp(1, 8);
    let config = make_config(
        equal_color_tolerance,
        center_direction_bias,
        dominant_direction_threshold,
        steep_direction_threshold,
    );
    scale_rgba_config_into(input, src_w, src_h, scale, &config, output);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(c: [u8; 4]) -> u32 {
        u32::from_le_bytes(c)
    }

    /// The reported bug: a 1:1 staircase between two gradient colours ~10
    /// apart was rendered as unblended squares at every scale (most visible
    /// at 7x/8x). It must now get xBRZ's diagonal blend.
    #[test]
    fn gradient_staircase_is_blended_not_squared() {
        let m = [76, 66, 114, 255];
        let d = [66, 54, 104, 255];
        let (w, h) = (12usize, 12usize);
        let mut img = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                img.extend_from_slice(if x + y < 12 { &m } else { &d });
            }
        }
        for factor in [2usize, 4, 7, 8] {
            let out = scale_rgba_config(&img, w, h, factor, &ScalerConfig::default());
            let blended = out
                .chunks_exact(4)
                .filter(|p| p != &m.as_slice() && p != &d.as_slice())
                .count();
            // Each interior step corner gets a diagonal cut of mixed pixels.
            assert!(blended >= 8 * factor, "x{factor}: only {blended} blended pixels - staircase left square");
            // And the output is not just the nearest-neighbour upscale.
            let ow = w * factor;
            let corner = |sx: usize, sy: usize| {
                let (ox, oy) = (sx * factor + factor - 1, sy * factor + factor - 1);
                px(out[(oy * ow + ox) * 4..][..4].try_into().unwrap())
            };
            // Pixel (5, 6) is the last M on the edge (5 + 6 = 11 < 12) and
            // its right and lower neighbours are D: the 2x2 block M D / D D
            // has jg < fk, so its bottom-right sub-pixel is pulled towards D
            // (partially at 2x/3x, fully from 4x on) - never left as M, which
            // is what the nearest-neighbour "squared" output had.
            assert_ne!(corner(5, 6), px(m), "x{factor}");
        }
    }

    fn sample(w: usize, h: usize, seed: u32) -> Vec<u8> {
        let mut s = seed | 1;
        (0..w * h)
            .flat_map(|_| {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                let pal = [[10u8, 20, 30, 255], [200, 40, 40, 255], [60, 60, 200, 0], [250, 250, 250, 128]];
                pal[(s % 4) as usize]
            })
            .collect()
    }

    #[test]
    fn bands_with_halo_windows_stack_to_full_render() {
        let (w, h) = (19usize, 23usize);
        let img = sample(w, h, 7);
        let cfg = ScalerConfig::default();
        for factor in 2..=8 {
            let full = scale_rgba_config(&img, w, h, factor, &cfg);
            let full: Vec<u32> = full.chunks_exact(4).map(|c| u32::from_ne_bytes(c.try_into().unwrap())).collect();
            for cuts in [vec![0, h], vec![0, 1, h], vec![0, 5, 6, 17, h], vec![0, h - 1, h]] {
                let mut stacked = Vec::new();
                for b in cuts.windows(2) {
                    let (y0, y1) = (b[0], b[1]);
                    let (a, z) = (y0.saturating_sub(2), (y1 + 2).min(h));
                    let mut out = vec![0u32; w * factor * (y1 - y0) * factor];
                    scale_band_into_u32(&img[a * w * 4..z * w * 4], w, h, a, factor, y0, y1, &cfg, &mut out).unwrap();
                    stacked.extend(out);
                }
                assert!(stacked == full, "x{factor} cuts {cuts:?}");
            }
        }
    }

    #[test]
    fn unaligned_buffers_match_aligned() {
        let (w, h) = (9usize, 7usize);
        let img = sample(w, h, 99);
        let cfg = ScalerConfig::default();
        let want = scale_rgba_config(&img, w, h, 3, &cfg);
        // shift both input and output off 4-byte alignment
        let mut src = vec![0u8; img.len() + 1];
        src[1..].copy_from_slice(&img);
        let mut dst = vec![0u8; want.len() + 1];
        scale_rgba_config_into(&src[1..], w, h, 3, &cfg, &mut dst[1..]);
        assert_eq!(&dst[1..], &want[..]);
    }

    #[test]
    fn degenerate_sizes() {
        let cfg = ScalerConfig::default();
        assert!(scale_rgba_config(&[], 0, 5, 4, &cfg).is_empty());
        assert!(scale_rgba_config(&[], 7, 0, 8, &cfg).is_empty());
        for f in 1..=8 {
            // A transparent pixel equals its out-of-bounds surroundings: flat.
            let out = scale_rgba_config(&[0, 0, 0, 0], 1, 1, f, &cfg);
            assert!(out.iter().all(|&b| b == 0), "1x1 transparent at x{f}");
        }
        // An isolated opaque pixel gets its corners rounded against the
        // transparent border (values from the reference implementation).
        let alphas = |f: usize| -> Vec<u8> {
            scale_rgba_config(&[1, 2, 3, 255], 1, 1, f, &cfg).chunks_exact(4).map(|p| p[3]).collect()
        };
        assert_eq!(alphas(1), [255]);
        assert_eq!(alphas(2), [201; 4]);
        assert_eq!(alphas(3), [140, 255, 140, 255, 255, 255, 140, 255, 140]);
        assert_eq!(alphas(4), [81, 232, 232, 81, 232, 255, 255, 232, 232, 255, 255, 232, 81, 232, 232, 81]);
    }
}
