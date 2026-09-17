#!/usr/bin/env python3
"""Fit standing v0: when does a party bother to put up a candidate?

Every party in the app stands in every region, which no party does in life.
Parties skip regions for two different reasons, and the two elections separate
them cleanly:

  under STV     it is a capacity question -- can you find a candidate, and is
                there a branch to run them. A council DEA and an Assembly
                constituency differ about four and a half fold in size, and a
                threshold on the *number* of a party's voters fits both with
                one number where a threshold on share does not (TUV 84% against
                77%, Green 86% / 76%, PBP 86% / 81%, Aontu 86% / 83%). That is
                also why the Assembly looks like "everyone always stands": a
                constituency is simply big enough that the small parties clear
                the same bar they miss in half the DEAs.

  under FPTP    it is a viability question -- the big parties skip seats they
                cannot win, which is why their thresholds here are the highest
                of all. Every Westminster seat is much the same size, so this
                one is fitted on share.

Three Westminster absences are stand-asides rather than judgements of strength:
the DUP in Fermanagh and South Tyrone, the UUP in Belfast North, and Sinn Fein
in Belfast South and Mid Down, each leaving a clear run to a neighbour. A pact
is a deal, not a rule about support, so they are dropped from the fit -- with
them in, the DUP and UUP get fitted thresholds of 9% and 7% on the strength of
one seat apiece. Pacts are their own feature, on the deferred list.

Thresholds maximise classification accuracy over the observed regions, on
candidate values midway between neighbouring observations; where several tie,
the median of the tied set is taken.

Circularity, worth remembering when reading the accuracies: the shares come
from voters v1, which was itself fitted with who-stood-where applied. This is
a description of the pattern, not an out-of-sample test of it.

Reads   data/model/voters_v1_dz.csv, data/model/turnout_v0.json,
        data/model/turnout_v0_dz.csv, data/dz21_electorate.json,
        data/dz21_to_pc08.csv, data/dz21_to_pc24.csv,
        data/council_elections_23/council_elections_2023.json,
        data/assembly_elections_22/assembly_2022.json,
        data/pc24_results_2024.json
Writes  data/model/standing_v0.json
"""
from __future__ import annotations

import collections
import csv
import json
import re

import numpy as np

from prior_model import DATA, MODEL, PARTIES, ROOT, Data

# Thresholds are in votes, so they must be in the same votes the app counts:
# electorate x the election's own level x the zone's turnout index (turnout v0,
# scripts/fit_turnout.py). Shares are weighted the same way -- by the votes a
# zone casts, not by the electors living in it.
TURNOUT = json.loads((MODEL / "turnout_v0.json").read_text())["levels"]

# Absences that were pacts: (election, party, region).
PACTS = [
    ("westminster", "DUP", "Fermanagh and South Tyrone"),
    ("westminster", "UUP", "Belfast North"),
    ("westminster", "Sinn Féin", "Belfast South and Mid Down"),
]


def key(s: str) -> str:
    return re.sub(r"[^a-z]", "", str(s).lower().replace("&", "and"))


def regions_of(d: Data, lookup: str) -> tuple[np.ndarray, dict[str, str]]:
    """Each DZ's region under one boundary set, and the display names."""
    with (DATA / lookup).open() as fh:
        rows = list(csv.DictReader(fh))
    name = {r["code"]: r["pc_name"] for r in rows}
    return (np.array([key(name[c]) for c in d.codes]),
            {key(r["pc_name"]): r["pc_name"] for r in rows})


def observations(d: Data, shares: np.ndarray, electorate: np.ndarray, index: np.ndarray):
    """(election, party, region, share, votes, stood) over all three elections."""
    council = json.loads((DATA / "council_elections_23" / "council_elections_2023.json").read_text())
    assembly = json.loads((DATA / "assembly_elections_22" / "assembly_2022.json").read_text())
    westminster = json.loads((DATA / "pc24_results_2024.json").read_text())

    wm = {}
    for c in westminster["constituencies"]:
        votes = collections.Counter()
        for cand in c["candidates"]:
            votes[cand["party"]] += cand["votes"]
        wm[key(c["name"])] = votes

    asm_regions, asm_names = regions_of(d, "dz21_to_pc08.csv")
    wm_regions, wm_names = regions_of(d, "dz21_to_pc24.csv")
    dea_regions = np.array([key(d.dea_names[i]) for i in d.dea_of_dz])
    dea_names = {key(n): n for n in d.dea_names}

    sets = [
        ("council", dea_regions, dea_names,
         {key(u["dea"]): u["party_first_prefs"] for u in council["deas"]}),
        ("assembly", asm_regions, asm_names,
         {key(c["constituency"]): c["party_first_prefs"] for c in assembly["constituencies"]}),
        ("westminster", wm_regions, wm_names, wm),
    ]

    out = []
    for election, regions, names, results in sets:
        for rkey, first_prefs in results.items():
            idx = np.where(regions == rkey)[0]
            if not len(idx):
                continue
            weight = electorate[idx] * index[idx]          # votes, not electors
            share = (weight[:, None] * shares[idx]).sum(0) / weight.sum()
            votes = share * weight.sum() * TURNOUT[election]
            for k, party in enumerate(PARTIES):
                out.append((election, party, names[rkey], share[k], votes[k],
                            first_prefs.get(party, 0) > 0))
    return out


def threshold(xs: np.ndarray, stood: np.ndarray) -> tuple[float, float]:
    """The cut maximising accuracy, and that accuracy. Zero means "always"."""
    if stood.all():
        return 0.0, 1.0
    order = np.unique(xs)
    mids = np.concatenate([[0.0], (order[:-1] + order[1:]) / 2, [order[-1] * 1.5]])
    acc = np.array([((xs >= t) == stood).mean() for t in mids])
    best = acc.max()
    return float(np.median(mids[acc == best])), float(best)


def main() -> None:
    d = Data()
    with (MODEL / "voters_v1_dz.csv").open() as fh:
        shares = np.array([[float(r[p]) for p in PARTIES] for r in csv.DictReader(fh)])
    table = json.loads((DATA / "dz21_electorate.json").read_text())["table"]
    by_code = dict(zip([c["code"] for c in table["dimensions"][0]["categories"]], table["values"]))
    electorate = np.array([by_code[c] for c in d.codes], float)

    with (MODEL / "turnout_v0_dz.csv").open() as fh:
        by_zone = {r["code"]: float(r["index"]) for r in csv.DictReader(fh)}
    index = np.array([by_zone[c] for c in d.codes])

    rows = observations(d, shares, electorate, index)
    pacts = {(e, p, key(r)) for e, p, r in PACTS}
    kept = [o for o in rows if (o[0], o[1], key(o[2])) not in pacts]

    out = {
        "version": "standing v0",
        "parties": PARTIES,
        "turnout_levels": TURNOUT,
        "stv": {"unit": "votes", "fitted_on": "2023 council DEAs and 2022 Assembly constituencies",
                "thresholds": {}, "accuracy": {}},
        "fptp": {"unit": "share", "fitted_on": "2024 Westminster constituencies",
                 "thresholds": {}, "accuracy": {}},
        "pacts_excluded": [{"election": e, "party": p, "region": r} for e, p, r in PACTS],
        "note": "an entity formed by merging parties takes their mean threshold, "
                "weighted by each one's NI-wide votes",
    }
    print(f"{'party':<12}{'STV (voters)':>22}{'FPTP (share)':>22}")
    for party in PARTIES:
        stv = [o for o in kept if o[0] in ("council", "assembly") and o[1] == party]
        fptp = [o for o in kept if o[0] == "westminster" and o[1] == party]
        t_stv, a_stv = threshold(np.array([o[4] for o in stv]),
                                 np.array([o[5] for o in stv]))
        t_fptp, a_fptp = threshold(np.array([o[3] for o in fptp]),
                                   np.array([o[5] for o in fptp]))
        out["stv"]["thresholds"][party] = round(t_stv)
        out["stv"]["accuracy"][party] = round(a_stv, 3)
        out["fptp"]["thresholds"][party] = round(t_fptp, 4)
        out["fptp"]["accuracy"][party] = round(a_fptp, 3)
        stv_txt = "always" if t_stv <= 0 else f"{t_stv:,.0f}"
        fptp_txt = "always" if t_fptp <= 0 else f"{100 * t_fptp:.1f}%"
        print(f"{party:<12}{stv_txt:>14} {100 * a_stv:>6.0f}%{fptp_txt:>15} {100 * a_fptp:>6.0f}%")

    path = MODEL / "standing_v0.json"
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    n_stv = len({(o[0], o[2]) for o in kept if o[0] != "westminster"})
    print(f"\n{n_stv} STV regions, 18 Westminster seats, {len(PACTS)} pact absences excluded")
    print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
