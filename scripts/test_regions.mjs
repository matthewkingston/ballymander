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
const RegionModel = load('web/regions.js', 'RegionModel');

const graph = new DZGraph(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz_adjacency.json'), 'utf8')));
const feats = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/data/dz.geojson'), 'utf8')).features;
const pops = Object.fromEntries(feats.map((f) => [f.properties.code, f.properties.pop]));

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

const model = new RegionModel(graph, pops);
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

const built = model.score;
const rescored = model._rescore() / model.eD2;
check(Math.abs(built - rescored) < 1e-6 * Math.max(1, built),
  `incremental score matches a full rescore (${built.toFixed(3)} vs ${rescored.toFixed(3)})`);

/* --- determinism --------------------------------------------------------- */
const a = new RegionModel(graph, pops);
a.start(18, 42); while (a.buildStep());
const b = new RegionModel(graph, pops);
b.start(18, 42); while (b.buildStep());
const c = new RegionModel(graph, pops);
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

/* --- does it actually converge? ------------------------------------------ */
const STEPS = 200000;
console.log(`\nconvergence after ${STEPS.toLocaleString()} steps`);
console.log('  N   seed     build dev    optimised dev      build score   optimised score');
for (const [N, seed] of [[4, 7], [18, 7], [18, 8], [18, 9], [50, 7], [100, 7]]) {
  const m = new RegionModel(graph, pops);
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
const slow = new RegionModel(graph, pops);
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
