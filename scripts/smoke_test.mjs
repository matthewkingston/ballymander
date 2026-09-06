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

const stats = await page.evaluate(() => ({
  zones: document.getElementById('stat-zones').textContent,
  pop: document.getElementById('stat-pop').textContent,
}));

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
// The build phase is one zone per redraw by design, which is ~60s. Raise the
// steps-per-redraw knob so the smoke test exercises the same code path fast.
await page.evaluate(() => {
  CONFIG.buildStepsPerRedraw = 400;
  document.getElementById('ctl-n').value = '12';
  document.getElementById('ctl-seed').value = '3';
});
await page.click('#ctl-go');
await page.waitForFunction(
  () => document.getElementById('run-phase').textContent.startsWith('optimising'),
  { timeout: 60000 }
);
await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));
await page.screenshot({ path: `${OUT}/map-regions.png` });
await page.click('#ctl-stop');

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
    lgd: t.querySelector('.tt-lgd')?.textContent,
  };
});

await page.screenshot({ path: `${OUT}/map-hover.png` });

// how much of the canvas is actually painted with zone colour?
const painted = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  if (!c) return null;
  return { w: c.width, h: c.height };
});

console.log(JSON.stringify({ stats, graph, regions, tip, painted, errors, failed, external }, null, 2));
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
if (problems.length) {
  console.error(`\nSMOKE TEST FAILED: ${problems.join('; ')}`);
  process.exit(1);
}
console.error('\nsmoke test passed');
