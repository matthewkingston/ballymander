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
    this.relRaw = 0;          // SUM_r of the religion term, already signed
    this.wPop = 1;
    this.wShape = 0;
    this.wPopShape = 0;
    this.wRel = 0;
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
  }

  /* Seed N regions and prepare the build phase. */
  start(N, seed, opts = {}) {
    const {
      temperature = 1, wPop = 1, wShape = 0, wPopShape = 0, wRel = 0,
      relMode = 'off', relThreshold = 0.6, relSteepness = 0.05, relAbove = true,
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
    this.weightSum = this.wPop + this.wShape + this.wPopShape + this.wRel || 1;
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

  /* Divided by the total weight, so only the ratios matter: (0.1, 1, 1) and
   * (1, 10, 10) are the same objective. */
  get score() {
    return (this.wPop * this.scorePop
      + this.wShape * this.scoreShape
      + this.wPopShape * this.scorePopShape
      + this.wRel * this.scoreReligion) / this.weightSum;
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
  setWeights(wPop, wShape, wPopShape, wRel = this.wRel) {
    const p = Math.max(0, wPop);
    const l = this.hasGeometry ? Math.max(0, wShape) : 0;
    const q = this.hasGeometry ? Math.max(0, wPopShape) : 0;
    const x = this.relMode === 'off' ? 0 : Math.max(0, wRel);
    if (p === this.wPop && l === this.wShape && q === this.wPopShape
        && x === this.wRel) return false;
    this.wPop = p;
    this.wShape = l;
    this.wPopShape = q;
    this.wRel = x;
    this.weightSum = p + l + q + x || 1;
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
    this.weightSum = this.wPop + this.wShape + this.wPopShape + this.wRel || 1;
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
