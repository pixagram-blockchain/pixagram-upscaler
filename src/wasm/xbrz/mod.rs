//! A high quality image upscaling algorithm designed to preserve key details in low-resolution pixel art.
//!
//! The original version was implemented by C++ by [Zenju](https://sourceforge.net/u/zenju/profile/)
//! and can be found on [SourceForge](https://sourceforge.net/projects/xbrz/).
//!
//! This project is a direct port of xBRZ version 1.8 into Rust.
//!
use self::config::ScalerConfig;
use self::oob_reader::OobReaderTransparent;
use self::pixel::{Pixel, Rgba8};
use self::scaler::{Scaler, Scaler2x, Scaler3x, Scaler4x, Scaler5x, Scaler6x};
#[cfg(feature = "parallel")]
use self::ycbcr_lookup::YCbCrLookup;

pub use self::config::ScalerConfig as XbrzScalerConfig;

mod blend;
pub mod config;
mod kernel;
mod matrix;
mod oob_reader;
mod pixel;
mod scaler;
mod ycbcr_lookup;

/// Use the xBRZ algorithm to scale up an image by an integer factor.
///
/// The `source` is specified as a flat array of pixels, ordered in left to right, then top to bottom order.
/// The subpixels are arranged in RGBA order and each channel is 8 bits, such that each pixel takes up 4 bytes.
///
/// A newly allocated image is returned as a flat RGBA vector, with image dimensions
/// `src_width * factor` by `src_height * factor` and total byte length
/// `src_width * factor * src_height * factor * 4`.
///
/// The `factor` may be one of 1, 2, 3, 4, 5 or 6.
///
/// # Panics
///
/// Panics if the `source` slice length is not exactly equal to `src_width * src_height * 4`,
/// or if `factor` is not one of 1, 2, 3, 4, 5 or 6.
pub fn scale_rgba(source: &[u8], src_width: usize, src_height: usize, factor: usize) -> Vec<u8> {
    scale_rgba_config(source, src_width, src_height, factor, &ScalerConfig::default())
}

/// Use the xBRZ algorithm to scale up an image with custom configuration.
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

/// Use the xBRZ algorithm to scale up an image, writing directly into a
/// caller-provided buffer (`src_width*factor * src_height*factor * 4` bytes).
///
/// Every destination pixel is written (`fill_block` covers the full
/// `SCALE x SCALE` block before blending), so the buffer may contain stale
/// data from a previous frame. This is the zero-copy path used by the wasm
/// shared buffer, removing one full-output allocation + memcpy per call.
pub fn scale_rgba_config_into(
    source: &[u8],
    src_width: usize,
    src_height: usize,
    factor: usize,
    config: &ScalerConfig,
    destination: &mut [u8],
) {
    scale_with_config_into::<Rgba8>(source, src_width, src_height, factor, config, destination);
}

fn scale_with_config_into<P: Pixel + bytemuck::Pod + Send + Sync>(
    source: &[u8],
    src_width: usize,
    src_height: usize,
    factor: usize,
    config: &ScalerConfig,
    destination: &mut [u8],
) {
    if src_width == 0 || src_height == 0 {
        assert!(destination.is_empty());
        return;
    }

    assert_eq!(source.len(), src_width * src_height * P::SIZE);
    assert_eq!(
        destination.len(),
        src_width * src_height * factor * factor * P::SIZE
    );
    assert!(factor > 0);
    assert!(factor <= 6);

    // Safe reinterpretation: P is plain-old-data with alignment 1.
    let src_argb: &[P] = bytemuck::cast_slice(source);
    let dst_argb: &mut [P] = bytemuck::cast_slice_mut(destination);

    match factor {
        1 => dst_argb.copy_from_slice(src_argb),
        2 => run_scaler::<P, Scaler2x, 2>(src_argb, dst_argb, src_width, src_height, config),
        3 => run_scaler::<P, Scaler3x, 3>(src_argb, dst_argb, src_width, src_height, config),
        4 => run_scaler::<P, Scaler4x, 4>(src_argb, dst_argb, src_width, src_height, config),
        5 => run_scaler::<P, Scaler5x, 5>(src_argb, dst_argb, src_width, src_height, config),
        6 => run_scaler::<P, Scaler6x, 6>(src_argb, dst_argb, src_width, src_height, config),
        _ => unreachable!(),
    }
}

// ============================================================================
// Scaler dispatch (serial / parallel)
// ============================================================================

/// Runs the chosen scaler over the whole destination buffer.
///
/// With the `parallel` feature enabled the output is split into horizontal
/// stripes that are processed across the rayon thread pool. Each stripe owns a
/// disjoint `&mut` chunk of the destination (via `par_chunks_mut`), so the
/// writes never alias and no locking is required on the hot path. The xBRZ
/// preprocessing is intentionally recomputed per stripe (see `scale_image`) so
/// that stripes are fully independent.
///
/// Without the feature it runs as a single stripe on the calling thread, which
/// is byte-for-byte identical to the original single-threaded implementation.
#[inline]
fn run_scaler<P, S, const N: usize>(
    src: &[P],
    dst: &mut [P],
    src_width: usize,
    src_height: usize,
    config: &ScalerConfig,
) where
    P: Pixel + Send + Sync,
    S: Scaler<N>,
{
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;

        // Build the shared YCbCr lookup table once, on this thread, before any
        // worker reads it through the unchecked accessor.
        YCbCrLookup::initialise();

        let dest_width = src_width * N;
        let threads = rayon::current_num_threads().max(1);
        let stripe_rows = ((src_height + threads - 1) / threads).max(1);
        let chunk_len = dest_width * stripe_rows * N;

        dst.par_chunks_mut(chunk_len)
            .enumerate()
            .for_each(|(i, chunk)| {
                let y0 = i * stripe_rows;
                let y1 = (y0 + stripe_rows).min(src_height);
                if y0 >= y1 {
                    return;
                }
                <S as Scaler<N>>::scale_image::<P, OobReaderTransparent<P>>(
                    src, chunk, src_width, src_height, config, y0..y1,
                );
            });
    }

    #[cfg(not(feature = "parallel"))]
    {
        <S as Scaler<N>>::scale_image::<P, OobReaderTransparent<P>>(
            src, dst, src_width, src_height, config, 0..src_height,
        );
    }
}

// ============================================================================
// Public API for lib.rs
// ============================================================================

/// Core xBRZ upscaling function with configurable parameters
/// 
/// # Arguments
/// * `input` - Source image as RGBA bytes
/// * `src_w` - Source image width
/// * `src_h` - Source image height  
/// * `scale` - Scale factor (1-6)
/// * `equal_color_tolerance` - Tolerance for considering colors equal (default: 30.0)
/// * `center_direction_bias` - Bias for center direction (default: 4.0)
/// * `dominant_direction_threshold` - Threshold for dominant direction (default: 3.6)
/// * `steep_direction_threshold` - Threshold for steep direction (default: 2.2)
/// 
/// # Returns
/// Scaled image as RGBA bytes
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
    let scale = scale.clamp(1, 6);
    
    if scale == 1 {
        return input.to_vec();
    }
    
    let config = config::ScalerConfig {
        equal_color_tolerance,
        center_direction_bias,
        dominant_direction_threshold,
        steep_direction_threshold,
    };
    
    scale_rgba_config(input, src_w, src_h, scale, &config)
}

/// Like [`xbrz_upscale`] but writes into a caller-provided buffer of exactly
/// `src_w * scale * src_h * scale * 4` bytes, avoiding an allocation per call.
/// Every output byte is written, so the buffer does not need to be zeroed.
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
    let scale = scale.clamp(1, 6);

    if scale == 1 {
        output.copy_from_slice(input);
        return;
    }

    let config = config::ScalerConfig {
        equal_color_tolerance,
        center_direction_bias,
        dominant_direction_threshold,
        steep_direction_threshold,
    };

    scale_rgba_config_into(input, src_w, src_h, scale, &config, output);
}
