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
const gerryVisible = await page.evaluate(() => ({
  rel: !document.getElementById('rel-gerry').hidden,
  age: !document.getElementById('age-gerry').hidden,        // extreme: stays shut
  blocks: document.querySelectorAll('#variables .demo-block').length,
  bars: [...document.querySelectorAll('#bars-stat option')].map((o) => o.value),
}));
await page.click('#ctl-go');
await page.waitForFunction(
  () => document.getElementById('run-phase').textContent.startsWith('Optimising'),
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
    ageSpread: m.demoSpread('age').toFixed(1),
    ageShown: document.getElementById('run-var-age').textContent,
    demoKeys: m.demographics.map((d) => d.key),
    demoReadouts: m.demographics.map((d) =>
      document.getElementById(`run-var-${d.key}`).textContent),
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
    value: document.getElementById('ctl-real').value,
    results: !document.getElementById('results').hidden,
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
      bonus: !document.getElementById('ctl-bonus').hidden,
      direction: document.querySelector('label[for="ctl-party-dup-a"]').textContent,
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
  title: document.getElementById('region-title').textContent,
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
  const r = Number(document.getElementById('region-title').textContent.replace(/\D/g, '')) - 1;
  return {
    wedges: document.querySelectorAll('#region-pie path').length,
    standing: [...m.regionStanding(r, out)].filter(Boolean).length,
    seats: document.getElementById('region-seats').textContent,
    stagesShown: !document.getElementById('region-stages').hasAttribute('hidden'),
  };
});
// clicking the map picks the region, and it is remembered
const first = await page.evaluate(() => document.getElementById('region-title').textContent);
await page.mouse.click(pt.x, pt.y);
await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
election.region.afterClick = await page.evaluate(() => ({
  title: document.getElementById('region-title').textContent,
  matchesModel: document.getElementById('region-title').textContent
    === `Region ${window.__shownRegionForTest + 1}`,
}));
election.region.first = first;
await page.click('#view-overall');
await page.click('#view-region');
election.region.remembered = await page.evaluate(() =>
  document.getElementById('region-title').textContent);

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
if (!election || !election.tip
    || election.tip.ranked !== (election.tip.rows.findIndex((r) => /DUP/.test(r)) === 4 ? 1 : 0)) {
  problems.push('tooltip rank number shown in the wrong case');
}
if (!election || election.tip.demoHidden) {
  problems.push('tooltip dropped the demographic lines, which now share it with the parties');
}
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
    || !/wins the seat/.test(election.region.fptp.seats)) {
  problems.push('FPTP region view missing its pie');
}
if (!election || election.region.remembered !== election.region.afterClick.title) {
  problems.push('region view forgot which region was shown');
}

if (!election || !election.stv.controls.seats || election.stv.controls.margin
    || !election.stv.controls.bonus
    || election.stv.controls.direction !== 'Win seats') {
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
if (!real || real.running.selectorShown || real.running.value !== 'none') {
  problems.push('the real-region selector stayed up once a run started');
}
if (!real || !real.stopped.selectorShown || real.stopped.regionsDisabled) {
  problems.push('the selector did not come back when the run stopped');
}
if (!real || real.cleared.painted !== 0 || real.cleared.results) {
  problems.push('choosing None did not clear the map');
}
if (!pause || pause.label !== 'RESUME' || !pause.held) problems.push('pause did not hold the run');
if (!pause || !pause.advanced || pause.resumedLabel !== 'PAUSE') problems.push('resume did not restart the run');
if (problems.length) {
  console.error(`\nSMOKE TEST FAILED: ${problems.join('; ')}`);
  process.exit(1);
}
console.error('\nsmoke test passed');
