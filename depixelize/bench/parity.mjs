// Byte-compares depixelize.js with both WebAssembly builds in pkg/: the test
// sprites in every mode, random images × random options (precision, shading,
// id prefixes, RGB input, out-of-range values), and the zero-copy path.
//   node bench/parity.mjs [randomCount=1000]
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const ref = require('../depixelize.js');
const { sprites } = require('./sprites.js');
const big = require('./images.js');
const wasm = await import('../pkg/depixelize-wasm.mjs');

const pkg = new URL('../pkg/', import.meta.url);
const builds = {
  scalar: await wasm.load(await readFile(new URL('depixelize.wasm', pkg))),
  simd: await wasm.load(await readFile(new URL('depixelize-simd.wasm', pkg))),
};

let ok = 0, bad = 0;
function check(label, img, opts) {
  const js = ref.depixelize(img, opts);
  for (const [name, eng] of Object.entries(builds)) {
    const w = eng.depixelize(img, opts);
    if (w === js) { ok++; continue; }
    bad++;
    let i = 0; while (i < js.length && js[i] === w[i]) i++;
    if (bad <= 5) console.log(`DIFF ${label} [${name}] ${JSON.stringify(opts)} at byte ${i}:\n  js:   …${js.slice(Math.max(0, i - 50), i + 30)}\n  wasm: …${w.slice(Math.max(0, i - 50), i + 30)}`);
  }
}

for (const [name, img] of Object.entries({ ...sprites, ...big })) {
  for (const mode of ['auto', 'cell', 'shape']) {
    check(name, img, { mode, scale: 30 });
    check(name, img, { mode, scale: 30, smooth: 'fast' });
  }
}
console.log(`sprites + big images (paper + fast smoothing): ${ok} identical, ${bad} different`);

const count = +(process.argv[2] ?? 1000);
let seed = 2024;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
for (let it = 0; it < count; it++) {
  const w = 1 + Math.floor(rnd() * 20), h = 1 + Math.floor(rnd() * 20);
  const np = [2, 3, 6, 12, 256][it % 5];
  const pal = Array.from({ length: np }, () => [rnd() * 256, rnd() * 256, rnd() * 256,
    it % 7 === 0 ? (rnd() < 0.3 ? 0 : rnd() < 0.5 ? 255 : rnd() * 255) : 255]);
  if (it % 11 === 0) for (let k = 0; k < np; k++) { const v = 90 + 12 * k; pal[k] = [v, v + 2, v - 3, 255]; }
  const ch = it % 13 === 0 ? 3 : 4, data = new Uint8ClampedArray(w * h * ch);
  for (let i = 0; i < w * h; i++) {
    const c = np === 256 ? [rnd() * 256, rnd() * 256, rnd() * 256, 255] : pal[Math.floor(rnd() * np)];
    for (let k = 0; k < ch; k++) data[i * ch + k] = c[k];
  }
  check('random' + it, { width: w, height: h, data }, {
    mode: ['auto', 'cell', 'shape', undefined][it % 4],
    scale: [30, 40, 12.5, 7, 0.1, -3, 3e7][it % 7],
    precision: ['auto', 0, 1, 2, 3, 6, 9, -1, 2.7, undefined][it % 10],
    iterations: [20, 0, 3, 50][it % 4 === 1 ? 1 : it % 3],
    guesses: [20, 1, 7][it % 3],
    guessOffset: [0.05, 0.2, 0.01, 1e9, -1, 0.5][it % 6],
    shading: [0.7, 0, 1.3, undefined, 1e9][it % 5],
    seed: it,
    smooth: it % 9 === 0 ? false : it % 2 ? 'fast' : true,
    idPrefix: it % 17 === 0 ? 'p' + it + '-' : undefined,
  });
}
console.log(`total: ${ok} identical, ${bad} different`);

// Zero-copy: pixels written into the module's input view, SVG read from its output view.
let zc = 0;
for (const img of [sprites.mushroom, big.photo96]) for (const eng of Object.values(builds)) {
  const px = eng.input(img.width, img.height);
  px.set(img.data);
  for (const smooth of [true, 'fast']) {
    const view = eng.depixelizeView({ width: img.width, height: img.height, data: px }, { scale: 30, smooth });
    if (new TextDecoder().decode(view) === ref.depixelize(img, { scale: 30, smooth })) zc++; else bad++;
  }
}
console.log(`zero-copy path: ${zc}/8 identical`);
process.exitCode = bad ? 1 : 0;
