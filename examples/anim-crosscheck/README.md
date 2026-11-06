# Animated GIF / WebP cross-check

Compares every composited frame of `FrameDecoder` with Chrome's own decoder
(`ImageDecoder`), checks that WASM memory stays flat however many frames are
rendered, and exercises `WasmAnimationPool` (pixels, bitmaps, looping, skip,
close while a frame is in flight).

```bash
npm run build                                   # dist/wasm-anim + dist/*.js
python3 examples/anim-crosscheck/make_fixtures.py examples/anim-crosscheck/fixtures   # needs Pillow
python3 -m http.server 8000                     # from the repository root
# open http://localhost:8000/examples/anim-crosscheck/crosscheck.html in Chrome
```

`localhost` counts as a secure context, which `ImageDecoder` requires. The
page prints a summary; the full data is in `window.__RESULT__`. Expected: GIF
bit-exact, WebP within a few levels (Chrome blends in premultiplied space;
against libwebp's own animation decoder the frames are exact), no memory
growth, every pool line `ok`.

Fixtures come from Pillow (its GIF / WebP encoders choose sub-rectangles,
disposal and blending) plus hand-built files covering what they do not:
interlaced GIF frames, frames running off the canvas, local palettes with
out-of-range indices, and every ANMF blend / dispose combination with ALPH +
VP8, VP8 and VP8L bitstreams.
