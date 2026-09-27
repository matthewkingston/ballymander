#!/usr/bin/env python3
"""Stamp each local file index.html loads with a hash of its contents.

Run by scripts/deploy.sh on the staged copy, never on web/ itself:

    python3 scripts/stamp_assets.py STAGED_WEB_DIR

`app.js` becomes `app.js?v=3f9c2a1b`, and so on for every src= and href= in
index.html that names a file in the directory. Cloudflare and browsers cache
those files for hours, where index.html is fetched fresh every time; so without
this a deploy can pair the new page with the old script. With it, a changed
file has a new URL and is fetched fresh, and an unchanged one keeps its URL and
stays cached.

Only index.html is rewritten. Files reached some other way -- the data app.js
fetches, the pictures its pages name -- keep their plain URLs.
"""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

ATTR = re.compile(r'\b(src|href)="([^"#?:]+)"')


def stamp(web: Path) -> int:
    index = web / "index.html"
    html = index.read_text()
    count = 0

    def replace(m: re.Match) -> str:
        nonlocal count
        path = web / m.group(2)
        if not path.is_file():
            return m.group(0)
        count += 1
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:8]
        return f'{m.group(1)}="{m.group(2)}?v={digest}"'

    index.write_text(ATTR.sub(replace, html))
    return count


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} STAGED_WEB_DIR")
    print(f"stamped {stamp(Path(sys.argv[1]))} asset URLs in index.html")
