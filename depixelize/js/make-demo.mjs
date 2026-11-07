// Generates a single-file copy of demo.html: every <script src="…"></script>
// (depixelize.js and pkg/depixelize-wasm.inline.js) is replaced by the
// script's contents, so the page works when opened straight from disk with no
// build and no server. Run after build.sh (it needs pkg/).
//
//   node make-demo.mjs demo.html out.html
//
// Script paths are resolved relative to demo.html.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [demoPath, outPath] = process.argv.slice(2);
if (!outPath) throw new Error('usage: make-demo.mjs <demo.html> <out.html>');

let inlined = 0;
const html = readFileSync(demoPath, 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  inlined++;
  // "</script" inside the code would end the element early.
  const code = readFileSync(resolve(dirname(demoPath), src), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
  return `<script>\n${code}\n</script>`;
});
if (!inlined) throw new Error('make-demo: no <script src="…"> found in ' + demoPath);
writeFileSync(outPath, html);
console.log(`${outPath}: ${(html.length / 1024).toFixed(0)} KiB, ${inlined} scripts inlined`);
