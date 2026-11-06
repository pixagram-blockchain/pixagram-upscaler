//! WebP frames, composited onto the animation canvas one at a time.
//!
//! The RIFF container is walked here, not by `image-webp`'s animation API:
//! that API cannot clear its canvas between loops, applies disposal only when
//! a background colour has been set, and clears the wrong pixels when it
//! disposes under an opaque partial frame. Each ANMF frame's bitstream (ALPH +
//! VP8, VP8 or VP8L) is wrapped in a minimal still-image container and decoded
//! with `image-webp`'s still decoder; compositing is done here.

use std::io::Cursor;

use image_webp::WebPDecoder;

use super::blend::over_nonpremult;
use super::{clear_rect, effective_delay, AnimError, FrameMeta, Rect, Scan, SharedBytes};

#[inline]
fn u16le(d: &[u8], at: usize) -> u32 {
    d[at] as u32 | (d[at + 1] as u32) << 8
}

#[inline]
fn u24le(d: &[u8], at: usize) -> u32 {
    d[at] as u32 | (d[at + 1] as u32) << 8 | (d[at + 2] as u32) << 16
}

#[inline]
fn u32le(d: &[u8], at: usize) -> u32 {
    u24le(d, at) | (d[at + 3] as u32) << 24
}

/// One RIFF chunk: fourcc, payload range, and where the next chunk starts.
struct Chunk {
    fourcc: [u8; 4],
    start: usize,
    end: usize,
    next: usize,
}

/// Reads the chunk header at `p`; `None` if it (or its payload) runs past
/// `limit`.
fn chunk_at(d: &[u8], p: usize, limit: usize) -> Option<Chunk> {
    if p.checked_add(8)? > limit {
        return None;
    }
    let size = u32le(d, p + 4) as usize;
    let start = p + 8;
    let end = start.checked_add(size)?;
    if end > limit {
        return None;
    }
    let next = end + (size & 1);
    Some(Chunk {
        fourcc: [d[p], d[p + 1], d[p + 2], d[p + 3]],
        start,
        end,
        next,
    })
}

/// Where the next frame comes from.
enum Kind {
    /// A still image (VP8, VP8L, or VP8X without the animation flag),
    /// decoded whole as the single frame.
    Still { done: bool },
    /// ANMF frames from `first` up to `limit`.
    Animated { first: usize, next: usize, limit: usize },
}

pub(crate) struct WebpSource {
    data: SharedBytes,
    kind: Kind,
    max_pixels: u64,
    /// Rectangle of the frame on the canvas, if it is to be cleared before
    /// the next frame (its dispose flag was set).
    dispose: Option<Rect>,
    /// A frame's bitstream wrapped as a still image (scratch).
    container: Vec<u8>,
    /// Decoded frame pixels, RGB or RGBA (scratch).
    pixels: Vec<u8>,
}

impl WebpSource {
    /// Parses the container and returns its header facts.
    pub fn new(data: SharedBytes, max_pixels: u64) -> Result<(Scan, WebpSource), AnimError> {
        let d = data.as_ref();
        if d.len() < 20 || &d[..4] != b"RIFF" || &d[8..12] != b"WEBP" {
            return Err(AnimError::new("not a WebP file"));
        }
        // Tolerate a RIFF size that overstates the file (truncated download):
        // walk what is there.
        let limit = (8 + u32le(d, 4) as usize).min(d.len());
        let first = chunk_at(d, 12, limit).ok_or_else(|| AnimError::new("WebP: truncated header"))?;
        let mut scan = Scan {
            width: 0,
            height: 0,
            frames: 1,
            loop_count: 1,
            duration_ms: 0,
            animated: false,
        };
        let kind = if &first.fourcc == b"VP8X" && first.end - first.start >= 10 && d[first.start] & 0x02 != 0 {
            let x = first.start;
            scan.width = 1 + u24le(d, x + 4);
            scan.height = 1 + u24le(d, x + 7);
            scan.animated = true;
            scan.frames = 0;
            let mut first_anmf = None;
            let mut p = first.next;
            while let Some(c) = chunk_at(d, p, limit) {
                match &c.fourcc {
                    b"ANIM" if c.end - c.start >= 6 => {
                        let n = u16le(d, c.start + 4);
                        scan.loop_count = n; // 0 = forever, else total plays
                    }
                    b"ANMF" if c.end - c.start >= 16 => {
                        first_anmf.get_or_insert(p);
                        scan.frames += 1;
                        scan.duration_ms += effective_delay(u24le(d, c.start + 12)) as u64;
                    }
                    _ => {}
                }
                p = c.next;
            }
            let first = first_anmf.ok_or_else(|| AnimError::new("WebP: animation has no frames"))?;
            Kind::Animated { first, next: first, limit }
        } else {
            // Still image: let the decoder validate it and report its size.
            let dec = WebPDecoder::new(Cursor::new(d))?;
            let (w, h) = dec.dimensions();
            scan.width = w;
            scan.height = h;
            Kind::Still { done: false }
        };
        Ok((
            scan,
            WebpSource {
                data,
                kind,
                max_pixels,
                dispose: None,
                container: Vec::new(),
                pixels: Vec::new(),
            },
        ))
    }

    pub fn rewind(&mut self) {
        match &mut self.kind {
            Kind::Still { done } => *done = false,
            Kind::Animated { first, next, .. } => *next = *first,
        }
        self.dispose = None;
    }

    /// Decodes the next frame and composites it onto `canvas` (`cw x ch`).
    pub fn next_frame(&mut self, canvas: &mut [u8], cw: usize, ch: usize) -> Result<Option<FrameMeta>, AnimError> {
        match self.kind {
            Kind::Still { done: true } => Ok(None),
            Kind::Still { done: false } => {
                let (w, h, alpha) = decode_still(self.data.as_ref(), self.max_pixels, &mut self.pixels)?;
                if w as usize != cw || h as usize != ch {
                    return Err(AnimError::new("WebP: image size changed while decoding"));
                }
                write_frame(canvas, cw, &self.pixels, alpha, Rect { x: 0, y: 0, w: cw, h: ch }, false);
                self.kind = Kind::Still { done: true };
                Ok(Some(FrameMeta { delay_ms: 0 }))
            }
            Kind::Animated { first, next, limit } => {
                let d = self.data.as_ref();
                // Next ANMF chunk (other chunks between frames are skipped).
                let mut p = next;
                let anmf = loop {
                    let Some(c) = chunk_at(d, p, limit) else { return Ok(None) };
                    if &c.fourcc == b"ANMF" && c.end - c.start >= 16 {
                        break c;
                    }
                    p = c.next;
                };
                let h0 = anmf.start;
                let fx = 2 * u24le(d, h0) as usize;
                let fy = 2 * u24le(d, h0 + 3) as usize;
                let fw = 1 + u24le(d, h0 + 6) as usize;
                let fh = 1 + u24le(d, h0 + 9) as usize;
                let delay_ms = u24le(d, h0 + 12);
                let flags = d[h0 + 15];
                let blend = flags & 0x02 == 0;
                let dispose = flags & 0x01 != 0;
                if fx + fw > cw || fy + fh > ch {
                    return Err(AnimError::new("WebP: frame outside the canvas"));
                }
                if fw as u64 * fh as u64 > self.max_pixels {
                    return Err(AnimError::new("WebP: frame exceeds the pixel limit"));
                }

                // Frame data: [ALPH] VP8 | VP8L, then optional unknown chunks.
                let mut alph = None;
                let mut bitstream = None;
                let mut q = h0 + 16;
                while let Some(c) = chunk_at(d, q, anmf.end) {
                    match &c.fourcc {
                        b"ALPH" if alph.is_none() => alph = Some(c.start..c.end),
                        b"VP8 " | b"VP8L" => {
                            bitstream = Some((c.fourcc, c.start..c.end));
                            break;
                        }
                        _ => {}
                    }
                    q = c.next;
                }
                let (fourcc, range) = bitstream.ok_or_else(|| AnimError::new("WebP: frame has no bitstream"))?;
                let alph = if &fourcc == b"VP8 " { alph.map(|r| &d[r]) } else { None };
                wrap_still(&mut self.container, alph, &fourcc, &d[range], fw as u32, fh as u32);
                let (w, h, alpha) = decode_still(&self.container, self.max_pixels, &mut self.pixels)?;
                if (w as usize, h as usize) != (fw, fh) {
                    return Err(AnimError::new("WebP: frame size disagrees with its bitstream"));
                }

                // Decoded: now (and only now) touch the canvas.
                if let Some(r) = self.dispose.take() {
                    clear_rect(canvas, cw, r);
                }
                let rect = Rect { x: fx, y: fy, w: fw, h: fh };
                write_frame(canvas, cw, &self.pixels, alpha, rect, blend);
                self.dispose = dispose.then_some(rect);
                self.kind = Kind::Animated { first, next: anmf.next, limit };
                Ok(Some(FrameMeta { delay_ms }))
            }
        }
    }
}

/// Wraps one frame's bitstream as a still WebP: `VP8L` or `VP8 ` alone, or
/// `VP8X` (alpha flag) + `ALPH` + `VP8 ` for lossy frames with alpha.
fn wrap_still(out: &mut Vec<u8>, alph: Option<&[u8]>, fourcc: &[u8; 4], bitstream: &[u8], w: u32, h: u32) {
    fn chunk(out: &mut Vec<u8>, fourcc: &[u8], payload: &[u8]) {
        out.extend_from_slice(fourcc);
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        if payload.len() & 1 == 1 {
            out.push(0);
        }
    }
    out.clear();
    out.extend_from_slice(b"RIFF\0\0\0\0WEBP");
    if let Some(alph) = alph {
        let (w1, h1) = ((w - 1).to_le_bytes(), (h - 1).to_le_bytes());
        let vp8x = [0x10, 0, 0, 0, w1[0], w1[1], w1[2], h1[0], h1[1], h1[2]];
        chunk(out, b"VP8X", &vp8x);
        chunk(out, b"ALPH", alph);
    }
    chunk(out, fourcc, bitstream);
    let riff = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff.to_le_bytes());
}

/// Decodes a still WebP into `pixels` (RGBA if it has alpha, else RGB).
fn decode_still(file: &[u8], max_pixels: u64, pixels: &mut Vec<u8>) -> Result<(u32, u32, bool), AnimError> {
    let mut dec = WebPDecoder::new(Cursor::new(file))?;
    let (w, h) = dec.dimensions();
    if w as u64 * h as u64 > max_pixels {
        return Err(AnimError::new(format!("WebP: {w}x{h} exceeds the pixel limit")));
    }
    let alpha = dec.has_alpha();
    let n = dec
        .output_buffer_size()
        .ok_or_else(|| AnimError::new("WebP: image too large"))?;
    dec.set_memory_limit((max_pixels as usize).saturating_mul(8));
    if pixels.len() != n {
        pixels.clear();
        pixels
            .try_reserve(n)
            .map_err(|_| AnimError::new("out of memory decoding a WebP frame"))?;
        pixels.resize(n, 0);
    }
    dec.read_image(pixels)?;
    Ok((w, h, alpha))
}

/// Writes decoded pixels into `rect` of the canvas: RGB as opaque, RGBA
/// either copied or blended over what is there.
fn write_frame(canvas: &mut [u8], cw: usize, pixels: &[u8], alpha: bool, rect: Rect, blend: bool) {
    let bpp = if alpha { 4 } else { 3 };
    for row in 0..rect.h {
        let src = &pixels[row * rect.w * bpp..][..rect.w * bpp];
        let start = ((rect.y + row) * cw + rect.x) * 4;
        let dst = &mut canvas[start..start + rect.w * 4];
        if !alpha {
            for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(3)) {
                d[..3].copy_from_slice(s);
                d[3] = 255;
            }
        } else if !blend {
            dst.copy_from_slice(src);
        } else {
            for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                let out = over_nonpremult([s[0], s[1], s[2], s[3]], [d[0], d[1], d[2], d[3]]);
                d.copy_from_slice(&out);
            }
        }
    }
}
