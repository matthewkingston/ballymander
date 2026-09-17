#!/usr/bin/env python3
"""Fit turnout v0: how much more, or less, each Data Zone votes.

The app has always weighted a Data Zone by its electorate times one NI-wide
turnout, which says every elector is equally likely to vote. They are not: the
2024 Westminster poll ran from 52.1% in Strangford to 62.9% in Fermanagh and
South Tyrone. In a tool about where lines go that matters, because the zones
that turn out least are systematically the same kind of place, so every drawn
region's shares tilt towards them.

What is fitted is an **index**, not a turnout: the level belongs to the
election (a council poll is quieter than an Assembly one) and what the places
share is how far above or below that level they sit. So

    votes in a zone = electorate x level(election) x index(zone)

with the index normalised to one across Northern Ireland.

Fitted on all three elections at once -- 80 council DEAs, 18 Assembly
constituencies, 18 Westminster ones -- each contributing its own level and all
sharing the coefficients. Every one of those carries a measured electorate and
valid-vote count in its own result sheet, so the target needs no estimating.

**Turnout is not a response to the contest**, which is what makes this safe to
model per place: across the 18 Westminster seats the correlation between
turnout and the winning margin is +0.18, near zero and, if anything, the wrong
way round -- the tightest seats in the country (East Londonderry, North Antrim)
are among the quietest. Were it otherwise, fitting turnout per zone would bake
today's boundaries into the zones themselves.

Features are few on purpose: 116 regions is not enough to tell 24 collinear
census shares apart, and the candidate sets are compared by leave-one-region-out
CV below rather than chosen by eye.

Reads   data/model/dz21_features.csv, data/dz21_electorate.json,
        data/ni-census21-people-dz21+age_syoa-*.json,
        data/dz21_to_pc08.csv, data/dz21_to_pc24.csv,
        data/council_elections_23/…, data/assembly_elections_22/…,
        data/pc24_results_2024.json
Writes  data/model/turnout_v0.json, data/model/turnout_v0_dz.csv
"""
from __future__ import annotations

import csv
import glob
import json
import re

import numpy as np

from prior_model import DATA, MARGIN, MODEL, ROOT, Data

# Candidate feature sets, smallest first. The winner is chosen by CV, not taste.
CANDIDATES = {
    "grade only": ["grade_DE"],
    "grade pair": ["grade_DE", "grade_AB"],
    "grade + age": ["grade_DE", "grade_AB", "age_65_plus"],
    "grade + community": ["grade_DE", "grade_AB", "up_catholic"],
    "+ age": ["grade_DE", "grade_AB", "age_65_plus", "up_catholic"],
    "+ identity": ["grade_DE", "grade_AB", "age_65_plus", "up_catholic", "id_other"],
}
# The index is held inside the range real regions have actually recorded, so an
# unusual Data Zone cannot invent a turnout nowhere has ever managed. Taken from
# the data rather than set by hand: see `bounds` below.


def key(s: str) -> str:
    return re.sub(r"[^a-z]", "", str(s).lower().replace("&", "and"))


def age_share(codes: list[str]) -> np.ndarray:
    """Share of the adult population aged 65 and over, per Data Zone."""
    path = glob.glob(str(DATA / "ni-census21-people-dz21+age_syoa-*.json"))[0]
    table = json.loads(open(path).read())["table"]
    zones = [c.get("code") or c["label"] for c in table["dimensions"][0]["categories"]]
    ages = [c["label"] for c in table["dimensions"][1]["categories"]]
    years = np.array([int(re.match(r"(\d+)", a).group(1)) for a in ages])
    values = np.array(table["values"], float).reshape(len(zones), len(ages))
    adult = values[:, years >= 18].sum(1)
    old = values[:, years >= 65].sum(1)
    by_code = dict(zip(zones, np.divide(old, adult, out=np.zeros_like(old), where=adult > 0)))
    return np.array([by_code[c] for c in codes])


def regions_of(d: Data, lookup: str) -> np.ndarray:
    with (DATA / lookup).open() as fh:
        name = {r["code"]: r["pc_name"] for r in csv.DictReader(fh)}
    return np.array([key(name[c]) for c in d.codes])


def observations(d: Data):
    """(layer, region key, electorate, valid votes) for every region measured."""
    council = json.loads((DATA / "council_elections_23" / "council_elections_2023.json").read_text())
    assembly = json.loads((DATA / "assembly_elections_22" / "assembly_2022.json").read_text())
    westminster = json.loads((DATA / "pc24_results_2024.json").read_text())
    rows = []
    for u in council["deas"]:
        rows.append(("council", key(u["dea"]), u["electorate"], u["valid_votes"]))
    for c in assembly["constituencies"]:
        rows.append(("assembly", key(c["constituency"]), c["electorate"], c["valid_votes"]))
    for c in westminster["constituencies"]:
        rows.append(("westminster", key(c["name"]), c["electorate"], c["valid_votes"]))
    return rows


def main() -> None:
    d = Data()
    with (MODEL / "dz21_features.csv").open() as fh:
        rows = list(csv.DictReader(fh))
    names = [c for c in rows[0] if c != "code"]
    F = {n: np.array([float(r[n]) for r in rows]) for n in names}
    F["age_65_plus"] = age_share([r["code"] for r in rows])

    table = json.loads((DATA / "dz21_electorate.json").read_text())["table"]
    by_code = dict(zip([c["code"] for c in table["dimensions"][0]["categories"]], table["values"]))
    electorate = np.array([by_code[c] for c in d.codes], float)

    zone_region = {
        "council": np.array([key(d.dea_names[i]) for i in d.dea_of_dz]),
        "assembly": regions_of(d, "dz21_to_pc08.csv"),
        "westminster": regions_of(d, "dz21_to_pc24.csv"),
    }
    obs = observations(d)
    layers = ["council", "assembly", "westminster"]

    def design(feature_names):
        """Region-level features, turnout, weights and layer labels."""
        X, y, w, lay = [], [], [], []
        for layer, rkey, elect, votes in obs:
            idx = np.where(zone_region[layer] == rkey)[0]
            if not len(idx) or not elect:
                continue
            ew = electorate[idx]
            X.append([float((ew * F[n][idx]).sum() / ew.sum()) for n in feature_names])
            y.append(np.log(votes / elect))
            w.append(elect)
            lay.append(layers.index(layer))
        return np.array(X), np.array(y), np.array(w, float), np.array(lay)

    def fit(X, y, w, lay, n_layers=3):
        """Weighted least squares: one intercept per layer, shared slopes."""
        D = np.hstack([np.eye(n_layers)[lay], X])
        W = np.sqrt(w)[:, None]
        beta, *_ = np.linalg.lstsq(D * W, y * np.sqrt(w), rcond=None)
        return beta

    print("leave-one-region-out CV, rms error in log turnout:")
    best = None
    for label, feature_names in CANDIDATES.items():
        X, y, w, lay = design(feature_names)
        mu, sd = X.mean(0), X.std(0)
        Z = (X - mu) / np.where(sd > 0, sd, 1)
        err = []
        for i in range(len(y)):
            keep = np.arange(len(y)) != i
            if len(set(lay[keep])) < 3:
                continue
            beta = fit(Z[keep], y[keep], w[keep], lay[keep])
            pred = beta[lay[i]] + Z[i] @ beta[3:]
            err.append(pred - y[i])
        rms = float(np.sqrt(np.mean(np.square(err))))
        print(f"  {label:<14}{len(feature_names)} feature(s)   {1000 * rms:6.1f} millinats")
        if best is None or rms < best[0]:
            best = (rms, label, feature_names)
    rms, label, feature_names = best
    print(f"  chosen: {label}")

    X, y, w, lay = design(feature_names)
    mu, sd = X.mean(0), X.std(0)
    sd = np.where(sd > 0, sd, 1)
    beta = fit((X - mu) / sd, y, w, lay)
    levels = {layers[i]: float(np.exp(beta[i])) for i in range(3)}
    coef = beta[3:] / sd                       # back to raw feature units
    lo = X.min(0) - MARGIN * (X.max(0) - X.min(0))
    hi = X.max(0) + MARGIN * (X.max(0) - X.min(0))

    Z = np.stack([np.clip(F[n], lo[i], hi[i]) for i, n in enumerate(feature_names)], 1)
    raw = np.exp((Z - mu) @ coef)
    index = raw / (electorate * raw).sum() * electorate.sum()     # mean one by electorate
    # Every observed region's own index, once its election's level is divided
    # out: the range of these is what a real place has been seen to do.
    observed = np.exp(y - beta[lay])
    bounds = (float(observed.min()), float(observed.max()))
    unclipped = (float(index.min()), float(index.max()))
    clipped = int(((index < bounds[0]) | (index > bounds[1])).sum())
    index = np.clip(index, *bounds)
    index = index / ((electorate * index).sum() / electorate.sum())

    # How well it does, region by region, against what was actually recorded.
    print("\nfit against the regions measured:")
    for i, layer in enumerate(layers):
        sel = lay == i
        pred = np.exp(beta[i] + ((X[sel] - mu) / sd) @ beta[3:])
        act = np.exp(y[sel])
        r = np.corrcoef(pred, act)[0, 1]
        print(f"  {layer:<12}{sel.sum():>3} regions   level {100 * levels[layer]:5.1f}%   "
              f"actual {100 * act.min():.1f}-{100 * act.max():.1f}%   correlation {r:+.2f}")
    print(f"\n  coefficients (per unit share): "
          + ", ".join(f"{n} {c:+.2f}" for n, c in zip(feature_names, coef)))
    print(f"  index spread over {len(index):,} zones: {index.min():.2f} to {index.max():.2f}, "
          f"sd {index.std():.3f}")
    print(f"  before clipping {unclipped[0]:.2f} to {unclipped[1]:.2f}; held to the observed "
          f"regional range {bounds[0]:.2f}-{bounds[1]:.2f}, which binds on {clipped:,} zones "
          f"({100 * clipped / len(index):.1f}%)")

    MODEL.mkdir(parents=True, exist_ok=True)
    (MODEL / "turnout_v0.json").write_text(json.dumps({
        "version": "turnout v0",
        "features": feature_names,
        "chosen_by": f"leave-one-region-out CV over {len(CANDIDATES)} candidate sets",
        "cv_rms_log_turnout": round(rms, 4),
        "levels": {k: round(v, 4) for k, v in levels.items()},
        "coef": [round(float(c), 4) for c in coef],
        "centre": [round(float(v), 6) for v in mu],
        "clip_lo": [round(float(v), 6) for v in lo],
        "clip_hi": [round(float(v), 6) for v in hi],
        "index_clip": [round(v, 4) for v in bounds],
        "index_clip_source": "the most and least eager region observed, level divided out",
        "apply": "x -> clip -> exp((x - centre) @ coef), normalised to mean one by electorate",
        "regions": len(y),
    }, indent=1, ensure_ascii=False) + "\n")
    with (MODEL / "turnout_v0_dz.csv").open("w", newline="") as fh:
        wtr = csv.writer(fh)
        wtr.writerow(["code", "index"])
        for code, v in zip(d.codes, index):
            wtr.writerow([code, f"{v:.5f}"])
    for f in ("turnout_v0.json", "turnout_v0_dz.csv"):
        print(f"wrote {(MODEL / f).relative_to(ROOT)}")


if __name__ == "__main__":
    main()
