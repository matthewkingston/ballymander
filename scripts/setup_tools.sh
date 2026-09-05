#!/usr/bin/env bash
# Fetch build-time toolchain (node + mapshaper) and vendor MapLibre for the app.
# Everything lands in repo-local .tools/ and web/vendor/ -- no sudo, no system changes.
# Remove with:  rm -rf .tools web/vendor
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_VERSION="v24.20.0"          # LTS
MAPSHAPER_VERSION="0.7.58"
MAPLIBRE_VERSION="5.24.0"      # UMD single-file build; v6 is ESM-only and chunk-split

TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS" web/vendor

# --- node ------------------------------------------------------------------
if command -v mapshaper >/dev/null 2>&1 && [ -z "${FORCE_LOCAL_TOOLS:-}" ]; then
  echo "==> using system mapshaper: $(command -v mapshaper)"
elif [ -x "$TOOLS/bin/mapshaper" ]; then
  echo "==> mapshaper already installed in .tools"
else
  if [ ! -x "$TOOLS/bin/node" ]; then
    ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64) NARCH=x64 ;;
      aarch64|arm64) NARCH=arm64 ;;
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
    esac
    TARBALL="node-${NODE_VERSION}-linux-${NARCH}.tar.xz"
    echo "==> downloading node ${NODE_VERSION} (${NARCH}, ~28MB) into .tools/"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}" \
      | tar xJ -C "$TOOLS" --strip-components=1
  fi
  export PATH="$TOOLS/bin:$PATH"
  echo "==> installing mapshaper ${MAPSHAPER_VERSION}"
  npm install --silent --global --prefix "$TOOLS" "mapshaper@${MAPSHAPER_VERSION}"
fi

# --- vendor MapLibre (so the running app makes zero external requests) ------
for f in maplibre-gl.js maplibre-gl.css; do
  if [ ! -s "web/vendor/$f" ]; then
    echo "==> vendoring $f (maplibre-gl ${MAPLIBRE_VERSION})"
    curl -fsSL -o "web/vendor/$f" \
      "https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/$f"
  fi
done

echo
echo "toolchain ready:"
PATH="$TOOLS/bin:$PATH"
echo "  mapshaper $(mapshaper --version 2>&1 | tail -1)"
ls -lh web/vendor | awk 'NR>1 {printf "  web/vendor/%-18s %s\n", $9, $5}'
