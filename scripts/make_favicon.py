#!/usr/bin/env python3
"""Cut the salamander down to favicon sizes.

Run by hand, not by run.sh: the outputs are committed, and this needs Pillow
(`pip install pillow`), which nothing else in the project does.

    python3 scripts/make_favicon.py

Three things happen that a plain resize would get wrong:

  square      the drawing is wider than it is tall, so it is trimmed to its own
              ink and padded to a square rather than squashed into one
  plate       it is black line on transparency, which all but disappears against
              a dark browser tab, so it sits on the app's panel white with the
              corners rounded as any app icon's are
  ink         thin lines fade at 16 and 32 px, so what survives the resize is
              darkened back to full strength

Reads   web/img/salamander.png
Writes  web/img/favicon-{16,32,64,180}.png
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "web", "img", "salamander.png")
OUT = os.path.join(ROOT, "web", "img")

MARGIN = 0.06        # breathing room around the ink, as a share of its long side
RADIUS = 0.17        # corner radius of the plate, as a share of its side
PLATE = (255, 255, 255, 255)
SIZES = (16, 32, 64, 180)


def main() -> None:
    art = Image.open(SRC).convert("RGBA")
    art = art.crop(art.split()[3].getbbox())            # trim transparent margins
    side = int(max(art.size) * (1 + 2 * MARGIN))

    icon = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ImageDraw.Draw(icon).rounded_rectangle([0, 0, side - 1, side - 1],
                                           radius=int(side * RADIUS), fill=PLATE)
    icon.paste(art, ((side - art.width) // 2, (side - art.height) // 2), art)

    for size in SIZES:
        out = icon.resize((size, size), Image.LANCZOS)
        if size <= 32:
            alpha = out.split()[3]
            rgb = out.convert("RGB").point(lambda v: max(0, round((v - 40) * 255 / 215)))
            out = rgb.convert("RGBA")
            out.putalpha(alpha)
        path = os.path.join(OUT, f"favicon-{size}.png")
        out.save(path)
        print(f"wrote {os.path.relpath(path, ROOT)}  {size}x{size}")


if __name__ == "__main__":
    main()
