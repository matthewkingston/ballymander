#!/usr/bin/env python3
"""Parse the EONI 2022 NI Assembly result sheets into one JSON.

First preferences by party, by constituency (2008 parliamentary boundaries, the
ones the Assembly still uses). 18 workbooks, all one layout -- the filenames come
in two conventions but the sheets inside are identical, and the layout matches
the per-DEA council workbooks.

Party labels come from parse_council_2023 so that this, the 2023 council data and
pc24_results_2024.json all use one vocabulary and can be joined on `party`.

Every constituency is reconciled against the Total Valid Votes on its own sheet.
"""
from __future__ import annotations

import json
import glob
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_council_2023 import (            # noqa: E402  one shared vocabulary
    PARTY_CANON, PARTY_MAP, SKIP_ROW, norm_ws, norm_poll_pct,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "assembly_elections_22", "raw")
OUT = os.path.join(ROOT, "data", "assembly_elections_22", "assembly_2022.json")
BOUNDARIES = os.path.join(
    ROOT, "data",
    "osni_open_data_largescale_boundaries_parliamentary_constituencies_2008.geojson")

# Stood in 2022 but not in the 2023 council or 2024 Westminster data.
EXTRA_PARTIES = {
    "Resume NI": "Resume NI",
    "Heritage": "Heritage Party",
}
PARTIES = {**PARTY_CANON, **EXTRA_PARTIES}
EXTRA_MAP = {
    "resume ni": "Resume NI",
    "heritage party - pro-freedom. pro-family. pro-life.": "Heritage",
}

LABELS = [
    ("electorate",    r"eligible electorate"),
    ("votes_polled",  r"(total )?votes polled"),
    ("valid_votes",   r"(total )?valid votes"),
    ("invalid_votes", r"invalid votes"),
    ("seats",         r"number to be elected"),
    ("quota",         r"electoral quota( of)?"),
    ("poll_pct",      r"%\s*poll"),
]
FLOATS = {"poll_pct"}


def standardise(raw):
    """Map a sheet description to a party label, or None if unrecognised."""
    k = norm_ws(raw).lower().strip()
    for table in (PARTY_MAP, EXTRA_MAP):
        if k in table:
            return table[k]
        hit = table.get(k.rstrip("."), table.get(k + "."))
        if hit:
            return hit
    return None


def txt(v):
    return norm_ws("" if v is None else str(v))


def parse_workbook(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    grid = [list(r) for r in wb[wb.sheetnames[0]].iter_rows(values_only=True)]
    wb.close()

    name = None
    meta = {k: None for k, _ in LABELS}
    for row in grid:
        for j, v in enumerate(row):
            t = txt(v).lower().rstrip(": ")
            if not t:
                continue
            nxt = next((row[k] for k in range(j + 1, len(row)) if txt(row[k])), None)
            if name is None and re.fullmatch(r"constituency of", t):
                name = txt(nxt)
            for key, pat in LABELS:
                if meta[key] is None and re.fullmatch(pat, t):
                    try:
                        val = float(str(nxt).replace(",", "").rstrip("%"))
                        meta[key] = val if key in FLOATS else int(round(val))
                    except (TypeError, ValueError):
                        pass
    meta["poll_pct"] = norm_poll_pct(meta["poll_pct"])

    hdr = name_c = desc_c = fp_c = None
    for i, row in enumerate(grid):
        for j, v in enumerate(row):
            if txt(v).lower() == "candidate":
                hdr, name_c = i, j
                break
        if hdr is not None:
            break
    if hdr is None:
        raise ValueError("no candidate table header")
    for j, v in enumerate(grid[hdr]):
        t = txt(v).lower()
        if desc_c is None and t == "description":
            desc_c = j
        if fp_c is None and re.search(r"(1st|first) preference", t):
            fp_c = j
    if desc_c is None or fp_c is None:
        raise ValueError("no description / 1st preference column")

    # four workbooks print the whole candidate table twice in one sheet
    stop = len(grid)
    for i in range(hdr + 1, len(grid)):
        if name_c < len(grid[i]) and txt(grid[i][name_c]).lower() == "candidate":
            stop = i
            break

    cands = []
    for row in grid[hdr + 1:stop]:
        cand = txt(row[name_c]) if name_c < len(row) else ""
        party = txt(row[desc_c]) if desc_c < len(row) else ""
        if not cand or not party:
            continue
        if cand == "0" or (party == "0" and str(row[fp_c]) in ("0", "0.0", "None")):
            continue                      # template filler rows
        if SKIP_ROW.match(cand) or SKIP_ROW.match(party) or SKIP_ROW.match(cand + party):
            continue
        try:
            fp = int(round(float(str(row[fp_c]).replace(",", ""))))
        except (TypeError, ValueError, IndexError):
            continue
        cands.append({"candidate": cand, "party_raw": party, "first_pref": fp})
    return name, meta, cands


def boundary_names():
    with open(BOUNDARIES) as fh:
        g = json.load(fh)
    return {re.sub(r"[^a-z]", "", f["properties"]["PC_NAME"].lower()): f["properties"]["PC_NAME"]
            for f in g["features"]}


def build():
    canon = boundary_names()
    out, flags = {}, []
    for path in sorted(glob.glob(os.path.join(RAW, "*.xlsx"))):
        src = os.path.basename(path)
        try:
            name, meta, rows = parse_workbook(path)
        except Exception as exc:
            flags.append({"level": "error", "source": src,
                          "issue": "parse failed", "detail": str(exc)})
            continue
        key = re.sub(r"[^a-z]", "", (name or "").lower())
        if key not in canon:
            flags.append({"level": "error", "source": src, "constituency": name,
                          "issue": "name does not match a 2008 boundary"})

        cands = []
        for r in rows:
            party = standardise(r["party_raw"])
            if party is None:
                flags.append({"level": "error", "constituency": name, "source": src,
                              "issue": "unrecognised party description",
                              "detail": r["party_raw"], "candidate": r["candidate"],
                              "first_pref": r["first_pref"]})
            cands.append({"candidate": r["candidate"], "party": party,
                          "party_raw": r["party_raw"], "party_source": "source",
                          "first_pref": r["first_pref"]})
        total = sum(c["first_pref"] for c in cands)
        ok = meta["valid_votes"] is not None and total == meta["valid_votes"]
        if not ok:
            flags.append({"level": "error", "constituency": name, "source": src,
                          "issue": "first preferences do not sum to stated Total Valid Votes",
                          "detail": f"sum={total} stated={meta['valid_votes']}"})
        parties = defaultdict(int)
        for c in cands:
            parties[c["party"] or "UNKNOWN"] += c["first_pref"]
        out[name] = {
            "constituency": name, "source_file": src,
            "seats": meta["seats"], "electorate": meta["electorate"],
            "votes_polled": meta["votes_polled"], "valid_votes": meta["valid_votes"],
            "invalid_votes": meta["invalid_votes"], "quota": meta["quota"],
            "poll_pct": meta["poll_pct"],
            "reconciled_to_stated_total": ok, "first_prefs_total": total,
            "party_first_prefs": dict(sorted(parties.items(), key=lambda kv: -kv[1])),
            "candidates": sorted(cands, key=lambda c: -c["first_pref"]),
        }

    for missing in set(canon.values()) - {re.sub(r"\s+", " ", n).upper() for n in out}:
        if re.sub(r"[^a-z]", "", missing.lower()) not in {re.sub(r"[^a-z]", "", n.lower()) for n in out}:
            flags.append({"level": "error", "constituency": missing,
                          "issue": "constituency missing from output"})

    totals = defaultdict(int)
    for c in out.values():
        for p, v in c["party_first_prefs"].items():
            totals[p] += v
    doc = {
        "election": "Northern Ireland Assembly election, 5 May 2022",
        "poll_date": "2022-05-05",
        "source": "https://www.eoni.org.uk/results-data/ni-assembly-election-2022-results/",
        "measure": "first preference votes by party, by constituency",
        "keyed_by": "constituency name, as PC_NAME in the 2008 boundaries geojson",
        "notes": {
            "party": "Short label normalised from the sheet's own description, kept "
                     "verbatim in `party_raw`. Labels match council_elections_2023.json "
                     "and pc24_results_2024.json, so the three join on `party`. Resume NI "
                     "and Heritage stood only in 2022.",
            "party_source": "'source' throughout: no voting modelling assumption has been "
                            "applied to this dataset. See \"Voting modelling assumptions\" "
                            "in README.md for the ones applied elsewhere.",
            "verification": "Each constituency's first preferences are summed and compared "
                            "with the Total Valid Votes printed on the same sheet.",
        },
        "constituency_count": len(out),
        "candidate_count": sum(len(c["candidates"]) for c in out.values()),
        "reconciled_count": sum(1 for c in out.values() if c["reconciled_to_stated_total"]),
        "party_names": PARTIES,
        "ni_party_first_prefs": dict(sorted(totals.items(), key=lambda kv: -kv[1])),
        "flags": flags,
        "constituencies": [out[k] for k in sorted(out)],
    }
    with open(OUT, "w") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
    return doc


if __name__ == "__main__":
    d = build()
    print(f"constituencies: {d['constituency_count']}/18   candidates: {d['candidate_count']}")
    print(f"reconciled to stated Total Valid Votes: {d['reconciled_count']}/{d['constituency_count']}")
    print(f"flags: {len(d['flags'])}")
    for f in d["flags"]:
        print("  !", {k: v for k, v in f.items() if k != "level"})
    tot = sum(d["ni_party_first_prefs"].values())
    print("\nNI-wide first preferences:")
    for p, v in d["ni_party_first_prefs"].items():
        print(f"  {p:<16}{v:>8,}  {100*v/tot:5.2f}%   {PARTIES.get(p,'?')}")
    print(f"  {'TOTAL':<16}{tot:>8,}")
