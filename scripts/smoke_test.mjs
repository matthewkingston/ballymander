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
  // Every demographic block, in a mix of modes: religion gerrymandering, which
  // is also what opens the sub-block only that mode uses, and the rest in the
  // two modes that share a shape. The blocks are generated from the definition
  // table, so this checks the generation as much as the terms.
  for (const [key, want] of [['rel', 'gerrymander'], ['age', 'extreme'],
                             ['orient', 'average'], ['grade', 'extreme']]) {
    const mode = document.getElementById(`ctl-${key}-mode`);
    mode.value = want;
    mode.dispatchEvent(new Event('change'));
    const w = document.getElementById(`ctl-${key}-w`);
    w.value = '0';                        // log10 scale, so weight 1
    w.dispatchEvent(new Event('input'));
  }
});
const gerryVisible = await page.evaluate(() => ({
  rel: !document.getElementById('demo-rel-gerry').hidden,
  age: !document.getElementById('demo-age-gerry').hidden,   // extreme: stays shut
  blocks: document.querySelectorAll('#demo-blocks .demo-block').length,
  bars: [...document.querySelectorAll('#bars-stat option')].map((o) => o.value),
}));
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
    rows: document.querySelectorAll('#bars .bar-row').length,
    axis: [document.getElementById('bars-min').textContent,
           document.getElementById('bars-max').textContent],
    barsFilled: [...document.querySelectorAll('.bar-fill')]
      .filter((b) => parseFloat(b.style.width) > 0).length,
    resultsShown: !document.getElementById('results').hidden,
    phase: document.getElementById('run-phase').textContent,
    maxDev: document.getElementById('run-dev').textContent,
    shapeShown: document.getElementById('run-shape').textContent,
    meanPenalty: Number(m.meanPenalty.toFixed(3)),
    meanPopPenalty: Number(m.meanPopPenalty.toFixed(3)),
    sealed: m.sealed,
    cutTotal: m.cutRaw,
    recomTotal: m.recombinations,
    recomShown: document.getElementById('run-recom').textContent,
    cutShown: document.getElementById('run-cut').textContent,
    relMode: m.demoByKey.rel.mode,
    relSeats: `${m.demoSeats('rel')}/${m.N}`,
    relShown: document.getElementById('run-demo-rel').textContent,
    ageMode: m.demoByKey.age.mode,
    ageSpread: m.demoSpread('age').toFixed(1),
    ageShown: document.getElementById('run-demo-age').textContent,
    demoKeys: m.demographics.map((d) => d.key),
    demoReadouts: m.demographics.map((d) =>
      document.getElementById(`run-demo-${d.key}`).textContent),
    gerryVisible: window.__gerryVisible,
    popsSumToTotal: pops.reduce((a, b) => a + b, 0),
  };
});

// switching the statistic must rescale and re-rank the same bars, not rebuild
const statSwitch = await page.evaluate(() => {
  const sel = document.getElementById('bars-stat');
  const max = () => document.getElementById('bars-max').textContent;
  const rows = () => document.querySelectorAll('#bars .bar-row').length;
  const before = { max: max(), rows: rows() };
  sel.value = 'demo:age';
  sel.dispatchEvent(new Event('change'));
  const demo = max();
  sel.value = 'cut';
  sel.dispatchEvent(new Event('change'));
  return {
    before,
    demo,
    after: { max: max(), rows: rows() },
    filled: [...document.querySelectorAll('.bar-fill')]
      .filter((b) => parseFloat(b.style.width) > 0).length,
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
    demo: [...t.querySelectorAll('.tt-demo div:not([hidden])')].map((d) => d.textContent),
    region: t.querySelector('.tt-region-name')?.textContent,
    regionPop: t.querySelector('.tt-region-pop-value')?.textContent,
    regionDemo: [...t.querySelectorAll('.tt-region-demo div:not([hidden])')]
      .map((d) => d.textContent),
  };
});

await page.screenshot({ path: `${OUT}/map-hover.png` });

// how much of the canvas is actually painted with zone colour?
const painted = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  if (!c) return null;
  return { w: c.width, h: c.height };
});

// --- election mode ------------------------------------------------------
// Switch modes, gerrymander one party, and check the panel, the bars and the
// tooltip all follow. The party terms ride the demographic machinery, so what
// matters here is the wiring: that the right things show, and that what the
// panel says matches what the model holds.
await page.click('#mode-election');
const electionOptions = await page.evaluate(() =>
  [...document.querySelectorAll('#bars-stat option')].map((o) => o.value));
await page.evaluate(() => {
  const set = (id, v) => {
    const e = document.getElementById(id);
    e.value = v;
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('ctl-party-p', 'DUP');
  set('ctl-party-mode', 'gerrymander');
  set('ctl-party-w', '0.4');
});
await page.click('#ctl-go');
await page.waitForFunction(() => window.__model.assigned === window.__model.n,
  { timeout: 60000 });
await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));
await page.click('#ctl-stop');
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));

const election = await page.evaluate(() => {
  const m = window.__model;
  const sel = document.getElementById('bars-stat');
  sel.value = 'party:DUP';
  sel.dispatchEvent(new Event('change'));
  const key = 'party:DUP';
  const votes = Array.from({ length: m.N }, (_, r) => m.regionPartyVotes(key, r));
  return {
    options: [...sel.options].map((o) => o.value),
    seats: m.partySeats(key),
    shown: document.getElementById('run-party').textContent,
    label: document.querySelector('.run-party-label').textContent,
    mode: m.demoByKey[key].mode,
    regions: m.N,
    demoBlocksHidden: document.getElementById('demo-blocks').hidden,
    partyBlockShown: !document.getElementById('party-block').hidden,
    demoRowsHidden: [...document.querySelectorAll('[id^="run-demo-"]')]
      .every((d) => d.parentElement.hidden),
    demoWeightsOff: m.demographics.every((d) => d.weight === 0),
    totalVotes: Math.round(votes.reduce((a, b) => a + b, 0)),
    nationalVotes: Math.round(m.parties.reduce((a, q) =>
      a + Array.from({ length: m.N }, (_, r) => q.rSum[r]).reduce((x, y) => x + y, 0), 0)),
  };
});
const marked = await page.evaluate(() =>
  document.querySelectorAll('#bars .bar-row.is-win').length);
election.marked = marked;

// The seats pie: one wedge per party, drawn only where seats were won, and a
// caption naming whatever is under the pointer.
election.pie = await page.evaluate(() => {
  const m = window.__model;
  const paths = [...document.querySelectorAll('#pie-svg path')];
  const seats = m.parties.map((q) => m.partySeats(q.key));
  return {
    shown: !document.getElementById('pie').hidden,
    wedges: paths.length,
    drawn: paths.filter((p) => (p.getAttribute('d') || '').length > 0).length,
    withSeats: seats.filter((n) => n > 0).length,
    total: seats.reduce((a, b) => a + b, 0),
    regions: m.N,
    lastRowIsParty: document.getElementById('run').lastElementChild
      .querySelector('#run-party') !== null,
  };
});
const biggest = await page.evaluate(() => {
  const m = window.__model;
  let best = 0;
  m.parties.forEach((q, i) => {
    if (m.partySeats(q.key) > m.partySeats(m.parties[best].key)) best = i;
  });
  const r = document.querySelectorAll('#pie-svg path')[best].getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
await page.mouse.move(biggest.x, biggest.y);
await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
election.pie.caption = await page.evaluate(() =>
  document.getElementById('pie-caption').textContent.trim());

await page.mouse.move(pt.x - 30, pt.y - 30);
await page.mouse.move(pt.x, pt.y, { steps: 8 });
await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
election.tip = await page.evaluate(() => {
  const t = document.getElementById('tooltip');
  if (!t || t.hidden) return null;
  const rows = [...t.querySelectorAll('.tt-party-row')];
  return {
    party: t.querySelector('.tt-party')?.innerText.trim(),
    rows: rows.map((r) => r.innerText.replace(/\n/g, ' ')),
    targets: rows.filter((r) => r.classList.contains('is-target')).length,
    ranked: rows.filter((r) => r.querySelector('.tt-party-rank')).length,
    demoHidden: t.querySelector('.tt-demo')?.innerText.trim() === '',
  };
});
await page.screenshot({ path: `${OUT}/map-election.png` });

await page.click('#mode-demographics');
election.backToDemographics = await page.evaluate(() => ({
  options: [...document.querySelectorAll('#bars-stat option')].map((o) => o.value),
  partyRowHidden: document.getElementById('run-party').parentElement.hidden,
  pieHidden: document.getElementById('pie').hidden,
}));
election.electionOptions = electionOptions;

console.log(JSON.stringify({ graph, regions, statSwitch, pause, tip, election, painted, errors, failed, external }, null, 2));
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
if (!regions || regions.rows !== regions.regionCount) problems.push('a bar per region missing');
if (!regions || regions.barsFilled !== regions.regionCount) problems.push('bars not drawn');
if (!regions || !regions.axis[0] || !regions.axis[1]) problems.push('bar axis not labelled');
if (!statSwitch || statSwitch.before.max === statSwitch.demo
    || statSwitch.demo === statSwitch.after.max) {
  problems.push('switching the statistic did not rescale the axis');
}
if (!regions || regions.cutShown !== regions.cutTotal.toLocaleString('en-GB')) {
  problems.push('cut edge readout does not match the model');
}
if (!regions || !(regions.recomTotal > 0)) problems.push('no recombinations happened');
if (!regions || regions.recomShown !== regions.recomTotal.toLocaleString('en-GB')) {
  problems.push('recombination readout does not match the model');
}
if (!statSwitch || statSwitch.after.rows !== statSwitch.before.rows
    || statSwitch.filled !== statSwitch.before.rows) {
  problems.push('switching the statistic disturbed the bars');
}
// A disc scores 1 and nothing can beat it, so anything below means the moment
// sums never got real geometry.
if (!regions || !(regions.meanPenalty > 0.99)) problems.push('land penalty not measured');
if (!regions || !(regions.meanPopPenalty > 0)) problems.push('people penalty not measured');
if (!regions || regions.relMode !== 'gerrymander') problems.push('religion mode did not take');
if (!regions || regions.ageMode !== 'extreme') problems.push('age mode did not take');
if (!regions || !regions.gerryVisible.rel) problems.push('gerrymander sub-controls stayed hidden');
if (!regions || regions.gerryVisible.age) problems.push('gerrymander sub-controls shown outside that mode');
if (!regions || regions.gerryVisible.blocks !== regions.demoKeys.length) {
  problems.push('a demographic control block is missing');
}
if (!regions || regions.demoKeys.some((k) => !regions.gerryVisible.bars.includes(`demo:${k}`))) {
  problems.push('a demographic is missing from the statistic selector');
}
if (!regions || regions.demoReadouts.some((t) => !t || t === '\u2014')) {
  problems.push('a demographic readout stayed empty');
}
if (!regions || regions.relShown !== regions.relSeats) problems.push('religion readout wrong');
if (!regions || regions.ageShown !== regions.ageSpread) problems.push('age readout wrong');
// Every weight is up, so every demographic counts as active and should show.
const wantDemo = regions ? regions.demoKeys.length : 0;
if (!tip || tip.demo.length !== wantDemo) {
  problems.push('a demographic is missing from the tooltip');
}
if (!tip || tip.regionDemo.length !== wantDemo) {
  problems.push("a demographic is missing from the tooltip's region block");
}
if (!election || !election.demoBlocksHidden || !election.partyBlockShown) {
  problems.push('mode switch did not swap the control blocks');
}
if (!election || !election.demoRowsHidden) problems.push('demographic readouts stayed in election mode');
if (!election || !election.demoWeightsOff) problems.push('demographics kept steering in election mode');
if (!election || election.mode !== 'gerrymander') problems.push('party mode did not take');
if (!election || election.shown !== `${election.seats}/${election.regions} won`) {
  problems.push('party readout does not match the model');
}
if (!election || election.label !== 'DUP') problems.push('party readout not labelled with the party');
if (!election || election.marked !== election.seats) {
  problems.push('bars marked as won do not match the seats');
}
if (!election || !election.electionOptions.includes('party:Sinn Féin')
    || election.electionOptions.some((o) => o.startsWith('demo:'))) {
  problems.push('statistic selector not filtered to the mode');
}
if (!election || !election.backToDemographics.options.includes('demo:rel')
    || election.backToDemographics.options.some((o) => o.startsWith('party:'))) {
  problems.push('statistic selector did not switch back');
}
if (!election || !election.backToDemographics.partyRowHidden) {
  problems.push('party readout stayed in demographics mode');
}
// Votes are conserved: every voter lands in exactly one region.
if (!election || Math.abs(election.nationalVotes - 789554) > 2) {
  problems.push(`votes not conserved (${election && election.nationalVotes})`);
}
if (!election || !election.tip || !/votes?\b/.test(election.tip.party || '')) {
  problems.push('tooltip missing the zone party line');
}
// The region's standings: five rows, strongest first, the selected party
// highlighted -- and ranked only when it misses the top five.
if (!election || !election.tip || election.tip.rows.length !== 5) {
  problems.push('tooltip region standings not five rows');
}
if (!election || !election.tip || election.tip.targets !== 1) {
  problems.push('tooltip did not highlight exactly one party');
}
if (!election || !election.tip
    || election.tip.ranked !== (election.tip.rows.findIndex((r) => /DUP/.test(r)) === 4 ? 1 : 0)) {
  problems.push('tooltip rank number shown in the wrong case');
}
if (!election || !election.tip.demoHidden) problems.push('tooltip kept the demographic lines');
if (!election || !election.pie.shown) problems.push('seats pie missing in election mode');
if (!election || election.pie.wedges !== 9) problems.push('a party is missing from the pie');
if (!election || election.pie.drawn !== election.pie.withSeats) {
  problems.push('pie wedges do not match the parties holding seats');
}
if (!election || election.pie.total !== election.pie.regions) {
  problems.push('pie seats do not add up to the regions');
}
if (!election || !/\u2014 \d+ seats?$/.test(election.pie.caption || '')) {
  problems.push(`pie caption wrong on hover (${election && election.pie.caption})`);
}
if (!election || !election.pie.lastRowIsParty) {
  problems.push('party readout is not last in the results block');
}
if (!election || !election.backToDemographics.pieHidden) {
  problems.push('seats pie stayed in demographics mode');
}
if (!pause || pause.label !== 'RESUME' || !pause.held) problems.push('pause did not hold the run');
if (!pause || !pause.advanced || pause.resumedLabel !== 'PAUSE') problems.push('resume did not restart the run');
if (problems.length) {
  console.error(`\nSMOKE TEST FAILED: ${problems.join('; ')}`);
  process.exit(1);
}
console.error('\nsmoke test passed');
