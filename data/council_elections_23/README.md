# NI local council elections 2023 — first preferences by DEA

`council_elections_2023.json` — built by `scripts/parse_council_2023.py` from the
59 raw result sheets in `raw/` (see `manifest.tsv` for checksums and source URLs).

All 80 DEAs, 807 candidates, 462 seats, 745,516 valid votes.

## Verification

Every DEA's first preferences are summed and compared against the **Total Valid
Votes printed on that same sheet**. All 80 reconcile exactly
(`reconciled_to_stated_total: true`). Candidate and seat counts match the
published NI totals, and NI-wide party shares match the official result
(SF 30.96%, DUP 23.21%, Alliance 13.31%, UUP 10.90%, SDLP 8.72%, TUV 3.92%).

## Source formats

| format | DEAs | notes |
|---|---|---|
| `pdf_text` | 35 | machine-readable PDFs, parsed from glyph positions |
| `xlsx` | 14 | one workbook per DEA |
| `xlsx_bundle` | 24 | Belfast / Ards & North Down / Antrim & Newtownabbey |
| `pdf_scanned_transcribed` | 7 | Fermanagh & Omagh — image-only, hand transcribed |

The 7 Fermanagh & Omagh sheets (Enniskillen, Erne East/North/West, Mid Tyrone,
Omagh, West Tyrone) have **no text layer at all**. Their figures were read off
the rendered page images and are validated the same way — each sums exactly to
the Total Valid Votes printed on the sheet. Two caveats there: long candidate
names are clipped by the source rendering itself (e.g. `Devine Gallagher, Ro`),
and West Tyrone's invalid-vote count is derived (8413 − 8301 = 112) as the field
was not legible.

## Derived fields

Two fields are not always printed on the sheets and are recovered rather than
read. Both carry a marker so nothing derived is mistaken for source.

**`electorate`** — the seven Mid Ulster sheets (Carntogher, Clogher Valley,
Cookstown, Dungannon, Magherafelt, Moyola, Torrent) print no eligible
electorate, but every sheet prints `% Poll`. Since

```
electorate = votes polled / % Poll        votes polled = valid / (1 - invalid rate)
```

the only unknown is the invalid rate, and that is tightly bounded across the
DEAs that do publish it (median 1.23%, p10-p90 0.84%-1.81%). Tested against the
66 DEAs printing both figures, the recovery has a median error of **+0.05%**
and a standard deviation of 0.40%; 65 of 66 fall within 1% and all 66 within
2%. `electorate_source` is `"derived"` for those seven and `"source"` for the
rest, and each is listed in `flags`.

As a second check, the seven derived electorates give register-to-adult-
population ratios of 0.852-1.009 (median 0.969) against 0.957 for the other 73
— inside the normal range and slightly high, as expected for rural DEAs.

**`poll_pct`** — normalised on read. Most sheets store `% Poll` as a percentage
(55.51) but two Belfast worksheets store it as a fraction (0.5551), so a value
below 1.5 is multiplied by 100. Left unnormalised this inflated the derived
electorate by a factor of 100.

## Known gaps

`flags` in the JSON lists anything unresolved. There are currently **no
error-level flags**; both remaining entries are informational.

EONI's Sperrin workbook leaves the Description cell as `0` for two candidates,
so their party is not in the source at all:

* Sperrin — `Barr, Raymond` (985 first prefs)
* Sperrin — `Gallagher, Paul` (1042 first prefs)

Both are recorded as **Independent** by manual assignment (confirmed 2026-09-10),
not from the sheet. Every candidate carries `party_source`, which is `"source"`
except for these two, where it is `"manual"` — so the assignment stays visible
to anything consuming the file, and `flags` records it. With them included the
NI independent share is 4.61%, matching the published figure.

These are the only two manual assignments in the dataset, and they fill genuine
blanks rather than reassigning a declared party.

Separately, seven independents are counted as the party their voters would
strongly tend to back at Westminster level (`party_source: "assumed"`, declared
label kept in `party_as_declared`). See "Voting modelling assumptions" in the
top-level `README.md` for the list, the reasoning and the `party_source`
vocabulary.

## Party standardisation

55 distinct description strings across the sources collapse to 16 party labels
(`party_names` in the JSON). Each candidate keeps its verbatim `party_raw`
alongside the standardised `party`.

**Labels match `data/pc24_results_2024.json` exactly** — all 12 parties common to
both elections use the same `party` label and the same `party_name`, so the two
datasets join on `party` directly (`Sinn Féin`, `DUP`, `Alliance`, `UUP`, `SDLP`,
`TUV`, `Independent`, `Green`, `PBP`, `Aontú`, `CCLA`, `Conservative`). Four more
stood at council level only and follow the same naming style: `IRSP`, `PUP`,
`Socialist Party`, `Workers Party`. The mapping is explicit, not fuzzy: an
unrecognised string is flagged rather than guessed. Source typos handled
include `Indepdendent`, `GREEN PART NORTHERN IRELAND`,
`Socialist Party (Northenr Ireland)` and `Democratic Unionist Part - D.U.P`.
