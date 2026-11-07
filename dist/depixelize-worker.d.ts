/**
 * Depixelize worker for {@link WasmDepixelizePool}.
 *
 * Owns one instance of the depixelize module (instantiated from the module the
 * pool compiled once, SIMD or scalar build) and vectorizes one whole image per
 * request: the pixels arrive as a transferred buffer, the SVG goes back as a
 * string or as transferred UTF-8 bytes. Requests run in arrival order.
 *
 * Build target: a module worker, e.g.
 *   new Worker(new URL('./depixelize-worker.js', import.meta.url), { type: 'module' })
 *
 * The glue is imported statically, so a bundler that builds this worker
 * includes it in the worker chunk.
 */
export {};
//# sourceMappingURL=depixelize-worker.d.ts.map