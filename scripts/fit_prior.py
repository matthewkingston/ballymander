#!/usr/bin/env python3
"""Fit prior v3: demographic estimate of party shares for every Data Zone.

A joint multinomial logit over the nine modelled parties, fitted at Data
Zone level against 2023 council first preferences summed to DEAs, through
each DEA's ballot via transfer matrix v0 (see
prior_model.py and docs/voting-model.md). The settled choices are constants
here, not re-derived on each run:

  penalties   bloc means 0.1, within-bloc deviations 3.16  (CV-min, leave one
              council out, over bloc [0.001, 0.01, 0.1, 1] x within
              [0.1, 0.316, 1, 3.16, 10])
  tau         1.1: slopes scaled up, intercepts re-fitted, to undo the ridge's
              compression of the most segregated areas (chosen by judgement
              against the most segregated real DEAs)

--cv re-runs that penalty curve and prints it (several minutes).

Shares written per DZ are unmasked -- every party present -- because the prior
describes voters, not a ballot paper. Who stood where is applied downstream.

Both were re-tuned for prior v3, when the transfer matrix replaced masking.

Reads   data/model/dz21_features.csv, data/model/transfer_matrix_v0.json,
        data/council_elections_23/…, data/dz21_electorate.json
Writes  data/model/prior_v3_model.json
        data/model/prior_v3_dz.csv
"""
from __future__ import annotations

import argparse
import csv
import json

import numpy as np

from prior_model import BLOCS, K, MODEL, PARTIES, ROOT, Data

BLOC_PENALTY = 0.1
WITHIN_BLOC_PENALTY = 3.16
TAU = 1.1
GRID_BLOC = [0.001, 0.01, 0.1, 1.0]
GRID_WITHIN = [0.1, 0.316, 1.0, 3.16, 10.0]


def cv_curve(d: Data) -> None:
    combos = [(ab, aw) for aw in GRID_WITHIN for ab in GRID_BLOC]
    scores = np.zeros((len(combos), len(d.folds)))
    alld = np.arange(len(d.dea_names))
    for j, fold in enumerate(d.folds):
        tr, te = alld[d.council != fold], alld[d.council == fold]
        trz, tez = d.dzs_in(tr), d.dzs_in(te)
        Xtr, _ = d.prepare(trz, trz)
        Xte, _ = d.prepare(trz, tez)
        for c, (ab, aw) in enumerate(combos):
            theta = d.fit(Xtr, trz, tr, ab, aw)     # cold start: warm starts stall short of the optimum
            P = d.on_ballot(d.to_dea(d.predict(theta, Xte), tez, te), te)
            scores[c, j] = d.kl(P, te)
    mean = 1000 * scores.mean(1)
    print("CV KL per vote (millinats), leave one council out; rows within-bloc, columns bloc penalty")
    print("         " + "".join(f"{ab:>8g}" for ab in GRID_BLOC))
    for i, aw in enumerate(GRID_WITHIN):
        print(f"  {aw:<7g}" + "".join(f"{mean[i * len(GRID_BLOC) + j]:>8.1f}" for j in range(len(GRID_BLOC))))
    ab, aw = combos[int(mean.argmin())]
    print(f"  minimum at bloc {ab:g} / within {aw:g}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cv", action="store_true", help="re-run the penalty CV curve first")
    args = ap.parse_args()

    d = Data()
    if args.cv:
        cv_curve(d)

    allz, alld = np.arange(len(d.codes)), np.arange(len(d.dea_names))
    X, (lo, hi, mu, sd) = d.prepare(allz, allz)
    theta = d.fit(X, allz, alld, BLOC_PENALTY, WITHIN_BLOC_PENALTY)
    theta = d.steepen(theta, X, allz, alld, TAU)
    shares = d.predict(theta, X)
    p = X.shape[1]

    MODEL.mkdir(parents=True, exist_ok=True)
    model = {
        "version": "prior v3",
        "parties": PARTIES,
        "blocs": BLOCS,
        "features": d.features,
        "bloc_penalty": BLOC_PENALTY,
        "within_bloc_penalty": WITHIN_BLOC_PENALTY,
        "tau": TAU,
        "ballot_mapping": "transfer_matrix_v0.json, absent party's row renormalised over the parties standing",
        "intercepts": theta[:K].tolist(),
        "coef": theta[K:].reshape(K, p).tolist(),
        "clip_lo": lo.tolist(),
        "clip_hi": hi.tolist(),
        "standardise_mean": mu.tolist(),
        "standardise_sd": sd.tolist(),
        "apply": "x -> clip(x, clip_lo, clip_hi) -> (x - mean) / sd -> softmax(intercepts + coef @ x)",
    }
    (MODEL / "prior_v3_model.json").write_text(json.dumps(model, indent=1, ensure_ascii=False) + "\n")
    with (MODEL / "prior_v3_dz.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["code"] + PARTIES)
        for code, row in zip(d.codes, shares):
            w.writerow([code] + [f"{x:.6f}" for x in row])

    P = d.on_ballot(d.to_dea(shares, allz, alld), alld)
    print(f"in-sample KL per vote {1000 * d.kl(P, alld):.1f} millinats over {len(alld)} DEAs")
    for f in ("prior_v3_model.json", "prior_v3_dz.csv"):
        print(f"wrote {(MODEL / f).relative_to(ROOT)}")


if __name__ == "__main__":
    main()
