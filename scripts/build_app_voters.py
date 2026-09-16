#!/usr/bin/env python3
"""Flatten voters v0 into the small JSON the app's election mode loads.

Per Data Zone: its electorate and the nine parties' voter shares. Votes are
shares x electorate x turnout, with turnout flat (see docs/voting-model.md);
the app multiplies them out. Independents and micro-parties are transparent, so
every vote here belongs to one of the nine.

Also carries what the app's STV count needs: transfer matrix v0, and each
party's exhaustion rate -- the share of a transferring pile that had no further
preference among the parties left, measured from the same clean transfer events
the matrix was fitted on.

Also carries, per party, the two spread constants the region model needs to
scale its score term, measured the same way as the demographic ones:

  vSpread  rms of (zone share - its region's share) over zones, vote-weighted
  rSpread  spread of the regions' shares

Both are measured over the 18 real 2024 constituencies, which is the size of
region the app defaults to.

Reads   data/model/voters_v0_dz.csv, data/dz21_electorate.json,
        data/dz21_to_pc24.csv
Writes  web/data/dz_voters.json
"""
from __future__ import annotations

import csv
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARES = os.path.join(ROOT, "data", "model", "voters_v0_dz.csv")
TRANSFERS = os.path.join(ROOT, "data", "model", "transfer_matrix_v0.json")
EVENTS = os.path.join(ROOT, "data", "model", "transfer_events.json")
ELECTORATE = os.path.join(ROOT, "data", "dz21_electorate.json")
CONSTITUENCIES = os.path.join(ROOT, "data", "dz21_to_pc24.csv")
OUT = os.path.join(ROOT, "web", "data", "dz_voters.json")

# NI-wide valid-vote turnout at the 2024 Westminster election, the election the
# app's first-past-the-post mode simulates.
TURNOUT = 0.572


def exhaustion(parties):
    """Non-transferable share of what each party passed on, over the clean events."""
    with open(EVENTS) as fh:
        events = json.load(fh)["events"]
    nt = {p: 0.0 for p in parties}
    moved = {p: 0.0 for p in parties}
    for e in events:
        if (e["party"] in nt
                and not any(c["party"] == e["party"] for c in e["continuing"])
                and e["other_party_share"] <= 0.25):
            nt[e["party"]] += e["non_transferable"]
            moved[e["party"]] += e["votes_moved"]
    return {p: round(nt[p] / moved[p], 4) if moved[p] else 0.15 for p in parties}


def main() -> None:
    with open(SHARES) as fh:
        rows = list(csv.DictReader(fh))
    parties = [c for c in rows[0] if c != "code"]
    with open(ELECTORATE) as fh:
        table = json.load(fh)["table"]
    electorate = dict(zip([c["code"] for c in table["dimensions"][0]["categories"]],
                          table["values"]))
    with open(CONSTITUENCIES) as fh:
        region = {r["code"]: r["pc_name"] for r in csv.DictReader(fh)}

    zones = {}
    for r in rows:
        code = r["code"]
        zones[code] = {"e": int(round(electorate[code])),
                       "s": [round(float(r[p]), 5) for p in parties]}

    # Spread constants, measured over the real constituencies.
    totals = {}
    for code, z in zones.items():
        votes = z["e"] * TURNOUT
        t = totals.setdefault(region[code], {"votes": 0.0, "party": [0.0] * len(parties)})
        t["votes"] += votes
        for i, s in enumerate(z["s"]):
            t["party"][i] += votes * s
    region_share = {name: [p / t["votes"] for p in t["party"]] for name, t in totals.items()}
    national = [sum(t["party"][i] for t in totals.values())
                / sum(t["votes"] for t in totals.values()) for i in range(len(parties))]

    spread = []
    for i in range(len(parties)):
        num = den = 0.0
        for code, z in zones.items():
            votes = z["e"] * TURNOUT
            gap = z["s"][i] - region_share[region[code]][i]
            num += votes * gap * gap
            den += votes
        v = math.sqrt(num / den)
        mean = sum(region_share[n][i] for n in region_share) / len(region_share)
        r = math.sqrt(sum((region_share[n][i] - mean) ** 2 for n in region_share) / len(region_share))
        spread.append({"party": parties[i], "vSpread": round(v, 4), "rSpread": round(r, 4),
                       "national": round(national[i], 4)})

    with open(TRANSFERS) as fh:
        matrix = json.load(fh)["matrix"]
    leaks = exhaustion(parties)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump({"source": "data/model/voters_v0_dz.csv", "turnout": TURNOUT,
                   "parties": parties, "spread": spread,
                   # row-major, parties in the order above; a party's own column
                   # is zero, since a transfer to itself never leaves the party
                   "transfers": [[round(matrix[a].get(b, 0.0), 5) for b in parties]
                                 for a in parties],
                   "exhaustion": [leaks[p] for p in parties],
                   "zones": zones},
                  fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print(f"wrote {os.path.relpath(OUT, ROOT)}: {len(zones):,} zones x {len(parties)} parties, "
          f"turnout {TURNOUT:.1%}")
    for s in spread:
        print(f"  {s['party']:<10} national {100 * s['national']:>5.1f}%   "
              f"vSpread {s['vSpread']:.4f}   rSpread {s['rSpread']:.4f}   "
              f"exhaustion {100 * leaks[s['party']]:>4.1f}%")


if __name__ == "__main__":
    main()
