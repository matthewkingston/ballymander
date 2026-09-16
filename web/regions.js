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

/* The demographic terms: a population-weighted mean per region, steered by one
 * of three modes. Adding another is its two columns plus one entry here.
 *
 * Each carries its own pair of sigma constants, and they are not
 * interchangeable. vSpread is how far a boundary zone sits from its region's
 * value; rSpread is how far regions sit from the national value. Religion is
 * strongly spatially correlated -- neighbours resemble each other and regional
 * spread stays half the zone spread. Age is not: adjacent zones differ by more
 * than the overall spread (a student area beside a family one), so averaging
 * ~210 zones per region washes most of it out. Measured:
 *
 *                     national   zone SD   adjacent rms   regional SD (N=18)
 *   religion            0.511     0.301          0.176                0.160
 *   age                39.600     5.389          6.139                1.431
 *   sexual orientation  0.0227    0.0206         0.0187               0.0103
 *   social grade        0.4829    0.1616         0.1457               0.0356
 *
 * Every vSpread but religion's is measured directly -- the rms of (zone value -
 * its region's value) over the frontier, at N=18 with population the only
 * weight. Religion's 0.2 was estimated from the adjacent rms before that
 * measurement existed and reads 0.270 the same way, so its term runs about a
 * third hotter than nominal; it is left alone because the slider absorbs it and
 * every setting anyone has tuned so far assumes it.
 *
 * The last two are shares of the people who answered, not of everyone: the
 * pipeline drops "prefer not to say" and the under-16s from the denominator
 * rather than counting them as an answer. So 26.7% of the population is outside
 * the orientation figure and 20.6% outside social grade, and each has its own
 * `_n` column accordingly.
 *
 * `field` is a population-weighted mean written by prepare_attributes.py, and
 * `countField` is that table's own row total -- the right denominator, and not
 * quite `pop`, since disclosure control perturbs every table separately. */
const DEMOGRAPHICS = [
  {
    key: 'rel',
    label: 'Religion',
    field: 'rel',
    countField: 'rel_n',
    vSpread: 0.2,
    rSpread: 0.15,
    threshold: 0.6,
    steepness: 0.05,
    thresholdRange: [0.05, 0.95, 0.01],
    steepnessRange: [0.01, 0.3, 0.01],
    decimals: 3,
  },
  {
    // Gerrymandering age is a much narrower target than religion: regional mean
    // ages only span 37.8-43.0 with the term off, so the default threshold sits
    // just above the national mean rather than anywhere near, say, 45, which no
    // region could reach however the lines were drawn.
    key: 'age',
    label: 'Age',
    field: 'age',
    countField: 'age_n',
    vSpread: 5.1,
    rSpread: 1.6,
    threshold: 41,
    steepness: 0.5,
    thresholdRange: [34, 46, 0.25],
    steepnessRange: [0.1, 3, 0.05],
    decimals: 1,
  },
  {
    // A rate, not a balance: the national figure is 2.3% and no region gets far
    // above 5%, so it wants four decimals where religion wants three. The
    // gerrymander threshold sits just above the national rate for the same
    // reason age's does -- the reachable band at N=18 is 0.012 to 0.049.
    key: 'orient',
    label: 'Orientation',
    field: 'orient',
    countField: 'orient_n',
    vSpread: 0.019,
    rSpread: 0.011,
    threshold: 0.03,
    steepness: 0.004,
    thresholdRange: [0.005, 0.1, 0.001],
    steepnessRange: [0.001, 0.02, 0.001],
    decimals: 4,
  },
  {
    // AB 1, C1 2/3, C2 1/3, semi-skilled and below 0, so the index is where a
    // region sits on the four grades. Reachable band at N=18 is 0.411 to 0.551.
    key: 'grade',
    label: 'Social grade',
    field: 'grade',
    countField: 'grade_n',
    vSpread: 0.16,
    rSpread: 0.04,
    threshold: 0.51,
    steepness: 0.015,
    thresholdRange: [0.25, 0.75, 0.005],
    steepnessRange: [0.005, 0.1, 0.005],
    decimals: 3,
  },
];

/* Extreme mode rewards separation, and `-(x - mu)^2` rewards it without limit,
 * so it will buy a region made of one outlier Data Zone if the prize is big
 * enough. Nothing else in the score stops that: a single-zone region scores
 * about 1 on land shape and on people shape, which is the best either can give,
 * and near-minimal on cut edges. Only the population term resists, and its cost
 * for stranding a region falls as 1/N^2 while this term's gain falls as 1/N --
 * so the weight at which it wins drops with N.
 *
 * Religion never triggered it because it cannot: values live in [0, 1], so the
 * furthest a region can sit from the national 0.511 is 0.49, which is 3.3 times
 * rSpread. Mean age reaches 72.4 in one 180-person Bangor block against a
 * national 39.6 -- 20 times rSpread, so 400 times the reward once squared. The
 * term was calibrated on the typical deviation and then asked to price one
 * twenty times larger.
 *
 * So extreme mode pays only up to a cap, and past it a degenerate region is
 * worth no more than an ordinary well-separated one. The cap is a multiple of
 * rSpread, the same constant that sets sigma. Five is deliberately generous:
 * extreme mode already reaches 3.6x rSpread legitimately at N=18, and no
 * religion value can reach 5x at all, so that term is left exactly as it was.
 *
 * The cap is on the reward only. Average mode keeps the plain square: it is a
 * penalty, bounded below by zero and with nothing to gain from a degenerate
 * region, and capping it would remove the pull on exactly the outliers it
 * exists to bring in. */
const EXTREME_CAP = 5;

/* --- the parties --------------------------------------------------------- */

/* A party is scored exactly like a demographic: a vote-weighted mean per
 * region, where the value is that party's share of the region's votes. Votes
 * are the model's voter shares times each zone's electorate times a flat
 * turnout, all fixed in web/data/dz_voters.json.
 *
 * Because every party shares one denominator -- the region's votes -- the
 * party terms ride the same per-region sums as the demographics, and a term's
 * own running sum IS that party's votes in the region.
 *
 * Gerrymander mode is the one place they differ. Under first past the post
 * what matters is beating the strongest rival, not reaching a fixed share, so
 * that mode scores the winning margin: this party's share minus the best other
 * party's. That needs every party's sums at once, which is what the _partyBest
 * helpers below are for. Average and extreme modes score the share, as a
 * demographic does.
 *
 * vSpread and rSpread are measured over the 18 real 2024 constituencies by
 * scripts/build_app_voters.py, the same quantities the demographics carry. */
function partyTerms(voters) {
  if (!voters || !voters.parties) return [];
  return voters.parties.map((party, index) => {
    const spread = (voters.spread && voters.spread[index]) || {};
    return {
      key: `party:${party}`,
      label: party,
      party,
      partyIndex: index,
      isParty: true,
      vSpread: spread.vSpread || 0.05,
      rSpread: spread.rSpread || 0.05,
      // The gerrymander threshold is a margin, so zero means "just wins".
      threshold: 0,
      steepness: 0.02,
      thresholdRange: [-0.3, 0.3, 0.005],
      steepnessRange: [0.005, 0.15, 0.005],
      decimals: 3,
    };
  });
}

/* { code: { votes, shares[] } } from the app's voter file. Shares are stored
 * rounded, so they are renormalised here: every vote then belongs to exactly
 * one party and a region's shares sum to one. */
function zoneVoters(voters) {
  if (!voters || !voters.zones) return null;
  const out = {};
  for (const [code, z] of Object.entries(voters.zones)) {
    const total = z.s.reduce((a, x) => a + x, 0);
    out[code] = {
      votes: z.e * voters.turnout,
      shares: total > 0 ? z.s.map((x) => x / total) : z.s,
    };
  }
  return out;
}

/* { key: { code: {value, n} } } for every demographic present in the data. */
function zoneDemographics(features) {
  const out = {};
  for (const def of DEMOGRAPHICS) {
    const rows = {};
    let ok = true;
    for (const f of features) {
      const p = f.properties;
      if (typeof p[def.field] !== 'number' || typeof p[def.countField] !== 'number') {
        ok = false;
        break;
      }
      rows[p.code] = { value: p[def.field], n: p[def.countField] };
    }
    if (ok) out[def.key] = rows;
  }
  return out;
}

/* --- model --------------------------------------------------------------- */

class RegionModel {
  /* graph: a DZGraph. popByCode / geomByCode / demographicsByCode: keyed by
   * zone code, the latter two from zoneGeometry() and zoneDemographics(). Both
   * are optional -- without geometry the shape terms are unavailable and their
   * weights forced to zero, and a demographic absent from the data simply has
   * no term. `voters` is web/data/dz_voters.json, adding one term per party. */
  constructor(graph, popByCode, geomByCode = null, demographicsByCode = null,
              voters = null) {
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

    // One term per demographic present in the data, each with its per-zone
    // values, its per-region running sums and its own recombination scratch.
    const demoByCode = demographicsByCode || {};
    this.terms = DEMOGRAPHICS.filter((def) => demoByCode[def.key]).map((def) => {
      const rows = demoByCode[def.key];
      const term = {
        ...def,
        def,
        zValue: new Float64Array(this.n),
        zN: new Float64Array(this.n),
        rSum: new Float64Array(0),
        rN: new Float64Array(0),
        sSum: new Float64Array(this.n),
        sN: new Float64Array(this.n),
        cap: EXTREME_CAP * def.rSpread,
      };
      let sum = 0;
      let count = 0;
      for (let i = 0; i < this.n; i++) {
        const row = rows[this.codes[i]] || { value: 0, n: 0 };
        term.zValue[i] = row.value;
        term.zN[i] = row.n;
        sum += row.value * row.n;
        count += row.n;
      }
      term.mean = count ? sum / count : 0;
      return term;
    });
    // Party terms, if the voter file is loaded. They join `demographics` so
    // every per-region sum, aggregate and subtree total maintains them too;
    // only their value function differs (see partyTerms).
    const zVoters = zoneVoters(voters);
    this.parties = !zVoters ? [] : partyTerms(voters).map((def) => {
      const term = {
        ...def,
        def,
        zValue: new Float64Array(this.n),
        zN: new Float64Array(this.n),
        rSum: new Float64Array(0),
        rN: new Float64Array(0),
        sSum: new Float64Array(this.n),
        sN: new Float64Array(this.n),
        cap: EXTREME_CAP * def.rSpread,
      };
      let sum = 0;
      let count = 0;
      for (let i = 0; i < this.n; i++) {
        const row = zVoters[this.codes[i]] || { votes: 0, shares: [] };
        term.zValue[i] = row.shares[def.partyIndex] || 0;
        term.zN[i] = row.votes;
        sum += term.zValue[i] * row.votes;
        count += row.votes;
      }
      term.mean = count ? sum / count : 0;
      return term;
    });
    // `terms` is everything the score can steer; `demographics` stays what it
    // has always been, so callers iterating it never see a party.
    this.terms = this.terms.concat(this.parties);
    this.terms.forEach((d, k) => { d.slot = k; });
    this.demographics = this.terms.filter((d) => !d.isParty);
    this.demoByKey = Object.fromEntries(this.terms.map((d) => [d.key, d]));
    this.hasElection = this.parties.length > 0;

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
    this._sPxx = sums(); this._sDeg = sums(); this._sInt = sums();

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
    };
    this._agg.demo = this.terms.map(() => ({ sum: 0, n: 0 }));

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

    this.wPop = 1;
    this.wShape = 0;
    this.wPopShape = 0;
    this.wCut = 0;
    this.sigmaCut = 1;
    this.weightSum = 1;
    for (const d of this.terms) {
      d.raw = 0;              // SUM_r of the term, already signed
      d.weight = 0;
      d.mode = 'off';        // off | average | extreme | gerrymander
      d.threshold = d.def.threshold;
      d.steepness = d.def.steepness;
      d.above = true;
      d.sigma = 1;
      d.rSum = new Float64Array(0);
      d.rN = new Float64Array(0);
    }
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
      temperature = 1, wPop = 1, wShape = 0, wPopShape = 0, wCut = 0, demo = {},
    } = opts;
    this.reset();
    this.N = N;
    this.target = this.totalPop / N;
    this.temperature = temperature;
    for (const d of this.terms) {
      const want = demo[d.key] || {};
      d.mode = want.mode || 'off';
      d.threshold = want.threshold ?? d.def.threshold;
      d.steepness = want.steepness ?? d.def.steepness;
      d.above = want.above !== false;
      d.weight = d.mode === 'off' ? 0 : Math.max(0, want.weight || 0);
      d.sigma = this._demoSigma(d, N);
    }
    this.wPop = Math.max(0, wPop);
    this.wShape = this.hasGeometry ? Math.max(0, wShape) : 0;
    this.wPopShape = this.hasGeometry ? Math.max(0, wPopShape) : 0;
    this.wCut = Math.max(0, wCut);
    // A move changes the cut count by the difference between a zone's
    // neighbour counts in two regions, which depends on local degree and not
    // on N at all -- so unlike the demographic terms this scale is fixed with N.
    //
    // meanDegree/3 is the per-move size, but that is the wrong yardstick here.
    // Every other term can be shifted by a single well-chosen move; the cut
    // count is structural, and moving a town out of one region takes a long
    // run of consecutive moves against population pressure. Calibrated by what
    // actually works instead, which is 8x stronger, so weight 1 is a setting
    // worth using rather than one that does almost nothing.
    this.sigmaCut = this.meanDegree / 24;
    this.weightSum = this._weightSum();
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
    for (const d of this.terms) {
      d.rSum = new Float64Array(N);
      d.rN = new Float64Array(N);
    }
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

  /* --- demographics ------------------------------------------------------ */

  /* One move shifts a region's value for a demographic by about
   *   (zone n / region n) * (zone value - region value)  =  vSpread * N / n
   * The value is intensive -- a ratio, not a sum -- so unlike the population
   * term this scales with N. Closed form, nothing measured at runtime. */
  _weightSum() {
    let total = this.wPop + this.wShape + this.wPopShape + this.wCut;
    for (const d of this.terms) total += d.weight;
    return total || 1;
  }

  _demoSigma(d, N) {
    const delta = (d.vSpread * N) / this.n;
    if (d.mode === 'gerrymander') {
      // The logistic's steepest slope, at the threshold, is 1/(4s).
      return delta / (4 * Math.max(1e-6, d.steepness));
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
    return 2 * d.rSpread * delta;
  }

  /* The term for one region value, already signed so lower is better in every
   * mode. Extreme is average negated: one minimises the variance of regional
   * values, the other maximises it. */
  _demoTermFrom(d, x) {
    if (d.mode === 'gerrymander') {
      const s = Math.max(1e-6, d.steepness);
      // Saturates above the threshold, still pulls below it, steepest at it.
      // exp() overflowing to Infinity gives 0 here, which is the right limit.
      const u = d.above ? (x - d.threshold) / s : (d.threshold - x) / s;
      return 1 / (1 + Math.exp(u));
    }
    const gap = x - d.mean;
    if (d.mode === 'average') return gap * gap;
    if (d.mode === 'extreme') {
      // Capped, and in this direction only -- see EXTREME_CAP.
      const held = Math.min(Math.abs(gap), d.cap);
      return -held * held;
    }
    return 0;
  }

  _demoValue(d, r) {
    return d.rN[r] ? d.rSum[r] / d.rN[r] : d.mean;
  }

  /* The best other party's share of a region, under the same hypothetical the
   * caller is pricing. Only gerrymander mode needs these: the margin is what
   * decides a first-past-the-post seat. */
  _partyBest(r, skip) {
    let best = 0;
    for (const q of this.parties) {
      if (q === skip) continue;
      const v = this._demoValue(q, r);
      if (v > best) best = v;
    }
    return best;
  }

  _partyBestWith(r, z, sign, skip) {
    let best = 0;
    for (const q of this.parties) {
      if (q === skip) continue;
      const n = q.rN[r] + sign * q.zN[z];
      const v = n > 0 ? (q.rSum[r] + sign * q.zValue[z] * q.zN[z]) / n : q.mean;
      if (v > best) best = v;
    }
    return best;
  }

  _partyBestWithAgg(r, g, sign, skip) {
    let best = 0;
    for (const q of this.parties) {
      if (q === skip) continue;
      const n = q.rN[r] + sign * g.demo[q.slot].n;
      const v = n > 0 ? (q.rSum[r] + sign * g.demo[q.slot].sum) / n : q.mean;
      if (v > best) best = v;
    }
    return best;
  }

  /* One side of a candidate recombination cut: `piece` takes the subtree's own
   * totals, otherwise the rest of the two regions. */
  _partyBestSplit(c, skip, piece) {
    let best = 0;
    for (const q of this.parties) {
      if (q === skip) continue;
      const n = piece ? q.sN[c] : q.sN[0] - q.sN[c];
      const sum = piece ? q.sSum[c] : q.sSum[0] - q.sSum[c];
      const v = n > 0 ? sum / n : q.mean;
      if (v > best) best = v;
    }
    return best;
  }

  /* What a term scores on: a share, or a winning margin for a party being
   * gerrymandered. */
  _demoTerm(d, r) {
    const x = this._demoValue(d, r);
    return this._demoTermFrom(d,
      d.isParty && d.mode === 'gerrymander' ? x - this._partyBest(r, d) : x);
  }

  _demoTermWith(d, r, z, sign) {
    const n = d.rN[r] + sign * d.zN[z];
    if (n <= 0) return this._demoTermFrom(d, d.mean);
    const x = (d.rSum[r] + sign * d.zValue[z] * d.zN[z]) / n;
    return this._demoTermFrom(d,
      d.isParty && d.mode === 'gerrymander' ? x - this._partyBestWith(r, z, sign, d) : x);
  }

  _demoTermWithAgg(d, r, g, sign, slot) {
    const n = d.rN[r] + sign * g.demo[slot].n;
    if (n <= 0) return this._demoTermFrom(d, d.mean);
    const x = (d.rSum[r] + sign * g.demo[slot].sum) / n;
    return this._demoTermFrom(d,
      d.isParty && d.mode === 'gerrymander' ? x - this._partyBestWithAgg(r, g, sign, d) : x);
  }

  _demoTermSplit(d, c, piece) {
    const n = piece ? d.sN[c] : d.sN[0] - d.sN[c];
    if (n <= 0) return this._demoTermFrom(d, d.mean);
    const x = (piece ? d.sSum[c] : d.sSum[0] - d.sSum[c]) / n;
    return this._demoTermFrom(d,
      d.isParty && d.mode === 'gerrymander' ? x - this._partyBestSplit(c, d, piece) : x);
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
    if (geom) {
      this.shapeRaw -= this._penalty(r) - 1;
      this.popShapeRaw -= this._penaltyPop(r) - 1;
    }
    for (const d of this.terms) {
      if (d.mode !== 'off') d.raw -= this._demoTerm(d, r);
    }
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

    for (const d of this.terms) {
      d.rSum[r] += sign * d.zValue[z] * d.zN[z];
      d.rN[r] += sign * d.zN[z];
    }

    if (geom) {
      this.shapeRaw += this._penalty(r) - 1;
      this.popShapeRaw += this._penaltyPop(r) - 1;
    }
    for (const d of this.terms) {
      if (d.mode !== 'off') d.raw += this._demoTerm(d, r);
    }
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
    const cutting = this.wCut > 0;
    const penNow = shaped ? this._penalty(region) : 0;
    const penPopNow = peopled ? this._penaltyPop(region) : 0;
    const demoNow = this.terms.map(
      (d) => (d.weight > 0 ? this._demoTerm(d, region) : 0));
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
      for (let k = 0; k < this.terms.length; k++) {
        const d = this.terms[k];
        if (d.weight <= 0) continue;
        delta += (d.weight * (this._demoTermWith(d, region, z, 1) - demoNow[k]))
          / d.sigma;
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
    const cutting = this.wCut > 0;
    const cutTally = cutting ? this._cutTally(moving) : null;
    const leavingCut = cutting ? cutTally.get(from) || 0 : 0;
    const leaving = shaped ? this._penaltyWithAgg(from, g, -1) - this._penalty(from) : 0;
    const leavingPop = peopled
      ? this._penaltyPopWithAgg(from, g, -1) - this._penaltyPop(from) : 0;
    const leavingDemo = this.terms.map(
      (d, k) => (d.weight > 0
        ? this._demoTermWithAgg(d, from, g, -1, k) - this._demoTerm(d, from) : 0));
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
      for (let k = 0; k < this.terms.length; k++) {
        const d = this.terms[k];
        if (d.weight <= 0) continue;
        const joining = this._demoTermWithAgg(d, r, g, 1, k) - this._demoTerm(d, r);
        delta += (d.weight * (leavingDemo[k] + joining)) / d.sigma;
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
    for (const slot of g.demo) { slot.sum = 0; slot.n = 0; }
    for (const z of zones) {
      const a = this.za[z];
      const pop = this.pop[z];
      const x = this.zx[z];
      const y = this.zy[z];
      const rr = x * x + y * y;
      g.area += a; g.ax += a * x; g.ay += a * y; g.axx += a * rr;
      g.own += this.zOwn[z];
      g.pop += pop; g.px += pop * x; g.py += pop * y; g.pxx += pop * rr;
      for (let k = 0; k < this.terms.length; k++) {
        const d = this.terms[k];
        g.demo[k].sum += d.zValue[z] * d.zN[z];
        g.demo[k].n += d.zN[z];
      }
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
   * demographic sums are all additive, so every term but one comes free.
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
      for (const d of this.terms) {
        d.sSum[i] = d.zValue[g] * d.zN[g];
        d.sN[i] = d.zN[g];
      }
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
      for (const d of this.terms) {
        d.sSum[q] += d.sSum[u];
        d.sN[q] += d.sN[u];
      }
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
    const oldDemo = this.terms.map(
      (d) => this._demoTerm(d, a) + this._demoTerm(d, b));

    const totPop = this._sPop[0];

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
      for (let k = 0; k < this.terms.length; k++) {
        const d = this.terms[k];
        if (d.weight <= 0) continue;
        const nw = this._demoTermSplit(d, c, true) + this._demoTermSplit(d, c, false);
        delta += (d.weight * (nw - oldDemo[k])) / d.sigma;
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
    for (let r = 0; r < this.N; r++) {
      const dev = this.regionPop[r] - this.target;
      total += dev * dev;
      shape += this._penalty(r) - 1;
      popShape += this._penaltyPop(r) - 1;
    }
    this.rawScore = total;
    this.shapeRaw = shape;
    this.popShapeRaw = popShape;
    for (const d of this.terms) {
      let raw = 0;
      for (let r = 0; r < this.N; r++) raw += this._demoTerm(d, r);
      d.raw = raw;
    }
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
    for (const d of this.terms) { d.rSum.fill(0); d.rN.fill(0); }
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
      for (const d of this.terms) {
        d.rSum[r] += d.zValue[z] * d.zN[z];
        d.rN[r] += d.zN[z];
      }
    }
    this._rescore();
  }

  /* Both terms are in units of one typical move, so the weight is a plain
   * relative priority rather than an exchange rate between people and metres. */
  get scorePop() { return this.rawScore / this.eD2; }

  get scoreShape() { return this.shapeRaw / this.sigmaShape; }

  get scorePopShape() { return this.popShapeRaw / this.sigmaPopShape; }

  demoScore(key) {
    const d = this.demoByKey[key];
    return d ? d.raw / d.sigma : 0;
  }

  get scoreCut() { return this.cutRaw / this.sigmaCut; }

  /* Divided by the total weight, so only the ratios matter: (0.1, 1, 1) and
   * (1, 10, 10) are the same objective. */
  get score() {
    return (this.wPop * this.scorePop
      + this.wShape * this.scoreShape
      + this.wPopShape * this.scorePopShape
      + this.wCut * this.scoreCut
      + this.terms.reduce((a, d) => a + d.weight * (d.raw / d.sigma), 0))
      / this.weightSum;
  }

  /* The legible versions: 1 is a circle for land, and for people it is a region
   * whose population is spread evenly across it. The normalised terms above are
   * measured per move, so their absolute values are large and say little. */
  get meanPenalty() { return this.N ? this.shapeRaw / this.N + 1 : 1; }

  get meanPopPenalty() { return this.N ? this.popShapeRaw / this.N + 1 : 1; }

  /* Spread of the regional values for one demographic: falling means the
   * regions are converging on the national figure, rising means they are
   * separating. */
  demoSpread(key) {
    const d = this.demoByKey[key];
    if (!d || !this.N) return 0;
    let mean = 0;
    for (let r = 0; r < this.N; r++) mean += this._demoValue(d, r);
    mean /= this.N;
    let v = 0;
    for (let r = 0; r < this.N; r++) {
      const gap = this._demoValue(d, r) - mean;
      v += gap * gap;
    }
    return Math.sqrt(v / this.N);
  }

  /* --- election readouts --------------------------------------------------
   * A party's votes in a region are its term's own running sum. */
  regionPartyVotes(key, r) {
    const d = this.demoByKey[key];
    return d && d.rSum.length ? d.rSum[r] : 0;
  }

  regionPartyShare(key, r) {
    const d = this.demoByKey[key];
    return d ? this._demoValue(d, r) : 0;
  }

  /* First past the post: the party with most votes. Ties go to the earlier
   * party, which is the order in the voter file. */
  regionWinner(r) {
    let best = null;
    let bestVotes = -1;
    for (const q of this.parties) {
      const v = q.rSum.length ? q.rSum[r] : 0;
      if (v > bestVotes) { bestVotes = v; best = q; }
    }
    return best ? best.key : null;
  }

  /* Regions this party wins, and its margin over the best rival. */
  partySeats(key) {
    if (!this.demoByKey[key]) return 0;
    let seats = 0;
    for (let r = 0; r < this.N; r++) if (this.regionWinner(r) === key) seats++;
    return seats;
  }

  partyMargin(key, r) {
    const d = this.demoByKey[key];
    if (!d) return 0;
    return this._demoValue(d, r) - this._partyBest(r, d);
  }

  /* Regions on the wanted side of the threshold. */
  demoSeats(key) {
    const d = this.demoByKey[key];
    if (!d) return 0;
    if (d.isParty) return this.partySeats(key);
    let seats = 0;
    for (let r = 0; r < this.N; r++) {
      const x = this._demoValue(d, r);
      if (d.above ? x >= d.threshold : x <= d.threshold) seats++;
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
  setWeights(wPop, wShape, wPopShape, wCut = this.wCut, demoWeights = null) {
    const p = Math.max(0, wPop);
    const l = this.hasGeometry ? Math.max(0, wShape) : 0;
    const q = this.hasGeometry ? Math.max(0, wPopShape) : 0;
    const c = Math.max(0, wCut);
    const wanted = this.terms.map((d) => {
      const w = demoWeights && demoWeights[d.key] !== undefined
        ? demoWeights[d.key] : d.weight;
      return d.mode === 'off' ? 0 : Math.max(0, w);
    });
    let changed = p !== this.wPop || l !== this.wShape || q !== this.wPopShape
      || c !== this.wCut;
    this.terms.forEach((d, k) => { if (wanted[k] !== d.weight) changed = true; });
    if (!changed) return false;
    this.wPop = p;
    this.wShape = l;
    this.wPopShape = q;
    this.wCut = c;
    this.terms.forEach((d, k) => { d.weight = wanted[k]; });
    this.weightSum = this._weightSum();
    this.bestScore = Infinity;
    // A partial map cannot be compared against a complete one; the build phase
    // records the first comparable state when it finishes.
    if (this.assigned >= this.n) this._recordBest();
    return true;
  }

  setPopWeight(w) { return this.setWeights(w, this.wShape, this.wPopShape); }

  setDemoWeight(key, w) {
    return this.setWeights(this.wPop, this.wShape, this.wPopShape, this.wCut,
      { [key]: w });
  }

  /* Mode, threshold, steepness and direction all change what the term measures,
   * so the running total has to be rebuilt from scratch and best-so-far goes
   * with it -- anything recorded under the old settings is not comparable. */
  setDemographic(key, mode, threshold, steepness, above) {
    const d = this.demoByKey[key];
    if (!d) return false;
    if (mode === d.mode && threshold === d.threshold
        && steepness === d.steepness && above === d.above) return false;
    d.mode = mode;
    d.threshold = threshold;
    d.steepness = steepness;
    d.above = above;
    if (mode === 'off') d.weight = 0;
    this.weightSum = this._weightSum();
    d.sigma = this._demoSigma(d, this.N);
    // The term itself changed shape, so its running total is rebuilt.
    d.raw = 0;
    for (let r = 0; r < this.N; r++) d.raw += this._demoTerm(d, r);
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
  regionDemo(key, r) {
    const d = this.demoByKey[key];
    return d ? this._demoValue(d, r) : 0;
  }

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
      demo: Object.fromEntries(
        this.terms.map((d) => [d.key, this._demoValue(d, r)])),
    }));
  }
}
