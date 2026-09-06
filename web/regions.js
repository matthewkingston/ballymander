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

/* --- model --------------------------------------------------------------- */

class RegionModel {
  /* graph: a DZGraph. popByCode: { [code]: number }. */
  constructor(graph, popByCode) {
    this.codes = [...graph.zones].sort();
    this.n = this.codes.length;
    this.index = new Map(this.codes.map((code, i) => [code, i]));
    this.nbr = this.codes.map((code) =>
      graph.neighbours(code).map((other) => this.index.get(other)));

    this.pop = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) this.pop[i] = popByCode[this.codes[i]] || 0;
    this.totalPop = this.pop.reduce((a, b) => a + b, 0);
    // sigma^2 for the population term: the scale of one typical move.
    this.eD2 = this.pop.reduce((a, b) => a + b * b, 0) / this.n;

    this.assign = new Int32Array(this.n);
    this.bestAssign = new Int32Array(this.n);
    this._seen = new Int32Array(this.n);   // BFS marks, stamped rather than cleared
    this._stamp = 0;

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
    this.bestScore = Infinity;
    this.steps = 0;
    this.moves = 0;
  }

  /* Seed N regions and prepare the build phase. */
  start(N, seed, temperature = 1) {
    this.reset();
    this.N = N;
    this.target = this.totalPop / N;
    this.temperature = temperature;
    this.rng = mulberry32(seed);
    this.regionPop = new Float64Array(N);
    this.regionSize = new Int32Array(N);
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

  /* --- build phase ------------------------------------------------------- */

  /* One assignment. Returns false when every zone is assigned. */
  buildStep() {
    if (this.assigned >= this.n) return false;

    let region = -1;
    for (let r = 0; r < this.N; r++) {
      if (this.openNbrs[r].size === 0) continue;
      if (region < 0 || this.regionPop[r] < this.regionPop[region]) region = r;
    }
    // The DZ graph is one connected component, so while anything is unassigned
    // some region borders it. Reaching here would mean that broke.
    if (region < 0) return false;

    const deviation = this.regionPop[region] - this.target;
    let pick = -1;
    let pickDelta = Infinity;
    for (const z of this.openNbrs[region]) {
      const d = this.pop[z];
      const delta = d * (d + 2 * deviation);
      if (delta < pickDelta || (delta === pickDelta && z < pick)) {
        pickDelta = delta;
        pick = z;
      }
    }

    this._place(pick, region);
    for (const w of this.nbr[pick]) {
      if (this.assign[w] < 0) this.openNbrs[region].add(w);
    }
    this.steps++;
    // A partial map cannot be compared against a complete one, so the first
    // state worth recording is the one where every zone has a region.
    if (this.assigned >= this.n) this._recordBest();
    return true;
  }

  _place(z, region) {
    const before = this.regionPop[region] - this.target;
    this.assign[z] = region;
    this.regionPop[region] += this.pop[z];
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
    if (!this._connectedWithout(from, z)) return false;

    const d = this.pop[z];
    const candidates = [from];
    const deltas = [0];
    const seen = new Set([from]);
    for (const w of this.nbr[z]) {
      const r = this.assign[w];
      if (r < 0 || seen.has(r)) continue;
      seen.add(r);
      candidates.push(r);
      deltas.push(2 * d * (d + this.regionPop[r] - this.regionPop[from]) / this.eD2);
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
    this._move(z, from, to);
    this.moves++;
    this._recordBest();
    return true;
  }

  _move(z, from, to) {
    const d = this.pop[z];
    const a0 = this.regionPop[from] - this.target;
    const b0 = this.regionPop[to] - this.target;
    this.regionPop[from] -= d;
    this.regionPop[to] += d;
    this.regionSize[from]--;
    this.regionSize[to]++;
    this.assign[z] = to;
    const a1 = this.regionPop[from] - this.target;
    const b1 = this.regionPop[to] - this.target;
    this.rawScore += a1 * a1 - a0 * a0 + b1 * b1 - b0 * b0;

    this._touchFrontier(z);
    for (const w of this.nbr[z]) this._touchFrontier(w);
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
    for (let r = 0; r < this.N; r++) {
      const dev = this.regionPop[r] - this.target;
      total += dev * dev;
    }
    this.rawScore = total;
    return total;
  }

  get score() { return this.rawScore / this.eD2; }

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

  /* Put the map back to the best state seen -- with a stochastic rule the
   * state when the user stops is not the best one visited. */
  restoreBest() {
    if (this.bestScore === Infinity) return;
    this.assign.set(this.bestAssign);
    this.regionPop.fill(0);
    this.regionSize.fill(0);
    for (let z = 0; z < this.n; z++) {
      const r = this.assign[z];
      if (r < 0) continue;
      this.regionPop[r] += this.pop[z];
      this.regionSize[r]++;
    }
    this._rescore();
    this.frontier = [];
    this.frontierPos.fill(-1);
    for (let z = 0; z < this.n; z++) this._touchFrontier(z);
  }

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
    }));
  }
}
