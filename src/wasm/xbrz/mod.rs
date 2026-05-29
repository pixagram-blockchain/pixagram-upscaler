//! A high quality image upscaling algorithm designed to preserve key details in low-resolution pixel art.
//!
//! The original version was implemented by C++ by [Zenju](https://sourceforge.net/u/zenju/profile/)
//! and can be found on [SourceForge](https://sourceforge.net/projects/xbrz/).
//!
//! This project is a direct port of xBRZ version 1.8 into Rust.
//!
use std::mem;

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
    scale::<Rgba8>(source, src_width, src_height, factor)
}

/// Use the xBRZ algorithm to scale up an image with custom configuration.
pub fn scale_rgba_config(
    source: &[u8], 
    src_width: usize, 
    src_height: usize, 
    factor: usize,
    config: &ScalerConfig,
) -> Vec<u8> {
    scale_with_config::<Rgba8>(source, src_width, src_height, factor, config)
}

fn scale<P: Pixel + Send + Sync>(
    source: &[u8],
    src_width: usize,
    src_height: usize,
    factor: usize,
) -> Vec<u8> {
    let config = ScalerConfig::default();
    scale_with_config::<P>(source, src_width, src_height, factor, &config)
}

fn scale_with_config<P: Pixel + Send + Sync>(
    source: &[u8], 
    src_width: usize, 
    src_height: usize, 
    factor: usize,
    config: &ScalerConfig,
) -> Vec<u8> {
    const U8_SIZE: usize = mem::size_of::<u8>();

    if src_width == 0 || src_height == 0 {
        return vec![];
    }

    assert_eq!(source.len(), src_width * src_height * P::SIZE);
    let (_, src_argb, _) = unsafe { source.align_to::<P>() };
    assert_eq!(src_argb.len(), src_width * src_height);

    assert!(factor > 0);
    assert!(factor <= 6);

    let dst_argb = if factor == 1 {
        src_argb.to_owned()
    } else {
        let mut dst_argb = vec![P::default(); src_width * src_height * factor * factor];
        match factor {
            0 | 1 => unreachable!(),
            2 => run_scaler::<P, Scaler2x, 2>(
                src_argb, dst_argb.as_mut_slice(), src_width, src_height, config,
            ),
            3 => run_scaler::<P, Scaler3x, 3>(
                src_argb, dst_argb.as_mut_slice(), src_width, src_height, config,
            ),
            4 => run_scaler::<P, Scaler4x, 4>(
                src_argb, dst_argb.as_mut_slice(), src_width, src_height, config,
            ),
            5 => run_scaler::<P, Scaler5x, 5>(
                src_argb, dst_argb.as_mut_slice(), src_width, src_height, config,
            ),
            6 => run_scaler::<P, Scaler6x, 6>(
                src_argb, dst_argb.as_mut_slice(), src_width, src_height, config,
            ),
            7.. => unreachable!(),
        };
        dst_argb
    };

    unsafe {
        let mut dst_nodrop = mem::ManuallyDrop::new(dst_argb);
        Vec::from_raw_parts(
            dst_nodrop.as_mut_ptr() as *mut u8,
            dst_nodrop.len() * P::SIZE / U8_SIZE,
            dst_nodrop.capacity() * P::SIZE / U8_SIZE,
        )
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
