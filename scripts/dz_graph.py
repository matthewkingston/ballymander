"""Read the Data Zone adjacency graph.

Reads only web/data/dz_adjacency.json -- never the 75 MB source -- so importing
this is cheap and has no side effects. Build the artifact with
scripts/build_adjacency.py.

    import sys; sys.path.insert(0, "scripts")   # when importing from the repo root
    from dz_graph import load

    g = load()
    g.neighbours("N20001651")                    # ['N20001659']  (Rathlin -> the ferry)
    g.are_neighbours("N20003391", "N20003778")   # True           (Strangford Narrows)

Two zones are neighbours when they share a length of boundary, or when they are
one of the declared water crossings. Zones that meet at a single point are not
neighbours -- see point_touches().
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Iterator, Mapping

ROOT = Path(__file__).resolve().parent.parent
ARTIFACT = ROOT / "web" / "data" / "dz_adjacency.json"


def connected_components(
    nodes: Iterable[str], neighbours: Mapping[str, Iterable[str]]
) -> list[list[str]]:
    """Components of an undirected graph, largest first; isolated nodes included."""
    seen: set[str] = set()
    comps: list[list[str]] = []
    for start in nodes:
        if start in seen:
            continue
        seen.add(start)
        stack, comp = [start], []
        while stack:
            node = stack.pop()
            comp.append(node)
            for other in neighbours.get(node, ()):
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        comps.append(sorted(comp))
    comps.sort(key=len, reverse=True)
    return comps


class Adjacency:
    """Who borders whom."""

    def __init__(self, doc: dict) -> None:
        self.meta: dict = doc["meta"]
        self.zones: list[str] = list(doc["zones"])
        self._adj: dict[str, set[str]] = {z: set() for z in self.zones}
        self._edges: dict[tuple[str, str], dict] = {}
        for edge in doc["edges"]:
            a, b = edge["a"], edge["b"]
            self._adj[a].add(b)
            self._adj[b].add(a)
            self._edges[_key(a, b)] = edge
        self._touches: dict[str, set[str]] = defaultdict(set)
        for touch in doc.get("point_touches", ()):
            self._touches[touch["a"]].add(touch["b"])
            self._touches[touch["b"]].add(touch["a"])

    def _known(self, code: str) -> str:
        if code not in self._adj:
            raise KeyError(f"unknown zone code {code!r}")
        return code

    def neighbours(self, code: str) -> list[str]:
        """Codes sharing a boundary with `code`, plus any declared crossing."""
        return sorted(self._adj[self._known(code)])

    def are_neighbours(self, a: str, b: str) -> bool:
        return b in self._adj[self._known(a)]

    def degree(self, code: str) -> int:
        return len(self._adj[self._known(code)])

    def edge(self, a: str, b: str) -> dict | None:
        """The full edge record, or None if the two are not neighbours."""
        return self._edges.get(_key(self._known(a), self._known(b)))

    def shared_m(self, a: str, b: str) -> float | None:
        """Metres of shared boundary; 0.0 across a crossing, None if not neighbours."""
        edge = self.edge(a, b)
        return None if edge is None else edge["shared_m"]

    def edges(self, kind: str | None = None) -> Iterator[dict]:
        for edge in self._edges.values():
            if kind is None or edge["kind"] == kind:
                yield edge

    def point_touches(self, code: str) -> list[str]:
        """Zones meeting `code` at a single point only. Deliberately not neighbours."""
        return sorted(self._touches[self._known(code)])

    def components(self) -> list[list[str]]:
        return connected_components(self.zones, self._adj)


def _key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def load(path: Path = ARTIFACT) -> Adjacency:
    if not path.exists():
        raise SystemExit(f"missing {path} -- run scripts/build_adjacency.py")
    return Adjacency(json.loads(path.read_text()))
