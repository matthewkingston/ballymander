/* NI Data Zones — interactive map and region builder.
 *
 * Structure is deliberately split into data / map / layers / interaction / run
 * so the dynamic features slot in without restructuring:
 *   - recolour by any metric  -> map.setPaintProperty('dz-fill', 'fill-color', expr)
 *   - swap the dataset        -> map.getSource(SRC).setData(next)
 * Hover and region colour both use feature-state, so nothing re-renders per
 * mouse move and no geometry is re-uploaded as regions change.
 *
 * The region algorithm itself lives in regions.js, free of DOM and MapLibre so
 * it can be tested headlessly (scripts/test_regions.mjs). This file only drives
 * it and paints the result.
 */
'use strict';

const CONFIG = {
  dataUrl: 'data/dz.geojson',
  graphUrl: 'data/dz_adjacency.json',
  votersUrl: 'data/dz_voters.json',
  // Measured extent of DZ2021.geojson.
  bounds: [[-8.1775, 54.0227], [-5.4328, 55.3130]],
  colors: {
    background: '#dfe7ee',
    fill: '#f4f1ea',
    fillHover: '#d9622b',
    line: '#a9b6c2',
  },
};

const SRC = 'dz';
const nf = new Intl.NumberFormat('en-GB');
const pct = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 2 });

const els = {
  status: document.getElementById('status'),
  tooltip: document.getElementById('tooltip'),
  ttName: document.querySelector('.tt-name'),
  ttPop: document.querySelector('.tt-pop-value'),
  ttDemo: document.querySelector('.tt-demo'),
  ttRegion: document.querySelector('.tt-region'),
  ttRegionName: document.querySelector('.tt-region-name'),
  ttRegionPop: document.querySelector('.tt-region-pop-value'),
  ttRegionDemo: document.querySelector('.tt-region-demo'),
  n: document.getElementById('ctl-n'),
  seed: document.getElementById('ctl-seed'),
  temp: document.getElementById('ctl-temp'),
  fps: document.getElementById('ctl-fps'),
  fpsValue: document.getElementById('ctl-fps-value'),
  build: document.getElementById('ctl-build'),
  buildValue: document.getElementById('ctl-build-value'),
  opt: document.getElementById('ctl-opt'),
  optValue: document.getElementById('ctl-opt-value'),
  popw: document.getElementById('ctl-popw'),
  popwValue: document.getElementById('ctl-popw-value'),
  shape: document.getElementById('ctl-shape'),
  shapeValue: document.getElementById('ctl-shape-value'),
  pshape: document.getElementById('ctl-pshape'),
  pshapeValue: document.getElementById('ctl-pshape-value'),
  cut: document.getElementById('ctl-cut'),
  cutValue: document.getElementById('ctl-cut-value'),
  recom: document.getElementById('ctl-recom'),
  recomValue: document.getElementById('ctl-recom-value'),
  demoBlocks: document.getElementById('demo-blocks'),
  partyBlock: document.getElementById('party-block'),
  modeDemographics: document.getElementById('mode-demographics'),
  modeElection: document.getElementById('mode-election'),
  electionType: document.getElementById('ctl-election-type'),
  seats: document.getElementById('ctl-seats'),
  pie: document.getElementById('pie'),
  pieSvg: document.getElementById('pie-svg'),
  pieCaption: document.getElementById('pie-caption'),
  ttParty: document.querySelector('.tt-party'),
  ttRegionParty: document.querySelector('.tt-region-party'),
  go: document.getElementById('ctl-go'),
  pause: document.getElementById('ctl-pause'),
  stop: document.getElementById('ctl-stop'),
  runPhase: document.getElementById('run-phase'),
  runDev: document.getElementById('run-dev'),
  runShape: document.getElementById('run-shape'),
  runPShape: document.getElementById('run-pshape'),
  runCut: document.getElementById('run-cut'),
  runRecom: document.getElementById('run-recom'),
  runMoves: document.getElementById('run-moves'),
  runScoreRow: document.getElementById('run-score-row'),
  runScore: document.getElementById('run-score'),
  runBest: document.getElementById('run-best'),
  results: document.getElementById('results'),
  resultsList: document.getElementById('results-list'),
  barsStat: document.getElementById('bars-stat'),
  bars: document.getElementById('bars'),
  barsMin: document.getElementById('bars-min'),
  barsMax: document.getElementById('bars-max'),
};

/* Live run state. `shadow` is what the map currently shows, so each redraw only
 * pushes the zones that actually changed. */
const run = {
  model: null,
  phase: 'idle',          // idle | build | optimise | done
  raf: 0,
  paused: false,
  lastDraw: 0,
  lastBars: 0,
  shadow: null,
  colors: [],
  bars: [],               // one {row, fill, value} per region, never reordered
};

/* Party colours for the seats pie. Roughly the parties' own, and distinct
 * enough from each other to read at this size. */
const PARTY_COLORS = {
  'Sinn Féin': '#186a3b',
  SDLP: '#c8102e',
  DUP: '#e8801a',
  UUP: '#7fb3e3',
  TUV: '#1b2f6b',
  Alliance: '#f2c313',
  Green: '#7ac143',
  'Aontú': '#6b3fa0',
  PBP: '#ef5a7a',
};

/* Which set of variables steers the run: 'demographics' or 'election'. The
 * hidden side's weights are forced to zero, so nothing steers unseen. */
let uiMode = 'demographics';
let election = null;      // set once web/data/dz_voters.json is loaded

const BAR_ROW_H = 18;     // must match .bar-row height in style.css
const BAR_INTERVAL = 200; // five redraws a second

/* What the bars can show: one per score term that has a weight slider. Each
 * needs its own format -- population wants thousands and no decimals, the
 * others want decimals -- but the padded min-to-max scale is generic, so
 * nothing else has to know which one is selected. */
const perRegion = (m, get) => Array.from({ length: m.N }, (_, r) => get(m, r));

const BAR_STATS = {
  pop: {
    values: (m) => perRegion(m, (x, r) => x.regionPop[r]),
    format: (v) => nf.format(Math.round(v)),
  },
  land: {
    values: (m) => perRegion(m, (x, r) => x.regionPenalty(r)),
    format: (v) => v.toFixed(2),
  },
  people: {
    values: (m) => perRegion(m, (x, r) => x.regionPopPenalty(r)),
    format: (v) => v.toFixed(2),
  },
  // One pass over the whole graph rather than one per region, which is why
  // statistics hand back an array instead of a per-region getter.
  cut: { values: (m) => Array.from(m.cutByRegion()), format: (v) => nf.format(v) },
};
for (const def of DEMOGRAPHICS) {
  BAR_STATS[`demo:${def.key}`] = {
    values: (m) => perRegion(m, (x, r) => x.regionDemo(def.key, r)),
    format: (v) => v.toFixed(def.decimals),
    modes: ['demographics'],
  };
}

/* Votes rather than shares, because that is what a first-past-the-post result
 * is counted in; `wins` marks the regions the party takes. */
function addPartyBarStats(parties) {
  for (const party of parties) {
    const key = `party:${party}`;
    BAR_STATS[key] = {
      values: (m) => perRegion(m, (x, r) => x.regionPartyVotes(key, r)),
      format: (v) => nf.format(Math.round(v)),
      // Under STV a region can return the party more than once, so the marker
      // ("took a seat here") is joined by the count itself.
      wins: (m, r) => m.regionPartySeats(key, r) > 0,
      seats: (m, r) => m.regionPartySeats(key, r),
      modes: ['election'],
    };
  }
}

/* The statistic list depends on the mode: shared terms always, then either the
 * demographics or the parties. Keeps the current choice if it still applies. */
function rebuildBarOptions() {
  const want = els.barsStat.value;
  els.barsStat.textContent = '';
  for (const [key, stat] of Object.entries(BAR_STATS)) {
    if (stat.modes && !stat.modes.includes(uiMode)) continue;
    const label = key.startsWith('party:') ? `${key.slice(6)} votes`
      : key.startsWith('demo:')
        ? DEMOGRAPHICS.find((d) => d.key === key.slice(5)).label
        : { pop: 'Population', land: 'Land shape', people: 'People shape',
            cut: 'Cut edges' }[key];
    els.barsStat.append(el('option', { value: key }, label));
  }
  els.barsStat.value = BAR_STATS[want] && (!BAR_STATS[want].modes
    || BAR_STATS[want].modes.includes(uiMode)) ? want : 'pop';
}

/* --- demographic controls ------------------------------------------------ */
/* One collapsible block per entry in DEMOGRAPHICS, plus its readout row, its
 * bar-chart entry and its two tooltip lines. All of it is generated, so a third
 * demographic is one entry in regions.js and nothing here or in the HTML. */
const demoUI = [];

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...kids);
  return node;
};

function buildDemoControls() {
  for (const def of DEMOGRAPHICS) {
    const id = (part) => `ctl-${def.key}-${part}`;
    const bodyId = `demo-${def.key}-body`;

    const wValue = el('span', { text: 'off' });
    const modeLabel = el('span', { class: 'demo-mode-label', text: 'average' });
    const toggle = el('button', {
      class: 'demo-toggle', type: 'button', 'aria-expanded': 'false',
      'aria-controls': bodyId,
    }, el('span', { class: 'chev', 'aria-hidden': 'true', text: '\u25B8' }),
       ` ${def.label}`);
    const w = el('input', {
      id: id('w'), type: 'range', min: -1.02, max: 1, step: 0.02, value: -1.02,
      'data-weight': true, 'data-off': true,
    });

    const mode = el('select', { id: id('mode') },
      ...['average', 'extreme', 'gerrymander'].map((v) =>
        el('option', { value: v, selected: v === 'average' }, v)));

    // The threshold and steepness sliders carry the term's own units and
    // range -- 0-1 for religion, years for age -- straight from its definition.
    const [tMin, tMax, tStep] = def.thresholdRange;
    const [sMin, sMax, sStep] = def.steepnessRange;
    const tValue = el('span', { text: String(def.threshold) });
    const sValue = el('span', { text: String(def.steepness) });
    const t = el('input', {
      id: id('t'), type: 'range', min: tMin, max: tMax, step: tStep,
      value: def.threshold,
    });
    const st = el('input', {
      id: id('s'), type: 'range', min: sMin, max: sMax, step: sStep,
      value: def.steepness,
    });
    const above = el('input', { id: id('a'), type: 'checkbox', checked: true });

    const gerry = el('div', {
      id: `demo-${def.key}-gerry`, class: 'ctl-grid ctl-sub', hidden: true },
      el('label', { for: id('t') }, 'Threshold ', tValue), t,
      el('label', { for: id('s') }, 'Steepness ', sValue), st,
      el('label', { for: id('a'), text: 'Above threshold' }), above);

    const body = el('div', { id: bodyId, class: 'demo-body', hidden: true },
      el('div', { class: 'ctl-grid ctl-sub' },
        el('label', { for: id('mode'), text: 'Mode' }), mode),
      gerry);

    els.demoBlocks.append(el('div', { class: 'demo-block' },
      el('div', { class: 'ctl-grid' },
        el('div', { class: 'ctl-head' }, toggle, modeLabel, wValue), w),
      body));

    // Mode-dependent, because the useful number differs: how far apart the
    // regions are for average/extreme, how many clear the bar for gerrymander.
    const readout = el('dd', { id: `run-demo-${def.key}`, text: '\u2014' });
    els.runScoreRow.before(el('div', {}, el('dt', { text: def.label }), readout));

    els.barsStat.querySelector('option[value="cut"]')
      .before(el('option', { value: `demo:${def.key}` }, def.label));

    const tip = el('div');
    const regionTip = el('div');
    els.ttDemo.append(tip);
    els.ttRegionDemo.append(regionTip);

    demoUI.push({ def, toggle, body, modeLabel, wValue, w, mode, gerry,
                  t, tValue, s: st, sValue, above, readout, tip, regionTip });
  }
}

/* --- seats pie ----------------------------------------------------------- */

/* One wedge per party, sized by regions won. Drawn once and then only its
 * paths are rewritten, so hovering a wedge is never interrupted by a redraw.
 * No labels: the caption names whatever is under the pointer. */
const SVG_NS = 'http://www.w3.org/2000/svg';
let pieWedges = [];
let pieShown = '';

function buildPie(parties) {
  els.pieSvg.textContent = '';
  pieWedges = parties.map((party) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', PARTY_COLORS[party] || '#9aa7b4');
    path.addEventListener('mouseenter', () => {
      const seats = run.model ? run.model.partySeats(`party:${party}`) : 0;
      els.pieCaption.textContent = `${party} — ${seats} ${seats === 1 ? 'seat' : 'seats'}`;
    });
    path.addEventListener('mouseleave', () => { els.pieCaption.innerHTML = '&nbsp;'; });
    els.pieSvg.append(path);
    return { party, path, seats: 0 };
  });
}

/* A wedge from `from` to `to` radians, clockwise from twelve o'clock. A single
 * party holding every seat has no arc to draw, so it gets a full circle. */
function wedgePath(from, to) {
  if (to - from >= Math.PI * 2 - 1e-9) {
    return 'M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z';
  }
  const x = (a) => Math.sin(a).toFixed(5);
  const y = (a) => (-Math.cos(a)).toFixed(5);
  return `M 0 0 L ${x(from)} ${y(from)} `
    + `A 1 1 0 ${to - from > Math.PI ? 1 : 0} 1 ${x(to)} ${y(to)} Z`;
}

function drawPie() {
  const m = run.model;
  if (!election || !pieWedges.length || !m || !m.N) return;
  const seats = pieWedges.map((w) => m.partySeats(`party:${w.party}`));
  const key = seats.join(',');
  if (key === pieShown) return;      // nothing moved; leave the DOM alone
  pieShown = key;
  const total = seats.reduce((a, b) => a + b, 0) || 1;
  let from = 0;
  pieWedges.forEach((wedge, i) => {
    const to = from + (seats[i] / total) * Math.PI * 2;
    wedge.seats = seats[i];
    wedge.path.setAttribute('d', seats[i] > 0 ? wedgePath(from, to) : '');
    from = to;
  });
}

/* --- the party block ----------------------------------------------------- */

/* One block, not one per party: the party selector picks which of the nine the
 * run is steering. Same controls as a demographic, except that in gerrymander
 * mode the threshold is a winning margin -- the party's share minus the best
 * other party's -- because that, not a fixed share, is what wins a seat under
 * first past the post. */
function buildPartyControls(voters) {
  const id = (part) => `ctl-party-${part}`;
  const wValue = el('span', { text: 'off' });
  const modeLabel = el('span', { class: 'demo-mode-label', text: 'average' });
  // The selected party names the block, so a collapsed block still says who
  // the run is drawing for.
  const toggleName = el('span', { text: 'Party' });
  const toggle = el('button', {
    class: 'demo-toggle', type: 'button', 'aria-expanded': 'false',
    'aria-controls': 'party-body',
  }, el('span', { class: 'chev', 'aria-hidden': 'true', text: '\u25B8' }), ' ', toggleName);
  const w = el('input', {
    id: id('w'), type: 'range', min: -1.02, max: 1, step: 0.02, value: -1.02,
    'data-weight': true, 'data-off': true,
  });
  const party = el('select', { id: id('p') },
    ...voters.parties.map((p, i) => el('option', { value: p, selected: i === 0 }, p)));
  const mode = el('select', { id: id('mode') },
    ...['average', 'extreme', 'gerrymander'].map((v) =>
      el('option', { value: v, selected: v === 'average' }, v)));

  const tValue = el('span', { text: '0' });
  const sValue = el('span', { text: '0.02' });
  const t = el('input', {
    id: id('t'), type: 'range', min: -0.3, max: 0.3, step: 0.005, value: 0,
  });
  const st = el('input', {
    id: id('s'), type: 'range', min: 0.005, max: 0.15, step: 0.005, value: 0.02,
  });
  const above = el('input', { id: id('a'), type: 'checkbox', checked: true });

  // Under STV the target is the count itself, so the margin and its steepness
  // give way to the seat bonus: how much a seat is worth against a quota of
  // leftover votes.
  const bValue = el('span', { text: '2' });
  const bonus = el('input', {
    id: id('b'), type: 'range', min: 1, max: 5, step: 0.5, value: 2,
  });
  const marginLabel = el('label', { for: id('t') }, 'Winning margin ', tValue);
  const steepLabel = el('label', { for: id('s') }, 'Steepness ', sValue);
  const bonusLabel = el('label', { for: id('b') }, 'Seat bonus ', bValue);
  const dirLabel = el('label', { for: id('a'), text: 'Above margin' });
  const gerry = el('div', { id: 'party-gerry', class: 'ctl-grid ctl-sub', hidden: true },
    marginLabel, t, steepLabel, st, bonusLabel, bonus, dirLabel, above);

  const body = el('div', { id: 'party-body', class: 'demo-body', hidden: true },
    el('div', { class: 'ctl-grid ctl-sub' },
      el('label', { for: id('p'), text: 'Party' }), party,
      el('label', { for: id('mode'), text: 'Mode' }), mode),
    gerry);

  els.partyBlock.append(el('div', { class: 'demo-block' },
    el('div', { class: 'ctl-grid' },
      el('div', { class: 'ctl-head' }, toggle, modeLabel, wValue), w),
    body));

  // Always the seats won, whatever the mode: it is the result the map is for.
  // Last in the block, under the run's own figures.
  const readout = el('dd', { id: 'run-party', text: '\u2014' });
  const row = el('div', {}, el('dt', { class: 'run-party-label', text: 'Party' }), readout);
  document.getElementById('run').append(row);

  const tip = el('div');
  const regionTip = el('div');
  els.ttParty.append(tip);
  els.ttRegionParty.append(regionTip);

  addPartyBarStats(voters.parties);
  buildPie(voters.parties);
  return { voters, toggle, toggleName, body, modeLabel, wValue, w, party, mode, gerry,
           t, tValue, s: st, sValue, above, readout, row, tip, regionTip,
           bonus, bValue, marginLabel, steepLabel, bonusLabel, dirLabel,
           type: () => els.electionType.value,
           seatsPer: () => Math.max(1, Number(els.seats.value) || 1),
           key: () => `party:${party.value}`,
           votes: (code) => {
             const z = voters.zones[code];
             return z ? z.e * voters.turnout : 0;
           },
           share: (code) => {
             const z = voters.zones[code];
             if (!z) return 0;
             const i = voters.parties.indexOf(party.value);
             const total = z.s.reduce((a, x) => a + x, 0) || 1;
             return z.s[i] / total;
           } };
}

/* Weights for every steered term, with the hidden mode's forced to zero. Both
 * the live tick and start() go through this, so they cannot disagree. */
function termWeights() {
  const out = {};
  for (const u of demoUI) {
    out[u.def.key] = uiMode === 'demographics' ? weightOf(u.w) : 0;
  }
  if (election) {
    for (const party of election.voters.parties) {
      out[`party:${party}`] = uiMode === 'election' && `party:${party}` === election.key()
        ? weightOf(election.w) : 0;
    }
  }
  return out;
}

/* Which of the gerrymander controls apply depends on the election being
 * simulated, so this runs on a mode switch and on an election-type change. */
function applyElectionType() {
  if (!election) return;
  const stv = uiMode === 'election' && election.type() === 'stv';
  for (const node of document.querySelectorAll('.election-only')) {
    node.hidden = uiMode !== 'election';
  }
  for (const node of document.querySelectorAll('.stv-only')) node.hidden = !stv;
  election.marginLabel.hidden = stv;
  election.t.hidden = stv;
  election.steepLabel.hidden = stv;
  election.s.hidden = stv;
  election.bonusLabel.hidden = !stv;
  election.bonus.hidden = !stv;
  election.dirLabel.textContent = stv ? 'Win seats' : 'Above margin';
}

function applyMode() {
  const demographics = uiMode === 'demographics';
  els.demoBlocks.hidden = !demographics;
  els.partyBlock.hidden = demographics || !election;
  els.modeDemographics.classList.toggle('is-active', demographics);
  els.modeElection.classList.toggle('is-active', !demographics);
  els.modeDemographics.setAttribute('aria-pressed', String(demographics));
  els.modeElection.setAttribute('aria-pressed', String(!demographics));
  for (const u of demoUI) u.readout.parentElement.hidden = !demographics;
  if (election) election.row.hidden = demographics;
  els.pie.hidden = demographics || !election || !run.model || run.phase === 'idle';
  applyElectionType();
  rebuildBarOptions();
  if (run.model) { readout(); drawBars(); drawPie(); }
}

/* --- data ---------------------------------------------------------------- */

async function loadVoters() {
  const res = await fetch(CONFIG.votersUrl);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${CONFIG.votersUrl}`);
  return res.json();
}

async function loadZones() {
  const res = await fetch(CONFIG.dataUrl);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${CONFIG.dataUrl}`);
  return res.json();
}

/* --- map ----------------------------------------------------------------- */

function createMap() {
  const map = new maplibregl.Map({
    container: 'map',
    // No basemap: a bare background layer, no external tile requests.
    style: {
      version: 8,
      sources: {},
      layers: [{
        id: 'background',
        type: 'background',
        paint: { 'background-color': CONFIG.colors.background },
      }],
    },
    bounds: CONFIG.bounds,
    fitBoundsOptions: { padding: 24 },
    maxZoom: 15,
    dragRotate: false,
    attributionControl: false,
  });

  map.touchZoomRotate.disableRotation();
  // Bottom-right, stacked above the scale: the results panel owns the top right.
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
  return map;
}

function addZoneLayers(map, geojson) {
  map.addSource(SRC, {
    type: 'geojson',
    data: geojson,
    // Lets setFeatureState key off the DZ code rather than a synthetic index.
    promoteId: 'code',
  });

  map.addLayer({
    id: 'dz-fill',
    type: 'fill',
    source: SRC,
    paint: {
      'fill-color': fillExpression([]),
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.85,
        1,
      ],
    },
  });

  map.addLayer({
    id: 'dz-line',
    type: 'line',
    source: SRC,
    paint: {
      'line-color': CONFIG.colors.line,
      // 3,780 outlines turn to mush when zoomed out, so thin them down.
      'line-width': ['interpolate', ['linear'], ['zoom'],
        6, 0.15,
        8, 0.3,
        11, 0.7,
        14, 1.2,
      ],
    },
  });
}

/* --- score weights ------------------------------------------------------- */

/* Weight sliders carry log10 of the weight, so 1 sits exactly in the middle
 * of the range and each end is a factor of ten away. Only the ratios between
 * weights matter -- the model divides the score by their sum -- so 0.1/1/1 and
 * 1/10/10 are the same objective.
 *
 * Terms marked `data-off` get one detent below the range, which reads as off.
 * Population has no such detent: it is the reference term and switching it off
 * entirely would leave nothing anchoring the regions to equal population. */
function weightOf(el) {
  const v = Number(el.value);
  if (el.dataset.off !== undefined && v <= Number(el.min) + 1e-9) return 0;
  return 10 ** v;
}

/* Flips between recombinations. Log like the weights, but the "never" detent
 * sits at the right-hand end, because in these units right means less often. */
function recomIntervalOf(el) {
  const v = Number(el.value);
  return v >= Number(el.max) - 1e-9 ? Infinity : Math.round(10 ** v);
}

function formatInterval(v) {
  return v === Infinity ? 'off' : nf.format(v);
}

function formatWeight(w) {
  return w === 0 ? 'off' : String(Number(w.toPrecision(3)));
}

/* --- region colour ------------------------------------------------------- */

/* Golden-angle hues, so any N comes out separable without a hand-made palette. */
function palette(n) {
  return Array.from({ length: n }, (_, i) => {
    const hue = (i * 137.508) % 360;
    return `hsl(${hue.toFixed(1)}, ${62 + (i % 3) * 9}%, ${56 + (i % 2) * 9}%)`;
  });
}

/* Hover wins over region colour; unassigned zones fall through to the
 * `otherwise` arm, which is what MapLibre uses when feature-state is unset.
 *
 * With no regions there is nothing to match on, and a `match` with no cases is
 * not a valid expression -- MapLibre rejects the whole layer, silently, leaving
 * the map with outlines and no fill. So before the first run the colour is just
 * a constant. */
function fillExpression(colors) {
  let base = CONFIG.colors.fill;
  if (colors.length) {
    base = ['match', ['feature-state', 'region']];
    colors.forEach((color, i) => base.push(i, color));
    base.push(CONFIG.colors.fill);
  }
  return [
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    CONFIG.colors.fillHover,
    base,
  ];
}

/* Push only the zones whose region changed since the last redraw. Zones are
 * only ever unset by clearRegions(), so this never has to write a null. */
function paintRegions(map) {
  const { model, shadow } = run;
  for (let z = 0; z < model.n; z++) {
    const region = model.assign[z];
    if (shadow[z] === region || region < 0) continue;
    shadow[z] = region;
    map.setFeatureState({ source: SRC, id: model.codes[z] }, { region });
  }
}

function clearRegions(map) {
  map.removeFeatureState({ source: SRC });   // also drops hover; it re-sets on move
  run.shadow.fill(-1);
}

/* --- interaction --------------------------------------------------------- */

/* With four demographics the tooltip would run to eight extra lines, most of
 * them about terms the run is ignoring. So it shows the ones being steered --
 * falling back to all of them when none is, since an idle map should still let
 * you read a zone's figures. Read off the sliders rather than the model so it
 * follows a weight being dragged, run or no run. */
function activeDemos() {
  const on = demoUI.filter((u) => weightOf(u.w) > 0);
  return on.length ? on : demoUI;
}

function showTooltip(point, props) {
  els.ttName.textContent = props.name || props.code;
  els.ttPop.textContent = props.pop == null ? '—' : nf.format(props.pop);
  // Election mode reads the party lines, so the demographic ones fold away --
  // the same filtering the results panel does.
  const shown = uiMode === 'election' ? new Set() : new Set(activeDemos());
  for (const u of demoUI) {
    const v = props[u.def.field];
    const show = shown.has(u) && typeof v === 'number';
    u.tip.textContent = show
      ? `${u.def.label.toLowerCase()} ${v.toFixed(u.def.decimals)}` : '';
    u.tip.hidden = !show;
  }

  const party = election && uiMode === 'election';
  els.ttParty.hidden = !party;
  if (party) {
    const votes = Math.round(election.votes(props.code) * election.share(props.code));
    election.tip.textContent = `${election.party.value} ${nf.format(votes)} `
      + `${votes === 1 ? 'vote' : 'votes'} (${pct.format(election.share(props.code))})`;
  }

  const region = run.model && run.model.regionOf(props.code);
  if (region == null) {
    els.ttRegion.hidden = true;
    els.ttRegionParty.hidden = true;
  } else {
    els.ttRegionName.textContent = `Region ${region + 1}`;
    els.ttRegionPop.textContent = nf.format(Math.round(run.model.regionPop[region]));
    for (const u of demoUI) {
      const show = shown.has(u) && run.model.demoByKey[u.def.key] !== undefined;
      u.regionTip.textContent = show
        ? `${u.def.label.toLowerCase()} `
          + `${run.model.regionDemo(u.def.key, region).toFixed(u.def.decimals)}`
        : '';
      u.regionTip.hidden = !show;
    }
    els.ttRegionParty.hidden = !party;
    if (party) {
      // The region's result, strongest first, so the winner is the top row.
      // The selected party is highlighted; if it misses the top five, the
      // fifth row gives way to it and carries its rank.
      const key = election.key();
      const standings = election.voters.parties.map((name) => ({
        name,
        key: `party:${name}`,
        votes: run.model.regionPartyVotes(`party:${name}`, region),
        share: run.model.regionPartyShare(`party:${name}`, region),
        seats: run.model.regionPartySeats(`party:${name}`, region),
      })).sort((a, b) => b.votes - a.votes);
      const rank = standings.findIndex((row) => row.key === key);
      const rows = rank < 5 ? standings.slice(0, 5)
        : [...standings.slice(0, 4), { ...standings[rank], rank: rank + 1 }];
      election.regionTip.textContent = '';
      for (const row of rows) {
        election.regionTip.append(el('div', {
          class: row.key === key ? 'tt-party-row is-target' : 'tt-party-row',
        }, ...(row.rank ? [el('span', { class: 'tt-party-rank', text: `${row.rank}.` })] : []),
           el('span', { class: 'tt-party-name', text: row.name }),
           el('span', { class: 'tt-party-votes',
             text: `${nf.format(Math.round(row.votes))} (${pct.format(row.share)})` }),
           ...(run.model.electionType === 'stv'
             ? [el('span', { class: 'tt-party-seats', text: `${row.seats}` })] : [])));
      }
    }
    els.ttRegion.hidden = false;
  }
  els.tooltip.hidden = false;

  // Keep the tooltip inside the viewport near the right/bottom edges.
  const pad = 14;
  const { offsetWidth: w, offsetHeight: h } = els.tooltip;
  let x = point.x + pad;
  let y = point.y + pad;
  if (x + w > window.innerWidth - 8) x = point.x - w - pad;
  if (y + h > window.innerHeight - 8) y = point.y - h - pad;
  els.tooltip.style.transform = `translate(${x}px, ${y}px)`;
}

function wireHover(map) {
  let hovered = null;

  const clear = () => {
    if (hovered !== null) {
      map.setFeatureState({ source: SRC, id: hovered }, { hover: false });
      hovered = null;
    }
    els.tooltip.hidden = true;
  };

  map.on('mousemove', 'dz-fill', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    if (hovered !== f.id) {
      if (hovered !== null) {
        map.setFeatureState({ source: SRC, id: hovered }, { hover: false });
      }
      hovered = f.id;
      map.setFeatureState({ source: SRC, id: hovered }, { hover: true });
    }
    showTooltip(e.point, f.properties);
  });

  map.on('mouseleave', 'dz-fill', () => {
    clear();
    map.getCanvas().style.cursor = '';
  });
  map.on('mouseenter', 'dz-fill', () => {
    map.getCanvas().style.cursor = 'crosshair';
  });

  // Leaving the canvas entirely doesn't always fire the layer's mouseleave.
  map.getCanvas().addEventListener('mouseout', clear);
}

/* --- the run ------------------------------------------------------------- */

function setButtons(state) {   // idle | running | paused
  els.go.disabled = state !== 'idle';
  els.pause.disabled = state === 'idle';
  els.stop.disabled = state === 'idle';
  els.pause.textContent = state === 'paused' ? 'RESUME' : 'PAUSE';
}

function readout() {
  const m = run.model;
  const phase = {
    build: `building ${nf.format(m.assigned)}/${nf.format(m.n)}`,
    optimise: 'optimising',
    done: 'stopped — best shown',
  }[run.phase] || '—';
  els.runPhase.textContent = run.paused ? `${phase} — paused` : phase;
  els.runDev.textContent = pct.format(m.maxDeviation);
  els.runMoves.textContent = nf.format(m.moves);
  els.runRecom.textContent = nf.format(m.recombinations);
  // The legible numbers: 1 is a circle for land, and evenly-spread population
  // for people. The normalised terms are measured per move, so their own
  // values are large and say little.
  els.runShape.textContent = m.meanPenalty.toFixed(2);
  els.runPShape.textContent = m.meanPopPenalty.toFixed(2);
  els.runCut.textContent = nf.format(m.cutRaw);
  for (const u of demoUI) {
    const live = m.demoByKey[u.def.key];
    u.readout.textContent = !live || live.weight === 0 ? '—'
      : live.mode === 'gerrymander' ? `${m.demoSeats(u.def.key)}/${m.N}`
        : m.demoSpread(u.def.key).toFixed(u.def.decimals);
  }
  if (election) {
    // Seats won always, since that is the outcome being drawn for; the spread
    // comes too in the modes where it is what the term is steering.
    const key = election.key();
    const live = m.demoByKey[key];
    const seats = `${m.partySeats(key)}/${m.totalSeats} won`;
    election.readout.textContent = !live || live.weight === 0
      || live.mode === 'gerrymander' ? seats
      : `${seats} · spread ${m.demoSpread(key).toFixed(3)}`;
    election.row.querySelector('.run-party-label').textContent = election.party.value;
  }
  els.runScore.textContent = m.score.toFixed(1);
  els.runBest.textContent = m.bestScore === Infinity ? '—' : m.bestScore.toFixed(1);
}

function tick(map) {
  return function frame(now) {
    if (run.paused) return;
    if (run.phase !== 'build' && run.phase !== 'optimise') return;
    const interval = 1000 / Number(els.fps.value);
    if (now - run.lastDraw >= interval) {
      run.lastDraw = now;
      // The two phases want very different rates: a build step claims a whole
      // zone and is worth seeing, while an optimisation step moves one zone in
      // 3,780 and is invisible on its own.
      // Both knobs are read every frame rather than captured at GO.
      // Temperature only affects the acceptance rule, so it is free to move.
      // The shape weight is part of the score, so changing it makes anything
      // recorded under the old weight incomparable -- setShapeWeight re-bases
      // best-so-far on the current state rather than leaving a stale one.
      const t = Number(els.temp.value);
      run.model.temperature = t > 0 ? t : 1;
      // Modes first: turning one off zeroes that term's weight, and setWeights
      // then reapplies the rest against the right total.
      for (const u of demoUI) {
        run.model.setDemographic(u.def.key, u.mode.value, Number(u.t.value),
          Number(u.s.value), u.above.checked);
      }
      if (election) {
        run.model.setElection(uiMode === 'election' ? election.type() : 'fptp',
          election.seatsPer(), Number(election.bonus.value));
        const chosen = election.key();
        for (const party of election.voters.parties) {
          const key = `party:${party}`;
          if (key === chosen && uiMode === 'election') {
            run.model.setDemographic(key, election.mode.value, Number(election.t.value),
              Number(election.s.value), election.above.checked);
          } else {
            // Off, not just unweighted: a term left in gerrymander mode would
            // still be recomputed on every move for nothing.
            run.model.setDemographic(key, 'off', 0, 0.02, true);
          }
        }
      }
      const demoWeights = termWeights();
      run.model.setWeights(weightOf(els.popw), weightOf(els.shape),
        weightOf(els.pshape), weightOf(els.cut), demoWeights);
      // Changes the move set rather than the score, so best-so-far stays
      // comparable and this needs no re-base.
      run.model.recomInterval = recomIntervalOf(els.recom);

      if (run.phase === 'build') {
        const steps = Number(els.build.value);
        for (let i = 0; i < steps; i++) {
          if (!run.model.buildStep()) { run.phase = 'optimise'; break; }
        }
      } else {
        const steps = Number(els.opt.value);
        for (let i = 0; i < steps; i++) run.model.optimiseStep();
      }
      paintRegions(map);
      readout();
      // Bars redraw on their own slower clock, and are bounded by the frame
      // rate: below 5 frames/s they follow it rather than outpacing it.
      if (now - run.lastBars >= BAR_INTERVAL) {
        run.lastBars = now;
        drawBars();
        drawPie();
      }
    }
    run.raf = requestAnimationFrame(frame);
  };
}

function start(map) {
  const n = Math.max(2, Math.min(500, Number(els.n.value) || 18));
  els.n.value = n;
  stop(map, { silent: true });
  clearRegions(map);

  if (election) {
    run.model.setElection(uiMode === 'election' ? election.type() : 'fptp',
      election.seatsPer(), Number(election.bonus.value));
  }
  run.model.start(n, Number(els.seed.value) || 0, {
    temperature: Number(els.temp.value) || 1,
    wPop: weightOf(els.popw),
    wShape: weightOf(els.shape),
    wPopShape: weightOf(els.pshape),
    wCut: weightOf(els.cut),
    demo: {
      ...Object.fromEntries(demoUI.map((u) => [u.def.key, {
        weight: termWeights()[u.def.key],
        mode: u.mode.value,
        threshold: Number(u.t.value),
        steepness: Number(u.s.value),
        above: u.above.checked,
      }])),
      ...(election ? { [election.key()]: {
        weight: termWeights()[election.key()],
        mode: election.mode.value,
        threshold: Number(election.t.value),
        steepness: Number(election.s.value),
        above: election.above.checked,
      } } : {}),
    },
  });
  run.colors = palette(n);
  map.setPaintProperty('dz-fill', 'fill-color', fillExpression(run.colors));

  run.phase = 'build';
  run.paused = false;
  run.lastDraw = 0;
  run.lastBars = 0;
  setButtons('running');
  els.results.hidden = false;
  els.resultsList.hidden = false;  // bars are live from the first build step
  els.pie.hidden = uiMode !== 'election' || !election;
  buildBars(n);
  drawBars();
  pieShown = '';
  drawPie();
  readout();
  run.raf = requestAnimationFrame(tick(map));
}

/* Halt without ending the run: phase and model state are untouched, so
 * resuming picks up exactly where it left off. */
function togglePause(map) {
  if (run.phase !== 'build' && run.phase !== 'optimise') return;
  run.paused = !run.paused;
  if (run.paused) {
    if (run.raf) cancelAnimationFrame(run.raf);
    run.raf = 0;
    setButtons('paused');
  } else {
    setButtons('running');
    run.lastDraw = 0;
    run.raf = requestAnimationFrame(tick(map));
  }
  readout();   // the loop is not running to do it
}

function stop(map, { silent = false } = {}) {
  if (run.raf) cancelAnimationFrame(run.raf);
  run.raf = 0;
  run.paused = false;
  setButtons('idle');
  if (silent || run.phase === 'idle') { run.phase = 'idle'; return; }

  // A stochastic rule leaves the map in whatever state it happened to be in,
  // which is not the best one visited.
  run.model.restoreBest();
  run.phase = 'done';
  paintRegions(map);
  readout();
  drawBars();
  drawPie();
}

/* One row per region, built once per run. drawBars() afterwards only writes a
 * transform, a width and a string -- never rebuilds -- so hovering a bar is not
 * destroyed mid-read and the cost does not grow with the update rate. */
function buildBars(n) {
  els.bars.textContent = '';
  els.bars.style.height = `${n * BAR_ROW_H}px`;
  run.bars = Array.from({ length: n }, (_, region) => {
    const row = document.createElement('div');
    row.className = 'bar-row';

    const label = document.createElement('span');
    label.className = 'bar-n';
    label.textContent = region + 1;

    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.background = run.colors[region];
    const value = document.createElement('span');
    value.className = 'bar-value';
    track.append(fill, value);

    // Seats, when a region returns more than one member.
    const seats = document.createElement('span');
    seats.className = 'bar-seats';
    seats.hidden = true;

    row.append(label, track, seats);
    els.bars.appendChild(row);
    return { row, fill, value, seats };
  });
}

function drawBars() {
  const m = run.model;
  if (!run.bars.length || run.bars.length !== m.N) return;

  const stat = BAR_STATS[els.barsStat.value] || BAR_STATS.pop;
  const value = stat.values(m);

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of value) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Padded, or the smallest region is a zero-width bar by definition. The
  // fallbacks cover every region being equal, and everything being zero.
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  const min = Math.max(0, lo - pad);
  const max = hi + pad;
  const span = max - min || 1;

  // Sorted by whatever is on show, so the selector reorders the panel too.
  const order = Array.from({ length: m.N }, (_, r) => r)
    .sort((a, b) => value[b] - value[a]);
  order.forEach((region, rank) => {
    const bar = run.bars[region];
    bar.row.style.transform = `translateY(${rank * BAR_ROW_H}px)`;
    bar.fill.style.width = `${((value[region] - min) / span) * 100}%`;
    bar.value.textContent = stat.format(value[region]);
    // Won regions are marked rather than recoloured: the bar's colour is the
    // region's own, and it has to stay readable against the map.
    bar.row.classList.toggle('is-win', Boolean(stat.wins && stat.wins(m, region)));
    const perRegion = stat.seats && m.electionType === 'stv';
    bar.seats.hidden = !perRegion;
    if (perRegion) bar.seats.textContent = stat.seats(m, region);
  });

  // The labels report the actual extremes, not the padded domain -- the padding
  // exists so the smallest bar is visible, not to be read off the axis.
  els.barsMin.textContent = stat.format(lo);
  els.barsMax.textContent = stat.format(hi);
}

/* --- boot ---------------------------------------------------------------- */

async function main() {
  const map = createMap();
  // Registered before anything is awaited: 'load' fires once, and awaiting the
  // voter file first would otherwise miss it and hang the boot.
  const mapLoaded = new Promise((resolve) => map.on('load', resolve));

  buildDemoControls();
  rebuildBarOptions();

  // Switching the statistic re-ranks immediately rather than waiting for the
  // next tick, so the panel responds even while paused or stopped.
  els.barsStat.addEventListener('change', () => { if (run.model) drawBars(); });

  const readouts = [[els.fps, els.fpsValue], [els.build, els.buildValue],
                    [els.opt, els.optValue], [els.popw, els.popwValue],
                    [els.shape, els.shapeValue], [els.pshape, els.pshapeValue],
                    [els.cut, els.cutValue], [els.recom, els.recomValue]];

  for (const u of demoUI) {
    // Collapsed still shows the weight slider and the current mode; the
    // selector and the gerrymander knobs are what fold away.
    u.toggle.addEventListener('click', () => {
      const open = u.body.hidden;
      u.body.hidden = !open;
      u.toggle.setAttribute('aria-expanded', String(open));
    });

    // There is no 'off' mode: the weight slider turns the term off, as it does
    // for every other term. The mode label greys out to show when that has
    // happened. Threshold and steepness only mean anything in gerrymander mode.
    const sync = () => {
      u.gerry.hidden = u.mode.value !== 'gerrymander';
      u.modeLabel.textContent = u.mode.value;
      u.modeLabel.classList.toggle('is-off', weightOf(u.w) === 0);
    };
    u.mode.addEventListener('change', sync);
    u.w.addEventListener('input', sync);
    sync();

    readouts.push([u.w, u.wValue], [u.t, u.tValue], [u.s, u.sValue]);
  }

  els.modeDemographics.addEventListener('click', () => {
    uiMode = 'demographics';
    applyMode();
  });
  els.modeElection.addEventListener('click', () => {
    if (!election) return;
    uiMode = 'election';
    applyMode();
  });
  els.modeElection.disabled = true;      // until the voter file is in

  for (const [input, out] of readouts) {
    const show = () => {
      if (input.dataset.weight !== undefined) {
        out.textContent = formatWeight(weightOf(input));
      } else if (input.dataset.interval !== undefined) {
        out.textContent = formatInterval(recomIntervalOf(input));
      } else {
        out.textContent = input.value;
      }
    };
    input.addEventListener('input', show);
    show();
  }

  // The voter file is the election mode's only input; without it the mode
  // stays unavailable and the demographics map works exactly as before.
  let voters = null;
  try {
    voters = await loadVoters();
  } catch (err) {
    console.warn('voter data unavailable, election mode off:', err.message);
  }
  if (voters) {
    election = buildPartyControls(voters);
    els.modeElection.disabled = false;
    const sync = () => {
      election.toggleName.textContent = election.party.value;
      election.gerry.hidden = election.mode.value !== 'gerrymander';
      election.modeLabel.textContent = election.mode.value;
      election.modeLabel.classList.toggle('is-off', weightOf(election.w) === 0);
      if (run.model && uiMode === 'election') readout();
    };
    election.toggle.addEventListener('click', () => {
      const open = election.body.hidden;
      election.body.hidden = !open;
      election.toggle.setAttribute('aria-expanded', String(open));
    });
    els.electionType.addEventListener('change', () => {
      applyElectionType();
      if (run.model) { readout(); drawBars(); pieShown = ''; drawPie(); }
    });
    els.seats.addEventListener('change', () => {
      if (!run.model) return;
      run.model.setElection(election.type(), election.seatsPer(), Number(election.bonus.value));
      readout();
      drawBars();
      pieShown = '';
      drawPie();
    });
    election.mode.addEventListener('change', sync);
    election.w.addEventListener('input', sync);
    election.party.addEventListener('change', () => {
      sync();
      if (run.model) drawBars();
    });
    els.pieSvg.addEventListener('mouseleave', () => { els.pieCaption.innerHTML = '&nbsp;'; });
    sync();
    readouts.push([election.w, election.wValue], [election.t, election.tValue],
                  [election.s, election.sValue], [election.bonus, election.bValue]);
    for (const [input, out] of readouts.slice(-4)) {
      const show = () => {
        out.textContent = input.dataset.weight !== undefined
          ? formatWeight(weightOf(input)) : input.value;
      };
      input.addEventListener('input', show);
      show();
    }
  }
  applyMode();

  try {
    const [geojson] = await Promise.all([loadZones(), mapLoaded]);

    addZoneLayers(map, geojson);
    wireHover(map);

    // Debug handles: poke at any of them from the console, e.g.
    //   __map.setPaintProperty('dz-fill', 'fill-color', '#c00')
    //   __graph.neighbours(__graph.zones[0])
    //   __model.summary()
    window.__map = map;

    els.status.hidden = true;

    // Adjacency is data, not a layer -- nothing on screen depends on it, so it
    // loads off the critical path and a failure must not take the map with it.
    DZGraph.load(CONFIG.graphUrl)
      .then((graph) => {
        window.__graph = graph;
        const pops = Object.fromEntries(
          geojson.features.map((f) => [f.properties.code, f.properties.pop]));
        run.model = new RegionModel(graph, pops, zoneGeometry(geojson.features),
          zoneDemographics(geojson.features), voters);
        run.shadow = new Int32Array(run.model.n).fill(-1);
        window.__model = run.model;
        els.go.disabled = false;
        els.go.addEventListener('click', () => start(map));
        els.pause.addEventListener('click', () => togglePause(map));
        els.stop.addEventListener('click', () => stop(map));
      })
      .catch((err) => console.warn('adjacency graph unavailable:', err.message));
  } catch (err) {
    els.status.textContent = `Could not load zones — ${err.message}`;
    els.status.classList.add('error');
    console.error(err);
  }
}

main();
