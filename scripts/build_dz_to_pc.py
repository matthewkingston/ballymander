#!/usr/bin/env python3
"""Map every 2021 Data Zone to one UK parliamentary constituency.

Handles both boundary vintages: the 2024 Westminster set (default) and the 2008
set the NI Assembly still uses. Pick with --vintage.

Standalone: nothing in the build pipeline calls this, and it writes only its own
two outputs. Run it again if either source boundary file is replaced.

    scripts/build_dz_to_pc.py [--data DIR] [--out DIR] [--keep-temp]

Method
------
Each DZ is assigned whole to the constituency covering the largest share of its
area. The two geographies come from different lineages -- constituencies were
redrawn in the 2023 review from ward-based building blocks, DZs were built for
the 2021 census -- so they do not nest: 127 of 3,780 DZs have less than 95% of
their area in a single constituency. Assigning those whole is a deliberate
choice (DZs stay indivisible), and it costs roughly 0.8% of the population
nationally; see `accuracy` in the JSON output for the per-constituency error.

Areas are measured on Irish Grid (EPSG:29903), not on lat/lon degrees.

Outputs
-------
data/dz21_to_pc24.csv    lookup, shaped for mapshaper:
                           -join data/dz21_to_pc24.csv keys=DZ2021_cd,code \
                                 field-types=code:str,pc_code:str
data/pc24_reference.json constituency metadata, the full DZ->PC map, the
                         accuracy report and the list of split DZs.
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DZ_GEO = "DZ2021.geojson"
DZ_CENSUS = "ni-census21-people-dz21-96e78665.json"        # optional, for validation

GRID = "EPSG:29903"          # Irish Grid; metres

# Tab names in the 2024 Electoral Office results workbook, by constituency code.
RESULTS_SHEET = {
    "N05000001": "BE",  "N05000002": "BN",  "N05000003": "BS",  "N05000004": "BW",
    "N05000005": "EA",  "N05000006": "EL",  "N05000007": "FST", "N05000008": "FY",
    "N05000009": "LV",  "N05000010": "MU",  "N05000011": "NYA", "N05000012": "NA",
    "N05000013": "ND",  "N05000014": "SA",  "N05000015": "SD",  "N05000016": "ST",
    "N05000017": "UB",  "N05000018": "WT",
}

# Two constituency vintages share this method. 2024 is the Westminster set from
# the 2023 review; 2008 is the older set, still used by the NI Assembly, whose
# OSNI file names its code field PC_ID rather than PC_Code.
VINTAGES = {
    "2024": {
        "pc_geo": "osni_open_data_largescale_boundaries_"
                  "parliamentary_constituencies_2023.geojson",
        "code_field": "PC_Code",
        "csv": "dz21_to_pc24.csv",
        "json": "pc24_reference.json",
        "target": "UK Parliamentary Constituency 2024 (PARLCON24 / OSNI 2023 review)",
        "census": "ni-census21-people-parlcon24-6af9c0bf.json",
        "results_sheet": RESULTS_SHEET,
    },
    "2008": {
        "pc_geo": "osni_open_data_largescale_boundaries_"
                  "parliamentary_constituencies_2008.geojson",
        "code_field": "PC_ID",
        "csv": "dz21_to_pc08.csv",
        "json": "pc08_reference.json",
        "target": "UK Parliamentary Constituency 2008 -- the boundaries the NI "
                  "Assembly still uses, and those of the 2022 Assembly election",
        "census": None,          # NISRA publishes no 2008-constituency census table
        "results_sheet": {},
    },
}

SPLIT_THRESHOLD = 0.95       # below this a DZ is flagged as genuinely split
SLIVER = 1e-6                # overlaps below this share of a DZ are digitising noise


def mapshaper(args: list[str]) -> None:
    exe = shutil.which("mapshaper-xl") or shutil.which("mapshaper")
    if not exe:
        sys.exit("mapshaper not on PATH -- try: export PATH=$PWD/.tools/bin:$PATH")
    cmd = [exe] + (["6gb"] if exe.endswith("mapshaper-xl") else []) + args
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def census_1d(path: Path) -> dict[str, tuple[str, int]]:
    """NISRA flexible-table JSON, one dimension -> {code: (label, count)}."""
    table = json.loads(path.read_text())["table"]
    cats = table["dimensions"][0]["categories"]
    return {c["code"]: (c["label"], v) for c, v in zip(cats, table["values"])}


def overlaps(data: Path, tmp: Path, pc_geo: str, code_field: str):
    """Intersect every DZ with every constituency.

    Returns ({dz: {pc_code: area_m2}}, {dz: dz_name}, [constituency properties]).
    """
    dz_proj, pc_proj = tmp / "dz.json", tmp / "pc.json"
    mapshaper([str(data / DZ_GEO), "-proj", GRID,
               "-filter-fields", "DZ2021_cd,DZ2021_nm", "-o", str(dz_proj)])
    mapshaper([str(data / pc_geo), "-proj", GRID,
               "-each", f"pc_nm=PC_NAME, pc_cd={code_field}",
               "-filter-fields", "pc_nm,pc_cd", "-o", str(pc_proj)])

    pc_features = json.loads(pc_proj.read_text())["features"]
    area: dict[str, dict[str, float]] = collections.defaultdict(dict)
    names: dict[str, str] = {}

    for i, feature in enumerate(pc_features):
        pc = feature["properties"]
        one = tmp / f"pc_{i:02d}.json"
        one.write_text(json.dumps({"type": "FeatureCollection", "features": [feature]}))
        out = tmp / f"ov_{i:02d}.csv"
        # -clip keeps one feature per DZ, so this.area sums its parts
        mapshaper([str(dz_proj), "-clip", str(one), "-filter", "this.area>0",
                   "-each", "ca=this.area",
                   "-filter-fields", "DZ2021_cd,DZ2021_nm,ca", "-o", str(out)])
        touched = 0
        for r in csv.DictReader(out.open()):
            dz = r["DZ2021_cd"]
            names[dz] = r["DZ2021_nm"]
            area[dz][pc["pc_cd"]] = area[dz].get(pc["pc_cd"], 0.0) + float(r["ca"])
            touched += 1
        print(f"  clipped {pc['pc_nm']:<30} {touched:5d} DZs touched")

    return area, names, [f["properties"] for f in pc_features]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "data",
                    help="directory holding the source boundary files (default: data/)")
    ap.add_argument("--out", type=Path, default=ROOT / "data",
                    help="directory to write the lookup and reference into")
    ap.add_argument("--vintage", choices=sorted(VINTAGES), default="2024",
                    help="constituency boundary set to map onto (default: 2024)")
    ap.add_argument("--keep-temp", action="store_true")
    args = ap.parse_args()
    cfg = VINTAGES[args.vintage]
    pc_census = cfg["census"]

    for f in (DZ_GEO, cfg["pc_geo"]):
        if not (args.data / f).exists():
            sys.exit(f"missing {args.data / f}")

    tmp = Path(tempfile.mkdtemp(prefix="dz2pc-"))
    try:
        print(f"==> intersecting DZs with constituencies on {GRID}")
        area, dz_names, pcs = overlaps(args.data, tmp, cfg["pc_geo"], cfg["code_field"])
    finally:
        if args.keep_temp:
            print(f"    temp kept at {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    pc_name = {p["pc_cd"]: p["pc_nm"] for p in pcs}
    # OSNI names are uppercase; prefer NISRA's proper-case labels for display.
    census = (census_1d(args.data / pc_census)
              if pc_census and (args.data / pc_census).exists() else {})
    display = {c: census.get(c, (n.title(), None))[0].strip() for c, n in pc_name.items()}

    # --- assign ----------------------------------------------------------
    # Whole DZ to the constituency with the largest overlap; ties break on code
    # so the output is stable across runs.
    rows, split = [], []
    for dz in sorted(area):
        full = sum(area[dz].values())
        m = {k: v for k, v in area[dz].items() if v / full > SLIVER}
        total = sum(m.values())
        winner = sorted(m, key=lambda k: (-m[k], k))[0]
        share = m[winner] / total
        rows.append({
            "code": dz,
            "pc_code": winner,
            "pc_name": display[winner],
            "share": round(share, 6),
            "split": int(share < SPLIT_THRESHOLD),
        })
        if share < SPLIT_THRESHOLD:
            split.append({
                "code": dz,
                "name": dz_names[dz],
                "assigned": winner,
                "share": round(share, 4),
                "others": [{"pc_code": k, "share": round(v / total, 4)}
                           for k, v in sorted(m.items(), key=lambda x: -x[1])[1:]],
            })

    # --- validate against NISRA's own constituency counts -----------------
    accuracy = {"note": f"{pc_census or 'no constituency census table'} not available; "
                        "assignment not validated against published populations"}
    per_pc_pop: dict[str, int] = {}
    if pc_census and (args.data / pc_census).exists() and (args.data / DZ_CENSUS).exists():
        dz_pop = {k: v[1] for k, v in census_1d(args.data / DZ_CENSUS).items()}
        pc_pop = census_1d(args.data / pc_census)
        assigned = collections.Counter()
        for r in rows:
            assigned[r["pc_code"]] += dz_pop.get(r["code"], 0)
        per_pc_pop = dict(assigned)
        errs = [(c, assigned[c] - v) for c, (_, v) in pc_pop.items()]
        total_pop = sum(v for _, v in pc_pop.values())
        accuracy = {
            "validated_against": pc_census,
            "sum_abs_error_people": sum(abs(d) for _, d in errs),
            "sum_abs_error_pct": round(100 * sum(abs(d) for _, d in errs) / total_pop, 4),
            "worst": sorted(
                ({"pc_code": c, "diff": d, "pct": round(100 * d / pc_pop[c][1], 3)}
                 for c, d in errs),
                key=lambda x: -abs(x["diff"]))[:5],
        }

    dz_counts = collections.Counter(r["pc_code"] for r in rows)

    reference = {
        "generated": dt.date.today().isoformat(),
        "unit": "Census 2021 Data Zone (DZ2021)",
        "target": cfg["target"],
        "method": (
            "Each DZ assigned whole to the constituency holding the largest share of "
            f"its area, measured on {GRID}. The two geographies do not nest; DZs with "
            f"less than {SPLIT_THRESHOLD:.0%} of their area in the assigned constituency "
            "are listed under split_dzs."
        ),
        "sources": {"data_zones": DZ_GEO, "constituencies": cfg["pc_geo"],
                    "validation": pc_census},
        "counts": {"data_zones": len(rows), "constituencies": len(pcs),
                   "split_data_zones": len(split)},
        "accuracy": accuracy,
        "constituencies": [
            {
                "code": c,
                "name": display[c],
                "osni_name": pc_name[c],
                "results_sheet": cfg["results_sheet"].get(c),
                "dz_count": dz_counts[c],
                "census_population": census.get(c, (None, None))[1],
                "assigned_population": per_pc_pop.get(c),
            }
            for c in sorted(pc_name)
        ],
        "dz_to_pc": {r["code"]: r["pc_code"] for r in rows},
        "split_dzs": sorted(split, key=lambda s: s["share"]),
    }

    args.out.mkdir(parents=True, exist_ok=True)
    csv_path, json_path = args.out / cfg["csv"], args.out / cfg["json"]
    with csv_path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["code", "pc_code", "pc_name", "share", "split"])
        w.writeheader()
        w.writerows(rows)
    json_path.write_text(json.dumps(reference, indent=1) + "\n")

    print(f"\n==> {csv_path}: {len(rows)} data zones, {len(split)} split")
    if "sum_abs_error_people" in accuracy:
        print(f"==> population error vs NISRA: {accuracy['sum_abs_error_people']} people "
              f"({accuracy['sum_abs_error_pct']}%)")
    print(f"==> {json_path}")


if __name__ == "__main__":
    main()
