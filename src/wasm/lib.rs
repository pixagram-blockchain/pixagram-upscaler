//! RenderArt WASM Module
//!
//! High-performance pixel art rendering engines for WebAssembly.
//!
//! Every renderer writes into one module-owned output buffer that is reused
//! across calls (no per-frame allocation). Each call returns an
//! [`UpscaleResult`] whose `ptr`/`len` locate the pixels in
//! `get_memory().buffer`; the view stays valid until the next render call (or
//! a memory growth). Invalid arguments throw a JavaScript `Error` instead of
//! trapping, so a bad call never leaves the instance unusable.

use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod crt;
mod hex;
mod xbrz;

#[cfg(test)]
mod golden_tests;

// Multi-threaded builds (`--features parallel`) re-export the pool initialiser.
#[cfg(all(feature = "parallel", target_arch = "wasm32"))]
pub use wasm_bindgen_rayon::init_thread_pool;

thread_local! {
    /// Shared output buffer, `u32`-backed so it is always 4-byte aligned (the
    /// xBRZ engine writes whole pixels). Only ever grows; its length is the
    /// high-water mark, so steady-state calls neither allocate nor re-zero.
    static SHARED_BUFFER: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
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

/// Largest output the module will attempt (bytes). A wasm32 `Vec` can hold at
/// most `isize::MAX` bytes, so ~2 GiB is the real ceiling.
const MAX_OUTPUT_BYTES: u64 = 0x7FFF_0000;

/// Bytes of a `w x h` RGBA image, or an error if `data` is shorter.
fn input_len(data: &[u8], w: u32, h: u32) -> Result<usize, JsError> {
    // u32 * u32 * 4 can exceed u64, so never trust the plain product.
    let need = (w as u64)
        .checked_mul(h as u64)
        .and_then(|p| p.checked_mul(4))
        .filter(|&n| n <= usize::MAX as u64)
        .ok_or_else(|| JsError::new(&format!("{w}x{h} RGBA input is too large")))?;
    if (data.len() as u64) < need {
        return Err(JsError::new(&format!(
            "input holds {} bytes but {}x{} RGBA needs {}",
            data.len(),
            w,
            h,
            need
        )));
    }
    Ok(need as usize)
}

/// Output dimensions and byte length, checked against overflow and the
/// module's addressable size.
fn output_size(out_w: u64, out_h: u64) -> Result<(u32, u32, usize), JsError> {
    let bytes = out_w.checked_mul(out_h).and_then(|p| p.checked_mul(4));
    match bytes {
        Some(b) if out_w <= u32::MAX as u64 && out_h <= u32::MAX as u64 && b <= MAX_OUTPUT_BYTES => {
            Ok((out_w as u32, out_h as u32, b as usize))
        }
        _ => Err(JsError::new(&format!(
            "output {out_w}x{out_h} exceeds the WebAssembly memory limit (~2 GiB)"
        ))),
    }
}

/// Runs `f` with a mutable byte view of the shared output buffer, sized to
/// exactly `len` bytes (`len % 4 == 0`). Renderers passed here must write
/// *every* byte (the `*_into` functions do), so stale data never leaks.
///
/// The buffer is moved out of its cell for the duration of the render: should
/// a renderer ever trap, the buffer is leaked but the module stays usable
/// (the cell is never left borrowed).
fn with_buffer<F>(len: usize, width: u32, height: u32, f: F) -> Result<UpscaleResult, JsError>
where
    F: FnOnce(&mut [u8]) -> Result<(), JsError>,
{
    debug_assert_eq!(len % 4, 0);
    let mut buffer = SHARED_BUFFER.with(|b| std::mem::take(&mut *b.borrow_mut()));
    let words = len / 4;
    let grown = if buffer.len() < words {
        // Grow once; report allocation failure instead of aborting.
        let have = buffer.len();
        buffer
            .try_reserve_exact(words - have)
            .map(|_| buffer.resize(words, 0))
            .map_err(|_| JsError::new(&format!("out of memory allocating {len} bytes")))
    } else {
        Ok(())
    };
    let result = grown.and_then(|_| {
        if len == 0 {
            Ok(()) // nothing to render (zero-area output)
        } else {
            f(bytemuck::cast_slice_mut(&mut buffer[..words]))
        }
    });
    let ptr = buffer.as_ptr() as u32;
    SHARED_BUFFER.with(|b| *b.borrow_mut() = buffer);
    result.map(|_| UpscaleResult {
        ptr,
        len: len as u32,
        width,
        height,
    })
}

fn scratch_error(e: xbrz::ScratchError) -> JsError {
    JsError::new(&format!("out of memory allocating {} bytes of xBRZ scratch", e.bytes))
}

/// Releases the shared output buffer (e.g. after a one-off large render).
/// The next call allocates again. WebAssembly memory itself never shrinks,
/// but the space becomes reusable by the module.
#[wasm_bindgen]
pub fn release_buffers() {
    SHARED_BUFFER.with(|buf| {
        if let Ok(mut b) = buf.try_borrow_mut() {
            *b = Vec::new();
        }
    });
}

// ============================================================================
// CRT Functions
// ============================================================================

/// CRT upscale with default config
#[wasm_bindgen]
pub fn crt_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> Result<UpscaleResult, JsError> {
    crt_upscale_config(
        data, width, height, scale,
        0.015, 0.02,
        -4.0, 0.5, 0.3,
        true, true, true,
    )
}

/// CRT upscale with full config
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
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
) -> Result<UpscaleResult, JsError> {
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

    // Mirror the clamp inside crt_upscale_into so the reported dimensions
    // and the buffer size always agree with what the renderer produces.
    let scale = scale.clamp(2, 32);
    let n = input_len(data, width, height)?;
    let (out_w, out_h, required) = output_size(width as u64 * scale as u64, height as u64 * scale as u64)?;

    with_buffer(required, out_w, out_h, |out| {
        crt::crt_upscale_into(
            &data[..n],
            width as usize,
            height as usize,
            scale as usize,
            &config,
            out,
        );
        Ok(())
    })
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
pub fn hex_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> Result<UpscaleResult, JsError> {
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
#[allow(clippy::too_many_arguments)]
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
) -> Result<UpscaleResult, JsError> {
    let orient = if orientation == 0 {
        hex::HexOrientation::FlatTop
    } else {
        hex::HexOrientation::PointyTop
    };

    let config = hex::HexConfig {
        orientation: orient,
        draw_borders,
        border_color,
        border_thickness: border_thickness as usize,
        background_color,
    };

    let n = input_len(data, width, height)?;
    // get_output_dimensions applies the same scale clamp as hex_upscale_into,
    // so `required` always matches the renderer's own size assertion.
    let (out_w, out_h) = hex::get_output_dimensions(
        width as usize,
        height as usize,
        scale as usize,
        &orient,
    );
    let (out_w, out_h, required) = output_size(out_w as u64, out_h as u64)?;

    with_buffer(required, out_w, out_h, |out| {
        hex::hex_upscale_into(
            &data[..n],
            width as usize,
            height as usize,
            scale as usize,
            &config,
            out,
        );
        Ok(())
    })
}

// ============================================================================
// XBRZ Functions
// ============================================================================

/// XBRZ upscale with default config
#[wasm_bindgen]
pub fn xbrz_upscale(data: &[u8], width: u32, height: u32, scale: u32) -> Result<UpscaleResult, JsError> {
    xbrz_upscale_config(
        data, width, height, scale,
        30.0, 4.0, 3.6, 2.2,
    )
}

/// XBRZ upscale with full config. `scale` is clamped to 1..=8.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn xbrz_upscale_config(
    data: &[u8],
    width: u32,
    height: u32,
    scale: u32,
    equal_color_tolerance: f64,
    center_direction_bias: f64,
    dominant_direction_threshold: f64,
    steep_direction_threshold: f64,
) -> Result<UpscaleResult, JsError> {
    // Mirror the clamp inside xbrz_upscale_into so the reported dimensions
    // and the buffer size always agree with what the renderer produces.
    let s = scale.clamp(1, 8);
    let n = input_len(data, width, height)?;
    let (out_w, out_h, required) = output_size(width as u64 * s as u64, height as u64 * s as u64)?;

    with_buffer(required, out_w, out_h, |out| {
        xbrz::try_xbrz_upscale_into(
            &data[..n],
            width as usize,
            height as usize,
            s as usize,
            equal_color_tolerance,
            center_direction_bias,
            dominant_direction_threshold,
            steep_direction_threshold,
            bytemuck::cast_slice_mut(out),
        )
        .map_err(scratch_error)
    })
}

/// Renders only source rows `[y0, y1)` of a `width x height` image: the
/// result holds destination rows `[y0 * scale, y1 * scale)`.
///
/// `window` carries source rows `[window_y0, window_y0 + window.len() / (4 *
/// width))`, which must cover `[y0 - 2, y1 + 2)` clipped to the image (the
/// kernel's halo). Bands rendered independently - e.g. one per Web Worker -
/// and stacked are byte-identical to a full render. `scale` must be 2..=8.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn xbrz_upscale_band(
    window: &[u8],
    width: u32,
    height: u32,
    window_y0: u32,
    y0: u32,
    y1: u32,
    scale: u32,
    equal_color_tolerance: f64,
    center_direction_bias: f64,
    dominant_direction_threshold: f64,
    steep_direction_threshold: f64,
) -> Result<UpscaleResult, JsError> {
    if !(2..=8).contains(&scale) {
        return Err(JsError::new("band rendering needs a scale in 2..=8"));
    }
    // Bound dimensions first, so no 32-bit arithmetic below can wrap.
    let max = xbrz::MAX_DIM as u64;
    if width == 0 || width as u64 > max || height as u64 > max {
        return Err(JsError::new(&format!("width must be 1..={max} and height <= {max}")));
    }
    if !(y0 < y1 && y1 <= height) {
        return Err(JsError::new("band rows must satisfy y0 < y1 <= height"));
    }
    let row_bytes = width as u64 * 4;
    if window.len() as u64 % row_bytes != 0 {
        return Err(JsError::new("window length must be a whole number of rows"));
    }
    let win_rows = window.len() as u64 / row_bytes;
    let need0 = (y0 as u64).saturating_sub(2);
    let need1 = (y1 as u64 + 2).min(height as u64);
    let wy0 = window_y0 as u64;
    if wy0 > need0 || wy0 + win_rows < need1 || wy0 + win_rows > height as u64 {
        return Err(JsError::new(&format!(
            "window rows [{}, {}) must cover [{}, {}) within the image",
            wy0,
            wy0 + win_rows,
            need0,
            need1
        )));
    }
    let (out_w, out_h, required) = output_size(width as u64 * scale as u64, (y1 - y0) as u64 * scale as u64)?;
    let config = xbrz::ScalerConfig {
        equal_color_tolerance,
        center_direction_bias,
        dominant_direction_threshold,
        steep_direction_threshold,
    };
    with_buffer(required, out_w, out_h, |out| {
        xbrz::scale_band_into_u32(
            window,
            width as usize,
            height as usize,
            window_y0 as usize,
            scale as usize,
            y0 as usize,
            y1 as usize,
            &config,
            bytemuck::cast_slice_mut(out),
        )
        .map_err(scratch_error)
    })
}

// ============================================================================
// Native benchmark hooks (not part of the wasm API)
// ============================================================================
#[doc(hidden)]
pub mod bench_api {
    pub fn crt(data: &[u8], w: usize, h: usize, scale: usize) -> Vec<u8> {
        crate::crt::crt_upscale(data, w, h, scale, &crate::crt::CrtConfig::default())
    }
    pub fn crt_into(data: &[u8], w: usize, h: usize, scale: usize, out: &mut [u8]) {
        crate::crt::crt_upscale_into(data, w, h, scale, &crate::crt::CrtConfig::default(), out)
    }
    pub fn hex(data: &[u8], w: usize, h: usize, scale: usize, borders: bool) -> Vec<u8> {
        let cfg = crate::hex::HexConfig { draw_borders: borders, ..Default::default() };
        crate::hex::hex_upscale(data, w, h, scale, &cfg)
    }
    pub fn hex_dims(w: usize, h: usize, scale: usize) -> (usize, usize) {
        crate::hex::get_output_dimensions(w, h, scale, &crate::hex::HexOrientation::FlatTop)
    }
    pub fn hex_into(data: &[u8], w: usize, h: usize, scale: usize, borders: bool, out: &mut [u8]) {
        let cfg = crate::hex::HexConfig { draw_borders: borders, ..Default::default() };
        crate::hex::hex_upscale_into(data, w, h, scale, &cfg, out)
    }
    pub fn xbrz(data: &[u8], w: usize, h: usize, scale: usize) -> Vec<u8> {
        crate::xbrz::xbrz_upscale(data, w, h, scale, 30.0, 4.0, 3.6, 2.2)
    }
    pub fn xbrz_into(data: &[u8], w: usize, h: usize, scale: usize, out: &mut [u8]) {
        crate::xbrz::xbrz_upscale_into(data, w, h, scale, 30.0, 4.0, 3.6, 2.2, out)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn xbrz_config(data: &[u8], w: usize, h: usize, scale: usize, tol: f64, bias: f64, dom: f64, steep: f64) -> Vec<u8> {
        crate::xbrz::xbrz_upscale(data, w, h, scale, tol, bias, dom, steep)
    }
    /// Renders source rows [y0, y1) only (destination rows [y0*scale, y1*scale)).
    /// `window` = source rows [wy0, ..) (pass wy0 = 0 and the whole image for no windowing).
    pub fn xbrz_band_window(window: &[u8], w: usize, h: usize, wy0: usize, scale: usize, y0: usize, y1: usize) -> Vec<u8> {
        let mut out = vec![0u32; w * scale * (y1 - y0) * scale];
        crate::xbrz::scale_band_into_u32(window, w, h, wy0, scale, y0, y1, &Default::default(), &mut out).unwrap();
        out.iter().flat_map(|p| p.to_ne_bytes()).collect()
    }
    pub fn xbrz_band(data: &[u8], w: usize, h: usize, scale: usize, y0: usize, y1: usize) -> Vec<u8> {
        let mut out = vec![0u32; w * scale * (y1 - y0) * scale];
        crate::xbrz::scale_band_into_u32(data, w, h, 0, scale, y0, y1, &Default::default(), &mut out).unwrap();
        out.iter().flat_map(|p| p.to_ne_bytes()).collect()
    }
}
