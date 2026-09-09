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
#                                      number, or to None to drop it from both
#                                      the numerator and the denominator -- or
#                                      `weight_from: "code"` where the codes are
#                                      already the values, as for single year of
#                                      age -- and the table becomes a
#                                      population-weighted mean. Two columns
#                                      come out: `column` for the index and
#                                      `column`_n for the table's own row total,
#                                      which is the correct denominator to
#                                      aggregate by later and is not quite the
#                                      same as `pop` (see the note below).
#
# To add a dataset: drop the JSON in data/ and add one line here.
RELIGION = "ni-census21-people-dz21+religion_belong_to_or_brought_up_in_dvo-f4902c4c.json"
AGE = "ni-census21-people-dz21+age_syoa-6e5d3e2d.json"
ORIENT = "ni-census21-people-dz21+sexual_orientation_dvo_agg4-4310722c.json"
GRADE = "ni-census21-people-dz21+social_grade-52ba72e2.json"

TABLES: list[dict] = [
    {"column": "pop", "file": "ni-census21-people-dz21-96e78665.json"},
    # Protestant 0, Catholic 1, and the unaligned at 0.5 on the assumption that
    # in a two-way contest they split evenly. Changing these means a rebuild.
    # Single year of age, codes "0".."100" with 100+ folded onto 100.
    {"column": "age", "file": AGE, "weight_from": "code"},
    {"column": "rel", "file": RELIGION, "weights": {
        "Catholic": 1.0,
        "Protestant and Other Christian (including Christian related)": 0.0,
        "Other religions": 0.5,
        "None": 0.5,
    }},
    # Straight 0, everything else 1. Non-answers are dropped from the
    # denominator rather than counted as straight, so the index is a share of
    # those who actually answered -- 73.3% of the population, since the question
    # was not put to under-16s.
    {"column": "orient", "file": ORIENT, "weights": {
        "Straight or heterosexual": 0.0,
        "Gay, lesbian, bisexual, other sexual orientation": 1.0,
        "Prefer not to say/Not stated": None,
        "No code required": None,
    }},
    # The four grades evenly spaced over 0..1, AB highest.
    {"column": "grade", "file": GRADE, "weights": {
        "AB: Higher and intermediate managerial, administrative and professional "
        "occupations": 1.0,
        "C1: Supervisory, clerical, and junior managerial, administrative and "
        "professional occupations": 2 / 3,
        "C2: Skilled manual occupations": 1 / 3,
        "Semi-skilled and unskilled manual occupations; unemployed and lowest "
        "grade occupations": 0.0,
        "No code required": None,
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

    Returns (category_labels, category_codes, {zone_code: [values...]}). For a
    1-D table there is a single unnamed category; for 2-D the flat `values` array
    is row-major over (zone, category).
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
    cells = dims[1]["categories"] if len(dims) == 2 else [{"code": "", "label": ""}]
    cats = [c["label"] for c in cells]
    codes = [c["code"] for c in cells]
    values = table["values"]

    expected = len(zones) * len(cats)
    if len(values) != expected:
        raise SystemExit(f"{path.name}: expected {expected} values, got {len(values)}")

    width = len(cats)
    rows = {code: values[i * width:(i + 1) * width] for i, code in enumerate(zones)}
    return cats, codes, rows


def collapse(spec: dict, path: Path, cats: list[str], codes: list[str],
             rows: dict[str, list]) -> tuple[list[str], dict[str, list]]:
    """Collapse a 2-D table to a weighted index per zone, plus its row total.

    The index is the population-weighted mean of the category weights, so for
    religion it runs 0 (all Protestant) to 1 (all Catholic). The row total comes
    out alongside because it is the right denominator to aggregate the index by
    later, and it is not quite `pop`: NISRA's disclosure control leaves the two
    differing in about a third of zones, by a handful of people each.

    Every category must carry a weight, in both directions -- a renamed, added
    or dropped category is a hard failure rather than a silently wrong index. A
    weight of None excludes that category from the numerator *and* the
    denominator, which is how "prefer not to say" is kept from being counted as
    an answer; it still has to be named, so the guarantee holds.
    """
    if spec.get("weight_from") == "code":
        # The variable is ordinal and its codes are its values -- single year of
        # age is coded "0".."100". Avoids a 101-entry literal that a reworded
        # label would silently break.
        try:
            ws = [float(c) for c in codes]
        except ValueError:
            raise SystemExit(f"{path.name}: weight_from=code needs numeric "
                             f"category codes, got {codes[:3]}") from None
    else:
        weights = spec["weights"]
        missing = [c for c in cats if c not in weights]
        if missing:
            raise SystemExit(f"{path.name}: no weight given for category {missing}")
        unused = [c for c in weights if c not in cats]
        if unused:
            raise SystemExit(f"{path.name}: weights given for absent categories {unused}")
        ws = [weights[c] for c in cats]
    name = spec["column"]
    kept = [(i, w) for i, w in enumerate(ws) if w is not None]
    if not kept:
        raise SystemExit(f"{path.name}: every category is excluded")
    out: dict[str, list] = {}
    for code, vals in rows.items():
        n = sum(vals[i] for i, _ in kept)
        out[code] = [round(sum(vals[i] * w for i, w in kept) / n, 6), n] if n \
            else ["", 0]
    return [name, f"{name}_n"], out


def main() -> int:
    columns: list[str] = []
    data: dict[str, dict[str, object]] = {}

    for spec in TABLES:
        path = DATA / spec["file"]
        if not path.exists():
            raise SystemExit(f"missing source file: {path}")

        cats, codes, rows = load_nisra_table(path)
        total = sum(sum(v) for v in rows.values())   # before any collapsing

        kept = None
        if spec.get("weights") or spec.get("weight_from"):
            names, rows = collapse(spec, path, cats, codes, rows)
            # The denominator after exclusions, which is what `<column>_n` holds
            # and what the index is a share of -- not the table's own total.
            kept = sum(v[1] for v in rows.values())
        elif len(cats) == 1 and cats[0] == "":
            names = [spec["column"]]
        else:
            prefix = spec.get("prefix") or spec.get("column")
            names = [f"{prefix}_{slug(c)}" for c in cats]

        columns.extend(names)
        for code, vals in rows.items():
            data.setdefault(code, {}).update(zip(names, vals))

        counted = "" if kept is None or kept == total else f", counted {kept:,}"
        print(f"  {path.name}\n    -> {len(rows):,} zones x {len(names)} column(s) "
              f"{names}, total {total:,}{counted}")

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
