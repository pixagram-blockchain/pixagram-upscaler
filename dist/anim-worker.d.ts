/**
 * Animation worker for {@link WasmAnimationPool}.
 *
 * Owns a WebAssembly instance (instantiated from the module the pool compiled
 * once) and any number of open animations, each a `FrameDecoder`: the
 * compressed file plus one canvas. A `next` request decodes one frame,
 * renders it into the instance's single shared output buffer and ships it to
 * the page - as an ImageBitmap, or as transferred RGBA bytes - before the
 * next request is looked at. However many animations are open, and however
 * long they are, the worker holds one output frame.
 *
 * Requests are handled strictly in order (bitmap creation is the only await),
 * so a stream's frames, rewinds and close never overtake each other.
 *
 * Build target: a module worker, e.g.
 *   new Worker(new URL('./anim-worker.js', import.meta.url), { type: 'module' })
 */
export {};
//# sourceMappingURL=anim-worker.d.ts.map