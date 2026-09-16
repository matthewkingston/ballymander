#!/usr/bin/env python3
"""Real-life boundaries for the app: which region each Data Zone belongs to.

Three sets, so the map can be loaded with boundaries that actually exist rather
than drawn ones:

  westminster  the 18 constituencies used in 2024
  assembly     the 18 constituencies of 2008, which the Assembly still uses
  council      the 80 District Electoral Areas, taken from each Data Zone's own
               name (Airport_A1 -> Airport), the same convention the rest of the
               pipeline uses

Stored as a region list plus one index per zone, which is a good deal smaller
than repeating names 3,780 times.

Reads   data/dz21_to_pc24.csv, data/dz21_to_pc08.csv, web/data/dz.geojson
Writes  web/data/dz_regions.json
"""
from __future__ import annotations

import csv
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOJSON = os.path.join(ROOT, "web", "data", "dz.geojson")
OUT = os.path.join(ROOT, "web", "data", "dz_regions.json")


def indexed(codes, region_of):
    """[region names], [one index per code] -- both in the codes' own order."""
    names = []
    seen = {}
    index = []
    for code in codes:
        name = region_of[code]
        if name not in seen:
            seen[name] = len(names)
            names.append(name)
        index.append(seen[name])
    return {"regions": names, "index": index}


def main() -> None:
    with open(GEOJSON) as fh:
        features = json.load(fh)["features"]
    codes = [f["properties"]["code"] for f in features]
    dz_name = {f["properties"]["code"]: f["properties"]["name"] for f in features}

    def from_csv(name):
        with open(os.path.join(ROOT, "data", name)) as fh:
            return {r["code"]: r["pc_name"] for r in csv.DictReader(fh)}

    sets = {
        "westminster": indexed(codes, from_csv("dz21_to_pc24.csv")),
        "assembly": indexed(codes, from_csv("dz21_to_pc08.csv")),
        "council": indexed(codes, {c: re.sub(r"_[A-Z]+\d+$", "", n).replace("_", " ")
                                   for c, n in dz_name.items()}),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump({"codes": codes, "sets": sets}, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print(f"wrote {os.path.relpath(OUT, ROOT)}: {len(codes):,} zones")
    for key, s in sets.items():
        print(f"  {key:<12}{len(s['regions']):>4} regions")


if __name__ == "__main__":
    main()
