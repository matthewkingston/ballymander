#!/usr/bin/env python3
"""Voters v0: estimate each Data Zone's party voters from prior v2 and three elections.

Design (reasons in docs/voting-model.md, "Fitting"):

 1. Per region, per election layer -- council 2023 DEAs, Assembly 2022 (2008
    constituencies), Westminster 2024 (2024 constituencies) -- fit one
    log-ratio shift a_r, shared by every DZ in the region:
        x_z  proportional to  p_z * exp(V a_r)          p_z = prior v2 DZ shares
    prior term     a_r ~ N(0, Sigma_r),  Sigma_r = prior covariance x (pop_r / DEA pop)^beta
    data term      observed log-ratios of the parties that stood ~ N(prediction, Omega_r)
                   prediction = electorate-weighted DZ sum, through the region's ballot
                   (transfer matrix v0); Omega_r = floor_L^2 x (pop_r / constituency pop)^beta,
                   the same for every pair, plus counting noise
 2. Per-layer uncertainty from the curvature at the fit: C_r = (J' Omega^-1 J + Sigma_r^-1)^-1.
 3. Each layer's data contribution D = J' Omega^-1 J, inflated in the directions it
    observes by the within-region spread H_r = h^2 x (pop_r / constituency pop)^0.5:
    D~ = (D^-1 + H_r)^-1.
 4. Per DZ, combine the data contributions of its three regions once, on top of its
    DEA's prior: C_z^-1 = Sigma_DEA^-1 + sum D~_L;  m_z = C_z sum D~_L u_L;
    shares x_z proportional to p_z exp(V m_z).

Coordinates: log-ratio shifts live in the 8-dimensional zero-sum space, with an
orthonormal basis V (9 x 8). Independents and micro-parties are transparent.

Reads   data/model/{prior_v2_dz.csv, prior_v2_covariance.json, transfer_matrix_v0.json},
        the three elections' first preferences, data/dz21_to_pc08.csv, data/dz21_to_pc24.csv,
        data/dz21_electorate.json, the census population table
Writes  data/model/voters_v0_dz.csv          combined voter shares per DZ
        data/model/voters_v0_uncertainty.json per-DZ log-ratio (clr) covariance
        data/model/voters_v0_regions.json     per-region fits, for inspection
"""
from __future__ import annotations

import collections
import csv
import json
import math
import re

import numpy as np
from scipy.linalg import cho_factor, cho_solve, solve_triangular
from scipy.optimize import least_squares

from prior_model import DATA, K, MODEL, PARTIES, ROOT, Data, ballot_matrix, load_transfers

FLOORS = {"council 2023": 0.3, "assembly 2022": 0.2, "westminster 2024": 0.55}  # pairwise SD, constituency scale
SPREAD_H = 0.6          # within-region spread, pairwise SD at constituency size
SPREAD_EXPONENT = 0.5   # H grows as population^0.5
POPULATION = DATA / "ni-census21-people-dz21-96e78665.json"


def zero_sum_basis(n: int) -> np.ndarray:
    """Orthonormal basis (n x n-1) of vectors summing to zero."""
    B = np.zeros((n, n - 1))
    for j in range(1, n):
        v = np.zeros(n)
        v[:j] = 1.0 / j
        v[j] = -1.0
        B[:, j - 1] = v / np.linalg.norm(v)
    return B


def key(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower().replace("&", "and"))


def softmax_rows(L):
    L = L - L.max(1, keepdims=True)
    E = np.exp(L)
    return E / E.sum(1, keepdims=True)


# ------------------------------------------------------------------ inputs ----
def load_inputs():
    d = Data()
    with (MODEL / "prior_v2_dz.csv").open() as fh:
        rows = list(csv.DictReader(fh))
    assert [r["code"] for r in rows] == d.codes
    prior = np.array([[float(r[p]) for p in PARTIES] for r in rows])
    el = json.loads((DATA / "dz21_electorate.json").read_text())["table"]
    electorate = dict(zip([c["code"] for c in el["dimensions"][0]["categories"]], el["values"]))
    pt = json.loads(POPULATION.read_text())["table"]
    population = dict(zip([c["code"] for c in pt["dimensions"][0]["categories"]], pt["values"]))
    E = np.array([electorate[c] for c in d.codes], float)
    pop = np.array([population[c] for c in d.codes], float)
    cov = json.loads((MODEL / "prior_v2_covariance.json").read_text())
    return d, prior, E, pop, np.array(cov["cov"]), cov["beta"]


def build_layers(d):
    zi = {c: i for i, c in enumerate(d.codes)}
    pi = {p: i for i, p in enumerate(PARTIES)}
    layers = []

    def layer(name, region_of_dz, votes):
        names = sorted(votes)
        ri = {n: i for i, n in enumerate(names)}
        V = np.zeros((len(names), K))
        for n, pv in votes.items():
            for p, v in pv.items():
                if p in pi:
                    V[ri[n], pi[p]] += v
        return {"name": name, "regions": names, "V": V,
                "region": np.array([ri[region_of_dz[z]] for z in range(len(d.codes))])}

    layers.append(layer("council 2023", {z: d.dea_names[d.dea_of_dz[z]] for z in range(len(d.codes))},
                        {n: dict(zip(PARTIES, d.N[i] * d.Y[i])) for i, n in enumerate(d.dea_names)}))

    def pc_of(f):
        with (DATA / f).open() as fh:
            return {zi[r["code"]]: r["pc_name"] for r in csv.DictReader(fh)}
    asm = json.loads((DATA / "assembly_elections_22" / "assembly_2022.json").read_text())
    byname = {key(c["constituency"]): (c["constituency"], c["party_first_prefs"]) for c in asm["constituencies"]}
    pc08 = pc_of("dz21_to_pc08.csv")
    layers.append(layer("assembly 2022", {z: byname[key(n)][0] for z, n in pc08.items()},
                        dict(byname.values())))
    wm = {}
    for c in json.loads((DATA / "pc24_results_2024.json").read_text())["constituencies"]:
        pv = collections.Counter()
        for cand in c["candidates"]:
            pv[cand["party"]] += cand["votes"]
        wm[key(c["name"])] = (c["name"], pv)
    pc24 = pc_of("dz21_to_pc24.csv")
    layers.append(layer("westminster 2024", {z: wm[key(n)][0] for z, n in pc24.items()}, dict(wm.values())))
    return layers


# ------------------------------------------------------------- region fit ----
def fit_region(logp, w, votes, G, Sigma_a, floor_var, spread_var, Vb):
    """Fit one region's shift; return its estimate and data contribution."""
    stood = np.where(votes > 0)[0]
    Ws = zero_sum_basis(len(stood))
    y = Ws.T @ np.log(votes[stood] / votes[stood].sum())
    Omega = Ws.T @ (np.eye(len(stood)) * floor_var / 2 + np.diag(1.0 / votes[stood])) @ Ws
    Lo = np.linalg.cholesky(Omega)
    Ls = np.linalg.cholesky(Sigma_a)

    def predict(a):
        X = w @ softmax_rows(logp + Vb @ a)
        B = X @ G
        return Ws.T @ np.log(B[stood])

    def residuals(a):
        return np.concatenate([solve_triangular(Lo, y - predict(a), lower=True),
                               solve_triangular(Ls, a, lower=True)])
    sol = least_squares(residuals, np.zeros(K - 1), method="lm", xtol=1e-12, ftol=1e-12, gtol=1e-12)
    if not sol.success:
        raise RuntimeError(f"region fit did not converge: {sol.message}")
    a = sol.x
    step = 1e-5
    J = np.column_stack([(predict(a + step * e) - predict(a - step * e)) / (2 * step)
                         for e in np.eye(K - 1)])
    D = J.T @ np.linalg.solve(Omega, J)
    prior_prec = cho_solve(cho_factor(Sigma_a), np.eye(K - 1))
    C = np.linalg.inv(D + prior_prec)
    g = (D + prior_prec) @ a                 # the data's pull, D u (prior mean is zero)
    lam, U = np.linalg.eigh(D)
    keep = lam > 1e-9 * max(lam.max(), 1e-12)
    U, lam = U[:, keep], lam[keep]
    inflated = np.linalg.inv(np.diag(1.0 / lam) + spread_var / 2 * np.eye(len(lam)))
    D_tilde = U @ inflated @ U.T
    D_tilde_u = U @ inflated @ (U.T @ g / lam)
    return {"shift": a, "C": C, "D_tilde": D_tilde, "D_tilde_u": D_tilde_u,
            "observed_dims": int(keep.sum()), "cost": float(sol.cost)}


def ballot_log_ratio_rms(shares, votes, G):
    """RMS over party pairs that stood of (predicted - observed) log-ratio on the ballot."""
    stood = np.where(votes > 0)[0]
    B = (shares @ G)[stood]
    o = votes[stood] / votes[stood].sum()
    e = np.log(B) - np.log(o)
    diffs = [(e[i] - e[j]) ** 2 for i in range(len(stood)) for j in range(i + 1, len(stood))]
    return float(np.mean(diffs))


def main() -> None:
    d, prior, E, pop, Sigma, beta = load_inputs()
    layers = build_layers(d)
    tm = load_transfers()
    Vb = zero_sum_basis(K)
    Sigma_a = Vb.T @ Sigma @ Vb
    n_z = len(d.codes)
    dea_ref = pop.sum() / len(d.dea_names)
    const_ref = pop.sum() / 18
    logp = np.log(np.maximum(prior, 1e-12))

    fits, report = {}, {}
    for L in layers:
        R = len(L["regions"])
        pop_r = np.bincount(L["region"], weights=pop, minlength=R)
        e_r = np.bincount(L["region"], weights=E, minlength=R)
        out = []
        for r in range(R):
            idx = np.where(L["region"] == r)[0]
            w = E[idx] / e_r[r]
            G = ballot_matrix(L["V"][r] > 0, tm)
            f = fit_region(logp[idx], w, L["V"][r], G,
                           Sigma_a * (pop_r[r] / dea_ref) ** beta,
                           FLOORS[L["name"]] ** 2 * (pop_r[r] / const_ref) ** beta,
                           SPREAD_H ** 2 * (pop_r[r] / const_ref) ** SPREAD_EXPONENT, Vb)
            f.update(idx=idx, w=w, G=G)
            out.append(f)
        fits[L["name"]] = out

    # ---- combine per DZ
    dea_pop = np.bincount(d.dea_of_dz, weights=pop, minlength=len(d.dea_names))
    prec0 = cho_solve(cho_factor(Sigma_a), np.eye(K - 1))
    region_of = {L["name"]: L["region"] for L in layers}
    m = np.zeros((n_z, K - 1))
    Cz = np.zeros((n_z, K - 1, K - 1))
    cache = {}
    for z in range(n_z):
        combo = (d.dea_of_dz[z],) + tuple(region_of[L["name"]][z] for L in layers)
        if combo not in cache:
            prec = prec0 / (dea_pop[combo[0]] / dea_ref) ** beta
            pull = np.zeros(K - 1)
            for L, r in zip(layers, combo[1:]):
                prec = prec + fits[L["name"]][r]["D_tilde"]
                pull = pull + fits[L["name"]][r]["D_tilde_u"]
            C = np.linalg.inv(prec)
            cache[combo] = (C @ pull, C)
        m[z], Cz[z] = cache[combo]
    shares = softmax_rows(logp + m @ Vb.T)

    # ---- diagnostics: prior, each layer's own fit, and the combined estimate, on each layer's ballots
    regions_out = {}
    for L in layers:
        rows, err = [], collections.defaultdict(list)
        for r, f in enumerate(fits[L["name"]]):
            votes, G, idx, w = L["V"][r], f["G"], f["idx"], f["w"]
            own = w @ softmax_rows(logp[idx] + Vb @ f["shift"])
            for label, s in (("prior", w @ prior[idx]), ("layer fit", own), ("combined", w @ shares[idx])):
                err[label].append(ballot_log_ratio_rms(s, votes, G))
            rows.append({"region": L["regions"][r], "votes": dict(zip(PARTIES, votes.round().astype(int).tolist())),
                         "fitted_voter_shares": dict(zip(PARTIES, np.round(own, 5).tolist())),
                         "combined_voter_shares": dict(zip(PARTIES, np.round(w @ shares[idx], 5).tolist())),
                         "observed_dims": f["observed_dims"]})
        regions_out[L["name"]] = rows
        report[L["name"]] = {k: math.sqrt(np.mean(v)) for k, v in err.items()}

    # ---- outputs
    with (MODEL / "voters_v0_dz.csv").open("w", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(["code"] + PARTIES)
        for code, row in zip(d.codes, shares):
            wr.writerow([code] + [f"{x:.6f}" for x in row])
    iu = np.triu_indices(K)
    clr_cov = np.einsum("ia,zab,jb->zij", Vb, Cz, Vb)
    (MODEL / "voters_v0_uncertainty.json").write_text(json.dumps({
        "description": "per-DZ covariance of the log-ratio (clr) voter shares; upper triangle, row-major",
        "parties": PARTIES, "codes": d.codes,
        "clr_cov_upper": [[round(float(x), 5) for x in c[iu]] for c in clr_cov],
    }, ensure_ascii=False) + "\n")
    (MODEL / "voters_v0_regions.json").write_text(json.dumps({
        "settings": {"floors_pairwise_sd_constituency_scale": FLOORS, "beta": beta,
                     "spread_h": SPREAD_H, "spread_exponent": SPREAD_EXPONENT,
                     "dea_reference_population": round(dea_ref), "constituency_reference_population": round(const_ref)},
        "layers": regions_out,
    }, ensure_ascii=False, indent=1) + "\n")

    print("RMS pairwise log-ratio error on each layer's own ballots (parties that stood):")
    print(f"  {'layer':<18}{'prior':>8}{'layer fit':>11}{'combined':>10}   floor")
    for L in layers:
        rr = report[L["name"]]
        print(f"  {L['name']:<18}{rr['prior']:>8.3f}{rr['layer fit']:>11.3f}{rr['combined']:>10.3f}   {FLOORS[L['name']]}")
    ni_prior = E @ prior / E.sum()
    ni_comb = E @ shares / E.sum()
    print("NI-wide voter shares (electorate-weighted):")
    print("  " + "  ".join(f"{p} {100 * a:.1f}->{100 * b:.1f}" for p, a, b in zip(PARTIES, ni_prior, ni_comb)))
    sd = np.sqrt(np.einsum("zii->zi", clr_cov))
    print("median log-ratio SD per party: " + "  ".join(f"{p} {s:.2f}" for p, s in zip(PARTIES, np.median(sd, 0))))
    for f_ in ("voters_v0_dz.csv", "voters_v0_uncertainty.json", "voters_v0_regions.json"):
        print(f"wrote {(MODEL / f_).relative_to(ROOT)}")


if __name__ == "__main__":
    main()
