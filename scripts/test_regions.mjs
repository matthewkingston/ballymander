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
const { RegionModel, zoneGeometry } = load('web/regions.js',
  '{ RegionModel, zoneGeometry }');

const graph = new DZGraph(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz_adjacency.json'), 'utf8')));
const feats = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz.geojson'), 'utf8')).features;
const pops = Object.fromEntries(feats.map((f) => [f.properties.code, f.properties.pop]));
const geom = zoneGeometry(feats);

const failures = [];
function check(ok, msg) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
}

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

const model = new RegionModel(graph, pops, geom);
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

const sealer = new RegionModel(graph, pops, geom);
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

const bare = new RegionModel(graph, pops, geom);
bare.sweepInterval = Infinity;
bare.start(18, 5);
while (bare.buildStep());
check(bare.sealed === 0, 'sweepInterval = Infinity turns sealing off');
check(bare.assigned === bare.n, 'the build still completes without sealing');
console.log(`  build score ${bare.scorePop.toFixed(0)} without sealing, `
  + `${sealer.scorePop.toFixed(0)} with (${sealer.steps.toLocaleString()} steps `
  + `vs ${bare.steps.toLocaleString()})`);

const seal2 = new RegionModel(graph, pops, geom);
seal2.start(18, 5);
while (seal2.buildStep());
const seal3 = new RegionModel(graph, pops, geom);
seal3.start(18, 5);
while (seal3.buildStep());
check(seal2.assign.every((v, i) => v === seal3.assign[i]),
  'sealing stays deterministic for a given seed');

/* --- determinism --------------------------------------------------------- */
const a = new RegionModel(graph, pops, geom);
a.start(18, 42); while (a.buildStep());
const b = new RegionModel(graph, pops, geom);
b.start(18, 42); while (b.buildStep());
const c = new RegionModel(graph, pops, geom);
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;
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
const off = new RegionModel(graph, pops, geom);
off.start(18, 5, 1, 0);
while (off.buildStep());
for (let i = 0; i < 50000; i++) off.optimiseStep();
const noGeom = new RegionModel(graph, pops);          // shape term unavailable
noGeom.start(18, 5, 1, 1);                            // weight ignored
while (noGeom.buildStep());
for (let i = 0; i < 50000; i++) noGeom.optimiseStep();
check(off.assign.every((v, i) => v === noGeom.assign[i]),
  'weight 0 is exactly the behaviour without the shape term at all');

/* Sums are maintained incrementally through tens of thousands of moves and are
 * a small difference of large numbers, so drift is the thing to watch. */
const on = new RegionModel(graph, pops, geom);
on.start(18, 5, 1, 1);
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
const people = new RegionModel(graph, pops, geom);
people.start(18, 5, 1, 0, 1);
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

const both = new RegionModel(graph, pops, geom);
both.start(18, 5, 1, 1, 1);
while (both.buildStep());
for (let i = 0; i < 50000; i++) both.optimiseStep();
console.log(`  both              : land ${both.meanPenalty.toFixed(3)}, `
  + `people ${both.meanPopPenalty.toFixed(3)}`);
check(both.meanPenalty < off.meanPenalty && both.meanPopPenalty < off.meanPopPenalty,
  'both weights together improve both measures over no shape term at all');

/* Weight changes re-base best for the people term too. */
const liveP = new RegionModel(graph, pops, geom);
liveP.start(18, 5, 1, 0, 0);
while (liveP.buildStep());
for (let i = 0; i < 20000; i++) liveP.optimiseStep();
liveP.setPopShapeWeight(2);
check(near(liveP.bestScore, liveP.score, 1e-9),
  'changing the people weight re-bases best-so-far');
check(liveP.setPopShapeWeight(2) === false, 'the same people weight is a no-op');

/* Changing the weight mid-run changes the objective, so the old best is not
 * comparable and must not survive. */
const live = new RegionModel(graph, pops, geom);
live.start(18, 5, 1, 0);
while (live.buildStep());
for (let i = 0; i < 20000; i++) live.optimiseStep();
live.setShapeWeight(2);
check(near(live.bestScore, live.score, 1e-9),
  'changing the shape weight re-bases best-so-far on the current state');
const rebased = live.bestScore;
check(live.setShapeWeight(2) === false && live.bestScore === rebased,
  'setting the same weight again changes nothing');
check(live.setShapeWeight(0.5) === true, 'a real change is reported as one');

/* --- does it actually converge? ------------------------------------------ */
const STEPS = 200000;
console.log(`\nconvergence after ${STEPS.toLocaleString()} steps`);
console.log('  N   seed     build dev    optimised dev      build score   optimised score');
for (const [N, seed] of [[4, 7], [18, 7], [18, 8], [18, 9], [50, 7], [100, 7]]) {
  const m = new RegionModel(graph, pops, geom);
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
const slow = new RegionModel(graph, pops, geom);
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
