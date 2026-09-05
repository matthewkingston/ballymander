# NI Data Zones map

Interactive map of Northern Ireland's 3,780 Census 2021 Data Zones, with
population on hover.

![zones](docs/map-hover.png)

## Quick start

```bash
./run.sh
```

First run fetches the toolchain (~28MB) and builds the map data (~30s); after
that it just serves. Then, **from your laptop**:

```bash
ssh -L 8765:localhost:8765 <user>@<this-box>
# or on an existing session: press Enter, then ~C , then:  -L 8765:localhost:8765
```

and open <http://localhost:8765>.

The server binds `127.0.0.1` only — this box has a public IP, so the app is
deliberately not exposed. Rendering happens in your laptop's browser, so only
the one-time ~0.7MB data fetch crosses the tunnel; pan, zoom and hover are local.

> Don't run a browser on the box through X11 forwarding — WebGL over X11 is
> painful-to-broken and would round-trip every frame.

Other flags: `./run.sh --rebuild` (force a data rebuild), `./run.sh --port 9000`.

## How it works

```
data/*.json      ──prepare_attributes.py──>  build/dz_attributes.csv
data/DZ2021.geojson ──build_map_data.sh────>  web/data/dz.geojson  ──> web/ app
                        (mapshaper)
```

| Script | Does |
|---|---|
| `scripts/setup_tools.sh` | node + mapshaper into `.tools/`, MapLibre into `web/vendor/`. No sudo. |
| `scripts/prepare_attributes.py` | NISRA flexible-table JSON → CSV |
| `scripts/build_map_data.sh` | mapshaper: simplify + join + trim fields |
| `scripts/verify_build.py` | asserts the output is correct |
| `scripts/serve.py` | static server, gzip, localhost-only |
| `scripts/smoke_test.sh` | headless browser check + screenshots |

Everything build-time lives in `.tools/` and is disposable: `rm -rf .tools`.
Nothing in `web/` depends on node, and the running app makes **zero external
requests** — MapLibre is vendored.

### Why mapshaper

The source is 75MB with 1.76M vertices, and **60.5% of its points are shared
between neighbouring zones**. Simplification therefore has to be topology-aware:
anything per-polygon (`ogr2ogr -simplify`, Shapely's `.simplify(preserve_topology=True)`
— that flag preserves each polygon's *own* validity, not shared borders) tears
visible gaps between zones. mapshaper builds topology on import and simplifies
each shared arc once.

Result: 1,760,787 → 146,017 vertices (8.3%), 3.6MB, 0.7MB gzipped.

Tune with `SIMPLIFY=9% ./scripts/build_map_data.sh` — higher keeps more detail.

## Adding another DZ-level dataset

Drop the NISRA JSON in `data/`, then add **one line** to `TABLES` in
`scripts/prepare_attributes.py`:

```python
TABLES = [
    {"column": "pop",  "file": "ni-census21-people-dz21-96e78665.json"},
    {"prefix": "rel",  "file": "ni-census21-...religion...json"},   # 2-D: one column per category
]
```

Then `./run.sh --rebuild`. The loader handles 1-D (zone → number) and 2-D
(zone × category) tables; 2-D becomes one column per category, e.g. `rel_catholic`.

The religion table is already in `data/` and commented out ready to enable.

> **Note on the numbers:** DZ-level census counts carry NISRA's statistical
> disclosure control, so they're approximate by a person or two and won't
> reconcile exactly with published higher-level totals. The people table sums to
> 1,903,168 against the published 1,903,175.

## The app

`web/app.js` is split into data / map / layers / interaction so the planned
dynamic features drop in without restructuring:

```js
// recolour by any metric (e.g. a choropleth)
__map.setPaintProperty('dz-fill', 'fill-color', expression)

// swap the data live
__map.getSource('dz').setData(next)
```

Hover uses MapLibre `feature-state` keyed off the DZ code (via the source's
`promoteId`), so nothing re-renders per mouse move and there is no per-feature
DOM. `window.__map` is exposed as a console handle.

## Verification

```bash
python3 scripts/verify_build.py    # data assertions
./scripts/smoke_test.sh            # headless render + hover, needs run.sh serving
```

`verify_build.py` checks 3,780 features, unique codes matching the source, all
rings closed and ≥4 points, and that populations sum to 1,903,168.

`smoke_test.sh` loads the page in headless Chromium, asserts no console errors,
no failed requests and no external requests, hovers a Belfast zone to confirm
the tooltip, and writes `map-full.png` / `map-hover.png` (override with `OUTDIR=`).

### Headless verification setup

This box has no browser, no GPU libs and **no fonts**, all of which were
installed into `.tools/` without sudo:

```bash
cd .tools/pptr && npm install puppeteer
# the bundled installer fails here; fetch the browser manually:
curl -fsSL -o /tmp/chs.zip \
  https://storage.googleapis.com/chrome-for-testing-public/<ver>/linux64/chrome-headless-shell-linux64.zip
# then, without sudo, for the missing shared libs and fonts:
cd .tools/debs && apt-get download libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libgbm1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libxi6 libxrender1 libxres1 fonts-dejavu-core
for d in *.deb; do dpkg-deb -x "$d" ../sysroot; done
```

`smoke_test.sh` wires up `LD_LIBRARY_PATH` and `FONTCONFIG_FILE` for these.
Without the fonts, text renders as zero-width glyphs and screenshots look blank.

## Data

| File | Contents |
|---|---|
| `data/DZ2021.geojson` | 3,780 Data Zones (NISRA, 2021) |
| `data/SDZ2021.geojson` | 850 Super Data Zones — parent tier, unused so far |
| `data/ni-census21-people-dz21-*.json` | population per DZ |
| `data/ni-census21-...religion...json` | religion per DZ × 4 categories |

Hierarchy is a clean tree: DZ → SDZ → DEA → LGD. Source `.geojson` files are
gitignored (large); the census JSON is small enough to keep.
