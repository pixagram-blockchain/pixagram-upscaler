/**
 * WASM band worker for {@link WasmXbrzPool}.
 *
 * Each worker owns its own WebAssembly instance (instantiated from a module the
 * pool compiled once) and renders horizontal bands of an xBRZ upscale. Bands
 * carry their 2-row halo, so they stack byte-identically to a single-threaded
 * render. No SharedArrayBuffer is required; when the pool passes one (page is
 * cross-origin isolated) the band is written straight into it.
 *
 * Build target: a module worker, e.g.
 *   new Worker(new URL('./wasm-worker.js', import.meta.url), { type: 'module' })
 */
export {};
//# sourceMappingURL=wasm-worker.d.ts.map