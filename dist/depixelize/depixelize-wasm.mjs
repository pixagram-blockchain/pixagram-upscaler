// depixelize-wasm.mjs — WebAssembly build of depixelize.js (Rust → wasm32).
//
// Same options, byte-identical SVG output. About 5× faster than depixelize.js
// with SIMD, 2.4× with the scalar fallback. Browsers, Web Workers, Node, Deno
// and Bun; no dependencies, no imports needed by the .wasm.
//
//   import { init, depixelize } from './depixelize-wasm.mjs';
//   await init();                          // SIMD build when supported
//   const svg = depixelize(imageData, { scale: 30 });
//   const quick = depixelize(imageData, { smooth: 'fast' });   // opt-in fast smoothing
//
// Zero-copy I/O (the module keeps persistent buffers in its linear memory):
//   const eng = await load();
//   const px = eng.input(w, h);            // view of the module's pixel buffer
//   decodeInto(px);                        // fill it directly (no copy)
//   const bytes = eng.depixelizeView({ width: w, height: h, data: px });
//   // `bytes` views the module's output: use it before the next call
//
// `source` (init / load): nothing (the .wasm next to this file), a URL /
// Request / Response / Promise<Response>, the module bytes (ArrayBuffer or
// typed array) or a compiled WebAssembly.Module.

const DEFAULTS = Object.freeze({
  scale: 40, mode: 'auto', smooth: true, iterations: 20, guesses: 20,
  guessOffset: 0.05, shading: 0.7, seed: 1, precision: 'auto',
});

const ABI = 4;
// Smallest module using v128 (i8x16.splat + popcnt): validates only with SIMD.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const utf8 = new TextDecoder();
const enc = new TextEncoder();

/** True when this engine can run WebAssembly SIMD (simd128). */
export function simdSupported() {
  try { return WebAssembly.validate(SIMD_PROBE); } catch { return false; }
}

// @default-source (replaced in depixelize-wasm.inline.js)
function defaultSource(simd) {
  // One literal `new URL('./file.wasm', import.meta.url)` per build (not a
  // computed path), so bundlers (webpack 5, Vite, Parcel) recognise both
  // files as assets and emit them.
  return simd
    ? new URL('./depixelize-simd.wasm', import.meta.url)
    : new URL('./depixelize.wasm', import.meta.url);
}
// @end

async function instantiate(source) {
  source = await source;
  if (source instanceof WebAssembly.Module) return WebAssembly.instantiate(source, {});
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return (await WebAssembly.instantiate(source, {})).instance;
  }
  if (typeof source === 'string' || source instanceof URL) {
    if (String(source).startsWith('file:') && typeof process === 'object' && process.versions?.node) {
      // Node's fetch() cannot read file: URLs. The specifier is a variable
      // and the import is marked ignored, so bundlers targeting browsers
      // neither resolve nor bundle it (this branch only runs in Node).
      const fsPromises = 'node:fs/promises';
      const { readFile } = await import(/* webpackIgnore: true */ /* @vite-ignore */ fsPromises);
      return (await WebAssembly.instantiate(await readFile(new URL(source)), {})).instance;
    }
    source = await fetch(source);
  } else if (typeof Request === 'function' && source instanceof Request) {
    source = await fetch(source);
  }
  const res = source;
  if (res.status && !res.ok) throw new Error(`depixelize-wasm: ${res.url || 'module'} → HTTP ${res.status}`);
  if (typeof WebAssembly.instantiateStreaming === 'function' &&
      (res.headers?.get?.('content-type') || '').startsWith('application/wasm')) {
    return (await WebAssembly.instantiateStreaming(res, {})).instance;
  }
  return (await WebAssembly.instantiate(await res.arrayBuffer(), {})).instance;
}

/**
 * Loads a module and returns an independent engine.
 * @param {*} [source] see the header comment; default: the .wasm next to this file
 * @param {{simd?: boolean}} [opts] simd: pick the SIMD (true) or scalar (false)
 *   build when `source` is omitted; default: SIMD when supported
 */
export async function load(source, { simd } = {}) {
  const useSimd = simd ?? simdSupported();
  const instance = await instantiate(source === undefined ? defaultSource(useSimd) : source);
  return makeEngine(instance.exports);
}

/** Options with defaults applied, normalised exactly like depixelize.js. */
function normalize(opts = {}) {
  const o = {};
  for (const k in DEFAULTS) o[k] = opts[k] !== undefined && opts[k] !== null ? opts[k] : DEFAULTS[k];
  return {
    // seeds the SVG id hash, like depixelize.js
    key: [o.scale, o.mode, o.shading, o.smooth, o.iterations, o.guesses, o.guessOffset, o.seed, o.precision].join('|'),
    id: opts.idPrefix ? enc.encode(String(opts.idPrefix)) : null,
    mode: o.mode === 'cell' ? 1 : o.mode === 'shape' ? 2 : 0,
    smooth: o.smooth === 'fast' ? 2 : o.smooth !== false ? 1 : 0,
    iterations: o.iterations | 0,
    guesses: o.guesses | 0,
    guessOffset: +o.guessOffset,
    seed: o.seed | 0,
    scale: +o.scale,                       // clamped by the module like in JS
    shading: +o.shading || 0,
    precision: o.precision === 'auto' ? -1 : Math.min(6, Math.max(0, Math.trunc(+o.precision) || 0)),
  };
}

function makeEngine(ex) {
  if (typeof ex.dpx_abi !== 'function' || ex.dpx_abi() !== ABI) {
    throw new Error('depixelize-wasm: incompatible .wasm (expected ABI ' + ABI + ')');
  }
  // The module's pixel buffer, as last handed out by input() or filled here.
  let inPtr = -1, inLen = 0;

  /** View of the module's pixel buffer for a width × height image (RGBA, or RGB with channels = 3). */
  function input(width, height, channels = 4) {
    const n = Math.max(0, width | 0) * Math.max(0, height | 0) * (channels === 3 ? 3 : 4);
    inPtr = ex.dpx_input(n); inLen = n;
    return new Uint8ClampedArray(ex.memory.buffer, inPtr, n);
  }

  /** Runs the pipeline; returns a view of the SVG in the module's memory. */
  function depixelizeView(image, opts) {
    const w = image.width | 0, h = image.height | 0, data = image.data;
    if (w <= 0 || h <= 0) throw new RangeError('depixelize: image must be at least 1×1');
    if (!data || data.length < w * h * 3) throw new RangeError('depixelize: pixel data too short');
    const o = normalize(opts), n = data.length;
    // Pixels already in the module's buffer (from input()) are used in place.
    const inPlace = data.buffer === ex.memory.buffer && data.byteOffset === inPtr && n <= inLen;
    if (!inPlace) {
      const src = data instanceof Uint8Array || data instanceof Uint8ClampedArray ? data : Uint8ClampedArray.from(data);
      const p = ex.dpx_input(n);
      new Uint8Array(ex.memory.buffer, p, n).set(src);
      inPtr = p; inLen = n;
    }
    // Option string (UTF-16LE) and id prefix (UTF-8) → argument buffer.
    const ku = o.key.length, il = o.id ? o.id.length : 0;
    const ap = ex.dpx_args(ku * 2 + il);
    const args = new Uint8Array(ex.memory.buffer, ap, ku * 2 + il);
    for (let i = 0; i < ku; i++) { const c = o.key.charCodeAt(i); args[2 * i] = c & 255; args[2 * i + 1] = c >> 8; }
    if (il) args.set(o.id, ku * 2);
    const status = ex.dpx_run(n, w, h, o.mode, o.smooth, o.iterations, o.guesses, o.guessOffset, o.seed,
                              o.scale, o.shading, o.precision, ku, il);
    if (status === 1) throw new RangeError('depixelize: image must be at least 1×1');
    if (status === 2) throw new RangeError('depixelize: pixel data too short');
    if (status !== 0) throw new Error('depixelize: internal error');
    // Fresh view: the call may have grown (and detached) the memory.
    return new Uint8Array(ex.memory.buffer, ex.dpx_output_ptr(), ex.dpx_output_len());
  }

  return Object.freeze({
    simd: ex.dpx_simd() === 1,
    input,
    depixelizeView,
    depixelizeBytes: (image, opts) => depixelizeView(image, opts).slice(),
    depixelize: (image, opts) => utf8.decode(depixelizeView(image, opts)),
    /** Frees the module's persistent buffers (they grow again on demand). */
    release: () => { ex.dpx_release(); inPtr = -1; inLen = 0; },
  });
}

let engine = null;
function current() {
  if (!engine) throw new Error('depixelize-wasm: call await init() first');
  return engine;
}

/**
 * Loads the default engine used by the functions below. A second call without
 * arguments is a no-op; with arguments it replaces the engine.
 */
export async function init(source, opts) {
  if (!engine || source !== undefined || opts !== undefined) engine = await load(source, opts);
  return api;
}

/** Whether the default engine is the SIMD build. */
export function isSimd() { return !!engine && engine.simd; }

/**
 * Vectorizes `image` ({ width, height, data: RGBA (or RGB) bytes }, e.g. ImageData).
 * Options and defaults are those of depixelize.js. Returns the SVG document.
 */
export function depixelize(image, opts) { return current().depixelize(image, opts); }

/** Like depixelize() but returns the SVG as UTF-8 bytes (a copy you own). */
export function depixelizeBytes(image, opts) { return current().depixelizeBytes(image, opts); }

/** Like depixelizeBytes() without the copy: a view valid until the next call. */
export function depixelizeView(image, opts) { return current().depixelizeView(image, opts); }

/** View of the default engine's pixel buffer, to fill in place (see the header). */
export function input(width, height, channels) { return current().input(width, height, channels); }

const api = Object.freeze({ init, load, depixelize, depixelizeBytes, depixelizeView, input, isSimd, simdSupported, DEFAULTS });
export default api;
export { DEFAULTS };
