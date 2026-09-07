#!/usr/bin/env python3
"""Assert the built map data is correct. Exits non-zero on any failure."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "DZ2021.geojson"
OUT = ROOT / "web" / "data" / "dz.geojson"

EXPECTED_FEATURES = 3780
EXPECTED_POP = 1_903_168
# The religion table is ten people short of the people table: NISRA's disclosure
# control perturbs them independently. Checking it against EXPECTED_POP would
# fail, and rel_n is the right denominator for the religion index anyway.
EXPECTED_REL_TOTAL = 1_903_158

failures: list[str] = []


def check(ok: bool, msg: str) -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {msg}")
    if not ok:
        failures.append(msg)


def vertices(feat) -> int:
    g = feat["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    return sum(len(r) for p in polys for r in p)


def main() -> int:
    if not OUT.exists():
        raise SystemExit(f"missing {OUT} -- run scripts/build_map_data.sh")

    out = json.loads(OUT.read_text())
    feats = out["features"]
    print(f"\nverifying {OUT.relative_to(ROOT)}\n")

    check(len(feats) == EXPECTED_FEATURES,
          f"feature count is {EXPECTED_FEATURES} (got {len(feats):,})")

    props = [f["properties"] for f in feats]

    # attributes
    missing_pop = [p.get("code") for p in props if p.get("pop") is None]
    check(not missing_pop, f"every feature has pop (missing: {len(missing_pop)})")

    total = sum(p["pop"] for p in props if p.get("pop") is not None)
    check(total == EXPECTED_POP,
          f"populations sum to {EXPECTED_POP:,} (got {total:,})")

    rel_total = sum(p["rel_n"] for p in props if p.get("rel_n") is not None)
    check(rel_total == EXPECTED_REL_TOTAL,
          f"religion counts sum to {EXPECTED_REL_TOTAL:,} (got {rel_total:,})")

    bad_rel = [p.get("code") for p in props
               if not isinstance(p.get("rel"), (int, float)) or not 0 <= p["rel"] <= 1]
    check(not bad_rel, f"every 'rel' is a number in 0..1 (bad: {len(bad_rel)})")

    for field in ("code", "name", "sdz", "lgd", "area_ha", "rel", "rel_n"):
        n = sum(1 for p in props if p.get(field) in (None, ""))
        check(n == 0, f"every feature has '{field}' (missing: {n})")

    codes = [p["code"] for p in props]
    check(len(set(codes)) == len(codes), f"codes are unique ({len(set(codes)):,})")

    # geometry integrity
    bad_rings = unclosed = 0
    out_verts = 0
    for f in feats:
        g = f["geometry"]
        if g is None:
            bad_rings += 1
            continue
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            for ring in poly:
                out_verts += len(ring)
                if len(ring) < 4:
                    bad_rings += 1
                if ring[0] != ring[-1]:
                    unclosed += 1
    check(bad_rings == 0, f"no rings under 4 points (bad: {bad_rings})")
    check(unclosed == 0, f"all rings closed (unclosed: {unclosed})")

    # cross-check against the source boundaries
    if SRC.exists():
        src = json.loads(SRC.read_text())["features"]
        src_codes = {f["properties"]["DZ2021_cd"] for f in src}
        check(src_codes == set(codes), "code set matches source DZ2021.geojson")
        src_verts = sum(vertices(f) for f in src)
        print(f"\n  vertices {src_verts:,} -> {out_verts:,} "
              f"({out_verts / src_verts * 100:.1f}% retained)")
    else:
        print("\n  (source geojson absent, skipped code cross-check)")

    size = OUT.stat().st_size
    print(f"  size     {size / 1e6:.1f} MB")

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
