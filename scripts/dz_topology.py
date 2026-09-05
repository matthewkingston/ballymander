"""Exact topology primitives for the Data Zone boundary mosaic.

Shared vertices in DZ2021.geojson are float-identical -- 60.4% of undirected
boundary segments are claimed by two zones -- so adjacency is an *exact*
computation: hash every segment and see who uses it. No tolerance, no snapping,
no spatial index. That is what makes it cheap and reproducible.

Used by build_adjacency.py (from the full-resolution source) and by
verify_adjacency.py (from the simplified build output, to prove simplification
preserved shared borders).
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Iterable, Iterator, NamedTuple

# Equirectangular metres. Across NI (54.0-55.3 N) the error is well under 1%,
# far tighter than anything we use lengths for (weighting, sliver detection).
M_PER_DEG_LAT = 111_320.0

Point = tuple[float, float]
Segment = tuple[Point, Point]


class Topology(NamedTuple):
    """One pass over the geometry, indexed two ways."""

    codes: list[str]                      # zone index -> zone code
    segments: dict[Segment, set[int]]     # undirected segment -> zone indices
    vertices: dict[Point, set[int]]       # vertex -> zone indices
    stats: dict[str, int]                 # anomalies worth reporting, not hiding


def m_per_deg_lon(lat: float) -> float:
    return M_PER_DEG_LAT * math.cos(math.radians(lat))


def segment_m(seg: Segment) -> float:
    (x1, y1), (x2, y2) = seg
    lat = (y1 + y2) / 2
    return math.hypot((x2 - x1) * m_per_deg_lon(lat), (y2 - y1) * M_PER_DEG_LAT)


def rings(feature: dict) -> Iterator[list]:
    """Every ring of a feature -- exterior and interior, across every part.

    Interior rings count: a zone that encloses another shares that border with it.
    """
    g = feature.get("geometry")
    if g is None:
        return
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    for poly in polys:
        for ring in poly:
            yield ring


def build(features: Iterable[dict], code_field: str) -> Topology:
    """Index every boundary segment and vertex by the zones that use it.

    Zone indices rather than code strings keep the two dicts (~1.1M entries each
    for the full-resolution source) to a size worth holding in memory.
    """
    codes: list[str] = []
    segments: dict[Segment, set[int]] = defaultdict(set)
    vertices: dict[Point, set[int]] = defaultdict(set)
    unclosed = degenerate = 0

    for i, feat in enumerate(features):
        codes.append(feat["properties"][code_field])
        for ring in rings(feat):
            pts = [(c[0], c[1]) for c in ring]
            if pts[0] != pts[-1]:  # close it rather than lose a segment, but say so
                pts.append(pts[0])
                unclosed += 1
            prev = pts[0]
            vertices[prev].add(i)
            for cur in pts[1:]:
                if cur == prev:  # zero-length segment is not a border
                    degenerate += 1
                else:
                    segments[(prev, cur) if prev < cur else (cur, prev)].add(i)
                    vertices[cur].add(i)
                prev = cur

    stats = {
        "unclosed_rings": unclosed,
        "degenerate_segments": degenerate,
        # >2 zones on one segment means the source polygons overlap there.
        "segments_over_2_zones": sum(1 for z in segments.values() if len(z) > 2),
    }
    return Topology(codes, dict(segments), dict(vertices), stats)


def shared_boundaries(topo: Topology) -> dict[tuple[int, int], float]:
    """Zone pairs sharing at least one segment -> total shared length in metres."""
    pairs: dict[tuple[int, int], float] = defaultdict(float)
    for seg, zones in topo.segments.items():
        if len(zones) < 2:
            continue
        length = segment_m(seg)
        zs = sorted(zones)
        for a in range(len(zs)):
            for b in range(a + 1, len(zs)):
                pairs[(zs[a], zs[b])] += length
    return dict(pairs)


def point_touches(
    topo: Topology, shared: dict[tuple[int, int], float]
) -> dict[tuple[int, int], Point]:
    """Pairs meeting at a single point but sharing no segment, and where.

    The two diagonal zones where four zones meet at a crossroads. Deliberately
    not adjacency -- a contiguous region cannot pass through a dimensionless
    point -- but recorded, with the meeting point, so the exclusion is visible
    in the data and can be plotted.
    """
    touching: dict[tuple[int, int], Point] = {}
    for point, zones in topo.vertices.items():
        if len(zones) < 2:
            continue
        zs = sorted(zones)
        for a in range(len(zs)):
            for b in range(a + 1, len(zs)):
                pair = (zs[a], zs[b])
                if pair not in shared:
                    touching.setdefault(pair, point)
    return touching


def margin_points(topo: Topology) -> list[tuple[Point, int]]:
    """Vertices on the outer margin of the mosaic, with the zone that owns them.

    A segment used by only one zone borders something that is not a Data Zone:
    the coast, a lough shore, or the international border. Only these vertices
    can bound a gap in the mosaic, so restricting the water-gap audit to them
    cuts it from 1.76M points to a few hundred thousand.
    """
    seen: set[tuple[Point, int]] = set()
    for seg, zones in topo.segments.items():
        if len(zones) != 1:
            continue
        zone = next(iter(zones))
        seen.add((seg[0], zone))
        seen.add((seg[1], zone))
    return sorted(seen)


def contains(point: Point, feature: dict) -> bool:
    """Point-in-polygon (ray casting) against every part of a feature, holes honoured."""
    x, y = point
    g = feature.get("geometry")
    if g is None:
        return False
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    for poly in polys:
        inside_part = True
        for i, ring in enumerate(poly):
            crossings = False
            for j in range(len(ring) - 1):
                x1, y1 = ring[j][0], ring[j][1]
                x2, y2 = ring[j + 1][0], ring[j + 1][1]
                if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                    crossings = not crossings
            if i == 0:
                if not crossings:
                    inside_part = False
                    break
            elif crossings:  # in a hole
                inside_part = False
                break
        if inside_part:
            return True
    return False


def min_gap_m(feat_a: dict, feat_b: dict) -> float:
    """Shortest distance between two features' boundary vertices, in metres.

    Brute force over vertex pairs. Only ever called for the handful of declared
    water crossings, where recording the real gap beats hard-coding a number.
    """
    pa = [(c[0], c[1]) for ring in rings(feat_a) for c in ring]
    pb = [(c[0], c[1]) for ring in rings(feat_b) for c in ring]
    scale = m_per_deg_lon(sum(y for _, y in pa + pb) / len(pa + pb))
    proj_b = [(x * scale, y * M_PER_DEG_LAT) for x, y in pb]
    best, closest = float("inf"), (pa[0], pb[0])
    for point in pa:
        px, py = point[0] * scale, point[1] * M_PER_DEG_LAT
        for j, (qx, qy) in enumerate(proj_b):
            d = (px - qx) ** 2 + (py - qy) ** 2
            if d < best:
                best, closest = d, (point, pb[j])
    return segment_m(closest)  # re-measure the winning pair at its own latitude
