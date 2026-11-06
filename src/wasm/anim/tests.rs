//! FrameDecoder tests: fixtures are encoded here (GIF with the `gif` crate,
//! animated WebP from `image-webp`'s lossless encoder wrapped in ANMF chunks)
//! and every composited frame is compared with a deliberately naive reference
//! compositor that works on whole canvases.

use std::borrow::Cow;

use gif::DisposalMethod;

use super::blend::over_nonpremult;
use super::{effective_delay, Animation, Format, DEFAULT_MAX_PIXELS};

// ───────────────────────────── GIF fixtures ─────────────────────────────

const PALETTE: [u8; 18] = [
    0, 0, 0, // 0 black
    255, 0, 0, // 1 red
    0, 255, 0, // 2 green
    0, 0, 255, // 3 blue
    255, 255, 255, // 4 white
    9, 9, 9, // 5 transparent key in the tests
];

#[derive(Clone)]
struct GifFrame {
    left: u16,
    top: u16,
    w: u16,
    h: u16,
    indices: Vec<u8>,
    transparent: Option<u8>,
    dispose: DisposalMethod,
    delay_cs: u16,
    palette: Option<Vec<u8>>,
    interlaced: bool,
}

impl GifFrame {
    fn solid(left: u16, top: u16, w: u16, h: u16, idx: u8, dispose: DisposalMethod) -> GifFrame {
        GifFrame {
            left,
            top,
            w,
            h,
            indices: vec![idx; w as usize * h as usize],
            transparent: None,
            dispose,
            delay_cs: 5,
            palette: None,
            interlaced: false,
        }
    }
}

fn gif_file(screen: (u16, u16), frames: &[GifFrame], repeat: Option<gif::Repeat>) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = gif::Encoder::new(&mut out, screen.0, screen.1, &PALETTE).unwrap();
        if let Some(r) = repeat {
            enc.set_repeat(r).unwrap();
        }
        for f in frames {
            let frame = gif::Frame {
                left: f.left,
                top: f.top,
                width: f.w,
                height: f.h,
                buffer: Cow::Borrowed(&f.indices),
                transparent: f.transparent,
                dispose: f.dispose,
                delay: f.delay_cs,
                palette: f.palette.clone(),
                interlaced: f.interlaced,
                ..gif::Frame::default()
            };
            enc.write_frame(&frame).unwrap();
        }
    }
    out
}

/// Whole-canvas reference: what each GIF frame should look like.
fn gif_reference(canvas: (usize, usize), frames: &[GifFrame]) -> Vec<Vec<u8>> {
    let (cw, ch) = canvas;
    let mut cur = vec![0u8; cw * ch * 4];
    let mut out = Vec::new();
    let mut before_prev: Option<Vec<u8>> = None;
    let mut clear: Option<(usize, usize, usize, usize)> = None;
    for f in frames {
        if let Some((x, y, w, h)) = clear.take() {
            for yy in y..(y + h).min(ch) {
                for xx in x..(x + w).min(cw) {
                    cur[(yy * cw + xx) * 4..][..4].fill(0);
                }
            }
        }
        if let Some(saved) = before_prev.take() {
            cur = saved;
        }
        let snapshot = cur.clone();
        let palette = f.palette.as_deref().unwrap_or(&PALETTE);
        for fy in 0..f.h as usize {
            for fx in 0..f.w as usize {
                let (x, y) = (f.left as usize + fx, f.top as usize + fy);
                if x >= cw || y >= ch {
                    continue;
                }
                let idx = f.indices[fy * f.w as usize + fx];
                if Some(idx) == f.transparent {
                    continue;
                }
                let px = match palette.get(idx as usize * 3..idx as usize * 3 + 3) {
                    Some(p) => [p[0], p[1], p[2], 255],
                    None => [0, 0, 0, 255], // past the colour table: black
                };
                cur[(y * cw + x) * 4..][..4].copy_from_slice(&px);
            }
        }
        out.push(cur.clone());
        match f.dispose {
            DisposalMethod::Background => clear = Some((f.left as usize, f.top as usize, f.w as usize, f.h as usize)),
            // Restoring the whole canvas snapshot equals restoring the rect:
            // only the rect changed since the snapshot.
            DisposalMethod::Previous => before_prev = Some(snapshot),
            _ => {}
        }
    }
    out
}

fn decode_all(anim: &mut Animation) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    while anim.next_frame().unwrap() {
        frames.push(anim.canvas().to_vec());
    }
    frames
}

fn assert_frames_eq(got: &[Vec<u8>], want: &[Vec<u8>], w: usize) {
    assert_eq!(got.len(), want.len(), "frame count");
    for (i, (g, e)) in got.iter().zip(want).enumerate() {
        if g != e {
            let first = g.chunks(4).zip(e.chunks(4)).position(|(a, b)| a != b).unwrap();
            panic!(
                "frame {i} differs first at ({}, {}): got {:?} want {:?}",
                first % w,
                first / w,
                &g[first * 4..first * 4 + 4],
                &e[first * 4..first * 4 + 4]
            );
        }
    }
}

fn disposal_sequence() -> Vec<GifFrame> {
    use DisposalMethod::*;
    let mut f1 = GifFrame::solid(1, 1, 3, 3, 2, Previous);
    f1.indices[0] = 5; // transparent corner shows the red below
    f1.indices[4] = 3;
    f1.transparent = Some(5);
    let mut f3 = GifFrame::solid(0, 0, 2, 2, 4, Keep);
    f3.indices[3] = 5;
    f3.transparent = Some(5);
    vec![
        GifFrame::solid(0, 0, 5, 5, 1, Keep),     // red background
        f1,                                       // green square, then restored
        GifFrame::solid(2, 2, 3, 3, 3, Background), // blue square, then cleared
        f3,                                       // white corner over the hole
        GifFrame::solid(4, 0, 1, 5, 0, Any),      // black column
    ]
}

#[test]
fn gif_disposal_and_transparency_match_reference() {
    let frames = disposal_sequence();
    let file = gif_file((5, 5), &frames, Some(gif::Repeat::Infinite));
    let mut anim = Animation::open(file, DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!(anim.format(), Format::Gif);
    assert_eq!((anim.width(), anim.height()), (5, 5));
    assert_eq!(anim.frame_count(), 5);
    assert_eq!(anim.loop_count(), 0);
    assert!(anim.is_animated());
    let got = decode_all(&mut anim);
    assert_frames_eq(&got, &gif_reference((5, 5), &frames), 5);
}

#[test]
fn gif_rewind_replays_identically_with_one_canvas() {
    let frames = disposal_sequence();
    let mut anim = Animation::open(gif_file((5, 5), &frames, None), DEFAULT_MAX_PIXELS).unwrap();
    let ptr = anim.canvas().as_ptr();
    let first = decode_all(&mut anim);
    assert!(!anim.next_frame().unwrap(), "stays at the end until rewound");
    for _ in 0..3 {
        anim.rewind().unwrap();
        assert_eq!(anim.index(), None);
        assert!(anim.canvas().iter().all(|&b| b == 0), "rewind clears the canvas");
        let again = decode_all(&mut anim);
        assert_eq!(first, again);
        assert_eq!(anim.canvas().as_ptr(), ptr, "the canvas is never reallocated");
    }
}

#[test]
fn gif_canvas_grows_to_fit_the_first_frame_and_later_frames_are_clipped() {
    use DisposalMethod::*;
    let frames = vec![
        GifFrame::solid(0, 0, 4, 3, 1, Keep),  // larger than the 2x2 screen
        GifFrame::solid(2, 1, 9, 9, 2, Keep),  // runs off the canvas
        GifFrame::solid(30, 30, 2, 2, 3, Background), // entirely outside
        GifFrame::solid(0, 0, 1, 1, 4, Keep),
    ];
    let mut anim = Animation::open(gif_file((2, 2), &frames, None), DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!((anim.width(), anim.height()), (4, 3));
    let got = decode_all(&mut anim);
    assert_frames_eq(&got, &gif_reference((4, 3), &frames), 4);
}

#[test]
fn gif_local_palettes_interlacing_and_out_of_range_indices() {
    use DisposalMethod::*;
    // Display rows get colour (y % 4) + 1. An interlaced frame stores rows
    // pass by pass (0, 8 | 4 | 2, 6 | 1, 3, 5, 7), so write them that way.
    let mut f0 = GifFrame::solid(0, 0, 3, 9, 1, Keep);
    f0.interlaced = true;
    let stream_rows = [0usize, 8, 4, 2, 6, 1, 3, 5, 7];
    for (k, &y) in stream_rows.iter().enumerate() {
        f0.indices[k * 3..k * 3 + 3].fill((y % 4) as u8 + 1);
    }
    let mut f1 = GifFrame::solid(0, 0, 3, 3, 1, Keep);
    f1.palette = Some(vec![10, 20, 30, 40, 50, 60]); // two colours
    f1.indices = vec![0, 1, 7, 1, 0, 200, 1, 1, 0]; // 7 and 200: no such colour
    let frames = vec![f0.clone(), f1];
    let mut anim = Animation::open(gif_file((3, 9), &frames, None), DEFAULT_MAX_PIXELS).unwrap();
    let got = decode_all(&mut anim);
    // The reference works in display order.
    let mut shown = frames.clone();
    shown[0].interlaced = false;
    for y in 0..9 {
        shown[0].indices[y * 3..y * 3 + 3].fill((y % 4) as u8 + 1);
    }
    assert_frames_eq(&got, &gif_reference((3, 9), &shown), 3);
    // Out-of-range indices (7, 200) are opaque black, as Chromium draws them.
    assert_eq!(&got[1][2 * 4..2 * 4 + 4], &[0, 0, 0, 255]);
    assert_eq!(&got[1][5 * 4..5 * 4 + 4], &[0, 0, 0, 255]);
}

#[test]
fn gif_loop_counts_and_delays() {
    use DisposalMethod::*;
    let mut frames = vec![GifFrame::solid(0, 0, 1, 1, 1, Keep), GifFrame::solid(0, 0, 1, 1, 2, Keep)];
    frames[0].delay_cs = 0; // plays as 100 ms
    frames[1].delay_cs = 2; // 20 ms is honoured
    let cases = [(None, 1), (Some(gif::Repeat::Infinite), 0), (Some(gif::Repeat::Finite(2)), 3)];
    for (repeat, plays) in cases {
        let mut anim = Animation::open(gif_file((1, 1), &frames, repeat), DEFAULT_MAX_PIXELS).unwrap();
        assert_eq!(anim.loop_count(), plays, "{repeat:?}");
        assert_eq!(anim.duration_ms(), 120);
        assert!(anim.next_frame().unwrap());
        assert_eq!((anim.raw_delay_ms(), anim.delay_ms()), (0, 100));
        assert!(anim.next_frame().unwrap());
        assert_eq!((anim.raw_delay_ms(), anim.delay_ms()), (20, 20));
    }
    assert_eq!(effective_delay(10), 100);
    assert_eq!(effective_delay(11), 11);
}

#[test]
fn gif_single_frame_is_not_animated() {
    let frames = vec![GifFrame::solid(0, 0, 2, 2, 3, DisposalMethod::Keep)];
    let mut anim = Animation::open(gif_file((2, 2), &frames, None), DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!(anim.frame_count(), 1);
    assert!(!anim.is_animated());
    assert!(anim.next_frame().unwrap());
    assert_eq!(&anim.canvas()[..4], &[0, 0, 255, 255]);
    assert!(!anim.next_frame().unwrap());
}

#[test]
fn gif_truncated_file_plays_the_complete_frames() {
    let frames = disposal_sequence();
    let full = gif_file((5, 5), &frames, None);
    let want = gif_reference((5, 5), &frames);
    // Cut inside the last frame's image data.
    let cut = full.len() - 6;
    let mut anim = Animation::open(full[..cut].to_vec(), DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!(anim.frame_count(), 4, "the scan counts complete frames only");
    let got = decode_all(&mut anim);
    assert_eq!(got.len(), 4);
    assert_frames_eq(&got, &want[..4], 5);
    // The failed frame left the canvas alone.
    assert_eq!(anim.canvas(), &want[3][..]);
    anim.rewind().unwrap();
    assert_eq!(decode_all(&mut anim).len(), 4);
}

#[test]
fn gif_corrupt_frame_data_ends_the_loop_at_the_last_good_frame() {
    let frames = disposal_sequence();
    let mut file = gif_file((5, 5), &frames, None);
    // Overwrite the LZW data of the third frame with an invalid code stream
    // while keeping the block structure intact.
    let want = gif_reference((5, 5), &frames);
    let mut starts = Vec::new();
    let mut p = 13 + (3usize << ((file[10] & 7) + 1));
    while p < file.len() {
        match file[p] {
            0x21 => {
                p += 2;
                while file[p] != 0 {
                    p += file[p] as usize + 1;
                }
                p += 1;
            }
            0x2C => {
                starts.push(p + 11);
                p += 11;
                while file[p] != 0 {
                    p += file[p] as usize + 1;
                }
                p += 1;
            }
            _ => break,
        }
    }
    let data = starts[2];
    let len = file[data] as usize;
    for b in &mut file[data + 1..data + 1 + len] {
        *b = 0xFF;
    }
    let mut anim = Animation::open(file, DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!(anim.frame_count(), 5);
    let got = decode_all(&mut anim);
    assert!(got.len() >= 2 && got.len() < 5, "decoded {} frames", got.len());
    assert_frames_eq(&got[..2], &want[..2], 5);
    if got.len() == 2 {
        assert!(anim.is_truncated());
        assert_eq!(anim.frame_count(), 2);
        assert_eq!(anim.canvas(), &want[1][..]);
    }
}

// ───────────────────────────── WebP fixtures ────────────────────────────

struct WebpFrame {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    rgba: Vec<u8>,
    delay: u32,
    blend: bool,
    dispose: bool,
}

/// The VP8L payload of `rgba` encoded losslessly by image-webp.
fn vp8l(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut file = Vec::new();
    image_webp::WebPEncoder::new(&mut file)
        .encode(rgba, w, h, image_webp::ColorType::Rgba8)
        .unwrap();
    assert_eq!(&file[12..16], b"VP8L");
    let size = u32::from_le_bytes(file[16..20].try_into().unwrap()) as usize;
    file[20..20 + size].to_vec()
}

fn chunk(out: &mut Vec<u8>, fourcc: &[u8], payload: &[u8]) {
    out.extend_from_slice(fourcc);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    if payload.len() % 2 == 1 {
        out.push(0);
    }
}

fn u24(v: u32) -> [u8; 3] {
    let b = v.to_le_bytes();
    [b[0], b[1], b[2]]
}

fn webp_anim(canvas: (u32, u32), loops: u16, frames: &[WebpFrame]) -> Vec<u8> {
    let mut body = Vec::new();
    let mut vp8x = vec![0x12, 0, 0, 0];
    vp8x.extend_from_slice(&u24(canvas.0 - 1));
    vp8x.extend_from_slice(&u24(canvas.1 - 1));
    chunk(&mut body, b"VP8X", &vp8x);
    let mut anim = vec![0xAA, 0xBB, 0xCC, 0xFF]; // background hint browsers ignore
    anim.extend_from_slice(&loops.to_le_bytes());
    chunk(&mut body, b"ANIM", &anim);
    for f in frames {
        let mut p = Vec::new();
        p.extend_from_slice(&u24(f.x / 2));
        p.extend_from_slice(&u24(f.y / 2));
        p.extend_from_slice(&u24(f.w - 1));
        p.extend_from_slice(&u24(f.h - 1));
        p.extend_from_slice(&u24(f.delay));
        p.push((if f.blend { 0 } else { 2 }) | (f.dispose as u8));
        chunk(&mut p, b"VP8L", &vp8l(&f.rgba, f.w, f.h));
        chunk(&mut body, b"ANMF", &p);
    }
    let mut file = b"RIFF".to_vec();
    file.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    file.extend_from_slice(b"WEBP");
    file.extend_from_slice(&body);
    file
}

fn webp_reference(canvas: (usize, usize), frames: &[WebpFrame]) -> Vec<Vec<u8>> {
    let (cw, ch) = canvas;
    let mut cur = vec![0u8; cw * ch * 4];
    let mut out = Vec::new();
    let mut clear: Option<(usize, usize, usize, usize)> = None;
    for f in frames {
        if let Some((x, y, w, h)) = clear.take() {
            for yy in y..y + h {
                for xx in x..x + w {
                    cur[(yy * cw + xx) * 4..][..4].fill(0);
                }
            }
        }
        for fy in 0..f.h as usize {
            for fx in 0..f.w as usize {
                let s: [u8; 4] = f.rgba[(fy * f.w as usize + fx) * 4..][..4].try_into().unwrap();
                let at = ((f.y as usize + fy) * cw + f.x as usize + fx) * 4;
                let d: [u8; 4] = cur[at..at + 4].try_into().unwrap();
                let px = if f.blend { over_nonpremult(s, d) } else { s };
                cur[at..at + 4].copy_from_slice(&px);
            }
        }
        out.push(cur.clone());
        if f.dispose {
            clear = Some((f.x as usize, f.y as usize, f.w as usize, f.h as usize));
        }
    }
    assert_eq!(ch * cw * 4, cur.len());
    out
}

fn rgba_fill(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&f(x, y));
        }
    }
    v
}

fn webp_sequence() -> Vec<WebpFrame> {
    vec![
        // Partial first frame: the rest of the canvas must stay transparent,
        // on every loop.
        WebpFrame { x: 2, y: 2, w: 4, h: 4, rgba: rgba_fill(4, 4, |x, y| [40 * x as u8, 40 * y as u8, 200, 255]), delay: 80, blend: false, dispose: false },
        // Semi-transparent, blended over frame 0, disposed afterwards.
        WebpFrame { x: 0, y: 0, w: 6, h: 6, rgba: rgba_fill(6, 6, |x, _| [250, 10, 10, 30 * x as u8]), delay: 0, blend: true, dispose: true },
        // Not blended: alpha is copied as is.
        WebpFrame { x: 4, y: 0, w: 4, h: 8, rgba: rgba_fill(4, 8, |_, y| [5, 200, 5, 20 * y as u8]), delay: 40, blend: false, dispose: false },
        // Opaque frame in the corner the first frame never touches.
        WebpFrame { x: 0, y: 6, w: 2, h: 2, rgba: rgba_fill(2, 2, |_, _| [1, 2, 3, 255]), delay: 40, blend: true, dispose: true },
        WebpFrame { x: 0, y: 4, w: 4, h: 4, rgba: rgba_fill(4, 4, |x, y| [9, 99, 199, if (x + y) % 2 == 0 { 0 } else { 255 }]), delay: 10, blend: true, dispose: false },
    ]
}

#[test]
fn webp_blend_and_dispose_match_reference_on_every_loop() {
    let frames = webp_sequence();
    let file = webp_anim((8, 8), 3, &frames);
    let mut anim = Animation::open(file, DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!(anim.format(), Format::Webp);
    assert_eq!((anim.width(), anim.height(), anim.frame_count()), (8, 8, 5));
    assert_eq!(anim.loop_count(), 3);
    assert_eq!(anim.duration_ms(), 80 + 100 + 40 + 40 + 100);
    let want = webp_reference((8, 8), &frames);
    for _ in 0..3 {
        let got = decode_all(&mut anim);
        assert_frames_eq(&got, &want, 8);
        anim.rewind().unwrap();
    }
}

#[test]
fn webp_delays_and_infinite_loop() {
    let frames = webp_sequence();
    let mut anim = Animation::open(webp_anim((8, 8), 0, &frames), DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!(anim.loop_count(), 0);
    let mut delays = Vec::new();
    while anim.next_frame().unwrap() {
        delays.push((anim.raw_delay_ms(), anim.delay_ms()));
    }
    assert_eq!(delays, vec![(80, 80), (0, 100), (40, 40), (40, 40), (10, 100)]);
}

#[test]
fn webp_skip_frames_composites_what_it_skips() {
    let frames = webp_sequence();
    let want = webp_reference((8, 8), &frames);
    let mut anim = Animation::open(webp_anim((8, 8), 0, &frames), DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!(anim.skip_frames(3).unwrap(), 3);
    assert_eq!(anim.index(), Some(2));
    assert_eq!(anim.canvas(), &want[2][..]);
    assert_eq!(anim.skip_frames(10).unwrap(), 2);
    assert_eq!(anim.canvas(), &want[4][..]);
}

#[test]
fn webp_still_images_are_one_frame() {
    let rgba = rgba_fill(3, 2, |x, y| [x as u8 * 80, y as u8 * 120, 7, 255 - x as u8]);
    let mut file = Vec::new();
    image_webp::WebPEncoder::new(&mut file)
        .encode(&rgba, 3, 2, image_webp::ColorType::Rgba8)
        .unwrap();
    let mut anim = Animation::open(file, DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!((anim.width(), anim.height(), anim.frame_count()), (3, 2, 1));
    assert!(!anim.is_animated());
    assert!(anim.next_frame().unwrap());
    assert_eq!(anim.canvas(), &rgba[..]);
    assert!(!anim.next_frame().unwrap());
    anim.rewind().unwrap();
    assert!(anim.next_frame().unwrap());
    assert_eq!(anim.canvas(), &rgba[..]);
}

#[test]
fn webp_frame_outside_the_canvas_ends_the_loop() {
    let mut frames = webp_sequence();
    frames[3].x = 6; // 6 + 2 = 8 still fits
    frames[4].x = 6; // 6 + 4 > 8: invalid
    let mut anim = Animation::open(webp_anim((8, 8), 0, &frames), DEFAULT_MAX_PIXELS).unwrap();
    let got = decode_all(&mut anim);
    assert_eq!(got.len(), 4);
    assert!(anim.is_truncated());
    assert_eq!(anim.frame_count(), 4);
    assert_frames_eq(&got, &webp_reference((8, 8), &frames[..4]), 8);
}

#[test]
fn webp_truncated_file_plays_the_complete_frames() {
    let frames = webp_sequence();
    let file = webp_anim((8, 8), 0, &frames);
    let want = webp_reference((8, 8), &frames);
    let cut = file.len() - 10; // inside the last ANMF chunk
    let mut anim = Animation::open(file[..cut].to_vec(), DEFAULT_MAX_PIXELS).unwrap();
    assert_eq!(anim.frame_count(), 4);
    let got = decode_all(&mut anim);
    assert_frames_eq(&got, &want[..4], 8);
}

// ───────────────────────────── limits and errors ────────────────────────

#[test]
fn rejects_non_images_and_oversized_canvases() {
    assert!(Animation::open(b"\x89PNG\r\n\x1a\n0000".to_vec(), DEFAULT_MAX_PIXELS).is_err());
    assert!(Animation::open(Vec::new(), DEFAULT_MAX_PIXELS).is_err());
    assert!(Animation::open(b"GIF89a".to_vec(), DEFAULT_MAX_PIXELS).is_err());
    let frames = vec![GifFrame::solid(0, 0, 100, 100, 1, DisposalMethod::Keep)];
    let file = gif_file((100, 100), &frames, None);
    assert!(Animation::open(file.clone(), 100 * 100).is_ok());
    let err = Animation::open(file, 100 * 100 - 1).err().unwrap();
    assert!(err.0.contains("exceeds"), "{err}");
    let frames = webp_sequence();
    assert!(Animation::open(webp_anim((8, 8), 0, &frames), 63).is_err());
}

#[test]
fn gif_header_only_has_no_frames() {
    let mut file = gif_file((4, 4), &[], None);
    file.truncate(file.len() - 1); // drop the trailer too
    let err = Animation::open(file, DEFAULT_MAX_PIXELS).err().unwrap();
    assert!(err.0.contains("no complete frame"), "{err}");
}

