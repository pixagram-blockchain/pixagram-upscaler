/**
 * Header-only probe for GIF and WebP: is the file animated, how large is its
 * canvas, how many frames, how long. No pixel is decoded and nothing is
 * allocated beyond the result, so it is cheap enough for layout code that
 * must size a card before any decode (microseconds for typical files: GIF
 * image data is skipped sub-block by sub-block, WebP chunk by chunk).
 *
 * It applies the same rules as the WASM `FrameDecoder` (and browsers): a GIF
 * canvas is its logical screen enlarged to fit the first frame, frame
 * durations under 11 ms count as 100 ms, and loop counts are total plays
 * (0 = forever).
 */
/** What {@link probeAnimation} found. */
export interface AnimationInfo {
    format: 'gif' | 'webp';
    /** Canvas size in pixels (what every composited frame measures). */
    width: number;
    height: number;
    /** Complete frames in one loop (1 for a still image). */
    frameCount: number;
    /** Total plays: 0 = forever, 1 = once (GIF without NETSCAPE2.0 block). */
    loopCount: number;
    /** One loop in milliseconds, using the durations browsers play. */
    durationMs: number;
    /** More than one frame. */
    animated: boolean;
    /**
     * True when still-image decoders cannot open the file and it must go
     * through the frame decoder even with a single frame: every GIF, and any
     * WebP carrying the VP8X animation flag (libwebp's `WebPDecode`, used by
     * most WebP decoders, rejects those).
     */
    needsFrameDecoder: boolean;
}
/** Durations under 11 ms play as 100 ms in every major browser. */
export declare function effectiveDelay(ms: number): number;
/**
 * Probes GIF / WebP bytes. Returns `null` for anything else (PNG, JPEG, ...)
 * and for files too damaged to show a single frame. Never throws.
 */
export declare function probeAnimation(data: Uint8Array | ArrayBuffer): AnimationInfo | null;
//# sourceMappingURL=anim-probe.d.ts.map