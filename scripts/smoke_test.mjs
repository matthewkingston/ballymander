import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// puppeteer lives in .tools/pptr (gitignored), not next to this script, so
// resolve it from there rather than relying on ESM's script-relative lookup.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, '.tools/pptr/'));
const puppeteer = require('puppeteer');

const URL = 'http://127.0.0.1:8765/';
const OUT = process.env.OUTDIR || '.';

const browser = await puppeteer.launch({
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1400,900',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });

const errors = [], failed = [], external = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('requestfailed', r => failed.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('request', r => {
  const u = r.url();
  if (!u.startsWith('http://127.0.0.1:8765') && !u.startsWith('data:') && !u.startsWith('blob:')) {
    external.push(u);
  }
});

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

// app.js hides #status once the geojson is loaded and layers added
await page.waitForFunction(
  () => document.getElementById('status')?.hasAttribute('hidden'),
  { timeout: 60000 }
);

// let the WebGL frames settle
await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));

// the adjacency graph loads off the critical path, so wait for it separately
await page.waitForFunction(() => window.__graph, { timeout: 30000 }).catch(() => {});

const graph = await page.evaluate(() => {
  const g = window.__graph;
  if (!g) return null;
  return {
    zones: g.zones.length,
    edges: g.edges.length,
    components: g.meta.components,
    rathlin: g.neighbours('N20001651'),                  // ferry to The_Glens_B3 only
    narrows: g.areNeighbours('N20003391', 'N20003778'),  // Strangford, must be true
    corner: g.areNeighbours('N20000007', 'N20000022'),   // point touch, must be false
  };
});

// --- drive a region run -------------------------------------------------
// Wind the build rate up to its maximum so the smoke test exercises the same
// code path without waiting out an animation meant for a human.
await page.evaluate(() => {
  const build = document.getElementById('ctl-build');
  build.value = build.max;
  build.dispatchEvent(new Event('input'));
  document.getElementById('ctl-n').value = '12';
  document.getElementById('ctl-seed').value = '3';
  // Exercise the religion term, and the sub-block that only gerrymander uses.
  const mode = document.getElementById('ctl-relmode');
  mode.value = 'gerrymander';
  mode.dispatchEvent(new Event('change'));
  const relw = document.getElementById('ctl-relw');
  relw.value = '0';                       // log10 scale, so weight 1
  relw.dispatchEvent(new Event('input'));
});
const gerryVisible = await page.evaluate(() =>
  !document.getElementById('ctl-gerry').hidden);
await page.click('#ctl-go');
await page.waitForFunction(
  () => document.getElementById('run-phase').textContent.startsWith('optimising'),
  { timeout: 60000 }
);
await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));
await page.screenshot({ path: `${OUT}/map-regions.png` });

// pause holds the run without ending it, and resume picks it back up
await page.click('#ctl-pause');
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
const paused = await page.evaluate(() => ({
  label: document.getElementById('ctl-pause').textContent,
  phase: document.getElementById('run-phase').textContent,
  moves: window.__model.moves,
  goDisabled: document.getElementById('ctl-go').disabled,
}));
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
const stillPaused = await page.evaluate(() => window.__model.moves);
await page.click('#ctl-pause');
await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
const resumed = await page.evaluate(() => ({
  label: document.getElementById('ctl-pause').textContent,
  moves: window.__model.moves,
}));
const pause = {
  label: paused.label,
  phase: paused.phase,
  held: stillPaused === paused.moves,
  resumedLabel: resumed.label,
  advanced: resumed.moves > paused.moves,
  goDisabledWhilePaused: paused.goDisabled,
};

await page.click('#ctl-stop');

await page.evaluate((v) => { window.__gerryVisible = v; }, gerryVisible);
const regions = await page.evaluate(() => {
  const m = window.__model;
  let painted = 0;
  for (const code of m.codes) {
    const st = window.__map.getFeatureState({ source: 'dz', id: code });
    if (st && typeof st.region === 'number') painted++;
  }
  const pops = m.summary().map(r => Math.round(r.pop));
  return {
    painted,
    zones: m.n,
    assignedAll: m.assigned === m.n,
    regionCount: m.N,
    rows: document.querySelectorAll('#results-table tbody tr').length,
    resultsShown: !document.getElementById('results').hidden,
    phase: document.getElementById('run-phase').textContent,
    maxDev: document.getElementById('run-dev').textContent,
    shapeShown: document.getElementById('run-shape').textContent,
    meanPenalty: Number(m.meanPenalty.toFixed(3)),
    meanPopPenalty: Number(m.meanPopPenalty.toFixed(3)),
    sealed: m.sealed,
    relMode: m.relMode,
    relSeats: `${m.relSeats}/${m.N}`,
    relShown: document.getElementById('run-rel').textContent,
    gerryVisible: window.__gerryVisible,
    popsSumToTotal: pops.reduce((a, b) => a + b, 0),
  };
});

await page.screenshot({ path: `${OUT}/map-full.png` });

// --- hover a zone -------------------------------------------------------
// aim at Belfast (dense zones) rather than the viewport centre
const target = await page.evaluate(() => {
  const m = window.__map;
  if (!m) return null;
  const p = m.project([-5.93, 54.60]);   // central Belfast
  return { x: Math.round(p.x), y: Math.round(p.y) };
});

const pt = target ?? { x: 700, y: 450 };
await page.mouse.move(pt.x - 40, pt.y - 40);
await page.mouse.move(pt.x, pt.y, { steps: 12 });
await page.evaluate(() => new Promise(r => setTimeout(r, 800)));

const tip = await page.evaluate(() => {
  const t = document.getElementById('tooltip');
  if (!t || t.hidden) return null;
  return {
    name: t.querySelector('.tt-name')?.textContent,
    pop: t.querySelector('.tt-pop-value')?.textContent,
    rel: t.querySelector('.tt-rel')?.textContent,
    region: t.querySelector('.tt-region-name')?.textContent,
    regionPop: t.querySelector('.tt-region-pop-value')?.textContent,
    regionRel: t.querySelector('.tt-region-rel')?.textContent,
  };
});

await page.screenshot({ path: `${OUT}/map-hover.png` });

// how much of the canvas is actually painted with zone colour?
const painted = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  if (!c) return null;
  return { w: c.width, h: c.height };
});

console.log(JSON.stringify({ graph, regions, pause, tip, painted, errors, failed, external }, null, 2));
await browser.close();

// Report *and* fail: a console error that only shows up in the JSON is easy to
// skim past, and a broken paint expression makes MapLibre drop the layer
// without throwing.
const problems = [];
if (errors.length) problems.push(`${errors.length} console error(s)`);
if (failed.length) problems.push(`${failed.length} failed request(s)`);
if (external.length) problems.push(`${external.length} external request(s)`);
if (!tip) problems.push('hover produced no tooltip (is the dz-fill layer there?)');
if (!graph || graph.components !== 1) problems.push('adjacency graph did not load');
if (!regions || !regions.assignedAll || regions.painted !== regions.zones) {
  problems.push('region run did not paint every zone');
}
if (!regions || regions.rows !== regions.regionCount) problems.push('results table incomplete');
// A disc scores 1 and nothing can beat it, so anything below means the moment
// sums never got real geometry.
if (!regions || !(regions.meanPenalty > 0.99)) problems.push('land penalty not measured');
if (!regions || !(regions.meanPopPenalty > 0)) problems.push('people penalty not measured');
if (!regions || regions.relMode !== 'gerrymander') problems.push('religion mode did not take');
if (!regions || !regions.gerryVisible) problems.push('gerrymander sub-controls stayed hidden');
if (!regions || regions.relShown !== regions.relSeats) problems.push('religion readout wrong');
if (!pause || pause.label !== 'RESUME' || !pause.held) problems.push('pause did not hold the run');
if (!pause || !pause.advanced || pause.resumedLabel !== 'PAUSE') problems.push('resume did not restart the run');
if (problems.length) {
  console.error(`\nSMOKE TEST FAILED: ${problems.join('; ')}`);
  process.exit(1);
}
console.error('\nsmoke test passed');
