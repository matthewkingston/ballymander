#!/usr/bin/env python3
"""Estimate how prior v2's errors covary between parties, at DEA scale.

This is the uncertainty used to weight the prior against election evidence, not
a final confidence interval. Steps (reasons in docs/voting-model.md):

 1. Out-of-sample predictions: refit the prior with each council left out and
    predict that council's DEAs, put through each DEA's ballot with the
    transfer matrix.
 2. Variation matrix: for each pair of parties, the variance over DEAs where both
    stood of (predicted - actual) log(share_p / share_q). Pairwise log-ratios
    need no common set of parties, so the missing-candidate pattern can't
    produce an invalid matrix. Shares floored at 0.2%.
 3. clr covariance  S = -1/2 H T H,  H = I - 11'/K.
 4. Shrink each correlation towards a bloc target -- the overlap-weighted mean
    correlation of its pair type (six types: within each bloc, and each pair of
    blocs) -- by lambda = k / (k + n), n = DEAs where both stood. k = 10 for
    nationalist-other pairs, 60 for all others.
 5. Clip any negative eigenvalue to zero.

Scaling to larger areas is Method B: variance x (population ratio)^beta, with
beta = -0.35 measured on prior v2. It's recorded in the output, not applied.

Reads   the prior inputs (see fit_prior.py)
Writes  data/model/prior_v2_oos_dea.json
        data/model/prior_v2_covariance.json
"""
from __future__ import annotations

import json

import numpy as np

from fit_prior import BLOC_PENALTY, TAU, WITHIN_BLOC_PENALTY
from prior_model import BLOC_INDEX, BLOCS, FLOOR, K, MODEL, PARTIES, ROOT, Data

BLOC_NAMES = list(BLOCS)
K_SHRINK = {"nationalist-other": 10.0}
K_SHRINK_DEFAULT = 60.0
BETA = -0.35
MIN_OVERLAP = 4


def pair_type(i: int, j: int) -> str:
    a, b = sorted([BLOC_INDEX[i], BLOC_INDEX[j]])
    return f"within {BLOC_NAMES[a]}" if a == b else f"{BLOC_NAMES[a]}-{BLOC_NAMES[b]}"


def out_of_sample(d: Data) -> np.ndarray:
    alld = np.arange(len(d.dea_names))
    P = np.zeros_like(d.Y)
    for fold in d.folds:
        tr, te = alld[d.council != fold], alld[d.council == fold]
        trz, tez = d.dzs_in(tr), d.dzs_in(te)
        Xtr, _ = d.prepare(trz, trz)
        Xte, _ = d.prepare(trz, tez)
        theta = d.fit(Xtr, trz, tr, BLOC_PENALTY, WITHIN_BLOC_PENALTY)
        theta = d.steepen(theta, Xtr, trz, tr, TAU)
        P[te] = d.on_ballot(d.to_dea(d.predict(theta, Xte), tez, te), te)
    return P


def main() -> None:
    d = Data()
    P = out_of_sample(d)
    alld = np.arange(len(d.dea_names))
    print(f"out-of-sample KL per vote {1000 * d.kl(P, alld):.1f} millinats (leave one council out)")

    LP, LY = np.log(np.maximum(P, FLOOR)), np.log(np.maximum(d.Y, FLOOR))
    T = np.zeros((K, K))
    N = np.zeros((K, K), int)
    for i in range(K):
        N[i, i] = d.M[:, i].sum()
        for j in range(i + 1, K):
            ok = d.M[:, i] & d.M[:, j]
            N[i, j] = N[j, i] = ok.sum()
            if ok.sum() < MIN_OVERLAP:
                raise SystemExit(f"{PARTIES[i]}-{PARTIES[j]}: only {ok.sum()} DEAs with both standing")
            u = (LP[ok, i] - LP[ok, j]) - (LY[ok, i] - LY[ok, j])
            T[i, j] = T[j, i] = u.var(ddof=1)
    H = np.eye(K) - 1.0 / K
    S = -0.5 * H @ T @ H
    sd = np.sqrt(np.diag(S))
    R = S / np.outer(sd, sd)

    pairs = [(i, j) for i in range(K) for j in range(i + 1, K)]
    num, den = {}, {}
    for i, j in pairs:
        t = pair_type(i, j)
        num[t] = num.get(t, 0.0) + R[i, j] * N[i, j]
        den[t] = den.get(t, 0) + N[i, j]
    targets = {t: num[t] / den[t] for t in num}

    Rs = np.eye(K)
    for i, j in pairs:
        t = pair_type(i, j)
        k = K_SHRINK.get(t, K_SHRINK_DEFAULT)
        lam = k / (k + N[i, j])
        Rs[i, j] = Rs[j, i] = (1 - lam) * R[i, j] + lam * targets[t]
    cov = Rs * np.outer(sd, sd)
    w, V = np.linalg.eigh(cov)
    clipped = w[w < 0].tolist()
    cov = V @ np.diag(np.maximum(w, 0)) @ V.T
    sd_final = np.sqrt(np.diag(cov))
    corr = cov / np.outer(sd_final, sd_final)

    print("per-party sd (log-ratio): " + "  ".join(f"{p} {s:.2f}" for p, s in zip(PARTIES, sd_final)))
    print("bloc targets: " + "  ".join(f"{t} {v:+.2f}" for t, v in targets.items()))
    print("eigenvalues clipped to zero: " + (", ".join(f"{x:+.5f}" for x in clipped) or "none"))

    (MODEL / "prior_v2_oos_dea.json").write_text(json.dumps({
        "description": "prior v2 predictions for each DEA with its council left out of the fit, "
                       "put through the DEA's ballot with transfer matrix v0; Y is the actual share",
        "parties": PARTIES, "deas": d.dea_names, "council": d.council.tolist(),
        "P_oos": np.round(P, 6).tolist(), "Y": np.round(d.Y, 6).tolist(), "stood": d.M.tolist(),
    }, ensure_ascii=False) + "\n")
    (MODEL / "prior_v2_covariance.json").write_text(json.dumps({
        "version": "prior v2",
        "parties": PARTIES,
        "scale": "DEA (2023 council first preferences, out of sample by council)",
        "representation": "clr (centred log-ratio) of party shares",
        "sd": sd_final.tolist(),
        "corr": corr.tolist(),
        "cov": cov.tolist(),
        "variation_matrix": T.tolist(),
        "corr_unshrunk": R.tolist(),
        "overlap_n": N.tolist(),
        "bloc_targets": targets,
        "k": {**K_SHRINK, "all other pair types": K_SHRINK_DEFAULT},
        "eigenvalues_clipped": clipped,
        "floor": FLOOR,
        "beta": BETA,
        "scaling": "variance for a region = cov * (region population / DEA population)^beta",
    }, indent=1, ensure_ascii=False) + "\n")
    for f in ("prior_v2_oos_dea.json", "prior_v2_covariance.json"):
        print(f"wrote {(MODEL / f).relative_to(ROOT)}")


if __name__ == "__main__":
    main()
