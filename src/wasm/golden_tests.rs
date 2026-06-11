//! Golden-output tests.
//!
//! These hash the output of every renderer over deterministic pseudo-random
//! inputs. The hashes below were captured from the ORIGINAL implementation;
//! any refactor must keep them identical (byte-for-byte output parity).
//!
//! To (re)capture: GOLDEN_CAPTURE=1 cargo test golden -- --nocapture
#![cfg(test)]

use crate::{crt, hex, xbrz};

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self { Rng(seed.max(1)) }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12; x ^= x << 25; x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn byte(&mut self) -> u8 { (self.next() >> 32) as u8 }
}

fn fnv1a(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}

fn make_input(w: usize, h: usize, seed: u64) -> Vec<u8> {
    const PALETTE: [[u8; 3]; 8] = [
        [0,0,0],[255,255,255],[228,52,52],[52,228,52],
        [52,52,228],[240,200,40],[120,40,200],[40,200,220],
    ];
    const ALPHAS: [u8; 3] = [0, 64, 255];
    let mut rng = Rng::new(seed);
    let mut out = Vec::with_capacity(w * h * 4);
    for _ in 0..w * h {
        let c = PALETTE[(rng.byte() % 8) as usize];
        let a = ALPHAS[(rng.byte() % 3) as usize];
        out.extend_from_slice(&[c[0], c[1], c[2], a]);
    }
    out
}

fn smooth_input(w: usize, h: usize, seed: u64) -> Vec<u8> {
    let mut rng = Rng::new(seed);
    (0..w * h * 4).map(|_| rng.byte()).collect()
}

fn check(name: &str, hashes: &[u64], golden: &[u64]) {
    if std::env::var("GOLDEN_CAPTURE").is_ok() {
        println!("const GOLDEN_{}: [u64; {}] = {:?};", name, hashes.len(), hashes);
    } else {
        assert_eq!(hashes, golden, "{name} output changed");
    }
}

#[test]
fn golden_crt() {
    let mut hashes = Vec::new();
    for &(w, h) in &[(17usize, 13usize), (32, 32), (7, 9)] {
        let img = smooth_input(w, h, 0xC127 + (w * h) as u64);
        for &scale in &[2usize, 3, 5] {
            for cfg in [
                crt::CrtConfig::default(),
                crt::CrtConfig { enable_warp: false, ..Default::default() },
                crt::CrtConfig { enable_scanlines: false, enable_mask: false, ..Default::default() },
                crt::CrtConfig {
                    warp_x: 0.05, warp_y: 0.06, scan_hardness: -8.0,
                    scan_opacity: 0.8, mask_opacity: 0.7,
                    enable_warp: true, enable_scanlines: true, enable_mask: true,
                },
            ] {
                hashes.push(fnv1a(&crt::crt_upscale(&img, w, h, scale, &cfg)));
            }
        }
    }
    check("CRT", &hashes, &GOLDEN_CRT);
}

#[test]
fn golden_hex() {
    let mut hashes = Vec::new();
    for &(w, h) in &[(17usize, 13usize), (9, 21)] {
        let img = make_input(w, h, 0x4E + (w * h) as u64);
        for &scale in &[2usize, 5, 16] {
            for orientation in [hex::HexOrientation::FlatTop, hex::HexOrientation::PointyTop] {
                for (borders, thickness) in [(false, 1usize), (true, 1), (true, 3)] {
                    let cfg = hex::HexConfig {
                        orientation,
                        draw_borders: borders,
                        border_color: 0x282828FF,
                        border_thickness: thickness,
                        background_color: 0x11223344,
                    };
                    hashes.push(fnv1a(&hex::hex_upscale(&img, w, h, scale, &cfg)));
                }
            }
        }
    }
    check("HEX", &hashes, &GOLDEN_HEX);
}

#[test]
fn golden_xbrz() {
    let mut hashes = Vec::new();
    for &(w, h) in &[(17usize, 13usize), (24, 16)] {
        let img = make_input(w, h, 0xB12 + (w * h) as u64);
        for scale in 1usize..=6 {
            hashes.push(fnv1a(&xbrz::xbrz_upscale(&img, w, h, scale, 30.0, 4.0, 3.6, 2.2)));
        }
        hashes.push(fnv1a(&xbrz::xbrz_upscale(&img, w, h, 4, 12.0, 3.0, 4.2, 2.0)));
    }
    check("XBRZ", &hashes, &GOLDEN_XBRZ);
}

// === Captured from the ORIGINAL implementation - do not edit ===
const GOLDEN_CRT: [u64; 36] = [6226087842120382615, 11135532877416148708, 18078436396590237385, 3276810353461604749, 15904512823350598249, 4569593559203987606, 10562413766326943969, 3094427877166781822, 13639501399250738258, 7015679004875718832, 11538556831897937875, 15485161121735027728, 8325026638908662228, 9216542454337861895, 97728005682051347, 15426237886011280750, 15021002138090089353, 13251316344508902762, 11602816936681371555, 13922820149007878329, 17459677438261169660, 8597536769236668439, 5001699177702778462, 12110517037378135969, 16873883167023422822, 2835382379658692681, 8766683687720306741, 4847586457165283538, 9215354270168568736, 13690439656027767208, 13125369393704092040, 6495528746746659403, 12628934383397540959, 12081066145750796030, 17932986022312811488, 4257637957861011087];
const GOLDEN_HEX: [u64; 36] = [3215850021787353481, 3044214592730659845, 12143846871881017305, 1921342324149399829, 10899610931370089033, 1066458917054146952, 15535659895130727252, 3475491131461891432, 119501158930531649, 1041444292093185577, 15428598566665302513, 7091369252814524432, 4205752112161476177, 11101317767237744560, 7790725136579417880, 16178459635023501440, 8912110871609274456, 15354553943768386001, 2912826023665737432, 17205342352702134529, 1957590095922817576, 15876294967167466616, 14318604220131751092, 2944721850448248201, 10072469962802975465, 11376402104728137009, 10742982385725657276, 18311261564136056772, 4169388503587840928, 5937970949777037132, 8402359616905796172, 8460084222846278800, 13795974529697018761, 16618973373347314108, 1398531052086703793, 8147703962327464545];
const GOLDEN_XBRZ: [u64; 14] = [10971233172549040208, 15552607187377126050, 14256454315407012571, 6360389447189752136, 8737835304357626018, 12501696767116939523, 4728590056213508388, 5450351023726106908, 9840418425636043563, 2088842716164075354, 12561481717772317028, 4405049503489852227, 4545022532725338035, 7343741145402552177];
