# Generates the extension icons (pure Python, no dependencies).
import struct, zlib, os

def rrect(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def pixel(u, v):
    # u, v in [0,1]
    if not rrect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22):
        return (0, 0, 0, 0)
    col = (255, 144, 232, 255)           # pink background
    if rrect(u, v, 0.14, 0.24, 0.86, 0.72, 0.10):
        col = (22, 22, 26, 255)          # dark subtitle panel
        if rrect(u, v, 0.24, 0.37, 0.76, 0.45, 0.04):
            col = (255, 255, 255, 255)   # line 1
        if rrect(u, v, 0.32, 0.53, 0.68, 0.61, 0.04):
            col = (255, 226, 138, 255)   # line 2 (translation)
    # little speech-bubble tail
    if 0.26 <= u <= 0.40 and 0.72 <= v <= 0.84 and (u - 0.26) >= (v - 0.72) * 1.2:
        col = (22, 22, 26, 255)
    return col

def make(size, path):
    ss = 4
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    p = pixel((x + (sx + .5) / ss) / size, (y + (sy + .5) / ss) / size)
                    for i in range(3):
                        acc[i] += p[i] * p[3]
                    acc[3] += p[3]
            a = acc[3] / (ss * ss)
            if acc[3]:
                row += bytes([int(acc[0] / acc[3]), int(acc[1] / acc[3]), int(acc[2] / acc[3]), int(a)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'extension', 'icons')
for s in (16, 32, 48, 128):
    make(s, os.path.join(out, 'icon%d.png' % s))
