# depixelize v4 — Rust / WebAssembly

Resolution-independent vectorization of pixel art — Kopf & Lischinski,
*Depixelizing Pixel Art* (SIGGRAPH 2011) — as a Rust crate compiled to
WebAssembly in two builds, **SIMD** (`simd128`) and **scalar**, behind a small
ES-module API, plus the readable JavaScript reference `depixelize.js`.

- **Byte-identical output.** Both engines produce the same SVG, down to the
  last digit, for the same pixels and options.
- **One shared data model.** Both implementations use the same flat
  typed-array layout.
- **Compact SVG.** Coordinates are in pixel units, with precision tied to
  `scale`.
- **Zero-copy I/O.** WebAssembly reads its input and writes its output in
  place, with no intermediate copies.
- **Opt-in fast smoothing.** `smooth: 'fast'` replaces the paper's random
  relaxation with a deterministic pattern search on the same energy. Curves
  come out as smooth, and smoothing takes 6–13× less time (one `f32x4` per
  step in the SIMD build).

## In @pixagram/upscaler

This folder is the source of `@pixagram/upscaler/depixelize`.

- From the repository root, `npm run build:depixelize` runs `build.sh`,
  copies `pkg/` to `dist/depixelize/` (the published files) and regenerates
  `examples/depixelize-demo.html`, the single-file demo. `pkg/` itself is a
  build output and is not committed.
- `npm test` includes this crate's `cargo test`; `npm run test:depixelize`
  also builds `pkg/` and runs `bench/parity.mjs`.
- `WasmDepixelizePool`, exported by the package root, runs this module in Web
  Workers (see the repository README).
- The glue names each `.wasm` with a literal `new URL('./….wasm',
  import.meta.url)` and hides its Node-only `node:fs/promises` import from
  bundlers, so webpack 5, Vite and esbuild bundle it as is.

## Contents

| Path | What it is |
|---|---|
| `pkg/depixelize-wasm.mjs` | ES module: `init`, `load`, `depixelize`, `depixelizeView`, `input`, … (browsers, workers, Node, Deno, Bun) |
| `pkg/depixelize-wasm.d.ts` | TypeScript declarations |
| `pkg/depixelize-simd.wasm` | SIMD build (paper smoothing: two candidates per `f64x2`; fast smoothing: four positions per `f32x4`) |
| `pkg/depixelize.wasm` | Scalar build (fallback for engines without SIMD) |
| `pkg/depixelize-wasm.inline.js` | Classic `<script>` with both builds embedded — works from `file://`, no bundler |
| `depixelize.js` | JavaScript reference implementation (v4), single file, zero dependencies |
| `demo.html` | Browser demo: engine and smoothing switches, precision, benchmark with byte-identity check (open it straight from disk once `pkg/` is built) |
| `js/make-demo.mjs` | Inlines the scripts of `demo.html` into one file (`examples/depixelize-demo.html`, which needs no build) |
| `package.json` | Marks the `.js` files of this folder as CommonJS (the parent package is `"type": "module"`) |
| `src/` | Rust source: `pipeline.rs` (graph, cells, regions, curves), `optimize.rs` (B-spline geometry, paper relaxation), `fast.rs` (fast smoothing, f32x4 kernel), `svg.rs` (writer), `math.rs` (deterministic kernels), `wasm.rs` (ABI) |
| `tests/` | Golden tests: hashes of the SVGs `depixelize.js` produces |
| `bench/` | `parity.mjs` (JS vs both builds, byte for byte), `bench.mjs` (timings and sizes) |
| `build.sh` | Builds `pkg/` |

## Quick start

### Browser or bundler (ES module)

```js
import { init, depixelize } from './pkg/depixelize-wasm.mjs';

await init();   // fetches depixelize-simd.wasm, or depixelize.wasm without SIMD support
const ctx = canvas.getContext('2d');
const svg = depixelize(ctx.getImageData(0, 0, canvas.width, canvas.height), { scale: 30 });
const quick = depixelize(imageData, { scale: 30, smooth: 'fast' });   // opt-in fast smoothing
```

The `.wasm` files are loaded from next to the module. Serve them as
`application/wasm` so they compile while downloading (most servers do).

### Zero-copy

The module keeps its pixel and SVG buffers in its own memory between calls,
so you can work on them in place:

1. `input(w, h)` returns a view of the module's pixel buffer. Fill it directly,
   for example from a decoder that writes into a buffer you provide.
2. `depixelizeView()` returns the SVG as a view of the module's output buffer.
   Nothing is copied on either side.

```js
import { load } from './pkg/depixelize-wasm.mjs';
const engine = await load();

const px = engine.input(width, height);       // Uint8ClampedArray over the module's memory
await frame.copyTo(px, { format: 'RGBA' });    // e.g. a WebCodecs VideoFrame, or any decoder
const bytes = engine.depixelizeView({ width, height, data: px }, { scale: 30 });
await writable.write(bytes);                   // use it before the next call on this engine
```

Both views stay valid until the next call on the same engine.

| Call | Returns | Copies |
|---|---|---|
| `depixelizeBytes()` | A `Uint8Array` you own | One |
| `depixelize()` | A string decoded straight from the view | None besides the string itself |

### Plain `<script>`, or a page opened from disk

```html
<script src="pkg/depixelize-wasm.inline.js"></script>
<script>
  DepixelizeWasm.init().then(() => {
    const svg = DepixelizeWasm.depixelize(imageData, { mode: 'shape' });
  });
</script>
```

Browsers do not load ES modules or `.wasm` files from `file://`. This bundle
avoids both, at the cost of being larger (130 KB, both builds inside).

### Web Worker

A 256×256 image takes about 0.13 s (0.03 s with `smooth: 'fast'`). To keep
the page responsive with large images, run the work in a worker:

```js
// worker.js — a module worker
import { init, depixelize } from './pkg/depixelize-wasm.mjs';
const ready = init();
onmessage = async ({ data }) => {
  await ready;
  postMessage(depixelize(data.image, data.opts));
};

// main thread
const worker = new Worker('worker.js', { type: 'module' });
worker.onmessage = (e) => { output.innerHTML = e.data; };
worker.postMessage({ image: imageData, opts: { scale: 30 } });
```

### Node

```js
import { init, depixelize } from './pkg/depixelize-wasm.mjs';
await init();   // reads the .wasm next to the module
const svg = depixelize({ width, height, data: rgbaBytes }, { scale: 30 });
```

### Rust

```rust
use depixelize::{depixelize, depixelize_into, Mode, Options, Smooth};

let svg = depixelize(width, height, &rgba, &Options { scale: 30.0, mode: Mode::Shape, ..Options::default() })?;
let quick = depixelize(width, height, &rgba, &Options { smooth: Smooth::Fast, ..Options::default() })?;

let mut buf = Vec::new();                 // reused across calls: no output reallocation
depixelize_into(&mut buf, width, height, &rgba, &Options::default())?;
```

## API

| Function | Returns |
|---|---|
| `init(source?, { simd? })` | `Promise<api>`. Loads the default engine; calling it again without arguments does nothing |
| `load(source?, { simd? })` | `Promise<Engine>`, an independent `{ simd, depixelize, depixelizeBytes, depixelizeView, input, release }` |
| `depixelize(image, options?)` | SVG document (`string`) |
| `depixelizeBytes(image, options?)` | SVG as UTF-8 bytes (`Uint8Array`), a copy you own |
| `depixelizeView(image, options?)` | SVG as a view of the module's memory, with no copy. Valid until the next call |
| `input(width, height, channels = 4)` | View of the module's pixel buffer, to fill in place. Valid until the next call |
| `isSimd()` / `simdSupported()` | Whether the default engine is the SIMD build / whether this engine supports SIMD |
| `DEFAULTS` | Default options (frozen) |

- **`source`**: if omitted, the `.wasm` next to the module is used. It can
  also be a URL, `Request`, `Response` (or a promise of one), the module bytes,
  or a compiled `WebAssembly.Module`.
- **`image`**: `{ width, height, data }` with RGBA (or RGB) bytes, row-major.
  `ImageData` works as is.
- **Errors**: `RangeError` for an empty image or too little pixel data.
- **`engine.release()`**: frees the module's persistent buffers; they grow
  again on demand.

`depixelize.js` exports `depixelize` and `depixelizeBytes` with the same
options.

### Options

| Option | Default | Meaning |
|---|---|---|
| `scale` | `40` | Output size: SVG `width`/`height` = image size × scale. Geometry is in pixel units |
| `precision` | `'auto'` | Decimals of the coordinates, in pixels (0–6). `'auto'` is the coarsest grid that keeps every point within ¼ output pixel at `scale`: 2 decimals at scale 40, 1 at scale 4 |
| `mode` | `'auto'` | `'cell'`: a region is a group of similar pixels (as in the paper), so colour varies smoothly inside it. `'shape'`: a region is a group of identical pixels, so every colour boundary becomes a curve. `'auto'`: decided per region; banded shading stays crisp, while gradients, dither and noise are smoothed |
| `smooth` | `true` | Optimise the curve control points (paper §3.4). `true`: the paper's random relaxation. `'fast'`: a deterministic pattern search on the same energy, about as smooth in a fraction of the time (see [Fast smoothing](#fast-smoothing)). `false`: control points stay on the pixel lattice |
| `iterations` | `20` | Relaxation sweeps. In fast mode, the maximum: sweeps stop once no point can improve |
| `guesses` | `20` | Random candidates per control point per sweep (unused in fast mode) |
| `guessOffset` | `0.05` | Maximum displacement of one candidate, in pixels. In fast mode, the step sizes are 2×, 1× and ½× this |
| `shading` | `0.7` | σ, in pixels, of the colour interpolation inside multi-colour regions; `0` gives flat cells |
| `seed` | `1` | PRNG seed. The output is deterministic |
| `idPrefix` | hash | Prefix for the ids inside the SVG |

## Fast smoothing

`smooth: 'fast'` (Rust: `Smooth::Fast`) keeps the paper's energy — the
turning angles of the control polygon (∫|κ| ds) plus |p − p̂|⁴ — and replaces
its minimiser. The paper mode (`smooth: true`) tries `guesses` = 20 random
moves per control point in each of `iterations` = 20 sweeps. The fast mode is
a deterministic **pattern search**:

- **One visit = four positions.** A visit scores the point where it is
  (lane 0) and three trial moves 120° apart (lanes 1–3): exactly one `f32x4`
  in the SIMD build. The trial with the lowest energy wins if it is strictly
  below the current one (the lowest lane wins ties).
- **Adaptive step.** A point starts with a step of 2 × `guessOffset`. When no
  trial improves on its position, the step halves (1×, then ½×). After the
  smallest step fails, the point sleeps and is not visited again until a
  neighbour, or the T-junction end next to it, moves. A woken point restarts
  at 1×. Sweeps end when every point sleeps, or after `iterations` sweeps.
- **Six directions.** Odd sweeps turn the pattern by 60°, so a point probes
  six directions over two visits.
- **Small, precise numbers.** Everything runs in IEEE single precision, in
  coordinates relative to the visited point. Differences are below a few
  pixels, so f32 still resolves ~10⁻⁷ px. `depixelize.js` emulates f32 with
  `Math.fround` after every operation, so all three engines stay
  byte-identical.
- **No randomness.** `seed` and `guesses` are not used.

### Result quality

The fast mode reaches the paper relaxation's smoothness (within 1 %) or
better. The table gives the final energy, the quantity both modes minimise
(lower is smoother), next to the unsmoothed curves:

| Image | Unsmoothed | Paper | Fast |
|---|---:|---:|---:|
| mushroom | 56.6 | 35.2 | 33.6 |
| smiley | 31.2 | 12.2 | 12.2 |
| heart | 14.4 | 9.9 | 9.2 |
| letterC | 29.1 | 13.4 | 13.5 |
| landscape | 32.0 | 13.7 | 13.8 |
| sprite sheet 128×128 | 1973 | 1001 | 990 |
| noisy photo 96×96 | 3354 | 1101 | 1016 |

The energies above use exact `atan2`. Rendered in Chrome, the fast and
paper modes differ by roughly half as much as the paper mode differs from
unsmoothed curves (mean pixel difference): mostly sub-pixel shifts along
curves that are smooth in both. The control points move about as far from
the pixel lattice in both modes.

### The SIMD kernel

The `f32x4` kernel (`src/fast.rs`) has no per-lane branches, and uses bit
operations where a select or a branch would otherwise be needed:

- `|x|` is an AND with `0x7FFF_FFFF`.
- The octant fold-backs of `|atan2|`, `π/2 − r` and `π − r`, are a sign
  flip (XOR with the compare mask's sign bit) plus an AND-masked constant:
  `(r ^ (m & SIGN)) + (m & C)`. That is exactly `C − r` when the mask is set,
  and `r` otherwise.
- The 0/0 lane of a degenerate angle is cleared with one ANDNOT.
- The winner is `ctz(bitmask(e == min(e)))`: a horizontal minimum (two
  shuffle + `pmin` steps), one compare, `i32x4.bitmask` and trailing zeros.
  When lane 0 holds the minimum, the result is 0, meaning stay. That is also
  the scalar rule, "the first lane strictly below the current energy".
- The constants are loaded once per call through volatile reads, so engines
  keep them in registers instead of rebuilding `v128.const` at every use.

The scalar builds (native, and wasm without SIMD) and `depixelize.js` score
the lanes in order, with the same early exit as the paper mode. That makes
the same decision as the full sums.

## Output format

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="560" height="560" viewBox="0 0 14 14">
  <path fill="#141414" stroke="#141414" vector-effect="non-scaling-stroke"
        d="M4 0h6q.56.425.88.67.315.24.57.44.265.19.47.46 … v3q-.665.415-.95.61 … z"/>
```

- **Pixel units.** The `viewBox` is the image size. Coordinates are bounded by
  the image size whatever the scale, so a 256 px image at scale 40 no longer
  has numbers like `10240.5`. `scale` only sets `width` and `height`.
- **Precision grid.** Points are rounded to 10⁻ᵖ px.
- **Path encoding.**
  - Each subpath starts with an absolute `M`, followed by relative
    `h`/`v`/`l`/`q` commands.
  - Deltas are taken between already-rounded points, so they are exact and
    nothing drifts along long paths.
  - Minified syntax: implicit command repetition, no leading zeros, and a
    separator only where one is needed.
- **Canonical quads.** Each B-spline segment has one rounded form:
  - its endpoints and node point are rounded to the grid;
  - its control point is solved so that the segment passes *exactly* through
    the rounded node point.

  Every region draws whole segments or exact halves of that one form. Shared
  edges and T-junctions are therefore identical on both sides at any
  precision. Precision changes how faithful the shape is, never whether the
  regions meet without gaps. Control points therefore sometimes carry one or
  two extra digits.
- **Shading.** Smooth regions are drawn as pixel runs, one path per colour,
  under a single blur filter, instead of one `<rect>` per run.

## Architecture

```
pixels → similarity graph → crossings → cells → regions → visible edges
       → loops (CSR) → curves (CSR) → corners → optimise → finalize → SVG bytes
```

- **One `Graph` of flat typed arrays (struct of arrays).** Every stage is a
  small function over it: `readPixels`, `buildSimilarity`, `resolveCrossings`,
  `buildCells`, `buildRegions`, `buildBoundaries`, `traceLoops`,
  `buildCurves`, `detectCorners`, `optimize`, `finalize`, `renderSvg`.
- **No per-object storage.**
  - Curves, loops and region pixels are offset ranges (CSR) into shared
    buffers, filled by one reusable stable bucket sort (`csr`).
  - Stages hand each other `subarray` views, never copies.
  - The original control-point positions p̂ are read straight from the node
    lattice, so no copy is kept.
- **Fixed-slot nodes, as in the GPU implementation.** This is the approach of
  Kreuzer et al., *Depixelizing Pixel Art on GPUs*, 2014:
  - every pixel corner owns two node slots (`id = corner·2 + slot`) on the
    ¼-pixel lattice;
  - every cell has at most 8 edges at `pixel·8 + k`;
  - the similarity graph is 4 bits per pixel.

  Indices are computed, never searched.
- **The same layout in Rust.** It mirrors the JS layout field for field. That
  is what keeps byte-for-byte parity tractable.
- **Shared helpers.** `List` (a growable typed array), `csr`, `Scratch` (flood
  fills), `ByteWriter` (number formatting into a `Uint8Array`) and
  `PathEncoder`.

## Performance

Times in ms (median, best of several runs), with `{ scale: 30 }` and all
other options at their defaults. For each smoothing setting, the SVG is the
same for all three engines.

| Image | Size | `smooth` | depixelize.js | WASM scalar | WASM SIMD | SIMD vs JS |
|---|---:|---|---:|---:|---:|---:|
| mushroom | 14×14 | `true` | 3.3 | 1.4 | 0.70 | 4.7× |
| | | `'fast'` | 0.73 | 0.26 | 0.15 | 4.9× |
| | | `false` | 0.18 | 0.08 | 0.08 | 2.3× |
| landscape | 32×20 | `true` | 3.7 | 1.5 | 0.76 | 4.9× |
| | | `'fast'` | 0.73 | 0.28 | 0.21 | 3.5× |
| | | `false` | 0.32 | 0.15 | 0.15 | 2.1× |
| sprite sheet | 128×128 | `true` | 143 | 63 | 31.5 | 4.5× |
| | | `'fast'` | 27.3 | 10.4 | 7.8 | 3.5× |
| | | `false` | 10.8 | 5.5 | 5.5 | 2.0× |
| noisy photo | 96×96 | `true` | 127 | 58 | 29.2 | 4.3× |
| | | `'fast'` | 39.2 | 15.2 | 10.4 | 3.8× |
| | | `false` | 14.1 | 6.6 | 6.7 | 2.1× |
| sprite sheet | 256×256 | `true` | 606 | 252 | 129 | 4.7× |
| | | `'fast'` | 104 | 36 | 28.3 | 3.7× |
| | | `false` | 40 | 19.6 | 19.8 | 2.0× |

Smoothing alone (the difference to `false`), WASM SIMD:

| Image | Paper | Fast | Ratio |
|---|---:|---:|---:|
| sprite sheet 128×128 | 26.0 ms | 2.2 ms | 12× |
| noisy photo 96×96 | 22.5 ms | 3.7 ms | 6× |
| sprite sheet 256×256 | 109 ms | 8.5 ms | 13× |

In `depixelize.js` the fast mode smooths 4–9× faster than the paper mode. It
gains less there than in WebAssembly, because every operation goes through
`Math.fround`.

These figures are from Node 22 (V8) on a 2.7 GHz Intel Xeon (x86-64), via
`node bench/bench.mjs`.

- **First call.** It also compiles: `init()` takes about 15 ms with streaming
  compilation, and the optimising tier takes over during the first large
  image (about +30 ms at 256×256).
- **Memory.** Linear memory grows to about 320 bytes per input pixel (21 MB
  for 256×256) and is reused by later calls. `release()` returns it.
- **Where the time goes.** With the paper's relaxation, the curve optimiser
  takes about 80 % of the time. With `smooth: 'fast'` it takes about a third
  in WebAssembly (about 60 % in `depixelize.js`), and the rest of the
  pipeline dominates.

## Byte-identical to depixelize.js

- **Same pipeline**: same loop orders, same tie-breaks and the same data
  layout. Integer arithmetic is used wherever JS uses integers.
- **Floating point**: IEEE-754 `+ − × ÷` and comparisons are correctly rounded in
  every engine. Rust never fuses `a * b + c` into an FMA, and no relaxed-SIMD
  instructions are used.
- **Single precision (fast mode)**: JS rounds every operation with
  `Math.fround`. An f64 `+ − × ÷` of two f32 values, rounded once more to
  f32, is the correctly rounded f32 result, so JS matches Rust's `f32` and
  wasm's `f32x4` bit for bit.
- **Transcendentals replaced**: the algorithm's only transcendental functions
  are replaced by deterministic kernels in both implementations, because
  `Math.atan2`, `Math.sin` and `Math.cos` are not guaranteed to agree to the
  last bit across engines.
  - `|atan2|` uses octant reduction plus a degree-4 minimax polynomial in
    Estrin form (max error 1.1·10⁻⁵ rad).
  - The random candidate directions come from a 256-entry table built by
    repeated exact rotation.
- **SIMD lanes**: each lane runs exactly the scalar operation sequence.
  `pmin`/`pmax` have the scalar `a > b ? a : b` semantics. Bitwise
  replacements are exact: `(r ^ SIGN) + C` is `C − r` in IEEE arithmetic.
- **SVG numbers**: integers in fine grid units, formatted by integer
  arithmetic, so there is no float-to-string conversion anywhere in the output.
- **Verification**:
  - `node bench/parity.mjs` compares both builds with `depixelize.js` on the
    test sprites in every mode with both smoothing methods, on 1000 random
    images with random options (including out-of-range ones and fast mode),
    and on the zero-copy path.
  - `cargo test` checks the Rust crate against hashes of the reference's output.

## Where the speed comes from

- **Optimiser**: an exact reorganisation of the reference loop, so every
  decision stays the same.
  - A control point with energy exactly 0 cannot improve. It is skipped, and
    the PRNG, a Weyl counter, jumps ahead in O(1). This skips about 25 % of
    evaluations.
  - All candidates are drawn first, and their energies are computed as one
    dense batch. They are then accepted in draw order with the same `<`
    comparisons.
- **Fast smoothing**: see [Fast smoothing](#fast-smoothing). It takes 4–11
  visits per control point, each one `f32x4` evaluation, instead of 420
  energy evaluations.
- **SIMD build**:
  - two paper-mode candidates per `f64x2`, four fast-mode positions per
    `f32x4`;
  - four PRNG outputs per `i32x4` step;
  - one 16-byte load per candidate direction, from an interleaved table.
- **Corner patterns** (Fig. 7): the 48 variants are bucketed by lattice phase
  and first step, so each node is tested against at most three of them.
- **I/O**:
  - persistent input and output buffers in linear memory;
  - SVG written as bytes into one growable buffer;
  - a 6-function C ABI with no imports and no wasm-bindgen.

## What changed in v4

- **`smooth: 'fast'`** (Rust: `Smooth::Fast`): opt-in deterministic pattern
  search, f32, one `f32x4` per visit with bit-level SIMD tricks. It reaches
  the paper mode's smoothness with 6–13× less smoothing time in WebAssembly.
  The default (`smooth: true`) is unchanged, byte for byte.
- **Rust API**: `Options::smooth` is now an enum,
  `Smooth::{Off, Paper, Fast}`, with `From<bool>`. The crate version is 4.0.0.
- **WebAssembly**: ABI 4 (`dpx_run`'s `smooth` is 0 off, 1 paper, 2 fast).
  The glue and the `.d.ts` accept `smooth: 'fast'`. The fast mode adds about
  5 KB to each binary (114 KB scalar, 116 KB SIMD).
- **Demo**: a smoothing switch (paper / fast / off).

## What changed in v3

- **Output format**: pixel-unit `viewBox`, a `precision` option,
  relative/minified paths, canonical quads and per-colour shading paths. The
  SVGs are 25–42 % smaller. The rendered geometry matches v2 to within
  rounding.
- **`depixelize.js`**:
  - rewritten around the shared typed-array data model, with small stage
    functions and views instead of copies;
  - adds `depixelizeBytes`;
  - its geometry is bit-identical to v2's (checked against v2 on 442 images
    and option sets);
  - it runs at the same speed as v2.
- **WebAssembly**:
  - ABI v3 with persistent buffers;
  - `input()`, `depixelizeView()` and `release()`;
  - the binaries are 20 % smaller (110 KB each).
- **Rust**: `Options::precision` and `depixelize_into` (reusable output
  buffer).
- **Hardening**: `scale` is clamped to 10⁶, `shading` to 1000 and `precision`
  to 0–6, identically in both implementations.

## Building

```sh
rustup target add wasm32-unknown-unknown
./build.sh               # → pkg/
cargo test               # golden tests against depixelize.js
node bench/parity.mjs    # JS vs both WebAssembly builds, byte for byte
node bench/bench.mjs     # timings and sizes
```

- **Rust**: 1.85 or newer is required.
- **wasm-opt** (binaryen): recommended, found on `PATH` or via `WASM_OPT=…`.
  It makes the SIMD build about 20 % faster and both builds smaller. Version
  121 or newer (`build.sh` passes `--enable-bulk-memory-opt`). With Rust 1.97
  and binaryen 132 the build reproduces the binaries in `dist/depixelize/`
  byte for byte.
- **Node 18+** generates `depixelize-wasm.inline.js` and runs the scripts.
- **Native CLI**, for tests and profiling:
  `cargo run --release --bin depixelize-cli -- <w> <h> <pixels.rgba> [--mode auto|cell|shape] [--scale N] [--precision N] [--fast | --no-smooth] [--out file.svg] [--bench N]`.

## Browser support

| Build | Supported in |
|---|---|
| SIMD build | Chrome / Edge 91+, Firefox 89+, Safari 16.4+, Node 16.4+ |
| Scalar build | Every engine with WebAssembly |
| Inline bundle | Needs `DecompressionStream`: Chrome 80+, Firefox 113+, Safari 16.4+, Node 18+ |

`init()` chooses between the SIMD and scalar builds by itself.
