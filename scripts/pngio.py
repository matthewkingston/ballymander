"""Read and write 8-bit RGBA PNGs with nothing but the standard library.

Pillow would do this in two lines, and make_favicon.py uses it -- but installing
it here needs python3-venv, which needs root, and the one format this has to
read is the one Inkscape emits. zlib and struct are enough for that.

Reads   8-bit RGB or RGBA, no interlacing (anything else is a hard error rather
        than a quiet misread)
Writes  8-bit RGBA, filter 0 on every row, zlib doing the compression
"""
from __future__ import annotations

import struct
import zlib

SIG = b'\x89PNG\r\n\x1a\n'


def _chunks(raw):
    if raw[:8] != SIG:
        raise SystemExit('not a PNG')
    i = 8
    while i < len(raw):
        (length,) = struct.unpack('>I', raw[i:i + 4])
        yield raw[i + 4:i + 8], raw[i + 8:i + 8 + length]
        i += 8 + length + 4


def load_rgba(path):
    """-> (width, height, bytearray of width*height*4)."""
    raw = open(path, 'rb').read()
    head = None
    idat = bytearray()
    for kind, body in _chunks(raw):
        if kind == b'IHDR':
            head = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            idat += body
    if head is None:
        raise SystemExit(f'{path}: no IHDR')
    w, h, depth, colour, _, _, interlace = head
    if depth != 8 or colour not in (2, 6) or interlace:
        raise SystemExit(f'{path}: need 8-bit RGB/RGBA and no interlace, got '
                         f'depth {depth}, colour type {colour}, interlace {interlace}')
    ch = 4 if colour == 6 else 3
    stride = w * ch
    data = zlib.decompress(bytes(idat))
    if len(data) != (stride + 1) * h:
        raise SystemExit(f'{path}: {len(data)} bytes of pixel data, expected '
                         f'{(stride + 1) * h}')
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = data[pos]
        pos += 1
        line = bytearray(data[pos:pos + stride])
        pos += stride
        # The five filters, undone in place. Sub and Up are the common ones and
        # are worth their own loops; the other two are rare enough to be slow.
        if f == 1:
            for x in range(ch, stride):
                line[x] = (line[x] + line[x - ch]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        elif f != 0:
            raise SystemExit(f'{path}: row {y} has filter {f}')
        if ch == 4:
            out[y * w * 4:(y + 1) * w * 4] = line
        else:
            base = y * w * 4
            for x in range(w):
                out[base + x * 4:base + x * 4 + 3] = line[x * 3:x * 3 + 3]
                out[base + x * 4 + 3] = 255
        prev = line
    return w, h, out


def save_rgba(path, w, h, px):
    """px is width*height*4 bytes, RGBA."""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * w * 4:(y + 1) * w * 4]

    def chunk(kind, body):
        return (struct.pack('>I', len(body)) + kind + body
                + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff))

    with open(path, 'wb') as fh:
        fh.write(SIG)
        fh.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
        fh.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        fh.write(chunk(b'IEND', b''))
