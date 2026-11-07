//! WebAssembly ABI (no imports, no wasm-bindgen), driven by depixelize-wasm.mjs.
//!
//! The module owns three persistent buffers, so a call allocates nothing on
//! the JS side and nothing is copied twice:
//!
//! * `dpx_input(len)` → pointer to the pixel buffer (grown to ≥ `len` bytes,
//!   capacity kept). JS writes the pixels there — or hands out a view of it so
//!   the caller can fill it directly (zero-copy input).
//! * `dpx_args(len)` → pointer to a small buffer for the option string
//!   (UTF-16LE, seeds the id hash) followed by the optional id prefix (UTF-8).
//! * `dpx_run(...)` → status (0 ok, 1 empty image, 2 data too short,
//!   3 internal error). The SVG is then at `dpx_output_ptr()`, `dpx_output_len()`
//!   bytes long — JS decodes it straight from a view (zero-copy output). It
//!   stays valid until the next `dpx_run`.
//!
//! A pointer stays valid until the next call that may grow the same buffer;
//! growing linear memory never moves existing data.

use crate::{run, Error, Mode, Smooth};
use std::cell::UnsafeCell;

struct Buffers {
    input: Vec<u8>,
    args: Vec<u8>,
    output: Vec<u8>,
}

/// wasm32 without threads is single-threaded: one global set of buffers.
struct Global(UnsafeCell<Buffers>);
// SAFETY: this module is only built for single-threaded wasm32.
unsafe impl Sync for Global {}
static STATE: Global = Global(UnsafeCell::new(Buffers { input: Vec::new(), args: Vec::new(), output: Vec::new() }));

#[inline]
fn state() -> &'static mut Buffers {
    // SAFETY: single-threaded, and no exported function holds this reference
    // across a call into another exported function.
    unsafe { &mut *STATE.0.get() }
}

#[inline]
fn ensure(v: &mut Vec<u8>, len: usize) -> *mut u8 {
    if v.len() < len {
        v.resize(len, 0);
    }
    v.as_mut_ptr()
}

/// Pixel buffer of at least `len` bytes.
#[unsafe(no_mangle)]
pub extern "C" fn dpx_input(len: usize) -> *mut u8 {
    ensure(&mut state().input, len)
}

/// Argument buffer of at least `len` bytes.
#[unsafe(no_mangle)]
pub extern "C" fn dpx_args(len: usize) -> *mut u8 {
    ensure(&mut state().args, len)
}

/// The SVG written by the last successful [`dpx_run`].
#[unsafe(no_mangle)]
pub extern "C" fn dpx_output_ptr() -> *const u8 {
    state().output.as_ptr()
}

/// Length in bytes of the SVG written by the last successful [`dpx_run`].
#[unsafe(no_mangle)]
pub extern "C" fn dpx_output_len() -> usize {
    state().output.len()
}

/// Releases the persistent buffers (they are re-grown on demand).
#[unsafe(no_mangle)]
pub extern "C" fn dpx_release() {
    let s = state();
    s.input = Vec::new();
    s.args = Vec::new();
    s.output = Vec::new();
}

/// 1 when this build evaluates candidates with `simd128` (f64x2 paper mode, f32x4 fast mode).
#[unsafe(no_mangle)]
pub extern "C" fn dpx_simd() -> u32 {
    cfg!(target_feature = "simd128") as u32
}

/// ABI version (bump on incompatible changes).
#[unsafe(no_mangle)]
pub extern "C" fn dpx_abi() -> u32 {
    4
}

/// Runs the whole pipeline on `input[..px_len]` with the option string
/// (`key_units` UTF-16 units) and id prefix (`id_len` bytes) from the
/// argument buffer. `smooth`: 0 off, 1 paper, 2 fast. `precision` < 0 =
/// automatic. See the module docs.
#[allow(clippy::too_many_arguments)]
#[unsafe(no_mangle)]
pub extern "C" fn dpx_run(
    px_len: usize,
    width: u32,
    height: u32,
    mode: u32,
    smooth: u32,
    iterations: i32,
    guesses: i32,
    guess_offset: f64,
    seed: i32,
    scale: f64,
    shading: f64,
    precision: i32,
    key_units: usize,
    id_len: usize,
) -> u32 {
    let s = state();
    let pixels = &s.input[..px_len.min(s.input.len())];
    let args = &s.args;
    let key_end = (key_units * 2).min(args.len());
    let key: Vec<u16> = args[..key_end].chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
    let id = if id_len > 0 {
        std::str::from_utf8(&args[key_end..(key_end + id_len).min(args.len())]).ok()
    } else {
        None
    };
    let mode = match mode {
        1 => Mode::Cell,
        2 => Mode::Shape,
        _ => Mode::Auto,
    };
    let result = run(
        &mut s.output,
        width as usize,
        height as usize,
        pixels,
        mode,
        match smooth {
            0 => Smooth::Off,
            2 => Smooth::Fast,
            _ => Smooth::Paper,
        },
        iterations,
        guesses,
        guess_offset,
        seed,
        scale,
        shading,
        precision,
        &key,
        id,
    );
    match result {
        Ok(()) => 0,
        Err(Error::EmptyImage) => 1,
        Err(Error::DataTooShort) => 2,
        Err(Error::Internal(_)) => 3,
    }
}
