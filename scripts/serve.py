#!/usr/bin/env python3
"""Static server for web/, with gzip.

Binds 127.0.0.1 only -- this box has a public IP, so the app is reached over an
SSH tunnel rather than being exposed:

    ssh -L 8765:localhost:8765 <user>@<box>     # then http://localhost:8765

Gzip matters here because every byte crosses that tunnel: the GeoJSON drops from
~3.6MB to ~0.7MB. Compressed bodies are cached in memory and invalidated on mtime.
"""
from __future__ import annotations

import argparse
import gzip
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"

COMPRESSIBLE = {".html", ".js", ".css", ".json", ".geojson", ".svg", ".csv", ".txt", ".map"}
MIN_SIZE = 1024

_cache: dict[str, tuple[float, bytes]] = {}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        payload = self._gzipped()
        if payload is None:
            super().do_GET()
            return
        body, ctype = payload
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")  # always pick up rebuilds
        self.end_headers()
        self.wfile.write(body)

    def _gzipped(self) -> tuple[bytes, str] | None:
        """Compressed body for this request, or None to fall back to the base class."""
        if "gzip" not in self.headers.get("Accept-Encoding", ""):
            return None
        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.isfile(path):
            return None
        if os.path.splitext(path)[1].lower() not in COMPRESSIBLE:
            return None
        try:
            stat = os.stat(path)
            if stat.st_size < MIN_SIZE:
                return None
            cached = _cache.get(path)
            if cached and cached[0] == stat.st_mtime:
                body = cached[1]
            else:
                with open(path, "rb") as fh:
                    body = gzip.compress(fh.read(), 6)
                _cache[path] = (stat.st_mtime, body)
        except OSError:
            return None
        return body, self.guess_type(path)

    def log_message(self, fmt: str, *args) -> None:
        if len(args) > 1 and str(args[1]).startswith(("2", "3")):
            return  # only surface problems
        super().log_message(fmt, *args)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="default 127.0.0.1; do not bind 0.0.0.0 on a public-IP box")
    args = ap.parse_args()

    if not (WEB_ROOT / "data" / "dz.geojson").exists():
        print("warning: web/data/dz.geojson missing -- run scripts/build_map_data.sh\n")

    handler = partial(Handler, directory=str(WEB_ROOT))
    with ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        print(f"serving {WEB_ROOT} on http://{args.host}:{args.port}")
        print(f"\n  from your laptop:  ssh -L {args.port}:localhost:{args.port} "
              f"{os.environ.get('USER', 'user')}@<this-box>")
        print(f"  then open:         http://localhost:{args.port}\n")
        print("Ctrl-C to stop", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
