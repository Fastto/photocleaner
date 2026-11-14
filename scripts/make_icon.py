"""Generates a simple 1024x1024 source icon (icon-src.png) with the stdlib only."""
import struct, zlib, sys
N = 1024
rows = []
for y in range(N):
    row = bytearray([0])
    for x in range(N):
        # rounded square mask
        r = 200
        cx = min(max(x, r), N - 1 - r); cy = min(max(y, r), N - 1 - r)
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
        if not inside:
            row += bytes((0, 0, 0, 0)); continue
        t = y / N
        px = (int(40 + 40 * t), int(110 + 60 * (1 - t)), int(230 - 40 * t), 255)
        # "photo" frame + sun + mountains
        if 220 < x < 804 and 260 < y < 764:
            px = (250, 250, 252, 255)
            if 250 < x < 774 and 290 < y < 734:
                px = (60, 130, 220, 255)
                if (x - 600) ** 2 + (y - 420) ** 2 < 55 ** 2: px = (255, 214, 80, 255)
                base = 734
                if y > base - 170 + abs(x - 420) * 0.9 or y > base - 120 + abs(x - 620) * 0.9:
                    px = (36, 150, 100, 255)
        row += bytes(px)
    rows.append(bytes(row))
raw = b"".join(rows)
def chunk(t, d):
    c = struct.pack(">I", len(d)) + t + d
    return c + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
open(sys.argv[1] if len(sys.argv) > 1 else "icon-src.png", "wb").write(png)
