import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// puppeteer lives in .tools/pptr (gitignored), not next to this script, so
// resolve it from there rather than relying on ESM's script-relative lookup.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .tools/ is gitignored, so it exists only in the main checkout: running this
// copy of the script from a worktree resolves puppeteer from there.
const TOOLS = process.env.SMOKE_TOOLS_ROOT || ROOT;
const require = createRequire(path.join(TOOLS, '.tools/pptr/'));
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

// The server is the user's and serves the main checkout, so a change on a
// branch cannot otherwise be tested until it is merged -- which has put a
// failing assertion on main more than once. Point SMOKE_OVERRIDE_DIR at a
// worktree and the page, its script and its stylesheet are served from there
// instead; everything else (data, artwork, vendor) still comes from the server,
// none of it being what a UI branch changes.
const OVERRIDE = process.env.SMOKE_OVERRIDE_DIR;
if (OVERRIDE) {
  const { readFileSync } = await import('node:fs');
  const from = {
    '/': ['web/index.html', 'text/html'],
    '/index.html': ['web/index.html', 'text/html'],
    '/app.js': ['web/app.js', 'text/javascript'],
    '/style.css': ['web/style.css', 'text/css'],
    '/regions.js': ['web/regions.js', 'text/javascript'],
    '/graph.js': ['web/graph.js', 'text/javascript'],
  };
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.isInterceptResolutionHandled()) return;
    const hit = from[new global.URL(r.url()).pathname];
    if (hit) {
      r.respond({ status: 200, contentType: hit[1],
                  body: readFileSync(path.join(OVERRIDE, hit[0])) });
    } else r.continue();
  });
  console.error(`serving web/ from ${OVERRIDE}`);
}

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

const initialPanel = await page.evaluate(() => ({
  // The bars open on the variable the page opens with, not on population.
  barStat: document.getElementById('bars-stat').value,
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
// Wind the simulation speed up to its maximum so the smoke test exercises the
// same code path without waiting out an animation meant for a human.
await page.evaluate(() => {
  const speed = document.getElementById('ctl-speed');
  speed.value = speed.max;
  speed.dispatchEvent(new Event('input'));
  document.getElementById('ctl-n').value = '12';
  document.getElementById('ctl-seed').value = '3';     // fixed, not auto
  // The page opens with one variable, Alliance. Add every demographic to it, in
  // a mix of modes: religion gerrymandering, which is also what opens the
  // sub-block only that mode uses, and the rest in the two modes that share a
  // shape. Blocks are generated from one definition, party or demographic
  // alike, so this checks the generation as much as the terms.
  const add = (key) => {
    document.getElementById('ctl-add-open').click();
    document.querySelector(`#ctl-add [data-key="${key}"]`).click();
  };
  for (const [key, want] of [['rel', 'gerrymander'], ['age', 'extreme'],
                             ['orient', 'average'], ['grade', 'extreme']]) {
    add(key);
    const mode = document.getElementById(`ctl-${key}-mode`);
    mode.value = want;
    mode.dispatchEvent(new Event('change'));
    const w = document.getElementById(`ctl-${key}-w`);
    w.value = '0';                        // log10 scale, so weight 1
    w.dispatchEvent(new Event('input'));
  }
});
// Which button wears the accent before anything has been started.
const primaryIdle = await page.evaluate(() =>
  (document.getElementById('ctl-go').classList.contains('is-primary') ? 'ctl-go'
    : document.getElementById('ctl-stop').classList.contains('is-primary')
      ? 'ctl-stop' : 'none'));
const gerryVisible = await page.evaluate(() => ({
  rel: !document.getElementById('rel-gerry').hidden,
  age: !document.getElementById('age-gerry').hidden,        // extreme: stays shut
  blocks: document.querySelectorAll('#variables .demo-block').length,
  bars: [...document.querySelectorAll('#bars-stat option')].map((o) => o.value),
}));
// Before anything has run the panel is already there, holding its title and a
// line of help -- it used to appear the instant GO was pressed.
const resultsAtRest = await page.evaluate(() => ({
  panel: !document.getElementById('results').hidden,
  hint: !document.getElementById('results-hint').hidden,
  hintText: document.getElementById('results-hint').textContent.replace(/\s+/g, ' ').trim(),
  overall: !document.getElementById('overall').hidden,
  viewSwitch: !document.querySelector('.view-switch').hidden,
  // Held open at four fifths of the left panel rather than collapsing onto the
  // one paragraph. A ratio, not a pixel count: the left panel decides both.
  resting: document.getElementById('results').classList.contains('is-resting'),
  height: document.getElementById('results').getBoundingClientRect().height,
  fitsWindow: document.getElementById('results').getBoundingClientRect().bottom
    <= window.innerHeight,
}));
await page.click('#ctl-go');
await page.waitForFunction(
  () => document.getElementById('run-phase').textContent.startsWith('Optimising'),
  { timeout: 60000 }
);
await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));
await page.screenshot({ path: `${OUT}/map-regions.png` });

// pause holds the run without ending it, and resume picks it back up
await page.click('#ctl-go');
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
const paused = await page.evaluate(() => ({
  label: document.getElementById('ctl-go').textContent,
  phase: document.getElementById('run-phase').textContent,
  moves: window.__model.moves,
  goDisabled: document.getElementById('ctl-go').disabled,
}));
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
const stillPaused = await page.evaluate(() => window.__model.moves);
await page.click('#ctl-go');
await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
const resumed = await page.evaluate(() => ({
  label: document.getElementById('ctl-go').textContent,
  moves: window.__model.moves,
}));
const primary = await page.evaluate(() => {
  const which = () => (document.getElementById('ctl-go').classList.contains('is-primary')
    ? 'ctl-go'
    : document.getElementById('ctl-stop').classList.contains('is-primary') ? 'ctl-stop' : 'none');
  return { idle: null, running: which() };
});
primary.idle = primaryIdle;
const pause = {
  primary,
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
    panelAlwaysUp: !document.getElementById('results').hidden,
    resultsShown: document.getElementById('results-hint').hidden,
    phase: document.getElementById('run-phase').textContent,
    maxDev: document.getElementById('run-dev').textContent,
    meanPenalty: Number(m.meanPenalty.toFixed(3)),
    meanPopPenalty: Number(m.meanPopPenalty.toFixed(3)),
    sealed: m.sealed,
    cutTotal: m.cutRaw,
    recomTotal: m.recombinations,
    recomShown: document.getElementById('run-recom').textContent,
    movesShown: document.getElementById('run-moves').textContent,
    moves: m.moves,
    // The overall block is deliberately short: phase, flips, recom, score, best
    // score, max pop dev, and then whatever the map is being drawn for.
    statLabels: [...document.querySelectorAll('#run dt')].map((d) => d.textContent),
    relMode: m.demoByKey.rel.mode,
    relSeats: `${m.demoSeats('rel')}/${m.N}`,
    relShown: document.getElementById('run-var-rel').textContent,
    ageMode: m.demoByKey.age.mode,
    ageRowGone: document.getElementById('run-var-age').parentElement.hidden,
    demoKeys: m.demographics.map((d) => d.key),
    demoReadouts: m.demographics.map((d) => ({
      key: d.key,
      mode: m.demoByKey[d.key].mode,
      text: document.getElementById(`run-var-${d.key}`).textContent,
      hidden: document.getElementById(`run-var-${d.key}`).parentElement.hidden,
    })),
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
  // Population, not cut edges: the shape statistics are behind advanced
  // controls now, and this runs in the mode the page opens in.
  sel.value = 'pop';
  sel.dispatchEvent(new Event('change'));
  return {
    before,
    demo,
    basicOptions: [...sel.options].map((o) => o.value),
    after: { max: max(), rows: rows() },
    filled: [...document.querySelectorAll('.bar-fill')]
      .filter((b) => parseFloat(b.style.width) > 0).length,
  };
});

// Pointing at a bar lights its region on the map, and only its region.
const barRow = await page.evaluate(() => {
  const row = document.querySelectorAll('#bars .bar-row')[3];
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           label: Number(row.querySelector('.bar-n').textContent) };
});
await page.mouse.move(barRow.x, barRow.y, { steps: 4 });
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
const barVeil = await page.evaluate(() => {
  const m = window.__model;
  const on = m.codes.filter((c) => window.__map.getFeatureState({ source: 'dz', id: c }).veil);
  const regions = [...new Set(on.map((c) => m.regionOf(c)))];
  // Which row the pointer actually landed on, read back rather than assumed:
  // rows keep their place in the DOM and are moved by transform as the ranking
  // changes, so the one at a remembered position may not be the one measured.
  const under = document.querySelector('#bars .bar-row:hover');
  return { lit: on.length, regions,
           row: under ? Number(under.querySelector('.bar-n').textContent) : null,
           whole: regions.length === 1
             && on.length === m.codes.filter((c) => m.regionOf(c) === regions[0]).length };
});
await page.mouse.move(8, 8);
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
barVeil.clearedOnLeaving = await page.evaluate(() => window.__model.codes.every(
  (c) => !window.__map.getFeatureState({ source: 'dz', id: c }).veil));

await page.screenshot({ path: `${OUT}/map-full.png` });

// --- the seed, fixed and automatic --------------------------------------
// An empty box means a fresh seed every run, reported in the label so a map
// worth keeping can be found again; a number in the box pins it, and is not
// repeated in the label.
const seed = await page.evaluate(async () => {
  const box = document.getElementById('ctl-seed');
  const label = document.getElementById('ctl-seed-value');
  const go = () => new Promise((done) => {
    document.getElementById('ctl-go').click();
    const wait = () => (window.__model && window.__model.assigned === window.__model.n
      ? done() : setTimeout(wait, 100));
    wait();
  });
  const stop = () => new Promise((done) => {
    document.getElementById('ctl-stop').click();
    setTimeout(done, 200);
  });
  const fixedLabel = label.textContent;         // still on the fixed seed above
  box.value = '';
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await go();
  const first = label.textContent;
  await stop();
  await go();
  const second = label.textContent;
  await stop();
  return { placeholder: box.placeholder, fixedLabel, first, second, boxAfter: box.value };
});

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

// --- real boundaries ----------------------------------------------------
// Loading a real map should look like a run that has just stopped, and GO
// should carry on from it rather than starting again.
const realSet = async (value) => page.evaluate((v) => {
  const e = document.getElementById('ctl-real');
  e.value = v;
  e.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
const realState = () => page.evaluate(() => {
  const m = window.__model;
  return {
    N: m.N,
    assigned: m.assigned,
    painted: m.codes.filter((c) => {
      const st = window.__map.getFeatureState({ source: 'dz', id: c });
      return st && typeof st.region === 'number';
    }).length,
    regionsBox: document.getElementById('ctl-n').value,
    regionsDisabled: document.getElementById('ctl-n').disabled,
    selectorShown: !document.getElementById('ctl-real').hidden,
    selectorDisabled: document.getElementById('ctl-real').disabled,
    // Nothing in the region group is usable during a run, so it folds itself.
    groupFolded: document.getElementById('region-settings').hidden,
    value: document.getElementById('ctl-real').value,
    results: document.getElementById('results-hint').hidden,
    bars: document.querySelectorAll('#bars .bar-row').length,
  };
});
await realSet('westminster');
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
const realWestminster = await realState();
await realSet('council');
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
const realCouncil = await realState();
await realSet('westminster');
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
await page.click('#ctl-go');
await page.evaluate(() => new Promise(r => setTimeout(r, 1200)));
const realRunning = await realState();
await page.click('#ctl-stop');
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
const realStopped = await realState();
await realSet('none');
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
const realCleared = await realState();
const real = { westminster: realWestminster, council: realCouncil,
               running: realRunning, stopped: realStopped, cleared: realCleared };

// how much of the canvas is actually painted with zone colour?
const painted = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  if (!c) return null;
  return { w: c.width, h: c.height };
});

// --- a party as a variable ----------------------------------------------
// There are no modes: a party is one more variable beside the demographics.
// Add DUP, gerrymander by it, and check the panel, the bars and the tooltip all
// follow. Party terms ride the demographic machinery, so what matters here is
// the wiring: that the right things show, and that what the panel says matches
// what the model holds.
await page.evaluate(() => {
  document.getElementById('ctl-add-open').click();
  document.querySelector('#ctl-add [data-key="party:DUP"]').click();
});
const electionOptions = await page.evaluate(() =>
  [...document.querySelectorAll('#bars-stat option')].map((o) => o.value));
await page.evaluate(() => {
  const set = (id, v) => {
    const e = document.getElementById(id);
    e.value = v;
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('ctl-party-dup-mode', 'gerrymander');
  set('ctl-party-dup-w', '0.4');
});
await page.click('#ctl-go');
await page.waitForFunction(() => window.__model.assigned === window.__model.n,
  { timeout: 60000 });
await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));
// The region count is fixed for the life of a run; the election controls are not.
const lockedDuringRun = await page.evaluate(() => ({
  regions: document.getElementById('ctl-n').disabled,
  type: document.getElementById('ctl-election-type').disabled,
  seats: document.getElementById('ctl-seats').disabled,
}));
await page.click('#ctl-stop');
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
const unlockedAfterStop = await page.evaluate(() =>
  !document.getElementById('ctl-n').disabled);

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
    shown: document.getElementById('run-var-party-dup').textContent,
    label: document.getElementById('run-var-party-dup').previousElementSibling.textContent,
    mode: m.demoByKey[key].mode,
    regions: m.N,
    // Parties and demographics share the page: five blocks, five readout rows,
    // and every one of them steering.
    blocks: document.querySelectorAll('#variables .demo-block').length,
    relStillThere: document.getElementById('run-var-rel') !== null,
    demoWeightsOn: m.demographics.filter((d) => d.weight > 0).length,
    totalVotes: Math.round(votes.reduce((a, b) => a + b, 0)),
    // Conservation, against the zones themselves rather than a number written
    // down here: every zone's electorate times its turnout index should end up
    // in exactly one region. (Stored sums are in those units; the election's
    // level turns them into ballots.)
    nationalVotes: Math.round(m.parties.reduce((a, q) =>
      a + Array.from({ length: m.N }, (_, r) => q.rSum[r]).reduce((x, y) => x + y, 0), 0)),
    // totalElectors is summed over zones at construction, so this really is
    // the zone side against the region side.
    zoneVotes: Math.round(m.totalElectors),
    ballots: Math.round(m.parties.reduce((a, q) =>
      a + Array.from({ length: m.N }, (_, r) => q.rSum[r]).reduce((x, y) => x + y, 0), 0)
      * m.voteScale),
  };
});
const marked = await page.evaluate(() =>
  document.querySelectorAll('#bars .bar-row.is-win').length);
election.marked = marked;
election.lockedDuringRun = lockedDuringRun;
election.unlockedAfterStop = unlockedAfterStop;

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
      .querySelector('#run-var-party-dup') !== null,
    // Says what to do until a wedge has been pointed at.
    caption: document.getElementById('pie-caption').textContent.trim(),
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
election.pie.hovered = await page.evaluate(() =>
  document.getElementById('pie-caption').textContent.trim());
// And it stays on that party once the pointer has gone: a reading you can only
// have while hovering is one you cannot read while the map moves under it.
await page.mouse.move(biggest.x - 400, biggest.y - 200);
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
election.pie.afterLeaving = await page.evaluate(() =>
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
    ranks: rows.map((r) => {
      const n = r.querySelector('.tt-party-rank');
      return n ? Number(n.textContent.replace('.', '')) : null;
    }),
    demoHidden: t.querySelector('.tt-demo')?.innerText.trim() === '',
  };
});
await page.screenshot({ path: `${OUT}/map-election.png` });

// The election is reported whether or not anything is steering it, and a party
// on the page keeps its row without keeping its colour. Turning DUP's weight
// off used to take the whole standings block away with it.
const dupWeight = (v) => page.evaluate((x) => {
  const w = document.getElementById('ctl-party-dup-w');
  w.value = x === 'off' ? w.min : x;
  w.dispatchEvent(new Event('input', { bubbles: true }));
}, v);
await dupWeight('off');
await page.mouse.move(pt.x - 30, pt.y - 30);
await page.mouse.move(pt.x, pt.y, { steps: 8 });
await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
election.unsteered = await page.evaluate(() => {
  const t = document.getElementById('tooltip');
  const rows = [...t.querySelectorAll('.tt-party-row')];
  return {
    rows: rows.length,
    lit: rows.filter((r) => r.classList.contains('is-target')).length,
    keptDup: rows.some((r) => /DUP/.test(r.innerText)),
    demoLines: [...t.querySelectorAll('.tt-demo div')].filter((e) => !e.hidden).length,
    zoneParty: t.querySelector('.tt-party')?.innerText.trim(),
  };
});
await dupWeight('0');            // log10, so back to weight 1

// More parties on the page than the list's five rows. Five is a floor: the
// list grows rather than swapping out parties that are themselves on the page,
// which used to leave the first and the last four and nothing between.
const EXTRA = ['Sinn Féin', 'UUP', 'SDLP', 'TUV', 'Green'];
await page.evaluate((names) => {
  for (const name of names) {
    document.getElementById('ctl-add-open').click();
    const item = document.querySelector(`#ctl-add [data-key="party:${name}"]`);
    if (item) item.click();
    else document.getElementById('ctl-add-open').click();
  }
}, EXTRA);
await page.mouse.move(pt.x - 30, pt.y - 30);
await page.mouse.move(pt.x, pt.y, { steps: 8 });
await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
election.manyParties = await page.evaluate(() => {
  const t = document.getElementById('tooltip');
  const rows = [...t.querySelectorAll('.tt-party-row')];
  const onPage = [...document.querySelectorAll('#bars-stat option')]
    .filter((o) => o.value.startsWith('party:'))
    .map((o) => o.value.slice(6).replace(/\s+/g, ''));
  const listed = rows.map((r) => r.querySelector('.tt-party-name').textContent
    .replace(/\s+/g, ''));
  return { rows: rows.length, onPage: onPage.length,
           allListed: onPage.every((n) => listed.includes(n)),
           listed, missing: onPage.filter((n) => !listed.includes(n)) };
});
await page.evaluate((names) => {
  for (const name of names) {
    const block = [...document.querySelectorAll('#variables .demo-block')]
      .find((x) => x.querySelector('.demo-toggle').textContent
        .replace(/[\u25B8\s]+/g, '') === name.replace(/\s+/g, ''));
    if (block) block.querySelector('.var-remove').click();
  }
}, EXTRA);

// Switching to STV re-counts the regions already on the map, so this needs no
// second run: the same lines, counted a different way.
await page.evaluate(() => {
  const set = (id, v) => { const e = document.getElementById(id); e.value = v;
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.dispatchEvent(new Event('input', { bubbles: true })); };
  set('ctl-election-type', 'stv');
  set('ctl-seats', '5');
});
await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
election.stv = await page.evaluate(() => {
  const m = window.__model;
  const out = new Int32Array(m.parties.length);
  const perRegion = Array.from({ length: m.N },
    (_, r) => [...m.regionSeats(r, out)].reduce((a, b) => a + b, 0));
  return {
    controls: {
      seats: !document.getElementById('ctl-seats').hidden,
      margin: !document.getElementById('ctl-party-dup-t').hidden,
      // Both are fine tuning, so both wait for advanced mode -- and the margin
      // has nothing to tune under STV even then.
      bonus: !document.getElementById('ctl-bonus').hidden,
      // The label is 'Goal' whatever the variable; the options carry the
      // meaning, and a party's are Win/Lose rather than above/below a margin.
      // Without the info marker, which every control label now carries.
      goalLabel: (() => {
        const l = document.querySelector('label[for="ctl-party-dup-a"]').cloneNode(true);
        const mark = l.querySelector('.info-mark');
        if (mark) mark.remove();
        return l.textContent.trim();
      })(),
      goalOptions: [...document.getElementById('ctl-party-dup-a').options]
        .map((o) => `${o.value}:${o.textContent}`),
      goal: document.getElementById('ctl-party-dup-a').value,
    },
    seatsPer: m.seatsPerRegion,
    total: m.totalSeats,
    regions: m.N,
    perRegion,
    allParties: m.parties.reduce((a, q) => a + m.partySeats(q.key), 0),
    readout: document.getElementById('run-var-party-dup').textContent,
    dup: m.partySeats('party:DUP'),
    barSeats: [...document.querySelectorAll('#bars .bar-seats')]
      .filter((e) => !e.hidden).map((e) => Number(e.textContent)),
  };
});

// The standing rule: with it on, parties that fall short of their threshold
// leave the ballot in that region and some of their voters stay at home.
election.standing = await page.evaluate(() => {
  const m = window.__model;
  const box = document.getElementById('ctl-standing');
  const cast = () => Math.round(Array.from({ length: m.N },
    (_, r) => m.regionVotesCast(r)).reduce((a, b) => a + b, 0));
  const absent = () => {
    const out = new Uint8Array(m.parties.length);
    let n = 0;
    for (let r = 0; r < m.N; r++) n += [...m.regionStanding(r, out)].filter((x) => !x).length;
    return n;
  };
  const on = { rule: m.standingRule, votes: cast(), absent: absent(), shown: !box.hidden };
  box.click();
  const off = { rule: m.standingRule, votes: cast(), absent: absent() };
  box.click();
  return { on, off, back: { rule: m.standingRule, votes: cast() } };
});

// Advanced mode: Compactness stands for three sliders, which come out on the
// switch and are flattened back to their mean when it goes off again.
const advancedMode = await page.evaluate(() => {
  const box = document.getElementById('ctl-advanced');
  const parts = ['ctl-shape', 'ctl-pshape', 'ctl-cut'].map((id) =>
    document.getElementById(id));
  const compact = document.getElementById('ctl-compact');
  const shown = () => ({
    compact: !compact.hidden,
    parts: parts.map((p) => !p.hidden),
    bonus: !document.getElementById('ctl-bonus').hidden,
    margin: !document.getElementById('ctl-party-dup-t').hidden,
    recom: !document.getElementById('ctl-recom').hidden,
    branch: !document.getElementById('ctl-branch').hidden,
    // The run's bookkeeping: counters and the objective's own value.
    runRows: ['run-moves', 'run-recom', 'run-score', 'run-best']
      .map((id) => !document.getElementById(id).parentElement.hidden),
    // Always out, whichever mode: the phase and how equal the populations are.
    runKept: ['run-phase', 'run-dev']
      .map((id) => !document.getElementById(id).parentElement.hidden),
    // A demographic's threshold stays out in simple mode; its steepness does
    // not. Religion is on the page in gerrymander mode by this point.
    relThreshold: !document.getElementById('ctl-rel-t').hidden,
    relSteepness: !document.getElementById('ctl-rel-s').hidden,
    // The shape charts follow the sliders they belong to.
    shapeStats: [...document.getElementById('bars-stat').options]
      .map((o) => o.value).filter((v) => ['land', 'people', 'cut'].includes(v)).length,
  });
  const simple = shown();
  box.click();                                  // into advanced
  const open = shown();
  // Three different values, then back: all four must agree on their mean.
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set(parts[0], '0.5'); set(parts[1], '0'); set(parts[2], '-0.5');
  box.click();                                  // back to simple
  const flat = {
    values: parts.map((p) => Number(p.value)),
    compact: Number(compact.value),
    readout: document.getElementById('ctl-compact-value').textContent,
    stored: (() => { try { return localStorage.getItem('ballymander.advanced'); }
                     catch { return null; } })(),
  };
  // And the one knob drives all three.
  set(compact, '0.4');
  const spread = parts.map((p) => Number(p.value));
  set(compact, '0');
  return { simple, open, flat, spread };
});

// The two restored search controls reach the model, which reads them per frame.
// Waits are on the value rather than on the clock: the model picks these up
// once a frame, and a fixed sleep that is enough at ten frames a second is not
// enough at five. A real regression still fails here -- the wait times out and
// the value it returns is the wrong one.
const searchControls = await page.evaluate(async () => {
  const until = async (pred, ms = 4000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const box = document.getElementById('ctl-advanced');
  box.click();
  const recom = document.getElementById('ctl-recom');
  const branch = document.getElementById('ctl-branch');
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const readout = () => document.getElementById('ctl-recom-value').textContent;
  // Infinity does not survive the JSON hop out of the page, so it goes as text.
  const start = { interval: String(window.__model.recomInterval),
                  branch: window.__model.allowBranchMoves, readout: readout() };
  set(recom, '3');                       // 10^3
  branch.click();
  // Whatever state the tests above left behind: stop, then start. Clicking GO
  // on a run that is already going pauses it, and a paused run reads nothing.
  document.getElementById('ctl-stop').click();
  await until(() => document.getElementById('ctl-go').textContent === 'START');
  document.getElementById('ctl-go').click();
  await until(() => String(window.__model.recomInterval) === '1000');
  const moved = { interval: String(window.__model.recomInterval),
                  branch: window.__model.allowBranchMoves, readout: readout() };
  set(recom, recom.max);                 // the detent past the end: never
  await until(() => String(window.__model.recomInterval) === 'Infinity');
  const off = { interval: String(window.__model.recomInterval), readout: readout() };
  document.getElementById('ctl-stop').click();
  set(recom, '2.3');
  branch.click();
  box.click();
  return { start, moved, off };
});

// The party editor: exclude a party, merge two, and put them back.
await page.click('#party-editor .demo-toggle');
const editorPick = (names) => page.evaluate((want) => {
  for (const row of document.querySelectorAll('.pe-row')) {
    const box = row.querySelector('input');
    if (want.includes(row.querySelector('.pe-name').textContent) !== box.checked) box.click();
  }
}, names);
const editorPress = (label) => page.evaluate((l) => {
  [...document.querySelectorAll('.pe-action')].find((b) => b.textContent === l).click();
}, label);
const editorState = () => page.evaluate(() => ({
  rows: [...document.querySelectorAll('.pe-row')].map((r) =>
    r.querySelector('.pe-name').textContent + (r.classList.contains('is-out') ? '(out)' : '')),
  buttons: [...document.querySelectorAll('.pe-action')]
    .map((b) => `${b.textContent}:${b.disabled ? 'off' : 'on'}`),
  selected: [...document.querySelectorAll('.pe-row input')].filter((b) => b.checked).length,
  votes: window.__model.parties.map((q) => Math.round(Array.from(
    { length: window.__model.N }, (_, r) => q.rSum[r]).reduce((a, b) => a + b, 0))),
  offered: [...document.querySelectorAll('#ctl-add .add-item')].map((b) => b.textContent),
  // The party variables on the page, by the name their block carries.
  steering: [...document.querySelectorAll('#variables .demo-toggle')]
    .map((b) => b.textContent.replace('\u25B8', '').trim()),
}));
election.editor = { start: await editorState() };
await editorPick(['TUV']);
election.editor.onePicked = (await editorState()).buttons;
await editorPress('Exclude');
election.editor.excluded = await editorState();
// A button is live only when pressing it would change something, so the pair
// swaps over once the party it is pointing at has been struck off -- and a
// selection holding one of each gives both something to do.
await editorPick(['TUV']);
election.editor.excludedPicked = (await editorState()).buttons;
await editorPick(['TUV', 'DUP']);
election.editor.mixedPicked = (await editorState()).buttons;
await editorPick(['DUP', 'UUP']);
election.editor.twoPicked = (await editorState()).buttons;
await editorPress('Merge');
election.editor.merged = await editorState();
// Whatever the merger ended up called -- some combinations have their own name.
const mergedName = election.editor.merged.rows[0];
await editorPick([mergedName]);
election.editor.mergedPicked = (await editorState()).buttons;
await editorPress('Unmerge');
await editorPick(['TUV']);
await editorPress('Include');
election.editor.restored = await editorState();

// One region's election in detail: a pie under first past the post, the count
// stage by stage under STV, and the map choosing which region.
election.region = {};
await page.click('#view-region');
election.region.stv = await page.evaluate(() => ({
  title: document.getElementById('region-name').textContent,
  seats: document.getElementById('region-seats').textContent,
  stages: document.querySelectorAll('#region-stages .stage-row').length,
  full: [...document.querySelectorAll('#region-stages .stage-row')].every((row) =>
    Math.abs([...row.querySelectorAll('.stage-seg')]
      .reduce((a, seg) => a + parseFloat(seg.style.width), 0) - 100) < 0.5),
  pieShown: !document.getElementById('region-pie').hasAttribute('hidden'),
  overallHidden: document.getElementById('overall').hidden,
}));
await page.evaluate(() => {
  const e = document.getElementById('ctl-election-type');
  e.value = 'fptp';
  e.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
election.region.fptp = await page.evaluate(() => {
  // One wedge per party that stood here, which is not all nine: the standing
  // rule keeps the parties with too little support locally off the ballot.
  const m = window.__model;
  const out = new Uint8Array(m.parties.length);
  // Which region is on show, before any click has told the test directly.
  const r = Number(document.getElementById('region-name').textContent.replace(/\D/g, '')) - 1;
  return {
    wedges: document.querySelectorAll('#region-pie path').length,
    standing: [...m.regionStanding(r, out)].filter(Boolean).length,
    seats: document.getElementById('region-seats').textContent,
    stagesShown: !document.getElementById('region-stages').hasAttribute('hidden'),
  };
});
// clicking the map picks the region, and it is remembered
const first = await page.evaluate(() => document.getElementById('region-name').textContent);
await page.mouse.click(pt.x, pt.y);
await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
election.region.afterClick = await page.evaluate(() => ({
  title: document.getElementById('region-name').textContent,
  matchesModel: document.getElementById('region-name').textContent
    === `Region ${window.__shownRegionForTest + 1}`,
}));
election.region.first = first;

// Pointing at the region's name or its swatch lights that region on the map.
// Dispatched rather than pointed at: the element is static, so there is no
// position to get wrong, and the swatch sits inside the title either way.
election.region.titleVeil = await page.evaluate(async () => {
  const m = window.__model;
  const title = document.getElementById('region-title');
  const lit = () => {
    const on = m.codes.filter((c) => window.__map.getFeatureState({ source: 'dz', id: c }).veil);
    const regions = [...new Set(on.map((c) => m.regionOf(c)))];
    return { n: on.length, regions };
  };
  title.dispatchEvent(new MouseEvent('mouseenter'));
  await new Promise((r) => setTimeout(r, 250));
  const on = lit();
  title.dispatchEvent(new MouseEvent('mouseleave'));
  await new Promise((r) => setTimeout(r, 250));
  const shown = Number(document.getElementById('region-name').textContent
    .replace(/\D/g, '')) - 1;
  return {
    shown,
    litRegions: on.regions,
    whole: on.regions.length === 1
      && on.n === m.codes.filter((c) => m.regionOf(c) === shown).length,
    clearedOnLeaving: lit().n === 0,
    swatchInsideTitle: title.contains(document.getElementById('region-swatch')),
  };
});

await page.click('#view-overall');
await page.click('#view-region');
election.region.remembered = await page.evaluate(() =>
  document.getElementById('region-name').textContent);

// A variable taken off the page takes its block, its readout row and its entry
// in the results selector with it -- and stops steering, which is the point.
await page.click('#view-overall');
election.removed = await page.evaluate(() => {
  const before = {
    blocks: document.querySelectorAll('#variables .demo-block').length,
    options: [...document.querySelectorAll('#bars-stat option')].map((o) => o.value),
    offered: [...document.querySelectorAll('#ctl-add .add-item')].map((b) => b.dataset.key),
  };
  document.querySelector('#rel-body').previousElementSibling
    .querySelector('.var-remove').click();
  return {
    before,
    blocks: document.querySelectorAll('#variables .demo-block').length,
    options: [...document.querySelectorAll('#bars-stat option')].map((o) => o.value),
    offered: [...document.querySelectorAll('#ctl-add .add-item')].map((b) => b.dataset.key),
    rowGone: document.getElementById('run-var-rel') === null,
    weight: window.__model.demoByKey.rel.weight,
    mode: window.__model.demoByKey.rel.mode,
    // The pie belongs to the map, not to any variable: it stays.
    pieShown: !document.getElementById('pie').hidden,
  };
});
election.electionOptions = electionOptions;

console.log(JSON.stringify({ graph, regions, statSwitch, pause, tip, election, real, painted, errors, failed, external }, null, 2));
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
if (!regions || regions.movesShown !== regions.moves.toLocaleString('en-GB')) {
  problems.push('flips readout does not match the model');
}
if (!barVeil || !barVeil.row || !barVeil.whole || barVeil.regions[0] !== barVeil.row - 1
    || !barVeil.clearedOnLeaving) {
  problems.push(`hovering a bar did not light its region alone: ${JSON.stringify(barVeil)}`);
}
if (!resultsAtRest || !resultsAtRest.panel || !resultsAtRest.hint
    || resultsAtRest.overall || resultsAtRest.viewSwitch
    || !resultsAtRest.hintText.startsWith('Select your settings')) {
  problems.push('the results panel was not already there with its help text');
}
// Three of the four map statistics belong to sliders that wait for advanced
// mode, so their charts wait with them.
if (!statSwitch || ['land', 'people', 'cut'].some((v) => statSwitch.basicOptions.includes(v))
    || !statSwitch.basicOptions.includes('pop')) {
  problems.push('the shape statistics were offered in basic mode: '
    + (statSwitch && statSwitch.basicOptions.join(', ')));
}
// A written-down height, not a measured one, so this checks the panel is held
// open at roughly what the CSS says and still fits the window.
if (!resultsAtRest || !resultsAtRest.resting || !resultsAtRest.fitsWindow
    || resultsAtRest.height < 600 || resultsAtRest.height > 760) {
  problems.push('the empty results panel was not held open: '
    + (resultsAtRest && `${Math.round(resultsAtRest.height)}px`));
}
if (!regions || !regions.panelAlwaysUp || !regions.resultsShown) {
  problems.push('the help text did not give way to the results');
}
const WANT_STATS = ['Phase', 'Flips', 'ReCom', 'Score', 'Best score', 'Max pop dev'];
if (!regions || WANT_STATS.some((label, i) => regions.statLabels[i] !== label)) {
  problems.push(`overall stats wrong: ${regions && regions.statLabels.join(', ')}`);
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
if (!regions || regions.gerryVisible.blocks !== regions.demoKeys.length + 1) {
  problems.push(`a variable block is missing (${regions && regions.gerryVisible.blocks} `
    + `for ${regions && regions.demoKeys.length} demographics plus the opening one)`);
}
if (!regions || regions.demoKeys.some((k) => !regions.gerryVisible.bars.includes(`demo:${k}`))) {
  problems.push('a demographic is missing from the statistic selector');
}
// Gerrymander mode has a real count and names the side it was drawn for. The
// other modes have nothing to say, so their row is off the list entirely --
// a row holding a dash claimed a fact and then withheld it.
if (!regions || regions.demoReadouts.some(({ mode, text, hidden }) => (mode === 'gerrymander'
  ? hidden || !/^\d+\/\d+ (above|below)$/.test(text) : !hidden))) {
  problems.push('a demographic readout does not match its mode: '
    + (regions && JSON.stringify(regions.demoReadouts)));
}
// Gerrymander mode names the side it was aiming at; the goal defaults to above.
if (!initialPanel || initialPanel.barStat !== 'party:Alliance') {
  problems.push('the bars did not open on the page\'s own variable: '
    + (initialPanel && initialPanel.barStat));
}
if (!regions || regions.relShown !== `${regions.relSeats} above`) {
  problems.push(`religion readout wrong: ${regions && regions.relShown}`);
}
// Age is in extreme mode, whose spread is uninterpretable, so it has no row.
if (!regions || !regions.ageRowGone) {
  problems.push('age kept a readout row with nothing in it');
}
// Every weight is up, so every demographic counts as active and should show.
const wantDemo = regions ? regions.demoKeys.length : 0;
if (!tip || tip.demo.length !== wantDemo) {
  problems.push('a demographic is missing from the tooltip');
}
if (!tip || tip.regionDemo.length !== wantDemo) {
  problems.push("a demographic is missing from the tooltip's region block");
}
if (!election || election.blocks !== 6 || !election.relStillThere) {
  problems.push(`parties and demographics should share the page (${election && election.blocks} blocks)`);
}
if (!election || election.demoWeightsOn !== 4) {
  problems.push(`every demographic should still be steering (${election && election.demoWeightsOn})`);
}
if (!election || election.mode !== 'gerrymander') problems.push('party mode did not take');
if (!election || election.shown !== `${election.seats}/${election.regions} won`) {
  problems.push('party readout does not match the model');
}
if (!election || election.label !== 'DUP') problems.push('party readout not labelled with the party');
if (!election || election.marked !== election.seats) {
  problems.push('bars marked as won do not match the seats');
}
if (!election || !election.electionOptions.includes('party:DUP')
    || !election.electionOptions.includes('demo:rel')
    || election.electionOptions.includes('party:Sinn Féin')) {
  problems.push(`statistic selector should offer exactly the variables on the page `
    + `(${election && election.electionOptions.join(', ')})`);
}
if (!election || election.removed.blocks !== election.removed.before.blocks - 1
    || !election.removed.rowGone) {
  problems.push('removing a variable left its block or its readout behind');
}
if (!election || election.removed.options.includes('demo:rel')
    || !election.removed.before.options.includes('demo:rel')) {
  problems.push('removing a variable left it in the results selector');
}
if (!election || !election.removed.offered.includes('rel')
    || election.removed.before.offered.includes('rel')) {
  problems.push(`a removed variable was not offered again `
    + `(${election && election.removed.offered.join(', ')})`);
}
if (!election || election.removed.weight !== 0 || election.removed.mode !== 'off') {
  problems.push('a removed variable kept steering the map');
}
if (!election || !election.removed.pieShown) {
  problems.push('the pie should not depend on which variables are on the page');
}

if (!election || !election.standing.on.shown) problems.push('standing checkbox hidden in election mode');
if (!election || !election.standing.on.rule || election.standing.off.rule) {
  problems.push('standing checkbox did not reach the model');
}
if (!election || !(election.standing.on.absent > 0) || election.standing.off.absent !== 0) {
  problems.push('standing rule kept every party on every ballot');
}
if (!election || !(election.standing.on.votes < election.standing.off.votes)) {
  problems.push('nobody stayed at home when their party did not stand');
}
if (!election || election.standing.back.votes !== election.standing.on.votes) {
  problems.push('toggling the standing rule did not restore the votes');
}

if (!seed || seed.placeholder !== 'Auto') problems.push('seed box does not offer Auto');
if (!seed || seed.fixedLabel !== '') {
  problems.push(`a typed seed should not be repeated in the label (${seed && seed.fixedLabel})`);
}
if (!seed || !/^\d+$/.test(seed.first) || !/^\d+$/.test(seed.second)) {
  problems.push(`an automatic seed should be reported plainly (${seed && seed.first})`);
}
if (!seed || seed.first === seed.second) {
  problems.push(`automatic seeds should differ run to run (${seed && seed.first})`);
}
if (!seed || seed.boxAfter !== '') problems.push('an automatic seed was written into the box');

// Votes are conserved: every voter lands in exactly one region.
if (!election || Math.abs(election.nationalVotes - election.zoneVotes) > 2) {
  problems.push(`votes not conserved (${election && election.nationalVotes} in regions, `
    + `${election && election.zoneVotes} in zones)`);
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
// A rank is printed exactly where a row does not follow the one above it. Walk
// the list keeping the standing each row must be at: an unprinted rank means
// "one more than the last", a printed one must be a genuine jump past that, or
// it is telling the reader what the row above already told them. Which party
// is promoted depends on the map, so this checks the rule rather than a name.
{
  const ranks = election && election.tip ? election.tip.ranks : null;
  let at = 0;
  let bad = !ranks || !ranks.length;
  for (const r of ranks || []) {
    if (r === null) at += 1;
    else if (r <= at + 1) { bad = true; break; }
    else at = r;
  }
  if (bad) problems.push(`tooltip rank numbers wrong: ${JSON.stringify(ranks)}`);
}
if (!election || election.tip.demoHidden) {
  problems.push('tooltip dropped the demographic lines, which now share it with the parties');
}
if (!election || !election.manyParties || !election.manyParties.allListed
    || election.manyParties.rows < election.manyParties.onPage) {
  problems.push('tooltip dropped a party that was on the page: '
    + JSON.stringify(election && election.manyParties));
}
if (!election || !election.unsteered || election.unsteered.rows !== 5
    || election.unsteered.lit !== 0 || !election.unsteered.keptDup
    || !election.unsteered.demoLines || !/votes?\b/.test(election.unsteered.zoneParty || '')) {
  problems.push('tooltip did not keep the election and the variables with nothing steered: '
    + JSON.stringify(election && election.unsteered));
}
if (!election || !election.pie.shown) problems.push('seats pie missing in election mode');
if (!election || election.pie.wedges !== 9) problems.push('a party is missing from the pie');
if (!election || election.pie.drawn !== election.pie.withSeats) {
  problems.push('pie wedges do not match the parties holding seats');
}
if (!election || election.pie.total !== election.pie.regions) {
  problems.push('pie seats do not add up to the regions');
}
if (!election || election.pie.caption !== 'Hover over to see individual results') {
  problems.push(`pie caption should say what to do first (${election && election.pie.caption})`);
}
if (!election || !/\u2014 \d+ seats?$/.test(election.pie.hovered || '')) {
  problems.push(`pie caption wrong on hover (${election && election.pie.hovered})`);
}
if (!election || election.pie.afterLeaving !== election.pie.hovered) {
  problems.push('pie caption did not stay on the party once the pointer left ('
    + (election && `${election.pie.hovered} -> ${election.pie.afterLeaving}`) + ')');
}
if (!election || !election.pie.lastRowIsParty) {
  problems.push('party readout is not last in the results block');
}
// STV: the controls that apply, and a count that fills every region.
if (!election || !election.lockedDuringRun.regions || election.lockedDuringRun.type
    || election.lockedDuringRun.seats) {
  problems.push('region count not locked during a run, or election controls locked');
}
if (!election || !election.unlockedAfterStop) {
  problems.push('region count stayed locked after the run stopped');
}
// The editor: what the buttons allow, and that the votes follow.
const ed = election && election.editor;
if (!ed || ed.start.rows.length !== 9 || ed.start.buttons.some((b) => !b.endsWith(':off'))) {
  problems.push('party editor did not start with nine parties and nothing to do');
}
if (!ed || ed.onePicked[0] !== 'Include:off' || ed.onePicked[1] !== 'Exclude:on'
    || ed.onePicked[2] !== 'Merge:off') {
  problems.push(`one standing party: exclude only, no merge (${ed && ed.onePicked.join(' ')})`);
}
if (!ed || ed.excludedPicked[0] !== 'Include:on' || ed.excludedPicked[1] !== 'Exclude:off') {
  problems.push(`one struck-off party: include only (${ed && ed.excludedPicked.join(' ')})`);
}
if (!ed || ed.mixedPicked[0] !== 'Include:on' || ed.mixedPicked[1] !== 'Exclude:on') {
  problems.push(`a mixed selection: both live (${ed && ed.mixedPicked.join(' ')})`);
}
if (!ed || !ed.excluded.rows.includes('TUV(out)') || ed.excluded.selected !== 0) {
  problems.push('excluding a party did not take, or left it selected');
}
if (!ed || ed.excluded.votes[5] !== 0 || !(ed.excluded.votes[1] > ed.start.votes[1])) {
  problems.push("an excluded party's votes did not move on");
}
if (!ed || ed.twoPicked[2] !== 'Merge:on') problems.push('two selected parties should allow a merge');
if (!ed || ed.merged.rows.length !== 8 || ed.merged.rows.includes('DUP')
    || ed.merged.rows.includes('UUP')) {
  problems.push('a merger should head the list and take its parties out of it');
}
if (!ed || ed.merged.votes[3] !== 0
    || Math.abs(ed.merged.votes[1] - (ed.excluded.votes[1] + ed.excluded.votes[3])) > 2) {
  problems.push('a merger did not gather its parties\' votes');
}
// DUP was being gerrymandered and hosts the merger, so its variable stays and
// takes the merger's name; UUP is no longer an entity, so it is not on offer.
if (!ed || !ed.merged.steering.includes(ed.merged.rows[0])
    || ed.merged.offered.includes('UUP')) {
  problems.push(`the gerrymander target did not follow the merger `
    + `(${ed && ed.merged.steering.join(', ')})`);
}
if (!ed || ed.mergedPicked[2] !== 'Unmerge:on') {
  problems.push('one merged party selected should offer Unmerge');
}
if (!ed || ed.restored.rows.length !== 9
    || ed.restored.votes.some((v, i) => Math.abs(v - ed.start.votes[i]) > 1)) {
  problems.push('unmerging and including did not restore the ballot');
}
if (!election || !election.region.stv.stages || !election.region.stv.full
    || election.region.stv.pieShown || !election.region.stv.overallHidden) {
  problems.push('STV region view missing its stage bars');
}
if (!election || !/\d/.test(election.region.stv.seats)
    || !/quota/.test(election.region.stv.seats)) {
  problems.push('STV region view missing its seat line');
}
if (!election || election.region.fptp.wedges < 2 || election.region.fptp.stagesShown
    || election.region.fptp.wedges !== election.region.fptp.standing
    || !/^Winner: /.test(election.region.fptp.seats)) {
  problems.push('FPTP region view missing its pie');
}
{
  const v = election && election.region && election.region.titleVeil;
  if (!v || !v.whole || v.litRegions[0] !== v.shown || !v.clearedOnLeaving
      || !v.swatchInsideTitle) {
    problems.push(`region title hover did not light its region: ${JSON.stringify(v)}`);
  }
}
if (!election || election.region.remembered !== election.region.afterClick.title) {
  problems.push('region view forgot which region was shown');
}

if (!election || !election.stv.controls.seats || election.stv.controls.margin
    || election.stv.controls.bonus
    || election.stv.controls.goalLabel !== 'Goal'
    || election.stv.controls.goal !== 'above'
    || election.stv.controls.goalOptions.join('|') !== 'above:Win|below:Lose') {
  problems.push('STV gerrymander controls wrong');
}
if (!election || election.stv.perRegion.some((n) => n !== election.stv.seatsPer)) {
  problems.push('an STV region did not fill its seats');
}
if (!election || election.stv.total !== election.stv.regions * election.stv.seatsPer
    || election.stv.allParties !== election.stv.total) {
  problems.push('STV seats do not add up');
}
if (!election || election.stv.readout !== `${election.stv.dup}/${election.stv.total} won`) {
  problems.push('party readout wrong under STV');
}
if (!election || election.stv.barSeats.length !== election.stv.regions
    || election.stv.barSeats.reduce((a, b) => a + b, 0) !== election.stv.dup) {
  problems.push('per-region seats on the bars do not match the total');
}
if (!real || real.westminster.N !== 18 || real.westminster.assigned !== 3780
    || real.westminster.painted !== 3780 || real.westminster.bars !== 18) {
  problems.push('Westminster boundaries did not load onto the map');
}
if (!real || real.westminster.regionsBox !== '18' || !real.westminster.regionsDisabled) {
  problems.push('the region count did not follow the real map');
}
if (!real || real.council.N !== 80 || real.council.painted !== 3780) {
  problems.push('council boundaries did not load onto the map');
}
// It stays on the page now, greyed rather than gone, but it still resets: the
// map stopped being the real one with the first move.
if (!real || !real.running.selectorShown || !real.running.selectorDisabled
    || real.running.value !== 'none') {
  problems.push('the real-region selector was not greyed and reset by the run');
}
if (!real || !real.running.groupFolded) {
  problems.push('the region settings group did not fold away for the run');
}
if (!real || !real.stopped.selectorShown || real.stopped.selectorDisabled
    || real.stopped.regionsDisabled || real.stopped.groupFolded) {
  problems.push('the region settings did not come back when the run stopped');
}
const adv = advancedMode;
if (!adv || !adv.simple.compact || adv.simple.parts.some(Boolean) || adv.simple.bonus
    || adv.simple.recom || adv.simple.branch) {
  problems.push('simple mode showed more than Compactness');
}
if (!adv || adv.open.compact || !adv.open.parts.every(Boolean) || !adv.open.bonus
    || !adv.open.recom || !adv.open.branch) {
  problems.push('advanced mode did not bring out the fine tuning');
}
if (!adv || adv.simple.shapeStats !== 0 || adv.open.shapeStats !== 3) {
  problems.push('the shape statistics did not follow the advanced switch: '
    + (adv && `${adv.simple.shapeStats} then ${adv.open.shapeStats}`));
}
// The run's counters and its score are bookkeeping; the phase and the
// population deviation are the result, and stay out in both modes.
if (!adv || adv.simple.runRows.some(Boolean) || !adv.open.runRows.every(Boolean)
    || !adv.simple.runKept.every(Boolean) || !adv.open.runKept.every(Boolean)) {
  problems.push('the run rows showed at the wrong times');
}
// A demographic's threshold is the one piece of a gerrymander that is not fine
// tuning: without it the mode does not say which side of what.
if (!adv || !adv.simple.relThreshold || adv.simple.relSteepness
    || !adv.open.relThreshold || !adv.open.relSteepness) {
  problems.push("a demographic's threshold and steepness showed at the wrong times");
}
const search = searchControls;
if (!search || search.moved.interval !== '1000' || search.moved.readout !== '1,000'
    || search.moved.branch !== false) {
  problems.push('the restored search controls did not reach the model');
}
if (!search || search.off.interval !== 'Infinity' || search.off.readout !== 'off') {
  problems.push('the ReCom detent did not turn recombination off');
}
// Mean of 0.5, 0 and -0.5 is 0, and all four must be sitting on it.
if (!adv || adv.flat.compact !== 0 || adv.flat.values.some((v) => v !== 0)
    || adv.flat.readout !== '1' || adv.flat.stored !== '0') {
  problems.push('leaving advanced mode did not flatten the three to their mean');
}
if (!adv || adv.spread.some((v) => v !== 0.4)) {
  problems.push('Compactness did not drive the three sliders it stands for');
}
if (!real || real.cleared.painted !== 0 || real.cleared.results) {
  problems.push('choosing None did not clear the map');
}
if (!pause || pause.label !== 'RESUME' || !pause.held) problems.push('pause did not hold the run');
// The accent marks the obvious next action, and it moves once a run is going.
if (!pause || !pause.primary || pause.primary.idle !== 'ctl-go'
    || pause.primary.running !== 'ctl-stop') {
  problems.push(`the accent should sit on START, then on STOP `
    + `(${pause && JSON.stringify(pause.primary)})`);
}
if (!pause || !pause.advanced || pause.resumedLabel !== 'PAUSE') problems.push('resume did not restart the run');
if (problems.length) {
  console.error(`\nSMOKE TEST FAILED: ${problems.join('; ')}`);
  process.exit(1);
}
console.error('\nsmoke test passed');
