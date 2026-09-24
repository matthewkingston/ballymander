#!/usr/bin/env python3
"""Prepare the wide gable: key out the text box and record where it was.

Run by hand when the artwork changes, not by run.sh: the outputs are committed.

    python3 scripts/build_gable.py

The drawing is the building's front, unchanged from the old logo, with its side
extended to the right and a flat magenta rectangle marking where the article
title goes. Two things happen to it:

  key         the magenta is erased to transparency, so the marker never ships.
              Matched loosely rather than on one exact value, since the
              rectangle's edge is anti-aliased against the wall behind it.

  box         its bounds are written out as fractions of the image, not pixels.
              Fractions survive the gable being drawn at any size, and they mean
              nudging the rectangle in Inkscape and rerunning this is the whole
              of moving the title -- no coordinates to carry across by hand.

The front's width is read from the old logo rather than written down here: the
side was added to the right of it, so that file is what says where the front
ends, and it is what the panel pins the mural's size to.

Reads   art/ballymander-article.png, web/img/ballymander-wide.png
Writes  web/img/ballymander-article.png, web/gable.js
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pngio import load_rgba, save_rgba                         # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'art', 'ballymander-article.png')
FRONT = os.path.join(ROOT, 'web', 'img', 'ballymander-wide.png')
OUT_PNG = os.path.join(ROOT, 'web', 'img', 'ballymander-article.png')
OUT_JS = os.path.join(ROOT, 'web', 'gable.js')


def is_flat_magenta(r, g, b, a):
    """The marker's own colour, for finding where it was drawn."""
    return a > 0 and r > 180 and b > 180 and g < 100


def is_tinted(r, g, b, a, margin=24):
    """Any magenta at all, at any alpha: red and blue both well above green.

    The marker is anti-aliased against what is behind it, so its edge is the
    colour at a fraction of its opacity -- which an earlier version of this
    missed by demanding the pixel be mostly opaque, and left a one-pixel
    magenta line round the text box. Matching on hue instead catches the edge
    however faint it is. The drawing's own colours are blues and greys, where
    red sits at or below green, so none of them match.
    """
    return a > 0 and r > g + margin and b > g + margin


def main() -> int:
    w, h, px = load_rgba(SRC)
    fw, fh, _ = load_rgba(FRONT)
    if fh != h:
        raise SystemExit(f'the front is {fw}x{fh} and the article gable {w}x{h}: '
                         f'the heights must match or the mural changes size')
    if w <= fw:
        raise SystemExit(f'the article gable ({w}) is no wider than the front ({fw})')

    xs0, xs1, ys0, ys1 = w, -1, h, -1
    found = 0
    for y in range(h):
        base = y * w
        for x in range(w):
            i = (base + x) * 4
            if is_flat_magenta(px[i], px[i + 1], px[i + 2], px[i + 3]):
                found += 1
                xs0, xs1 = min(xs0, x), max(xs1, x)
                ys0, ys1 = min(ys0, y), max(ys1, y)
    if not found:
        raise SystemExit('no magenta rectangle found -- is the marker still in the art?')
    bw, bh = xs1 - xs0 + 1, ys1 - ys0 + 1
    fill = found / (bw * bh)
    if fill < 0.9:
        raise SystemExit(f'the magenta covers only {fill:.0%} of its own bounds -- '
                         f'expected a filled rectangle, not a shape')
    if xs0 < fw:
        raise SystemExit(f'the text box starts at x={xs0}, inside the front '
                         f'(which ends at {fw}) -- it belongs on the side')

    # Erased rather than left to be covered: the marker must not ship even if
    # the title is one day not drawn over it. By hue across the whole image
    # rather than by the rectangle's bounds, so the anti-aliased edge goes with
    # it -- that edge sits outside the flat fill, so anything working from the
    # bounds leaves exactly the one-pixel line this used to.
    stray = 0
    wiped = 0
    for y in range(h):
        base = y * w
        for x in range(w):
            i = (base + x) * 4
            if not is_tinted(px[i], px[i + 1], px[i + 2], px[i + 3]):
                continue
            # Anything far from the rectangle is not its edge, and erasing it
            # would be erasing the drawing.
            if not (xs0 - 4 <= x <= xs1 + 4 and ys0 - 4 <= y <= ys1 + 4):
                stray += 1
                continue
            px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0
            wiped += 1
    if stray:
        raise SystemExit(f'{stray} magenta pixels sit away from the marker -- '
                         f'the colour is meant to appear nowhere else in the art')
    # Checked at a far lower threshold than it was erased at: a tint too weak
    # to match at 24 would still be visible against the wall.
    left = sum(1 for y in range(h) for x in range(w)
               if is_tinted(*(px[((y * w + x) * 4) + k] for k in range(4)), margin=8))
    if left:
        raise SystemExit(f'{left} magenta pixels survived the key')

    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
    save_rgba(OUT_PNG, w, h, px)

    meta = {
        'image': 'img/ballymander-article.png',
        'width': w,
        'height': h,
        # What the panel pins the mural's size to: the gable is shown at
        # width/front times whatever the front alone used to take.
        'front': fw,
        'title': {
            'x': round(xs0 / w, 6), 'y': round(ys0 / h, 6),
            'w': round(bw / w, 6), 'h': round(bh / h, 6),
        },
    }
    with open(OUT_JS, 'w') as fh_:
        fh_.write('/* Generated by scripts/build_gable.py -- do not edit.\n'
                  ' * Rebuild after changing art/ballymander-article.png. */\n')
        fh_.write('const GABLE = ')
        fh_.write(json.dumps(meta, indent=2))
        fh_.write(';\n')

    print(f'gable {w}x{h}, front {fw} ({w / fw:.5f}x wider)')
    print(f'{wiped} magenta pixels erased, {found} of them the flat fill')
    print(f'text box {bw}x{bh} at {xs0},{ys0} -- '
          f'{meta["title"]["w"]:.4f} of the width, {meta["title"]["h"]:.4f} of the height')
    print(f'wrote {os.path.relpath(OUT_PNG, ROOT)} '
          f'({os.path.getsize(OUT_PNG) / 1024:.0f} KB) and {os.path.relpath(OUT_JS, ROOT)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
