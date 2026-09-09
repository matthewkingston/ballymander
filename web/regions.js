/* Growing N regions of roughly equal population out of Data Zones.
 *
 * Deliberately free of DOM and MapLibre: everything here is pure state plus
 * step functions, so the whole algorithm can be driven headlessly under node
 * against the real data (scripts/test_regions.mjs). app.js owns the animation,
 * the rendering and the controls.
 *
 * Two phases, per major_checkpoint_1.txt:
 *   buildStep()     grow seeds until every zone is assigned
 *   optimiseStep()  move single zones between regions, favouring lower score
 *
 * The score is normalised so later terms (equal mean age, say) can be added as
 * a weighted sum without re-tuning anything around them:
 *
 *   score       = SUM_r (pop_r - target)^2 / E[d^2]
 *   build delta = d * (d + 2*(pop_r - target)) / E[d^2]   assign unassigned d to r
 *   move delta  = 2d * (d + pop_B - pop_A)    / E[d^2]    move d out of A into B
 *
 * E[d^2] is the mean squared DZ population, so one typical move shifts the
 * score by about 2 whatever N is, and the temperature is a plain number near 1.
 */
'use strict';

/* --- prng ---------------------------------------------------------------- */

/* mulberry32: small, fast, and seedable, so a run is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --- geometry ------------------------------------------------------------ */

/* How far a boundary zone's religion value typically sits from its own
 * region's. The rms difference between adjacent zones is 0.176 and the
 * pop-weighted SD across NI is 0.301, so 0.2 is a fair round figure. It only
 * sets the scale of a slider whose default is arbitrary. */
const V_SPREAD = 0.2;

/* How far regional religion values typically sit from the national one. Not the
 * same thing as V_SPREAD, and not something the optimiser can shrink to nothing:
 * NI's segregation is coarse enough that regions stay this far apart whatever
 * the boundaries. Measured at 0.153 across N=18 with the term switched off. */
const R_SPREAD = 0.15;

const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((54.65 * Math.PI) / 180);

/* Area-weighted centroid of one GeoJSON feature, in projected metres.
 *
 * Ring 0 of each part is the outer ring and the rest are holes, so holes are
 * subtracted by sign rather than by trusting the winding order. The shoelace
 * area here is only used to weight the parts against each other -- the area
 * that goes into the moment comes from the `area_ha` property, which is
 * measured on the full-resolution boundaries. */
function featureCentroid(feature) {
  const g = feature.geometry;
  const parts = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  let wTotal = 0;
  let wx = 0;
  let wy = 0;
  let fallbackX = 0;
  let fallbackY = 0;
  let fallbackN = 0;

  for (const poly of parts) {
    for (let ring = 0; ring < poly.length; ring++) {
      const pts = poly[ring];
      let twiceArea = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const x1 = pts[i][0] * M_PER_DEG_LON;
        const y1 = pts[i][1] * M_PER_DEG_LAT;
        const x2 = pts[i + 1][0] * M_PER_DEG_LON;
        const y2 = pts[i + 1][1] * M_PER_DEG_LAT;
        const cross = x1 * y2 - x2 * y1;
        twiceArea += cross;
        cx += (x1 + x2) * cross;
        cy += (y1 + y2) * cross;
        if (ring === 0) { fallbackX += x1; fallbackY += y1; fallbackN++; }
      }
      if (twiceArea === 0) continue;
      const area = Math.abs(twiceArea / 2) * (ring === 0 ? 1 : -1);
      wTotal += area;
      wx += area * (cx / (3 * twiceArea));
      wy += area * (cy / (3 * twiceArea));
    }
  }

  if (wTotal === 0) {   // degenerate ring: fall back to the mean vertex
    return fallbackN ? { x: fallbackX / fallbackN, y: fallbackY / fallbackN }
                     : { x: 0, y: 0 };
  }
  return { x: wx / wTotal, y: wy / wTotal };
}

/* { code: {x, y, area} } for every zone, in metres, with the origin moved to
 * the centre of the data.
 *
 * The origin shift is not cosmetic. The moment identity below is a small
 * difference of large numbers, and in raw projected metres the two terms agree
 * to about four significant figures, which throws away most of the mantissa. */
function zoneGeometry(features) {
  const raw = features.map((f) => ({
    code: f.properties.code,
    ...featureCentroid(f),
    area: (f.properties.area_ha || 0) * 1e4,   // hectares -> square metres
  }));
  const ox = raw.reduce((a, z) => a + z.x, 0) / raw.length;
  const oy = raw.reduce((a, z) => a + z.y, 0) / raw.length;
  const out = {};
  for (const z of raw) out[z.code] = { x: z.x - ox, y: z.y - oy, area: z.area };
  return out;
}

/* { code: {value, n} } for every zone: the religion index and the count it was
 * averaged over.
 *
 * `rel` runs 0 (all Protestant) to 1 (all Catholic), with the unaligned at 0.5
 * on the assumption that in a two-way contest they split evenly. The weighting
 * is applied in scripts/prepare_attributes.py, so changing it means a rebuild.
 *
 * `rel_n` rather than `pop` is the denominator to aggregate by: NISRA's
 * disclosure control perturbs the two tables independently, leaving them
 * differing in about a third of zones by a handful of people each. */
function zoneReligion(features) {
  const out = {};
  for (const f of features) {
    const p = f.properties;
    if (typeof p.rel !== 'number' || typeof p.rel_n !== 'number') return null;
    out[p.code] = { value: p.rel, n: p.rel_n };
  }
  return out;
}

/* --- model --------------------------------------------------------------- */

class RegionModel {
  /* graph: a DZGraph. popByCode / geomByCode: keyed by zone code, the latter
   * from zoneGeometry(). Geometry is optional -- without it the shape term is
   * unavailable and its weight is forced to zero. */
  constructor(graph, popByCode, geomByCode = null, relByCode = null) {
    this.codes = [...graph.zones].sort();
    this.n = this.codes.length;
    this.index = new Map(this.codes.map((code, i) => [code, i]));
    this.nbr = this.codes.map((code) =>
      graph.neighbours(code).map((other) => this.index.get(other)));
    this.meanDegree = this.nbr.reduce((a, list) => a + list.length, 0) / this.n;

    this.pop = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) this.pop[i] = popByCode[this.codes[i]] || 0;
    this.totalPop = this.pop.reduce((a, b) => a + b, 0);
    this.meanPop = this.totalPop / this.n;
    // sigma^2 for the population term: the scale of one typical move.
    this.eD2 = this.pop.reduce((a, b) => a + b * b, 0) / this.n;

    // Zone geometry for the shape term: centroid, area, and the zone's own
    // moment taken as a disc of equal area (see _penaltyFrom).
    this.hasGeometry = Boolean(geomByCode);
    this.zx = new Float64Array(this.n);
    this.zy = new Float64Array(this.n);
    this.za = new Float64Array(this.n);
    this.zOwn = new Float64Array(this.n);
    if (this.hasGeometry) {
      for (let i = 0; i < this.n; i++) {
        const g = geomByCode[this.codes[i]] || { x: 0, y: 0, area: 0 };
        this.zx[i] = g.x;
        this.zy[i] = g.y;
        this.za[i] = g.area;
        this.zOwn[i] = (g.area * g.area) / (2 * Math.PI);
      }
    }
    this.totalArea = this.za.reduce((a, b) => a + b, 0);
    this.meanArea = this.totalArea / this.n;

    // Religion: the index per zone and the count it was averaged over.
    this.hasReligion = Boolean(relByCode);
    this.zRel = new Float64Array(this.n);
    this.zRelN = new Float64Array(this.n);
    if (this.hasReligion) {
      for (let i = 0; i < this.n; i++) {
        const r = relByCode[this.codes[i]] || { value: 0, n: 0 };
        this.zRel[i] = r.value;
        this.zRelN[i] = r.n;
      }
    }
    let relSum = 0;
    let relN = 0;
    for (let i = 0; i < this.n; i++) {
      relSum += this.zRel[i] * this.zRelN[i];
      relN += this.zRelN[i];
    }
    this.relMean = relN ? relSum / relN : 0;   // the national value, 0.5111

    this.assign = new Int32Array(this.n);
    this.bestAssign = new Int32Array(this.n);
    this._seen = new Int32Array(this.n);   // BFS marks, stamped rather than cleared
    this._stamp = 0;

    // When a zone is an articulation point of its region, taking it alone
    // would split the region in two. With this on, the smaller piece goes with
    // it instead of the move being rejected. Like sweepInterval, a knob rather
    // than run state, so it survives start().
    this.allowBranchMoves = true;
    this._single = [0];   // scratch, so a plain move allocates nothing
    this._cutMap = new Map();   // scratch: region -> edges leaving the moving set

    // Recombination scratch, allocated once at capacity rather than per step.
    // A step touches ~420 zones and ~1,200 induced edges at N=18, and runs
    // often enough that allocating this each time would be pure GC churn.
    const halfEdges = this.nbr.reduce((a, list) => a + list.length, 0);
    const edgeCap = (halfEdges >> 1) + 1;
    this._members = [];
    this._local = new Int32Array(this.n);
    this._uf = new Int32Array(this.n);
    this._parent = new Int32Array(this.n);
    this._depth = new Int32Array(this.n);
    this._order = new Int32Array(this.n);
    this._tin = new Int32Array(this.n);
    this._tout = new Int32Array(this.n);
    this._head = new Int32Array(this.n);
    this._stack = new Int32Array(this.n);
    this._sz = new Int32Array(this.n);
    this._eu = new Int32Array(edgeCap);
    this._ev = new Int32Array(edgeCap);
    this._eord = new Int32Array(edgeCap);
    this._nxt = new Int32Array(halfEdges);
    this._to = new Int32Array(halfEdges);
    const sums = () => new Float64Array(this.n);
    this._sPop = sums(); this._sArea = sums(); this._sAx = sums(); this._sAy = sums();
    this._sAxx = sums(); this._sOwn = sums(); this._sPx = sums(); this._sPy = sums();
    this._sPxx = sums(); this._sRelS = sums(); this._sRelN = sums();
    this._sDeg = sums(); this._sInt = sums();

    // Flips between recombinations. Like sweepInterval, a knob rather than run
    // state, so it survives start(). Infinity turns recombination off.
    //
    // 200 is where the return flattens off. A recombination costs roughly fifty
    // flips, so this is a real trade: measured over an equal two seconds at
    // N=18 seed 7, best score came out 260 with none, 230 every 2,000, 187
    // every 500, 181 every 100 and 174 every 25 -- while throughput fell from
    // 147k steps/sec to 84k at the far end.
    this.recomInterval = 200;
    this._agg = {
      area: 0, ax: 0, ay: 0, axx: 0, own: 0, pop: 0, px: 0, py: 0, pxx: 0,
      relSum: 0, relN: 0,
    };

    // Build steps between pocket sweeps. A sweep is one pass over the
    // unassigned zones, so this is about taste rather than cost. Set to
    // Infinity to turn sealing off. Deliberately not in reset(): it is a
    // tuning knob, not run state, and must survive start().
    this.sweepInterval = 25;

    this.reset();
  }

  reset() {
    this.assign.fill(-1);
    this.N = 0;
    this.target = 0;
    this.temperature = 1;
    this.assigned = 0;
    this.regionPop = new Float64Array(0);
    this.regionSize = new Int32Array(0);
    this.openNbrs = [];        // per region: unassigned neighbours, build phase
    this.frontier = [];        // zones with a neighbour in another region
    this.frontierPos = new Int32Array(this.n).fill(-1);
    this.rawScore = 0;
    this.shapeRaw = 0;        // SUM_r (land penalty_r - 1)
    this.popShapeRaw = 0;     // SUM_r (people penalty_r - 1)
    this.cutRaw = 0;          // edges whose two zones ended in different regions
    this.relRaw = 0;          // SUM_r of the religion term, already signed
    this.wPop = 1;
    this.wShape = 0;
    this.wPopShape = 0;
    this.wRel = 0;
    this.wCut = 0;
    this.sigmaCut = 1;
    this.weightSum = 1;
    this.relMode = 'off';     // off | average | extreme | gerrymander
    this.relThreshold = 0.6;
    this.relSteepness = 0.05;
    this.relAbove = true;
    this.sigmaRel = 1;
    this.sigmaShape = 1;
    this.sigmaPopShape = 1;
    this.rArea = new Float64Array(0);
    this.rSx = new Float64Array(0);
    this.rSy = new Float64Array(0);
    this.rSxx = new Float64Array(0);
    this.rOwn = new Float64Array(0);
    this.rPx = new Float64Array(0);
    this.rPy = new Float64Array(0);
    this.rPxx = new Float64Array(0);
    this.rRelSum = new Float64Array(0);
    this.rRelN = new Float64Array(0);
    this.bestScore = Infinity;
    this.steps = 0;
    this.moves = 0;
    this.sweepCounter = 0;
    this.sealed = 0;
    this.branched = 0;
    this.recomCounter = 0;
    this.recombinations = 0;
  }

  /* Seed N regions and prepare the build phase. */
  start(N, seed, opts = {}) {
    const {
      temperature = 1, wPop = 1, wShape = 0, wPopShape = 0, wRel = 0,
      relMode = 'off', relThreshold = 0.6, relSteepness = 0.05, relAbove = true,
      wCut = 0,
    } = opts;
    this.reset();
    this.N = N;
    this.target = this.totalPop / N;
    this.temperature = temperature;
    this.relMode = this.hasReligion ? relMode : 'off';
    this.relThreshold = relThreshold;
    this.relSteepness = relSteepness;
    this.relAbove = relAbove;
    this.wPop = Math.max(0, wPop);
    this.wShape = this.hasGeometry ? Math.max(0, wShape) : 0;
    this.wPopShape = this.hasGeometry ? Math.max(0, wPopShape) : 0;
    this.wRel = this.relMode === 'off' ? 0 : Math.max(0, wRel);
    this.wCut = Math.max(0, wCut);
    // A move changes the cut count by the difference between a zone's
    // neighbour counts in two regions, which depends on local degree and not
    // on N at all -- so unlike the religion term this scale is fixed with N.
    //
    // meanDegree/3 is the per-move size, but that is the wrong yardstick here.
    // Every other term can be shifted by a single well-chosen move; the cut
    // count is structural, and moving a town out of one region takes a long
    // run of consecutive moves against population pressure. Calibrated by what
    // actually works instead, which is 8x stronger, so weight 1 is a setting
    // worth using rather than one that does almost nothing.
    this.sigmaCut = this.meanDegree / 24;
    this.weightSum = this.wPop + this.wShape + this.wPopShape + this.wRel
      + this.wCut || 1;
    this.sigmaRel = this._sigmaRel(N);
    // One move shifts a region's land penalty by about (zone area / region
    // area) and its people penalty by about (zone pop / region pop); see the
    // derivations in major_checkpoint_1.txt. Both reduce to N/n here, but they
    // are written out so they stay right if the data changes. Unlike the
    // population-equality term these depend on N.
    this.sigmaShape = (this.meanArea * N) / (this.totalArea || 1);
    this.sigmaPopShape = (this.meanPop * N) / (this.totalPop || 1);
    this.rng = mulberry32(seed);
    this.regionPop = new Float64Array(N);
    this.regionSize = new Int32Array(N);
    this.rArea = new Float64Array(N);
    this.rSx = new Float64Array(N);
    this.rSy = new Float64Array(N);
    this.rSxx = new Float64Array(N);
    this.rOwn = new Float64Array(N);
    this.rPx = new Float64Array(N);
    this.rPy = new Float64Array(N);
    this.rPxx = new Float64Array(N);
    this.rRelSum = new Float64Array(N);
    this.rRelN = new Float64Array(N);
    this.openNbrs = Array.from({ length: N }, () => new Set());

    const seeds = this._farthestPointSeeds(N);
    for (let r = 0; r < N; r++) this._place(seeds[r], r);
    // Open sets can only be filled once every seed is down, or an early seed
    // would claim a zone that a later seed sits on.
    for (let r = 0; r < N; r++) {
      for (const w of this.nbr[seeds[r]]) if (this.assign[w] < 0) this.openNbrs[r].add(w);
    }
    this._rescore();
    return seeds.map((z) => this.codes[z]);
  }

  /* Pick seeds far apart: purely random seeds clump, and a region boxed in
   * early can never recover during the build, since nothing is ever stolen. */
  _farthestPointSeeds(N) {
    const dist = new Float64Array(this.n).fill(Infinity);
    const seeds = [(this.rng() * this.n) | 0];
    this._spreadFrom(seeds[0], dist);
    while (seeds.length < N) {
      let best = 0;
      for (let i = 1; i < this.n; i++) if (dist[i] > dist[best]) best = i;
      seeds.push(best);
      this._spreadFrom(best, dist);
    }
    return seeds;
  }

  /* BFS from src, lowering dist[] to the distance to the nearest seed so far. */
  _spreadFrom(src, dist) {
    const stamp = ++this._stamp;
    this._seen[src] = stamp;
    let frontier = [src];
    let d = 0;
    while (frontier.length) {
      for (const z of frontier) if (d < dist[z]) dist[z] = d;
      const next = [];
      for (const z of frontier) {
        for (const w of this.nbr[z]) {
          if (this._seen[w] !== stamp) { this._seen[w] = stamp; next.push(w); }
        }
      }
      frontier = next;
      d++;
    }
  }

  /* --- religion ---------------------------------------------------------- */

  /* One move shifts a region's religion value by about
   *   (zone n / region n) * (zone value - region value)  =  V_SPREAD * N / n
   * The value is intensive -- a ratio, not a sum -- so unlike the population
   * term this scales with N. Closed form, nothing measured at runtime. */
  _sigmaRel(N) {
    const delta = (V_SPREAD * N) / this.n;
    if (this.relMode === 'gerrymander') {
      // The logistic's steepest slope, at the threshold, is 1/(4s).
      return delta / (4 * Math.max(1e-6, this.relSteepness));
    }
    // (x - mu)^2 changes by 2|x - mu| * delta, so the scale is set by how far
    // regions actually sit from the mean -- NOT by delta itself.
    //
    // Getting this wrong is worth a comment. The population term's deviation
    // does settle at one move's worth, because the optimiser can drive it
    // there. Religion cannot be driven that close: geography holds regional
    // values ~0.15 apart however the lines are drawn. Using delta^2 here made
    // the term 123x too strong, which at equal weights swamped everything else
    // -- max population deviation went from 1.4% to 33%.
    return 2 * R_SPREAD * delta;
  }

  /* The term for one region value, already signed so lower is better in every
   * mode. Extreme is average negated: one minimises the variance of regional
   * values, the other maximises it. */
  _relTermFrom(x) {
    if (this.relMode === 'gerrymander') {
      const s = Math.max(1e-6, this.relSteepness);
      // Saturates above the threshold, still pulls below it, steepest at it.
      // exp() overflowing to Infinity gives 0 here, which is the right limit.
      const u = this.relAbove
        ? (x - this.relThreshold) / s
        : (this.relThreshold - x) / s;
      return 1 / (1 + Math.exp(u));
    }
    const d = x - this.relMean;
    if (this.relMode === 'average') return d * d;
    if (this.relMode === 'extreme') return -d * d;
    return 0;
  }

  _relValue(r) {
    return this.rRelN[r] ? this.rRelSum[r] / this.rRelN[r] : this.relMean;
  }

  _relTerm(r) { return this._relTermFrom(this._relValue(r)); }

  _relTermWith(r, z, sign) {
    const n = this.rRelN[r] + sign * this.zRelN[z];
    if (n <= 0) return this._relTermFrom(this.relMean);
    return this._relTermFrom(
      (this.rRelSum[r] + sign * this.zRel[z] * this.zRelN[z]) / n);
  }

  _relTermWithAgg(r, g, sign) {
    const n = this.rRelN[r] + sign * g.relN;
    if (n <= 0) return this._relTermFrom(this.relMean);
    return this._relTermFrom((this.rRelSum[r] + sign * g.relSum) / n);
  }

  /* --- shape ------------------------------------------------------------- */

  /* Compactness as a moment of inertia about the region's own centroid,
   * normalised so a disc scores exactly 1 and anything worse scores higher.
   * A square is 1.047, a 4:1 rectangle 2.22.
   *
   * `own` is the sum of each zone's own moment, taken as a disc of equal area.
   * Without it a one-zone region has zero moment and scores 0 -- better than a
   * disc -- which would bias the build towards keeping regions small. It
   * decays as 1/k, so it stops mattering once a region has real extent. */
  _penaltyFrom(A, Sx, Sy, Sxx, own) {
    if (A <= 0) return 1;
    const I = Sxx - (Sx * Sx + Sy * Sy) / A + own;
    return (2 * Math.PI * I) / (A * A);
  }

  _penalty(r) {
    return this._penaltyFrom(this.rArea[r], this.rSx[r], this.rSy[r],
      this.rSxx[r], this.rOwn[r]);
  }

  /* What the penalty would be with zone z added (sign +1) or removed (-1). */
  _penaltyWith(r, z, sign) {
    const a = sign * this.za[z];
    return this._penaltyFrom(
      this.rArea[r] + a,
      this.rSx[r] + a * this.zx[z],
      this.rSy[r] + a * this.zy[z],
      this.rSxx[r] + a * (this.zx[z] * this.zx[z] + this.zy[z] * this.zy[z]),
      this.rOwn[r] + sign * this.zOwn[z]);
  }

  /* The same moment with people as the mass instead of land.
   *
   * Needed because the two disagree badly: DZ areas span a factor of 15,000
   * while populations span 15, so an area-weighted centroid sits wherever the
   * ground is -- measured across a run, up to 8 km from where the people are.
   * The land penalty is close to blind to the shape of the population.
   *
   * Normalised by the region's own area, so 1 means the people are spread like
   * a uniform disc covering the region: above 1 they are strung out, below 1
   * they are clustered. There is no floor at 1, unlike the land penalty --
   * concentration earns credit, and the land term is what stops that being
   * bought with sprawl. */
  _penaltyPopFrom(P, Px, Py, Pxx, A) {
    if (P <= 0 || A <= 0) return 1;
    const I = Pxx - (Px * Px + Py * Py) / P;
    return (2 * Math.PI * I) / (P * A);
  }

  _penaltyPop(r) {
    return this._penaltyPopFrom(this.regionPop[r], this.rPx[r], this.rPy[r],
      this.rPxx[r], this.rArea[r]);
  }

  _penaltyPopWith(r, z, sign) {
    const p = sign * this.pop[z];
    return this._penaltyPopFrom(
      this.regionPop[r] + p,
      this.rPx[r] + p * this.zx[z],
      this.rPy[r] + p * this.zy[z],
      this.rPxx[r] + p * (this.zx[z] * this.zx[z] + this.zy[z] * this.zy[z]),
      this.rArea[r] + sign * this.za[z]);
  }

  /* Fold zone z into region r's sums, keeping both penalty totals current.
   * This owns regionPop too, because the people penalty depends on it and the
   * two must not be updated out of step. */
  _accumulate(r, z, sign) {
    const geom = this.hasGeometry;
    const rel = this.relMode !== 'off';
    if (geom) {
      this.shapeRaw -= this._penalty(r) - 1;
      this.popShapeRaw -= this._penaltyPop(r) - 1;
    }
    if (rel) this.relRaw -= this._relTerm(r);
    const a = sign * this.za[z];
    this.rArea[r] += a;
    this.rSx[r] += a * this.zx[z];
    this.rSy[r] += a * this.zy[z];
    this.rSxx[r] += a * (this.zx[z] * this.zx[z] + this.zy[z] * this.zy[z]);
    this.rOwn[r] += sign * this.zOwn[z];

    const p = sign * this.pop[z];
    this.regionPop[r] += p;
    this.rPx[r] += p * this.zx[z];
    this.rPy[r] += p * this.zy[z];
    this.rPxx[r] += p * (this.zx[z] * this.zx[z] + this.zy[z] * this.zy[z]);

    this.rRelSum[r] += sign * this.zRel[z] * this.zRelN[z];
    this.rRelN[r] += sign * this.zRelN[z];

    if (geom) {
      this.shapeRaw += this._penalty(r) - 1;
      this.popShapeRaw += this._penaltyPop(r) - 1;
    }
    if (rel) this.relRaw += this._relTerm(r);
  }

  /* --- build phase ------------------------------------------------------- */

  /* Assign every unassigned pocket that only one region can ever reach.
   *
   * A zone can only be claimed by a region already bordering it, so if a
   * connected pocket of unassigned zones touches exactly one region, every
   * zone in it is going to that region whatever happens elsewhere -- no other
   * region can get adjacent without going through the first one, and nothing
   * is ever stolen during the build. Handing them over now is not a guess.
   *
   * It matters because until then the region looks smaller than it really is,
   * so the build keeps feeding it while it is already committed to the pocket,
   * and it over-claims on its far side. Returns how many zones were sealed. */
  sealPockets() {
    if (this.assigned >= this.n) return 0;
    const stamp = ++this._stamp;
    let sealed = 0;

    for (let start = 0; start < this.n; start++) {
      if (this.assign[start] >= 0 || this._seen[start] === stamp) continue;
      const pocket = [start];
      this._seen[start] = stamp;
      let owner = -1;
      let contested = false;
      // No early exit on `contested`: the whole pocket still has to be marked,
      // or its far side gets rescanned as a separate pocket.
      for (let i = 0; i < pocket.length; i++) {
        for (const w of this.nbr[pocket[i]]) {
          const r = this.assign[w];
          if (r < 0) {
            if (this._seen[w] !== stamp) { this._seen[w] = stamp; pocket.push(w); }
          } else if (owner < 0) {
            owner = r;
          } else if (owner !== r) {
            contested = true;
          }
        }
      }
      if (contested || owner < 0) continue;
      for (const z of pocket) this._claim(z, owner);
      sealed += pocket.length;
    }
    this.sealed += sealed;
    return sealed;
  }

  _claim(z, region) {
    this._place(z, region);
    for (const w of this.nbr[z]) {
      if (this.assign[w] < 0) this.openNbrs[region].add(w);
    }
  }

  /* One assignment. Returns false when every zone is assigned. */
  buildStep() {
    if (this.assigned >= this.n) return false;

    if (++this.sweepCounter >= this.sweepInterval) {
      this.sweepCounter = 0;
      this.sealPockets();
      if (this.assigned >= this.n) { this._recordBest(); return false; }
    }

    let region = -1;
    for (let r = 0; r < this.N; r++) {
      if (this.openNbrs[r].size === 0) continue;
      if (region < 0 || this.regionPop[r] < this.regionPop[region]) region = r;
    }
    // The DZ graph is one connected component, so while anything is unassigned
    // some region borders it. Reaching here would mean that broke.
    if (region < 0) return false;

    const deviation = this.regionPop[region] - this.target;
    const shaped = this.wShape > 0;
    const peopled = this.wPopShape > 0;
    const religious = this.wRel > 0;
    const cutting = this.wCut > 0;
    const penNow = shaped ? this._penalty(region) : 0;
    const penPopNow = peopled ? this._penaltyPop(region) : 0;
    const relNow = religious ? this._relTerm(region) : 0;
    let pick = -1;
    let pickDelta = Infinity;
    for (const z of this.openNbrs[region]) {
      const d = this.pop[z];
      // Both terms are normalised now, because they are being added together.
      let delta = (this.wPop * d * (d + 2 * deviation)) / this.eD2;
      if (shaped) {
        delta += (this.wShape * (this._penaltyWith(region, z, 1) - penNow))
          / this.sigmaShape;
      }
      if (peopled) {
        delta += (this.wPopShape * (this._penaltyPopWith(region, z, 1) - penPopNow))
          / this.sigmaPopShape;
      }
      if (religious) {
        delta += (this.wRel * (this._relTermWith(region, z, 1) - relNow))
          / this.sigmaRel;
      }
      if (cutting) {
        let dc = 0;
        for (const w of this.nbr[z]) {
          const other = this.assign[w];
          if (other >= 0 && other !== region) dc++;
        }
        delta += (this.wCut * dc) / this.sigmaCut;
      }
      delta /= this.weightSum;
      if (delta < pickDelta || (delta === pickDelta && z < pick)) {
        pickDelta = delta;
        pick = z;
      }
    }

    this._claim(pick, region);
    this.steps++;
    // A partial map cannot be compared against a complete one, so the first
    // state worth recording is the one where every zone has a region.
    if (this.assigned >= this.n) this._recordBest();
    return true;
  }

  _place(z, region) {
    // Before assign[z] is written. Edges to neighbours already assigned
    // elsewhere become cut; edges to unassigned neighbours are cut neither
    // before nor after, which is why the count grows through the build.
    for (const w of this.nbr[z]) {
      const r = this.assign[w];
      if (r >= 0 && r !== region) this.cutRaw++;
    }
    const before = this.regionPop[region] - this.target;
    this.assign[z] = region;
    this._accumulate(region, z, 1);   // also updates regionPop
    this.regionSize[region]++;
    this.assigned++;
    const after = this.regionPop[region] - this.target;
    this.rawScore += after * after - before * before;
    // z can only sit in the open set of a region that already borders it.
    for (const w of this.nbr[z]) {
      const r = this.assign[w];
      if (r >= 0) this.openNbrs[r].delete(z);
    }
    // Assigning z can also turn its already-assigned neighbours into border
    // zones, so they need re-testing too, not just z.
    this._touchFrontier(z);
    for (const w of this.nbr[z]) this._touchFrontier(w);
  }

  /* --- optimisation phase ------------------------------------------------ */

  /* One attempted move. Returns true if a zone actually changed region. */
  optimiseStep() {
    if (++this.recomCounter >= this.recomInterval) {
      this.recomCounter = 0;
      return this.recombineStep();
    }
    this.steps++;
    if (this.frontier.length === 0) return false;

    const z = this.frontier[(this.rng() * this.frontier.length) | 0];
    const from = this.assign[z];
    if (this.regionSize[from] <= 1) return false;

    // What has to move with z for `from` to stay in one piece. Usually just z.
    let moving;
    if (this._connectedWithout(from, z)) {
      moving = this._single;
      moving[0] = z;
    } else if (this.allowBranchMoves) {
      moving = this._branchOf(from, z);
      if (moving === null || moving.length >= this.regionSize[from]) return false;
    } else {
      return false;
    }

    const g = this._aggregateInto(this._agg, moving);
    const dP = g.pop;
    const candidates = [from];
    const deltas = [0];
    const seen = new Set([from]);
    // Constant across candidates: what leaving `from` costs.
    const shaped = this.wShape > 0;
    const peopled = this.wPopShape > 0;
    const religious = this.wRel > 0;
    const cutting = this.wCut > 0;
    const cutTally = cutting ? this._cutTally(moving) : null;
    const leavingCut = cutting ? cutTally.get(from) || 0 : 0;
    const leaving = shaped ? this._penaltyWithAgg(from, g, -1) - this._penalty(from) : 0;
    const leavingPop = peopled
      ? this._penaltyPopWithAgg(from, g, -1) - this._penaltyPop(from) : 0;
    const leavingRel = religious
      ? this._relTermWithAgg(from, g, -1) - this._relTerm(from) : 0;
    for (const w of this.nbr[z]) {
      const r = this.assign[w];
      if (r < 0 || seen.has(r)) continue;
      seen.add(r);
      candidates.push(r);
      let delta = this.wPop * 2 * dP
        * (dP + this.regionPop[r] - this.regionPop[from]) / this.eD2;
      if (shaped) {
        const joining = this._penaltyWithAgg(r, g, 1) - this._penalty(r);
        delta += (this.wShape * (leaving + joining)) / this.sigmaShape;
      }
      if (peopled) {
        const joining = this._penaltyPopWithAgg(r, g, 1) - this._penaltyPop(r);
        delta += (this.wPopShape * (leavingPop + joining)) / this.sigmaPopShape;
      }
      if (religious) {
        const joining = this._relTermWithAgg(r, g, 1) - this._relTerm(r);
        delta += (this.wRel * (leavingRel + joining)) / this.sigmaRel;
      }
      if (cutting) {
        delta += (this.wCut * (leavingCut - (cutTally.get(r) || 0))) / this.sigmaCut;
      }
      deltas.push(delta / this.weightSum);
    }
    if (candidates.length === 1) return false;

    // Straight after the build phase regions differ by tens of thousands, so
    // deltas reach several hundred and a naive exp() overflows at once.
    let min = Infinity;
    for (const x of deltas) if (x < min) min = x;
    const weights = deltas.map((x) => Math.exp(-(x - min) / this.temperature));
    let total = 0;
    for (const w of weights) total += w;

    let pick = this.rng() * total;
    let chosen = candidates.length - 1;
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i];
      if (pick <= 0) { chosen = i; break; }
    }

    const to = candidates[chosen];
    if (to === from) return false;
    if (moving.length > 1) this.branched++;
    this._moveSet(moving, from, to);
    this.moves++;
    this._recordBest();
    return true;
  }

  _moveSet(zones, from, to) {
    const a0 = this.regionPop[from] - this.target;
    const b0 = this.regionPop[to] - this.target;
    for (const z of zones) {
      // assign[z] is still `from` here and earlier zones of the set have
      // already moved, so this telescopes: an edge inside the set is counted
      // cut when its first end moves and uncut again when its second does.
      for (const w of this.nbr[z]) {
        const r = this.assign[w];
        if (r === from) this.cutRaw++;
        else if (r === to) this.cutRaw--;
      }
      this._accumulate(from, z, -1);  // both also update regionPop
      this._accumulate(to, z, 1);
      this.regionSize[from]--;
      this.regionSize[to]++;
      this.assign[z] = to;
    }
    const a1 = this.regionPop[from] - this.target;
    const b1 = this.regionPop[to] - this.target;
    this.rawScore += a1 * a1 - a0 * a0 + b1 * b1 - b0 * b0;

    // Only once every zone has moved: mid-way through the set the frontier
    // would be tested against a state that never actually exists.
    for (const z of zones) {
      this._touchFrontier(z);
      for (const w of this.nbr[z]) this._touchFrontier(w);
    }
  }

  /* Edges leaving the moving set, tallied by the region on the far side.
   * Edges inside the set never change status, so they are skipped. Built once
   * per step and shared across candidates, like the geometric aggregate. */
  _cutTally(zones) {
    const tally = this._cutMap;
    tally.clear();
    const stamp = ++this._stamp;
    for (const z of zones) this._seen[z] = stamp;
    for (const z of zones) {
      for (const w of this.nbr[z]) {
        if (this._seen[w] === stamp) continue;
        const r = this.assign[w];
        if (r >= 0) tally.set(r, (tally.get(r) || 0) + 1);
      }
    }
    return tally;
  }

  /* Cut edges counted from scratch, for the drift checks. */
  _countCut() {
    let cut = 0;
    for (let z = 0; z < this.n; z++) {
      const r = this.assign[z];
      if (r < 0) continue;
      for (const w of this.nbr[z]) {
        if (w > z && this.assign[w] >= 0 && this.assign[w] !== r) cut++;
      }
    }
    return cut;
  }

  /* Each region's own cut edges, in one pass. For the bar chart, which redraws
   * five times a second -- not worth maintaining incrementally. */
  cutByRegion() {
    const out = new Float64Array(this.N);
    for (let z = 0; z < this.n; z++) {
      const r = this.assign[z];
      if (r < 0) continue;
      for (const w of this.nbr[z]) {
        const rw = this.assign[w];
        if (rw >= 0 && rw !== r) out[r]++;
      }
    }
    return out;
  }

  /* Would `region` still be one piece with z taken out of it? */
  _connectedWithout(region, z) {
    const size = this.regionSize[region];
    if (size <= 1) return false;
    let start = -1;
    for (const w of this.nbr[z]) {
      if (w !== z && this.assign[w] === region) { start = w; break; }
    }
    if (start < 0) return false;

    const stamp = ++this._stamp;
    this._seen[start] = stamp;
    const stack = [start];
    let count = 1;
    while (stack.length) {
      const u = stack.pop();
      for (const w of this.nbr[u]) {
        if (w !== z && this.assign[w] === region && this._seen[w] !== stamp) {
          this._seen[w] = stamp;
          count++;
          stack.push(w);
        }
      }
    }
    return count === size - 1;
  }

  /* The connected pieces `region` would fall into without z.
   *
   * Every piece must contain a neighbour of z -- otherwise it was already cut
   * off with z present, and the region was never connected -- so starting a
   * flood from each of z's neighbours in the region finds all of them, in
   * O(region size) rather than a scan of every zone. */
  _componentsWithout(region, z) {
    const stamp = ++this._stamp;
    const comps = [];
    for (const start of this.nbr[z]) {
      if (this.assign[start] !== region || this._seen[start] === stamp) continue;
      const comp = [start];
      this._seen[start] = stamp;
      for (let i = 0; i < comp.length; i++) {
        for (const w of this.nbr[comp[i]]) {
          if (w !== z && this.assign[w] === region && this._seen[w] !== stamp) {
            this._seen[w] = stamp;
            comp.push(w);
          }
        }
      }
      comps.push(comp);
    }
    return comps;
  }

  /* z plus everything that has to travel with it: keep the largest piece,
   * move the rest. The result is the unique smallest set whose departure
   * leaves `region` in one piece -- the graph picks it, not a heuristic.
   * Returns null if z is not actually a cut vertex here. */
  _branchOf(region, z) {
    const comps = this._componentsWithout(region, z);
    if (comps.length < 2) return null;
    let biggest = 0;
    for (let i = 1; i < comps.length; i++) {
      if (comps[i].length > comps[biggest].length) biggest = i;
    }
    const moving = [z];
    for (let i = 0; i < comps.length; i++) {
      if (i !== biggest) for (const w of comps[i]) moving.push(w);
    }
    return moving;
  }

  /* Totals for a moving set, computed once and shared by every candidate
   * destination, so each candidate's delta stays O(1) however big the set. */
  _aggregateInto(g, zones) {
    g.area = 0; g.ax = 0; g.ay = 0; g.axx = 0; g.own = 0;
    g.pop = 0; g.px = 0; g.py = 0; g.pxx = 0;
    g.relSum = 0; g.relN = 0;
    for (const z of zones) {
      const a = this.za[z];
      const pop = this.pop[z];
      const x = this.zx[z];
      const y = this.zy[z];
      const rr = x * x + y * y;
      g.area += a; g.ax += a * x; g.ay += a * y; g.axx += a * rr;
      g.own += this.zOwn[z];
      g.pop += pop; g.px += pop * x; g.py += pop * y; g.pxx += pop * rr;
      g.relSum += this.zRel[z] * this.zRelN[z]; g.relN += this.zRelN[z];
    }
    return g;
  }

  _penaltyWithAgg(r, g, sign) {
    return this._penaltyFrom(
      this.rArea[r] + sign * g.area,
      this.rSx[r] + sign * g.ax,
      this.rSy[r] + sign * g.ay,
      this.rSxx[r] + sign * g.axx,
      this.rOwn[r] + sign * g.own);
  }

  _penaltyPopWithAgg(r, g, sign) {
    return this._penaltyPopFrom(
      this.regionPop[r] + sign * g.pop,
      this.rPx[r] + sign * g.px,
      this.rPy[r] + sign * g.py,
      this.rPxx[r] + sign * g.pxx,
      this.rArea[r] + sign * g.area);
  }

  /* --- recombination ----------------------------------------------------- */

  /* Merge two adjacent regions, draw a random spanning tree over the union and
   * cut one edge of it. A tree splits into exactly two pieces when any edge is
   * removed, and every tree edge is a real adjacency edge, so both pieces are
   * connected in the graph too: contiguity here is structural rather than
   * checked. That is what lets a whole boundary be redrawn in one step, and
   * what dissolves the sealed pockets single-zone moves get stuck in.
   *
   * Returns true if the boundary actually changed. */
  recombineStep() {
    this.steps++;
    if (this.frontier.length === 0) return false;

    const seed = this.frontier[(this.rng() * this.frontier.length) | 0];
    const a = this.assign[seed];
    let b = -1;
    let seen = 0;
    for (const w of this.nbr[seed]) {          // reservoir-pick among differing
      const r = this.assign[w];
      if (r < 0 || r === a) continue;
      seen++;
      if (this.rng() * seen < 1) b = r;
    }
    if (b < 0) return false;

    const size = this._recomCollect(seed, a, b);
    if (size < 2) return false;
    if (!this._recomTree(size)) return false;
    this._recomAccumulate(size);
    return this._recomChoose(size, a, b);
  }

  /* Every zone of both regions, by one flood from the seed. The union is
   * connected -- both regions are, and they touch -- so one pass reaches all
   * of it. There are no member lists on the model, only assign[]. */
  _recomCollect(seed, a, b) {
    const members = this._members;
    members.length = 0;
    const stamp = ++this._stamp;
    this._seen[seed] = stamp;
    members.push(seed);
    for (let i = 0; i < members.length; i++) {
      for (const w of this.nbr[members[i]]) {
        const r = this.assign[w];
        if ((r === a || r === b) && this._seen[w] !== stamp) {
          this._seen[w] = stamp;
          members.push(w);
        }
      }
    }
    for (let i = 0; i < members.length; i++) this._local[members[i]] = i;
    this._stampMembers = stamp;
    return members.length;
  }

  /* Random-order Kruskal. Preferred over a randomised BFS, whose trees come out
   * shallow and bushy so that nearly every cut is tiny-versus-huge; this gives
   * longer paths and therefore more balanced cuts to choose between. */
  _recomTree(size) {
    const members = this._members;
    const stamp = this._stampMembers;
    let m = 0;
    for (let i = 0; i < size; i++) {
      for (const w of this.nbr[members[i]]) {
        if (this._seen[w] !== stamp) continue;
        const j = this._local[w];
        if (j > i) { this._eu[m] = i; this._ev[m] = j; m++; }
      }
    }
    this._edgeCount = m;
    if (m < size - 1) return false;

    for (let i = 0; i < m; i++) this._eord[i] = i;
    for (let i = m - 1; i > 0; i--) {          // Fisher-Yates
      const j = (this.rng() * (i + 1)) | 0;
      const t = this._eord[i]; this._eord[i] = this._eord[j]; this._eord[j] = t;
    }

    const uf = this._uf;
    for (let i = 0; i < size; i++) uf[i] = i;
    const find = (x) => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };

    this._head.fill(-1, 0, size);
    let added = 0;
    let slot = 0;
    for (let k = 0; k < m && added < size - 1; k++) {
      const e = this._eord[k];
      const u = this._eu[e];
      const v = this._ev[e];
      const ru = find(u);
      const rv = find(v);
      if (ru === rv) continue;
      uf[ru] = rv;
      this._to[slot] = v; this._nxt[slot] = this._head[u]; this._head[u] = slot++;
      this._to[slot] = u; this._nxt[slot] = this._head[v]; this._head[v] = slot++;
      added++;
    }
    return added === size - 1;
  }

  /* Root the tree, then one backward pass over the preorder gives every
   * candidate cut's totals at once: population, area, the moment sums and the
   * religion sums are all additive, so four of the five score terms come free.
   *
   * Cut edges is not a subtree sum, but the handshake lemma makes it one:
   *   edges leaving S = (induced degrees in S) - 2 * (edges inside S)
   * and an induced edge lies inside subtree(x) exactly when x is an ancestor of
   * its LCA -- so counting at each edge's LCA and subtree-summing that gives
   * the second half. A naive depth walk is enough at this size. */
  _recomAccumulate(size) {
    const { _members: members, _parent: parent, _depth: depth, _order: order,
      _tin: tin, _sz: sz, _stack: stack, _head: head, _nxt: nxt, _to: to } = this;
    const stamp = this._stampMembers;

    let sp = 0;
    let count = 0;
    stack[sp++] = 0;
    parent[0] = -1;
    depth[0] = 0;
    while (sp > 0) {
      const u = stack[--sp];
      tin[u] = count;
      order[count++] = u;
      for (let e = head[u]; e !== -1; e = nxt[e]) {
        const v = to[e];
        if (v === parent[u]) continue;
        parent[v] = u;
        depth[v] = depth[u] + 1;
        stack[sp++] = v;
      }
    }

    for (let i = 0; i < size; i++) {
      const g = members[i];
      let deg = 0;
      for (const w of this.nbr[g]) if (this._seen[w] === stamp) deg++;
      const rr = this.zx[g] * this.zx[g] + this.zy[g] * this.zy[g];
      this._sPop[i] = this.pop[g];
      this._sArea[i] = this.za[g];
      this._sAx[i] = this.za[g] * this.zx[g];
      this._sAy[i] = this.za[g] * this.zy[g];
      this._sAxx[i] = this.za[g] * rr;
      this._sOwn[i] = this.zOwn[g];
      this._sPx[i] = this.pop[g] * this.zx[g];
      this._sPy[i] = this.pop[g] * this.zy[g];
      this._sPxx[i] = this.pop[g] * rr;
      this._sRelS[i] = this.zRel[g] * this.zRelN[g];
      this._sRelN[i] = this.zRelN[g];
      this._sDeg[i] = deg;
      this._sInt[i] = 0;
      sz[i] = 1;
    }

    for (let e = 0; e < this._edgeCount; e++) {
      let u = this._eu[e];
      let v = this._ev[e];
      while (depth[u] > depth[v]) u = parent[u];
      while (depth[v] > depth[u]) v = parent[v];
      while (u !== v) { u = parent[u]; v = parent[v]; }
      this._sInt[u]++;
    }

    for (let i = size - 1; i >= 1; i--) {
      const u = order[i];
      const q = parent[u];
      this._sPop[q] += this._sPop[u];
      this._sArea[q] += this._sArea[u];
      this._sAx[q] += this._sAx[u];
      this._sAy[q] += this._sAy[u];
      this._sAxx[q] += this._sAxx[u];
      this._sOwn[q] += this._sOwn[u];
      this._sPx[q] += this._sPx[u];
      this._sPy[q] += this._sPy[u];
      this._sPxx[q] += this._sPxx[u];
      this._sRelS[q] += this._sRelS[u];
      this._sRelN[q] += this._sRelN[u];
      this._sDeg[q] += this._sDeg[u];
      this._sInt[q] += this._sInt[u];
      sz[q] += sz[u];
    }
  }

  /* Score every cut against the existing boundary, pick one, apply it.
   *
   * The current split is added as a candidate with delta 0 -- a random tree
   * will not generally contain an edge that reproduces it, so it has to be put
   * in by hand. That makes it the reference the cuts are judged against, means
   * a step never forces a change when the status quo is best, and removes any
   * need for retry logic, since there is always a valid candidate. */
  _recomChoose(size, a, b) {
    const { _members: members, _order: order, _tin: tin, _sz: sz } = this;

    let oldCross = 0;
    for (let e = 0; e < this._edgeCount; e++) {
      if (this.assign[members[this._eu[e]]] !== this.assign[members[this._ev[e]]]) oldCross++;
    }
    const devA = this.regionPop[a] - this.target;
    const devB = this.regionPop[b] - this.target;
    const oldPop = devA * devA + devB * devB;
    const oldShape = this._penalty(a) + this._penalty(b) - 2;
    const oldPeople = this._penaltyPop(a) + this._penaltyPop(b) - 2;
    const oldRel = this._relTerm(a) + this._relTerm(b);

    const totPop = this._sPop[0];
    const relValue = (sum, n) => (n > 0 ? sum / n : this.relMean);

    const cuts = [-1];          // -1 is the status quo
    const deltas = [0];
    for (let c = 1; c < size; c++) {   // every node but the root cuts its parent edge
      const p1 = this._sPop[c];
      const p2 = totPop - p1;
      const d1 = p1 - this.target;
      const d2 = p2 - this.target;
      let delta = this.wPop * (d1 * d1 + d2 * d2 - oldPop) / this.eD2;

      if (this.wShape > 0) {
        const nw = this._penaltyFrom(this._sArea[c], this._sAx[c], this._sAy[c],
          this._sAxx[c], this._sOwn[c])
          + this._penaltyFrom(this._sArea[0] - this._sArea[c], this._sAx[0] - this._sAx[c],
            this._sAy[0] - this._sAy[c], this._sAxx[0] - this._sAxx[c],
            this._sOwn[0] - this._sOwn[c]) - 2;
        delta += (this.wShape * (nw - oldShape)) / this.sigmaShape;
      }
      if (this.wPopShape > 0) {
        const nw = this._penaltyPopFrom(p1, this._sPx[c], this._sPy[c], this._sPxx[c],
          this._sArea[c])
          + this._penaltyPopFrom(p2, this._sPx[0] - this._sPx[c], this._sPy[0] - this._sPy[c],
            this._sPxx[0] - this._sPxx[c], this._sArea[0] - this._sArea[c]) - 2;
        delta += (this.wPopShape * (nw - oldPeople)) / this.sigmaPopShape;
      }
      if (this.wRel > 0) {
        const nw = this._relTermFrom(relValue(this._sRelS[c], this._sRelN[c]))
          + this._relTermFrom(relValue(this._sRelS[0] - this._sRelS[c],
            this._sRelN[0] - this._sRelN[c]));
        delta += (this.wRel * (nw - oldRel)) / this.sigmaRel;
      }
      if (this.wCut > 0) {
        const cross = this._sDeg[c] - 2 * this._sInt[c];
        delta += (this.wCut * (cross - oldCross)) / this.sigmaCut;
      }
      cuts.push(c);
      deltas.push(delta / this.weightSum);
    }

    let min = Infinity;
    for (const d of deltas) if (d < min) min = d;
    let total = 0;
    const weights = deltas.map((d) => {
      const w = Math.exp(-(d - min) / this.temperature);
      total += w;
      return w;
    });
    let pick = this.rng() * total;
    let chosen = 0;
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i];
      if (pick <= 0) { chosen = i; break; }
    }

    const c = cuts[chosen];
    // Kept so the whole subtree/LCA scoring pass can be checked against a real
    // rescore: after applying, score should have moved by exactly this.
    this.lastRecomDelta = deltas[chosen];
    if (c < 0) return false;          // status quo won

    // Which piece keeps which number, by whichever pairing overlaps more --
    // otherwise half of all steps would swap two regions' colours at random.
    const start = tin[c];
    const end = start + sz[c];
    let s1inA = 0;
    let s1inB = 0;
    for (let i = start; i < end; i++) {
      const g = members[order[i]];
      if (this.assign[g] === a) s1inA += this.pop[g]; else s1inB += this.pop[g];
    }
    const keepOrder = s1inA + (this.regionPop[b] - s1inB)
      >= s1inB + (this.regionPop[a] - s1inA);
    const r1 = keepOrder ? a : b;
    const r2 = keepOrder ? b : a;

    const stamp = ++this._stamp;
    for (let i = start; i < end; i++) this._seen[members[order[i]]] = stamp;
    for (let i = 0; i < size; i++) {
      const g = members[i];
      this.assign[g] = this._seen[g] === stamp ? r1 : r2;
    }

    // Half of two regions has been rewritten, so recompute rather than thread
    // hundreds of zones through the incremental path.
    this._resum();
    this.frontier = [];
    this.frontierPos.fill(-1);
    for (let z = 0; z < this.n; z++) this._touchFrontier(z);
    this.recombinations++;
    this._recordBest();
    return true;
  }

  /* --- frontier ---------------------------------------------------------- */

  _touchFrontier(z) {
    const r = this.assign[z];
    let border = false;
    if (r >= 0) {
      for (const w of this.nbr[z]) {
        const rw = this.assign[w];
        if (rw >= 0 && rw !== r) { border = true; break; }
      }
    }
    const at = this.frontierPos[z];
    if (border && at < 0) {
      this.frontierPos[z] = this.frontier.length;
      this.frontier.push(z);
    } else if (!border && at >= 0) {
      const last = this.frontier.pop();
      if (last !== z) {
        this.frontier[at] = last;
        this.frontierPos[last] = at;
      }
      this.frontierPos[z] = -1;
    }
  }

  /* --- scoring and results ----------------------------------------------- */

  _rescore() {
    let total = 0;
    let shape = 0;
    let popShape = 0;
    let rel = 0;
    for (let r = 0; r < this.N; r++) {
      const dev = this.regionPop[r] - this.target;
      total += dev * dev;
      shape += this._penalty(r) - 1;
      popShape += this._penaltyPop(r) - 1;
      rel += this._relTerm(r);
    }
    this.rawScore = total;
    this.shapeRaw = shape;
    this.popShapeRaw = popShape;
    this.relRaw = rel;
    this.cutRaw = this._countCut();
    return total;
  }

  /* Rebuild every per-region sum from `assign`. */
  _resum() {
    this.regionPop.fill(0);
    this.regionSize.fill(0);
    this.rArea.fill(0);
    this.rSx.fill(0);
    this.rSy.fill(0);
    this.rSxx.fill(0);
    this.rOwn.fill(0);
    this.rPx.fill(0);
    this.rPy.fill(0);
    this.rPxx.fill(0);
    this.rRelSum.fill(0);
    this.rRelN.fill(0);
    for (let z = 0; z < this.n; z++) {
      const r = this.assign[z];
      if (r < 0) continue;
      const rr = this.zx[z] * this.zx[z] + this.zy[z] * this.zy[z];
      this.regionPop[r] += this.pop[z];
      this.regionSize[r]++;
      this.rArea[r] += this.za[z];
      this.rSx[r] += this.za[z] * this.zx[z];
      this.rSy[r] += this.za[z] * this.zy[z];
      this.rSxx[r] += this.za[z] * rr;
      this.rOwn[r] += this.zOwn[z];
      this.rPx[r] += this.pop[z] * this.zx[z];
      this.rPy[r] += this.pop[z] * this.zy[z];
      this.rPxx[r] += this.pop[z] * rr;
      this.rRelSum[r] += this.zRel[z] * this.zRelN[z];
      this.rRelN[r] += this.zRelN[z];
    }
    this._rescore();
  }

  /* Both terms are in units of one typical move, so the weight is a plain
   * relative priority rather than an exchange rate between people and metres. */
  get scorePop() { return this.rawScore / this.eD2; }

  get scoreShape() { return this.shapeRaw / this.sigmaShape; }

  get scorePopShape() { return this.popShapeRaw / this.sigmaPopShape; }

  get scoreReligion() { return this.relRaw / this.sigmaRel; }

  get scoreCut() { return this.cutRaw / this.sigmaCut; }

  /* Divided by the total weight, so only the ratios matter: (0.1, 1, 1) and
   * (1, 10, 10) are the same objective. */
  get score() {
    return (this.wPop * this.scorePop
      + this.wShape * this.scoreShape
      + this.wPopShape * this.scorePopShape
      + this.wRel * this.scoreReligion
      + this.wCut * this.scoreCut) / this.weightSum;
  }

  /* The legible versions: 1 is a circle for land, and for people it is a region
   * whose population is spread evenly across it. The normalised terms above are
   * measured per move, so their absolute values are large and say little. */
  get meanPenalty() { return this.N ? this.shapeRaw / this.N + 1 : 1; }

  get meanPopPenalty() { return this.N ? this.popShapeRaw / this.N + 1 : 1; }

  /* Spread of the regional religion values: falling means the regions are
   * converging on the national mix, rising means they are separating. */
  get relSpread() {
    if (!this.N) return 0;
    let mean = 0;
    for (let r = 0; r < this.N; r++) mean += this._relValue(r);
    mean /= this.N;
    let v = 0;
    for (let r = 0; r < this.N; r++) {
      const d = this._relValue(r) - mean;
      v += d * d;
    }
    return Math.sqrt(v / this.N);
  }

  /* Regions on the wanted side of the threshold. */
  get relSeats() {
    let seats = 0;
    for (let r = 0; r < this.N; r++) {
      const x = this._relValue(r);
      if (this.relAbove ? x >= this.relThreshold : x <= this.relThreshold) seats++;
    }
    return seats;
  }

  /* Max deviation from target as a fraction -- the legible number to show. */
  get maxDeviation() {
    let worst = 0;
    for (let r = 0; r < this.N; r++) {
      const dev = Math.abs(this.regionPop[r] - this.target);
      if (dev > worst) worst = dev;
    }
    return this.target ? worst / this.target : 0;
  }

  _recordBest() {
    if (this.score < this.bestScore) {
      this.bestScore = this.score;
      this.bestAssign.set(this.assign);
    }
  }

  /* Change the shape weight mid-run. The score is a weighted sum, so a
   * different weight is a different objective -- anything recorded under the
   * old one is not comparable and best-so-far restarts from where we are.
   * Returns whether anything changed. */
  setShapeWeight(w) { return this.setWeights(this.wPop, w, this.wPopShape); }

  /* Any weight is part of the score, so changing one is a change of
   * objective: anything recorded under the old weights is not comparable and
   * best-so-far restarts from the current state. Returns whether it changed. */
  setWeights(wPop, wShape, wPopShape, wRel = this.wRel, wCut = this.wCut) {
    const p = Math.max(0, wPop);
    const l = this.hasGeometry ? Math.max(0, wShape) : 0;
    const q = this.hasGeometry ? Math.max(0, wPopShape) : 0;
    const x = this.relMode === 'off' ? 0 : Math.max(0, wRel);
    const c = Math.max(0, wCut);
    if (p === this.wPop && l === this.wShape && q === this.wPopShape
        && x === this.wRel && c === this.wCut) return false;
    this.wPop = p;
    this.wShape = l;
    this.wPopShape = q;
    this.wRel = x;
    this.wCut = c;
    this.weightSum = p + l + q + x + c || 1;
    this.bestScore = Infinity;
    // A partial map cannot be compared against a complete one; the build phase
    // records the first comparable state when it finishes.
    if (this.assigned >= this.n) this._recordBest();
    return true;
  }

  setPopWeight(w) { return this.setWeights(w, this.wShape, this.wPopShape); }

  /* Mode, threshold, steepness and direction all change what the term measures,
   * so the running total has to be rebuilt from scratch and best-so-far goes
   * with it -- anything recorded under the old settings is not comparable. */
  setReligion(mode, threshold, steepness, above) {
    const m = this.hasReligion ? mode : 'off';
    if (m === this.relMode && threshold === this.relThreshold
        && steepness === this.relSteepness && above === this.relAbove) return false;
    this.relMode = m;
    this.relThreshold = threshold;
    this.relSteepness = steepness;
    this.relAbove = above;
    if (m === 'off') this.wRel = 0;
    this.weightSum = this.wPop + this.wShape + this.wPopShape + this.wRel
      + this.wCut || 1;
    this.sigmaRel = this._sigmaRel(this.N);
    this.relRaw = 0;
    for (let r = 0; r < this.N; r++) this.relRaw += this._relTerm(r);
    this.bestScore = Infinity;
    if (this.assigned >= this.n) this._recordBest();
    return true;
  }

  setPopShapeWeight(w) { return this.setWeights(this.wPop, this.wShape, w); }

  /* Put the map back to the best state seen -- with a stochastic rule the
   * state when the user stops is not the best one visited. */
  restoreBest() {
    if (this.bestScore === Infinity) return;
    this.assign.set(this.bestAssign);
    this._resum();
    this.frontier = [];
    this.frontierPos.fill(-1);
    for (let z = 0; z < this.n; z++) this._touchFrontier(z);
  }

  /* Per-region values for display. The bars redraw five times a second, so
   * these exist to avoid going through summary(), which allocates an object
   * per region every time it is called. */
  regionReligion(r) { return this._relValue(r); }

  regionPenalty(r) { return this._penalty(r); }

  regionPopPenalty(r) { return this._penaltyPop(r); }

  regionOf(code) {
    const r = this.assign[this.index.get(code)];
    return r === undefined || r < 0 ? null : r;
  }

  summary() {
    return Array.from({ length: this.N }, (_, r) => ({
      region: r,
      pop: this.regionPop[r],
      zones: this.regionSize[r],
      deviation: this.target ? (this.regionPop[r] - this.target) / this.target : 0,
      penalty: this._penalty(r),
      penaltyPop: this._penaltyPop(r),
      religion: this._relValue(r),
    }));
  }
}
