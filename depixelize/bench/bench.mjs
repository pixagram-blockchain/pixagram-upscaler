// Median wall time of depixelize.js vs the scalar and SIMD WebAssembly builds,
// for each smoothing setting (the output of the three is identical).
//   node bench/bench.mjs
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const ref = require('../depixelize.js');
const { sprites } = require('./sprites.js');
const big = require('./images.js');
const wasm = await import('../pkg/depixelize-wasm.mjs');

const pkg = new URL('../pkg/', import.meta.url);
const scalar = await wasm.load(await readFile(new URL('depixelize.wasm', pkg)));
const simd = await wasm.load(await readFile(new URL('depixelize-simd.wasm', pkg)));

function median(fn, runs) {
  const t = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  return t[runs >> 1];
}
// Best median of three rounds, after a warm-up (lets the engine tier up):
// robust against background load on the machine.
function time(fn, runs) {
  for (let i = 0; i < Math.max(3, runs); i++) fn();
  return Math.min(median(fn, runs), median(fn, runs), median(fn, runs));
}
const fmt = (ms) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(1)).padStart(7);

const images = { mushroom: sprites.mushroom, smiley: sprites.smiley, landscape: sprites.landscape, ...big };
const modes = { paper: true, fast: 'fast', off: false };
console.log(`node ${process.version} — ms (best median of 3 rounds), options { scale: 30, smooth }`);
console.log('image        size  smooth       JS  wasm scalar  wasm SIMD  SIMD vs JS     SVG');
for (const [name, img] of Object.entries(images)) {
  const runs = img.width * img.height > 10000 ? 7 : 21;
  for (const [label, smooth] of Object.entries(modes)) {
    const opts = { scale: 30, smooth };
    const tj = time(() => ref.depixelizeBytes(img, opts), runs);
    const ts = time(() => scalar.depixelizeView(img, opts), runs);
    const tv = time(() => simd.depixelizeView(img, opts), runs);
    const kb = (simd.depixelizeView(img, opts).length / 1024).toFixed(1);
    console.log(`${(label === 'paper' ? name : '').padEnd(10)} ${(label === 'paper' ? img.width + '×' + img.height : '').padStart(7)}  ${label.padEnd(5)} ${fmt(tj)}  ${fmt(tj === 0 ? 0 : ts)}     ${fmt(tv)}      ×${(tj / tv).toFixed(1).padEnd(6)} ${kb.padStart(6)} KB`);
  }
}
