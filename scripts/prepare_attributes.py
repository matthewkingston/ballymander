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
# Each entry is one source file. For a 1-D table (zone -> number) `column` names
# the output column. For a 2-D table (zone x category -> number) `prefix` is used
# to build one column per category, e.g. rel_catholic, rel_none.
#
# To add a dataset: drop the JSON in data/ and add one line here.
TABLES: list[dict] = [
    {"column": "pop", "file": "ni-census21-people-dz21-96e78665.json"},
    # {"prefix": "rel",
    #  "file": "ni-census21-people-dz21+religion_belong_to_or_brought_up_in_dvo-f4902c4c.json"},
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


def main() -> int:
    columns: list[str] = []
    data: dict[str, dict[str, object]] = {}

    for spec in TABLES:
        path = DATA / spec["file"]
        if not path.exists():
            raise SystemExit(f"missing source file: {path}")

        cats, rows = load_nisra_table(path)

        if len(cats) == 1 and cats[0] == "":
            names = [spec["column"]]
        else:
            prefix = spec.get("prefix") or spec.get("column")
            names = [f"{prefix}_{slug(c)}" for c in cats]

        columns.extend(names)
        for code, vals in rows.items():
            data.setdefault(code, {}).update(zip(names, vals))

        total = sum(sum(v) for v in rows.values())
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
