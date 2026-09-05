#!/usr/bin/env bash
# Build anything missing, then serve the map on 127.0.0.1:8765.
#   ./run.sh              build if needed, then serve
#   ./run.sh --rebuild    force a rebuild of the map data first
#   ./run.sh --port 9000  serve on another port
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

REBUILD=0
SERVE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) REBUILD=1; shift ;;
    *) SERVE_ARGS+=("$1"); shift ;;
  esac
done

# 1. toolchain (node + mapshaper in .tools/, MapLibre in web/vendor/)
if [ ! -x .tools/bin/mapshaper ] && ! command -v mapshaper >/dev/null 2>&1 \
   || [ ! -s web/vendor/maplibre-gl.js ]; then
  echo "==> toolchain"
  ./scripts/setup_tools.sh
fi

# 2. census attributes -> CSV
if [ "$REBUILD" = 1 ] || [ ! -f build/dz_attributes.csv ]; then
  echo "==> attributes"
  python3 scripts/prepare_attributes.py
fi

# 3. simplified boundaries + join
if [ "$REBUILD" = 1 ] || [ ! -f web/data/dz.geojson ]; then
  echo "==> map data"
  ./scripts/build_map_data.sh
  python3 scripts/verify_build.py
fi

# 4. adjacency graph (guarded on its own artifact: an existing dz.geojson
#    skips step 3, and this must still be built)
if [ "$REBUILD" = 1 ] || [ ! -f web/data/dz_adjacency.json ]; then
  echo "==> adjacency"
  python3 scripts/build_adjacency.py
  python3 scripts/verify_adjacency.py
fi

# 5. serve
echo
exec python3 scripts/serve.py "${SERVE_ARGS[@]}"
