//! GIF frames, composited onto the animation canvas one at a time.

use std::io::Cursor;
use std::num::NonZeroU64;

use gif::{ColorOutput, DecodeOptions, Decoder, DisposalMethod, MemoryLimit};

use super::{
    clear_rect, effective_delay, restore_rect, save_rect, AnimError, FrameMeta, Rect, Scan,
    SharedBytes,
};

#[inline]
fn u16le(d: &[u8], at: usize) -> u32 {
    d[at] as u32 | (d[at + 1] as u32) << 8
}

/// Skips a chain of data sub-blocks starting at `p`; returns the position
/// after the terminator, or `None` if the file ends first.
fn skip_sub_blocks(d: &[u8], mut p: usize) -> Option<usize> {
    loop {
        let n = *d.get(p)? as usize;
        p += 1;
        if n == 0 {
            return Some(p);
        }
        p += n;
        if p > d.len() {
            return None;
        }
    }
}

/// Header walk without decoding any pixel data: canvas size (logical screen
/// enlarged to fit the first frame, as Chromium does), number of complete
/// frames, loop count (total plays, 0 = forever) and total duration. Stops at
/// the trailer, at an unknown block or where the file is truncated.
pub(crate) fn scan(d: &[u8]) -> Result<Scan, AnimError> {
    if d.len() < 13 || &d[..3] != b"GIF" {
        return Err(AnimError::new("not a GIF file"));
    }
    let screen_w = u16le(d, 6);
    let screen_h = u16le(d, 8);
    let packed = d[10];
    let mut p = 13usize;
    if packed & 0x80 != 0 {
        p += 3usize << ((packed & 7) + 1);
    }
    let mut frames = 0u32;
    let mut duration_ms = 0u64;
    let mut pending_delay = 0u32;
    let mut loop_count = 1u32; // no NETSCAPE2.0 block: play once
    let mut first: Option<(u32, u32, u32, u32)> = None;
    while let Some(&block) = d.get(p) {
        match block {
            0x21 => {
                let Some(&label) = d.get(p + 1) else { break };
                p += 2;
                if label == 0xF9 {
                    // Graphic Control Extension: [4, packed, delay lo, delay hi, transparent]
                    if let Some(sub) = d.get(p..p + 5) {
                        if sub[0] >= 4 {
                            pending_delay = u16le(sub, 2) * 10;
                        }
                    }
                } else if label == 0xFF {
                    // Application extension: NETSCAPE2.0 / ANIMEXTS1.0 loop count.
                    if let Some(id) = d.get(p..p + 12) {
                        if id[0] == 11 && (&id[1..12] == b"NETSCAPE2.0" || &id[1..12] == b"ANIMEXTS1.0") {
                            if let Some(sub) = d.get(p + 12..p + 16) {
                                if sub[0] >= 3 && sub[1] == 1 {
                                    let n = u16le(sub, 2);
                                    loop_count = if n == 0 { 0 } else { n + 1 };
                                }
                            }
                        }
                    }
                }
                match skip_sub_blocks(d, p) {
                    Some(next) => p = next,
                    None => break,
                }
            }
            0x2C => {
                let Some(desc) = d.get(p..p + 10) else { break };
                let rect = (u16le(desc, 1), u16le(desc, 3), u16le(desc, 5), u16le(desc, 7));
                let local = desc[9];
                p += 10;
                if local & 0x80 != 0 {
                    p += 3usize << ((local & 7) + 1);
                }
                p += 1; // LZW minimum code size
                match skip_sub_blocks(d, p) {
                    Some(next) => p = next,
                    None => break, // truncated frame: not counted
                }
                if first.is_none() {
                    first = Some(rect);
                }
                frames += 1;
                duration_ms += effective_delay(pending_delay) as u64;
                pending_delay = 0;
            }
            _ => break, // trailer (0x3B) or an unknown block
        }
    }
    let Some((fx, fy, fw, fh)) = first else {
        return Err(AnimError::new("GIF has no complete frame"));
    };
    let width = screen_w.max(fx + fw);
    let height = screen_h.max(fy + fh);
    Ok(Scan {
        width,
        height,
        frames,
        loop_count,
        duration_ms,
        animated: frames > 1,
    })
}

/// What the frame on the canvas leaves behind for the next one.
enum Pending {
    None,
    /// Clear to transparent ("restore to background").
    Clear(Rect),
    /// Put back what the frame covered ("restore to previous").
    Restore(Rect),
}

pub(crate) struct GifSource {
    data: SharedBytes,
    decoder: Decoder<Cursor<SharedBytes>>,
    max_pixels: u64,
    /// Palette indices of the frame being decoded (frame-sized scratch).
    indices: Vec<u8>,
    /// Canvas pixels under a frame with "restore to previous" disposal.
    saved: Vec<u8>,
    pending: Pending,
}

fn open_decoder(data: &SharedBytes, max_pixels: u64) -> Result<Decoder<Cursor<SharedBytes>>, AnimError> {
    let mut options = DecodeOptions::new();
    options.set_color_output(ColorOutput::Indexed);
    // Indexed output: one byte per pixel.
    options.set_memory_limit(MemoryLimit::Bytes(NonZeroU64::new(max_pixels.max(1)).unwrap()));
    Ok(options.read_info(Cursor::new(data.clone()))?)
}

impl GifSource {
    pub fn new(data: SharedBytes, max_pixels: u64) -> Result<GifSource, AnimError> {
        let decoder = open_decoder(&data, max_pixels)?;
        Ok(GifSource {
            data,
            decoder,
            max_pixels,
            indices: Vec::new(),
            saved: Vec::new(),
            pending: Pending::None,
        })
    }

    pub fn rewind(&mut self) -> Result<(), AnimError> {
        self.decoder = open_decoder(&self.data, self.max_pixels)?;
        self.pending = Pending::None;
        self.saved = Vec::new();
        Ok(())
    }

    /// Decodes the next frame and composites it onto `canvas` (`cw x ch`).
    /// `Ok(None)` at the end of the stream; the canvas is only touched once
    /// the frame has decoded completely.
    pub fn next_frame(&mut self, canvas: &mut [u8], cw: usize, ch: usize) -> Result<Option<FrameMeta>, AnimError> {
        let Some(frame) = self.decoder.next_frame_info()? else {
            return Ok(None);
        };
        let (left, top) = (frame.left as u64, frame.top as u64);
        let (fw, fh) = (frame.width as usize, frame.height as usize);
        let dispose = frame.dispose;
        let transparent = frame.transparent;
        let interlaced = frame.interlaced;
        let delay_ms = frame.delay as u32 * 10;

        let n = fw * fh;
        if n as u64 > self.max_pixels {
            return Err(AnimError::new(format!("GIF frame {fw}x{fh} exceeds the pixel limit")));
        }
        if self.indices.len() < n {
            self.indices
                .try_reserve(n - self.indices.len())
                .map_err(|_| AnimError::new("out of memory decoding a GIF frame"))?;
            self.indices.resize(n, 0);
        }
        // Rows in stream order. `read_into_buffer` would deinterlace, but gif
        // 0.14 fails row-by-row fills of interlaced frames ("image
        // truncated") on valid files; filling the whole frame and mapping the
        // interlace passes to canvas rows below avoids that path entirely.
        if n > 0 && !self.decoder.fill_buffer(&mut self.indices[..n])? {
            return Err(AnimError::new("GIF: image truncated"));
        }

        // The frame decoded: now (and only now) touch the canvas.
        match std::mem::replace(&mut self.pending, Pending::None) {
            Pending::None => {}
            Pending::Clear(r) => clear_rect(canvas, cw, r),
            Pending::Restore(r) => restore_rect(canvas, cw, r, &self.saved),
        }

        let rect = Rect::clipped(left, top, fw as u64, fh as u64, cw, ch);
        if dispose == DisposalMethod::Previous && !rect.is_empty() {
            save_rect(canvas, cw, rect, &mut self.saved);
        }

        if !rect.is_empty() {
            let palette = self.decoder.palette()?;
            let paint = Paint {
                palette,
                colors: palette.len() / 3,
                transparent: transparent.map_or(usize::MAX, |t| t as usize),
                rect,
                frame_x: left as usize,
                frame_y: top as usize,
                cw,
            };
            if interlaced {
                // Stream row k belongs to the k-th row of the four passes.
                let mut k = 0;
                for (start, step) in [(0, 8), (4, 8), (2, 4), (1, 2)] {
                    let mut y = start;
                    while y < fh {
                        paint.row(canvas, &self.indices[k * fw..(k + 1) * fw], y);
                        k += 1;
                        y += step;
                    }
                }
            } else {
                for y in 0..fh {
                    paint.row(canvas, &self.indices[y * fw..(y + 1) * fw], y);
                }
            }
        }

        self.pending = match dispose {
            _ if rect.is_empty() => Pending::None,
            DisposalMethod::Background => Pending::Clear(rect),
            DisposalMethod::Previous => Pending::Restore(rect),
            DisposalMethod::Any | DisposalMethod::Keep => Pending::None,
        };
        Ok(Some(FrameMeta { delay_ms }))
    }
}

/// Paints rows of one frame's palette indices onto the canvas.
struct Paint<'a> {
    palette: &'a [u8],
    colors: usize,
    transparent: usize,
    /// The frame rectangle clipped to the canvas.
    rect: Rect,
    frame_x: usize,
    frame_y: usize,
    cw: usize,
}

impl Paint<'_> {
    /// Paints frame row `y` (`src` holds the frame's full row of indices).
    #[inline]
    fn row(&self, canvas: &mut [u8], src: &[u8], y: usize) {
        let r = self.rect;
        let cy = self.frame_y + y;
        if cy < r.y || cy >= r.y + r.h {
            return; // clipped away
        }
        let src = &src[r.x - self.frame_x..][..r.w];
        let start = (cy * self.cw + r.x) * 4;
        let dst = &mut canvas[start..start + r.w * 4];
        for (px, &idx) in dst.chunks_exact_mut(4).zip(src) {
            let idx = idx as usize;
            // The transparent index leaves the canvas as it is.
            if idx == self.transparent {
                continue;
            }
            if idx < self.colors {
                px[0] = self.palette[idx * 3];
                px[1] = self.palette[idx * 3 + 1];
                px[2] = self.palette[idx * 3 + 2];
            } else {
                // Past the colour table: opaque black, as Chromium draws it
                // (its table is padded to 256 entries with black).
                px[..3].fill(0);
            }
            px[3] = 255;
        }
    }
}
