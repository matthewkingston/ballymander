"""Shared pieces of the voting-model prior: data loading, the model, fitting.

Imported by fit_prior.py and prior_covariance.py. See docs/voting-model.md for
what each choice is and why it was made.

The prior is a joint multinomial logit over nine parties, symmetric (every
party has its own coefficients, no reference party), with a bloc-structured
ridge penalty. It predicts shares for every Data Zone from that DZ's own
features and is fitted by summing those predictions up to DEA totals and
scoring them against the 2023 council first preferences -- fitting at the
level it is applied at, so the slope isn't flattened by aggregation.

DZ shares are unmasked: every party's voters, whether or not it stood. Before
scoring, each DEA's shares are put through the ballot that DEA actually had: a
party that stood keeps its voters, and an absent party's voters go to the
parties that stood in proportion to its row of transfer matrix v0,
renormalised over them. (Renormalising directly, not cascading through other
absent parties, is how the matrix was estimated from STV counts.)
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MODEL = DATA / "model"

FEATURES_CSV = MODEL / "dz21_features.csv"
COUNCIL = DATA / "council_elections_23" / "council_elections_2023.json"
ELECTORATE = DATA / "dz21_electorate.json"
DEA_CODES = DATA / "ni-census21-people-dea14-40874f41.json"
TRANSFERS = MODEL / "transfer_matrix_v0.json"

# Independents and the micro-parties (PUP, Conservative, IRSP, Workers Party,
# CCLA, Socialist Party) are transparent: dropped from both sides.
PARTIES = ["Sinn Féin", "DUP", "Alliance", "UUP", "SDLP", "TUV", "Green", "PBP", "Aontú"]
BLOCS = {
    "nationalist": ["Sinn Féin", "SDLP", "PBP", "Aontú"],
    "unionist": ["DUP", "UUP", "TUV"],
    "other": ["Alliance", "Green"],
}
K = len(PARTIES)
MARGIN = 0.5      # clip features to the training range +/- half that range
EPS = 1e-6        # tiny intercept penalty: pins the symmetric parameterisation only
FLOOR = 0.002     # floor on shares before taking logs

BLOC_INDEX = np.zeros(K, int)
for _g, (_name, _members) in enumerate(BLOCS.items()):
    for _p in _members:
        BLOC_INDEX[PARTIES.index(_p)] = _g
N_BLOCS = len(BLOCS)


def norm(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower().replace("&", " and "))


def dea_of_label(dz_label: str) -> str:
    return norm(re.sub(r"_[A-Z]+\d+$", "", dz_label).replace("_", " "))


class Data:
    """Everything the fit needs, aligned: DZ features, DEA outcomes, folds."""

    def __init__(self):
        rows = list(csv.DictReader(FEATURES_CSV.open()))
        self.features = [k for k in rows[0] if k != "code"]
        self.codes = [r["code"] for r in rows]
        self.X = np.array([[float(r[f]) for f in self.features] for r in rows])

        council = json.loads(COUNCIL.read_text())
        self.dea_names = [u["dea"] for u in council["deas"]]
        keys = [norm(n) for n in self.dea_names]
        kidx = {k: i for i, k in enumerate(keys)}
        pi = {p: i for i, p in enumerate(PARTIES)}
        Y, M, N = [], [], []
        for u in council["deas"]:
            v = np.zeros(K)
            m = np.zeros(K, bool)
            # standing = the party has votes in the DEA as counted, i.e. after the
            # voting modelling assumptions in README.md are applied
            for p, x in u["party_first_prefs"].items():
                if p in pi:
                    v[pi[p]] += x
                    m[pi[p]] = True
            N.append(v.sum()); Y.append(v / v.sum()); M.append(m)
        self.Y, self.M, self.N = np.array(Y), np.array(M), np.array(N, float)
        self.W = self.N / self.N.mean()

        # G[d][a][b]: share of party a's voters counted for party b on DEA d's ballot
        tm = json.loads(TRANSFERS.read_text())["matrix"]
        self.G = np.zeros((len(self.dea_names), K, K))
        for d, stood in enumerate(self.M):
            for a in range(K):
                if stood[a]:
                    self.G[d, a, a] = 1.0
                else:
                    row = np.array([tm[PARTIES[a]].get(PARTIES[b], 0.0) if stood[b] else 0.0
                                    for b in range(K)])
                    if row.sum() <= 0:
                        raise ValueError(f"{self.dea_names[d]}: {PARTIES[a]} has no transfer destination")
                    self.G[d, a] = row / row.sum()

        codes = {norm(c["label"]): c["code"]
                 for c in json.loads(DEA_CODES.read_text())["table"]["dimensions"][0]["categories"]}
        self.council = np.array([codes[k][5:7] for k in keys])   # N1000 LL DD

        el = json.loads(ELECTORATE.read_text())["table"]
        label = {c["code"]: c["label"] for c in el["dimensions"][0]["categories"]}
        electorate = dict(zip(label, el["values"]))
        self.dea_of_dz = np.array([kidx[dea_of_label(label[c])] for c in self.codes])
        e = np.array([electorate[c] for c in self.codes], float)
        dea_e = np.bincount(self.dea_of_dz, weights=e, minlength=len(keys))
        self.wdz = e / dea_e[self.dea_of_dz]       # turnout flat within a DEA
        self.folds = sorted(set(self.council))

    def dzs_in(self, deas):
        return np.where(np.isin(self.dea_of_dz, deas))[0]

    def prepare(self, train_dz, apply_dz):
        """Clip to the training range +/- MARGIN, then standardise on training DZs."""
        Xt = self.X[train_dz]
        lo, hi = Xt.min(0), Xt.max(0)
        r = hi - lo
        lo, hi = lo - MARGIN * r, hi + MARGIN * r
        mu, sd = Xt.mean(0), Xt.std(0)
        sd[sd == 0] = 1
        return (np.clip(self.X[apply_dz], lo, hi) - mu) / sd, (lo, hi, mu, sd)

    def objective(self, Xs, dz_idx, deas, a_b, a_w, fixed_B=None):
        """Loss for a fit on training DZs `dz_idx`, scored on training DEAs `deas`."""
        p = Xs.shape[1]
        wd = self.wdz[dz_idx]
        remap = -np.ones(len(self.dea_names), int)
        remap[deas] = np.arange(len(deas))
        ri = remap[self.dea_of_dz[dz_idx]]
        Yt, Mt, Wt, Gt, nd = self.Y[deas], self.M[deas], self.W[deas], self.G[deas], len(deas)
        counts = np.bincount(BLOC_INDEX, minlength=N_BLOCS)

        def f(theta):
            b = theta[:K]
            B = fixed_B if fixed_B is not None else theta[K:].reshape(K, p)
            L = b[None, :] + Xs @ B.T
            L -= L.max(1, keepdims=True)
            pz = np.exp(L)
            pz /= pz.sum(1, keepdims=True)
            Pd = np.zeros((nd, K))
            np.add.at(Pd, ri, wd[:, None] * pz)
            Po = np.einsum("da,dab->db", Pd, Gt)             # onto each DEA's ballot
            Pc = np.where(Mt, np.maximum(Po, 1e-300), 1.0)
            loss = -(Wt[:, None] * Yt * np.log(Pc)).sum()
            g_obs = np.where(Mt, -(Wt[:, None] * Yt) / Pc, 0.0)
            gp = np.einsum("db,dab->da", g_obs, Gt)[ri] * wd[:, None]
            deta = pz * (gp - (gp * pz).sum(1, keepdims=True))
            gb = deta.sum(0) + 2 * EPS * b
            loss += EPS * (b ** 2).sum()
            if fixed_B is not None:
                return loss, gb
            means = np.array([B[BLOC_INDEX == g].mean(0) for g in range(N_BLOCS)])
            dev = B - means[BLOC_INDEX]
            loss += a_w * (dev ** 2).sum() + a_b * (counts[:, None] * means ** 2).sum()
            gB = deta.T @ Xs + 2 * a_w * dev + 2 * a_b * means[BLOC_INDEX]
            return loss, np.concatenate([gb, gB.ravel()])
        return f

    def fit(self, Xs, dz_idx, deas, a_b, a_w, init=None):
        p = Xs.shape[1]
        x0 = init if init is not None else np.zeros(K + K * p)
        r = minimize(self.objective(Xs, dz_idx, deas, a_b, a_w), x0, jac=True,
                     method="L-BFGS-B", options={"maxiter": 5000, "gtol": 1e-8})
        return r.x

    def refit_intercepts(self, Xs, dz_idx, deas, B):
        r = minimize(self.objective(Xs, dz_idx, deas, 0, 0, fixed_B=B), np.zeros(K),
                     jac=True, method="L-BFGS-B")
        return r.x

    @staticmethod
    def predict(theta, Xs):
        """Unmasked shares: every party's voters."""
        p = Xs.shape[1]
        L = theta[:K][None, :] + Xs @ theta[K:].reshape(K, p).T
        L -= L.max(1, keepdims=True)
        E = np.exp(L)
        return E / E.sum(1, keepdims=True)

    def to_dea(self, pz, dz_idx, deas):
        remap = -np.ones(len(self.dea_names), int)
        remap[deas] = np.arange(len(deas))
        Pd = np.zeros((len(deas), K))
        np.add.at(Pd, remap[self.dea_of_dz[dz_idx]], self.wdz[dz_idx][:, None] * pz)
        return Pd

    def on_ballot(self, Pd, deas):
        """DEA voter shares -> shares counted for the parties that stood."""
        return np.einsum("da,dab->db", Pd, self.G[deas])

    def kl(self, P, deas):
        Yt, Mt, Wt = self.Y[deas], self.M[deas], self.W[deas]
        t = np.where(Mt & (Yt > 0), Yt * np.log(np.maximum(Yt, 1e-300) / np.maximum(P, 1e-300)), 0).sum(1)
        return (Wt * t).sum() / Wt.sum()

    def steepen(self, theta, Xs, dz_idx, deas, tau):
        """Scale the slopes by tau and re-fit the intercepts to match."""
        p = Xs.shape[1]
        B = tau * theta[K:].reshape(K, p)
        b = self.refit_intercepts(Xs, dz_idx, deas, B)
        return np.concatenate([b, B.ravel()])
