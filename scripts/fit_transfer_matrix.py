#!/usr/bin/env python3
"""Fit transfer matrix v0: where a party's voters go when it isn't on the ballot.

Built from the STV transfer events of parse_transfers.py. Choices (reasons in
docs/voting-model.md):

  clean events  no running mate still in the count -- same-party transfers would
                swamp the cross-party signal -- and at most 25% of what's passed on
                came from other parties' voters.
  non-transferable
                renormalised away: turnout is assumed flat, so a voter with no
                further preference is not modelled as abstaining.
  availability  each source party has one weight w per destination party; in any
                event a destination's share is w_B / sum of w over the parties
                still in the count. Fitted by the standard minorise-maximise update
                for choices from varying sets. This is also how the matrix is
                applied: renormalise a row over the parties standing.
  weighting     every event counts once, whatever its size.
  shrinkage     each row is pulled towards its bloc's expectation by adding K
                pseudo-events in which all eight destinations are available,
                split by the target shares. Targets are the same fit pooled over
                every source party in the bloc (the party itself left out and the
                rest renormalised), except within "other", where Alliance and Green
                have no bloc-mates to pool: those two cells are hand-set.

Reads   data/model/transfer_events.json
Writes  data/model/transfer_matrix_v0.json
"""
from __future__ import annotations

import collections
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTS = os.path.join(ROOT, "data", "model", "transfer_events.json")
OUT = os.path.join(ROOT, "data", "model", "transfer_matrix_v0.json")

PARTIES = ["Sinn Féin", "DUP", "Alliance", "UUP", "SDLP", "TUV", "Green", "PBP", "Aontú"]
BLOCS = {
    "nationalist": ["Sinn Féin", "SDLP", "PBP", "Aontú"],
    "unionist": ["DUP", "UUP", "TUV"],
    "other": ["Alliance", "Green"],
}
BLOC_OF = {p: b for b, ps in BLOCS.items() for p in ps}
MAX_OTHER_PARTY_SHARE = 0.25
K = 5.0
HAND_SET_TARGETS = {("Alliance", "Green"): 0.35, ("Green", "Alliance"): 0.35}   # placeholder


def is_clean(e) -> bool:
    return (e["party"] in PARTIES
            and not any(c["party"] == e["party"] for c in e["continuing"])
            and e["other_party_share"] <= MAX_OTHER_PARTY_SHARE)


def observations(events):
    """(shares received by the nine, parties available) per event; each event sums to one."""
    obs = []
    for e in events:
        got = collections.defaultdict(float)
        for c in e["continuing"]:
            if c["party"] in PARTIES:
                got[c["party"]] += c["votes"]
        tot = sum(got.values())
        if tot > 0:
            obs.append(({p: v / tot for p, v in got.items()},
                        {c["party"] for c in e["continuing"] if c["party"] in PARTIES}))
    return obs


def fit_weights(obs, destinations, tol=1e-12, max_iter=20000):
    """Weights (summing to one) maximising sum over events of received x log(w / sum w available)."""
    w = {p: 1.0 / len(destinations) for p in destinations}
    for _ in range(max_iter):
        new = {}
        for p in destinations:
            received = sum(o.get(p, 0.0) for o, _ in obs)
            exposure = sum(sum(o.values()) / sum(w[c] for c in avail if c in w)
                           for o, avail in obs if p in avail)
            new[p] = max(received, 1e-12) / exposure if exposure > 0 else w[p]
        s = sum(new.values())
        new = {p: v / s for p, v in new.items()}
        if max(abs(new[p] - w[p]) for p in w) < tol:
            return new
        w = new
    return w


def main() -> None:
    events = [e for e in json.load(open(EVENTS))["events"] if is_clean(e)]
    pooled = {b: fit_weights(observations([e for e in events if BLOC_OF[e["party"]] == b]), PARTIES)
              for b in BLOCS}
    matrix, unshrunk, targets, n_events, n_available = {}, {}, {}, {}, {}
    for a in PARTIES:
        dests = [p for p in PARTIES if p != a]
        fixed = {q: s for (x, q), s in HAND_SET_TARGETS.items() if x == a}
        rest = sum(pooled[BLOC_OF[a]][p] for p in dests if p not in fixed)
        target = {p: fixed.get(p, pooled[BLOC_OF[a]][p] / rest * (1 - sum(fixed.values())))
                  for p in dests}
        obs = observations([e for e in events if e["party"] == a])
        seen = [p for p in dests if any(p in avail for _, avail in obs)]
        matrix[a] = fit_weights(obs + [({p: K * target[p] for p in dests}, set(dests))], dests)
        unshrunk[a] = fit_weights(obs, seen)
        targets[a] = target
        n_events[a] = len(obs)
        n_available[a] = {p: sum(1 for _, avail in obs if p in avail) for p in dests}

    def rounded(m):
        return {a: {b: round(v, 4) for b, v in row.items()} for a, row in m.items()}
    with open(OUT, "w") as fh:
        json.dump({
            "version": "transfer matrix v0",
            "meaning": "matrix[from][to]: share of a party's transferring voters who go to each other "
                       "party when all eight are standing. Where only some stand, renormalise the row "
                       "over those standing. Non-transferable votes are excluded.",
            "parties": PARTIES,
            "blocs": BLOCS,
            "settings": {"max_other_party_share": MAX_OTHER_PARTY_SHARE, "running_mate_continuing": "excluded",
                         "event_weighting": "each event counts once", "k_pseudo_events": K,
                         "hand_set_targets": {f"{a} -> {b}": s for (a, b), s in HAND_SET_TARGETS.items()}},
            "matrix": rounded(matrix),
            "unshrunk": rounded(unshrunk),
            "bloc_targets": rounded(targets),
            "clean_events": n_events,
            "events_with_destination_available": n_available,
        }, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    short = {"Sinn Féin": "SF", "Alliance": "All", "Green": "Grn", "Aontú": "Aon"}
    print(f"{len(events)} clean events; k = {K:g}")
    print("from \\ to " + "".join(f"{short.get(p, p):>6}" for p in PARTIES) + "  events")
    for a in PARTIES:
        print(f"  {short.get(a, a):<8}" + "".join(
            f"{'—' if a == b else f'{100 * matrix[a][b]:.0f}':>6}" for b in PARTIES) + f"{n_events[a]:>8}")
    print(f"wrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
