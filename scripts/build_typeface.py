#!/usr/bin/env python3
"""Turn the drawn letter row into a sprite sheet that text can be set in.

Run by hand when a letter changes, not by run.sh: the outputs are committed.

    python3 scripts/build_typeface.py

The source is one Inkscape export of all the characters in a row, black line
art with white rectangles used to cut strokes off, on whatever background
Inkscape gave it. Three things happen to it:

  ink         the art is flattened onto white and darkness becomes alpha, so
              black stays, white goes transparent, and the anti-aliased edge
              becomes partial alpha rather than a grey fringe. That turns the
              masking rectangles into real gaps -- a cut stroke reads as a cut
              on any background, not as a white nick that only disappears
              against the panel -- and leaves the ink as pure alpha, so a title
              can be any colour without being redrawn.

  band        two white rules run the length of the row, one above the letters
              and one below, and they are level where the letterforms are only
              aligned by eye. Their inner edges are the top line and the
              baseline, so every glyph is cut to that same band and no glyph
              carries vertical metrics of its own.

  split       the row is cut at the columns with no ink in them. The drawn gaps
              vary from 43 to 178 px, which is how the row was laid out rather
              than how it should be set, so they are discarded: only each
              glyph's own width survives.

Reads   art/ballysanser-sheet.png
Writes  web/img/ballysanser.png, web/ballysanser.js
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pngio import load_rgba, save_rgba                         # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'art', 'ballysanser-sheet.png')
OUT_PNG = os.path.join(ROOT, 'web', 'img', 'ballysanser.png')
OUT_JS = os.path.join(ROOT, 'web', 'ballysanser.js')

# Left to right in the drawing. A character not in here cannot be set.
ORDER = list('abcdefghijklmnopqrstuvwxyz') + ["'", '?']

# A column holding less than this much ink in total is between glyphs rather
# than inside one. One fully black pixel is 255, so this is four of them: above
# the stray anti-aliasing at the very top and bottom of the sheet, far below
# any real stroke.
INK_FLOOR = 255 * 4

# A row this white, right across the sheet, is one of the two rules.
RULE_WHITE = 0.5

# Transparent columns between the glyphs on the sheet, so that scaling it down
# blends each one's edge with nothing rather than with its neighbour. Generous:
# it costs 700px of sheet width and a few KB, and too little would show as a
# smear along the side of every letter.
GUTTER = 24

# Spacing, as a fraction of the band height, since that is the one dimension
# every glyph shares. Neither is measurable from the drawing: the gaps in it
# are layout, not tracking, and there is no space character to measure. Both
# are here to be argued with.
TRACKING = 0.07
WORD_SPACE = 0.25


def main() -> int:
    w, h, px = load_rgba(SRC)

    # --- ink: flatten onto white, darkness becomes alpha --------------------
    ink = bytearray(w * h)
    for i in range(w * h):
        r, g, b, a = px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3]
        lum = (r * 299 + g * 587 + b * 114) // 1000
        ink[i] = 255 - ((lum * a + 255 * (255 - a)) // 255)

    # --- band: the inner edges of the two rules -----------------------------
    rules = []
    for y in range(h):
        white = 0
        for x in range(w):
            i = (y * w + x) * 4
            if px[i + 3] == 255 and min(px[i], px[i + 1], px[i + 2]) > 250:
                white += 1
        rules.append(white / w > RULE_WHITE)
    # Found as runs rather than assumed to touch the edges: the export crops to
    # the drawing, and a sliver of art can stick out past a rule.
    runs = []
    run = None
    for y, is_rule in enumerate(rules):
        if is_rule:
            run = [y, y] if run is None else [run[0], y]
        elif run is not None:
            runs.append(run)
            run = None
    if run is not None:
        runs.append(run)
    if len(runs) < 2:
        raise SystemExit(f'expected a white rule above and below the letters, '
                         f'found {len(runs)}')
    if runs[0][0] > h // 4 or runs[-1][1] < h - h // 4:
        raise SystemExit('the white rules are not at the top and bottom of the sheet')
    top = runs[0][1] + 1
    bottom = runs[-1][0] - 1
    band = bottom - top + 1
    print(f'sheet {w}x{h}: rules at rows {runs[0][0]}-{runs[0][1]} and '
          f'{runs[-1][0]}-{runs[-1][1]}, leaving a band of {band} at {top}..{bottom}')

    # --- split: columns with no ink in the band -----------------------------
    cols = [0] * w
    for y in range(top, bottom + 1):
        base = y * w
        for x in range(w):
            cols[x] += ink[base + x]
    groups = []
    run = None
    for x, v in enumerate(cols):
        if v > INK_FLOOR:
            run = [x, x] if run is None else [run[0], x]
        elif run is not None:
            groups.append(run)
            run = None
    if run is not None:
        groups.append(run)
    if len(groups) != len(ORDER):
        raise SystemExit(f'found {len(groups)} glyphs for {len(ORDER)} characters -- '
                         f'either the order is wrong or two letters are touching')

    # --- the sheet ----------------------------------------------------------
    # Packed with a transparent gutter between the glyphs, not edge to edge.
    # The page scales the whole sheet down and shows one glyph's width of it
    # through a clipping box; with the glyphs touching, the filter at each
    # boundary samples the neighbouring letter and smears a sliver of it into
    # the box. The gutter gives it transparency to blend with instead, and has
    # to be wider than the filter reaches -- at the smallest size the sheet is
    # shown at, that is around thirteen source pixels.
    widths = [x1 - x0 + 1 for x0, x1 in groups]
    sheet_w = sum(widths) + GUTTER * (len(widths) + 1)
    out = bytearray(sheet_w * band * 4)
    glyphs = {}
    at = GUTTER
    for ch, (x0, x1) in zip(ORDER, groups):
        gw = x1 - x0 + 1
        for y in range(band):
            src = (top + y) * w
            dst = (y * sheet_w + at) * 4
            for x in range(gw):
                alpha = ink[src + x0 + x]
                # Black, with the drawing's darkness as its alpha.
                out[dst + x * 4 + 3] = alpha
        glyphs[ch] = {'x': at, 'w': gw}
        at += gw + GUTTER

    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
    save_rgba(OUT_PNG, sheet_w, band, out)

    meta = {
        'sheet': 'img/ballysanser.png',
        'sheetWidth': sheet_w,
        'band': band,
        'tracking': TRACKING,
        'wordSpace': WORD_SPACE,
        'glyphs': glyphs,
    }
    with open(OUT_JS, 'w') as fh:
        fh.write('/* Generated by scripts/build_typeface.py -- do not edit.\n'
                 ' * Rebuild after changing art/ballysanser-sheet.png.\n'
                 ' *\n'
                 ' * A plain global rather than a module export: the page loads\n'
                 ' * its scripts the old way, as graph.js and regions.js do. */\n')
        fh.write('const BALLYSANSER = ')
        fh.write(json.dumps(meta, indent=2))
        fh.write(';\n')

    thin = min(widths)
    wide = max(widths)
    print(f'{len(glyphs)} glyphs, {sheet_w}x{band}, widths {thin}..{wide}')
    print(f'wrote {os.path.relpath(OUT_PNG, ROOT)} '
          f'({os.path.getsize(OUT_PNG) / 1024:.0f} KB) '
          f'and {os.path.relpath(OUT_JS, ROOT)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
