//! Quick native benchmark of the three kernels.
//! Run: cargo run --release --example bench
use std::time::Instant;

use renderart::bench_api as api;

fn rng_bytes(n: usize, mut s: u64) -> Vec<u8> {
    (0..n)
        .map(|_| {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            (s.wrapping_mul(0x2545F4914F6CDD1D) >> 32) as u8
        })
        .collect()
}

fn palette_img(w: usize, h: usize, seed: u64) -> Vec<u8> {
    const P: [[u8; 4]; 8] = [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
        [228, 52, 52, 255],
        [52, 228, 52, 0],
        [52, 52, 228, 255],
        [240, 200, 40, 64],
        [120, 40, 200, 255],
        [40, 200, 220, 255],
    ];
    let r = rng_bytes(w * h, seed);
    let mut out = Vec::with_capacity(w * h * 4);
    for i in 0..w * h {
        out.extend_from_slice(&P[(r[i] % 8) as usize]);
    }
    out
}

fn time<F: FnMut() -> u64>(label: &str, iters: u32, mut f: F) {
    // warmup
    let mut sink = 0u64;
    sink ^= f();
    let t = Instant::now();
    for _ in 0..iters {
        sink ^= f();
    }
    let per = t.elapsed().as_secs_f64() * 1e3 / iters as f64;
    println!("{label:<34} {per:>8.2} ms/iter   (sink {sink:x})");
}


fn bench_into(w: usize, h: usize, smooth: &[u8], pix: &[u8]) {
    println!("--- buffer-reuse path (steady-state wasm) ---");
    let mut buf = vec![0u8; w * 4 * h * 4 * 4];
    time("crt 256x256 x4 (into)", 20, || {
        api::crt_into(smooth, w, h, 4, &mut buf);
        buf.iter().map(|&b| b as u64).sum()
    });
    let (hw, hh) = api::hex_dims(w, h, 12);
    let mut hbuf = vec![0u8; hw * hh * 4];
    time("hex 256x256 x12 (into, borders)", 10, || {
        api::hex_into(pix, w, h, 12, true, &mut hbuf);
        hbuf.iter().map(|&b| b as u64).sum()
    });
    let mut xbuf = vec![0u8; w * 4 * h * 4 * 4];
    time("xbrz 256x256 x4 (into)", 10, || {
        api::xbrz_into(pix, w, h, 4, &mut xbuf);
        xbuf.iter().map(|&b| b as u64).sum()
    });
    let mut xbuf2 = vec![0u8; w * 2 * h * 2 * 4];
    time("xbrz 256x256 x2 (into)", 20, || {
        api::xbrz_into(pix, w, h, 2, &mut xbuf2);
        xbuf2.iter().map(|&b| b as u64).sum()
    });
}

fn main() {
    let (w, h) = (256usize, 256usize);
    let smooth = rng_bytes(w * h * 4, 7);
    let pix = palette_img(w, h, 9);

    time("crt 256x256 x4 (default)", 20, || {
        api::crt(&smooth, w, h, 4).iter().map(|&b| b as u64).sum()
    });
    time("hex 256x256 x12 (borders)", 10, || {
        api::hex(&pix, w, h, 12, true).iter().map(|&b| b as u64).sum()
    });
    time("xbrz 256x256 x4 (default)", 10, || {
        api::xbrz(&pix, w, h, 4).iter().map(|&b| b as u64).sum()
    });
    time("xbrz 256x256 x2 (default)", 20, || {
        api::xbrz(&pix, w, h, 2).iter().map(|&b| b as u64).sum()
    });

    bench_into(w, h, &smooth, &pix);
}

// Buffer-reuse (steady-state wasm path) variants are appended by bench_into().
