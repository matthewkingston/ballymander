#!/usr/bin/env python3
"""Review tool: find zone pairs that are close but not adjacent, across water.

The DZ mosaic excludes water, so genuine connections across a river or a narrow
sound show up as gaps. build_adjacency.py bridges them from a hand-written list;
this script exists to check that list against the geometry rather than trust it.

A flagged row is a question, not a defect: geometry can show that water is narrow,
but only a person can say whether anything actually crosses it. That judgement is
the criterion -- see WATER_CROSSINGS.

    python3 scripts/audit_gaps.py

It prints a table and changes nothing. It is NOT wired into run.sh.

Scope, honestly: this searches to MAX_GAP_M only, so it can confirm a short
crossing was not missed but it can never prove the list complete -- it would not
have found the 6.3 km Rathlin ferry. The unconditional low-degree report at the
end is the backstop for anything beyond the radius.

Only *unshared* segments can bound a gap in the mosaic (a shared one has a Data
Zone on both sides), so the search is restricted to those, which is what keeps it
to seconds rather than minutes.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from math import hypot
from pathlib import Path

import dz_topology as topology
from build_adjacency import CODE_FIELD, MIN_SHARED_M, NAME_FIELD, SRC, WATER_CROSSINGS

ROOT = Path(__file__).resolve().parent.parent

MAX_GAP_M = 800.0   # also the grid cell size, so a 3x3 sweep cannot miss a pair
LOW_DEGREE = 1      # list zones at or below this, whatever the radius found

# Proximity alone is a bad signal: two zones on the same stretch of coast are
# often a few metres apart across a harbour mouth while being a short walk apart
# on land. What marks a crossing worth having is that the water is a real
# detour -- so candidates are ranked by how many hops apart they are in the
# land-only graph, and only the distant ones are worth a look.
SUSPICIOUS_HOPS = 6


def main() -> int:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC} -- the source boundaries are not in the repo")

    print(f"\nauditing {SRC.relative_to(ROOT)} for gaps under {MAX_GAP_M:,.0f} m\n")
    features = json.loads(SRC.read_text())["features"]
    names = [f["properties"][NAME_FIELD] for f in features]

    topo = topology.build(features, CODE_FIELD)
    shared = {p for p, m in topology.shared_boundaries(topo).items() if m >= MIN_SHARED_M}
    declared = {
        tuple(sorted((names.index(a), names.index(b)))) for a, b, _ in WATER_CROSSINGS
    }

    margin = topology.margin_points(topo)
    print(f"  {len(margin):,} vertices on the mosaic margin "
          f"(of {len(topo.vertices):,} total)")

    scale = topology.m_per_deg_lon(54.65)
    grid: dict[tuple[int, int], list[tuple[float, float, int]]] = defaultdict(list)
    for (lon, lat), zone in margin:
        x, y = lon * scale, lat * topology.M_PER_DEG_LAT
        grid[(int(x // MAX_GAP_M), int(y // MAX_GAP_M))].append((x, y, zone))

    closest: dict[tuple[int, int], tuple[float, tuple[float, float]]] = {}
    for cx, cy in list(grid):
        cell: dict[int, list[tuple[float, float]]] = defaultdict(list)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for x, y, zone in grid.get((cx + dx, cy + dy), ()):
                    cell[zone].append((x, y))
        zones = sorted(cell)
        if len(zones) < 2:
            continue
        for i, a in enumerate(zones):
            for b in zones[i + 1:]:
                # The overwhelming majority of neighbourhoods hold only zones that
                # already border each other; skipping those is what makes this cheap.
                if (a, b) in shared:
                    continue
                best = closest.get((a, b), (float("inf"), (0.0, 0.0)))
                for x1, y1 in cell[a]:
                    for x2, y2 in cell[b]:
                        d = hypot(x1 - x2, y1 - y2)
                        if d < best[0]:
                            best = (d, ((x1 + x2) / 2 / scale,
                                        (y1 + y2) / 2 / topology.M_PER_DEG_LAT))
                closest[(a, b)] = best

    near = sorted((d, mid, pair) for pair, (d, mid) in closest.items() if d <= MAX_GAP_M)
    print(f"  {len(near):,} non-adjacent pairs within range; classifying each gap\n")

    land_adj: dict[int, set[int]] = defaultdict(set)
    for a, b in shared:
        land_adj[a].add(b)
        land_adj[b].add(a)

    def hops(a: int, b: int, cap: int = 40) -> int | None:
        """Shortest path a -> b over shared boundaries only. None if unreachable."""
        frontier, seen = {a}, {a}
        for step in range(1, cap + 1):
            frontier = {n for f in frontier for n in land_adj[f] if n not in seen}
            if b in frontier:
                return step
            if not frontier:
                return None
            seen |= frontier
        return None

    water = []
    for gap, mid, pair in near:
        # A gap whose midpoint sits inside some other zone is separated by land,
        # not water -- two zones either side of a third. Only the rest matter.
        if any(topology.contains(mid, f) for f in features):
            continue
        water.append((hops(*pair), gap, mid, pair))
    water.sort(key=lambda r: (r[0] is not None, r[0], r[1]))

    print(f"  {len(water)} of them are separated by water rather than land\n")
    print(f"{'hops':>5} {'gap':>8}  {'zone A':<26} {'zone B':<26} {'midpoint':<20} declared")
    shown = 0
    for hop, gap, mid, (a, b) in water:
        if hop is not None and hop < SUSPICIOUS_HOPS and (a, b) not in declared:
            continue
        shown += 1
        flag = "yes" if (a, b) in declared else "NO  <-- review"
        print(f"{'--' if hop is None else hop:>5} {gap:7.0f}m  {names[a]:<26} "
              f"{names[b]:<26} {mid[0]:>9.4f},{mid[1]:<9.4f} {flag}")
    if not shown:
        print("  (none)")
    print(f"\n  {len(water) - shown} further water gaps are under {SUSPICIOUS_HOPS} "
          f"hops apart by land and so need no crossing")

    missing = declared - {pair for _, _, _, pair in water}
    for a, b in sorted(missing):
        print(f"{'':>5} {'':>8}  {names[a]:<26} {names[b]:<26} "
              f"{'':<20} declared, beyond {MAX_GAP_M:,.0f} m")

    # Backstop for anything the radius cannot reach.
    degree: dict[int, int] = defaultdict(int)
    for a, b in shared:
        degree[a] += 1
        degree[b] += 1
    for a, b in declared:
        degree[a] += 1
        degree[b] += 1
    low = sorted((degree[i], names[i]) for i in range(len(features))
                 if degree[i] <= LOW_DEGREE)
    print(f"\n  crossings included, {len(low)} zone(s) have only {LOW_DEGREE} "
          f"neighbour -- expect coastal and peninsular ones only:")
    for deg, name in low:
        print(f"    {deg}  {name}")
    print(f"  ({sum(1 for i in range(len(features)) if degree[i] == 2)} more have 2)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
