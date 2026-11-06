"""Animated GIF / WebP fixtures for the browser cross-check.

Pillow writes most of them (its GIF and WebP encoders pick sub-rectangles,
disposal and blending themselves); a few WebP files are assembled by hand from
Pillow-encoded still bitstreams so that every ANMF flag combination and the
ALPH + VP8 layout are covered.
"""
import io
import json
import math
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("fixtures"))
out.mkdir(parents=True, exist_ok=True)
manifest = []


def save(name, data, note):
    (out / name).write_bytes(data)
    manifest.append({"name": name, "note": note, "bytes": len(data)})


def sprite_frames(n, w, h, alpha=False, seed=0):
    frames = []
    for i in range(n):
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0) if alpha else (20, 24, 40, 255))
        d = ImageDraw.Draw(im)
        cx = int((w - 10) * (0.5 + 0.45 * math.sin(i * 2 * math.pi / n + seed)))
        cy = int((h - 10) * (0.5 + 0.45 * math.cos(i * 2 * math.pi / n + seed)))
        d.rectangle([cx, cy, cx + 9, cy + 9], fill=(240, 80 + 10 * i % 150, 40, 255))
        d.ellipse([w // 3, h // 3, w // 3 + 7 + i % 5, h // 3 + 7], fill=(60, 200, 90, 255 if not alpha else 140))
        d.line([0, i % h, w - 1, (i * 3) % h], fill=(250, 250, 250, 255), width=1)
        frames.append(im)
    return frames


def gif_bytes(frames, **kw):
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], **kw)
    return buf.getvalue()


def webp_bytes(frames, **kw):
    buf = io.BytesIO()
    frames[0].save(buf, format="WEBP", save_all=True, append_images=frames[1:], **kw)
    return buf.getvalue()


# ── GIF ──────────────────────────────────────────────────────────────────
f = sprite_frames(12, 64, 48)
save("gif_opaque_loop.gif", gif_bytes([x.convert("RGB") for x in f], duration=60, loop=0), "opaque, infinite loop")

f = sprite_frames(10, 48, 48, alpha=True)
save("gif_transparent_bg2.gif", gif_bytes(f, duration=[0, 10, 20, 30, 40, 50, 60, 70, 80, 90], loop=2, disposal=2),
     "transparency, dispose to background, loop=2, short delays")

f = sprite_frames(9, 40, 40, alpha=True, seed=1)
save("gif_dispose_previous.gif", gif_bytes(f, duration=80, loop=0, disposal=3), "dispose to previous")

f = sprite_frames(8, 40, 40, alpha=True, seed=2)
save("gif_mixed_disposal.gif", gif_bytes(f, duration=50, disposal=[1, 2, 3, 1, 3, 2, 0, 1]), "mixed disposal, plays once")

f = sprite_frames(6, 90, 70, seed=3)
save("gif_interlaced.gif", gif_bytes([x.convert("RGB") for x in f], duration=100, loop=0, interlace=True),
     "interlaced frames")

# Single-frame GIF (a still image).
buf = io.BytesIO()
sprite_frames(1, 33, 21)[0].convert("RGB").save(buf, format="GIF")
save("gif_still.gif", buf.getvalue(), "single frame")

# Logical screen smaller than the first frame (Chromium enlarges the canvas).
data = bytearray(gif_bytes([x.convert("RGB") for x in sprite_frames(4, 30, 20)], duration=70, loop=0))
struct.pack_into("<HH", data, 6, 16, 12)
save("gif_small_screen.gif", bytes(data), "logical screen smaller than the frames")

# ── WebP (Pillow / libwebp anim encoder) ─────────────────────────────────
f = sprite_frames(12, 64, 48)
save("webp_lossless_opaque.webp", webp_bytes(f, duration=60, loop=0, lossless=True), "lossless, opaque")

f = sprite_frames(10, 48, 48, alpha=True)
save("webp_lossless_alpha.webp", webp_bytes(f, duration=[0, 10, 20, 30, 40, 50, 60, 70, 80, 90], loop=3, lossless=True),
     "lossless with alpha, loop=3")

f = sprite_frames(10, 64, 64, alpha=True, seed=1)
save("webp_lossy_alpha.webp", webp_bytes(f, duration=70, loop=0, lossless=False, quality=80),
     "lossy with alpha (ALPH + VP8)")

f = sprite_frames(10, 64, 48, seed=2)
save("webp_lossy_opaque.webp", webp_bytes([x.convert("RGB") for x in f], duration=70, loop=0, lossless=False, quality=70),
     "lossy, opaque")

f = sprite_frames(10, 56, 56, alpha=True, seed=3)
save("webp_mixed.webp", webp_bytes(f, duration=40, loop=0, allow_mixed=True, quality=60, minimize_size=True),
     "mixed lossy/lossless, minimize_size")

buf = io.BytesIO()
sprite_frames(1, 37, 23, alpha=True)[0].save(buf, format="WEBP", lossless=True)
save("webp_still_lossless.webp", buf.getvalue(), "still VP8L")


# ── WebP assembled by hand: every ANMF flag combination ──────────────────
def still_chunks(im, lossless, quality=80):
    buf = io.BytesIO()
    im.save(buf, format="WEBP", lossless=lossless, quality=quality, exact=True)
    d = buf.getvalue()
    chunks, p = [], 12
    while p + 8 <= len(d):
        tag = d[p:p + 4]
        size = struct.unpack_from("<I", d, p + 4)[0]
        chunks.append((tag, d[p + 8:p + 8 + size]))
        p += 8 + size + (size & 1)
    return [(t, c) for t, c in chunks if t in (b"ALPH", b"VP8 ", b"VP8L")]


def chunk(tag, payload):
    return tag + struct.pack("<I", len(payload)) + payload + (b"\0" if len(payload) & 1 else b"")


def u24(v):
    return struct.pack("<I", v)[:3]


def anim_webp(cw, ch, frames, loops=0):
    body = chunk(b"VP8X", bytes([0x12, 0, 0, 0]) + u24(cw - 1) + u24(ch - 1))
    body += chunk(b"ANIM", bytes([0x10, 0x20, 0x30, 0xFF]) + struct.pack("<H", loops))
    for x, y, im, delay, blend, dispose, lossless in frames:
        payload = u24(x // 2) + u24(y // 2) + u24(im.width - 1) + u24(im.height - 1) + u24(delay)
        payload += bytes([(0 if blend else 2) | (1 if dispose else 0)])
        for tag, c in still_chunks(im, lossless):
            payload += chunk(tag, c)
        body += chunk(b"ANMF", payload)
    return b"RIFF" + struct.pack("<I", len(body) + 4) + b"WEBP" + body


def blob(w, h, rgba_fn):
    im = Image.new("RGBA", (w, h))
    im.putdata([rgba_fn(x, y) for y in range(h) for x in range(w)])
    return im


frames = [
    (0, 0, blob(40, 30, lambda x, y: (x * 6, y * 8, 120, 255)), 100, True, False, True),
    (4, 2, blob(20, 16, lambda x, y: (250, 20, 20, (x * 12) % 256)), 80, True, True, True),     # blend + dispose
    (10, 6, blob(24, 20, lambda x, y: (20, 230, 40, (y * 12) % 256)), 80, False, False, True),  # no blend
    (2, 10, blob(18, 18, lambda x, y: (30, 40, 250, 160)), 0, True, True, False),               # lossy ALPH, dispose
    (12, 0, blob(28, 30, lambda x, y: (200, 200, (x + y) * 4 % 256, 0 if (x // 4 + y // 4) % 2 else 220)), 60, True, False, False),
    (0, 20, blob(40, 10, lambda x, y: (90, 90, 90, 255)), 60, False, True, False),              # opaque lossy VP8
]
save("webp_manual_flags.webp", anim_webp(40, 30, frames, loops=0), "hand-built: blend/no-blend, dispose, ALPH+VP8, VP8, VP8L")

# Partial first frame: the rest of the canvas must be transparent on every loop.
frames = [
    (8, 8, blob(16, 16, lambda x, y: (255, 200, 0, 255)), 100, True, False, True),
    (0, 0, blob(10, 10, lambda x, y: (0, 120, 255, 255)), 100, True, False, True),
    (30, 30, blob(10, 10, lambda x, y: (255, 0, 120, 255)), 100, True, False, False),
]
save("webp_partial_first.webp", anim_webp(40, 40, frames, loops=0), "partial first frame; leftovers must clear on loop")

(out / "manifest.json").write_text(json.dumps(manifest, indent=1))
print(json.dumps(manifest, indent=1))


# ── GIF written by hand: interlacing, offsets, local palettes, edge cases ─
def lzw(indices, min_size):
    clear, end = 1 << min_size, (1 << min_size) + 1
    out, acc, nbits = bytearray(), 0, 0
    width = min_size + 1

    def emit(code):
        nonlocal acc, nbits
        acc |= code << nbits
        nbits += width
        while nbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8

    table = {(i,): i for i in range(clear)}
    nxt = end + 1
    emit(clear)
    seq = ()
    for px in indices:
        cand = seq + (px,)
        if cand in table:
            seq = cand
            continue
        emit(table[seq])
        if nxt < 4096:
            table[cand] = nxt
            nxt += 1
            if nxt > (1 << width) and width < 12:
                width += 1
        else:
            emit(clear)
            table = {(i,): i for i in range(clear)}
            nxt, width = end + 1, min_size + 1
        seq = (px,)
    if seq:
        emit(table[seq])
    emit(end)
    if nbits:
        out.append(acc & 0xFF)
    blocks = bytearray([min_size])
    for i in range(0, len(out), 255):
        part = out[i:i + 255]
        blocks += bytes([len(part)]) + part
    return bytes(blocks + b"\0")


def color_table(colors):
    n = 2
    while n < len(colors):
        n *= 2
    flat = b"".join(bytes(c) for c in colors) + b"\0\0\0" * (n - len(colors))
    return flat, n.bit_length() - 2


def hand_gif(screen, gct, frames, loop=None):
    flat, size_bits = color_table(gct)
    d = bytearray(b"GIF89a" + struct.pack("<HH", *screen) + bytes([0x80 | 0x70 | size_bits, 0, 0]) + flat)
    if loop is not None:
        d += b"\x21\xFF\x0BNETSCAPE2.0\x03\x01" + struct.pack("<H", loop) + b"\0"
    for fr in frames:
        t = fr.get("transparent")
        packed = (fr.get("disposal", 0) << 2) | (1 if t is not None else 0)
        d += b"\x21\xF9\x04" + bytes([packed]) + struct.pack("<H", fr.get("delay", 5)) + bytes([t or 0, 0])
        w, h = fr["w"], fr["h"]
        rows = [fr["indices"][y * w:(y + 1) * w] for y in range(h)]
        if fr.get("interlaced"):
            order = list(range(0, h, 8)) + list(range(4, h, 8)) + list(range(2, h, 4)) + list(range(1, h, 2))
            rows = [rows[y] for y in order]
        lct = fr.get("lct")
        pk = 0x40 if fr.get("interlaced") else 0
        extra = b""
        if lct:
            lflat, lbits = color_table(lct)
            pk |= 0x80 | lbits
            extra = lflat
        d += b"\x2C" + struct.pack("<HHHH", fr["left"], fr["top"], w, h) + bytes([pk]) + extra
        flat_idx = [i for r in rows for i in r]
        d += lzw(flat_idx, max(2, fr.get("code_size", 8)))
    return bytes(d + b"\x3B")


pal = [(0, 0, 0), (255, 0, 0), (0, 200, 0), (0, 0, 255), (255, 255, 255), (255, 200, 0), (120, 0, 200), (0, 200, 200)]


def pattern(w, h, f):
    return [f(x, y) for y in range(h) for x in range(w)]


hframes = [
    dict(left=0, top=0, w=53, h=37, indices=pattern(53, 37, lambda x, y: (x // 3 + y) % 8), interlaced=True, delay=8),
    dict(left=7, top=5, w=20, h=19, indices=pattern(20, 19, lambda x, y: 9 if (x + y) % 3 == 0 else (x * y) % 8),
         transparent=9, disposal=3, interlaced=True, delay=8),
    dict(left=30, top=20, w=40, h=30, indices=pattern(40, 30, lambda x, y: 5 + (x + y) % 3), disposal=2, delay=8),  # runs off the canvas
    dict(left=2, top=2, w=12, h=12, indices=pattern(12, 12, lambda x, y: (x + 2 * y) % 4), lct=[(10, 20, 30), (200, 100, 0)],
         delay=12),  # indices 2 and 3 are past its 2-colour table
    dict(left=40, top=0, w=13, h=37, indices=pattern(13, 37, lambda x, y: 4 if y % 2 else 3), transparent=3, disposal=1, delay=0),
]
save("gif_hand_interlaced.gif", hand_gif((53, 37), pal, hframes, loop=0),
     "hand-built: interlaced, offsets, dispose previous/background, local palette with out-of-range indices")
(out / "manifest.json").write_text(json.dumps(manifest, indent=1))
