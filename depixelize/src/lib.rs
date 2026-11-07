//! # depixelize
//!
//! Resolution-independent vectorization of pixel art — Kopf & Lischinski,
//! *Depixelizing Pixel Art* (SIGGRAPH 2011) — producing an SVG document.
//!
//! This crate is the fast twin of `depixelize.js`: for the same pixels and
//! options it emits **byte-identical** SVG. Every stage is a line-by-line port
//! running loops in the same order; all floating-point work uses the same
//! operation sequence, and the only transcendental functions of the algorithm
//! (angles, random directions) are replaced in both implementations by
//! deterministic `+ − × ÷` kernels (see `math.rs`).
//!
//! ```no_run
//! let rgba: Vec<u8> = vec![255; 16 * 16 * 4];
//! let svg = depixelize::depixelize(16, 16, &rgba, &depixelize::Options::default()).unwrap();
//! assert!(svg.starts_with("<svg"));
//! ```
//!
//! The SVG is in pixel units (`viewBox` = image size, `width`/`height` = size
//! × `scale`) with coordinates rounded to `precision` decimals, so numbers stay
//! small at any scale. [`depixelize_into`] reuses a caller's buffer.
//!
//! Smoothing ([`Smooth`]) is the paper's random relaxation by default, or an
//! opt-in deterministic pattern search ([`Smooth::Fast`]) that reaches the
//! same smoothness with a fraction of the work.
//!
//! On `wasm32` the crate exports a small C ABI (see `wasm.rs`) with persistent
//! input/output buffers, driven by `depixelize-wasm.mjs`. Build with
//! `-C target-feature=+simd128` to evaluate two random candidates per `f64x2`
//! vector, and a whole fast-mode visit (four positions) per `f32x4` vector
//! (identical results either way).

// `!(x > 0.0)`-style tests are deliberate: like the JS reference, NaN must
// take the fallback branch.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

mod fast;
mod math;
mod optimize;
mod pipeline;
mod svg;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use pipeline::Mode;

/// How the curve control points are optimised (paper §3.4).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Smooth {
    /// Keep the control points on the pixel lattice.
    Off,
    /// The paper's random relaxation: `iterations` sweeps of `guesses` random
    /// moves within `guess_offset`, seeded by `seed`. JS: `smooth: true`.
    #[default]
    Paper,
    /// Deterministic pattern search on the same energy, in f32: four positions
    /// per visit (one `f32x4` with simd128), steps of 2×, 1× and ½×
    /// `guess_offset`, sleeping points skipped; at most `iterations` sweeps.
    /// About as smooth as `Paper` with ~10× less work. JS: `smooth: 'fast'`.
    Fast,
}

impl From<bool> for Smooth {
    fn from(on: bool) -> Self {
        if on { Smooth::Paper } else { Smooth::Off }
    }
}

/// Options — same meaning and defaults as the JS options object.
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    /// Output size: SVG width/height = image size × scale (≤ 0 or NaN → 40; max 10⁶).
    pub scale: f64,
    /// Decimals of the coordinates, in pixel units (max 6). `None` = automatic:
    /// the coarsest grid that keeps every point within ¼ output pixel at `scale`
    /// (2 decimals at scale 40, 1 at scale 4).
    pub precision: Option<u32>,
    /// Region grouping, see [`Mode`].
    pub mode: Mode,
    /// Curve optimisation, see [`Smooth`].
    pub smooth: Smooth,
    /// Relaxation sweeps (fast mode: the maximum).
    pub iterations: i32,
    /// Random candidates per control point per sweep (paper mode).
    pub guesses: i32,
    /// Max displacement of one candidate, in pixels (fast mode: steps of 2×, 1×, ½× this).
    pub guess_offset: f64,
    /// σ (pixels) of the colour interpolation inside multi-colour regions; 0 = flat cells.
    pub shading: f64,
    /// PRNG seed.
    pub seed: i32,
    /// Prefix for SVG ids (default: derived from a hash of input and options).
    pub id_prefix: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            scale: 40.0,
            precision: None,
            mode: Mode::Auto,
            smooth: Smooth::Paper,
            iterations: 20,
            guesses: 20,
            guess_offset: 0.05,
            shading: 0.7,
            seed: 1,
            id_prefix: None,
        }
    }
}

/// Why an image could not be vectorized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// Width or height is zero.
    EmptyImage,
    /// Fewer than `width * height * 3` bytes of pixel data.
    DataTooShort,
    /// Internal consistency check failed (never expected; please report).
    Internal(&'static str),
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Error::EmptyImage => f.write_str("depixelize: image must be at least 1×1"),
            Error::DataTooShort => f.write_str("depixelize: pixel data too short"),
            Error::Internal(m) => write!(f, "depixelize: internal error: {m}"),
        }
    }
}

impl std::error::Error for Error {}

/// Vectorizes an RGBA (or RGB) image into an SVG string.
pub fn depixelize(width: u32, height: u32, pixels: &[u8], opts: &Options) -> Result<String, Error> {
    let bytes = depixelize_to_vec(width, height, pixels, opts)?;
    // The writer only emits ASCII.
    Ok(String::from_utf8(bytes).expect("SVG output is ASCII"))
}

/// Like [`depixelize`] but returns the UTF-8 bytes of the SVG.
pub fn depixelize_to_vec(width: u32, height: u32, pixels: &[u8], opts: &Options) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    depixelize_into(&mut out, width, height, pixels, opts)?;
    Ok(out)
}

/// Like [`depixelize_to_vec`] but writes into `out` (cleared first; its
/// capacity is reused, so repeated calls do not reallocate the output).
pub fn depixelize_into(out: &mut Vec<u8>, width: u32, height: u32, pixels: &[u8], opts: &Options) -> Result<(), Error> {
    // The JS option string `[scale, mode, shading, smooth, iterations, guesses,
    // guessOffset, seed, precision].join('|')`, which seeds the SVG id hash.
    let mut key = Vec::new();
    svg::push_js_num(&mut key, opts.scale);
    key.push(b'|');
    key.extend_from_slice(match opts.mode {
        Mode::Auto => b"auto",
        Mode::Cell => b"cell",
        Mode::Shape => b"shape",
    });
    key.push(b'|');
    svg::push_js_num(&mut key, opts.shading);
    key.push(b'|');
    key.extend_from_slice(match opts.smooth {
        Smooth::Off => b"false",
        Smooth::Paper => b"true",
        Smooth::Fast => b"fast",
    });
    for v in [opts.iterations as f64, opts.guesses as f64, opts.guess_offset, opts.seed as f64] {
        key.push(b'|');
        svg::push_js_num(&mut key, v);
    }
    key.push(b'|');
    match opts.precision {
        None => key.extend_from_slice(b"auto"),
        Some(p) => svg::push_js_num(&mut key, p as f64),
    }
    let key16: Vec<u16> = key.iter().map(|&b| b as u16).collect();
    let precision = opts.precision.map_or(-1, |p| p.min(6) as i32);
    run(
        out,
        width as usize,
        height as usize,
        pixels,
        opts.mode,
        opts.smooth,
        opts.iterations,
        opts.guesses,
        opts.guess_offset,
        opts.seed,
        opts.scale,
        opts.shading,
        precision,
        &key16,
        opts.id_prefix.as_deref(),
    )
}

/// Full pipeline with raw option values (shared by the Rust API and the wasm
/// ABI), normalised exactly like `normalize` in depixelize.js. `precision` < 0
/// means automatic; `opt_key` is the JS option string as UTF-16 units.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run(
    out: &mut Vec<u8>,
    w: usize,
    h: usize,
    pixels: &[u8],
    mode: Mode,
    smooth: Smooth,
    iterations: i32,
    guesses: i32,
    guess_offset: f64,
    seed: i32,
    scale: f64,
    shading: f64,
    precision: i32,
    opt_key: &[u16],
    id_prefix: Option<&str>,
) -> Result<(), Error> {
    if w == 0 || h == 0 {
        return Err(Error::EmptyImage);
    }
    let n = w.checked_mul(h).ok_or(Error::EmptyImage)?;
    if pixels.len() < n.saturating_mul(3) {
        return Err(Error::DataTooShort);
    }
    let scale = if scale > 0.0 { scale.min(1e6) } else { 40.0 };
    let sigma = if shading > 0.0 { shading.min(1000.0) } else { 0.0 };
    let precision = if precision < 0 { svg::auto_precision(scale) } else { (precision as usize).min(6) };
    let mut pd = pipeline::PixelData::new(w, h, pixels, mode).map_err(Error::Internal)?;
    match smooth {
        Smooth::Off => {}
        Smooth::Paper => pd.optimize(iterations, guesses, guess_offset, seed),
        Smooth::Fast => pd.optimize_fast(iterations, guess_offset),
    }
    pd.finalize();
    let id = match id_prefix {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => svg::hash_id(&pd, opt_key),
    };
    *out = svg::SvgWriter::new(&pd, scale, sigma, precision, &id, std::mem::take(out)).render();
    Ok(())
}
