#!/usr/bin/env python3
"""Generate the Phone Studio PWA icons (PNG, stdlib only — no PIL).

Design: dark rounded square (#141414) with seven amber (#ffb020)
waveform bars. No emoji, no text. Sizes: 180 (Apple touch icon),
192 + 512 (manifest).
"""
import struct
import zlib


def png_chunk(kind, data):
    chunk = struct.pack(">I", len(data)) + kind + data
    chunk += struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return chunk


def make_png(size, path):
    bg = (20, 20, 20)       # #141414
    bar = (255, 176, 32)    # #ffb020
    radius = size // 6
    # Seven bars, heights as fractions of the icon size.
    heights = [0.28, 0.44, 0.62, 0.78, 0.62, 0.44, 0.28]
    gap = size // 28
    total_gap = gap * (len(heights) - 1)
    bar_w = (size // 2 - total_gap) // len(heights)
    total_w = bar_w * len(heights) + total_gap
    x0 = (size - total_w) // 2
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filter: none
        for x in range(size):
            # Rounded corners: outside the radius -> transparent.
            in_corner = False
            cx = min(max(x, radius), size - 1 - radius)
            cy = min(max(y, radius), size - 1 - radius)
            if (x - cx) ** 2 + (y - cy) ** 2 > radius * radius:
                in_corner = True
            if in_corner:
                rows += bytes((0, 0, 0, 0))
                continue
            r, g, b = bg
            # Waveform bars.
            for i, h in enumerate(heights):
                bx0 = x0 + i * (bar_w + gap)
                bx1 = bx0 + bar_w
                bh = int(h * size)
                by0 = (size - bh) // 2
                by1 = by0 + bh
                if bx0 <= x < bx1 and by0 <= y < by1:
                    r, g, b = bar
                    break
            rows += bytes((r, g, b, 255))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + png_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print(f"{path}: {len(png)} bytes")


if __name__ == "__main__":
    import os

    here = os.path.dirname(os.path.abspath(__file__))
    for size in (180, 192, 512):
        make_png(size, os.path.join(here, f"icon-{size}.png"))
