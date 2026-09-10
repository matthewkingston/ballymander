#!/usr/bin/env python3
"""Estimate the electorate of each Data Zone, as a NISRA-shaped table.

There is no published electorate below DEA level, so this apportions each DEA's
actual registered electorate across its Data Zones in proportion to their adult
(18+) census population:

    dz_electorate = dz_18plus * (dea_register / dea_18plus)

That is deliberately a calibration, not a model. Registration completeness
varies a lot between DEAs -- 0.53 in Botanic, where residents are students or
not franchise-eligible, against 1.05 in Ballyarnett -- so a single NI-wide
factor would be badly wrong in exactly the places that matter. Anchoring on each
DEA's own figure puts every outlier in the right ballpark, and by construction
the Data Zones of a DEA sum to that DEA's published register.

What it does not fix is variation *within* a DEA: every Data Zone in Botanic
inherits the same 0.53, though halls of residence and ordinary streets plainly
differ. Nothing published below DEA level can settle that.

The census is March 2021 and the register May 2023, so the 18+ base is two years
stale; 16-17 year olds at the census are eligible by polling day. That is
absorbed into the ratio rather than modelled.

Reads   data/ni-census21-people-dz21+age_syoa-*.json         (adults per DZ)
        data/council_elections_23/council_elections_2023.json (register per DEA)
Writes  data/dz21_electorate.json
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
AGE = DATA / "ni-census21-people-dz21+age_syoa-6e5d3e2d.json"
COUNCIL = DATA / "council_elections_23" / "council_elections_2023.json"
OUT = DATA / "dz21_electorate.json"

VOTING_AGE = 18


def dea_key(name: str) -> str:
    """Match DEA names across sources ('Holywood & Clandeboye' == '... and ...')."""
    return re.sub(r"[^a-z]", "", name.lower().replace("&", " and "))


def dea_of(dz_label: str) -> str:
    """Data Zone labels carry their DEA: 'Ards_Peninsula_N5' -> 'Ards Peninsula'."""
    return re.sub(r"_[A-Z]+\d+$", "", dz_label).replace("_", " ")


def adults_per_dz():
    """(code, label) per Data Zone, and its 18+ population."""
    table = json.loads(AGE.read_text())["table"]
    zones = [(c["code"], c["label"]) for c in table["dimensions"][0]["categories"]]
    ages = [c["code"] for c in table["dimensions"][1]["categories"]]
    keep = [i for i, code in enumerate(ages)
            if int(re.match(r"\d+", code).group()) >= VOTING_AGE]
    width, values = len(ages), table["values"]
    if len(values) != len(zones) * width:
        sys.exit(f"{AGE.name}: expected {len(zones) * width} values, got {len(values)}")
    adults = {}
    for i, (code, _) in enumerate(zones):
        row = values[i * width:(i + 1) * width]
        adults[code] = sum(row[j] for j in keep)
    return zones, adults


def apportion(register: int, weights: dict) -> dict:
    """Split `register` across zones in proportion to `weights`, as integers.

    Largest remainder, so the parts sum to exactly `register` rather than to
    whatever rounding happens to leave behind.
    """
    total = sum(weights.values())
    if total == 0:
        return {z: 0 for z in weights}
    exact = {z: register * w / total for z, w in weights.items()}
    out = {z: int(v) for z, v in exact.items()}
    short = register - sum(out.values())
    for z in sorted(exact, key=lambda z: (-(exact[z] - out[z]), z))[:short]:
        out[z] += 1
    return out


def main() -> int:
    zones, adults = adults_per_dz()
    council = json.loads(COUNCIL.read_text())
    register = {dea_key(d["dea"]): d["electorate"] for d in council["deas"]}
    if any(v is None for v in register.values()):
        sys.exit("some DEAs have no electorate; run parse_council_2023.py first")

    by_dea = {}
    for code, label in zones:
        by_dea.setdefault(dea_key(dea_of(label)), {})[code] = adults[code]

    unknown = sorted(set(by_dea) - set(register))
    if unknown:
        sys.exit(f"Data Zones in DEAs with no register figure: {unknown}")

    electorate = {}
    ratios = []
    for dea, weights in by_dea.items():
        electorate.update(apportion(register[dea], weights))
        ratios.append((register[dea] / sum(weights.values()), dea))

    for dea, weights in by_dea.items():
        got = sum(electorate[z] for z in weights)
        if got != register[dea]:
            sys.exit(f"{dea}: apportioned {got} but register is {register[dea]}")

    OUT.write_text(json.dumps({
        "name": "ELECTORATE",
        "label": "Estimated electorate",
        "table": {
            "dimensions": [{
                "count": len(zones),
                "variable": {"name": "DZ21", "label": "Census 2021 Data Zone"},
                "categories": [{"code": c, "label": l} for c, l in zones],
            }],
            "values": [electorate[c] for c, _ in zones],
        },
    }, indent=1) + "\n", encoding="utf-8")

    ratios.sort()
    total = sum(electorate.values())
    print(f"==> {OUT.relative_to(ROOT)}")
    print(f"    {len(zones):,} Data Zones in {len(by_dea)} DEAs, "
          f"electorate {total:,} (= sum of DEA registers)")
    print(f"    adults 18+ {sum(adults.values()):,}, "
          f"NI ratio {total / sum(adults.values()):.3f}")
    print(f"    DEA ratio: min {ratios[0][0]:.3f} ({ratios[0][1]}), "
          f"max {ratios[-1][0]:.3f} ({ratios[-1][1]})")
    vals = sorted(electorate.values())
    print(f"    per-DZ electorate: min {vals[0]}, "
          f"median {vals[len(vals) // 2]}, max {vals[-1]}")
    print("    every DEA sums exactly to its published register")
    return 0


if __name__ == "__main__":
    sys.exit(main())
