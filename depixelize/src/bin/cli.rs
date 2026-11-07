//! depixelize-cli — native front-end for tests and benchmarks.
//!
//! ```text
//! depixelize-cli <width> <height> <pixels.rgba> [--mode auto|cell|shape]
//!     [--scale N] [--precision N] [--iterations N] [--guesses N] [--offset F] [--shading F]
//!     [--seed N] [--no-smooth | --fast] [--out file.svg] [--bench RUNS]
//! ```
//! `pixels.rgba` holds raw 8-bit RGBA (or RGB) pixels, row-major.

use depixelize::{depixelize_to_vec, Mode, Options, Smooth};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: {} <width> <height> <pixels.rgba> [options]", args[0]);
        std::process::exit(2);
    }
    let w: u32 = args[1].parse().expect("width");
    let h: u32 = args[2].parse().expect("height");
    let pixels = std::fs::read(&args[3]).expect("read pixels");
    let mut o = Options::default();
    let (mut out, mut bench) = (None::<String>, 0usize);
    let mut i = 4;
    while i < args.len() {
        let next = |i: usize| args.get(i + 1).cloned().expect("missing value");
        match args[i].as_str() {
            "--mode" => {
                o.mode = match next(i).as_str() {
                    "cell" => Mode::Cell,
                    "shape" => Mode::Shape,
                    _ => Mode::Auto,
                };
                i += 1;
            }
            "--scale" => { o.scale = next(i).parse().unwrap(); i += 1; }
            "--precision" => { o.precision = Some(next(i).parse().unwrap()); i += 1; }
            "--iterations" => { o.iterations = next(i).parse().unwrap(); i += 1; }
            "--guesses" => { o.guesses = next(i).parse().unwrap(); i += 1; }
            "--offset" => { o.guess_offset = next(i).parse().unwrap(); i += 1; }
            "--shading" => { o.shading = next(i).parse().unwrap(); i += 1; }
            "--seed" => { o.seed = next(i).parse().unwrap(); i += 1; }
            "--no-smooth" => o.smooth = Smooth::Off,
            "--fast" => o.smooth = Smooth::Fast,
            "--out" => { out = Some(next(i)); i += 1; }
            "--bench" => { bench = next(i).parse().unwrap(); i += 1; }
            a => panic!("unknown argument {a}"),
        }
        i += 1;
    }
    let t0 = Instant::now();
    let svg = depixelize_to_vec(w, h, &pixels, &o).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1)
    });
    let first = t0.elapsed();
    if bench > 0 {
        let mut times = Vec::with_capacity(bench);
        for _ in 0..bench {
            let t = Instant::now();
            std::hint::black_box(depixelize_to_vec(w, h, &pixels, &o).unwrap());
            times.push(t.elapsed().as_secs_f64() * 1e3);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!("first {:.2} ms, median {:.2} ms over {bench} runs, {} bytes", first.as_secs_f64() * 1e3, times[bench / 2], svg.len());
    }
    match out {
        Some(p) => std::fs::write(p, &svg).expect("write svg"),
        None => {
            use std::io::Write;
            std::io::stdout().write_all(&svg).unwrap();
        }
    }
}
