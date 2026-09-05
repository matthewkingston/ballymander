#!/usr/bin/env bash
# Headless browser check: load the app, assert no console/network errors,
# hover a zone, and write screenshots. Requires ./run.sh to be serving already.
#
# The browser + its shared libraries + fonts all live under .tools/ (no sudo).
# If they are missing, see the "Headless verification" section of README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$ROOT/.tools/bin:$PATH"
export PUPPETEER_CACHE_DIR="$ROOT/.tools/puppeteer"
export LD_LIBRARY_PATH="$ROOT/.tools/sysroot/usr/lib/x86_64-linux-gnu:$ROOT/.tools/sysroot/lib/x86_64-linux-gnu"
export FONTCONFIG_FILE="$ROOT/.tools/fonts.conf"
export OUTDIR="${OUTDIR:-$ROOT/build}"

mkdir -p "$OUTDIR"

if [ ! -d .tools/pptr/node_modules/puppeteer ]; then
  echo "puppeteer not installed -- see README 'Headless verification'" >&2
  exit 1
fi

cd .tools/pptr
exec node "$ROOT/scripts/smoke_test.mjs"
