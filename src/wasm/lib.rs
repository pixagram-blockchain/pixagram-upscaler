//! RenderArt WASM Module
//! 
//! High-performance pixel art rendering engines for WebAssembly.

use wasm_bindgen::prelude::*;

mod crt;
mod hex;
mod xbrz;

// Optimization: Single shared output buffer for all renderers.
// This prevents memory fragmentation and reduces static overhead compared 
// to maintaining three separate large buffers.
static mut SHARED_BUFFER: Vec<u8> = Vec::new();

/// Result of an upscale operation
#[wasm_bindgen]
pub struct UpscaleResult {
    pub ptr: u32,
    pub len: u32,
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

/// Updates the shared buffer with new data and returns the WASM pointer result.
/// This consolidates the unsafe static mut access into one location.
#[inline(always)]
fn update_buffer(output: Vec<u8>, width: u32, height: u32) -> UpscaleResult {
    unsafe {
        // This drops the previous Vec (freeing its memory) and takes ownership of the new one.
        SHARED_BUFFER = output;
        
        UpscaleResult {
            ptr: SHARED_BUFFER.as_ptr() as u32,
            len: SHARED_BUFFER.len() as u32,
            width,
            height,
        }
    }
}

// ============================================================================
// CRT Functions
// ============================================================================

/// CRT upscale with default config
#[wasm_bindgen]
pub fn crt_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> UpscaleResult {
    crt_upscale_config(
        data, width, height, scale,
        0.015, 0.02,      // warp_x, warp_y
        -4.0, 0.5, 0.3,   // scan_hardness, scan_opacity, mask_opacity
        true, true, true  // enable_warp, enable_scanlines, enable_mask
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
    
    let output = crt::crt_upscale(data, width as usize, height as usize, scale as usize, &config);
    update_buffer(output, width * scale, height * scale)
}

// ============================================================================
// HEX Functions  
// ============================================================================

/// HEX upscale with default config
#[wasm_bindgen]
pub fn hex_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> UpscaleResult {
    hex_upscale_config(
        data, width, height, scale,
        0,           // orientation (flat-top)
        false,       // draw_borders
        0x282828FF,  // border_color
        1,           // border_thickness
        0x00000000   // background_color
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
    let config = hex::HexConfig {
        orientation: if orientation == 0 {
            hex::HexOrientation::FlatTop
        } else {
            hex::HexOrientation::PointyTop
        },
        draw_borders,
        border_color,
        border_thickness: border_thickness as usize,
        background_color,
    };
    
    let (out_width, out_height) = hex::get_output_dimensions(
        width as usize,
        height as usize,
        scale as usize,
        &config.orientation
    );
    
    let output = hex::hex_upscale(data, width as usize, height as usize, scale as usize, &config);
    update_buffer(output, out_width as u32, out_height as u32)
}

/// Get HEX output dimensions
#[wasm_bindgen]
pub fn hex_get_dimensions(width: u32, height: u32, scale: u32, orientation: u32) -> Vec<u32> {
    let orient = if orientation == 0 {
        hex::HexOrientation::FlatTop
    } else {
        hex::HexOrientation::PointyTop
    };
    
    let (out_w, out_h) = hex::get_output_dimensions(
        width as usize,
        height as usize,
        scale as usize,
        &orient
    );
    
    vec![out_w as u32, out_h as u32]
}

// ============================================================================
// XBRZ Functions
// ============================================================================

/// XBRZ upscale with default config
#[wasm_bindgen]
pub fn xbrz_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> UpscaleResult {
    xbrz_upscale_config(
        data, width, height, scale,
        30.0,  // equal_color_tolerance
        4.0,   // center_direction_bias
        3.6,   // dominant_direction_threshold
        2.2    // steep_direction_threshold
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
    
    let out_width = width * clamped_scale as u32;
    let out_height = height * clamped_scale as u32;
    
    update_buffer(output, out_width, out_height)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    fn create_test_image(w: usize, h: usize) -> Vec<u8> {
        let mut data = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                data[i] = (x * 255 / w) as u8;     // R
                data[i + 1] = (y * 255 / h) as u8; // G
                data[i + 2] = 128;                  // B
                data[i + 3] = 255;                  // A
            }
        }
        data
    }
    
    #[test]
    fn test_crt_basic() {
        let img = create_test_image(4, 4);
        let result = crt_upscale(&img, 4, 4, 2);
        assert_eq!(result.width, 8);
        assert_eq!(result.height, 8);
        assert_eq!(result.len, 8 * 8 * 4);
    }
    
    #[test]
    fn test_hex_dimensions() {
        let dims = hex_get_dimensions(4, 4, 16, 0);
        assert!(dims[0] > 0);
        assert!(dims[1] > 0);
    }
    
    #[test]
    fn test_hex_render() {
        let img = create_test_image(4, 4);
        let result = hex_upscale(&img, 4, 4, 8);
        assert!(result.width > 0);
        assert!(result.height > 0);
    }
    
    #[test]
    fn test_xbrz_basic() {
        let img = create_test_image(4, 4);
        let result = xbrz_upscale(&img, 4, 4, 2);
        assert_eq!(result.width, 8);
        assert_eq!(result.height, 8);
    }
    
    #[test]
    fn test_xbrz_scale_factors() {
        let img = create_test_image(4, 4);
        
        for scale in 2..=6 {
            let result = xbrz_upscale(&img, 4, 4, scale);
            assert_eq!(result.width, 4 * scale);
            assert_eq!(result.height, 4 * scale);
        }
    }
}
