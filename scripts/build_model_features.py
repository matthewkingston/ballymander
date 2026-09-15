#!/usr/bin/env python3
"""Build the demographic feature table the voting model's prior is fitted on.

One row per Data Zone, 24 features, every one a share of a census population:

  religion brought up in   up_catholic, up_protestant, up_none_other
                           (None and Other religions pooled)
  current religion         lapsed_catholic, lapsed_protestant
                           (brought-up share minus current share; can dip just
                           below zero where the two tables' disclosure noise
                           disagrees, left unclipped),
                           now_presbyterian, now_church_of_ireland, now_methodist,
                           now_remaining_other_christian
  SDZ religion detail      sdz_unspecified_protestant ("Protestant" and
                           "Protestant (Mixed)"), sdz_conservative_pool
                           (Reformed Presbyterian + Pentecostal),
                           sdz_free_presbyterian
  social grade             grade_AB, grade_C1, grade_C2, grade_DE
                           (shares of the graded population)
  national identity        all eight categories, id_*

The detailed religion table only exists at Super Data Zone level. Those groups
all sit inside the DZ table's "Other Christian", so each SDZ count is shared out
across its Data Zones in proportion to their Other Christian count, and
now_remaining_other_christian is what is left once they're taken out. That
reproduces every SDZ total exactly.

Groups that sum to one (upbringing, grade, identity) are all kept: the model is
symmetric with a ridge penalty, so there's no reference category to choose.
Age bands were tested and dropped (docs/voting-model.md).

Reads   data/ni-census21-people-dz21+religion_belong_to_or_brought_up_in_dvo-*.json
        data/ni-census21-people-dz21+religion_belong_to_dvo-*.json
        data/ni-census21-people-dz21+nat_id_basic-*.json
        data/ni-census21-people-dz21+social_grade-*.json
        data/ni-census21-people-sdz21+religion_belong_to_dvo_1000-*.json
Writes  data/model/dz21_features.csv
"""
from __future__ import annotations

import collections
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "model" / "dz21_features.csv"

UNSPECIFIED = ["Christian: Protestant", "Christian: Protestant (Mixed)"]
CONSERVATIVE_POOL = ["Christian: Reformed Presbyterian", "Christian: Pentecostal"]
FREE_PRESBYTERIAN = ["Christian: Free Presbyterian"]
OTHER_CHRISTIAN = "Other Christian (including Christian related)"


def one(pattern: str) -> Path:
    hits = sorted(DATA.glob(pattern))
    if len(hits) != 1:
        raise SystemExit(f"expected one file matching {pattern}, found {len(hits)}")
    return hits[0]


def table(pattern: str):
    """(zones [(code, label)], category labels, {code: counts})."""
    t = json.loads(one(pattern).read_text())["table"]
    zones = [(c["code"], c["label"]) for c in t["dimensions"][0]["categories"]]
    cats = [c["label"] for c in t["dimensions"][1]["categories"]]
    w = len(cats)
    return zones, cats, {z: t["values"][i * w:(i + 1) * w] for i, (z, _) in enumerate(zones)}


def sdz_of(dz_label: str) -> str:
    return re.sub(r"\d+$", "", dz_label)


def main() -> None:
    zones, up_cats, UP = table("ni-census21-people-dz21+religion_belong_to_or_brought_up_in_dvo-*.json")
    _, now_cats, NOW = table("ni-census21-people-dz21+religion_belong_to_dvo-*.json")
    _, id_cats, NID = table("ni-census21-people-dz21+nat_id_basic-*.json")
    _, grade_cats, GR = table("ni-census21-people-dz21+social_grade-*.json")
    sdz_zones, sdz_cats, SDZ = table("ni-census21-people-sdz21+religion_belong_to_dvo_1000-*.json")
    sdz = {label: SDZ[code] for code, label in sdz_zones}
    si = {c: i for i, c in enumerate(sdz_cats)}
    ui = {c: i for i, c in enumerate(up_cats)}
    bi = {c: i for i, c in enumerate(now_cats)}
    gi = {c: i for i, c in enumerate(grade_cats)}
    oth = bi[OTHER_CHRISTIAN]
    grades = [c for c in grade_cats if not c.startswith("No code")]
    assert len(grades) == 4, grades

    sdz_other = collections.Counter()
    for code, label in zones:
        sdz_other[sdz_of(label)] += NOW[code][oth]

    rows = []
    for code, label in zones:
        u, b, n, g = UP[code], NOW[code], NID[code], GR[code]
        tu, tb, tn = sum(u), sum(b), sum(n)
        graded = sum(g[gi[c]] for c in grades)
        s, pool = sdz[sdz_of(label)], sdz_other[sdz_of(label)]
        frac = b[oth] / pool if pool else 0.0

        def apportion(names):
            return sum(s[si[x]] for x in names) * frac

        unspec, cons, freep = apportion(UNSPECIFIED), apportion(CONSERVATIVE_POOL), apportion(FREE_PRESBYTERIAN)
        cath_up = u[ui["Catholic"]] / tu
        prot_up = u[ui["Protestant and Other Christian (including Christian related)"]] / tu
        prot_now = sum(b[bi[c]] for c in ["Presbyterian Church in Ireland", "Church of Ireland",
                                          "Methodist Church in Ireland", OTHER_CHRISTIAN]) / tb
        f = {
            "up_catholic": cath_up,
            "up_protestant": prot_up,
            "up_none_other": (u[ui["None"]] + u[ui["Other religions"]]) / tu,
            "lapsed_catholic": cath_up - b[bi["Catholic"]] / tb,
            "lapsed_protestant": prot_up - prot_now,
            "now_presbyterian": b[bi["Presbyterian Church in Ireland"]] / tb,
            "now_church_of_ireland": b[bi["Church of Ireland"]] / tb,
            "now_methodist": b[bi["Methodist Church in Ireland"]] / tb,
            "now_remaining_other_christian": (b[oth] - unspec - cons - freep) / tb,
            "sdz_unspecified_protestant": unspec / tb,
            "sdz_conservative_pool": cons / tb,
            "sdz_free_presbyterian": freep / tb,
        }
        for key, cat in zip(["AB", "C1", "C2", "DE"], grades):
            f["grade_" + key] = g[gi[cat]] / graded
        for i, cat in enumerate(id_cats):
            f["id_" + re.sub(r"[^a-z]+", "_", cat.lower().replace(" only", "")).strip("_")] = n[i] / tn
        rows.append((code, f))

    names = list(rows[0][1])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["code"] + names)
        for code, f in rows:
            w.writerow([code] + [f"{f[k]:.6f}" for k in names])
    negative = sum(1 for _, f in rows if f["now_remaining_other_christian"] < -1e-9)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} Data Zones x {len(names)} features"
          f" ({negative} with negative remaining Other Christian)")


if __name__ == "__main__":
    main()
