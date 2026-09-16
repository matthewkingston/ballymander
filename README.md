# NI Data Zones map

Interactive map of Northern Ireland's 3,780 Census 2021 Data Zones, with
population on hover.

![zones](docs/map-hover.png)

## Quick start

```bash
./run.sh
```

First run fetches the toolchain (~28MB) and builds the map data and the adjacency
graph (a minute or two); after that it just serves. Then, **from your laptop**:

```bash
ssh -L 8765:localhost:8765 <user>@<this-box>
# or on an existing session: press Enter, then ~C , then:  -L 8765:localhost:8765
```

and open <http://localhost:8765>.

The server binds `127.0.0.1` only — this box has a public IP, so the app is
deliberately not exposed. Rendering happens in your laptop's browser, so only
the one-time ~0.8MB data fetch crosses the tunnel; pan, zoom and hover are local.

> Don't run a browser on the box through X11 forwarding — WebGL over X11 is
> painful-to-broken and would round-trip every frame.

Other flags: `./run.sh --rebuild` (force a data rebuild), `./run.sh --port 9000`.

## How it works

```
data/*.json      ──prepare_attributes.py──>  build/dz_attributes.csv
data/DZ2021.geojson ──build_map_data.sh────>  web/data/dz.geojson       ──> web/ app
                        (mapshaper)
data/DZ2021.geojson ──build_adjacency.py───>  web/data/dz_adjacency.json ──> web/ app
```

The two outputs come from the same source but not from each other: the graph is
built from the **full-resolution** boundaries, never the simplified ones.

| Script | Does |
|---|---|
| `scripts/setup_tools.sh` | node + mapshaper into `.tools/`, MapLibre into `web/vendor/`. No sudo. |
| `scripts/prepare_attributes.py` | NISRA flexible-table JSON → CSV |
| `scripts/build_map_data.sh` | mapshaper: simplify + join + trim fields |
| `scripts/verify_build.py` | asserts the map data is correct |
| `scripts/dz_topology.py` | exact boundary-segment topology, shared by the three below |
| `scripts/build_adjacency.py` | builds the adjacency graph; holds `WATER_CROSSINGS` |
| `scripts/dz_graph.py` | importable Python accessor for the graph |
| `scripts/verify_adjacency.py` | asserts the graph is correct |
| `scripts/audit_gaps.py` | review tool: finds close-but-not-adjacent pairs |
| `scripts/test_regions.mjs` | headless test of the region algorithm |
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

Drop the NISRA JSON in `data/`, then add an entry to `TABLES` in
`scripts/prepare_attributes.py`:

```python
TABLES = [
    {"column": "pop",  "file": "ni-census21-people-dz21-96e78665.json"},
    {"prefix": "rel",  "file": "ni-census21-...religion...json"},   # 2-D: one column per category
]
```

A 2-D table can instead be collapsed to a single weighted index with `weights`,
which is how religion is handled:

```python
{"column": "rel", "file": "...religion...json", "weights": {"Catholic": 1.0, ...}},
```

That emits `rel` (the weighted mean) and `rel_n` (the table's own row total).
Every category must carry a weight, both ways — a renamed or added category is a
hard failure rather than a silently wrong index.

For an ordinal table whose *category codes are already the values*, ask for them
by code instead of writing them out:

```python
{"column": "age", "file": "...age_syoa...json", "weight_from": "code"},
```

Age has 101 categories coded `0`–`100` (`100+ years` folded onto 100), so a
literal weights table would be 101 entries that break on any label rewording.

A weight of `None` drops a category from the numerator **and** the denominator,
which is how a non-answer is kept from being counted as an answer:

```python
{"column": "orient", "file": "...sexual_orientation...json", "weights": {
    "Straight or heterosexual": 0.0,
    "Gay, lesbian, bisexual, other sexual orientation": 1.0,
    "Prefer not to say/Not stated": None,
    "No code required": None,     # under 16
}},
```

It still has to be named, so the every-category rule holds. `<column>_n` then
holds the post-exclusion denominator, and `prepare_attributes.py` prints both
totals so the gap is visible.

Then `./run.sh --rebuild`. **It is not quite one line**: the joined fields also
have to be listed in `field-types` and `-filter-fields` in
`scripts/build_map_data.sh`, or mapshaper drops them.

> **Note on the numbers:** DZ-level census counts carry NISRA's statistical
> disclosure control, so they're approximate by a person or two and won't
> reconcile exactly with published higher-level totals. The people table sums to
> 1,903,168 against the published 1,903,175.

## Adjacency

`web/data/dz_adjacency.json` answers *who borders whom* — 3,780 zones, 10,743
edges, one connected component.

```python
import sys; sys.path.insert(0, "scripts")     # when importing from the repo root
from dz_graph import load
g = load()
g.neighbours("N20001651")                      # ['N20001659']
g.are_neighbours("N20003391", "N20003778")     # True
```

```js
__graph.neighbours('N20001651')                // same answers in the browser
__graph.areNeighbours('N20003391', 'N20003778')
```

**Two zones are neighbours when they share a length of boundary**, plus three
declared water crossings. Three decisions are worth knowing about, because none
of them is forced by the data:

*Shared vertices are float-identical* in the source — 60.4% of boundary segments
are claimed by two zones — so adjacency is an exact computation. No tolerance, no
snapping, no spatial index.

*Zones meeting at a single point are not neighbours.* 342 pairs do: the two
diagonals where four zones meet at a crossroads. A contiguous region cannot pass
through a dimensionless point, so they are excluded — but they are recorded under
`point_touches`, readable via `g.point_touches(code)`, so the decision is visible
in the data rather than hidden in a script. One pair sharing 0.32 mm (a digitising
artifact where three zones meet; the next smallest real border is 0.61 m) is
counted here too — see `MIN_SHARED_M`.

*The mosaic excludes water.* Lough Neagh, Strangford, Belfast Lough, Lough Foyle
and Carlingford are uncovered holes and the coast is a hard edge, so places that
are genuinely connected share no boundary — and Rathlin Island falls out of the
graph entirely. `WATER_CROSSINGS` in `build_adjacency.py` bridges exactly three,
declared by zone name so the list can be checked by eye:

| Crossing | Gap | Why |
|---|---|---|
| `Erne_West_F3` ↔ `Erne_East_F1` | 104 m | River Erne at Enniskillen |
| `Downpatrick_B1` ↔ `Ards_Peninsula_N4` | 623 m | Strangford Narrows ferry |
| `The_Glens_B3` ↔ `The_Glens_B1` | 6.3 km | Rathlin Island ferry |

**The test is whether there is a real-world way across — a bridge or a ferry — not
how narrow the water is.** Somewhere you cannot cross is far away in the only
sense that matters, however close it looks on a map. So the two sides of Belfast
Lough, Lough Neagh and Lough Foyle are not neighbours, and neither is the mouth of
Larne Lough: 319 m of water, but nothing crosses it, so those zones stay 6 hops
apart by land. Without the three that *are* declared, the graph has two components
and Rathlin has degree 0.

To check the list against the geometry:

```bash
python3 scripts/audit_gaps.py     # ~30s, prints a table, changes nothing
```

It ranks every non-adjacent pair within 800 m by how many hops apart they are in
the land-only graph — proximity alone is a bad signal, since two zones on the same
stretch of coast are often metres apart across a harbour mouth and a short walk
apart by land. It cannot prove the list complete: it would not have found the
6.3 km Rathlin ferry, which is what the low-degree report at the end is for.

## Building regions

Set a number of regions and press **GO**. The app grows that many regions out of
seed zones until every Data Zone is claimed, then keeps nudging zones between
regions to even the populations up, until you press **STOP**. **PAUSE** holds a
run without ending it — the phase and all model state survive, so resuming
continues exactly where it left off; **STOP** is what restores the best state
and shows the results table.

Controls: number of regions, random seed (same seed gives the same map),
temperature, the three score weights, whether branch moves are allowed, frames
per second, and how many model steps run per frame. The two
phases get separate step controls because they want very different rates -- a
build step claims a whole zone and is worth watching, while an optimisation step
moves one zone in 3,780 and is invisible on its own.

The algorithm is in `web/regions.js`, deliberately free of DOM and MapLibre so it
can be driven headlessly — `web/app.js` only animates it and paints the result,
via `setFeatureState`, so no geometry is re-uploaded as regions change.

**The score** is a weighted sum of normalised terms, **divided by the total
weight** — so only the ratios matter, and 0.1/1/1 is the same objective as
1/10/10. The weights are relative priorities, not gains. Population equality is
the anchor term:

```
S_pop       = SUM_r (pop_r - target)^2 / E[d^2]        target = total / N
build delta = d * (d + 2*(pop_r - target)) / E[d^2]    assign unassigned d to r
move delta  = 2d * (d + pop_B - pop_A)    / E[d^2]     move d out of A into B
```

`E[d^2]` is the mean squared DZ population. Normalising puts every term in units
of *one typical move*, so the temperature is a plain number near 1 at any N and
weights are pure priorities rather than exchange rates between incompatible
units. Note the two deltas are different formulas — assigning an unclaimed zone
is not a move from nowhere.

**Shape** is the second term, a compactness penalty measured as a moment of
inertia about each region's own centroid:

```
A    = SUM a_z          Sx = SUM a_z x_z      Sxx  = SUM a_z (x_z^2 + y_z^2)
Sown = SUM a_z^2/(2pi)  Sy = SUM a_z y_z

I       = Sxx - (Sx^2 + Sy^2)/A + Sown
penalty = 2*pi*I / A^2                       1 for a disc, higher for anything else
S_shape = SUM_r (penalty_r - 1) / sigma_shape
```

Treating each zone as a point mass at its centroid means that identity never
needs the centroid, so a zone joining or leaving is four additions — the same
O(1) as the population delta, with no sampling, no bounding box and no
rotational bias. A square scores 1.047 (π/3), a 4:1 rectangle 2.22.

`Sown` — each zone's own moment, taken as a disc of equal area — stops a
one-zone region scoring 0 and so looking better than a circle, which would bias
the build towards keeping regions small. It decays as `1/k`.

`sigma_shape = mean_zone_area * N / total_area`, derived rather than measured,
and unlike the population term it **depends on N**. The origin is shifted to the
centre of the data before measuring, because `Sxx - (Sx^2+Sy^2)/A` is a small
difference of large numbers and raw projected metres throw away most of the
mantissa.

**People shape** is a third term, the same moment with *people* as the mass
instead of land:

```
I_pop       = Ppp - (Px^2 + Py^2)/P
penalty_pop = 2*pi*I_pop / (P * A)     1 = people spread evenly across the region
```

It exists because the two measures disagree — correlation 0.438 over a run.
DZ areas span a factor of 15,000 while populations span 15, so an area-weighted
centroid sits wherever the *ground* is: measured across one run it lands 0.3 to
8.4 km from where the people are. One region scored 1.20 on land (a tidy patch)
and 2.45 on people (strung out along a line); another scored 1.03 on land (very
nearly a disc) and 0.45 on people (everyone balled into one corner).

Note it has **no floor at 1**, unlike the land penalty. Concentrated population
scores below 1 and earns credit; the land term is what stops that being bought
with sprawl. Normalising by the region's own area does mildly reward absorbing
large thinly-populated zones — that was the deliberate trade against a fixed
scale, which has no such incentive but would steer rural regions hard and urban
ones barely at all.

**Demographics** are the fourth kind of term, and there are four of them. All
work the same way — each zone carries one number, a region's value is the
population-weighted mean of its zones, and a mode selector picks what to do with
the spread of those values across regions. They live in a `DEMOGRAPHICS` table
in `regions.js`; a fifth is its two columns from the pipeline plus one entry
there, and no new UI markup, since the control block, the readout row, the
bar-chart entry and the tooltip lines are all generated from that table.

| | zone value | national |
|---|---|---|
| **religion** | Protestant 0, Catholic 1, the unaligned at 0.5, on the assumption that in a two-way contest they split evenly | **0.511** |
| **age** | mean age in years, from single-year-of-age counts, 100+ folded onto 100 | **39.60** |
| **orientation** | share who answered other than straight — 0 straight, 1 gay, lesbian, bisexual or other | **0.0227** |
| **social grade** | the four grades evenly spaced: AB 1, C1 ⅔, C2 ⅓, semi-skilled and below 0 | **0.4829** |

**The last two are shares of the people who answered, not of everyone.**
"Prefer not to say" and the under-16s the question was never put to are dropped
from the denominator rather than counted as an answer, so 26.7% of the
population sits outside the orientation figure and 20.6% outside social grade.
Each index therefore has its own `_n` column and its own national total, and
none of them is the population total.

A mode selector picks what to do with it:

| mode | term per region | effect |
|---|---|---|
| average | `(x − μ)²` | every region near the national mix |
| extreme | `−min(\|x − μ\|, cap)²` | the same negated and capped: segregate as far as geography allows |
| gerrymander | `1 / (1 + exp((x − t)/s))` | maximise how many regions clear a threshold |

A selector rather than a signed weight, because the score divides by the sum of
the weights and a negative one would collapse then invert that denominator,
taking every other term with it.

The gerrymander logistic is 1 well below the threshold, 0.5 at it, 0 well above,
and steepest exactly at `t` — so **packing and cracking emerge from the shape**
rather than being built in. Regions far below have almost no gradient and get
written off; regions just below have the strongest pull; regions above are
indifferent to losing supporters, so the population term drains them. Measured at
N=18, gerrymandering at 0.6 empties the marginal band completely — three regions
sit within 0.05 of the threshold with the term off, none with it on, and the
values split into a clean gap: `0.21 … 0.39 │ 0.66 … 0.75`.

**Steepness has a sweet spot in both directions.** Too sharp and the term is a
step function with no gradient to climb; too soft and it degenerates into average
mode. At N=18, `s = 0.05` wins 9 seats where `s = 0.15` wins 6.

Sigma is closed form rather than measured. The value is *intensive* — a ratio,
not a sum — so one move shifts it by about `(zone n / region n) × (zone value −
region value)`, which **scales with N** where the population term's does not:

```
delta(N) = vSpread * N / 3780
average, extreme:  sigma = 2 * rSpread * delta
gerrymander:       sigma = delta / (4s)
```

`vSpread` is how far a boundary zone sits from its own region's value; `rSpread`
is the different question of how far *regions* sit from the national value.

**The two demographics need genuinely different constants, and the reason is
worth stating.** Religion is strongly spatially correlated: neighbours resemble
each other, so a region's value stays a long way from the national one however
the lines are drawn. Age is not — adjacent zones differ by *more* than the
overall spread (a student area beside a family one), so averaging ~210 zones per
region washes almost all of it out.

| | national | zone SD | adjacent rms | regional SD (N=18) | vSpread | rSpread |
|---|---|---|---|---|---|---|
| religion | 0.511 | 0.301 | 0.176 | 0.160 | 0.2 | 0.15 |
| age | 39.60 | 5.389 | 6.139 | 1.431 | 5.1 | 1.6 |
| orientation | 0.0227 | 0.0206 | 0.0187 | 0.0103 | 0.019 | 0.011 |
| social grade | 0.4829 | 0.1616 | 0.1457 | 0.0356 | 0.16 | 0.04 |

Every `vSpread` but religion's is measured directly — the rms of (zone value −
its region's value) over the frontier, at N=18 with population the only weight,
and it barely moves at N=50 or 100. Religion's 0.2 predates that measurement and
reads 0.270 the same way, so that term runs about a third hotter than nominal;
it is left alone because the slider absorbs it and the settings tuned so far
assume it. Measured at a common state, the four terms' per-move deltas come out
at 1.40, 0.88, 0.87 and 1.26 — the same order, which is the whole point of the
normalisation.

The narrow regional band is also why each default gerrymander threshold sits
just above its own national figure — 41 years, not anything like 45. Averaging
~210 zones washes most of the zone-level variation out, so the reachable band at
N=18 is only 37.8–43.0 for age, 0.012–0.049 for orientation and 0.411–0.551 for
social grade; a threshold outside that is a target no region could ever reach.

**Extreme mode pays only up to a cap of `5 × rSpread`**, and this is not
cosmetic. `−(x − μ)²` rewards separation without limit, so it will buy a region
made of a single outlier Data Zone — `Bangor_Central_F2` is 180 people in 2
hectares at mean age 72.4. Nothing else in the score resists: a one-zone region
scores about 1 on land shape and on people shape, the best either can give, and
near-minimal on cut edges. Only population equality pushes back, and its cost for
stranding a region falls as `1/N²` while this term's gain falls as `1/N`, so the
weight at which the trade wins drops with N — measured, weight 10 at N=18, 3 at
N=50, **1 at N=100**.

**Religion is the only one of the four that cannot trigger this**, and it is an
accident of its scale rather than anything in the design: a value in [0, 1] sits
at most 0.48 from the national 0.511, which is 3.2× its rSpread. The others all
reach far past 5× — age 20.5×, orientation 13.0×, social grade 10.8× — so all
three need the cap, and each was calibrated on a typical deviation then asked to
price one an order of magnitude larger. At 5× the cap is unreachable for religion
and that term is bit-identical to before; for age it is 8 years, against the 3.6×
that extreme mode already reaches legitimately at N=18. With it, N=18 at weight
10 goes from a one-zone region at 99.8% population deviation to a smallest region
of 186 zones at 5.4%.

The cap is on the *reward* only. Average mode keeps the plain square: it is a
penalty, bounded below by zero, with nothing to gain from a degenerate region —
and capping it would remove the pull on exactly the outliers it exists to bring
in. Gerrymander mode needs no cap either, since the logistic already saturates:
a one-zone region wins one seat, the same as any other.

> The obvious guess for the first line, `sigma = delta^2`, is wrong by a factor
> of over a hundred, and it is an instructive mistake. It carries over the
> reasoning that works for population, where the deviation really does settle at
> one move's worth because the optimiser can drive it there. Religion cannot be
> driven that close — segregation is coarse enough that regions stay ~0.15 apart
> however the lines are drawn — so it is that spread, not `delta`, that sets the
> scale. The wrong version made the term 123× stronger than population at equal
> weights and swamped everything: max deviation went from 1.4% to 33%.
> `test_regions.mjs` now measures every term's per-move delta at a common state
> and asserts they stay within 40× of each other.

Each term aggregates by its own table's row total — `rel_n`, `age_n`,
`orient_n`, `grade_n` — never by `pop`. No two of those totals agree. Disclosure
control perturbs every table independently, which is the handful of people
between population, religion and age (1,903,168 / 1,903,158 / 1,903,347 — and
religion and population disagree in 1,261 of 3,780 zones); the other two are far
smaller because non-answers are excluded outright (1,395,521 and 1,511,617).

**Cut edges** is the last term, and the one that keeps towns whole. It counts
adjacency edges whose two zones ended up in different regions — a *count*, not a
length: two zones sharing 3 km count 1, exactly like two sharing 30 m.

That works because Data Zones hold roughly equal population, so their borders
are dense where people are dense. Measured on the real graph, a 1 km stretch of
region boundary crosses:

| | mean shared border | borders per km |
|---|---|---|
| countryside (<500/km²) | 2,018 m | **0.5** |
| edge of town | 398 m | 2.5 |
| town (2,500–6,000/km²) | 279 m | **3.6** |
| city (>6,000/km²) | 189 m | 5.3 |

So cutting through Omagh costs about 7× what the same distance of farmland
costs, and the optimiser routes around towns without ever being told what a town
is. Penalising boundary *length* would not do this — that is a compactness
measure, indifferent to what the boundary passes through.

A move changes the count by `(z's neighbours in A) − (z's neighbours in B)`,
which reads as you would want: move to where more of your neighbours already
are. Branch moves need the edges *inside* the moving set excluded, since those
never change status. Unlike the demographic terms', σ does not depend on N — the
delta is purely local.

At the default weight of 1, measured at N=18 across Omagh, Enniskillen,
Ballymena, Coleraine, Armagh and Newry: those six towns span **9 regions with
the term off and 7 with it on**, and the cut count falls from 1,883 to 541. It
costs population equality — max deviation 0.81% → 2.79% — necessarily so, since
keeping a town whole means declining the move that would have balanced the
populations.

> **This term's σ is calibrated, not derived**, and it is the one place the
> "one move's worth" convention is knowingly broken. The per-move size is
> `meanDegree / 3`, but that is the wrong yardstick: every other term can be
> shifted by a single well-chosen move, whereas the cut count is structural and
> moving a town out of a region takes a long run of consecutive moves against
> population pressure. Normalising by per-move size made weight 1 do almost
> nothing. It is `meanDegree / 24` instead — 8× stronger — so that 1 is a
> setting worth using. The consequence is that its per-move delta is the largest
> of them all, and the σ-calibration test's spread widens from about 5× to 12×
> against a 40× limit. The limit is that loose because the other end is
> deliberate too: gerrymander mode is *meant* to be flat away from its threshold
> — that flatness is what produces cracking — so measuring it over all moves
> understates it by about 2× against the same term in average mode.

It is also partly a compactness measure, so it overlaps with land shape. Expect
to want the land weight lower once this is turned up.

All five weight sliders are logarithmic, running 0.1 to 10 with **1 in the
middle** — the slider carries log₁₀ of the weight. The two shape terms have one
extra detent at the left that reads *off*; population does not, since with every
weight at zero there would be nothing anchoring the regions to equal population.
The penalties are still *measured* at weight 0 — about twenty flops per move —
so the readout shows what the shapes are even when they aren't being steered.
At N=18 over 50,000 moves:

| weights | land | people |
|---|---|---|
| neither | 2.073 | 1.918 |
| land only | 1.245 | 1.311 |
| people only | 1.587 | 1.114 |
| **both** | **1.204** | **0.995** |

The last row is the point: together they beat either alone *on both measures*,
which is not something you would get from two terms pulling against each other.

**Temperature and shape weight are both live**, read every frame rather than
captured at GO, so you can steer a run while watching it. They differ in one
way that matters: temperature only affects the acceptance rule, so the score and
best-so-far keep meaning what they meant. The shape weight is part of the score,
so changing it is a change of objective — the model discards the old best and
re-bases it on the current state, otherwise STOP would restore a "best" scored
under a weight you are no longer using.

**Build phase.** Seeds are chosen by farthest-point sampling, because purely
random seeds clump and a region boxed in early can never recover — nothing is
ever stolen during the build. Then repeatedly: take the lowest-population region
that still borders an unassigned zone, and give it the neighbour that most
improves the score. Because the DZ graph is one connected component, some region
always borders an unassigned zone, so this always finishes.

Every 25 steps it also **seals pockets**: any connected group of unassigned zones
bordered by exactly one region is handed to that region whole. This is forced
rather than clever — a zone can only be claimed by a region already bordering it,
and nothing is stolen during the build, so no second region can ever reach such a
group. Until it is handed over the region looks smaller than it really is, so the
build keeps feeding it while it is already committed to the pocket and it
over-claims on its far side. It fires a lot — around 1,400 of 3,780 zones at
N=18 — improving the build score in 10 of 12 (N, seed) combinations tried,
sometimes by 2–3×, and finishing the build in ~2,350 steps instead of ~3,760.
`__model.sweepInterval = Infinity` turns it off.

**Optimisation phase.** Sample a zone on a region boundary, then reassign it
among its neighbouring regions weighted by `exp(-delta / T)`.

If removing the zone would split its region in two, **branch moves** (a checkbox,
on by default) let it go anyway, taking the smaller piece with it. That set is
the unique smallest one whose departure leaves the region whole: every piece cut
off by removing the zone must touch that zone, and the zone touches the
destination, so both regions stay contiguous for free. Three-way splits keep the
largest piece. There is no size cap — a big branch wrecks population equality, so
its delta is large and the temperature suppresses it without a blunt threshold.
The set's totals are computed once and shared across candidate destinations, so
each candidate's delta stays O(1) however big the branch. Turning it off restores
the plain single-zone rule.

**Recombination** is the large move. Every so often — **Flips per ReCom**, default
200 — instead of nudging one zone it takes two adjacent regions, merges them,
draws a random spanning tree over the union and cuts a single edge of it. A tree
splits into exactly two pieces when any edge is removed, and every tree edge is a
real adjacency edge, so **both pieces are connected in the graph: contiguity is
structural here rather than checked.**

Every one of the `|U| − 1` possible cuts is scored on every term, not filtered
down first. One backward pass over the tree gives each cut's totals, because
population, area, the moment sums and the demographic sums are all additive.
Cut edges is not a subtree sum but is still exact, via the handshake lemma —
`edges leaving S = (induced degrees in S) − 2 × (edges inside S)` — with the
second half obtained by counting each induced edge at its LCA, since an edge lies
inside `subtree(x)` exactly when `x` is an ancestor of that LCA.

Two details that matter more than they look. **The existing boundary is entered
as a candidate with delta 0**, because a random tree will not generally contain
an edge reproducing it — that makes it the reference the cuts are judged against,
means a step never forces a change when the status quo is best, and removes any
need for retry logic. And **which piece keeps which region number is decided by
population overlap**; without that, half of all steps would swap two regions'
colours at random and the map would strobe.

A recombination costs roughly fifty flips, so the rate is a real trade. Measured
over an equal two seconds at N=18 seed 7, best score came out 260 with none, 230
every 2,000, 187 every 500, 181 every 100 and 174 every 25, while throughput fell
from 147k steps/sec to 84k. 200 is where the return flattens off. At equal *step*
counts the gain is larger still: 322 on flips alone against 208 with
recombination after 50,000 steps. Straight after the build, regions differ by tens of
thousands of people, so normalised deltas reach several hundred — the softmax
subtracts the minimum before exponentiating, or it overflows immediately. A
pleasant side effect is that the phase starts nearly greedy and becomes genuinely
stochastic as it converges. `T` is held fixed rather than annealed, so the current
score plateaus and jitters while the best-so-far keeps improving; **STOP** restores
the best state visited, which is not the state it happened to stop in.

> **Two things worth knowing before reading the numbers.** The build phase on its
> own leaves a wide spread — around 60% max deviation at N=18 — because boxed-in
> regions stop growing. Closing that is the optimisation phase's job, and it
> typically gets under 1% within a couple of hundred thousand steps.
>
> Occasionally two regions come out of the build as a **sealed pocket**: they
> border only each other and one other region, every one of whose adjacent zones
> is an articulation point, so nothing can legally cross without splitting
> something. `N=18 seed 7` is such a case and is kept in the test suite. It is a
> narrow channel rather than a dead end — it escapes around 1.4M steps and lands
> near 0.5% — but it is the clearest illustration of why single-zone moves alone
> are limited. Swap moves are the standard fix, and are deferred.

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
DOM. `window.__map` is exposed as a console handle, with `window.__graph` and
`window.__model` beside it. The graph loads off the critical path — nothing on screen depends on it, so a
failure to fetch it warns to the console and leaves the map working.

### Demographics and Election modes

The switch at the top of the left panel chooses what the run is steered by.

* **Demographics** is the original map: religion, age, orientation and social
  grade, each with a weight and an average / extreme / gerrymander mode.
* **Election** replaces those blocks with one party block — a party selector
  and the same weight, mode and gerrymander controls — and draws seats. Its own
  controls sit above Regions: **Election type** (first past the post or STV)
  and, for STV, **Elected/Region**, which has no upper limit — one region
  electing everybody is roughly a national list, and Regions goes down to 1 for
  exactly that.

Regions is fixed for the life of a run, since changing it means a different
map; the election controls stay live, so a paused or stopped map can be
re-counted under other rules.

### One region's election

The results panel switches between **Overall** and **Region**. Region shows a
single region's election in detail, and the map picks it: click any zone while
that view is open. The choice is remembered for the run and starts at region 1.

* **First past the post:** the region's votes as a pie, hover for each party's
  votes and share.
* **STV:** one bar per stage of the count, parties always in the same order. A
  party's block is what it holds at that point — the quotas it has already
  spent on seats, plus whatever is still live — so seats stay in the chart
  rather than vanishing. Exhausted ballots make up the hatched grey tail, which
  is why every bar is the same width. Hovering a block gives that party's
  votes, share and seats so far; the line above gives the final seats and the
  quota.

A party can be excluded after winning a seat: at party level its leftover pile
is what remains once a quota is spent, and that pile can be the smallest left
in the count.

The hidden mode's terms are switched off rather than left steering unseen, and
the results panel, the statistic selector and the tooltip all show only the
active mode's figures. The bars show a party's votes per region and mark the
regions it wins — with the seat count alongside when a region returns several
— a pie gives the seats every party took (hover a wedge to name it), and the
tooltip lists a region's top five parties with the selected one highlighted.

Gerrymander mode differs for a party, and differs again by election type.
Under first past the post the threshold is a **winning margin**, the party's
share minus the strongest rival's, because that is what takes the seat; zero
means "just wins". Under STV there is nothing to put a threshold on — the aim
is as many seats as possible — so the score is

    seat bonus × seats won + leftover votes ÷ quota

from the simulated count, and the controls become a **seat bonus** (how much a
seat outweighs vote-building, default 2) and a direction: win seats, or deny
them. Average and extreme modes work on the party's share in both.

The STV count itself is party-level — no candidates, no rankings — using the
transfer matrix and each party's exhaustion rate. It gets 95% of the seats
right across 91 real contests; see
[docs/voting-model.md](docs/voting-model.md#the-stv-count).

Election mode needs `web/data/dz_voters.json`, built by
`scripts/build_app_voters.py` from the voting model's estimates
([docs/voting-model.md](docs/voting-model.md)) and produced by `./run.sh`. It
holds each Data Zone's electorate and the nine parties' voter shares; votes are
those shares times the electorate times a flat 57.2% turnout, the NI-wide
figure at the 2024 Westminster election. Without the file the app runs exactly
as before and the Election button stays disabled.

In the model the parties are ordinary score terms (`regions.js`), so a party's
votes in a region are its term's own running sum and every party shares one
denominator. `scripts/test_regions.mjs` checks the margin term against a
from-scratch recompute after the optimiser has churned.

## Verification

```bash
python3 scripts/verify_build.py      # map data assertions
python3 scripts/verify_adjacency.py  # graph assertions
node scripts/test_regions.mjs        # region algorithm, headless, ~12s
./scripts/smoke_test.sh              # headless render + hover, needs run.sh serving
```

`test_regions.mjs` drives `web/regions.js` against the real data and asserts that
every zone ends assigned, that **every region is contiguous** after the build and
after 50,000 moves, that the incrementally-maintained frontier set matches a
from-scratch recompute, that the incremental score matches a full rescore, that a
seed reproduces its map exactly, and that optimisation cuts the score by more
than 5x at N = 4, 18, 50 and 100.

`verify_build.py` checks 3,780 features, unique codes matching the source, all
rings closed and ≥4 points, and that populations sum to 1,903,168.

`verify_adjacency.py` checks the graph is symmetric and loop-free, has one
connected component and no isolated zone, that the three crossings resolve to the
declared names, and — the check that ties the two artifacts together — that
**simplification lost no shared border**. It gains three: writing at
`precision=0.00001` (~0.65 m) snaps vertices together and promotes three
full-resolution point touches into shared segments. Each is verified to be
exactly that, so the number is a bound on a known artifact rather than a fudge.

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

## Voting modelling assumptions

Some candidates stand under a label that does not reflect who they actually
represent. Where that materially distorts party totals, this project counts
them as the party they function as, rather than the one on the ballot paper.

These are **modelling choices, not data corrections**, so they are applied
visibly and never destructively:

* the returning officer's own wording is always preserved verbatim — in
  `description` for 2024, `party_raw` for 2023;
* the label actually printed on the ballot is kept in `party_as_declared`;
* every candidate carries `party_source`, so any assumption can be found,
  audited, or reversed:

| `party_source` | meaning |
|---|---|
| `source` | the party as declared on the ballot paper |
| `assumed` | reassigned by an assumption below; declared label kept in `party_as_declared` |
| `manual` | the sheet gave no party at all and one was assigned by hand |

Every assumption also appears in the output: as a `flags` entry in the 2023
JSON, and as `party_source: "assumed"` in both. Reversing one is a one-line
edit — remove the entry from `ALIGNED` in `scripts/build_pc24_results.py`
(2024) or `scripts/parse_council_2023.py` (2023) and re-run that script.

### The test applied

**"What single party would this person's voters strongly tend to vote for at
Westminster level, if any?"** Council data exists here to be extrapolated
upward, so the question is about where a candidate's support would go in a
two-party-ish parliamentary contest, not about the candidate's own history. An
independent with no such tendency stays Independent.

### Current assumptions

| Election | Candidate | DEA / constituency | Votes | Counted as |
|---|---|---|---:|---|
| 2024 Westminster | EASTON, ALEX | North Down | 20,913 | **DUP** |
| 2022 Assembly | EASTON, Alex | North Down | 9,568 | **DUP** |
| 2022 Assembly | SUGDEN, Claire Elizabeth | East Londonderry | 3,981 | **UUP** |
| 2022 Assembly | QUIGLEY, Stephanie | East Londonderry | 1,503 | **SDLP** |
| 2023 council | BERRY, Paul | Cusher | 2,059 | **DUP** |
| 2023 council | Donnelly, Gary | The Moor | 1,868 | **Sinn Féin** |
| 2023 council | McCusker, Paul | Oldpark | 1,747 | **SDLP** |
| 2023 council | IRVINE, Steven Gary | Newtownards | 1,463 | **DUP** |
| 2023 council | IRVINE, Wesley Graham | Bangor Central | 1,369 | **DUP** |
| 2023 council | MONTEITH, Barry | Dungannon | 1,180 | **Sinn Féin** |
| 2023 council | McQUILLAN, Adrian | Bann | 701 | **DUP** |

Alex Easton was elected in 2024; the 2023 dataset does not record who won a
seat, so no such claim is made for the council seven -- six of them polled
between 86% and 152% of their DEA quota on first preferences, and McQuillan 53%.

**Alex Easton, North Down** (2024). Elected as an Independent with 20,913 votes
(48.30%). North Down is the only one of the 18 constituencies where *neither*
the DUP nor the TUV stood, leaving him the de facto unionist standard-bearer
against a single UUP challenger; he is also a former DUP MLA. Counting him as
Independent understates the DUP by 2.7 points across NI and hands the
Independent column a seat and 88.6% of its vote from one person. He stood as an
Independent in 2022 as well, taking 9,568 first preferences (138% of quota, the
only independent in that election to reach one), and is counted the same way.

**The seven 2023 council independents** are the cases where the test above has
a clear answer. Their effect on the NI-wide 2023 first preferences:

| | as declared | as modelled |
|---|---|---|
| Sinn Féin | 230,793 (30.96%) | 233,841 (31.37%) |
| DUP | 173,033 (23.21%) | 178,625 (23.96%) |
| SDLP | 64,996 (8.72%) | 66,743 (8.95%) |
| Independent | 34,396 (4.61%) | 24,009 (3.22%) |

The 2024 effect: Independent 23,602 (3.03%, 1 seat) becomes 2,689 (0.34%, 0
seats); DUP 172,058 (22.06%, 5 seats) becomes 192,971 (24.75%, 6 seats). The
2022 effect: Independent 25,315 (2.93%) becomes 10,263 (1.19%); DUP 21.33% ->
22.44%, UUP 11.17% -> 11.63%, SDLP 9.07% -> 9.24%.

### Deliberately not assumed

The remaining eight 2024 Independents total 2,689 votes, none above 0.66% in
its own seat, so no assumption about them would move anything meaningful.

The other **49 council independents (24,009 votes, 3.22%)** are left as
Independent by explicit decision, not by omission. The 19 largest were reviewed
individually; the twelve not listed above have no single party their voters
would strongly tend toward, several being prominent precisely for being
non-party. The unreviewed tail is 37 candidates, none above 53% of a DEA quota.

The other **21 Assembly independents (10,263 votes, 1.19%)** are a weaker
statement: only the three largest were reviewed, and the rest were **not
examined individually**. None of them reached even a quarter of a quota, the
largest being Gavin Malone (Newry and Armagh, 3,157, 32% of quota) -- so the
exposure is small, but this is an unfinished sweep rather than a set of
decisions.

Note that the 2023 council independent vote is structurally unlike 2024's. At
Westminster one candidate was 88.6% of the entire independent vote; at council
level the largest is 5.4%, spread over 39 of the 80 DEAs, so there is no single
decisive call and the residual 3.22% is genuine independent voting rather than
one unresolved case.

Sperrin's `Barr, Raymond` and `Gallagher, Paul` are a separate matter: EONI's
workbook gives them no party at all, so they are `manual`, not `assumed`. That
fills a blank rather than reassigning a declared label.

## Voting model

Work towards a voting mode (party voters per Data Zone, simulated elections in
drawn constituencies) is documented in
[`docs/voting-model.md`](docs/voting-model.md): the demographic prior, its
uncertainty, the transfer matrix built from STV transfers, the fit of all three
elections into voter shares per DZ, the evidence behind each choice, and the
questions still open.
Outputs are in `data/model/`; the scripts need `pip install -r requirements.txt`.

## Data

| File | Contents |
|---|---|
| `data/DZ2021.geojson` | 3,780 Data Zones (NISRA, 2021) |
| `data/SDZ2021.geojson` | 850 Super Data Zones — parent tier, unused so far |
| `data/ni-census21-people-dz21-*.json` | population per DZ |
| `data/ni-census21-...religion...json` | religion per DZ × 4 categories |
| `data/ni-census21-...age_syoa...json` | single year of age per DZ × 101 categories |
| `data/ni-census21-...sexual_orientation...json` | sexual orientation per DZ × 4 categories |
| `data/ni-census21-...social_grade...json` | social grade per DZ × 5 categories |
| `data/ni-census21-...nat_id_basic...json` | national identity per DZ × 8 categories |
| `data/ni-census21-...sdz21+religion_belong_to_dvo_1000...json` | detailed religion per SDZ × 32 categories |
| `data/model/` | voting model features and prior outputs ([docs](docs/voting-model.md)) |

Hierarchy is a clean tree: DZ → SDZ → DEA → LGD. Source `.geojson` files are
gitignored (large); the census JSON is small enough to keep.
