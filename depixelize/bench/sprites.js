// Synthetic test sprites (all original, hand-made for testing).
'use strict';

function fromGrid(grid, pal) {
  const h = grid.length, w = grid[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = pal[grid[y][x]];
    if (!c) throw new Error('no palette entry for ' + grid[y][x]);
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c.length > 3 ? c[3] : 255;
  }
  return { width: w, height: h, data };
}

const sprites = {};

// 1. The demo's built-in mushroom seed.
sprites.mushroom = fromGrid([
  '....KKKKKK....',
  '..KKRRRRRRKK..',
  '.KRRWWRRRWWRK.',
  '.KRWWWRRWWWRK.',
  'KRRWWRRRRWWRRK',
  'KRRRRRRRRRRRRK',
  'KRWWWRRRRWWWRK',
  '.KWWWRRRRWWWK.',
  '..KKSSSSSSKK..',
  '..KSSSSSSSSK..',
  '..KSKKSSKKSK..',
  '..KSKSSSSKSK..',
  '..KSSSSSSSSK..',
  '...KKKKKKKK...',
], { K: [20, 20, 20], R: [220, 40, 40], W: [250, 250, 250], S: [250, 200, 160], '.': [255, 255, 255] });

// 2. Smiley with 1-px eyes and a curved mouth.
sprites.smiley = fromGrid([
  '................',
  '.....KKKKKK.....',
  '...KKYYYYYYKK...',
  '..KYYYYYYYYYYK..',
  '.KYYYYYYYYYYYYK.',
  '.KYYYKYYYYKYYYK.',
  'KYYYYKYYYYKYYYYK',
  'KYYYYYYYYYYYYYYK',
  'KYYYYYYYYYYYYYYK',
  'KYYKYYYYYYYYKYYK',
  'KYYYKYYYYYYKYYYK',
  '.KYYYKKKKKKYYYK.',
  '.KYYYYYYYYYYYYK.',
  '..KYYYYYYYYYYK..',
  '...KKYYYYYYKK...',
  '.....KKKKKK.....',
], { K: [30, 30, 30], Y: [250, 210, 40], '.': [90, 160, 230] });

// 3. Heart with highlight.
sprites.heart = fromGrid([
  '...........',
  '..KKK.KKK..',
  '.KRRRKRRRK.',
  'KRWWRRRRRRK',
  'KRWRRRRRRRK',
  'KRRRRRRRRRK',
  '.KRRRRRRRK.',
  '..KRRRRRK..',
  '...KRRRK...',
  '....KRK....',
  '.....K.....',
], { K: [40, 10, 20], R: [230, 40, 70], W: [255, 230, 235], '.': [245, 245, 245] });

// 4. Thin lines: 1-px diagonal, circle outline, shallow slopes.
sprites.lines = fromGrid([
  '....................',
  '.B..................',
  '..B......GGGG.......',
  '...B....G....G......',
  '....B..G......G.....',
  '.....B.G......G.....',
  '......BG......G.....',
  '......GB......G.....',
  '.......GB....G......',
  '........GBGGG.......',
  '..........B.........',
  '...........B........',
  '....................',
  '.RRR................',
  '....RRR.............',
  '.......RRR..........',
  '..........RRR.......',
  '.............RRR....',
  '................RRR.',
  '....................',
], { B: [20, 20, 120], G: [20, 140, 40], R: [200, 30, 30], '.': [240, 240, 220] });

// 5. Shaded sphere with similar grey shades (multi-colour region).
(function () {
  const w = 18, h = 18, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + 0.5 - 9, dy = y + 0.5 - 9, r = Math.hypot(dx, dy);
    let c;
    if (r > 7.6) c = [40, 50, 90];
    else {
      const l = Math.max(0, Math.min(1, 0.55 - 0.08 * (dx + dy) / 2 + 0.25 * Math.sqrt(Math.max(0, 1 - r * r / 64))));
      const q = Math.round(l * 6) / 6;          // 7 posterised bands
      const v = Math.round(90 + q * 160);
      c = [v, v, v];
    }
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  sprites.sphere = { width: w, height: h, data };
})();

// 6. Smooth gradient + noise (photo-like) 24x24.
(function () {
  const w = 24, h = 24, data = new Uint8ClampedArray(w * h * 4);
  let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inDisk = Math.hypot(x - 15, y - 9) < 6;
    let r, g, b;
    if (inDisk) { r = 240 - 4 * Math.hypot(x - 13, y - 7); g = 150 - 3 * y; b = 40; }
    else { r = 60 + 3 * y; g = 120 + 2 * y; b = 200 - 2 * y; }
    r += (rnd() - 0.5) * 14; g += (rnd() - 0.5) * 14; b += (rnd() - 0.5) * 14;
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  sprites.photo = { width: w, height: h, data };
})();

// 7. Glyphs with diagonals (letters A, S, Z built by hand).
sprites.glyphs = fromGrid([
  '...................',
  '..KK....KKKK..KKKK.',
  '.K..K..K.........K.',
  '.K..K..K........K..',
  '.KKKK...KKK....K...',
  '.K..K......K..K....',
  '.K..K......K.K.....',
  '.K..K..KKKK..KKKKK.',
  '...................',
], { K: [10, 10, 10], '.': [255, 255, 255] });

// 8. Sprite on a transparent background (alpha).
sprites.alpha = fromGrid([
  '..........',
  '...KKKK...',
  '..KGGGGK..',
  '.KGGWGGGK.',
  '.KGWGGGGK.',
  '.KGGGGGGK.',
  '..KGGGGK..',
  '...KKKK...',
  '....KK....',
  '..........',
], { K: [20, 60, 20], G: [80, 200, 90], W: [230, 255, 230], '.': [0, 0, 0, 0] });

// 9. Blob with 1-px holes and thin tentacles (cf. Fig. 8 of the paper; original design).
sprites.blob = fromGrid([
  '..............',
  '....XXXXXX....',
  '..XXXXXXXXXX..',
  '.XXXXXXXXXXXX.',
  '.XXX.XXXX.XXX.',
  '.XXXXXXXXXXXX.',
  '.XX.XXX.XXX.X.',
  '..X..XX.XX..X.',
  '.X...X...X...X',
  '.X...........X',
  '..............',
], { X: [120, 120, 130], '.': [250, 250, 255] });

// 10. A "C" letter with staircase curves (cf. Fig. 6; own drawing).
sprites.letterC = fromGrid([
  '.............',
  '....DDDDD....',
  '..DDLLLLLDD..',
  '.DLLDDDDDLLD.',
  '.DLD.....DD..',
  'DLD..........',
  'DLD..........',
  'DLD..........',
  'DLD..........',
  'DLD..........',
  '.DLD.....DD..',
  '.DLLDDDDDLLD.',
  '..DDLLLLLDD..',
  '....DDDDD....',
  '.............',
], { D: [60, 60, 60], L: [210, 210, 210], '.': [255, 255, 255] });

// 11. Banded landscape: sky bands, hills, sun.
(function () {
  const w = 32, h = 20, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c;
    const sky = [[70, 110, 200], [90, 130, 215], [110, 150, 228], [135, 172, 238], [160, 192, 245]];
    c = sky[Math.min(4, Math.floor(y / 3))];
    if (Math.hypot(x - 24, y - 5) < 3.2) c = [255, 220, 90];
    const hill1 = 13 + 3 * Math.sin(x / 5), hill2 = 15 + 2 * Math.cos(x / 3.3 + 1);
    if (y > hill1) c = [60, 150, 60];
    if (y > hill2) c = [40, 110, 45];
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  sprites.landscape = { width: w, height: h, data };
})();

// 12. Checkerboard dither patch + 2x2 checker ambiguity.
sprites.dither = fromGrid([
  '............',
  '.ababababab.',
  '.babababab..',
  '.ababababab.',
  '.babababab..',
  '............',
  '..KK..K.K...',
  '..KK...K....',
  '......K.K...',
  '............',
], { a: [120, 120, 200], b: [150, 150, 225], K: [0, 0, 0], '.': [255, 255, 255] });

module.exports = { sprites, fromGrid };
