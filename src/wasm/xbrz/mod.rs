//! A high quality image upscaling algorithm designed to preserve key details in low-resolution pixel art.
use std::mem;

use self::config::ScalerConfig;
use self::oob_reader::OobReaderTransparent;
use self::pixel::{Pixel, Rgba8};
use self::scaler::{Scaler, Scaler2x, Scaler3x, Scaler4x, Scaler5x, Scaler6x};

// Fixed: Removed unused import
// pub use self::config::ScalerConfig as XbrzScalerConfig;

mod blend;
pub mod config;
mod kernel;
mod matrix;
mod oob_reader;
mod pixel;
mod scaler;
mod ycbcr_lookup;

/// Use the xBRZ algorithm to scale up an image by an integer factor.
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

fn scale<P: Pixel>(source: &[u8], src_width: usize, src_height: usize, factor: usize) -> Vec<u8> {
    let config = ScalerConfig::default();
    scale_with_config::<P>(source, src_width, src_height, factor, &config)
}

fn scale_with_config<P: Pixel>(
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
            0 => unreachable!(),
            1 => unreachable!(),
            2 => Scaler2x::scale_image::<P, OobReaderTransparent<P>>(
                src_argb,
                dst_argb.as_mut_slice(),
                src_width,
                src_height,
                config,
                0..src_height,
            ),
            3 => Scaler3x::scale_image::<P, OobReaderTransparent<P>>(
                src_argb,
                dst_argb.as_mut_slice(),
                src_width,
                src_height,
                config,
                0..src_height,
            ),
            4 => Scaler4x::scale_image::<P, OobReaderTransparent<P>>(
                src_argb,
                dst_argb.as_mut_slice(),
                src_width,
                src_height,
                config,
                0..src_height,
            ),
            5 => Scaler5x::scale_image::<P, OobReaderTransparent<P>>(
                src_argb,
                dst_argb.as_mut_slice(),
                src_width,
                src_height,
                config,
                0..src_height,
            ),
            6 => Scaler6x::scale_image::<P, OobReaderTransparent<P>>(
                src_argb,
                dst_argb.as_mut_slice(),
                src_width,
                src_height,
                config,
                0..src_height,
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
