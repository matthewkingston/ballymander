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

# One entry per collapsed index: column, what to call it, the total its own
# denominator must come to, and the range the index has to lie in.
#
# Every total is different, and none of them is EXPECTED_POP. Two reasons:
# NISRA's disclosure control perturbs each table independently, which accounts
# for the handful of people between religion, age and population; and the two
# newest exclude non-answers from the denominator entirely, so they are a share
# of those who answered rather than of everyone. Checking any of these against
# EXPECTED_POP would fail, and each `_n` is the right denominator for its own
# index anyway.
INDEXES = [
    ("rel", "religion", 1_903_158, 0, 1),
    ("age", "age", 1_903_347, 0, 100),
    ("orient", "sexual orientation", 1_395_521, 0, 1),
    ("grade", "social grade", 1_511_617, 0, 1),
]

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

    for col, label, expected, lo, hi in INDEXES:
        n_col = f"{col}_n"
        got = sum(p[n_col] for p in props if p.get(n_col) is not None)
        check(got == expected,
              f"{label} counts sum to {expected:,} (got {got:,})")

        bad = [p.get("code") for p in props
               if not isinstance(p.get(col), (int, float)) or not lo <= p[col] <= hi]
        check(not bad, f"every '{col}' is a number in {lo}..{hi} (bad: {len(bad)})")

    index_fields = tuple(f for col, *_ in INDEXES for f in (col, f"{col}_n"))
    for field in ("code", "name", "sdz", "lgd", "area_ha", *index_fields):
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
