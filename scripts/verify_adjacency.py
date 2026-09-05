#!/usr/bin/env python3
"""Assert the adjacency graph is correct. Exits non-zero on any failure."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import dz_topology as topology
from build_adjacency import MIN_SHARED_M, WATER_CROSSINGS
from dz_graph import ARTIFACT, load

ROOT = Path(__file__).resolve().parent.parent
MAP_DATA = ROOT / "web" / "data" / "dz.geojson"

EXPECTED_ZONES = 3780
EXPECTED_EDGES = 10_743
EXPECTED_BOUNDARY = 10_740
EXPECTED_CROSSINGS = 3
EXPECTED_POINT_TOUCHES = 342
EXPECTED_COMPONENTS = 1

# Simplification must never *lose* a shared border -- that is the property that
# keeps the drawn map consistent with the graph. It may *gain* a few: writing at
# precision=0.00001 (~0.65 m) snaps vertices together, promoting a handful of
# full-resolution point touches into shared segments. Each one is checked to be
# exactly that, so the number is a bound on a known artifact, not a fudge factor.
EXPECTED_QUANTISATION_MERGES = 3

failures: list[str] = []


def check(ok: bool, msg: str) -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {msg}")
    if not ok:
        failures.append(msg)


def main() -> int:
    graph = load()
    doc = json.loads(ARTIFACT.read_text())
    edges = doc["edges"]
    touches = doc["point_touches"]
    print(f"\nverifying {ARTIFACT.relative_to(ROOT)}\n")

    # the artifact describes itself accurately
    meta = graph.meta
    check(meta["zones"] == len(doc["zones"]) and meta["edges"] == len(edges)
          and meta["point_touches"] == len(touches),
          "meta counts match the arrays they describe")

    check(len(graph.zones) == EXPECTED_ZONES,
          f"zone count is {EXPECTED_ZONES:,} (got {len(graph.zones):,})")
    check(len(set(graph.zones)) == len(graph.zones), "zone codes are unique")

    # edges
    boundary = list(graph.edges("boundary"))
    crossings = list(graph.edges("crossing"))
    check(len(edges) == EXPECTED_EDGES,
          f"edge count is {EXPECTED_EDGES:,} (got {len(edges):,})")
    check(len(boundary) == EXPECTED_BOUNDARY,
          f"{EXPECTED_BOUNDARY:,} shared-boundary edges (got {len(boundary):,})")
    check(len(crossings) == EXPECTED_CROSSINGS,
          f"{EXPECTED_CROSSINGS} water crossings (got {len(crossings)})")

    known = set(graph.zones)
    unknown = [e for e in edges if e["a"] not in known or e["b"] not in known]
    check(not unknown, f"every edge joins two known zones (bad: {len(unknown)})")
    check(not [e for e in edges if e["a"] == e["b"]], "no self-loops")

    pairs = [tuple(sorted((e["a"], e["b"]))) for e in edges]
    check(len(set(pairs)) == len(pairs),
          f"no duplicate edges ({len(pairs) - len(set(pairs))} repeated)")

    thin = [e for e in boundary if e["shared_m"] < MIN_SHARED_M]
    check(not thin, f"every boundary edge shares >= {MIN_SHARED_M} m (thin: {len(thin)})")
    check(all(e["shared_m"] == 0.0 and "gap_m" in e and "via" in e for e in crossings),
          "every crossing has shared_m 0.0 plus gap_m and via")

    # graph shape
    comps = graph.components()
    check(len(comps) == EXPECTED_COMPONENTS,
          f"{EXPECTED_COMPONENTS} connected component (got {len(comps)}: "
          f"{[len(c) for c in comps][:5]})")
    isolated = [z for z in graph.zones if graph.degree(z) == 0]
    check(not isolated, f"no isolated zones (got {len(isolated)}: {isolated[:5]})")

    touch_pairs = {tuple(sorted((t["a"], t["b"]))) for t in touches}
    check(len(touches) == EXPECTED_POINT_TOUCHES,
          f"{EXPECTED_POINT_TOUCHES} point touches (got {len(touches):,})")
    check(not (touch_pairs & set(pairs)),
          f"no pair is both an edge and a point touch "
          f"(overlap: {len(touch_pairs & set(pairs))})")

    # cross-check against the drawn map
    if MAP_DATA.exists():
        feats = json.loads(MAP_DATA.read_text())["features"]
        names = {f["properties"]["code"]: f["properties"]["name"] for f in feats}
        check(set(names) == known, "zone codes match web/data/dz.geojson")

        declared = {tuple(sorted((a, b))) for a, b, _ in WATER_CROSSINGS}
        got = {tuple(sorted((names.get(e["a"], "?"), names.get(e["b"], "?"))))
               for e in crossings}
        check(got == declared,
              f"crossings resolve to the declared names (missing: "
              f"{sorted(declared - got)})")

        topo = topology.build(feats, "code")
        simplified = {
            tuple(sorted((topo.codes[a], topo.codes[b])))
            for (a, b), m in topology.shared_boundaries(topo).items()
            if m >= MIN_SHARED_M
        }
        full = {tuple(sorted((e["a"], e["b"]))) for e in boundary}
        lost = full - simplified
        check(not lost,
              f"simplification preserved every shared border (lost: {len(lost)} "
              f"{[tuple(names.get(c, c) for c in p) for p in sorted(lost)][:3]})")

        gained = simplified - full
        not_touches = gained - touch_pairs
        check(not not_touches,
              f"every border simplification added was a point touch at full "
              f"resolution (other: {len(not_touches)})")
        check(len(gained) <= EXPECTED_QUANTISATION_MERGES,
              f"at most {EXPECTED_QUANTISATION_MERGES} point touches merged by "
              f"output quantisation (got {len(gained)})")
    else:
        print("\n  (web/data/dz.geojson absent, skipped map cross-check)")

    degrees = sorted(graph.degree(z) for z in graph.zones)
    print(f"\n  degree   min {degrees[0]} / mean {sum(degrees) / len(degrees):.2f} "
          f"/ max {degrees[-1]}")
    print(f"  size     {ARTIFACT.stat().st_size / 1e6:.1f} MB")

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
