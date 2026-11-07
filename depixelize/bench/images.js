'use strict';
const { sprites } = require('./sprites');
// Benchmark images: 128×128 and 256×256 sprite sheets (tiled test sprites) and a
// 96×96 noisy photo-like gradient.
function sheet(n) {
  const names = Object.keys(sprites).filter(k => k !== 'photo');
  const W = n, H = n, data = new Uint8ClampedArray(W * H * 4).fill(255);
  let ox = 0, oy = 0, rowH = 0, k = 0;
  while (oy < H) {
    const s = sprites[names[k++ % names.length]];
    if (ox + s.width > W) { ox = 0; oy += rowH; rowH = 0; if (oy >= H) break; }
    for (let y = 0; y < s.height && oy + y < H; y++) for (let x = 0; x < s.width; x++) {
      const i = ((oy + y) * W + ox + x) * 4, j = (y * s.width + x) * 4;
      data[i] = s.data[j]; data[i + 1] = s.data[j + 1]; data[i + 2] = s.data[j + 2]; data[i + 3] = 255;
    }
    ox += s.width; rowH = Math.max(rowH, s.height);
  }
  return { width: W, height: H, data };
}
function photo(n) {
  const data = new Uint8ClampedArray(n * n * 4);
  let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4;
    const t = Math.sin(x / 9) * Math.cos(y / 7);
    data[i] = 120 + 90 * t + (rnd() - .5) * 30; data[i + 1] = 110 + 60 * Math.sin(y / 11) + (rnd() - .5) * 30;
    data[i + 2] = 140 - 70 * t + (rnd() - .5) * 30; data[i + 3] = 255;
  }
  return { width: n, height: n, data };
}
const imgs = { sheet128: sheet(128), sheet256: sheet(256), photo96: photo(96) };
module.exports = imgs;
