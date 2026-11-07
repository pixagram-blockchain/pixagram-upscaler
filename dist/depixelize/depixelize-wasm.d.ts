// Type declarations for depixelize-wasm.mjs (and the DepixelizeWasm global of
// depixelize-wasm.inline.js, which has the same shape as the default export).

export interface DepixelizeOptions {
  /** Output size: SVG width/height = image size × scale (default 40). Geometry is in pixel units (viewBox). */
  scale?: number;
  /**
   * Decimals of the coordinates, in pixel units (0–6). 'auto' (default) picks the
   * coarsest grid keeping every point within ¼ output pixel at `scale` (2 at scale 40).
   */
  precision?: number | 'auto';
  /** Region grouping (default 'auto'). */
  mode?: 'auto' | 'cell' | 'shape';
  /**
   * Curve smoothing (default true): true = the paper's random relaxation;
   * 'fast' = deterministic pattern search on the same energy (f32, one f32x4
   * per visit with SIMD) — about as smooth, a fraction of the time; false = off.
   */
  smooth?: boolean | 'fast';
  /** Relaxation sweeps (default 20; the maximum in fast mode). */
  iterations?: number;
  /** Random candidates per control point per sweep (default 20; unused in fast mode). */
  guesses?: number;
  /** Maximum displacement of one candidate, in pixels (default 0.05; fast mode starts at 2× this). */
  guessOffset?: number;
  /** σ in pixels of the colour interpolation inside multi-colour regions; 0 = flat (default 0.7). */
  shading?: number;
  /** PRNG seed; output is deterministic (default 1). */
  seed?: number;
  /** Prefix for the ids inside the SVG (default: a hash of image + options). */
  idPrefix?: string;
}

/** ImageData or any { width, height, data } with RGBA (or RGB) bytes, row-major. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array | ArrayLike<number>;
}

export type WasmSource =
  | string | URL | Request | Response | PromiseLike<Response>
  | ArrayBuffer | ArrayBufferView | WebAssembly.Module
  | PromiseLike<ArrayBuffer | ArrayBufferView | WebAssembly.Module>;

export interface LoadOptions {
  /** Without `source`: true = SIMD build, false = scalar build. Default: SIMD when supported. */
  simd?: boolean;
}

export interface Engine {
  /** True for the SIMD (simd128) build. */
  readonly simd: boolean;
  depixelize(image: PixelImage, opts?: DepixelizeOptions): string;
  /** The SVG as UTF-8 bytes (a copy you own). */
  depixelizeBytes(image: PixelImage, opts?: DepixelizeOptions): Uint8Array;
  /** The SVG as a view of the module's memory — no copy; valid until the next call on this engine. */
  depixelizeView(image: PixelImage, opts?: DepixelizeOptions): Uint8Array;
  /**
   * View of the module's pixel buffer for a width × height image (channels 4 = RGBA, 3 = RGB).
   * Fill it, then pass it as `data` to a depixelize* call: the pixels are used in place.
   * Valid until the next call on this engine.
   */
  input(width: number, height: number, channels?: 3 | 4): Uint8ClampedArray;
  /** Frees the module's persistent buffers (they grow again on demand). */
  release(): void;
}

export interface DepixelizeWasm {
  init(source?: WasmSource, opts?: LoadOptions): Promise<DepixelizeWasm>;
  load(source?: WasmSource, opts?: LoadOptions): Promise<Engine>;
  depixelize(image: PixelImage, opts?: DepixelizeOptions): string;
  depixelizeBytes(image: PixelImage, opts?: DepixelizeOptions): Uint8Array;
  depixelizeView(image: PixelImage, opts?: DepixelizeOptions): Uint8Array;
  input(width: number, height: number, channels?: 3 | 4): Uint8ClampedArray;
  isSimd(): boolean;
  simdSupported(): boolean;
  readonly DEFAULTS: Readonly<Required<Omit<DepixelizeOptions, 'idPrefix'>>>;
}

/** Loads the default engine used by depixelize() / depixelizeBytes(). */
export function init(source?: WasmSource, opts?: LoadOptions): Promise<DepixelizeWasm>;
/** Loads an independent engine. */
export function load(source?: WasmSource, opts?: LoadOptions): Promise<Engine>;
/** Vectorizes the image with the default engine; returns an SVG document. */
export function depixelize(image: PixelImage, opts?: DepixelizeOptions): string;
/** Like depixelize(), as UTF-8 bytes (a copy you own). */
export function depixelizeBytes(image: PixelImage, opts?: DepixelizeOptions): Uint8Array;
/** Like depixelizeBytes() without the copy: a view valid until the next call. */
export function depixelizeView(image: PixelImage, opts?: DepixelizeOptions): Uint8Array;
/** View of the default engine's pixel buffer, to fill in place. */
export function input(width: number, height: number, channels?: 3 | 4): Uint8ClampedArray;
/** Whether the default engine is the SIMD build. */
export function isSimd(): boolean;
/** Whether this JS engine supports WebAssembly SIMD. */
export function simdSupported(): boolean;
export const DEFAULTS: DepixelizeWasm['DEFAULTS'];

declare const api: DepixelizeWasm;
export default api;
