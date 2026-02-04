//! RenderArt WASM Module
//!
//! High-performance pixel art rendering engines for WebAssembly.

use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod crt;
mod hex;
mod xbrz;

// Thread-local shared buffer - safe, no `unsafe` needed for access
thread_local! {
    static SHARED_BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

/// Result of an upscale operation
#[wasm_bindgen]
pub struct UpscaleResult {
    pub ptr: u32,
    pub len: u32,
    pub width: u32,
    pub height: u32,
}

/// Result of dimension calculation (avoids Vec allocation)
#[wasm_bindgen]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

/// Get WASM memory for reading output buffers
#[wasm_bindgen]
pub fn get_memory() -> JsValue {
    wasm_bindgen::memory()
}

// ============================================================================
// Internal Helpers
// ============================================================================

/// Updates the shared buffer, reusing capacity when possible.
#[inline]
fn update_buffer(output: Vec<u8>, width: u32, height: u32) -> UpscaleResult {
    SHARED_BUFFER.with(|buf| {
        let mut buffer = buf.borrow_mut();
        
        // Reuse existing capacity if sufficient, otherwise take the new buffer
        if buffer.capacity() >= output.len() {
            buffer.clear();
            buffer.extend_from_slice(&output);
        } else {
            *buffer = output;
        }

        UpscaleResult {
            ptr: buffer.as_ptr() as u32,
            len: buffer.len() as u32,
            width,
            height,
        }
    })
}

/// Updates buffer by writing directly into pre-sized buffer (zero-copy path).
/// Use when the renderer can write into a provided slice.
#[inline]
fn with_buffer<F>(required_len: usize, width: u32, height: u32, f: F) -> UpscaleResult
where
    F: FnOnce(&mut [u8]),
{
    SHARED_BUFFER.with(|buf| {
        let mut buffer = buf.borrow_mut();

        // Ensure capacity and set length
        if buffer.len() < required_len {
            buffer.resize(required_len, 0);
        } else {
            // Reuse existing memory, just adjust view
            buffer.truncate(required_len);
        }

        // Let renderer write directly
        f(&mut buffer[..required_len]);

        UpscaleResult {
            ptr: buffer.as_ptr() as u32,
            len: required_len as u32,
            width,
            height,
        }
    })
}

// ============================================================================
// CRT Functions
// ============================================================================

/// CRT upscale with default config
#[wasm_bindgen]
pub fn crt_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> UpscaleResult {
    crt_upscale_config(
        data, width, height, scale,
        0.015, 0.02,
        -4.0, 0.5, 0.3,
        true, true, true,
    )
}

/// CRT upscale with full config
#[wasm_bindgen]
pub fn crt_upscale_config(
    data: &[u8],
    width: u32,
    height: u32,
    scale: u32,
    warp_x: f32,
    warp_y: f32,
    scan_hardness: f32,
    scan_opacity: f32,
    mask_opacity: f32,
    enable_warp: bool,
    enable_scanlines: bool,
    enable_mask: bool,
) -> UpscaleResult {
    let config = crt::CrtConfig {
        warp_x,
        warp_y,
        scan_hardness,
        scan_opacity,
        mask_opacity,
        enable_warp,
        enable_scanlines,
        enable_mask,
    };

    let out_w = width * scale;
    let out_h = height * scale;
    let required = (out_w * out_h * 4) as usize;

    // If your crt module supports writing to a slice, use with_buffer:
    // with_buffer(required, out_w, out_h, |out| {
    //     crt::crt_upscale_into(data, width as usize, height as usize, scale as usize, &config, out);
    // })
    
    // Otherwise, use the allocating path:
    let output = crt::crt_upscale(data, width as usize, height as usize, scale as usize, &config);
    update_buffer(output, out_w, out_h)
}

// ============================================================================
// HEX Functions
// ============================================================================

/// Get HEX output dimensions (no allocation)
#[wasm_bindgen]
pub fn hex_get_dimensions(width: u32, height: u32, scale: u32, orientation: u32) -> Dimensions {
    let orient = if orientation == 0 {
        hex::HexOrientation::FlatTop
    } else {
        hex::HexOrientation::PointyTop
    };

    let (out_w, out_h) = hex::get_output_dimensions(
        width as usize,
        height as usize,
        scale as usize,
        &orient,
    );

    Dimensions {
        width: out_w as u32,
        height: out_h as u32,
    }
}

/// HEX upscale with default config
#[wasm_bindgen]
pub fn hex_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> UpscaleResult {
    hex_upscale_config(
        data, width, height, scale,
        0,
        false,
        0x282828FF,
        1,
        0x00000000,
    )
}

/// HEX upscale with full config
#[wasm_bindgen]
pub fn hex_upscale_config(
    data: &[u8],
    width: u32,
    height: u32,
    scale: u32,
    orientation: u32,
    draw_borders: bool,
    border_color: u32,
    border_thickness: u32,
    background_color: u32,
) -> UpscaleResult {
    let orient = if orientation == 0 {
        hex::HexOrientation::FlatTop
    } else {
        hex::HexOrientation::PointyTop
    };

    let config = hex::HexConfig {
        orientation: orient.clone(),
        draw_borders,
        border_color,
        border_thickness: border_thickness as usize,
        background_color,
    };

    // Calculate dimensions once
    let (out_w, out_h) = hex::get_output_dimensions(
        width as usize,
        height as usize,
        scale as usize,
        &orient,
    );

    // If hex module can take pre-computed dimensions to avoid recalculating:
    // let output = hex::hex_upscale_with_dims(data, width as usize, height as usize, scale as usize, &config, out_w, out_h);
    
    let output = hex::hex_upscale(data, width as usize, height as usize, scale as usize, &config);
    update_buffer(output, out_w as u32, out_h as u32)
}

// ============================================================================
// XBRZ Functions
// ============================================================================

/// XBRZ upscale with default config
#[wasm_bindgen]
pub fn xbrz_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> UpscaleResult {
    xbrz_upscale_config(
        data, width, height, scale,
        30.0, 4.0, 3.6, 2.2,
    )
}

/// XBRZ upscale with full config
#[wasm_bindgen]
pub fn xbrz_upscale_config(
    data: &[u8],
    width: u32,
    height: u32,
    scale: u32,
    equal_color_tolerance: f64,
    center_direction_bias: f64,
    dominant_direction_threshold: f64,
    steep_direction_threshold: f64,
) -> UpscaleResult {
    let clamped_scale = scale.clamp(1, 6) as usize;
    let out_w = width * clamped_scale as u32;
    let out_h = height * clamped_scale as u32;

    let output = xbrz::xbrz_upscale(
        data,
        width as usize,
        height as usize,
        clamped_scale,
        equal_color_tolerance,
        center_direction_bias,
        dominant_direction_threshold,
        steep_direction_threshold,
    );

    update_buffer(output, out_w, out_h)
}
