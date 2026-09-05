#!/usr/bin/env python3
"""Build the Data Zone adjacency graph.

    data/DZ2021.geojson  ->  web/data/dz_adjacency.json

Two zones are neighbours when they share a length of boundary. Shared vertices in
the source are float-identical, so that is an exact test -- no tolerance, no
snapping (see dz_topology.py).

Shared boundary alone is not enough, because the DZ mosaic excludes water: Lough
Neagh, Strangford, Belfast Lough, Lough Foyle and Carlingford are uncovered holes
and the coast is a hard edge. Left at that, Rathlin Island is not in the graph at
all. Hence WATER_CROSSINGS below.

Takes about a minute; run.sh only runs it when the artifact is missing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import dz_topology as topology
from dz_graph import connected_components

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "DZ2021.geojson"
OUT = ROOT / "web" / "data" / "dz_adjacency.json"

CODE_FIELD = "DZ2021_cd"
NAME_FIELD = "DZ2021_nm"

# --- water crossings ------------------------------------------------------
# Pairs that are genuinely connected but share no boundary, because the water
# between them is not part of the mosaic. Declared by zone *name* so the list can
# be checked by eye; names are resolved to codes at build time and anything that
# stops resolving, or that turns out to already share a boundary, is a hard
# failure rather than a silently wrong edge.
#
# The test is whether there is a real-world way across -- a bridge or a ferry --
# NOT how narrow the water is. Somewhere you cannot cross is far away in the only
# sense that matters, however close it looks on a map. So the two sides of
# Belfast Lough, Lough Neagh and Lough Foyle are not neighbours, and neither is
# the mouth of Larne Lough (319 m of water, considered and rejected: nothing
# crosses it, so it stays 6 hops apart by land).
WATER_CROSSINGS: list[tuple[str, str, str]] = [
    ("Erne_West_F3", "Erne_East_F1", "River Erne at Enniskillen"),
    ("Downpatrick_B1", "Ards_Peninsula_N4", "Strangford Narrows ferry"),
    ("The_Glens_B3", "The_Glens_B1", "Rathlin Island ferry"),
]

# Below this, a "shared boundary" is a digitising artifact where three zones meet,
# not a border: the smallest is 0.32 mm and the next smallest real one is 0.61 m,
# ~1,900x larger. Counting it would contradict excluding corner touches, since
# that is physically what it is -- so such pairs fall through to point_touches.
# Anything between 1 mm and 0.5 m gives the same answer; the value is not
# load-bearing, the gap in the distribution is.
MIN_SHARED_M = 0.01

DEFINITION = (
    "neighbours share a length of boundary; plus declared water crossings; "
    "zones meeting at a single point are recorded but are not neighbours"
)


def resolve(features: list[dict]) -> dict[str, int]:
    """Zone name -> feature index. Names must be unique to be usable as keys."""
    index: dict[str, int] = {}
    for i, feat in enumerate(features):
        name = feat["properties"][NAME_FIELD]
        if name in index:
            raise SystemExit(
                f"{SRC.name}: zone name {name!r} is not unique -- "
                f"WATER_CROSSINGS keys on names, so it can no longer be resolved"
            )
        index[name] = i
    return index


def dump(doc: dict, path: Path) -> None:
    """Write with one record per line, so 10k edges stay greppable and diffable."""
    out = [
        "{",
        f'"meta": {json.dumps(doc["meta"], indent=2)},',
        f'"zones": {json.dumps(doc["zones"])},',
        '"edges": [',
        ",\n".join("  " + json.dumps(e) for e in doc["edges"]),
        "],",
        '"point_touches": [',
        ",\n".join("  " + json.dumps(t) for t in doc["point_touches"]),
        "]",
        "}",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n")


def main() -> int:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC} -- the source boundaries are not in the repo")

    print(f"\nreading {SRC.relative_to(ROOT)}")
    features = json.loads(SRC.read_text())["features"]
    codes = [f["properties"][CODE_FIELD] for f in features]
    by_name = resolve(features)

    topo = topology.build(features, CODE_FIELD)
    measured = topology.shared_boundaries(topo)
    shared = {pair: m for pair, m in measured.items() if m >= MIN_SHARED_M}
    # Slivers are not dropped: not being in `shared` makes point_touches pick
    # them up, which is the right classification for them.
    touches = topology.point_touches(topo, shared)
    print(f"  {len(features):,} zones, {len(topo.segments):,} distinct boundary segments")
    for key, value in topo.stats.items():
        print(f"    {key.replace('_', ' ')}: {value:,}")
    print(f"  {len(shared):,} pairs share a boundary; "
          f"{len(touches):,} meet only at a point "
          f"(of which {len(measured) - len(shared)} sub-{MIN_SHARED_M} m sliver(s))")

    edges = [
        {"a": codes[a], "b": codes[b], "kind": "boundary", "shared_m": round(metres, 1)}
        for (a, b), metres in sorted(shared.items())
    ]

    # crossings, verified against the geometry rather than trusted
    print(f"\n  {len(WATER_CROSSINGS)} declared water crossings")
    for name_a, name_b, via in WATER_CROSSINGS:
        for name in (name_a, name_b):
            if name not in by_name:
                raise SystemExit(
                    f"WATER_CROSSINGS: no zone named {name!r} in {SRC.name}"
                )
        a, b = by_name[name_a], by_name[name_b]
        if (min(a, b), max(a, b)) in shared:
            raise SystemExit(
                f"WATER_CROSSINGS: {name_a} and {name_b} already share a boundary -- "
                f"the entry is stale and would duplicate a real edge"
            )
        gap = topology.min_gap_m(features[a], features[b])
        edges.append({"a": codes[a], "b": codes[b], "kind": "crossing",
                      "shared_m": 0.0, "gap_m": round(gap, 1), "via": via})
        print(f"    {name_a} <-> {name_b}: {gap:,.0f} m  ({via})")

    zones = sorted(codes)
    neighbours: dict[str, set[str]] = {z: set() for z in zones}
    for edge in edges:
        neighbours[edge["a"]].add(edge["b"])
        neighbours[edge["b"]].add(edge["a"])
    comps = connected_components(zones, neighbours)
    degrees = sorted(len(n) for n in neighbours.values())

    doc = {
        "meta": {
            "source": str(SRC.relative_to(ROOT)),
            "definition": DEFINITION,
            "zones": len(zones),
            "edges": len(edges),
            "boundary_edges": len(shared),
            "crossings": len(WATER_CROSSINGS),
            "point_touches": len(touches),
            "min_shared_m": MIN_SHARED_M,
            "components": len(comps),
        },
        "zones": zones,
        "edges": sorted(edges, key=lambda e: (e["a"], e["b"])),
        "point_touches": [
            {"a": codes[a], "b": codes[b], "at": [round(at[0], 6), round(at[1], 6)]}
            for (a, b), at in sorted(touches.items())
        ],
    }
    dump(doc, OUT)

    mean = sum(degrees) / len(degrees)
    print(f"\n  {len(edges):,} edges, degree min {degrees[0]} / mean {mean:.2f} "
          f"/ max {degrees[-1]}")
    print(f"  {len(comps)} connected component(s): {[len(c) for c in comps]}")
    isolated = [z for z, n in neighbours.items() if not n]
    if isolated:
        print(f"  ISOLATED: {isolated}")
    print(f"\nwrote {OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
