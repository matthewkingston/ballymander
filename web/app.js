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
  regionsUrl: 'data/dz_regions.json',
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
  seedValue: document.getElementById('ctl-seed-value'),
  temp: document.getElementById('ctl-temp'),
  speed: document.getElementById('ctl-speed'),
  speedValue: document.getElementById('ctl-speed-value'),
  popw: document.getElementById('ctl-popw'),
  popwValue: document.getElementById('ctl-popw-value'),
  shape: document.getElementById('ctl-shape'),
  shapeValue: document.getElementById('ctl-shape-value'),
  pshape: document.getElementById('ctl-pshape'),
  pshapeValue: document.getElementById('ctl-pshape-value'),
  cut: document.getElementById('ctl-cut'),
  cutValue: document.getElementById('ctl-cut-value'),
  variables: document.getElementById('variables'),
  add: document.getElementById('ctl-add'),
  addOpen: document.getElementById('ctl-add-open'),
  partyEditor: document.getElementById('party-editor'),
  real: document.getElementById('ctl-real'),
  tactical: document.getElementById('ctl-tactical'),
  standing: document.getElementById('ctl-standing'),
  electionType: document.getElementById('ctl-election-type'),
  seats: document.getElementById('ctl-seats'),
  viewSwitch: document.querySelector('.view-switch'),
  viewOverall: document.getElementById('view-overall'),
  viewRegion: document.getElementById('view-region'),
  overall: document.getElementById('overall'),
  regionView: document.getElementById('region-view'),
  regionTitle: document.getElementById('region-title'),
  regionName: document.getElementById('region-name'),
  regionSwatch: document.getElementById('region-swatch'),
  regionSeats: document.getElementById('region-seats'),
  regionPie: document.getElementById('region-pie'),
  regionStages: document.getElementById('region-stages'),
  regionCaption: document.getElementById('region-caption'),
  regionHint: document.getElementById('region-hint'),
  pie: document.getElementById('pie'),
  pieSvg: document.getElementById('pie-svg'),
  pieCaption: document.getElementById('pie-caption'),
  ttParty: document.querySelector('.tt-party'),
  ttRegionParty: document.querySelector('.tt-region-party'),
  go: document.getElementById('ctl-go'),
  stop: document.getElementById('ctl-stop'),
  runPhase: document.getElementById('run-phase'),
  runDev: document.getElementById('run-dev'),
  runRecom: document.getElementById('run-recom'),
  runMoves: document.getElementById('run-moves'),
  runScore: document.getElementById('run-score'),
  runBest: document.getElementById('run-best'),
  results: document.getElementById('results'),
  resultsList: document.getElementById('results-list'),
  barsStat: document.getElementById('bars-stat'),
  bonus: document.getElementById('ctl-bonus'),
  bonusValue: document.getElementById('ctl-bonus-value'),
  bars: document.getElementById('bars'),
  barsMin: document.getElementById('bars-min'),
  barsMax: document.getElementById('bars-max'),
};

/* Live run state. `shadow` is what the map currently shows, so each redraw only
 * pushes the zones that actually changed. */
const run = {
  owed: { build: 0, optimise: 0 },   // fractions of a step carried between frames
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

/* Which half of the results panel is showing: the whole map, or one region's
 * election in detail. */
let panelView = 'overall';
let voters = null;        // web/data/dz_voters.json, once loaded

/* The election every drawn map holds. One election, so these are the page's,
 * not any one variable's -- including the seat bonus, which scores the count
 * itself rather than a party. */
const elect = {
  type: () => els.electionType.value,
  seatsPer: () => Math.max(1, Number(els.seats.value) || 1),
  bonus: () => Number(els.bonus.value) || 2,
  // A zone's ballots: its electorate, its turnout index, and the level of
  // whichever election is being simulated.
  votes: (code) => {
    const z = voters && voters.zones[code];
    if (!z) return 0;
    const levels = voters.levels || {};
    return z.e * (z.t == null ? 1 : z.t) * (levels[els.electionType.value] || voters.turnout);
  },
  share: (code, party) => {
    const z = voters && voters.zones[code];
    if (!z) return 0;
    const total = z.s.reduce((a, x) => a + x, 0) || 1;
    return z.s[voters.parties.indexOf(party)] / total;
  },
};

/* The region being shown in detail. Kept for the life of a run, so clicking
 * around the map and coming back lands where you left off; a new run starts at
 * the first region. */
let shownRegion = 0;

/* Real constituency boundaries, if their file loaded: one region index per
 * zone for each set. Offered as a starting point, never as a running state --
 * the selector goes away as soon as a run begins. */
let realRegions = null;
const realLoaded = () => Boolean(realRegions) && els.real.value !== 'none';

/* The run's clock. Ten frames a second is as fast as the eye gets anything
 * from a map this size -- above it the fill just flickers -- so it is fixed
 * rather than offered. What the speed slider moves is how much work happens
 * between frames, and the two phases keep their ratio: a build step claims a
 * whole zone and is worth watching, an optimiser step moves one zone in 3,780
 * and is invisible on its own, so builds run far slower.
 *
 * Speed 1 is ten thousand optimiser steps a second. */
const FRAME_MS = 100;            // ten frames a second
const OPT_PER_SEC = 10000;       // at speed 1
const BUILD_PER_SEC = 700;       // at speed 1
const RECOM_INTERVAL = 200;      // flips between recombinations, fixed
/* Work is measured against the clock rather than against frames, so the rate
 * holds when the browser cannot keep ten frames a second -- which it often
 * cannot, since painting 3,780 zones is the expensive part. A frame that
 * arrives very late claims no more than this much time, or a stall would be
 * followed by a burst long enough to cause another. */
const MAX_FRAME_MS = 250;

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
    };
  }
}

/* The map's own four always, then one entry per variable being steered -- so
 * the results offer exactly what was asked for. Keeps the current choice if it
 * is still on the list. */
const MAP_STATS = { pop: 'Population', land: 'Land shape', people: 'People shape',
                    cut: 'Cut edges' };

function rebuildBarOptions() {
  const want = els.barsStat.value;
  els.barsStat.textContent = '';
  for (const [key, label] of Object.entries(MAP_STATS)) {
    els.barsStat.append(el('option', { value: key }, label));
  }
  for (const v of variables) {
    els.barsStat.append(el('option', { value: barKey(v) },
      v.isParty ? `${varLabel(v)} votes` : varLabel(v)));
  }
  const offered = [...els.barsStat.options].some((o) => o.value === want);
  els.barsStat.value = offered ? want : 'pop';
}

/* --- variables ------------------------------------------------------------
 *
 * What the run is steered by. A variable is a party or a demographic -- the
 * model scores both the same way, so nothing here needs to know which it has
 * beyond the labels and the units of the gerrymander controls.
 *
 * The page carries as many as are asked for and no more: each brings its own
 * block of controls, its readout row, its entry in the results selector and its
 * two tooltip lines, and takes all of them away again when removed. A party and
 * a demographic can be steered at once, and so can two parties.
 *
 * A new variable arrives at weight zero. Weights are shares of one budget, so
 * an arriving variable would otherwise quietly dilute every variable already
 * there; at zero it changes nothing until its slider is moved. */
const variables = [];
const varByKey = new Map();

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

/* Everything that could be steered: the demographics, then the parties in
 * ballot order. `key` is the model's own term key, so a variable needs no
 * translation to reach the model. */
function catalogue() {
  const out = DEMOGRAPHICS.map((def) => ({ key: def.key, def, isParty: false }));
  if (voters) {
    out.push(...voters.parties.map((party) => ({ key: `party:${party}`, party, isParty: true })));
  }
  return out;
}

const varLabel = (v) => (v.isParty ? entityLabel(v.party) : v.def.label);
/* The results selector keys demographics apart from the model's own keys. */
const barKey = (v) => (v.isParty ? v.key : `demo:${v.key}`);

/* A party that has been struck off, or merged into another, is no longer
 * something to steer by: only entities can be. */
function canSteer(entry) {
  if (!entry.isParty) return true;
  return ballotEntities().some((e) => e.host === entry.party);
}

function buildVariable(entry) {
  // Accents folded rather than dropped, so Sinn Féin and Aontú get ids worth
  // reading -- party-sinn-fein, party-aontu.
  const slug = entry.key.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const id = (part) => `ctl-${slug}-${part}`;
  const bodyId = `${slug}-body`;
  const v = { ...entry };

  v.wValue = el('span', { text: 'off' });
  v.modeLabel = el('span', { class: 'demo-mode-label', text: 'gerrymander' });
  v.toggleName = el('span', { text: varLabel(entry) });
  v.toggle = el('button', {
    class: 'demo-toggle', type: 'button', 'aria-expanded': 'false',
    'aria-controls': bodyId,
  }, el('span', { class: 'chev', 'aria-hidden': 'true', text: '\u25B8' }), ' ', v.toggleName);
  v.remove = el('button', {
    class: 'var-remove', type: 'button', title: `Remove ${varLabel(entry)}`,
    'aria-label': `Remove ${varLabel(entry)}`, text: '\u00D7',
  });
  v.w = el('input', {
    id: id('w'), type: 'range', min: -1.02, max: 1, step: 0.02, value: -1.02,
    'data-weight': true, 'data-off': true,
  });
  // Gerrymander by default: it is what the tool is for, and the other two modes
  // are one click away.
  v.mode = el('select', { id: id('mode') },
    ...['average', 'extreme', 'gerrymander'].map((m) =>
      el('option', { value: m, selected: m === 'gerrymander' },
        m[0].toUpperCase() + m.slice(1))));

  // A demographic's threshold carries its own units and range -- 0-1 for
  // religion, years for age -- straight from its definition. A party's is a
  // winning margin instead: its share minus the best other party's, because
  // that, not a fixed share, is what takes a seat under first past the post.
  const [tMin, tMax, tStep] = entry.isParty ? [-0.3, 0.3, 0.005] : entry.def.thresholdRange;
  const [sMin, sMax, sStep] = entry.isParty ? [0.005, 0.15, 0.005] : entry.def.steepnessRange;
  const t0 = entry.isParty ? 0 : entry.def.threshold;
  const s0 = entry.isParty ? 0.02 : entry.def.steepness;
  v.tValue = el('span', { text: entry.isParty ? `${(100 * t0).toFixed(1)}%` : String(t0) });
  v.sValue = el('span', { text: String(s0) });
  v.t = el('input', { id: id('t'), type: 'range', min: tMin, max: tMax, step: tStep, value: t0 });
  v.s = el('input', { id: id('s'), type: 'range', min: sMin, max: sMax, step: sStep, value: s0 });
  v.above = el('input', { id: id('a'), type: 'checkbox', checked: true });

  v.tLabel = el('label', { for: id('t') },
    entry.isParty ? 'Winning margin ' : 'Threshold ', v.tValue);
  v.sLabel = el('label', { for: id('s') }, 'Steepness ', v.sValue);
  v.dirLabel = el('label', { for: id('a'),
    text: entry.isParty ? 'Above margin' : 'Above threshold' });
  v.gerry = el('div', { id: `${slug}-gerry`, class: 'ctl-grid ctl-sub', hidden: true },
    v.tLabel, v.t, v.sLabel, v.s, v.dirLabel, v.above);

  v.body = el('div', { id: bodyId, class: 'demo-body', hidden: true },
    el('div', { class: 'ctl-grid ctl-sub' },
      el('label', { for: id('mode'), text: 'Mode' }), v.mode),
    v.gerry);

  v.block = el('div', { class: 'demo-block' },
    el('div', { class: 'ctl-grid' },
      el('div', { class: 'ctl-head' }, v.toggle, v.modeLabel,
        // The weight and the remove button travel together, so a head too long
        // for one line puts the figure on the second rather than leaving the
        // button down there on its own looking like a gap.
        el('span', { class: 'ctl-head-end' }, v.wValue, v.remove)), v.w),
    v.body);
  els.variables.append(v.block);

  // Mode-dependent, because the useful number differs: how far apart the
  // regions are for average/extreme, how many clear the bar for gerrymander --
  // and for a party, always the seats, since that is the result the map is for.
  v.readout = el('dd', { id: `run-var-${slug}`, text: '\u2014' });
  v.readoutRow = el('div', {}, el('dt', { text: varLabel(entry) }), v.readout);
  document.getElementById('run').append(v.readoutRow);

  v.tip = el('div');
  v.regionTip = el('div');
  (entry.isParty ? els.ttParty : els.ttDemo).append(v.tip);
  if (!entry.isParty) els.ttRegionDemo.append(v.regionTip);
  return v;
}

/* Add, remove, and the menu that offers what is not already there. */
function addVariable(key) {
  if (varByKey.has(key)) return varByKey.get(key);
  const entry = catalogue().find((e) => e.key === key);
  if (!entry || !canSteer(entry)) return null;
  const v = buildVariable(entry);
  variables.push(v);
  varByKey.set(key, v);
  wireVariable(v);
  applyVariables();
  return v;
}

function removeVariable(v) {
  // Off, not merely unweighted: a term left in gerrymander mode would still be
  // recomputed on every move for nothing.
  if (run.model) run.model.setDemographic(v.key, 'off', 0, 0.02, true);
  v.block.remove();
  v.readoutRow.remove();
  v.tip.remove();
  v.regionTip.remove();
  variables.splice(variables.indexOf(v), 1);
  varByKey.delete(v.key);
  applyVariables();
  if (run.model) { sync(); readout(); drawBars(); }
}

/* The menu is built rather than borrowed from a <select>, because a native
 * dropdown swallows the click that dismisses it: the page never hears it, so
 * the collapsed select would sit there until something else was clicked. */
function rebuildAddMenu() {
  const taken = new Set(variables.map((v) => v.key));
  els.add.textContent = '';
  for (const entry of catalogue()) {
    if (taken.has(entry.key) || !canSteer(entry)) continue;
    const item = el('button', {
      class: 'add-item', type: 'button', role: 'menuitem', 'data-key': entry.key,
      text: entry.isParty ? entityLabel(entry.party) : entry.def.label,
    });
    item.addEventListener('click', () => chooseVariable(entry.key));
    els.add.append(item);
  }
  els.addOpen.disabled = !els.add.children.length;
}

/* The menu is not a fixture: the plus asks for it, it answers, and it goes away
 * again -- whether something was picked or the pointer went elsewhere. */
function openAddMenu() {
  if (els.addOpen.disabled) return;
  els.addOpen.hidden = true;
  els.add.hidden = false;
  const first = els.add.querySelector('.add-item');
  if (first) first.focus();
  // The panel scrolls, and the menu may open below its edge: bring it into
  // view rather than leaving it half cut off.
  els.add.scrollIntoView({ block: 'nearest' });
}

function closeAddMenu() {
  els.add.hidden = true;
  els.addOpen.hidden = false;
}

function chooseVariable(key) {
  closeAddMenu();
  const v = addVariable(key);
  if (!v) return;
  // Opened on arrival: a variable is added in order to set it up.
  v.body.hidden = false;
  v.toggle.setAttribute('aria-expanded', 'true');
  if (run.model) { sync(); readout(); drawBars(); }
}

/* The page follows the list: the results selector, the readout rows and the
 * pie all show what is being steered and nothing else. */
function applyVariables() {
  rebuildAddMenu();
  rebuildBarOptions();
  applyElectionType();
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
      els.pieCaption.textContent =
        `${entityLabel(party)} — ${seats} ${seats === 1 ? 'seat' : 'seats'}`;
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
  if (!voters || !pieWedges.length || !m || !m.N) return;
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

/* --- the party editor ---------------------------------------------------- */

/* Short names, used only when parties merge, where a full name per party would
 * not fit: DUP-UUP-TUV, All-SDLP-Gr. Everywhere else a party keeps its name. */
const PARTY_SHORT = {
  'Sinn Féin': 'SF', DUP: 'DUP', Alliance: 'All', UUP: 'UUP', SDLP: 'SDLP',
  TUV: 'TUV', Green: 'Gr', PBP: 'PBP', 'Aontú': 'Ao',
};

/* What is on the ballot. An item is either one of the nine parties or a merger
 * of several; merged items sit at the top of the list, newest first, and the
 * parties inside them leave the list until they are unmerged.
 *
 * This outlives a run: the model keeps the mapping through start(), and the
 * editor is not rebuilt, so a new map is drawn under the same ballot. */
const ballot = { items: [], selected: new Set(), ui: null };

/* Particular mergers have earned their own names. Keyed by the set, so the
 * order they were merged in doesn't matter. */
const ALL_PARTIES = Object.keys(PARTY_SHORT);
const except = (...out) => ALL_PARTIES.filter((p) => !out.includes(p));

const MERGER_NAMES = [
  [['DUP', 'UUP', 'TUV'], 'U Unity'],
  [['DUP', 'UUP'], 'U Unity Lite'],
  [['UUP', 'SDLP'], 'The Old Guard'],
  [except('PBP'), 'Profit'],
  [except('Green'), 'Magenta'],
  [except('Alliance'), 'Division'],
  [except('Sinn Féin'), 'Iad Féin'],
  [['Sinn Féin', 'SDLP'], 'N Unity'],
  [['Alliance', 'Green', 'PBP'], 'Big Other'],
  [['Sinn Féin', 'TUV'], 'Curveball'],
  [['Green', 'PBP', 'Aontú'], 'Mighty Mites'],
  [['Sinn Féin', 'DUP'], 'Best Friday'],
  [['Sinn Féin', 'Green'], 'Super Green'],
  [['Sinn Féin', 'SDLP', 'Aontú', 'PBP'], 'N Unity XL'],
  [['Sinn Féin', 'DUP', 'Alliance', 'UUP', 'SDLP', 'TUV', 'Green', 'PBP', 'Aontú'], 'Imperium'],
];
const mergerKey = (members) => [...members].sort().join('|');
const NAMED_MERGERS = new Map(MERGER_NAMES.map(([members, name]) => [mergerKey(members), name]));

const itemName = (item) => (item.members.length === 1 ? item.members[0]
  : NAMED_MERGERS.get(mergerKey(item.members))
    || item.members.map((p) => PARTY_SHORT[p] || p).join('-'));
const itemHost = (item) => item.members[0];       // the slot that carries the votes

/* Entities in the order the model knows them, for labelling everything else. */
function entityFor(party) {
  return ballot.items.find((item) => item.members.includes(party));
}

function entityLabel(party) {
  const item = entityFor(party);
  return item ? itemName(item) : party;
}

/* The party a slot's votes live in: itself, or its merger's host. */
function entityHost(party) {
  const item = entityFor(party);
  return item ? itemHost(item) : party;
}

function ballotEntities() {
  return ballot.items.map((item) => ({ item, host: itemHost(item), label: itemName(item) }));
}

function initBallot(parties) {
  ballot.items = parties.map((party) => ({ members: [party], standing: true, prev: {} }));
}

/* Hand the model the ballot and refresh everything that reads it. */
function applyBallot() {
  if (!run.model || !voters) return;
  const standing = {};
  const merge = {};
  for (const item of ballot.items) {
    const host = itemHost(item);
    for (const party of item.members) {
      standing[party] = item.standing;
      if (item.members.length > 1) merge[party] = host;
    }
  }
  run.model.setBallot({ standing, merge });
  refreshPartyVariables();
  rebuildBarOptions();
  readout();
  drawBars();
  pieShown = '';
  drawPie();
  if (panelView === 'region') drawRegion();
}

/* The gerrymander target follows the ballot: one entry per entity, named as the
 * editor names it. A party that has merged away is replaced by its host. */
function refreshPartyVariables() {
  // A party struck off the ballot, or merged into another, is no longer an
  // entity and so is no longer something to steer by: its variable goes, and
  // a host's keeps its place under whatever the merger ended up called.
  for (const v of [...variables]) {
    if (v.isParty && !canSteer(v)) removeVariable(v);
  }
  sync();
  for (const v of variables) v.readoutRow.querySelector('dt').textContent = varLabel(v);
  applyVariables();
}


/* Ticking a box must not rebuild the list: the checkboxes would be replaced
 * mid-click and the next one would land on a detached node. Only the buttons
 * change with the selection. */
function updateEditorButtons() {
  const ui = ballot.ui;
  if (!ui) return;
  const chosen = [...ballot.selected];
  const merged = chosen.filter((item) => item.members.length > 1);
  // A button is live exactly when pressing it would change something: include
  // needs something excluded in the selection, exclude needs something
  // included, and a mixed selection gives both work to do. Merging needs two
  // items, and unmerging exactly one merged item.
  const unmerge = chosen.length === 1 && merged.length === 1;
  ui.include.disabled = !chosen.some((item) => !item.standing);
  ui.exclude.disabled = !chosen.some((item) => item.standing);
  ui.merge.disabled = !(chosen.length > 1 || unmerge);
  ui.merge.textContent = unmerge ? 'Unmerge' : 'Merge';
}

function renderPartyEditor() {
  const ui = ballot.ui;
  if (!ui) return;
  ui.list.textContent = '';
  for (const item of ballot.items) {
    const id = itemName(item);
    const box = el('input', { type: 'checkbox', id: `pe-${id}` });
    box.checked = ballot.selected.has(item);
    box.addEventListener('change', () => {
      if (box.checked) ballot.selected.add(item);
      else ballot.selected.delete(item);
      updateEditorButtons();
    });
    ui.list.append(el('li', { class: item.standing ? 'pe-row' : 'pe-row is-out' },
      box,
      el('label', { class: 'pe-name', for: `pe-${id}`, text: id,
                    title: item.standing ? 'stands' : 'stands aside' })));
  }
  updateEditorButtons();
}

function editorAction(what) {
  const chosen = ballot.items.filter((item) => ballot.selected.has(item));
  if (!chosen.length) return;
  if (what === 'include' || what === 'exclude') {
    for (const item of chosen) item.standing = what === 'include';
  } else if (chosen.length === 1 && chosen[0].members.length > 1) {
    // Unmerge: the parties come back as they were before they merged.
    const item = chosen[0];
    const at = ballot.items.indexOf(item);
    const restored = item.members.map((party) => ({
      members: [party], standing: item.prev[party] !== false, prev: {},
    }));
    ballot.items.splice(at, 1, ...restored);
    ballot.items.sort(byBallotOrder);
  } else {
    // Merge: one item at the top, holding every party of every item chosen.
    const members = chosen.flatMap((item) => item.members)
      .sort((a, b) => voters.parties.indexOf(a) - voters.parties.indexOf(b));
    const prev = {};
    for (const item of chosen) {
      for (const party of item.members) {
        prev[party] = item.prev[party] !== undefined ? item.prev[party] : item.standing;
      }
    }
    // A merger stands if any of its parts did.
    const standing = chosen.some((item) => item.standing);
    ballot.items = ballot.items.filter((item) => !chosen.includes(item));
    ballot.items.unshift({ members, standing, prev });
  }
  ballot.selected.clear();
  renderPartyEditor();
  applyBallot();
}

/* Merged items first, newest at the top; the rest in the parties' own order. */
function byBallotOrder(a, b) {
  const ma = a.members.length > 1;
  const mb = b.members.length > 1;
  if (ma !== mb) return ma ? -1 : 1;
  if (ma) return 0;
  const order = voters.parties;
  return order.indexOf(a.members[0]) - order.indexOf(b.members[0]);
}

function buildPartyEditor(voters) {
  initBallot(voters.parties);
  const list = el('ul', { id: 'pe-list' });
  const body = el('div', { id: 'pe-body', class: 'demo-body', hidden: true }, list);
  const toggle = el('button', {
    class: 'demo-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'pe-body',
  }, el('span', { class: 'chev', 'aria-hidden': 'true', text: '\u25B8' }), ' Party editor');
  const mk = (label) => el('button', { class: 'pe-action', type: 'button', disabled: true }, label);
  const include = mk('Include');
  const exclude = mk('Exclude');
  const merge = mk('Merge');
  body.append(el('div', { class: 'pe-actions' }, include, exclude, merge));
  els.partyEditor.append(el('div', { class: 'demo-block' },
    el('div', { class: 'ctl-grid' }, el('div', { class: 'ctl-head' }, toggle)), body));
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  include.addEventListener('click', () => editorAction('include'));
  exclude.addEventListener('click', () => editorAction('exclude'));
  merge.addEventListener('click', () => editorAction('merge'));
  ballot.ui = { list, body, toggle, include, exclude, merge };
  renderPartyEditor();
}

/* --- one region's election ----------------------------------------------- */

const partyColour = (party) => PARTY_COLORS[party] || '#9aa7b4';

/* `hidden` is an HTML element property: assigning it on an SVG element sets a
 * JS property that never reaches the attribute, so the [hidden] rule keeps the
 * thing invisible. Toggle the attribute itself. */
function show(node, visible) {
  if (visible) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}

function regionCaption(text) {
  els.regionCaption.textContent = text || '\u00a0';
}

/* First past the post: the region's votes as a pie, hover for the figures. */
function drawRegionPie(m, r) {
  const parties = voters.parties;   // slots; merged ones hold nothing
  const votes = m.regionVotes(r, new Float64Array(parties.length));
  const total = votes.reduce((a, b) => a + b, 0) || 1;
  els.regionPie.textContent = '';
  let from = 0;
  parties.forEach((party, i) => {
    if (votes[i] <= 0) return;
    const to = from + (votes[i] / total) * Math.PI * 2;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', partyColour(party));
    path.setAttribute('d', wedgePath(from, to));
    path.addEventListener('mouseenter', () => regionCaption(
      `${entityLabel(party)} — ${nf.format(Math.round(votes[i]))} votes `
      + `(${pct.format(votes[i] / total)})`));
    path.addEventListener('mouseleave', () => regionCaption(''));
    els.regionPie.append(path);
    from = to;
  });
  const winner = m.regionWinner(r);
  els.regionSeats.textContent = winner ? `Winner: ${entityLabel(winner.slice(6))}` : '—';
}

/* STV: one bar per stage of the count, parties always in the same order.
 * A party's block is what it holds at that point -- the quotas it has already
 * used to win seats, plus whatever is still live -- so seats stay visible
 * rather than vanishing from the chart. Votes that have exhausted make up the
 * grey tail, which is why every bar is the same width. */
function drawRegionStages(m, r) {
  const parties = voters.parties;
  const { quota, total, stages } = m.regionCount(r);
  els.regionStages.textContent = '';
  const scale = total || 1;
  stages.forEach((stage, i) => {
    const row = el('div', { class: 'stage-row' },
      el('span', { class: 'stage-n', text: i === 0 ? '1st' : String(i) }));
    const bar = el('div', { class: 'stage-bar' });
    parties.forEach((party, p) => {
      const held = stage.locked[p] + stage.live[p];
      if (held <= 0) return;
      const seg = el('div', { class: 'stage-seg' });
      seg.style.width = `${(held / scale) * 100}%`;
      seg.style.background = partyColour(party);
      const seats = stage.seats[p];
      seg.addEventListener('mouseenter', () => regionCaption(
        `${entityLabel(party)} — ${nf.format(Math.round(held))} `
        + `(${pct.format(held / scale)}), ${seats} ${seats === 1 ? 'seat' : 'seats'}`));
      seg.addEventListener('mouseleave', () => regionCaption(''));
      bar.append(seg);
    });
    if (stage.exhausted > 0) {
      const seg = el('div', { class: 'stage-seg is-exhausted' });
      seg.style.width = `${(stage.exhausted / scale) * 100}%`;
      seg.addEventListener('mouseenter', () => regionCaption(
        `non-transferable — ${nf.format(Math.round(stage.exhausted))} `
        + `(${pct.format(stage.exhausted / scale)})`));
      seg.addEventListener('mouseleave', () => regionCaption(''));
      bar.append(seg);
    }
    const what = stage.party < 0 ? 'first preferences'
      : `${stage.kind} ${entityLabel(parties[stage.party])}`;
    row.append(bar, el('span', { class: 'stage-what', text: what, title: what }));
    els.regionStages.append(row);
  });
  const last = stages[stages.length - 1];
  const held = parties.map((party, p) => [entityLabel(party), last.seats[p]])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  els.regionSeats.textContent = held.length
    ? `${held.map(([party, n]) => `${party} ${n}`).join(' · ')}  (quota `
      + `${nf.format(Math.round(quota))})`
    : '—';
}

function drawRegion() {
  const m = run.model;
  const live = m && run.phase !== 'idle' && m.N > 0;
  show(els.regionHint, !live);
  show(els.regionPie, false);
  show(els.regionStages, false);
  if (!live || !voters) {
    els.regionName.textContent = '—';
    els.regionSwatch.style.background = 'transparent';
    els.regionSeats.textContent = '—';
    regionCaption('');
    return;
  }
  if (shownRegion >= m.N) shownRegion = 0;
  els.regionName.textContent = `Region ${shownRegion + 1}`;
  // The colour it is painted on the map, so the region can be found by eye
  // rather than by counting.
  els.regionSwatch.style.background = (run.colors && run.colors[shownRegion]) || 'transparent';
  if (m.electionType === 'stv') {
    show(els.regionStages, true);
    drawRegionStages(m, shownRegion);
  } else {
    show(els.regionPie, true);
    drawRegionPie(m, shownRegion);
  }
}

function applyView() {
  const region = panelView === 'region' && Boolean(voters);
  els.overall.hidden = Boolean(region);
  els.regionView.hidden = !region;
  els.viewOverall.classList.toggle('is-active', !region);
  els.viewRegion.classList.toggle('is-active', Boolean(region));
  els.viewOverall.setAttribute('aria-pressed', String(!region));
  els.viewRegion.setAttribute('aria-pressed', String(Boolean(region)));
  if (region) drawRegion();
  else if (run.model) { drawBars(); drawPie(); }
}

/* --- steering -------------------------------------------------------------- */

/* Weights for every term the model carries: what is not on the page is off, so
 * nothing steers unseen. */
function termWeights() {
  const out = {};
  for (const def of DEMOGRAPHICS) out[def.key] = 0;
  if (voters) for (const party of voters.parties) out[`party:${party}`] = 0;
  for (const v of variables) out[v.key] = weightOf(v.w);
  return out;
}

/* Collapsed still shows the weight slider and the current mode; the selector
 * and the gerrymander knobs are what fold away. There is no 'off' mode: the
 * weight slider turns a term off, as it does for every other term, and the
 * mode label greys out to show when that has happened. */
function sync() {
  for (const v of variables) {
    v.gerry.hidden = v.mode.value !== 'gerrymander';
    v.modeLabel.textContent = v.mode.value;
    v.modeLabel.classList.toggle('is-off', weightOf(v.w) === 0);
    if (v.isParty) v.toggleName.textContent = varLabel(v);
  }
}

function wireVariable(v) {
  v.toggle.addEventListener('click', () => {
    const open = v.body.hidden;
    v.body.hidden = !open;
    v.toggle.setAttribute('aria-expanded', String(open));
  });
  v.remove.addEventListener('click', () => removeVariable(v));
  v.mode.addEventListener('change', () => { sync(); if (run.model) readout(); });
  v.w.addEventListener('input', sync);
  for (const [input, out] of [[v.w, v.wValue], [v.t, v.tValue], [v.s, v.sValue]]) {
    // A party's threshold is a winning margin -- a share of the region's votes
    // -- so it reads as the percentage it is. A demographic's carries its own
    // units, which are already what they should be.
    wireReadout(input, out, v.isParty && input === v.t
      ? (value) => `${(100 * Number(value)).toFixed(1)}%` : null);
  }
  sync();
  applyElectionType();
}

/* Which of a party's gerrymander controls apply depends on the election being
 * simulated, so this runs whenever either changes. */
function applyElectionType() {
  const stv = els.electionType.value === 'stv';
  for (const node of document.querySelectorAll('.stv-only')) node.hidden = !stv;
  // Tactical voting is a first-past-the-post affair; under STV a lower
  // preference costs a voter nothing.
  for (const node of document.querySelectorAll('.fptp-only')) node.hidden = stv;
  for (const v of variables) {
    if (!v.isParty) continue;
    // Under STV the target is the count itself, so the margin and its steepness
    // give way; how much a seat is worth is the election's seat bonus.
    v.tLabel.hidden = stv;
    v.t.hidden = stv;
    v.sLabel.hidden = stv;
    v.s.hidden = stv;
    v.dirLabel.textContent = stv ? 'Win seats' : 'Above margin';
  }
}

/* --- data ---------------------------------------------------------------- */

async function fetchRealRegions() {
  const res = await fetch(CONFIG.regionsUrl);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${CONFIG.regionsUrl}`);
  const data = await res.json();
  const at = new Map(data.codes.map((code, i) => [code, i]));
  return { sets: data.sets, at };
}

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
  // Top right, held clear of the results panel by style.css.
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
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

/* The seed a run will use: whatever is in the box, or a fresh one drawn from
 * the clock when it is empty. Drawn once per GO rather than per frame, so
 * pausing and resuming stays on the same map.
 *
 * Whichever it is, it goes in the label: an auto seed that vanished with the
 * run would make a map worth keeping impossible to find again, which is the one
 * thing the seed is for. */
function seedForRun() {
  const typed = els.seed.value.trim();
  if (typed !== '') return { seed: Number(typed) >>> 0, auto: false };
  // Six digits rather than the whole clock: it changes every millisecond,
  // which is all that is wanted, and it is short enough to read off and type
  // back in. Two runs a quarter of an hour apart could share one, which costs
  // nothing.
  return { seed: Date.now() % 1000000, auto: true };
}

/* Only an automatic seed is reported: one typed into the box is already on
 * screen, and repeating it in the label would just be the same number twice. */
function showSeed(chosen) {
  // Unformatted: this number exists to be read off and typed back into the box
  // beside it, and the box will not take a thousands separator.
  els.seedValue.textContent = chosen && chosen.auto ? String(chosen.seed) : '';
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
/* Weights land on a grid that coarsens as they grow: 0.01 apart below 0.5, then
 * 0.05, 0.1 and 0.5. The slider itself stays logarithmic -- it is the value
 * coming off it that snaps -- which keeps two decimal places as the most any
 * weight ever needs, and stops the figure beside a label claiming a precision
 * nobody chose. 0.191 was never a considered number. */
const WEIGHT_STEPS = [[0.5, 0.01], [1, 0.05], [5, 0.1], [Infinity, 0.5]];

function snapWeight(w) {
  const [, step] = WEIGHT_STEPS.find(([limit]) => w < limit);
  return Number((Math.round(w / step) * step).toFixed(2));
}

function weightOf(el) {
  const v = Number(el.value);
  if (el.dataset.off !== undefined && v <= Number(el.min) + 1e-9) return 0;
  return snapWeight(10 ** v);
}

/* Flips between recombinations. Log like the weights, but the "never" detent
 * sits at the right-hand end, because in these units right means less often. */
/* The slider is log10 of the speed, so its ends are 0.01 and 10. */
function speedOf() {
  return 10 ** Number(els.speed.value);
}

/* Steps to take for the time that has passed, carrying the fraction left over
 * so that rates below one step a frame still advance. */
function stepsForElapsed(phase, perSecond, elapsed) {
  const ms = Math.min(elapsed, MAX_FRAME_MS);
  const want = run.owed[phase] + (perSecond * speedOf() * ms) / 1000;
  const whole = Math.floor(want);
  run.owed[phase] = want - whole;
  return whole;
}

/* Two significant figures is plenty for a speed: 0.01, 0.35, 1, 10. */
function formatSpeed(v) {
  return String(Number(v.toPrecision(2)));
}

function formatWeight(w) {
  return w === 0 ? 'off' : String(w);      // already snapped, so already short
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

/* The tooltip shows the variables being steered -- falling back to all of them
 * when none is, since an idle map should still let you read a zone's figures.
 * Read off the sliders rather than the model so it follows a weight being
 * dragged, run or no run. */
function activeVars() {
  const on = variables.filter((v) => weightOf(v.w) > 0);
  return on.length ? on : variables;
}

function showTooltip(point, props) {
  els.ttName.textContent = props.name || props.code;
  els.ttPop.textContent = props.pop == null ? '—' : nf.format(props.pop);
  const shown = new Set(activeVars());
  for (const v of variables) {
    const show = shown.has(v);
    if (v.isParty) {
      const share = elect.share(props.code, v.party);
      const votes = Math.round(elect.votes(props.code) * share);
      v.tip.textContent = show ? `${varLabel(v)} ${nf.format(votes)} `
        + `${votes === 1 ? 'vote' : 'votes'} (${pct.format(share)})` : '';
      v.tip.hidden = !show;
    } else {
      const value = props[v.def.field];
      const ok = show && typeof value === 'number';
      v.tip.textContent = ok
        ? `${v.def.label.toLowerCase()} ${value.toFixed(v.def.decimals)}` : '';
      v.tip.hidden = !ok;
    }
  }
  const party = Boolean(voters) && variables.some((v) => v.isParty && shown.has(v));
  els.ttParty.hidden = !variables.some((v) => v.isParty && shown.has(v));

  const region = run.model && run.model.regionOf(props.code);
  if (region == null) {
    els.ttRegion.hidden = true;
    els.ttRegionParty.hidden = true;
  } else {
    els.ttRegionName.textContent = `Region ${region + 1}`;
    els.ttRegionPop.textContent = nf.format(Math.round(run.model.regionPop[region]));
    for (const v of variables) {
      if (v.isParty) continue;
      const show = shown.has(v) && run.model.demoByKey[v.key] !== undefined;
      v.regionTip.textContent = show
        ? `${v.def.label.toLowerCase()} `
          + `${run.model.regionDemo(v.key, region).toFixed(v.def.decimals)}`
        : '';
      v.regionTip.hidden = !show;
    }
    els.ttRegionParty.hidden = !party;
    if (party) {
      // The region's result, strongest first, so the winner is the top row.
      // The parties being steered are highlighted; if one misses the top five,
      // the fifth row gives way to it and carries its rank.
      const targets = new Set(variables.filter((v) => v.isParty && shown.has(v))
        .map((v) => v.key));
      const standings = voters.parties
        .filter((name) => entityHost(name) === name)
        .map((name) => ({
        name: entityLabel(name),
        key: `party:${name}`,
        votes: run.model.regionPartyVotes(`party:${name}`, region),
        share: run.model.regionPartyShare(`party:${name}`, region),
        seats: run.model.regionPartySeats(`party:${name}`, region),
      })).sort((a, b) => b.votes - a.votes);
      const missing = [...targets].map((k) => standings.findIndex((row) => row.key === k))
        .filter((i) => i >= 5).sort((a, b) => a - b);
      const rows = !missing.length ? standings.slice(0, 5)
        : [...standings.slice(0, 5 - missing.length),
           ...missing.map((i) => ({ ...standings[i], rank: i + 1 }))];
      els.ttRegionParty.textContent = '';
      for (const row of rows) {
        els.ttRegionParty.append(el('div', {
          class: targets.has(row.key) ? 'tt-party-row is-target' : 'tt-party-row',
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

  // Clicking a zone chooses the region shown in detail. Only while that view
  // is open, so a click means nothing else in the app.
  map.on('click', 'dz-fill', (e) => {
    if (panelView !== 'region' || !run.model) return;
    const f = e.features && e.features[0];
    const region = f && run.model.regionOf(f.properties.code);
    if (region == null) return;
    shownRegion = region;
    window.__shownRegionForTest = region;    // handle for scripts/smoke_test.mjs
    drawRegion();
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

/* --- real boundaries ----------------------------------------------------- */

/* The options the model needs whichever way a map arrives. */
function runOptions() {
  return {
    temperature: Number(els.temp.value) || 1,
    wPop: weightOf(els.popw),
    wShape: weightOf(els.shape),
    wPopShape: weightOf(els.pshape),
    wCut: weightOf(els.cut),
    demo: {
      ...Object.fromEntries(variables.map((v) => [v.key, {
        weight: weightOf(v.w),
        mode: v.mode.value,
        threshold: Number(v.t.value),
        steepness: Number(v.s.value),
        above: v.above.checked,
      }])),
    },
  };
}

/* Put a real map on the screen as though a run had just stopped: every zone
 * assigned, the panel showing its figures, and GO free to carry on from it. */
function showRealRegions(map, key) {
  if (!run.model || !realRegions || !realRegions.sets[key]) return 0;
  const set = realRegions.sets[key];
  const assignment = run.model.codes.map((code) => set.index[realRegions.at.get(code)]);
  const n = run.model.adopt(assignment, runOptions());
  if (!n) return 0;
  els.n.value = n;
  run.colors = palette(n);
  map.setPaintProperty('dz-fill', 'fill-color', fillExpression(run.colors));
  // Every zone belongs to a region here, so they can all be repainted without
  // clearing first -- and they must be, because removeFeatureState lands after
  // the setFeatureState calls below and would wipe some of them.
  run.shadow.fill(-1);
  paintRegions(map);
  run.phase = 'done';
  run.paused = false;
  setButtons('idle');
  els.results.hidden = false;
  els.resultsList.hidden = false;
  els.pie.hidden = !voters;
  shownRegion = 0;
  buildBars(n);
  drawBars();
  pieShown = '';
  drawPie();
  readout();
  applyView();
  return n;
}

function clearRealRegions(map) {
  if (run.raf) cancelAnimationFrame(run.raf);
  run.raf = 0;
  run.phase = 'idle';
  run.paused = false;
  clearRegions(map);
  els.results.hidden = true;
  els.resultsList.hidden = true;
  els.pie.hidden = true;
  setButtons('idle');
}

/* --- the run ------------------------------------------------------------- */

function setButtons(state) {   // idle | running | paused
  // One button does all three jobs, because only one of them is ever available:
  // nothing to pause before a run, nothing to start during one.
  els.go.textContent = state === 'idle' ? 'START'
    : state === 'paused' ? 'RESUME' : 'PAUSE';
  els.go.disabled = false;
  els.stop.disabled = state === 'idle';
  // The accent marks whatever the obvious next action is. Before a run that is
  // starting it; once one is going, the button that ends it.
  els.go.classList.toggle('is-primary', state === 'idle');
  els.stop.classList.toggle('is-primary', state !== 'idle');
  // The number of regions and the seed are fixed once a run starts: changing
  // either mid-run would mean a different map, not a different reading of this
  // one. The election controls stay live, so a paused map can be re-counted.
  els.n.disabled = state !== 'idle' || realLoaded();
  els.seed.disabled = state !== 'idle';
  // Real boundaries are a starting point, not a state: once a run is going the
  // map is no longer the real one, so the selector goes away.
  for (const node of document.querySelectorAll('.real-only')) node.hidden = state !== 'idle';
}

function readout() {
  const m = run.model;
  const phase = {
    build: `Building ${nf.format(m.assigned)}/${nf.format(m.n)}`,
    optimise: 'Optimising',
    done: 'Stopped — best shown',
  }[run.phase] || '—';
  els.runPhase.textContent = run.paused ? `${phase} — paused` : phase;
  els.runDev.textContent = pct.format(m.maxDeviation);
  els.runMoves.textContent = nf.format(m.moves);
  els.runRecom.textContent = nf.format(m.recombinations);
  for (const v of variables) {
    const live = m.demoByKey[v.key];
    if (v.isParty) {
      // Seats won always, since that is the outcome being drawn for; the spread
      // comes too in the modes where it is what the term is steering.
      const seats = `${m.partySeats(v.key)}/${m.totalSeats} won`;
      v.readout.textContent = !live || live.weight === 0 || live.mode === 'gerrymander'
        ? seats : `${seats} · spread ${m.demoSpread(v.key).toFixed(3)}`;
    } else {
      v.readout.textContent = !live || live.weight === 0 ? '—'
        : live.mode === 'gerrymander' ? `${m.demoSeats(v.key)}/${m.N}`
          : m.demoSpread(v.key).toFixed(v.def.decimals);
    }
    v.readoutRow.querySelector('dt').textContent = varLabel(v);
  }
  els.runScore.textContent = m.score.toFixed(1);
  els.runBest.textContent = m.bestScore === Infinity ? '—' : m.bestScore.toFixed(1);
}

function tick(map) {
  return function frame(now) {
    if (run.paused) return;
    if (run.phase !== 'build' && run.phase !== 'optimise') return;
    if (now - run.lastDraw >= FRAME_MS) {
      const elapsed = now - run.lastDraw;
      run.lastDraw = now;
      // Read every frame rather than captured at GO.
      // Temperature only affects the acceptance rule, so it is free to move.
      // The shape weight is part of the score, so changing it makes anything
      // recorded under the old weight incomparable -- setShapeWeight re-bases
      // best-so-far on the current state rather than leaving a stale one.
      const t = Number(els.temp.value);
      run.model.temperature = t > 0 ? t : 1;
      // Modes first: turning one off zeroes that term's weight, and setWeights
      // then reapplies the rest against the right total.
      if (voters) {
        run.model.setElection(elect.type(), elect.seatsPer(), elect.bonus(),
          els.tactical.checked, els.standing.checked);
      }
      // Off, not merely unweighted: a term left in gerrymander mode would still
      // be recomputed on every move for nothing.
      for (const def of DEMOGRAPHICS) {
        if (!varByKey.has(def.key)) run.model.setDemographic(def.key, 'off', 0, 0.02, true);
      }
      if (voters) {
        for (const party of voters.parties) {
          const key = `party:${party}`;
          if (!varByKey.has(key)) run.model.setDemographic(key, 'off', 0, 0.02, true);
        }
      }
      for (const v of variables) {
        run.model.setDemographic(v.key, v.mode.value, Number(v.t.value),
          Number(v.s.value), v.above.checked);
      }
      const demoWeights = termWeights();
      run.model.setWeights(weightOf(els.popw), weightOf(els.shape),
        weightOf(els.pshape), weightOf(els.cut), demoWeights);
      // Changes the move set rather than the score, so best-so-far stays
      // comparable and this needs no re-base.
      run.model.recomInterval = RECOM_INTERVAL;

      if (run.phase === 'build') {
        const steps = stepsForElapsed('build', BUILD_PER_SEC, elapsed);
        for (let i = 0; i < steps; i++) {
          if (!run.model.buildStep()) { run.phase = 'optimise'; break; }
        }
      } else {
        const steps = stepsForElapsed('optimise', OPT_PER_SEC, elapsed);
        for (let i = 0; i < steps; i++) run.model.optimiseStep();
      }
      paintRegions(map);
      readout();
      // Bars redraw on their own slower clock, and are bounded by the frame
      // rate: below 5 frames/s they follow it rather than outpacing it.
      if (now - run.lastBars >= BAR_INTERVAL) {
        run.lastBars = now;
        if (panelView === 'region') drawRegion();
        else { drawBars(); drawPie(); }
      }
    }
    run.raf = requestAnimationFrame(frame);
  };
}

function start(map) {
  // From a real map, the run carries on from it: the build phase is already
  // done, so it goes straight to optimising. The selector then resets, since
  // the boundaries stop being the real ones with the first move.
  const fromReal = realLoaded();
  if (fromReal) {
    showSeed(null);          // no build, so no seed had any part in this map
    run.model.adopt(run.model.assign.slice(), runOptions());
    els.real.value = 'none';
    els.n.disabled = false;
    run.phase = 'optimise';
    run.paused = false;
    run.lastDraw = 0;
    run.lastBars = 0;
    setButtons('running');
    els.results.hidden = false;
    els.resultsList.hidden = false;
    els.pie.hidden = !voters;
    readout();
    run.raf = requestAnimationFrame(tick(map));
    return;
  }
  // One region is allowed: everyone elected from a single seat-rich region is
  // roughly a national list, and worth being able to look at.
  const n = Math.max(1, Math.min(500, Number(els.n.value) || 18));
  els.n.value = n;
  stop(map, { silent: true });
  clearRegions(map);

  if (voters) {
    run.model.setElection(elect.type(), elect.seatsPer(), elect.bonus(),
      els.tactical.checked, els.standing.checked);
  }
  const chosen = seedForRun();
  showSeed(chosen);
  run.model.start(n, chosen.seed, {
    temperature: Number(els.temp.value) || 1,
    wPop: weightOf(els.popw),
    wShape: weightOf(els.shape),
    wPopShape: weightOf(els.pshape),
    wCut: weightOf(els.cut),
    demo: Object.fromEntries(variables.map((v) => [v.key, {
      weight: weightOf(v.w),
      mode: v.mode.value,
      threshold: Number(v.t.value),
      steepness: Number(v.s.value),
      above: v.above.checked,
    }])),
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
  els.pie.hidden = !voters;
  shownRegion = 0;                 // a new map, so back to the first region
  buildBars(n);
  drawBars();
  pieShown = '';
  drawPie();
  readout();
  applyView();
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
  if (panelView === 'region') drawRegion();
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

/* How wide the label column has to be, measured in the browser doing the
 * rendering rather than guessed from a number written here.
 *
 * A fixed width cannot be right everywhere: the same string is several per cent
 * wider or narrower depending on the system font, so a column generous enough
 * for one machine leaves a void on another. This builds one head off-screen,
 * asks the browser how wide it is, and sizes the column to that. The reference
 * is a typical head rather than the longest -- the two long ones wrap, which is
 * the trade that got the void out of every other row. */
const LABEL_REFERENCE = { name: 'Alliance', mode: 'gerrymander', weight: '0.85' };

function sizeLabelColumn() {
  const head = el('div', { class: 'ctl-head' },
    el('button', { class: 'demo-toggle', type: 'button' },
      el('span', { class: 'chev', text: '▸' }), ` ${LABEL_REFERENCE.name}`),
    el('span', { class: 'demo-mode-label', text: LABEL_REFERENCE.mode }),
    el('span', { class: 'ctl-head-end' },
      el('span', { text: LABEL_REFERENCE.weight }),
      el('button', { class: 'var-remove', type: 'button', text: '×' })));
  // Not inside a .ctl-grid: that is the very grid whose column is being
  // measured, and it would stretch the head to the width already set -- the
  // measurement would just read its own answer back.
  const probe = el('div', {}, head);
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;'
    + 'width:max-content;white-space:nowrap';
  head.style.flexWrap = 'nowrap';
  head.style.width = 'max-content';
  els.variables.append(probe);
  // Round up: a fraction short would wrap the very string being fitted.
  const want = Math.ceil(head.getBoundingClientRect().width) + 1;
  probe.remove();
  document.documentElement.style.setProperty('--label-col', `${want}px`);
  return want;
}

/* Slider to the figure beside its label. Variables are added and removed, so
 * this is per input rather than a list walked once at boot. */
function wireReadout(input, out, format = null) {
  const show = () => {
    if (format) out.textContent = format(input.value);
    else if (input.dataset.weight !== undefined) out.textContent = formatWeight(weightOf(input));
    else if (input.dataset.speed !== undefined) {
      out.textContent = formatSpeed(speedOf());
    } else out.textContent = input.value;
  };
  input.addEventListener('input', show);
  show();
}

async function main() {
  const map = createMap();
  // Registered before anything is awaited: 'load' fires once, and awaiting the
  // voter file first would otherwise miss it and hang the boot.
  const mapLoaded = new Promise((resolve) => map.on('load', resolve));

  rebuildBarOptions();

  // Switching the statistic re-ranks immediately rather than waiting for the
  // next tick, so the panel responds even while paused or stopped.
  els.barsStat.addEventListener('change', () => { if (run.model) drawBars(); });

  for (const [input, out] of [[els.popw, els.popwValue], [els.shape, els.shapeValue],
                             [els.pshape, els.pshapeValue], [els.cut, els.cutValue],
                             [els.bonus, els.bonusValue]]) {
    wireReadout(input, out);
  }
  wireReadout(els.speed, els.speedValue, () => formatSpeed(speedOf()));
  sizeLabelColumn();

  els.viewOverall.addEventListener('click', () => { panelView = 'overall'; applyView(); });
  els.viewRegion.addEventListener('click', () => {
    if (!voters) return;
    panelView = 'region';
    applyView();
  });

  els.addOpen.addEventListener('click', openAddMenu);
  // Anywhere else closes it, first click and all: the menu is ours, so the
  // click that dismisses it reaches the page like any other.
  document.addEventListener('pointerdown', (e) => {
    if (els.add.hidden) return;
    if (!els.add.contains(e.target) && e.target !== els.addOpen) closeAddMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.add.hidden) { closeAddMenu(); els.addOpen.focus(); }
  });

  // Without the voter file there are no parties to steer by; the demographics
  // work exactly as before.
  try {
    voters = await loadVoters();
  } catch (err) {
    console.warn('voter data unavailable, parties unavailable:', err.message);
  }
  if (voters) {
    addPartyBarStats(voters.parties);
    buildPie(voters.parties);
    buildPartyEditor(voters);
    refreshPartyVariables();
    // Both belong to the election rather than to any variable, and both were
    // hidden until a mode revealed them. With one page they are simply there,
    // for as long as there are parties to have an election between.
    els.partyEditor.hidden = false;
    els.viewSwitch.hidden = false;
    // Both re-count the map as it stands, so the panel is right whether the run
    // is going, paused or stopped.
    const recount = () => {
      if (!run.model) return;
      run.model.setElection(elect.type(), elect.seatsPer(), elect.bonus(),
        els.tactical.checked, els.standing.checked);
      readout();
      drawBars();
      pieShown = '';
      drawPie();
      if (panelView === 'region') drawRegion();
    };
    els.electionType.addEventListener('change', () => { applyElectionType(); recount(); });
    els.seats.addEventListener('change', recount);
    els.tactical.addEventListener('change', recount);
    els.standing.addEventListener('change', recount);
    els.bonus.addEventListener('change', recount);
    els.pieSvg.addEventListener('mouseleave', () => { els.pieCaption.innerHTML = '&nbsp;'; });
  }

  // The page opens with one variable, which is what a variable is for: an
  // empty page would say nothing about what the tool does.
  addVariable(voters ? 'party:Alliance' : DEMOGRAPHICS[0].key);
  applyVariables();
  applyView();


  try {
    realRegions = await fetchRealRegions();
  } catch (err) {
    console.warn('real boundaries unavailable:', err.message);
    for (const node of document.querySelectorAll('.real-only')) node.hidden = true;
  }

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
        // Through setButtons rather than by hand, so START arrives wearing the
        // accent like every other idle state.
        setButtons('idle');
        // Real boundaries can only be put up once the model exists, so this is
        // wired here with the rest of the run controls.
        els.real.addEventListener('change', () => {
          if (els.real.value === 'none') clearRealRegions(map);
          else if (!showRealRegions(map, els.real.value)) els.real.value = 'none';
          els.n.disabled = realLoaded();
        });
        els.go.addEventListener('click', () => {
          if (run.phase === 'idle' || run.phase === 'done') start(map);
          else togglePause(map);
        });
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
