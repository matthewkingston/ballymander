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
const { RegionModel, zoneGeometry, zoneReligion } = load('web/regions.js',
  '{ RegionModel, zoneGeometry, zoneReligion }');

const graph = new DZGraph(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz_adjacency.json'), 'utf8')));
const feats = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz.geojson'), 'utf8')).features;
const pops = Object.fromEntries(feats.map((f) => [f.properties.code, f.properties.pop]));
const geom = zoneGeometry(feats);
const rel = zoneReligion(feats);

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

const model = new RegionModel(graph, pops, geom, rel);
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

const sealer = new RegionModel(graph, pops, geom, rel);
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

const bare = new RegionModel(graph, pops, geom, rel);
bare.sweepInterval = Infinity;
bare.start(18, 5);
while (bare.buildStep());
check(bare.sealed === 0, 'sweepInterval = Infinity turns sealing off');
check(bare.assigned === bare.n, 'the build still completes without sealing');
console.log(`  build score ${bare.scorePop.toFixed(0)} without sealing, `
  + `${sealer.scorePop.toFixed(0)} with (${sealer.steps.toLocaleString()} steps `
  + `vs ${bare.steps.toLocaleString()})`);

const seal2 = new RegionModel(graph, pops, geom, rel);
seal2.start(18, 5);
while (seal2.buildStep());
const seal3 = new RegionModel(graph, pops, geom, rel);
seal3.start(18, 5);
while (seal3.buildStep());
check(seal2.assign.every((v, i) => v === seal3.assign[i]),
  'sealing stays deterministic for a given seed');

/* --- determinism --------------------------------------------------------- */
const a = new RegionModel(graph, pops, geom, rel);
a.start(18, 42); while (a.buildStep());
const b = new RegionModel(graph, pops, geom, rel);
b.start(18, 42); while (b.buildStep());
const c = new RegionModel(graph, pops, geom, rel);
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

const branchOn = new RegionModel(graph, pops, geom, rel);
branchOn.start(18, 5, { wShape: 1, wPopShape: 1 });
while (branchOn.buildStep());
for (let i = 0; i < 50000; i++) branchOn.optimiseStep();

const branchOff = new RegionModel(graph, pops, geom, rel);
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
const off = new RegionModel(graph, pops, geom, rel);
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
const on = new RegionModel(graph, pops, geom, rel);
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
const people = new RegionModel(graph, pops, geom, rel);
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

const both = new RegionModel(graph, pops, geom, rel);
both.start(18, 5, { wShape: 1, wPopShape: 1 });
while (both.buildStep());
for (let i = 0; i < 50000; i++) both.optimiseStep();
console.log(`  both              : land ${both.meanPenalty.toFixed(3)}, `
  + `people ${both.meanPopPenalty.toFixed(3)}`);
check(both.meanPenalty < off.meanPenalty && both.meanPopPenalty < off.meanPopPenalty,
  'both weights together improve both measures over no shape term at all');

/* Weight changes re-base best for the people term too. */
const liveP = new RegionModel(graph, pops, geom, rel);
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
const small = new RegionModel(graph, pops, geom, rel);
small.start(18, 5, { wShape: 1, wPopShape: 1, wPop: 0.1 });          // land 1, people 1, population 0.1
while (small.buildStep());
for (let i = 0; i < 30000; i++) small.optimiseStep();
const big = new RegionModel(graph, pops, geom, rel);
big.start(18, 5, { wShape: 10, wPopShape: 10, wPop: 1 });            // the same thing, times ten
while (big.buildStep());
for (let i = 0; i < 30000; i++) big.optimiseStep();
check(small.assign.every((v, i) => v === big.assign[i]),
  'scaling every weight by ten gives an identical map');
check(near(small.score, big.score, 1e-9 * Math.max(1, Math.abs(small.score))),
  `and an identical score (${small.score.toFixed(6)} vs ${big.score.toFixed(6)})`);

const even = new RegionModel(graph, pops, geom, rel);
even.start(18, 5, { wShape: 1, wPopShape: 1, wPop: 1 });
while (even.buildStep());
check(near(even.score,
  (even.scorePop + even.scoreShape + even.scorePopShape) / 3, 1e-9 * Math.abs(even.score)),
  'equal weights make the score the mean of the three terms');
check(even.weightSum === 3, `weightSum tracks the weights (${even.weightSum})`);

const popw = new RegionModel(graph, pops, geom, rel);
popw.start(18, 5, { wShape: 1, wPopShape: 1, wPop: 1 });
while (popw.buildStep());
for (let i = 0; i < 20000; i++) popw.optimiseStep();
check(popw.setPopWeight(0.3) === true, 'the population weight is settable');
check(near(popw.bestScore, popw.score, 1e-9),
  'changing the population weight re-bases best-so-far too');
check(popw.setPopWeight(0.3) === false, 'the same population weight is a no-op');

/* Changing the weight mid-run changes the objective, so the old best is not
 * comparable and must not survive. */
const live = new RegionModel(graph, pops, geom, rel);
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

check(near(model.relMean, 0.5111, 5e-4),
  `national value is 0.511 (${model.relMean.toFixed(4)})`);

/* The index in the geojson against the raw NISRA table. This is what proves the
 * collapse in prepare_attributes.py did what it claims, end to end. */
const rawTable = JSON.parse(fs.readFileSync(path.join(ROOT,
  'data/ni-census21-people-dz21+religion_belong_to_or_brought_up_in_dvo-f4902c4c.json'),
  'utf8')).table;
const WEIGHTS = {
  Catholic: 1,
  'Protestant and Other Christian (including Christian related)': 0,
  'Other religions': 0.5,
  None: 0.5,
};
const catWeights = rawTable.dimensions[1].categories.map((c) => WEIGHTS[c.label]);
const width = catWeights.length;
let worstZone = 0;
rawTable.dimensions[0].categories.forEach((zc, i) => {
  const row = rawTable.values.slice(i * width, (i + 1) * width);
  const n = row.reduce((x, y) => x + y, 0);
  const want = row.reduce((acc, v, j) => acc + v * catWeights[j], 0) / n;
  const got = rel[zc.code];
  worstZone = Math.max(worstZone, Math.abs(want - got.value), Math.abs(n - got.n));
});
check(worstZone < 1e-5,
  `every zone index matches the raw table (worst error ${worstZone.toExponential(1)})`);

function relRun(opts, steps = 50000) {
  const m = new RegionModel(graph, pops, geom, rel);
  m.start(18, 5, opts);
  while (m.buildStep());
  for (let i = 0; i < steps; i++) m.optimiseStep();
  m.restoreBest();
  return m;
}
const seatsAt = (m, t, above) =>
  m.summary().filter((r) => (above ? r.religion >= t : r.religion <= t)).length;

const relOff = relRun({});
const relAvg = relRun({ wRel: 1, relMode: 'average' });
const relExt = relRun({ wRel: 1, relMode: 'extreme' });
console.log(`  off      spread ${relOff.relSpread.toFixed(3)}   `
  + `range ${Math.min(...relOff.summary().map((r) => r.religion)).toFixed(2)}`
  + `-${Math.max(...relOff.summary().map((r) => r.religion)).toFixed(2)}`);
console.log(`  average  spread ${relAvg.relSpread.toFixed(3)}   `
  + `range ${Math.min(...relAvg.summary().map((r) => r.religion)).toFixed(2)}`
  + `-${Math.max(...relAvg.summary().map((r) => r.religion)).toFixed(2)}`);
console.log(`  extreme  spread ${relExt.relSpread.toFixed(3)}   `
  + `range ${Math.min(...relExt.summary().map((r) => r.religion)).toFixed(2)}`
  + `-${Math.max(...relExt.summary().map((r) => r.religion)).toFixed(2)}`);
check(relAvg.relSpread < relOff.relSpread,
  `average mode narrows the spread (${relAvg.relSpread.toFixed(3)} vs `
  + `${relOff.relSpread.toFixed(3)})`);
check(relExt.relSpread > relOff.relSpread,
  `extreme mode widens it (${relExt.relSpread.toFixed(3)} vs `
  + `${relOff.relSpread.toFixed(3)})`);

/* Seats are a coarse integer that moves slowly, so these get more steps than
 * the modes above; 50,000 is not enough to flip one at N=18. */
const GERRY_STEPS = 300000;
const gAbove = relRun({ wRel: 1, relMode: 'gerrymander', relThreshold: 0.6, relAbove: true },
  GERRY_STEPS);
const gBelow = relRun({ wRel: 1, relMode: 'gerrymander', relThreshold: 0.4, relAbove: false },
  GERRY_STEPS);
const marginals = (m, t) => m.summary().filter((r) => Math.abs(r.religion - t) <= 0.05).length;
console.log(`  gerrymander above 0.6: ${seatsAt(gAbove, 0.6, true)}/18 seats `
  + `(${seatsAt(relOff, 0.6, true)}/18 with the term off)`);
console.log(`  gerrymander below 0.4: ${seatsAt(gBelow, 0.4, false)}/18 seats `
  + `(${seatsAt(relOff, 0.4, false)}/18 with the term off)`);
console.log(`  values: ${gAbove.summary().map((r) => r.religion.toFixed(2)).sort().join(' ')}`);
check(seatsAt(gAbove, 0.6, true) > seatsAt(relOff, 0.6, true),
  'gerrymander above wins more regions over the threshold');
check(seatsAt(gBelow, 0.4, false) > seatsAt(relOff, 0.4, false),
  'and the direction toggle wins more the other way');
check(gAbove.relSeats === seatsAt(gAbove, 0.6, true),
  "the model's own seat count agrees with an independent one");

/* The sharper test of the mechanism: packing and cracking means abandoning the
 * middle, so regions should vacate the neighbourhood of the threshold. This is
 * far less noisy than the seat count and is what the logistic is really for. */
console.log(`  regions within 0.05 of the threshold: `
  + `${marginals(relOff, 0.6)} with the term off, ${marginals(gAbove, 0.6)} gerrymandering`);
check(marginals(gAbove, 0.6) < marginals(relOff, 0.6),
  `gerrymandering empties the marginal band (${marginals(gAbove, 0.6)} vs `
  + `${marginals(relOff, 0.6)})`);

/* Two more running sums maintained through 50,000 moves, branch moves included. */
const relRawBefore = relExt.relRaw;
let worstValue = 0;
for (let r = 0; r < relExt.N; r++) {
  let sum = 0;
  let n = 0;
  for (let z = 0; z < relExt.n; z++) {
    if (relExt.assign[z] === r) { sum += relExt.zRel[z] * relExt.zRelN[z]; n += relExt.zRelN[z]; }
  }
  worstValue = Math.max(worstValue, Math.abs(sum / n - relExt._relValue(r)));
}
check(worstValue < 1e-9,
  `region values match a from-scratch weighted mean (worst ${worstValue.toExponential(1)})`);
relExt._resum();
check(near(relRawBefore, relExt.relRaw, 1e-6 * Math.max(1, Math.abs(relRawBefore))),
  `no drift in the religion total (${relRawBefore.toFixed(9)} vs ${relExt.relRaw.toFixed(9)})`);
check(regionsContiguous(relExt) === null, 'religion-steered regions stay contiguous');

/* Without the data the term is inert, whatever is asked for. */
const noRel = new RegionModel(graph, pops, geom);
noRel.start(18, 5, { wRel: 1, relMode: 'average' });
while (noRel.buildStep());
for (let i = 0; i < 50000; i++) noRel.optimiseStep();
noRel.restoreBest();
check(noRel.assign.every((v, i) => v === relOff.assign[i]),
  'with no religion data the term is inert whatever the mode');

const relLive = relRun({ wRel: 1, relMode: 'average' }, 20000);
check(relLive.setReligion('gerrymander', 0.6, 0.05, true) === true,
  'changing the religion mode is reported as a change');
check(near(relLive.bestScore, relLive.score, 1e-9),
  'changing the religion mode re-bases best-so-far');
check(relLive.setReligion('gerrymander', 0.6, 0.05, true) === false,
  'the same religion settings are a no-op');
check(relLive.setReligion('gerrymander', 0.55, 0.05, true) === true,
  'a threshold change alone counts as a change');

/* --- cut edges ------------------------------------------------------------ */
console.log('\ncut edges');

const cutOff = new RegionModel(graph, pops, geom, rel);
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

const cutOn = new RegionModel(graph, pops, geom, rel);
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

const calib = new RegionModel(graph, pops, geom, rel);
calib.start(18, 5, { wPop: 1 });
while (calib.buildStep());
for (let i = 0; i < 50000; i++) calib.optimiseStep();

function perMoveDeltas(m) {
  const acc = { population: [], land: [], people: [], religion: [], cut: [] };
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
      acc.religion.push(Math.abs((m._relTermWithAgg(from, g, -1) - m._relTerm(from)
        + m._relTermWithAgg(r, g, 1) - m._relTerm(r)) / m.sigmaRel));
      const tally = m._cutTally([z]);   // scratch map, so read both before reusing
      acc.cut.push(Math.abs(((tally.get(from) || 0) - (tally.get(r) || 0)) / m.sigmaCut));
      break;
    }
  }
  const rms = (a) => Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length);
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, rms(v)]));
}

const SPREAD_LIMIT = 25;
for (const mode of ['average', 'extreme', 'gerrymander']) {
  calib.setReligion(mode, 0.6, 0.05, true);
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
  const m = new RegionModel(graph, pops, geom, rel);
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
    check(m.maxDeviation < 0.05,
      `N=${N} seed ${seed}: max deviation under 5% (${(m.maxDeviation * 100).toFixed(2)}%)`);
  }
}

/* N=18 seed 7 is a known slow case, kept in the suite deliberately: regions 8
 * and 17 come out of the build as a sealed pocket, touching only each other and
 * one other region whose adjacent zones are all articulation points, so nothing
 * can legally cross. It is a narrow channel rather than a dead end -- it escapes
 * around 1.4M steps and lands near 0.5% -- but it is the clearest illustration
 * of why single-zone moves alone are limited. Swap moves are the standard fix
 * and are already deferred in major_checkpoint_1.txt. */
console.log('\nthe known slow case: N=18 seed 7, sealed pocket');
const slow = new RegionModel(graph, pops, geom, rel);
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
