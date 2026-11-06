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
export function effectiveDelay(ms: number): number {
  return ms < 11 ? 100 : ms;
}

const u16 = (d: Uint8Array, o: number): number => d[o] | (d[o + 1] << 8);
const u24 = (d: Uint8Array, o: number): number => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
const u32 = (d: Uint8Array, o: number): number => (u24(d, o) + d[o + 3] * 0x1000000);

/** Position after a chain of GIF data sub-blocks, or -1 if the file ends first. */
function skipSubBlocks(d: Uint8Array, p: number): number {
  for (;;) {
    if (p >= d.length) return -1;
    const n = d[p++];
    if (n === 0) return p;
    p += n;
    if (p > d.length) return -1;
  }
}

function isTag(d: Uint8Array, at: number, tag: string): boolean {
  if (at + tag.length > d.length) return false;
  for (let i = 0; i < tag.length; i++) if (d[at + i] !== tag.charCodeAt(i)) return false;
  return true;
}

function probeGif(d: Uint8Array): AnimationInfo | null {
  if (d.length < 13 || !(isTag(d, 0, 'GIF87a') || isTag(d, 0, 'GIF89a'))) return null;
  const screenW = u16(d, 6);
  const screenH = u16(d, 8);
  let p = 13;
  if (d[10] & 0x80) p += 3 << ((d[10] & 7) + 1);
  let frames = 0;
  let durationMs = 0;
  let pendingDelay = 0;
  let loopCount = 1;
  let first: [number, number, number, number] | null = null;
  while (p < d.length) {
    const block = d[p];
    if (block === 0x21) {
      if (p + 1 >= d.length) break;
      const label = d[p + 1];
      p += 2;
      if (label === 0xf9 && p + 5 <= d.length && d[p] >= 4) {
        pendingDelay = u16(d, p + 2) * 10;
      } else if (label === 0xff && p + 16 <= d.length && d[p] === 11 &&
        (isTag(d, p + 1, 'NETSCAPE2.0') || isTag(d, p + 1, 'ANIMEXTS1.0'))) {
        if (d[p + 12] >= 3 && d[p + 13] === 1) {
          const n = u16(d, p + 14);
          loopCount = n === 0 ? 0 : n + 1;
        }
      }
      p = skipSubBlocks(d, p);
      if (p < 0) break;
    } else if (block === 0x2c) {
      if (p + 10 > d.length) break;
      const rect: [number, number, number, number] = [u16(d, p + 1), u16(d, p + 3), u16(d, p + 5), u16(d, p + 7)];
      const local = d[p + 9];
      p += 10;
      if (local & 0x80) p += 3 << ((local & 7) + 1);
      p = skipSubBlocks(d, p + 1); // + LZW minimum code size
      if (p < 0) break; // truncated frame: not counted
      first ??= rect;
      frames++;
      durationMs += effectiveDelay(pendingDelay);
      pendingDelay = 0;
    } else {
      break; // trailer or unknown block
    }
  }
  if (!first) return null;
  const width = Math.max(screenW, first[0] + first[2]);
  const height = Math.max(screenH, first[1] + first[3]);
  if (!width || !height) return null;
  return {
    format: 'gif',
    width,
    height,
    frameCount: frames,
    loopCount,
    durationMs,
    animated: frames > 1,
    needsFrameDecoder: true,
  };
}

function probeWebp(d: Uint8Array): AnimationInfo | null {
  if (d.length < 20 || !isTag(d, 0, 'RIFF') || !isTag(d, 8, 'WEBP')) return null;
  const limit = Math.min(8 + u32(d, 4), d.length);
  const chunkEnd = (p: number): number => p + 8 + u32(d, p + 4);
  const still = (width: number, height: number): AnimationInfo | null =>
    width > 0 && height > 0
      ? { format: 'webp', width, height, frameCount: 1, loopCount: 1, durationMs: 0, animated: false, needsFrameDecoder: false }
      : null;

  const p = 12;
  if (p + 8 > limit || chunkEnd(p) > limit) return null;
  if (isTag(d, p, 'VP8 ')) {
    if (u32(d, p + 4) < 10 || d[p + 11] !== 0x9d || d[p + 12] !== 0x01 || d[p + 13] !== 0x2a) return null;
    return still(u16(d, p + 14) & 0x3fff, u16(d, p + 16) & 0x3fff);
  }
  if (isTag(d, p, 'VP8L')) {
    if (u32(d, p + 4) < 5 || d[p + 8] !== 0x2f) return null;
    const bits = u32(d, p + 9);
    return still((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (!isTag(d, p, 'VP8X') || u32(d, p + 4) < 10) return null;
  const flags = d[p + 8];
  const width = 1 + u24(d, p + 12);
  const height = 1 + u24(d, p + 15);
  if (!(flags & 0x02)) return still(width, height);

  let frames = 0;
  let durationMs = 0;
  let loopCount = 1;
  for (let q = chunkEnd(p) + (u32(d, p + 4) & 1); q + 8 <= limit; ) {
    const size = u32(d, q + 4);
    const end = q + 8 + size;
    if (end > limit) break; // truncated chunk
    if (isTag(d, q, 'ANIM') && size >= 6) loopCount = u16(d, q + 12);
    else if (isTag(d, q, 'ANMF') && size >= 16) {
      frames++;
      durationMs += effectiveDelay(u24(d, q + 20));
    }
    q = end + (size & 1);
  }
  if (frames === 0) return null;
  return {
    format: 'webp',
    width,
    height,
    frameCount: frames,
    loopCount,
    durationMs,
    animated: frames > 1,
    needsFrameDecoder: true,
  };
}

/**
 * Probes GIF / WebP bytes. Returns `null` for anything else (PNG, JPEG, ...)
 * and for files too damaged to show a single frame. Never throws.
 */
export function probeAnimation(data: Uint8Array | ArrayBuffer): AnimationInfo | null {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    return probeGif(d) ?? probeWebp(d);
  } catch {
    return null;
  }
}
