#!/usr/bin/env bash
# Simplify DZ boundaries (topology-aware) and join census attributes.
#   in : data/DZ2021.geojson (75MB, 1.76M vertices) + build/dz_attributes.csv
#   out: web/data/dz.geojson (~3-4MB)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/.tools/bin:$PATH"

SIMPLIFY="${SIMPLIFY:-6%}"   # share of removable vertices retained; tune vs output size
IN="data/DZ2021.geojson"
ATTRS="build/dz_attributes.csv"
OUT="web/data/dz.geojson"

[ -f "$IN" ]    || { echo "missing $IN" >&2; exit 1; }
[ -f "$ATTRS" ] || { echo "missing $ATTRS -- run scripts/prepare_attributes.py first" >&2; exit 1; }

# mapshaper-xl raises node's heap; the 75MB input can exceed the default.
MS=mapshaper-xl
command -v "$MS" >/dev/null 2>&1 || MS=mapshaper

mkdir -p "$(dirname "$OUT")"
echo "==> simplifying at ${SIMPLIFY} (Visvalingam weighted, keep-shapes)"

"$MS" 6gb "$IN" \
  -simplify "$SIMPLIFY" keep-shapes \
  -join "$ATTRS" keys=DZ2021_cd,code \
    field-types=code:str,pop:num,rel:num,rel_n:num \
  -filter-fields DZ2021_cd,DZ2021_nm,SDZ2021_cd,LGD2014_nm,Area_ha,pop,rel,rel_n \
  -rename-fields code=DZ2021_cd,name=DZ2021_nm,sdz=SDZ2021_cd,lgd=LGD2014_nm,area_ha=Area_ha \
  -o "$OUT" precision=0.00001

echo
ls -lh "$OUT" | awk '{print "==> " $9 ": " $5}'
