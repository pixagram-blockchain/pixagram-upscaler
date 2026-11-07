//! Golden tests: the SVG must be byte-identical to `depixelize.js` (v4).
//! Each expected value is the length and FNV-1a-64 hash of the SVG that the JS
//! reference produces for the same pixels and options.

use depixelize::{depixelize, Mode, Options, Smooth};

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3))
}

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}.rgba", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[test]
fn matches_js_reference() {
    #[rustfmt::skip]
    let cases: Vec<(&str, u32, u32, Options, usize, u64)> = vec![
        ("mushroom", 14, 14, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 4358, 0x32b3cc99f093006c),
        ("mushroom", 14, 14, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 4358, 0x32b3cc99f093006c),
        ("mushroom", 14, 14, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 4358, 0x32b3cc99f093006c),
        ("smiley", 16, 16, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 3472, 0xee3b3ba8f194a173),
        ("smiley", 16, 16, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 3472, 0xee3b3ba8f194a173),
        ("smiley", 16, 16, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 3472, 0xee3b3ba8f194a173),
        ("heart", 11, 11, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 2285, 0x34103c32c38027df),
        ("heart", 11, 11, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 2285, 0x34103c32c38027df),
        ("heart", 11, 11, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 2285, 0x34103c32c38027df),
        ("sphere", 18, 18, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 4436, 0x3b307e4118a7c77f),
        ("sphere", 18, 18, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 4436, 0x3b307e4118a7c77f),
        ("sphere", 18, 18, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 2584, 0xe01eef6a0f722e9a),
        ("photo", 24, 24, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 25070, 0x701698734b9befe8),
        ("photo", 24, 24, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 83658, 0xfae4b23e6337fad8),
        ("photo", 24, 24, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 25070, 0x20e831d5dd9cc31c),
        ("alpha", 10, 10, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 1761, 0xe387d79c9609a990),
        ("alpha", 10, 10, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 1761, 0xe387d79c9609a990),
        ("alpha", 10, 10, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 1761, 0xe387d79c9609a990),
        ("letterC", 13, 15, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 3767, 0x80a668e564eb81a5),
        ("letterC", 13, 15, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 3767, 0x80a668e564eb81a5),
        ("letterC", 13, 15, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 3767, 0x80a668e564eb81a5),
        ("landscape", 32, 20, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 6353, 0x21ffac31cf413e82),
        ("landscape", 32, 20, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 6353, 0x21ffac31cf413e82),
        ("landscape", 32, 20, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 4244, 0x0d769271810992bd),
        ("dither", 12, 10, Options { mode: Mode::Auto, scale: 30.0, ..Options::default() }, 2250, 0x2e1106f3682df184),
        ("dither", 12, 10, Options { mode: Mode::Shape, scale: 30.0, ..Options::default() }, 4954, 0x854a8660932c3f10),
        ("dither", 12, 10, Options { mode: Mode::Cell, scale: 30.0, ..Options::default() }, 2246, 0x7ce886e666b8a648),
        ("smiley", 16, 16, Options { mode: Mode::Auto, scale: 12.5, iterations: 5, guesses: 7, guess_offset: 0.2, seed: 42, ..Options::default() }, 3530, 0xc1f6af578c51f709),
        ("photo", 24, 24, Options { mode: Mode::Auto, shading: 0.0, ..Options::default() }, 68621, 0x8dbc7b4cc04b9856),
        ("alpha", 10, 10, Options { mode: Mode::Shape, smooth: Smooth::Off, ..Options::default() }, 1696, 0x56cdff958d73de25),
        ("landscape", 32, 20, Options { mode: Mode::Auto, scale: 7.0, iterations: 0, ..Options::default() }, 5900, 0xcc8501ab3156dcb9),
        ("sphere", 18, 18, Options { mode: Mode::Cell, guesses: 1, shading: 1.3, seed: -5, ..Options::default() }, 2534, 0xef11beb60edc8fc5),
        ("heart", 11, 11, Options { mode: Mode::Auto, id_prefix: Some("h-".into()), ..Options::default() }, 2285, 0x8a9ef0eb668ba6c3),
        ("mushroom", 14, 14, Options { mode: Mode::Auto, precision: Some(0), ..Options::default() }, 2716, 0xbc6ccff317b96ce0),
        ("letterC", 13, 15, Options { mode: Mode::Auto, scale: 100.0, precision: Some(4), ..Options::default() }, 5370, 0xc4429dba1f16d957),
        ("dither", 12, 10, Options { mode: Mode::Cell, precision: Some(1), ..Options::default() }, 2070, 0x1094a51987a48292),
    ];
    let mut failed = Vec::new();
    for (name, w, h, opts, len, hash) in &cases {
        let svg = depixelize(*w, *h, &fixture(name), opts).expect("depixelize");
        if svg.len() != *len || fnv1a64(svg.as_bytes()) != *hash {
            failed.push(format!("{name} {opts:?}: got {} bytes / {:#018x}", svg.len(), fnv1a64(svg.as_bytes())));
        }
    }
    assert!(failed.is_empty(), "differs from depixelize.js:\n{}", failed.join("\n"));
}

/// `Smooth::Fast` (`smooth: 'fast'` in JS): same contract, f32 pattern search.
#[test]
fn matches_js_reference_fast() {
    #[rustfmt::skip]
    let cases: Vec<(&str, u32, u32, Options, usize, u64)> = vec![
        ("mushroom", 14, 14, Options { mode: Mode::Auto, scale: 30.0, smooth: Smooth::Fast, ..Options::default() }, 4298, 0x4aabdeb5ef909cca),
        ("smiley", 16, 16, Options { mode: Mode::Shape, scale: 30.0, smooth: Smooth::Fast, ..Options::default() }, 3465, 0xdd3004145e9eedce),
        ("photo", 24, 24, Options { mode: Mode::Cell, scale: 30.0, smooth: Smooth::Fast, ..Options::default() }, 25010, 0xe0a8baec5194a412),
        ("photo", 24, 24, Options { mode: Mode::Auto, smooth: Smooth::Fast, ..Options::default() }, 25010, 0x606e307d33828c1f),
        ("landscape", 32, 20, Options { smooth: Smooth::Fast, iterations: 3, guess_offset: 0.2, ..Options::default() }, 6025, 0x4e4507d626fc48b2),
        ("sphere", 18, 18, Options { smooth: Smooth::Fast, guess_offset: 1e9, ..Options::default() }, 3979, 0xba85f45dbd4b694e),
        ("letterC", 13, 15, Options { mode: Mode::Shape, smooth: Smooth::Fast, precision: Some(3), ..Options::default() }, 4533, 0xb5a3f8b22a85d282),
        ("heart", 11, 11, Options { smooth: Smooth::Fast, iterations: 0, ..Options::default() }, 2167, 0xedccacda9a53a1f3),
        ("dither", 12, 10, Options { mode: Mode::Cell, smooth: Smooth::Fast, guess_offset: 0.013, seed: 9, ..Options::default() }, 2255, 0x5c64a488dc7ec7b5),
        ("alpha", 10, 10, Options { smooth: Smooth::Fast, scale: 7.0, ..Options::default() }, 1732, 0x4f5eb16179c3302c),
    ];
    let mut failed = Vec::new();
    for (name, w, h, opts, len, hash) in &cases {
        let svg = depixelize(*w, *h, &fixture(name), opts).expect("depixelize");
        if svg.len() != *len || fnv1a64(svg.as_bytes()) != *hash {
            failed.push(format!("{name} {opts:?}: got {} bytes / {:#018x}", svg.len(), fnv1a64(svg.as_bytes())));
        }
    }
    assert!(failed.is_empty(), "differs from depixelize.js:\n{}", failed.join("\n"));
}

#[test]
fn smooth_settings() {
    let px = fixture("mushroom");
    let run = |smooth: Smooth| depixelize(14, 14, &px, &Options { smooth, id_prefix: Some("t".into()), ..Options::default() }).unwrap();
    let (paper, fast, off) = (run(Smooth::Paper), run(Smooth::Fast), run(Smooth::Off));
    assert!(paper != fast && fast != off && paper != off);
    assert_eq!(fast, run(Smooth::Fast));
    assert_eq!(Smooth::from(true), Smooth::Paper);
    assert_eq!(Smooth::from(false), Smooth::Off);
    assert_eq!(Options::default().smooth, Smooth::Paper);
}

#[test]
fn deterministic_and_well_formed() {
    let px = fixture("mushroom");
    let a = depixelize(14, 14, &px, &Options::default()).unwrap();
    let b = depixelize(14, 14, &px, &Options::default()).unwrap();
    assert_eq!(a, b);
    assert!(a.starts_with("<svg") && a.trim_end().ends_with("</svg>"));
}

#[test]
fn rgb_input_matches_rgba() {
    let rgba = fixture("smiley");
    let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    let o = Options { scale: 20.0, ..Options::default() };
    assert_eq!(depixelize(16, 16, &rgba, &o).unwrap(), depixelize(16, 16, &rgb, &o).unwrap());
}

#[test]
fn reusable_output_buffer() {
    let px = fixture("heart");
    let mut buf = Vec::with_capacity(1 << 16);
    depixelize::depixelize_into(&mut buf, 11, 11, &px, &Options::default()).unwrap();
    let first = buf.clone();
    depixelize::depixelize_into(&mut buf, 11, 11, &px, &Options::default()).unwrap();
    assert_eq!(buf, first);
    assert!(buf.capacity() >= 1 << 16);
}

#[test]
fn pixel_units_and_small_numbers() {
    let svg = depixelize(14, 14, &fixture("mushroom"), &Options { scale: 1000.0, ..Options::default() }).unwrap();
    assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"14000\" height=\"14000\" viewBox=\"0 0 14 14\">"));
    // every absolute coordinate stays within the image (pixel units), whatever the scale
    let d = svg.split(" d=\"").nth(1).unwrap();
    let m: Vec<f64> = d[1..].split(|c: char| c.is_ascii_alphabetic()).next().unwrap().split(' ').map(|v| v.parse().unwrap()).collect();
    assert!(m.iter().all(|&v| (0.0..=14.0).contains(&v)));
}

#[test]
fn rejects_bad_input() {
    use depixelize::Error;
    assert_eq!(depixelize(0, 4, &[], &Options::default()), Err(Error::EmptyImage));
    assert_eq!(depixelize(4, 4, &[0; 10], &Options::default()), Err(Error::DataTooShort));
    // 1×1 is the smallest valid image
    assert!(depixelize(1, 1, &[10, 20, 30, 255], &Options::default()).is_ok());
}
