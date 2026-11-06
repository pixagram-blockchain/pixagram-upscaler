//! Animated GIF and WebP, decoded one composited frame at a time.
//!
//! [`Animation`] owns the compressed file and exactly one RGBA canvas the size
//! of the image. [`Animation::next_frame`] decodes the next frame into a
//! frame-sized scratch buffer, applies the previous frame's disposal and
//! composites the new frame onto the canvas. An animation of any length is
//! therefore processed in the memory of one frame: frames are never stored,
//! and looping simply decodes again from the first frame
//! ([`Animation::rewind`]).
//!
//! Compositing follows what browsers display (Chromium/Skia and Firefox):
//!
//! * GIF: the canvas is the logical screen, enlarged to fit the first frame
//!   (Chromium does this for files that declare a zero or too-small screen).
//!   It starts transparent: the background colour index is ignored. Disposal
//!   "background" clears the frame rectangle to transparent, "previous"
//!   restores it. Palette indices past the colour table are opaque black.
//! * WebP: the canvas is cleared to transparent at the start of every loop
//!   (the ANIM background colour is only a hint, which browsers ignore).
//!   Blending is libwebp's non-premultiplied "over"; the dispose flag clears
//!   the frame rectangle before the next frame.
//! * Durations under 11 ms play as 100 ms ([`effective_delay`]), as in every
//!   major browser.
//! * The loop count is reported as total plays, 0 meaning forever: a GIF
//!   without a NETSCAPE2.0 block plays once and NETSCAPE `n` plays `n + 1`
//!   times; a WebP ANIM loop count of `n` plays `n` times.
//!
//! A frame that fails to decode after the first one ends the animation at the
//! last good frame (browsers keep showing what they could decode), and the
//! canvas is left untouched by the failed frame: every frame is decoded into
//! scratch memory before anything is composited.

use std::fmt;
use std::rc::Rc;

mod blend;
mod gif_source;
mod webp_source;

#[cfg(test)]
mod tests;

/// Largest canvas accepted by default: 16 MP (64 MiB of RGBA).
pub const DEFAULT_MAX_PIXELS: u64 = 16 * 1024 * 1024;

/// Frame durations below this many milliseconds play as [`MIN_DELAY_SUBSTITUTE_MS`].
pub const MIN_DELAY_MS: u32 = 11;
/// What browsers play instead of a duration under [`MIN_DELAY_MS`].
pub const MIN_DELAY_SUBSTITUTE_MS: u32 = 100;

/// The duration browsers actually give a frame that declares `raw_ms`.
#[inline]
pub fn effective_delay(raw_ms: u32) -> u32 {
    if raw_ms < MIN_DELAY_MS {
        MIN_DELAY_SUBSTITUTE_MS
    } else {
        raw_ms
    }
}

/// A decoding error, with a message suitable for a JavaScript `Error`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnimError(pub String);

impl AnimError {
    pub(crate) fn new(msg: impl Into<String>) -> Self {
        AnimError(msg.into())
    }
}

impl fmt::Display for AnimError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<gif::DecodingError> for AnimError {
    fn from(e: gif::DecodingError) -> Self {
        AnimError(format!("GIF: {e}"))
    }
}

impl From<image_webp::DecodingError> for AnimError {
    fn from(e: image_webp::DecodingError) -> Self {
        AnimError(format!("WebP: {e}"))
    }
}

/// Container format of an [`Animation`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Gif,
    Webp,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Gif => "gif",
            Format::Webp => "webp",
        }
    }
}

/// The compressed file, shared between the animation and its decoder (a GIF
/// decoder is re-created from it on every rewind).
#[derive(Clone)]
pub(crate) struct SharedBytes(Rc<Vec<u8>>);

impl SharedBytes {
    fn new(data: Vec<u8>) -> Self {
        SharedBytes(Rc::new(data))
    }
}

impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// A rectangle already clipped to the canvas.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

impl Rect {
    /// `x, y, w, h` (in any unit wide enough) clipped to a `cw x ch` canvas.
    pub fn clipped(x: u64, y: u64, w: u64, h: u64, cw: usize, ch: usize) -> Rect {
        let (cw, ch) = (cw as u64, ch as u64);
        let x0 = x.min(cw);
        let y0 = y.min(ch);
        let x1 = x.saturating_add(w).min(cw);
        let y1 = y.saturating_add(h).min(ch);
        Rect {
            x: x0 as usize,
            y: y0 as usize,
            w: (x1 - x0) as usize,
            h: (y1 - y0) as usize,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }
}

/// Clears `r` to transparent black.
pub(crate) fn clear_rect(canvas: &mut [u8], cw: usize, r: Rect) {
    for row in r.y..r.y + r.h {
        let start = (row * cw + r.x) * 4;
        canvas[start..start + r.w * 4].fill(0);
    }
}

/// Copies the pixels of `r` into `out` (resized to fit).
pub(crate) fn save_rect(canvas: &[u8], cw: usize, r: Rect, out: &mut Vec<u8>) {
    out.clear();
    for row in r.y..r.y + r.h {
        let start = (row * cw + r.x) * 4;
        out.extend_from_slice(&canvas[start..start + r.w * 4]);
    }
}

/// Writes back what [`save_rect`] saved for the same rectangle.
pub(crate) fn restore_rect(canvas: &mut [u8], cw: usize, r: Rect, saved: &[u8]) {
    let line = r.w * 4;
    for (i, row) in (r.y..r.y + r.h).enumerate() {
        let start = (row * cw + r.x) * 4;
        canvas[start..start + line].copy_from_slice(&saved[i * line..(i + 1) * line]);
    }
}

/// What a source reports for a frame it composited.
pub(crate) struct FrameMeta {
    /// Declared duration in milliseconds (before [`effective_delay`]).
    pub delay_ms: u32,
}

/// Header facts every source works out before the first frame.
pub(crate) struct Scan {
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub loop_count: u32,
    pub duration_ms: u64,
    pub animated: bool,
}

enum Source {
    Gif(Box<gif_source::GifSource>),
    Webp(webp_source::WebpSource),
}

/// Sniffs the container: `Some(Format)` for GIF87a/89a and RIFF/WEBP.
pub fn sniff(data: &[u8]) -> Option<Format> {
    if data.len() >= 6 && (&data[..6] == b"GIF87a" || &data[..6] == b"GIF89a") {
        Some(Format::Gif)
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some(Format::Webp)
    } else {
        None
    }
}

/// A GIF or WebP (animated or still) decoded one composited frame at a time.
pub struct Animation {
    format: Format,
    width: usize,
    height: usize,
    canvas: Vec<u8>,
    frame_count: u32,
    loop_count: u32,
    duration_ms: u64,
    animated: bool,
    /// Index of the frame on the canvas; `None` before the first frame.
    index: Option<u32>,
    raw_delay_ms: u32,
    /// Set when a loop has run out of frames; cleared by `rewind`.
    ended: bool,
    /// Set when a frame failed to decode and the animation was cut short.
    truncated: bool,
    source: Source,
}

impl Animation {
    /// Parses the headers of `data` (GIF or WebP) and allocates the canvas.
    /// No frame is decoded yet: call [`Animation::next_frame`] for frame 0.
    /// Canvases over `max_pixels` pixels are refused.
    pub fn open(data: Vec<u8>, max_pixels: u64) -> Result<Animation, AnimError> {
        let format = sniff(&data).ok_or_else(|| AnimError::new("not a GIF or WebP file"))?;
        let max_pixels = max_pixels.max(1);
        let data = SharedBytes::new(data);
        let (scan, source) = match format {
            Format::Gif => {
                let scan = gif_source::scan(data.as_ref())?;
                check_canvas(scan.width, scan.height, max_pixels)?;
                let src = gif_source::GifSource::new(data, max_pixels)?;
                (scan, Source::Gif(Box::new(src)))
            }
            Format::Webp => {
                let (scan, src) = webp_source::WebpSource::new(data, max_pixels)?;
                check_canvas(scan.width, scan.height, max_pixels)?;
                (scan, Source::Webp(src))
            }
        };
        let (width, height) = (scan.width as usize, scan.height as usize);
        let bytes = width * height * 4; // fits: check_canvas bounded it
        let mut canvas = Vec::new();
        canvas
            .try_reserve_exact(bytes)
            .map_err(|_| AnimError::new(format!("out of memory allocating a {width}x{height} canvas")))?;
        canvas.resize(bytes, 0);
        Ok(Animation {
            format,
            width,
            height,
            canvas,
            frame_count: scan.frames,
            loop_count: scan.loop_count,
            duration_ms: scan.duration_ms,
            animated: scan.animated,
            index: None,
            raw_delay_ms: 0,
            ended: false,
            truncated: false,
            source,
        })
    }

    pub fn format(&self) -> Format {
        self.format
    }

    /// Canvas width in pixels.
    pub fn width(&self) -> u32 {
        self.width as u32
    }

    /// Canvas height in pixels.
    pub fn height(&self) -> u32 {
        self.height as u32
    }

    /// Frames in one loop. Known from the headers up front; lowered if a frame
    /// later turns out to be undecodable.
    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Total plays, 0 = forever (see the module notes).
    pub fn loop_count(&self) -> u32 {
        self.loop_count
    }

    /// Sum of the effective durations of one loop, in milliseconds.
    pub fn duration_ms(&self) -> u64 {
        self.duration_ms
    }

    /// True for an animation with more than one frame.
    pub fn is_animated(&self) -> bool {
        self.animated && self.frame_count > 1
    }

    /// Index of the frame currently on the canvas (`None` before the first).
    pub fn index(&self) -> Option<u32> {
        self.index
    }

    /// Declared duration of the current frame, in milliseconds.
    pub fn raw_delay_ms(&self) -> u32 {
        self.raw_delay_ms
    }

    /// Duration browsers give the current frame, in milliseconds.
    pub fn delay_ms(&self) -> u32 {
        effective_delay(self.raw_delay_ms)
    }

    /// True once a frame failed to decode and the animation was cut short.
    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    /// The composited canvas: `width * height` RGBA pixels, not premultiplied.
    pub fn canvas(&self) -> &[u8] {
        &self.canvas
    }

    /// Decodes and composites the next frame. Returns `false` (canvas
    /// unchanged) when the loop has no more frames; [`Animation::rewind`]
    /// starts the next loop. An error is returned only for the first frame;
    /// a later undecodable frame ends the loop instead.
    pub fn next_frame(&mut self) -> Result<bool, AnimError> {
        if self.ended {
            return Ok(false);
        }
        let next = self.index.map_or(0, |i| i + 1);
        let (w, h) = (self.width, self.height);
        let result = match &mut self.source {
            Source::Gif(src) => src.next_frame(&mut self.canvas, w, h),
            Source::Webp(src) => src.next_frame(&mut self.canvas, w, h),
        };
        match result {
            Ok(Some(meta)) => {
                self.index = Some(next);
                self.raw_delay_ms = meta.delay_ms;
                if next >= self.frame_count {
                    // More frames than the header scan found (can only
                    // happen with unusual block layouts): keep counting.
                    self.frame_count = next + 1;
                }
                Ok(true)
            }
            Ok(None) => {
                self.ended = true;
                if next > 0 && next < self.frame_count {
                    self.frame_count = next;
                }
                Ok(false)
            }
            Err(e) if next == 0 => Err(e),
            Err(_) => {
                self.ended = true;
                self.truncated = true;
                self.frame_count = next;
                Ok(false)
            }
        }
    }

    /// Advances up to `n` frames (decoding and compositing each, as frames
    /// depend on their predecessors) and returns how many were advanced.
    pub fn skip_frames(&mut self, n: u32) -> Result<u32, AnimError> {
        let mut done = 0;
        while done < n && self.next_frame()? {
            done += 1;
        }
        Ok(done)
    }

    /// Starts over: transparent canvas, next frame is frame 0.
    pub fn rewind(&mut self) -> Result<(), AnimError> {
        match &mut self.source {
            Source::Gif(src) => src.rewind()?,
            Source::Webp(src) => src.rewind(),
        }
        self.canvas.fill(0);
        self.index = None;
        self.raw_delay_ms = 0;
        self.ended = false;
        Ok(())
    }
}

fn check_canvas(w: u32, h: u32, max_pixels: u64) -> Result<(), AnimError> {
    if w == 0 || h == 0 {
        return Err(AnimError::new("image has no area"));
    }
    let pixels = w as u64 * h as u64;
    let fits_memory = pixels
        .checked_mul(4)
        .is_some_and(|b| b <= (isize::MAX as u64).min(0x7FFF_0000));
    if pixels > max_pixels || !fits_memory {
        return Err(AnimError::new(format!(
            "{w}x{h} canvas exceeds the limit of {max_pixels} pixels"
        )));
    }
    Ok(())
}
