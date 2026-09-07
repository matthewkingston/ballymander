#!/usr/bin/env python3
"""Flatten NISRA Census 2021 flexible-table JSON into a CSV for mapshaper's -join.

mapshaper cannot read NISRA's nested format, so this is the bridge between
data/*.json and the geometry build.

Adding another DZ-level dataset is a one-line entry in TABLES below.
"""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "build" / "dz_attributes.csv"

# --- registry -------------------------------------------------------------
# Each entry is one source file, in one of three shapes:
#
#   1-D table (zone -> number):        `column` names the single output column.
#   2-D table (zone x category):       `prefix` gives one column per category,
#                                      e.g. rel_catholic, rel_none.
#   2-D table collapsed to an index:   `weights` maps each category label to a
#                                      number, and the table becomes a single
#                                      population-weighted mean per zone. Two
#                                      columns come out: `column` for the index
#                                      and `column`_n for the table's own row
#                                      total, which is the correct denominator
#                                      to aggregate by later and is not quite
#                                      the same as `pop` (see the note below).
#
# To add a dataset: drop the JSON in data/ and add one line here.
RELIGION = "ni-census21-people-dz21+religion_belong_to_or_brought_up_in_dvo-f4902c4c.json"

TABLES: list[dict] = [
    {"column": "pop", "file": "ni-census21-people-dz21-96e78665.json"},
    # Protestant 0, Catholic 1, and the unaligned at 0.5 on the assumption that
    # in a two-way contest they split evenly. Changing these means a rebuild.
    {"column": "rel", "file": RELIGION, "weights": {
        "Catholic": 1.0,
        "Protestant and Other Christian (including Christian related)": 0.0,
        "Other religions": 0.5,
        "None": 0.5,
    }},
]

ZONE_DIM = "DZ21"  # dimension we key on


def slug(label: str) -> str:
    """'Protestant and Other Christian (including...)' -> 'protestant_and_other_christian'."""
    s = re.sub(r"\(.*?\)", " ", label).lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return re.sub(r"_+", "_", s)[:40]


def load_nisra_table(path: Path) -> tuple[list[str], dict[str, list]]:
    """Parse a NISRA flexible table.

    Returns (category_labels, {zone_code: [values...]}). For a 1-D table there is
    a single unnamed category; for 2-D the flat `values` array is row-major over
    (zone, category).
    """
    with path.open() as fh:
        table = json.load(fh)["table"]

    dims = table["dimensions"]
    if not dims or dims[0]["variable"]["name"] != ZONE_DIM:
        raise SystemExit(f"{path.name}: expected first dimension {ZONE_DIM}, "
                         f"got {dims[0]['variable']['name'] if dims else 'none'}")
    if len(dims) > 2:
        raise SystemExit(f"{path.name}: {len(dims)}-D tables are not supported yet")

    zones = [c["code"] for c in dims[0]["categories"]]
    cats = [c["label"] for c in dims[1]["categories"]] if len(dims) == 2 else [""]
    values = table["values"]

    expected = len(zones) * len(cats)
    if len(values) != expected:
        raise SystemExit(f"{path.name}: expected {expected} values, got {len(values)}")

    width = len(cats)
    rows = {code: values[i * width:(i + 1) * width] for i, code in enumerate(zones)}
    return cats, rows


def collapse(spec: dict, path: Path, cats: list[str],
             rows: dict[str, list]) -> tuple[list[str], dict[str, list]]:
    """Collapse a 2-D table to a weighted index per zone, plus its row total.

    The index is the population-weighted mean of the category weights, so for
    religion it runs 0 (all Protestant) to 1 (all Catholic). The row total comes
    out alongside because it is the right denominator to aggregate the index by
    later, and it is not quite `pop`: NISRA's disclosure control leaves the two
    differing in about a third of zones, by a handful of people each.

    Every category must carry a weight, in both directions -- a renamed, added
    or dropped category is a hard failure rather than a silently wrong index.
    """
    weights = spec["weights"]
    missing = [c for c in cats if c not in weights]
    if missing:
        raise SystemExit(f"{path.name}: no weight given for category {missing}")
    unused = [c for c in weights if c not in cats]
    if unused:
        raise SystemExit(f"{path.name}: weights given for absent categories {unused}")

    ws = [weights[c] for c in cats]
    name = spec["column"]
    out: dict[str, list] = {}
    for code, vals in rows.items():
        n = sum(vals)
        out[code] = [round(sum(v * w for v, w in zip(vals, ws)) / n, 6), n] if n \
            else ["", 0]
    return [name, f"{name}_n"], out


def main() -> int:
    columns: list[str] = []
    data: dict[str, dict[str, object]] = {}

    for spec in TABLES:
        path = DATA / spec["file"]
        if not path.exists():
            raise SystemExit(f"missing source file: {path}")

        cats, rows = load_nisra_table(path)
        total = sum(sum(v) for v in rows.values())   # before any collapsing

        if spec.get("weights"):
            names, rows = collapse(spec, path, cats, rows)
        elif len(cats) == 1 and cats[0] == "":
            names = [spec["column"]]
        else:
            prefix = spec.get("prefix") or spec.get("column")
            names = [f"{prefix}_{slug(c)}" for c in cats]

        columns.extend(names)
        for code, vals in rows.items():
            data.setdefault(code, {}).update(zip(names, vals))

        print(f"  {path.name}\n    -> {len(rows):,} zones x {len(names)} column(s) "
              f"{names}, total {total:,}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["code", *columns])
        for code in sorted(data):
            row = data[code]
            w.writerow([code, *(row.get(c, "") for c in columns)])

    print(f"\nwrote {OUT.relative_to(ROOT)}: {len(data):,} rows, "
          f"columns: code, {', '.join(columns)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
