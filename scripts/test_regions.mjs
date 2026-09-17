/* Headless test of web/regions.js against the real Data Zone data.
 *
 * The region model is deliberately DOM-free so it can be exercised here rather
 * than only through the browser. Run: node scripts/test_regions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (file, name) =>
  new Function(`${fs.readFileSync(path.join(ROOT, file), 'utf8')}; return ${name};`)();

const DZGraph = load('web/graph.js', 'DZGraph');
const { RegionModel, zoneGeometry, zoneDemographics } = load('web/regions.js',
  '{ RegionModel, zoneGeometry, zoneDemographics }');

const graph = new DZGraph(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz_adjacency.json'), 'utf8')));
const feats = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz.geojson'), 'utf8')).features;
const pops = Object.fromEntries(feats.map((f) => [f.properties.code, f.properties.pop]));
const geom = zoneGeometry(feats);
const demo = zoneDemographics(feats);
const voters = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz_voters.json'), 'utf8'));

const failures = [];
function check(ok, msg) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* Independent contiguity check -- deliberately not the model's own. */
function regionsContiguous(model) {
  const members = Array.from({ length: model.N }, () => []);
  for (let z = 0; z < model.n; z++) {
    if (model.assign[z] >= 0) members[model.assign[z]].push(z);
  }
  for (let r = 0; r < model.N; r++) {
    if (members[r].length === 0) return `region ${r} is empty`;
    const want = new Set(members[r]);
    const seen = new Set([members[r][0]]);
    const stack = [members[r][0]];
    while (stack.length) {
      for (const w of model.nbr[stack.pop()]) {
        if (want.has(w) && !seen.has(w)) { seen.add(w); stack.push(w); }
      }
    }
    if (seen.size !== want.size) {
      return `region ${r} is in ${want.size - seen.size + 1} pieces`;
    }
  }
  return null;
}

function frontierFromScratch(model) {
  const set = new Set();
  for (let z = 0; z < model.n; z++) {
    const r = model.assign[z];
    if (r < 0) continue;
    for (const w of model.nbr[z]) {
      if (model.assign[w] >= 0 && model.assign[w] !== r) { set.add(z); break; }
    }
  }
  return set;
}

const model = new RegionModel(graph, pops, geom, demo);
console.log(`\nregion model over ${model.n.toLocaleString()} zones, `
  + `total pop ${model.totalPop.toLocaleString()}, E[d^2] = `
  + `${Math.round(model.eD2).toLocaleString()}\n`);

/* --- build phase --------------------------------------------------------- */
console.log('build phase');
model.start(18, 1);
let guard = 0;
while (model.buildStep()) if (++guard > 1e5) break;

check(model.assigned === model.n,
  `every zone assigned (${model.assigned.toLocaleString()}/${model.n.toLocaleString()})`);
check(model.assign.every((r) => r >= 0 && r < 18), 'every assignment is a valid region');
check(regionsContiguous(model) === null,
  `every region contiguous after build (${regionsContiguous(model) || 'ok'})`);
check([...model.regionSize].every((s) => s > 0), 'no region is empty');

const scratch = frontierFromScratch(model);
check(scratch.size === model.frontier.length
  && model.frontier.every((z) => scratch.has(z)),
  `frontier matches a from-scratch recompute (${model.frontier.length} vs ${scratch.size})`);

const built = model.scorePop;
const rescored = model._rescore() / model.eD2;
check(Math.abs(built - rescored) < 1e-6 * Math.max(1, built),
  `incremental score matches a full rescore (${built.toFixed(3)} vs ${rescored.toFixed(3)})`);

/* --- sealing pockets ----------------------------------------------------- */
console.log('\npocket sealing');

/* The invariant the sweep must leave behind: no unassigned pocket bordered by
 * exactly one region, because such a pocket can only ever go to that region. */
function lonePocketExists(m) {
  const seen = new Set();
  for (let start = 0; start < m.n; start++) {
    if (m.assign[start] >= 0 || seen.has(start)) continue;
    const pocket = [start];
    seen.add(start);
    const owners = new Set();
    for (let i = 0; i < pocket.length; i++) {
      for (const w of m.nbr[pocket[i]]) {
        if (m.assign[w] < 0) {
          if (!seen.has(w)) { seen.add(w); pocket.push(w); }
        } else {
          owners.add(m.assign[w]);
        }
      }
    }
    if (owners.size === 1) return true;
  }
  return false;
}

const sealer = new RegionModel(graph, pops, geom, demo);
sealer.start(18, 5);
check(sealer.sweepInterval === 25,
  `sweepInterval survives start() (${sealer.sweepInterval})`);
let sweeps = 0;
while (sealer.buildStep()) {
  if (sealer.steps % 25 === 0) { sealer.sealPockets(); sweeps++; }
}
check(!lonePocketExists(sealer), 'no single-owner pocket is left unassigned');
check(sealer.sealed > 0, `pockets actually get sealed (${sealer.sealed} zones)`);
check(sealer.assigned === sealer.n, 'sealing still assigns every zone');
check(regionsContiguous(sealer) === null,
  'sealing keeps every region contiguous -- a pocket touching one region joins it whole');

const bare = new RegionModel(graph, pops, geom, demo);
bare.sweepInterval = Infinity;
bare.start(18, 5);
while (bare.buildStep());
check(bare.sealed === 0, 'sweepInterval = Infinity turns sealing off');
check(bare.assigned === bare.n, 'the build still completes without sealing');
console.log(`  build score ${bare.scorePop.toFixed(0)} without sealing, `
  + `${sealer.scorePop.toFixed(0)} with (${sealer.steps.toLocaleString()} steps `
  + `vs ${bare.steps.toLocaleString()})`);

const seal2 = new RegionModel(graph, pops, geom, demo);
seal2.start(18, 5);
while (seal2.buildStep());
const seal3 = new RegionModel(graph, pops, geom, demo);
seal3.start(18, 5);
while (seal3.buildStep());
check(seal2.assign.every((v, i) => v === seal3.assign[i]),
  'sealing stays deterministic for a given seed');

/* --- determinism --------------------------------------------------------- */
const a = new RegionModel(graph, pops, geom, demo);
a.start(18, 42); while (a.buildStep());
const b = new RegionModel(graph, pops, geom, demo);
b.start(18, 42); while (b.buildStep());
const c = new RegionModel(graph, pops, geom, demo);
c.start(18, 43); while (c.buildStep());
check(a.assign.every((v, i) => v === b.assign[i]), 'same seed gives an identical map');
check(!a.assign.every((v, i) => v === c.assign[i]), 'a different seed gives a different map');

/* --- optimisation phase -------------------------------------------------- */
console.log('\noptimisation phase');
let worstSeen = 0;
let bestViolation = false;
for (let i = 0; i < 50000; i++) {
  model.optimiseStep();
  if (model.score > worstSeen) worstSeen = model.score;
  if (model.bestScore > model.score + 1e-9) bestViolation = true;
}
check(!bestViolation, 'best-so-far is never worse than the current score');
check(regionsContiguous(model) === null,
  `every region still contiguous after 50,000 steps (${regionsContiguous(model) || 'ok'})`);
check(model.assigned === model.n, 'still every zone assigned');
check([...model.regionSize].every((s) => s > 0), 'still no empty region');

const scratch2 = frontierFromScratch(model);
check(scratch2.size === model.frontier.length
  && model.frontier.every((z) => scratch2.has(z)),
  `frontier still matches a recompute (${model.frontier.length} vs ${scratch2.size})`);

const drift = Math.abs(model.score - model._rescore() / model.eD2);
check(drift < 1e-6 * Math.max(1, model.score),
  `no score drift over 50,000 incremental updates (${drift.toExponential(2)})`);

model.restoreBest();
check(Math.abs(model.score - model.bestScore) < 1e-6 * Math.max(1, model.bestScore),
  'restoreBest reproduces the best score exactly');
check(regionsContiguous(model) === null, 'restored best state is contiguous');

/* --- branch moves -------------------------------------------------------- */
console.log('\nbranch moves');

const branchOn = new RegionModel(graph, pops, geom, demo);
branchOn.start(18, 5, { wShape: 1, wPopShape: 1 });
while (branchOn.buildStep());
for (let i = 0; i < 50000; i++) branchOn.optimiseStep();

const branchOff = new RegionModel(graph, pops, geom, demo);
branchOff.allowBranchMoves = false;
branchOff.start(18, 5, { wShape: 1, wPopShape: 1 });
while (branchOff.buildStep());
for (let i = 0; i < 50000; i++) branchOff.optimiseStep();

check(branchOn.allowBranchMoves === true, 'allowBranchMoves survives start()');
check(branchOff.branched === 0, 'off means no branch moves happen at all');
check(branchOn.branched > 0,
  `on means they actually fire (${branchOn.branched.toLocaleString()} of `
  + `${branchOn.moves.toLocaleString()} moves)`);

/* The whole point: moving a cut vertex plus its smaller side must leave both
 * regions in one piece. This is the check that would catch a wrong component
 * choice, and it is done independently of the model's own routine. */
check(regionsContiguous(branchOn) === null,
  `every region contiguous after branch moves (${regionsContiguous(branchOn) || 'ok'})`);
check([...branchOn.regionSize].every((s) => s > 0), 'no region emptied by a branch move');
check(branchOn.assigned === branchOn.n, 'every zone still assigned');

/* _moveSet updates the frontier only after the whole set has moved; getting
 * that wrong would leave it out of step with reality. */
const bScratch = frontierFromScratch(branchOn);
check(bScratch.size === branchOn.frontier.length
  && branchOn.frontier.every((z) => bScratch.has(z)),
  `frontier survives multi-zone moves (${branchOn.frontier.length} vs ${bScratch.size})`);

const bRaw = branchOn.shapeRaw;
const bPopRaw = branchOn.popShapeRaw;
const bScore = branchOn.scorePop;
branchOn._resum();
check(near(bRaw, branchOn.shapeRaw, 1e-6 * Math.max(1, Math.abs(bRaw)))
  && near(bPopRaw, branchOn.popShapeRaw, 1e-6 * Math.max(1, Math.abs(bPopRaw)))
  && near(bScore, branchOn.scorePop, 1e-6 * Math.max(1, bScore)),
  'no drift in any incremental total across branch moves');

/* _branchOf directly: find a real cut vertex and check what it hands back. */
let probed = 0;
for (const z of branchOn.frontier) {
  const r = branchOn.assign[z];
  if (branchOn.regionSize[r] <= 1 || branchOn._connectedWithout(r, z)) continue;
  const moving = branchOn._branchOf(r, z);
  check(moving !== null && moving[0] === z, 'the branch leads with the zone itself');
  const comps = branchOn._componentsWithout(r, z);
  const total = comps.reduce((a, c) => a + c.length, 0);
  check(total === branchOn.regionSize[r] - 1,
    `the pieces account for the whole region minus the zone (${total} vs `
    + `${branchOn.regionSize[r] - 1})`);
  check(moving.length - 1 <= total / 2,
    `the branch is the smaller side (${moving.length - 1} of ${total})`);
  check(moving.length < branchOn.regionSize[r], 'something is always left behind');
  probed = comps.length;
  break;
}
check(probed >= 2, `found a real cut vertex to probe (${probed} pieces)`);

console.log(`  branch moves off: score ${branchOff.scorePop.toFixed(1)}, `
  + `land ${branchOff.meanPenalty.toFixed(3)}`);
console.log(`  branch moves on : score ${branchOn.scorePop.toFixed(1)}, `
  + `land ${branchOn.meanPenalty.toFixed(3)}, `
  + `${(100 * branchOn.branched / branchOn.moves).toFixed(1)}% of moves were branches`);

/* --- recombination -------------------------------------------------------- */
console.log('\nrecombination');

const recom = new RegionModel(graph, pops, geom, demo);
recom.recomInterval = Infinity;          // drive it by hand
/* Every demographic is live, in a mix of modes, because each keeps its own pair
 * of scratch arrays through the spanning-tree pass and each contributes its own
 * subtree sums. Mixing extreme with gerrymander exercises both shapes of the
 * term at once, and running all of them is what would catch a scratch array
 * shared between two of them. */
recom.start(18, 5, { wShape: 1, wPopShape: 1, wCut: 1, demo: {
  rel: { weight: 1, mode: 'extreme' },
  age: { weight: 1, mode: 'gerrymander', threshold: 41, above: true },
  orient: { weight: 1, mode: 'average' },
  grade: { weight: 1, mode: 'gerrymander', threshold: 0.51, above: false },
} });
while (recom.buildStep());
for (let i = 0; i < 5000; i++) recom.optimiseStep();
check(recom.recombinations === 0, 'recomInterval = Infinity turns it off');

/* The check that matters. Every candidate cut is scored from subtree sums, and
 * the cut-edge part from the handshake identity plus an LCA pass -- none of
 * which is verified by anything else. If any of it is wrong, the delta the
 * choice was made on will not match the score the map actually ends up with. */
const shadow = new Int32Array(recom.n);
let applied = 0;
let refused = 0;
let worstDelta = 0;
let regionsTouched = 0;
let overlapViolation = 0;
for (let k = 0; k < 800; k++) {
  shadow.set(recom.assign);
  const before = recom.score;
  const seen = recom.recombinations;
  recom.recombineStep();
  if (recom.recombinations === seen) { refused++; continue; }
  applied++;
  worstDelta = Math.max(worstDelta,
    Math.abs((before + recom.lastRecomDelta) - recom.score)
      / Math.max(1, Math.abs(recom.score)));

  /* Exactly two regions may change, and the overlap rule means the piece that
   * keeps a region's number holds most of its people -- so less than half the
   * union's population can change hands. */
  const touched = new Set();
  let movedPop = 0;
  for (let z = 0; z < recom.n; z++) {
    if (shadow[z] === recom.assign[z]) continue;
    touched.add(shadow[z]);
    touched.add(recom.assign[z]);
    movedPop += recom.pop[z];
  }
  regionsTouched = Math.max(regionsTouched, touched.size);
  let unionPop = 0;
  for (let z = 0; z < recom.n; z++) if (touched.has(shadow[z])) unionPop += recom.pop[z];
  if (movedPop > unionPop / 2) overlapViolation++;
}
check(applied > 0, `recombinations happen (${applied} of ${applied + refused} attempts)`);
check(refused > 0,
  `and the status quo sometimes wins, so it is really a candidate (${refused} refused)`);
check(worstDelta < 1e-9,
  `the predicted delta matches a real rescore (worst relative error ${worstDelta.toExponential(1)})`);
check(regionsTouched === 2, `exactly two regions change per step (${regionsTouched})`);
check(overlapViolation === 0,
  `the piece keeping a number holds most of its people (${overlapViolation} violations)`);

check(regionsContiguous(recom) === null,
  `every region contiguous after ${applied} recombinations -- structural, not checked`);
check([...recom.regionSize].every((s) => s > 0), 'no region emptied');
check(recom.assigned === recom.n, 'every zone still assigned');
check(recom.cutRaw === recom._countCut(), 'the cut count survives recombination');

/* What it actually buys: a better map for the same number of steps. Seed 7 is
 * the hard case -- it used to be a sealed pocket, which pocket sealing largely
 * fixed, but it is still where single-zone moves make the slowest progress. */
function after(steps, interval) {
  const m = new RegionModel(graph, pops, geom, demo);
  m.recomInterval = interval;
  m.start(18, 7, { wShape: 1, wPopShape: 1 });
  while (m.buildStep());
  while (m.steps < steps) m.optimiseStep();
  return m;
}
const flipsOnly = after(50000, Infinity);
const withRecom = after(50000, 200);
console.log(`  seed 7 after 50,000 steps: best ${flipsOnly.bestScore.toFixed(0)} on flips `
  + `alone, ${withRecom.bestScore.toFixed(0)} with recombination `
  + `(${withRecom.recombinations} of them)`);
check(withRecom.bestScore < flipsOnly.bestScore,
  `recombination gets further in the same steps `
  + `(${withRecom.bestScore.toFixed(0)} vs ${flipsOnly.bestScore.toFixed(0)})`);

/* --- shape term ---------------------------------------------------------- */
console.log('\nshape (moment of inertia)');

/* Against analytic values, independent of any NI data: a disc is 1, a square is
 * pi/3, a 4:1 rectangle 2.22. This is what catches a wrong constant or a
 * dropped self-moment. */
function gridPenalty(w, h) {
  let A = 0; let Sx = 0; let Sy = 0; let Sxx = 0; let own = 0;
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      const x = i + 0.5; const y = j + 0.5;
      A += 1; Sx += x; Sy += y; Sxx += x * x + y * y; own += 1 / (2 * Math.PI);
    }
  }
  return RegionModel.prototype._penaltyFrom.call(null, A, Sx, Sy, Sxx, own);
}
check(gridPenalty(1, 1) === 1, `a single cell scores exactly 1 (${gridPenalty(1, 1)})`);
check(near(gridPenalty(40, 40), Math.PI / 3, 0.002),
  `a square scores pi/3 (${gridPenalty(40, 40).toFixed(4)} vs ${(Math.PI / 3).toFixed(4)})`);
check(near(gridPenalty(80, 20), 2.225, 0.01),
  `a 4:1 rectangle scores 2.22 (${gridPenalty(80, 20).toFixed(4)})`);
check(gridPenalty(160, 10) > gridPenalty(80, 20),
  'a 16:1 rectangle scores worse than a 4:1');

/* People-weighted moment. With uniform density it must agree with the land
 * moment -- that is the whole design: they only diverge where density does. */
function gridPopPenalty(w, h, popAt) {
  let A = 0; let P = 0; let Px = 0; let Py = 0; let Pxx = 0;
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      const x = i + 0.5; const y = j + 0.5; const p = popAt(i, j);
      A += 1; P += p; Px += p * x; Py += p * y; Pxx += p * (x * x + y * y);
    }
  }
  return RegionModel.prototype._penaltyPopFrom.call(null, P, Px, Py, Pxx, A);
}
const uniform = () => 1;
check(near(gridPopPenalty(40, 40, uniform), Math.PI / 3, 0.005),
  `uniform density over a square gives pi/3, same as land `
  + `(${gridPopPenalty(40, 40, uniform).toFixed(4)})`);
check(near(gridPopPenalty(80, 20, uniform), 2.225, 0.01),
  `uniform density over a 4:1 rectangle gives 2.22 `
  + `(${gridPopPenalty(80, 20, uniform).toFixed(4)})`);
const corner = (i, j) => (i === 0 && j === 0 ? 1 : 0);
check(gridPopPenalty(40, 40, corner) === 0,
  'population in a single cell scores 0 -- concentration earns credit');
const ribbon = (i, j) => (j === 20 ? 1 : 0);
check(gridPopPenalty(40, 40, ribbon) < 1,
  `people along a ribbon inside a square are still tighter than the square `
  + `(${gridPopPenalty(40, 40, ribbon).toFixed(3)})`);
check(gridPopPenalty(160, 10, uniform) > gridPopPenalty(80, 20, uniform),
  'a more elongated region strings its people out further');

/* Weight 0 must be exactly the old behaviour, geometry present or not. */
const off = new RegionModel(graph, pops, geom, demo);
off.start(18, 5, { wShape: 0 });
while (off.buildStep());
for (let i = 0; i < 50000; i++) off.optimiseStep();
const noGeom = new RegionModel(graph, pops);          // shape term unavailable
noGeom.start(18, 5, { wShape: 1 });                            // weight ignored
while (noGeom.buildStep());
for (let i = 0; i < 50000; i++) noGeom.optimiseStep();
check(off.assign.every((v, i) => v === noGeom.assign[i]),
  'weight 0 is exactly the behaviour without the shape term at all');

/* Sums are maintained incrementally through tens of thousands of moves and are
 * a small difference of large numbers, so drift is the thing to watch. */
const on = new RegionModel(graph, pops, geom, demo);
on.start(18, 5, { wShape: 1 });
while (on.buildStep());
for (let i = 0; i < 50000; i++) on.optimiseStep();
const beforeResum = on.shapeRaw;
on._resum();
check(near(beforeResum, on.shapeRaw, 1e-6 * Math.max(1, Math.abs(on.shapeRaw))),
  `no drift in the shape sums over 50,000 moves `
  + `(${beforeResum.toFixed(9)} vs ${on.shapeRaw.toFixed(9)})`);

/* The trade-off is real and the test should say so rather than hide it. */
console.log(`  weight 0: mean penalty ${off.meanPenalty.toFixed(3)}, `
  + `max dev ${(off.maxDeviation * 100).toFixed(2)}%`);
console.log(`  weight 1: mean penalty ${on.meanPenalty.toFixed(3)}, `
  + `max dev ${(on.maxDeviation * 100).toFixed(2)}%`);
check(on.meanPenalty < off.meanPenalty,
  `weight 1 makes regions rounder (${on.meanPenalty.toFixed(3)} vs `
  + `${off.meanPenalty.toFixed(3)})`);
check(regionsContiguous(on) === null, 'shaped regions are still contiguous');
check(on.assigned === on.n, 'shaped run still assigns every zone');

/* The people term, on its own and against the land term. */
const people = new RegionModel(graph, pops, geom, demo);
people.start(18, 5, { wShape: 0, wPopShape: 1 });
while (people.buildStep());
for (let i = 0; i < 50000; i++) people.optimiseStep();
const popDrift = people.popShapeRaw;
people._resum();
check(near(popDrift, people.popShapeRaw, 1e-6 * Math.max(1, Math.abs(popDrift))),
  `no drift in the people sums over 50,000 moves `
  + `(${popDrift.toFixed(9)} vs ${people.popShapeRaw.toFixed(9)})`);
console.log(`  neither weight    : land ${off.meanPenalty.toFixed(3)}, `
  + `people ${off.meanPopPenalty.toFixed(3)}`);
console.log(`  land weight only  : land ${on.meanPenalty.toFixed(3)}, `
  + `people ${on.meanPopPenalty.toFixed(3)}`);
console.log(`  people weight only: land ${people.meanPenalty.toFixed(3)}, `
  + `people ${people.meanPopPenalty.toFixed(3)}`);
check(people.meanPopPenalty < on.meanPopPenalty,
  `weighting people beats weighting land at the people measure `
  + `(${people.meanPopPenalty.toFixed(3)} vs ${on.meanPopPenalty.toFixed(3)})`);
check(regionsContiguous(people) === null, 'people-shaped regions are contiguous');

const both = new RegionModel(graph, pops, geom, demo);
both.start(18, 5, { wShape: 1, wPopShape: 1 });
while (both.buildStep());
for (let i = 0; i < 50000; i++) both.optimiseStep();
console.log(`  both              : land ${both.meanPenalty.toFixed(3)}, `
  + `people ${both.meanPopPenalty.toFixed(3)}`);
check(both.meanPenalty < off.meanPenalty && both.meanPopPenalty < off.meanPopPenalty,
  'both weights together improve both measures over no shape term at all');

/* Weight changes re-base best for the people term too. */
const liveP = new RegionModel(graph, pops, geom, demo);
liveP.start(18, 5, {});
while (liveP.buildStep());
for (let i = 0; i < 20000; i++) liveP.optimiseStep();
liveP.setPopShapeWeight(2);
check(near(liveP.bestScore, liveP.score, 1e-9),
  'changing the people weight re-bases best-so-far');
check(liveP.setPopShapeWeight(2) === false, 'the same people weight is a no-op');

/* Only the ratios between weights matter: the score is divided by their sum,
 * so scaling all three must be invisible. Checked through the whole dynamics,
 * not just the score getter -- a weight left out of a delta would show here. */
const small = new RegionModel(graph, pops, geom, demo);
small.start(18, 5, { wShape: 1, wPopShape: 1, wPop: 0.1 });          // land 1, people 1, population 0.1
while (small.buildStep());
for (let i = 0; i < 30000; i++) small.optimiseStep();
const big = new RegionModel(graph, pops, geom, demo);
big.start(18, 5, { wShape: 10, wPopShape: 10, wPop: 1 });            // the same thing, times ten
while (big.buildStep());
for (let i = 0; i < 30000; i++) big.optimiseStep();
check(small.assign.every((v, i) => v === big.assign[i]),
  'scaling every weight by ten gives an identical map');
check(near(small.score, big.score, 1e-9 * Math.max(1, Math.abs(small.score))),
  `and an identical score (${small.score.toFixed(6)} vs ${big.score.toFixed(6)})`);

const even = new RegionModel(graph, pops, geom, demo);
even.start(18, 5, { wShape: 1, wPopShape: 1, wPop: 1 });
while (even.buildStep());
check(near(even.score,
  (even.scorePop + even.scoreShape + even.scorePopShape) / 3, 1e-9 * Math.abs(even.score)),
  'equal weights make the score the mean of the three terms');
check(even.weightSum === 3, `weightSum tracks the weights (${even.weightSum})`);

const popw = new RegionModel(graph, pops, geom, demo);
popw.start(18, 5, { wShape: 1, wPopShape: 1, wPop: 1 });
while (popw.buildStep());
for (let i = 0; i < 20000; i++) popw.optimiseStep();
check(popw.setPopWeight(0.3) === true, 'the population weight is settable');
check(near(popw.bestScore, popw.score, 1e-9),
  'changing the population weight re-bases best-so-far too');
check(popw.setPopWeight(0.3) === false, 'the same population weight is a no-op');

/* Changing the weight mid-run changes the objective, so the old best is not
 * comparable and must not survive. */
const live = new RegionModel(graph, pops, geom, demo);
live.start(18, 5, {});
while (live.buildStep());
for (let i = 0; i < 20000; i++) live.optimiseStep();
live.setShapeWeight(2);
check(near(live.bestScore, live.score, 1e-9),
  'changing the shape weight re-bases best-so-far on the current state');
const rebased = live.bestScore;
check(live.setShapeWeight(2) === false && live.bestScore === rebased,
  'setting the same weight again changes nothing');
check(live.setShapeWeight(0.5) === true, 'a real change is reported as one');

/* --- religion ------------------------------------------------------------ */
console.log('\nreligion');

check(near(model.demoByKey.rel.mean, 0.5111, 5e-4),
  `national value is 0.511 (${model.demoByKey.rel.mean.toFixed(4)})`);

/* The index against the raw NISRA table is checked for every demographic at
 * once, in the section below. */

function relRun(opts, steps = 50000) {
  const m = new RegionModel(graph, pops, geom, demo);
  m.start(18, 5, opts);
  while (m.buildStep());
  for (let i = 0; i < steps; i++) m.optimiseStep();
  m.restoreBest();
  return m;
}
const seatsAt = (m, t, above) =>
  m.summary().filter((r) => (above ? r.demo.rel >= t : r.demo.rel <= t)).length;

const relOff = relRun({});
const relAvg = relRun({ demo: { rel: { weight: 1, mode: 'average' } } });
const relExt = relRun({ demo: { rel: { weight: 1, mode: 'extreme' } } });
console.log(`  off      spread ${relOff.demoSpread('rel').toFixed(3)}   `
  + `range ${Math.min(...relOff.summary().map((r) => r.demo.rel)).toFixed(2)}`
  + `-${Math.max(...relOff.summary().map((r) => r.demo.rel)).toFixed(2)}`);
console.log(`  average  spread ${relAvg.demoSpread('rel').toFixed(3)}   `
  + `range ${Math.min(...relAvg.summary().map((r) => r.demo.rel)).toFixed(2)}`
  + `-${Math.max(...relAvg.summary().map((r) => r.demo.rel)).toFixed(2)}`);
console.log(`  extreme  spread ${relExt.demoSpread('rel').toFixed(3)}   `
  + `range ${Math.min(...relExt.summary().map((r) => r.demo.rel)).toFixed(2)}`
  + `-${Math.max(...relExt.summary().map((r) => r.demo.rel)).toFixed(2)}`);
check(relAvg.demoSpread('rel') < relOff.demoSpread('rel'),
  `average mode narrows the spread (${relAvg.demoSpread('rel').toFixed(3)} vs `
  + `${relOff.demoSpread('rel').toFixed(3)})`);
check(relExt.demoSpread('rel') > relOff.demoSpread('rel'),
  `extreme mode widens it (${relExt.demoSpread('rel').toFixed(3)} vs `
  + `${relOff.demoSpread('rel').toFixed(3)})`);

/* Seats are a coarse integer that moves slowly, so these get more steps than
 * the modes above; 50,000 is not enough to flip one at N=18. */
const GERRY_STEPS = 300000;
const gAbove = relRun({ demo: { rel: { weight: 1, mode: 'gerrymander', threshold: 0.6, above: true } } },
  GERRY_STEPS);
const gBelow = relRun({ demo: { rel: { weight: 1, mode: 'gerrymander', threshold: 0.4, above: false } } },
  GERRY_STEPS);
const marginals = (m, t) => m.summary().filter((r) => Math.abs(r.demo.rel - t) <= 0.05).length;
console.log(`  gerrymander above 0.6: ${seatsAt(gAbove, 0.6, true)}/18 seats `
  + `(${seatsAt(relOff, 0.6, true)}/18 with the term off)`);
console.log(`  gerrymander below 0.4: ${seatsAt(gBelow, 0.4, false)}/18 seats `
  + `(${seatsAt(relOff, 0.4, false)}/18 with the term off)`);
console.log(`  values: ${gAbove.summary().map((r) => r.demo.rel.toFixed(2)).sort().join(' ')}`);
check(seatsAt(gAbove, 0.6, true) > seatsAt(relOff, 0.6, true),
  'gerrymander above wins more regions over the threshold');
check(seatsAt(gBelow, 0.4, false) > seatsAt(relOff, 0.4, false),
  'and the direction toggle wins more the other way');
check(gAbove.demoSeats('rel') === seatsAt(gAbove, 0.6, true),
  "the model's own seat count agrees with an independent one");

/* Packing and cracking means abandoning the middle, so regions vacate the
 * neighbourhood of the threshold. Reported rather than asserted: it is only a
 * meaningful comparison at a fixed seat count, and once recombination started
 * winning extra seats it stopped tracking the objective -- more seats can mean
 * more regions sitting just over the line. Seats above is the assertion. */
console.log(`  regions within 0.05 of the threshold: `
  + `${marginals(relOff, 0.6)} with the term off, ${marginals(gAbove, 0.6)} gerrymandering`);

/* Two more running sums per term, maintained through 50,000 moves, branch moves
 * included. Both terms are checked even though only religion was being steered:
 * age's sums are updated by every move regardless, so this catches a term that
 * is carried along but not threaded through some move type. */
const rawBefore = relExt.demographics.map((d) => d.raw);
for (const d of relExt.demographics) {
  let worstValue = 0;
  for (let r = 0; r < relExt.N; r++) {
    let sum = 0;
    let n = 0;
    for (let z = 0; z < relExt.n; z++) {
      if (relExt.assign[z] === r) { sum += d.zValue[z] * d.zN[z]; n += d.zN[z]; }
    }
    worstValue = Math.max(worstValue, Math.abs(sum / n - relExt._demoValue(d, r)));
  }
  check(worstValue < 1e-9,
    `${d.key} region values match a from-scratch weighted mean `
    + `(worst ${worstValue.toExponential(1)})`);
}
relExt._resum();
relExt.demographics.forEach((d, i) => {
  check(near(rawBefore[i], d.raw, 1e-6 * Math.max(1, Math.abs(rawBefore[i]))),
    `no drift in the ${d.key} total (${rawBefore[i].toFixed(9)} vs ${d.raw.toFixed(9)})`);
});
check(regionsContiguous(relExt) === null, 'religion-steered regions stay contiguous');

/* Without the data the term is inert, whatever is asked for. */
const noRel = new RegionModel(graph, pops, geom);
noRel.start(18, 5, { demo: { rel: { weight: 1, mode: 'average' } } });
while (noRel.buildStep());
for (let i = 0; i < 50000; i++) noRel.optimiseStep();
noRel.restoreBest();
check(noRel.assign.every((v, i) => v === relOff.assign[i]),
  'with no religion data the term is inert whatever the mode');

const relLive = relRun({ demo: { rel: { weight: 1, mode: 'average' } } }, 20000);
check(relLive.setDemographic('rel', 'gerrymander', 0.6, 0.05, true) === true,
  'changing the religion mode is reported as a change');
check(near(relLive.bestScore, relLive.score, 1e-9),
  'changing the religion mode re-bases best-so-far');
check(relLive.setDemographic('rel', 'gerrymander', 0.6, 0.05, true) === false,
  'the same religion settings are a no-op');
check(relLive.setDemographic('rel', 'gerrymander', 0.55, 0.05, true) === true,
  'a threshold change alone counts as a change');

/* --- demographics --------------------------------------------------------- */
/* Everything past religion is generic: the term list in regions.js drives the
 * model, the UI and this. So every demographic present gets the same battery,
 * and adding a fifth adds nothing here. Religion's own section above keeps only
 * what is specific to it.
 *
 * Two things vary between them and are declared rather than derived: the
 * gerrymander thresholds to probe, which have to sit inside each variable's own
 * reachable band, and the raw table to check the zone index against. */
console.log('\ndemographics');

const DEMO_PROBES = {
  rel: { mean: 0.5111, tol: 5e-4, above: 0.6, below: 0.4 },
  age: { mean: 39.6, tol: 0.05, above: 41, below: 38.5 },
  orient: { mean: 0.0227, tol: 5e-4, above: 0.03, below: 0.017 },
  grade: { mean: 0.4829, tol: 5e-4, above: 0.51, below: 0.45 },
};

/* The zone index in the geojson against the raw NISRA table -- what proves the
 * collapse in prepare_attributes.py did what it claims, end to end. `null`
 * means the category is excluded from the numerator *and* the denominator, so
 * these also check that "prefer not to say" and the under-16s never reach the
 * index. `fromCode` is the ordinal path, where the category codes are the
 * values themselves and a label table could not express them. */
const RAW_TABLES = {
  rel: {
    file: 'ni-census21-people-dz21+religion_belong_to_or_brought_up_in_dvo-f4902c4c.json',
    total: 1903158,
    weights: {
      Catholic: 1,
      'Protestant and Other Christian (including Christian related)': 0,
      'Other religions': 0.5,
      None: 0.5,
    },
  },
  age: {
    file: 'ni-census21-people-dz21+age_syoa-6e5d3e2d.json',
    total: 1903347,
    fromCode: true,
  },
  orient: {
    file: 'ni-census21-people-dz21+sexual_orientation_dvo_agg4-4310722c.json',
    total: 1395521,
    weights: {
      'Straight or heterosexual': 0,
      'Gay, lesbian, bisexual, other sexual orientation': 1,
      'Prefer not to say/Not stated': null,
      'No code required': null,
    },
  },
  grade: {
    file: 'ni-census21-people-dz21+social_grade-52ba72e2.json',
    total: 1511617,
    weights: {
      ['AB: Higher and intermediate managerial, administrative and professional '
        + 'occupations']: 1,
      ['C1: Supervisory, clerical, and junior managerial, administrative and '
        + 'professional occupations']: 2 / 3,
      'C2: Skilled manual occupations': 1 / 3,
      ['Semi-skilled and unskilled manual occupations; unemployed and lowest '
        + 'grade occupations']: 0,
      'No code required': null,
    },
  },
};

const demoRun = (opts, steps = 50000) => {
  const m = new RegionModel(graph, pops, geom, demo);
  m.start(18, 5, opts);
  while (m.buildStep());
  for (let i = 0; i < steps; i++) m.optimiseStep();
  m.restoreBest();
  return m;
};
const demoOff = demoRun({ wPop: 1 });

check(model.demographics.length === Object.keys(RAW_TABLES).length,
  `every demographic in the model is covered here (${model.demographics.length})`);

for (const d of model.demographics) {
  const probe = DEMO_PROBES[d.key];
  const raw = RAW_TABLES[d.key];
  const dp = d.def.decimals;
  const values = (m) => m.summary().map((r) => r.demo[d.key]);
  console.log(`\n  ${d.label}`);

  check(near(d.mean, probe.mean, probe.tol),
    `national value is ${probe.mean} (${d.mean.toFixed(Math.max(dp, 4))})`);

  /* --- the data ---------------------------------------------------------- */
  const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', raw.file), 'utf8')).table;
  const cells = table.dimensions[1].categories;
  const ws = raw.fromCode
    ? cells.map((c) => Number(c.code))
    : cells.map((c) => raw.weights[c.label]);
  check(ws.every((w) => w !== undefined),
    'every category in the raw table is accounted for');
  if (raw.fromCode) {
    check(ws.every(Number.isFinite) && Math.min(...ws) === 0 && Math.max(...ws) === 100,
      `the categories are the ages 0-100 (${ws.length} of them)`);
  }
  const width = ws.length;
  let worstZone = 0;
  let total = 0;
  table.dimensions[0].categories.forEach((zc, i) => {
    const row = table.values.slice(i * width, (i + 1) * width);
    let num = 0;
    let n = 0;
    row.forEach((v, j) => {
      if (ws[j] === null) return;      // excluded from both, not counted as an answer
      num += v * ws[j];
      n += v;
    });
    total += n;
    const got = demo[d.key][zc.code];
    worstZone = Math.max(worstZone, Math.abs(num / n - got.value), Math.abs(n - got.n));
  });
  check(worstZone < 1e-5,
    `every zone index matches the raw table (worst error ${worstZone.toExponential(1)})`);
  check(total === raw.total,
    `the denominator totals ${raw.total.toLocaleString()} (${total.toLocaleString()})`);

  /* --- average and extreme ------------------------------------------------ */
  const avg = demoRun({ wPop: 1, demo: { [d.key]: { weight: 1, mode: 'average' } } });
  const ext = demoRun({ wPop: 1, demo: { [d.key]: { weight: 1, mode: 'extreme' } } });
  for (const [tag, m] of [['off', demoOff], ['average', avg], ['extreme', ext]]) {
    console.log(`    ${tag.padEnd(8)} spread ${m.demoSpread(d.key).toFixed(dp)}   `
      + `range ${Math.min(...values(m)).toFixed(dp)}-${Math.max(...values(m)).toFixed(dp)}`);
  }
  check(avg.demoSpread(d.key) < demoOff.demoSpread(d.key),
    `average mode narrows the spread (${avg.demoSpread(d.key).toFixed(dp)} `
    + `vs ${demoOff.demoSpread(d.key).toFixed(dp)})`);
  check(ext.demoSpread(d.key) > demoOff.demoSpread(d.key),
    `extreme mode widens it (${ext.demoSpread(d.key).toFixed(dp)} `
    + `vs ${demoOff.demoSpread(d.key).toFixed(dp)})`);

  /* --- gerrymander -------------------------------------------------------- */
  const seatsAt = (m, t, above) =>
    values(m).filter((v) => (above ? v >= t : v <= t)).length;
  const up = demoRun({ wPop: 1, demo: { [d.key]: {
    weight: 1, mode: 'gerrymander', threshold: probe.above, above: true } } });
  const down = demoRun({ wPop: 1, demo: { [d.key]: {
    weight: 1, mode: 'gerrymander', threshold: probe.below, above: false } } });
  console.log(`    gerrymander above ${probe.above}: `
    + `${seatsAt(up, probe.above, true)}/18 seats `
    + `(${seatsAt(demoOff, probe.above, true)}/18 off)   `
    + `below ${probe.below}: ${seatsAt(down, probe.below, false)}/18 `
    + `(${seatsAt(demoOff, probe.below, false)}/18 off)`);
  check(seatsAt(up, probe.above, true) > seatsAt(demoOff, probe.above, true),
    'gerrymander above wins more regions over the threshold');
  check(seatsAt(down, probe.below, false) > seatsAt(demoOff, probe.below, false),
    'and the direction toggle wins more the other way');
  check(up.demoSeats(d.key) === seatsAt(up, probe.above, true),
    "the model's own seat count agrees with an independent one");
  check(regionsContiguous(up) === null, 'steered regions stay contiguous');

  /* --- the extreme-mode cap ----------------------------------------------- */
  /* Uncapped, `-(x - mu)^2` buys a region made of one outlier zone: nothing
   * else in the score resists, since a one-zone region scores about 1 on both
   * shape terms, the best either gives. Religion is the only one that cannot
   * reach the cap, its values being confined to [0, 1] within 3.3x rSpread of
   * the national figure; the rest all can, and all need it. */
  const reach = Math.max(...Array.from(d.zValue, (v) => Math.abs(v - d.mean)));
  const binds = reach > d.cap;
  console.log(`    cap ${d.cap.toFixed(dp)}, furthest zone ${reach.toFixed(dp)} `
    + `(${(reach / d.rSpread).toFixed(1)}x rSpread) -- ${binds ? 'binds' : 'unreachable'}`);
  check(binds === (d.key !== 'rel'),
    `the cap ${d.key === 'rel' ? 'is unreachable, so religion is unchanged'
      : 'is reachable, which is why it is needed'}`);

  const savedMode = d.mode;
  d.mode = 'extreme';
  const termAt = (gap) => model._demoTermFrom(d, d.mean + gap);
  check(near(termAt(d.cap / 2), -((d.cap / 2) ** 2), 1e-12 * d.cap ** 2 + 1e-15),
    'below the cap the term is the plain negated square');
  check(near(termAt(d.cap * 3), -(d.cap ** 2), 1e-12 * d.cap ** 2 + 1e-15)
    && near(termAt(-d.cap * 9), -(d.cap ** 2), 1e-12 * d.cap ** 2 + 1e-15),
    'past it the term saturates, in both directions');
  d.mode = savedMode;

  /* At weight 10 an uncapped age term collapses to a one-zone region at 99.8%
   * population deviation; every variable that can reach its cap could. */
  const hot = demoRun({ wPop: 1, wShape: 1, wPopShape: 1, wCut: 1,
    demo: { [d.key]: { weight: 10, mode: 'extreme' } } });
  const smallest = Math.min(...hot.summary().map((r) => r.zones));
  console.log(`    extreme at weight 10: smallest region ${smallest} zones, `
    + `max deviation ${(100 * hot.maxDeviation).toFixed(1)}%`);
  check(smallest > 50,
    `a heavy extreme weight buys no degenerate region (smallest ${smallest} zones)`);
  check(hot.maxDeviation < 0.25,
    `and population equality survives it (${(100 * hot.maxDeviation).toFixed(1)}%)`);

  /* --- inert when it should be -------------------------------------------- */
  check(demoRun({ wPop: 1, demo: { [d.key]: { weight: 0, mode: 'extreme' } } })
    .assign.every((v, i) => v === demoOff.assign[i]),
    'weight 0 is inert whatever the mode');
  const without = { ...demo };
  delete without[d.key];
  const blind = new RegionModel(graph, pops, geom, without);
  blind.start(18, 5, { wPop: 1, demo: { [d.key]: { weight: 1, mode: 'average' } } });
  while (blind.buildStep());
  for (let i = 0; i < 50000; i++) blind.optimiseStep();
  blind.restoreBest();
  check(blind.assign.every((v, i) => v === demoOff.assign[i]),
    'with no data for it the term is inert whatever the mode');
}

/* All four at once, which is the case none of the single-term runs covers: the
 * per-term running sums, sigmas and scratch arrays all have to stay separate. */
const allOn = demoRun({ wPop: 1, demo: Object.fromEntries(
  model.demographics.map((d) => [d.key, { weight: 1, mode: 'average' }])) });
console.log(`\n  all four averaged: ${model.demographics.map((d) =>
  `${d.key} ${allOn.demoSpread(d.key).toFixed(d.def.decimals)}`).join('  ')}`);
check(model.demographics.every((d) => allOn.demoSpread(d.key) < demoOff.demoSpread(d.key)),
  'steering all four at once narrows every one of them');
check(regionsContiguous(allOn) === null, 'and the regions stay contiguous');

/* --- cut edges ------------------------------------------------------------ */
console.log('\ncut edges');

const cutOff = new RegionModel(graph, pops, geom, demo);
cutOff.start(18, 5, { wShape: 1, wPopShape: 1 });
while (cutOff.buildStep());
check(cutOff.cutRaw === cutOff._countCut(),
  `count is right after the build (${cutOff.cutRaw} vs ${cutOff._countCut()})`);

/* The incremental delta is the only genuinely fiddly part, and branch moves --
 * where a whole set moves and its internal edges must not change status -- are
 * where it would go wrong. So recount from scratch after every step. */
let mismatch = 0;
let branches = 0;
for (let i = 0; i < 500; i++) {
  const before = cutOff.branched;
  cutOff.optimiseStep();
  if (cutOff.branched > before) branches++;
  if (cutOff.cutRaw !== cutOff._countCut()) mismatch++;
}
check(mismatch === 0, `count stays exact over 500 steps (${mismatch} mismatches)`);
check(branches > 0, `and those steps included branch moves (${branches})`);

for (let i = 0; i < 50000; i++) cutOff.optimiseStep();
check(cutOff.cutRaw === cutOff._countCut(),
  `still exact after 50,000 more (${cutOff.cutRaw} vs ${cutOff._countCut()})`);

const cutOn = new RegionModel(graph, pops, geom, demo);
cutOn.start(18, 5, { wShape: 1, wPopShape: 1, wCut: 1 });
while (cutOn.buildStep());
for (let i = 0; i < 50000; i++) cutOn.optimiseStep();
cutOn.restoreBest();
cutOff.restoreBest();
console.log(`  weight 0: ${cutOff.cutRaw} cut edges,  weight 1: ${cutOn.cutRaw}`);
check(cutOn.cutRaw < cutOff.cutRaw,
  `weighting it cuts fewer edges (${cutOn.cutRaw} vs ${cutOff.cutRaw})`);
check(regionsContiguous(cutOn) === null, 'cut-weighted regions stay contiguous');

const byRegion = cutOn.cutByRegion();
check(Math.round(byRegion.reduce((a, b) => a + b, 0)) === cutOn.cutRaw * 2,
  'cutByRegion sums to twice the total, one count per endpoint');

/* The point of the term: towns should stop being split. Zone names carry their
 * DEA, so a town's zones are identifiable by prefix, and its built-up part by
 * density. Belfast is excluded -- at N=18 it cannot fit in one region. */
const TOWNS = ['Omagh', 'Enniskillen', 'Ballymena', 'Coleraine', 'Armagh', 'Newry'];
const dense = {};
for (const f of feats) {
  const p = f.properties;
  const town = TOWNS.find((name) => p.name.startsWith(`${name}_`));
  if (town && p.pop / (p.area_ha / 100) >= 2000) {
    (dense[town] ||= []).push(model.index.get(p.code));
  }
}
const splits = (m) => TOWNS.reduce(
  (total, town) => total + new Set(dense[town].map((z) => m.assign[z])).size, 0);

for (const [label, m] of [['weight 0', cutOff], ['weight 1', cutOn]]) {
  console.log(`  ${label}: ${splits(m)} regions for ${TOWNS.length} towns, `
    + `${m.cutRaw} cut edges, max dev ${(m.maxDeviation * 100).toFixed(2)}%`);
}
check(splits(cutOn) < splits(cutOff),
  `at the default weight the towns are split less (${splits(cutOn)} vs ${splits(cutOff)})`);
check(cutOn.maxDeviation > cutOff.maxDeviation,
  'and it costs population equality to do it, as it must');

/* --- sigma calibration --------------------------------------------------- */
/* Every term is normalised to "one typical move's worth", so at a common state
 * their per-move deltas should be the same order. This is the check that would
 * have caught the religion sigma being 123x too strong: it was derived assuming
 * the regional deviation settles at one move's scale, as the population term's
 * does, when geography actually holds religion values ~0.15 apart however the
 * lines are drawn. At equal weights that swamped everything else. */
console.log('\nsigma calibration');

const calib = new RegionModel(graph, pops, geom, demo);
calib.start(18, 5, { wPop: 1 });
while (calib.buildStep());
for (let i = 0; i < 50000; i++) calib.optimiseStep();

function perMoveDeltas(m) {
  const acc = { population: [], land: [], people: [], cut: [] };
  for (const d of m.demographics) acc[d.key] = [];
  for (let k = 0; k < 4000; k++) {
    const z = m.frontier[(m.rng() * m.frontier.length) | 0];
    const from = m.assign[z];
    if (m.regionSize[from] <= 1 || !m._connectedWithout(from, z)) continue;
    const g = m._aggregateInto(m._agg, [z]);
    for (const w of m.nbr[z]) {
      const r = m.assign[w];
      if (r < 0 || r === from) continue;
      acc.population.push(Math.abs(2 * g.pop
        * (g.pop + m.regionPop[r] - m.regionPop[from]) / m.eD2));
      acc.land.push(Math.abs((m._penaltyWithAgg(from, g, -1) - m._penalty(from)
        + m._penaltyWithAgg(r, g, 1) - m._penalty(r)) / m.sigmaShape));
      acc.people.push(Math.abs((m._penaltyPopWithAgg(from, g, -1) - m._penaltyPop(from)
        + m._penaltyPopWithAgg(r, g, 1) - m._penaltyPop(r)) / m.sigmaPopShape));
      m.demographics.forEach((d, k) => {
        acc[d.key].push(Math.abs((m._demoTermWithAgg(d, from, g, -1, k) - m._demoTerm(d, from)
          + m._demoTermWithAgg(d, r, g, 1, k) - m._demoTerm(d, r)) / d.sigma));
      });
      const tally = m._cutTally([z]);   // scratch map, so read both before reusing
      acc.cut.push(Math.abs(((tally.get(from) || 0) - (tally.get(r) || 0)) / m.sigmaCut));
      break;
    }
  }
  const rms = (a) => Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length);
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, rms(v)]));
}

/* A coarse net for order-of-magnitude mistakes, not a tight one, because both
 * ends of the range are deliberate. The cut term is 8x hotter than its nominal
 * per-move size on purpose, since the cut count is structural and moving a town
 * takes a run of consecutive moves rather than one. And gerrymander mode is
 * meant to be flat away from its threshold -- that flatness is what produces
 * cracking -- so measuring it over all moves understates it by ~2x against the
 * same term in average mode. */
const SPREAD_LIMIT = 40;
for (const mode of ['average', 'extreme', 'gerrymander']) {
  for (const d of calib.demographics) {
    calib.setDemographic(d.key, mode, d.def.threshold, d.def.steepness, true);
  }
  const d = perMoveDeltas(calib);
  const vals = Object.values(d);
  const ratio = Math.max(...vals) / Math.min(...vals);
  console.log(`  ${mode.padEnd(12)}`
    + Object.entries(d).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ')
    + `   spread ${ratio.toFixed(1)}x`);
  check(ratio < SPREAD_LIMIT,
    `${mode}: every term's per-move delta is within ${SPREAD_LIMIT}x of the others `
    + `(${ratio.toFixed(1)}x)`);
}

/* --- does it actually converge? ------------------------------------------ */
const STEPS = 200000;
console.log(`\nconvergence after ${STEPS.toLocaleString()} steps`);
console.log('  N   seed     build dev    optimised dev      build score   optimised score');
for (const [N, seed] of [[4, 7], [18, 7], [18, 8], [18, 9], [50, 7], [100, 7]]) {
  const m = new RegionModel(graph, pops, geom, demo);
  m.start(N, seed);
  while (m.buildStep());
  const devBuild = m.maxDeviation;
  const scoreBuild = m.score;
  for (let i = 0; i < STEPS; i++) m.optimiseStep();
  m.restoreBest();
  console.log(`${String(N).padStart(3)} ${String(seed).padStart(6)} `
    + `${(devBuild * 100).toFixed(1).padStart(12)}% ${(m.maxDeviation * 100).toFixed(2).padStart(14)}% `
    + `${scoreBuild.toFixed(0).padStart(16)} ${m.score.toFixed(1).padStart(17)}`);

  check(m.score < scoreBuild / 5,
    `N=${N} seed ${seed}: optimisation cuts the score by >5x `
    + `(${scoreBuild.toFixed(0)} -> ${m.score.toFixed(1)})`);
  check(regionsContiguous(m) === null, `N=${N} seed ${seed}: optimised regions contiguous`);
  if (seed !== 7 || N !== 18) {
    // 7% not 5%: across recombination settings this measurement ranges over
    // roughly 3.9-5.2% at N=100 with no trend, so a 5% line is inside the noise.
    check(m.maxDeviation < 0.07,
      `N=${N} seed ${seed}: max deviation under 7% (${(m.maxDeviation * 100).toFixed(2)}%)`);
  }
}

/* --- election terms ------------------------------------------------------ */
/* The nine parties ride the demographic machinery, so what needs checking is
 * that their sums stay right through every kind of move, and that the
 * gerrymander term -- the one that scores a winning margin rather than a share
 * -- agrees with a from-scratch recompute after the optimiser has churned. */
console.log('\nelection terms');
const PARTY = `party:${voters.parties[1]}`;      // DUP: stands second in the file
const votesTotal = Object.values(voters.zones)
  .reduce((a, z) => a + z.e * voters.turnout, 0);

const vote = new RegionModel(graph, pops, geom, demo, voters);
check(vote.parties.length === voters.parties.length,
  `one term per party (${vote.parties.length})`);
vote.start(18, 3, { wPop: 1, demo: { [PARTY]: { weight: 1, mode: 'gerrymander',
  threshold: 0, steepness: 0.02, above: true } } });
while (vote.buildStep());
for (let i = 0; i < 400000; i++) vote.optimiseStep();

const regionVotes = (m) => Array.from({ length: m.N },
  (_, r) => m.parties.reduce((a, q) => a + q.rSum[r], 0));
const sumVotes = regionVotes(vote).reduce((a, b) => a + b, 0);
check(near(sumVotes, votesTotal, votesTotal * 1e-9),
  `every vote lands in exactly one region (${Math.round(sumVotes).toLocaleString()})`);

/* Shares are a vote-weighted mean, so each region's must sum to one. */
let worstShare = 0;
for (let r = 0; r < vote.N; r++) {
  const total = vote.parties.reduce((a, q) => a + vote.regionPartyShare(q.key, r), 0);
  worstShare = Math.max(worstShare, Math.abs(total - 1));
}
check(worstShare < 1e-9, `region shares sum to one (worst off by ${worstShare.toExponential(1)})`);

/* The incremental term against a full recompute from the assignment alone. */
const mirror = new RegionModel(graph, pops, geom, demo, voters);
mirror.start(18, 3, { wPop: 1, demo: { [PARTY]: { weight: 1, mode: 'gerrymander',
  threshold: 0, steepness: 0.02, above: true } } });
mirror.assign.set(vote.assign);
mirror._resum();
const liveTerm = vote.demoScore(PARTY);
const fresh = mirror.demoScore(PARTY);
check(near(liveTerm, fresh, 1e-6 * Math.max(1, Math.abs(fresh))),
  `margin term survives ${vote.moves.toLocaleString()} moves and `
  + `${vote.recombinations.toLocaleString()} recombinations `
  + `(${liveTerm.toFixed(6)} vs ${fresh.toFixed(6)})`);

/* Seats, margins and the winner are three views of the same sums. */
let seats = 0;
let agree = true;
for (let r = 0; r < vote.N; r++) {
  const winner = vote.regionWinner(r);
  if (winner === PARTY) seats++;
  if ((vote.partyMargin(PARTY, r) > 0) !== (winner === PARTY)) agree = false;
}
check(seats === vote.partySeats(PARTY) && seats === vote.demoSeats(PARTY),
  `seats agree across the three readouts (${seats}/18)`);
check(agree, 'a positive margin means winning the region');

/* Gerrymandering for a party should win it more regions than ignoring it. */
const idle = new RegionModel(graph, pops, geom, demo, voters);
idle.start(18, 3, { wPop: 1 });
while (idle.buildStep());
for (let i = 0; i < 400000; i++) idle.optimiseStep();
check(vote.partySeats(PARTY) >= idle.partySeats(PARTY),
  `gerrymandering wins at least as many regions as not (${vote.partySeats(PARTY)} vs `
  + `${idle.partySeats(PARTY)})`);
check(regionsContiguous(vote) === null, 'election run keeps every region contiguous');

/* --- STV ----------------------------------------------------------------- */
/* The party-level count, and the score built on it: seats won plus the
 * leftover pile as a fraction of a quota. */
console.log('\nSTV');
const stv = new RegionModel(graph, pops, geom, demo, voters);
stv.setElection('stv', 5, 2);
stv.start(18, 3, { wPop: 1,
  demo: { [PARTY]: { weight: 1, mode: 'gerrymander', above: true } } });
while (stv.buildStep());
for (let i = 0; i < 300000; i++) stv.optimiseStep();

const seatsOut = new Int32Array(voters.parties.length);
let everyRegionFull = true;
let seatTotal = 0;
for (let r = 0; r < stv.N; r++) {
  const sum = [...stv.regionSeats(r, seatsOut)].reduce((a, b) => a + b, 0);
  seatTotal += sum;
  if (sum !== 5) everyRegionFull = false;
}
check(everyRegionFull && seatTotal === stv.totalSeats,
  `every region fills its 5 seats (${seatTotal} of ${stv.totalSeats})`);
check(voters.parties.reduce((a, p) => a + stv.partySeats(`party:${p}`), 0) === stv.totalSeats,
  'every seat belongs to exactly one party');

const stvMirror = new RegionModel(graph, pops, geom, demo, voters);
stvMirror.setElection('stv', 5, 2);
stvMirror.start(18, 3, { wPop: 1,
  demo: { [PARTY]: { weight: 1, mode: 'gerrymander', above: true } } });
stvMirror.assign.set(stv.assign);
stvMirror._resum();
check(near(stv.demoScore(PARTY), stvMirror.demoScore(PARTY),
  1e-6 * Math.max(1, Math.abs(stvMirror.demoScore(PARTY)))),
  `STV term survives ${stv.moves.toLocaleString()} moves and `
  + `${stv.recombinations.toLocaleString()} recombinations `
  + `(${stv.demoScore(PARTY).toFixed(4)} vs ${stvMirror.demoScore(PARTY).toFixed(4)})`);

const stvIdle = new RegionModel(graph, pops, geom, demo, voters);
stvIdle.setElection('stv', 5, 2);
stvIdle.start(18, 3, { wPop: 1 });
while (stvIdle.buildStep());
for (let i = 0; i < 300000; i++) stvIdle.optimiseStep();
check(stv.partySeats(PARTY) > stvIdle.partySeats(PARTY),
  `gerrymandering under STV wins more seats than not (${stv.partySeats(PARTY)} vs `
  + `${stvIdle.partySeats(PARTY)} of ${stv.totalSeats})`);
check(regionsContiguous(stv) === null, 'STV run keeps every region contiguous');

/* Seats are lumpy, so more votes need not mean more seats -- but a party that
 * holds a quota outright must always be returned. */
let quotaHonoured = true;
for (let r = 0; r < stv.N; r++) {
  const share = stv.regionPartyShare(PARTY, r);
  if (share >= 1 / 6 && stv.regionPartySeats(PARTY, r) < 1) quotaHonoured = false;
}
check(quotaHonoured, 'a party holding a quota always takes a seat');

/* Changing the seats per region is a different election, so the term rebuilds. */
const before = stv.demoScore(PARTY);
stv.setElection('stv', 7, 2);
check(stv.totalSeats === stv.N * 7 && stv.demoScore(PARTY) !== before,
  `seats per region changes the count (${stv.totalSeats} seats now)`);
stv.setElection('fptp', 5, 2);
check(stv.totalSeats === stv.N, 'first past the post returns one seat a region');

/* --- tactical voting ----------------------------------------------------- */
/* Third parties squeezed towards the leading two, by how tight the race is.
 * Votes move; nobody stays at home. */
console.log('\ntactical voting');
const tac = new RegionModel(graph, pops, geom, demo, voters);
tac.start(18, 3, { wPop: 1 });
while (tac.buildStep());
for (let i = 0; i < 150000; i++) tac.optimiseStep();

const castOf = (m, r) => voters.parties.map((p) => m.regionPartyVotes(`party:${p}`, r));
tac.setElection('fptp', 5, 2, false);
const plain = Array.from({ length: tac.N }, (_, r) => castOf(tac, r));
tac.setElection('fptp', 5, 2, true);
const cast = Array.from({ length: tac.N }, (_, r) => castOf(tac, r));

const totals = (v) => v.reduce((a, b) => a + b, 0);
check(plain.every((v, r) => near(totals(v), totals(cast[r]), 1e-6 * totals(v))),
  'tactical switching moves votes without losing any');

/* Where the race is tight the third parties give way; where it is safe they
 * barely move. */
const gap = (v) => {
  const s = [...v].sort((a, b) => b - a);
  return Math.log(s[0] / s[1]);
};
const squeeze = (r) => {
  const order = [...plain[r].keys()].sort((a, b) => plain[r][b] - plain[r][a]);
  const rest = order.slice(2).filter((k) => plain[r][k] > 0);
  return rest.reduce((a, k) => a + cast[r][k], 0) / rest.reduce((a, k) => a + plain[r][k], 0);
};
const tightest = [...plain.keys()].sort((a, b) => gap(plain[a]) - gap(plain[b]))[0];
const safest = [...plain.keys()].sort((a, b) => gap(plain[b]) - gap(plain[a]))[0];
check(squeeze(tightest) < 0.95 && squeeze(tightest) > 0.8,
  `the tightest region squeezes its third parties (x${squeeze(tightest).toFixed(2)}, `
  + `gap ${gap(plain[tightest]).toFixed(2)})`);
check(squeeze(safest) > 0.97,
  `the safest barely does (x${squeeze(safest).toFixed(2)}, gap ${gap(plain[safest]).toFixed(2)})`);
check(squeeze(tightest) < squeeze(safest), 'the tighter the race, the harder the squeeze');

/* The leaders take what the others lose. */
const leadersGain = [...plain.keys()].every((r) => {
  const order = [...plain[r].keys()].sort((a, b) => plain[r][b] - plain[r][a]);
  const before = plain[r][order[0]] + plain[r][order[1]];
  const after = cast[r][order[0]] + cast[r][order[1]];
  return after >= before - 1e-6;
});
check(leadersGain, 'the leading two never lose by it');

tac.setElection('stv', 5, 2, true);
const stvCast = Array.from({ length: tac.N }, (_, r) => castOf(tac, r));
check(stvCast.every((v, r) => v.every((x, i) => near(x, plain[r][i], 1e-6))),
  'nothing is squeezed under STV, where a lower preference is free');

/* --- who stands ---------------------------------------------------------- */
/* A party can stand aside, or parties can merge. Both are one mapping from
 * true voters to the ballot, applied to the zone votes. */
console.log('\nthe ballot');
const ballot = new RegionModel(graph, pops, geom, demo, voters);
ballot.start(18, 3, { wPop: 1 });
while (ballot.buildStep());
for (let i = 0; i < 150000; i++) ballot.optimiseStep();
const niVotes = (m) => voters.parties.map((p, i) =>
  Array.from({ length: m.N }, (_, r) => m.parties[i].rSum[r]).reduce((a, b) => a + b, 0));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const baseVotes = niVotes(ballot);
const idx = (p) => voters.parties.indexOf(p);

ballot.setBallot({ standing: { TUV: false } });
const asideVotes = niVotes(ballot);
const leak = baseVotes[idx('TUV')] * voters.exhaustion[idx('TUV')];
check(asideVotes[idx('TUV')] === 0, 'a party that stands aside has no votes');
check(near(sum(baseVotes) - sum(asideVotes), leak, 1),
  `its voters abstain at its exhaustion rate (${Math.round(leak).toLocaleString()} of `
  + `${Math.round(baseVotes[idx('TUV')]).toLocaleString()})`);
const moved = baseVotes[idx('TUV')] - leak;
const toDup = asideVotes[idx('DUP')] - baseVotes[idx('DUP')];
check(near(toDup / moved, voters.transfers[idx('TUV')][idx('DUP')], 0.002),
  `the rest follow the transfer matrix (DUP ${(100 * toDup / moved).toFixed(1)}% vs `
  + `${(100 * voters.transfers[idx('TUV')][idx('DUP')]).toFixed(1)}%)`);

ballot.setBallot({ merge: { UUP: 'DUP', TUV: 'DUP' } });
const mergedVotes = niVotes(ballot);
const unionistBefore = ['DUP', 'UUP', 'TUV'].reduce((a, p) => a + baseVotes[idx(p)], 0);
check(near(mergedVotes[idx('DUP')], unionistBefore, 1),
  `a merger keeps every vote (${Math.round(mergedVotes[idx('DUP')]).toLocaleString()})`);
check(mergedVotes[idx('UUP')] === 0 && mergedVotes[idx('TUV')] === 0,
  'the parties that merged hold nothing themselves');
check(near(sum(mergedVotes), sum(baseVotes), 1),
  'merging changes no totals, since nobody stays at home');
const P = voters.parties.length;
const row = Array.from({ length: P }, (_, b) => ballot._transfers[idx('DUP') * P + b]);
check(row[idx('DUP')] === 0 && row[idx('UUP')] === 0 && row[idx('TUV')] === 0,
  "a merged party's transfers to itself are gone");
check(near(sum(row), 1, 1e-9), 'and what is left renormalises to one');

/* Seats are still dealt in full when the ballot is short. */
ballot.setElection('stv', 5, 2);
ballot.setBallot({ standing: { Green: false, PBP: false, 'Aontú': false, TUV: false } });
const seatsOut2 = new Int32Array(P);
let full = true;
for (let r = 0; r < ballot.N; r++) {
  if (sum([...ballot.regionSeats(r, seatsOut2)]) !== 5) full = false;
}
check(full, 'a short ballot still fills every seat');
check(['Green', 'PBP', 'Aontú', 'TUV'].every((p) => ballot.partySeats(`party:${p}`) === 0),
  'parties that stood aside win nothing');

ballot.setBallot({});
const restored = niVotes(ballot);
check(restored.every((v, i) => near(v, baseVotes[i], 1e-6)),
  'putting everyone back restores the votes exactly');
ballot.setElection('fptp', 5, 2);

/* N=18 seed 7 is a known slow case, kept in the suite deliberately: regions 8
 * and 17 come out of the build as a sealed pocket, touching only each other and
 * one other region whose adjacent zones are all articulation points, so nothing
 * can legally cross. It is a narrow channel rather than a dead end -- it escapes
 * around 1.4M steps and lands near 0.5% -- but it is the clearest illustration
 * of why single-zone moves alone are limited. Swap moves are the standard fix
 * and are already deferred in major_checkpoint_1.txt. */
console.log('\nthe known slow case: N=18 seed 7, sealed pocket');
const slow = new RegionModel(graph, pops, geom, demo);
slow.start(18, 7);
while (slow.buildStep());
for (const upTo of [200000, 600000, 1600000]) {
  while (slow.steps < upTo) slow.optimiseStep();
  console.log(`  ${(slow.steps / 1e6).toFixed(1)}M steps: best score `
    + `${slow.bestScore.toFixed(1).padStart(9)}`);
}
slow.restoreBest();
check(slow.maxDeviation < 0.02,
  `escapes the pocket by 1.6M steps (${(slow.maxDeviation * 100).toFixed(2)}%)`);

console.log();
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('all checks passed');
