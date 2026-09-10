#!/usr/bin/env python3
"""Flatten the 2024 UK general election declarations into one JSON file.

Standalone: nothing in the build pipeline calls this, and it writes only its own
output. Run it again if the workbook is replaced.

    scripts/build_pc24_results.py [--data DIR] [--out DIR]

The source is the Electoral Office for Northern Ireland's declaration workbook,
one sheet per constituency, tab names BE..WT. Sheets are read by row label
rather than by cell position, so a re-issued workbook with rows moved still
parses. Constituencies are keyed by the same N05000001-18 codes as
data/pc24_reference.json, not by name.

Two quirks of the source, both preserved rather than papered over:

  * `votes_polled` is the figure at the end of the verification stage, as the
    footnote on every sheet says. In 8 of 18 constituencies it does not equal
    valid + rejected -- Foyle by 97 ballots, the rest by 5 or fewer. The
    per-constituency `reconciliation` field records the difference. Candidate
    votes always sum exactly to `valid_votes`, which is what matters here.
  * The workbook's "Elected" column holds uncached IF() formulas, so it is
    empty in the file. The winner is taken as the top-polling candidate, and
    checked against the sheet's own "Candidate Elected" line.

Party descriptions come off the sheets in 17 spellings for 12 parties -- wrapped
cells leave embedded newlines, and Alliance appears as both "Alliance Party" and
"Alliance". PARTIES below maps every one to a short label; an unrecognised
description is a hard error rather than a silent passthrough.

Output
------
data/pc24_results_2024.json  per-constituency results with normalised party
                             labels, plus an NI-wide party summary.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

XLSX = "uk-parliamentary-election-2024-results-website-4.xlsx"
REFERENCE = "pc24_reference.json"     # supplies the N05000001-18 codes

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

# raw sheet description (whitespace collapsed) -> (short label, full name)
PARTIES = {
    "Sinn Féin": ("Sinn Féin", "Sinn Féin"),
    "Democratic Unionist Party - D.U.P.": ("DUP", "Democratic Unionist Party"),
    "Alliance Party": ("Alliance", "Alliance Party of Northern Ireland"),
    "Alliance": ("Alliance", "Alliance Party of Northern Ireland"),
    "Ulster Unionist Party": ("UUP", "Ulster Unionist Party"),
    "SDLP (Social Democratic & Labour Party)": ("SDLP", "Social Democratic and Labour Party"),
    "TUV - No Sea Border": ("TUV", "Traditional Unionist Voice"),
    "Green Party Northern Ireland": ("Green", "Green Party Northern Ireland"),
    "Aontú for Life, Unity, Economic Justice": ("Aontú", "Aontú"),
    "People Before Profit": ("PBP", "People Before Profit"),
    "Conservative and Unionist Party": ("Conservative", "Conservative and Unionist Party"),
    "Cross-Community Labour Alternative": ("CCLA", "Cross-Community Labour Alternative"),
    "Independent": ("Independent", "Independent"),
}


# --- voting modelling assumptions ------------------------------------------
# Candidates counted as a party other than the one on the ballot paper, so that
# party totals reflect functional alignment rather than the declared label.
# Each entry is a deliberate modelling choice, not a data correction: the
# sheet's own wording is always preserved in the candidate's `description`, and
# the candidate is marked party_source="assumed". See "Voting modelling
# assumptions" in README.md for the reasoning behind each one.
ALIGNED = {
    # Stood as an Independent, but North Down is the only constituency where
    # neither the DUP nor the TUV put up a candidate; he took 48.3% as the
    # de facto unionist standard-bearer. Counted as DUP.
    ("North Down", "EASTON, ALEX"): ("DUP", "Democratic Unionist Party"),
}


# --- minimal xlsx reader (no third-party deps available) -------------------

def _col_row(ref: str) -> tuple[int, int]:
    m = re.match(r"([A-Z]+)(\d+)", ref)
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1, int(m.group(2)) - 1


class Workbook:
    """Just enough of the OOXML format to read cell values and sheet names."""

    def __init__(self, path: Path):
        self.z = zipfile.ZipFile(path)
        self.shared = []
        if "xl/sharedStrings.xml" in self.z.namelist():
            root = ET.fromstring(self.z.read("xl/sharedStrings.xml"))
            # a shared string can be split into several runs; join them
            self.shared = ["".join(t.text or "" for t in si.iter(NS + "t")) for si in root]
        wb = ET.fromstring(self.z.read("xl/workbook.xml"))
        rels = ET.fromstring(self.z.read("xl/_rels/workbook.xml.rels"))
        target = {r.get("Id"): r.get("Target") for r in rels}
        self.sheets = []
        for sh in wb.find(NS + "sheets"):
            part = target[sh.get(RNS + "id")].lstrip("/")
            self.sheets.append((sh.get("name"), part if part.startswith("xl/") else "xl/" + part))

    def grid(self, part: str) -> list[list]:
        root = ET.fromstring(self.z.read(part))
        cells: dict[tuple[int, int], object] = {}
        maxr = maxc = -1
        for c in root.iter(NS + "c"):
            ref = c.get("r")
            if not ref:
                continue
            ci, ri = _col_row(ref)
            t = c.get("t", "n")
            v = c.find(NS + "v")
            if t == "inlineStr":
                node = c.find(NS + "is")
                val = "".join(x.text or "" for x in node.iter(NS + "t")) if node is not None else None
            elif v is None or v.text is None:
                val = None                      # includes formulas with no cached result
            elif t == "s":
                val = self.shared[int(v.text)]
            elif t in ("str", "e"):
                val = v.text
            else:
                val = float(v.text)
                if val == int(val):
                    val = int(val)
            if val is None or val == "":
                continue
            cells[(ri, ci)] = val
            maxr, maxc = max(maxr, ri), max(maxc, ci)
        return [[cells.get((r, c)) for c in range(maxc + 1)] for r in range(maxr + 1)]


# --- sheet parsing ---------------------------------------------------------

def first(row: list):
    return next((v for v in row if v is not None), None)


def labelled(rows: list[list], label: str):
    """Value in the first cell after the cell whose text starts with `label`."""
    for row in rows:
        v = first(row)
        if isinstance(v, str) and v.strip().lower().startswith(label.lower()):
            rest = [x for x in row if x is not None][1:]
            return rest[0] if rest else None
    return None


def normalise_party(desc: str) -> tuple[str, str]:
    key = re.sub(r"\s+", " ", desc).strip()
    if key not in PARTIES:
        sys.exit(f"unrecognised party description {key!r} -- add it to PARTIES")
    return PARTIES[key]


def parse_sheet(rows: list[list]) -> dict:
    header = next((i for i, r in enumerate(rows)
                   if any(isinstance(v, str) and v.strip() == "Description" for v in r)), None)
    if header is None:
        sys.exit("no candidate table header found")

    candidates = []
    for row in rows[header + 1:]:
        name = first(row)
        if not isinstance(name, str) or name.strip().startswith("*"):
            break                               # blank row or the footnote
        nums = [v for v in row if isinstance(v, (int, float))]
        desc = next((v for v in row[1:] if isinstance(v, str)), None)
        if not nums or desc is None:
            break
        short, full = normalise_party(desc)
        candidates.append({
            "name": name.strip(),               # as printed: "SURNAME, Forename"
            "party": short,
            "party_name": full,
            "party_source": "source",
            "description": re.sub(r"\s+", " ", desc).strip(),
            "votes": int(nums[-1]),
        })
    candidates.sort(key=lambda c: -c["votes"])

    constituency = str(labelled(rows, "Constituency")).strip()
    for c in candidates:
        aligned = ALIGNED.get((constituency, c["name"]))
        if aligned:
            c["party_as_declared"] = c["party"]
            c["party"], c["party_name"] = aligned
            c["party_source"] = "assumed"

    valid = labelled(rows, "Valid votes")
    for c in candidates:
        c["share"] = round(c["votes"] / valid, 5) if valid else None
    return {
        "name": constituency,
        "elected": str(labelled(rows, "Candidate Elected")).strip(),
        "electorate": labelled(rows, "Eligible electorate"),
        "votes_polled": labelled(rows, "Votes polled"),
        "valid_votes": valid,
        "rejected_votes": labelled(rows, "Rejected votes"),
        "turnout": labelled(rows, "% turnout"),
        "candidates": candidates,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "data")
    ap.add_argument("--out", type=Path, default=ROOT / "data")
    args = ap.parse_args()

    for f in (XLSX, REFERENCE):
        if not (args.data / f).exists():
            sys.exit(f"missing {args.data / f}")

    ref = json.loads((args.data / REFERENCE).read_text())
    code_of = {c["results_sheet"]: c["code"] for c in ref["constituencies"]}
    name_of = {c["code"]: c["name"] for c in ref["constituencies"]}

    wb = Workbook(args.data / XLSX)
    constituencies, warnings = [], []

    for tab, part in wb.sheets:
        if tab not in code_of:
            sys.exit(f"sheet {tab!r} is not in {REFERENCE}")
        code = code_of[tab]
        s = parse_sheet(wb.grid(part))

        if s["name"].lower() != name_of[code].lower():
            warnings.append(f"{tab}: sheet says {s['name']!r}, reference says {name_of[code]!r}")
        total = sum(c["votes"] for c in s["candidates"])
        if total != s["valid_votes"]:
            warnings.append(f"{tab}: candidate votes {total} != valid votes {s['valid_votes']}")
        if abs(s["votes_polled"] / s["electorate"] - s["turnout"]) > 5e-6:
            warnings.append(f"{tab}: turnout does not match polled/electorate")
        winner = s["candidates"][0]
        if s["candidates"][1]["votes"] == winner["votes"]:
            warnings.append(f"{tab}: tie for first place")
        if s["elected"].split()[-1].upper() not in winner["name"].upper():
            warnings.append(f"{tab}: top candidate {winner['name']!r} is not {s['elected']!r}")

        for c in s["candidates"]:
            c["elected"] = c is winner
        constituencies.append({
            "code": code,
            "name": name_of[code],
            "results_sheet": tab,
            "elected": {"name": s["elected"], "party": winner["party"]},
            "electorate": s["electorate"],
            "votes_polled": s["votes_polled"],
            "valid_votes": s["valid_votes"],
            "rejected_votes": s["rejected_votes"],
            "turnout": round(s["turnout"], 5),
            # source quirk: votes_polled is a verification-stage count
            "reconciliation": s["votes_polled"] - (s["valid_votes"] + s["rejected_votes"]),
            "majority": winner["votes"] - s["candidates"][1]["votes"],
            "candidates": s["candidates"],
        })

    constituencies.sort(key=lambda c: c["code"])

    votes, stood, seats, names = collections.Counter(), collections.Counter(), collections.Counter(), {}
    for c in constituencies:
        for cand in c["candidates"]:
            votes[cand["party"]] += cand["votes"]
            stood[cand["party"]] += 1
            names[cand["party"]] = cand["party_name"]
        seats[c["elected"]["party"]] += 1
    ni_valid = sum(c["valid_votes"] for c in constituencies)

    out = {
        "generated": dt.date.today().isoformat(),
        "election": "UK parliamentary general election, 4 July 2024",
        "source": XLSX,
        "keyed_by": "PARLCON24 constituency code, as in " + REFERENCE,
        "notes": {
            "votes_polled": (
                "Total votes polled at the end of the verification stage, per the "
                "footnote on every sheet. In 8 of 18 constituencies this differs from "
                "valid + rejected; see the per-constituency `reconciliation` field. "
                "Candidate votes sum exactly to valid_votes in all 18."
            ),
            "candidate_names": "As printed on the declaration: 'SURNAME, Forename'.",
            "party": (
                "Short label normalised from the sheet's own description, which is kept "
                "verbatim (whitespace collapsed) in each candidate's `description`."
            ),
            "party_source": (
                "'source' where the party is the one on the ballot paper. 'assumed' "
                "where a voting modelling assumption counts the candidate as a "
                "different party; the declared label is then kept in "
                "`party_as_declared` and the sheet wording in `description`. See "
                "\"Voting modelling assumptions\" in README.md."
            ),
            "share": "Candidate votes as a fraction of valid_votes in that constituency.",
        },
        "totals": {
            "electorate": sum(c["electorate"] for c in constituencies),
            "votes_polled": sum(c["votes_polled"] for c in constituencies),
            "valid_votes": ni_valid,
            "rejected_votes": sum(c["rejected_votes"] for c in constituencies),
            "candidates": sum(len(c["candidates"]) for c in constituencies),
            "turnout": round(sum(c["votes_polled"] for c in constituencies)
                             / sum(c["electorate"] for c in constituencies), 5),
        },
        "parties": [
            {"party": p, "party_name": names[p], "votes": v,
             "share": round(v / ni_valid, 5), "candidates": stood[p], "seats": seats[p]}
            for p, v in votes.most_common()
        ],
        "constituencies": constituencies,
    }

    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / "pc24_results_2024.json"
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"==> {path}")
    print(f"    {len(constituencies)} constituencies, {out['totals']['candidates']} candidates, "
          f"{len(out['parties'])} parties, turnout {100 * out['totals']['turnout']:.2f}%")
    for p in out["parties"]:
        print("    %-13s %8d %6.2f%%  %2d stood  %2d seats"
              % (p["party"], p["votes"], 100 * p["share"], p["candidates"], p["seats"]))
    if warnings:
        print("\n!! %d warning(s):" % len(warnings))
        for w in warnings:
            print("   " + w)
    else:
        print("    all internal checks passed")


if __name__ == "__main__":
    main()
