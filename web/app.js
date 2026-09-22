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
    line: '#a9b6c2',
    // The hover highlight is white and its outline near-black, deliberately
    // colourless: the regions already use every hue the app has, so anything
    // tinted would clash with one region and match another.
    veil: '#ffffff',
    veilLine: '#1c2530',
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
  ttPopLine: document.querySelector('.tt-pop'),
  ttRegionPopLine: document.querySelector('.tt-region-pop'),
  ttRegionName: document.querySelector('.tt-region-name'),
  ttRegionPop: document.querySelector('.tt-region-pop-value'),
  ttRegionDemo: document.querySelector('.tt-region-demo'),
  n: document.getElementById('ctl-n'),
  seed: document.getElementById('ctl-seed'),
  seedValue: document.getElementById('ctl-seed-value'),
  temp: document.getElementById('ctl-temp'),
  tempValue: document.getElementById('ctl-temp-value'),
  speed: document.getElementById('ctl-speed'),
  speedValue: document.getElementById('ctl-speed-value'),
  popw: document.getElementById('ctl-popw'),
  popwValue: document.getElementById('ctl-popw-value'),
  shape: document.getElementById('ctl-shape'),
  shapeValue: document.getElementById('ctl-shape-value'),
  pshape: document.getElementById('ctl-pshape'),
  pshapeValue: document.getElementById('ctl-pshape-value'),
  compact: document.getElementById('ctl-compact'),
  compactValue: document.getElementById('ctl-compact-value'),
  advanced: document.getElementById('ctl-advanced'),
  menuToggle: document.getElementById('menu-toggle'),
  panelMenu: document.getElementById('panel-menu'),
  panelBody: document.getElementById('panel-body'),
  recom: document.getElementById('ctl-recom'),
  recomValue: document.getElementById('ctl-recom-value'),
  branch: document.getElementById('ctl-branch'),
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
  resultsHint: document.getElementById('results-hint'),
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
  lastPie: 0,
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
  // Cyan-ward of the pale blue it used to be, which sat five degrees of hue
  // from the accent. Twenty is enough to read as a different colour.
  UUP: '#6ec6e0',
  TUV: '#1b2f6b',
  Alliance: '#f2c313',
  Green: '#7ac143',
  'Aontú': '#6b3fa0',
  PBP: '#ef5a7a',
};

/* Fine tuning, off by default and remembered between visits: a control that is
 * a choice stays on the page, a control that is a dial waits behind the
 * checkbox. Reading storage throws in a private window, so a failure is simply
 * the default. */
const ADVANCED_KEY = 'ballymander.advanced';
let advanced = false;
try {
  advanced = localStorage.getItem(ADVANCED_KEY) === '1';
} catch { advanced = false; }

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
 * Speed 1 is 8,500 optimiser steps a second. It was 10,000, which ran a shade
 * faster than is comfortable to watch; both phases came down by the same 15% so
 * their ratio is untouched. The slider's default stays at 1, where it sits at
 * the centre of its track with every other slider on the panel -- what changed
 * is what 1 does, not where the thumb rests. */
const FRAME_MS = 100;            // ten frames a second
const OPT_PER_SEC = 8500;        // at speed 1
const BUILD_PER_SEC = 595;       // at speed 1, the same 100:7 as before
// Flips between recombinations is not here: it is a choice about the search
// rather than its pace, and is a slider again under advanced controls.
/* Work is measured against the clock rather than against frames, so the rate
 * holds when the browser cannot keep ten frames a second -- which it often
 * cannot, since painting 3,780 zones is the expensive part. A frame that
 * arrives very late claims no more than this much time, or a stall would be
 * followed by a burst long enough to cause another. */
const MAX_FRAME_MS = 250;

const BAR_ROW_H = 18;     // must match .bar-row height in style.css
/* Two clocks for the results panel, by what the thing being drawn does when it
 * changes rather than by which panel it is in.
 *
 * A pie only turns: a wedge grows, its neighbours give way, and the shape is
 * legible at any speed. Those keep the map's own pace, and look better for it.
 *
 * A list reorders. The bars are re-ranked on every draw, so a region that has
 * barely moved can still cross two neighbours and jump up the column; the STV
 * stages are rebuilt row by row and shuffle the same way. At five draws a
 * second neither can be followed. Once a second is slow enough to read a row
 * while it moves and still keeps up with anything worth watching. */
const PIE_INTERVAL = 200;  // five redraws a second, with the map
const BAR_INTERVAL = 1000; // one redraw a second

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

/* The map's own measures, then one entry per variable being steered -- so the
 * results offer exactly what was asked for. Keeps the current choice if it is
 * still on the list.
 *
 * The three shape measures follow their sliders behind advanced controls: on
 * the left they are one knob called Compactness, and offering them here as
 * three separate charts would contradict that. Population equality has a
 * slider of its own in both modes, so its chart stays in both. */
const MAP_STATS = { pop: 'Population', land: 'Land shape', people: 'People shape',
                    cut: 'Cut edges' };
const BASIC_STATS = ['pop'];

/* Whether the reader has picked a statistic for themselves. Until they do, the
 * bars follow the variables: those are what the run is being steered by, and
 * they are the reason the map looks the way it does. Population and the shape
 * measures are the fallback for a page with nothing on it. */
let barStatChosen = false;

function rebuildBarOptions() {
  const want = els.barsStat.value;
  els.barsStat.textContent = '';
  for (const [key, label] of Object.entries(MAP_STATS)) {
    if (!advanced && !BASIC_STATS.includes(key)) continue;
    els.barsStat.append(el('option', { value: key }, label));
  }
  for (const v of variables) {
    els.barsStat.append(el('option', { value: barKey(v) },
      v.isParty ? `${varFullLabel(v)} votes` : varFullLabel(v)));
  }
  const offered = [...els.barsStat.options].some((o) => o.value === want);
  const firstVariable = variables.length ? barKey(variables[0]) : null;
  els.barsStat.value = !barStatChosen && firstVariable ? firstVariable
    // A chosen statistic stands until it is taken off the page. When it is,
    // another variable takes its place, and population only once the last
    // variable has gone.
    : offered ? want
      : firstVariable || 'pop';
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
/* The name in full, for everywhere the label is not sitting in the variable's
 * own head with its mode and weight beside it. Most read the same either way;
 * age is 'Average age' here, being a mean rather than a band. */
const varFullLabel = (v) => (v.isParty ? entityLabel(v.party)
  : v.def.longLabel || v.def.label);
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
    class: 'var-remove', type: 'button', title: `Remove ${varFullLabel(entry)}`,
    'aria-label': `Remove ${varFullLabel(entry)}`, text: '\u00D7',
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
  // Which way the term is being pushed, as the thing itself rather than as a
  // box to leave ticked: a party is being drawn to win or to lose, a
  // demographic to land above or below its threshold. A checkbox called "above
  // margin" made the reader work out what leaving it unticked would mean.
  v.above = el('select', { id: id('a') },
    el('option', { value: 'above', selected: true },
      entry.isParty ? 'Win' : 'Above threshold'),
    el('option', { value: 'below' },
      entry.isParty ? 'Lose' : 'Below threshold'));

  v.tLabel = el('label', { for: id('t') },
    entry.isParty ? 'Winning margin ' : 'Threshold ', v.tValue);
  v.sLabel = el('label', { for: id('s') }, 'Steepness ', v.sValue);
  v.dirLabel = el('label', { for: id('a'), text: 'Goal' });
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
  // Starts off the list. readout() puts it up as soon as there is a figure for
  // it, which for a party is at once and for a demographic is when it is
  // gerrymandering.
  v.readoutRow = el('div', { hidden: true },
    el('dt', { text: varFullLabel(entry) }), v.readout);
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
  if (run.model) readout();
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
      text: varFullLabel(entry),
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
  addInfoMarkers();
}

/* --- info markers -------------------------------------------------------- */

/* A marker beside every labelled control, opening a longer note under the row
 * it belongs to. Deliberately not a hover tooltip: this is for the paragraph
 * you read once when you first meet a control, which a tooltip you have to
 * keep a pointer inside is a poor place for.
 *
 * PLACEHOLDER. Every note below is lorem ipsum, and the three lengths exist
 * only so that the layout is exercised at its messiest -- what the notes
 * actually say is not written yet and is not for this file to decide.
 *
 * The markers are attached by walking the panel rather than written into the
 * markup twenty-odd times, because the rows are half static and half generated
 * from the variables, and this way both get one from the same line of code. */
const INFO_PLACEHOLDER = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod '
  + 'tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut '
  + 'aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit '
  + 'in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia '
  + 'deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste '
  + 'natus error sit voluptatem accusantium doloremque laudantium, totam rem '
  + 'aperiam eaque ipsa quae ab illo inventore veritatis.',
];
let infoCount = 0;
let openNote = null;

function closeNote() {
  if (!openNote) return;
  openNote.note.hidden = true;
  openNote.marker.setAttribute('aria-expanded', 'false');
  openNote = null;
}

/* One at a time: two open notes in a 398px column is a wall of text, and the
 * question being asked is always about one control. */
function toggleNote(marker, note) {
  const wasOpen = openNote && openNote.note === note;
  closeNote();
  if (wasOpen) return;
  note.hidden = false;
  marker.setAttribute('aria-expanded', 'true');
  openNote = { marker, note };
}

/* Give every labelled row in the panel a marker, skipping the ones that have
 * one already, so this can be called again whenever rows are added. */
/* The marker on its own, so the width measurement can build one that is not
 * attached to anything. */
function infoMark() {
  return el('button', {
    class: 'info-mark', type: 'button', 'aria-expanded': 'false',
    'aria-label': 'About this setting', text: 'i',
  });
}

/* A marker and the note it opens, as a pair. */
function makeInfo() {
  const marker = infoMark();
  const note = el('div', { class: 'info-note', hidden: true },
    INFO_PLACEHOLDER[infoCount % INFO_PLACEHOLDER.length]);
  infoCount += 1;
  marker.addEventListener('click', () => toggleNote(marker, note));
  return { marker, note };
}

function addInfoMarkers() {
  // Direct children only. A label nested deeper is somebody else's -- the party
  // editor names each party with one -- and giving those a marker put an "i"
  // inside every party's name.
  for (const label of els.panelBody.querySelectorAll('.ctl-grid > label')) {
    if (label.querySelector('.info-mark')) continue;
    const { marker, note } = makeInfo();
    // Before the readout, not after it. A slider's label ends in a number that
    // changes as it is dragged, and a marker sitting after it slides about with
    // every digit; before it, the marker holds still and the number moves on
    // its own as it always did.
    const readout = label.querySelector('span');
    if (readout) {
      label.insertBefore(marker, readout);
      label.insertBefore(document.createTextNode(' '), readout);
    } else {
      label.append(' ', marker);
    }
    // After the control the label names, so the note reads under its own row
    // rather than between the label and the thing it labels.
    const control = label.nextElementSibling;
    (control || label).after(note);
  }

  // A block that heads itself -- the party editor, and every variable -- has a
  // .ctl-head where the others have a label, so the walk above does not reach
  // it. The note goes at the end of the same grid, which for the editor puts it
  // above the list of parties and for a variable below its weight slider:
  // under its own row either way, as with the labels.
  for (const head of els.panelBody.querySelectorAll('.ctl-grid > .ctl-head')) {
    if (head.querySelector('.info-mark')) continue;
    const { marker, note } = makeInfo();
    // Before the weight and the remove button for the same reason the labels
    // put it before their readout: the figure changes width as the slider
    // moves, and anything after it would shift with every digit.
    const end = head.querySelector('.ctl-head-end');
    if (end) head.insertBefore(marker, end);
    else head.append(marker);
    head.parentElement.append(note);
  }
}

/* --- seats pie ----------------------------------------------------------- */

/* One wedge per party, sized by regions won. Drawn once and then only its
 * paths are rewritten, so hovering a wedge is never interrupted by a redraw.
 * No labels: the caption names whatever is under the pointer. */
const SVG_NS = 'http://www.w3.org/2000/svg';
let pieWedges = [];
let pieShown = '';

/* The caption says what to do until it has something to say. After the first
 * wedge is pointed at it follows that party for good, live, rather than going
 * blank the moment the pointer leaves -- a figure that vanishes when you look
 * away is a figure you cannot read while the map moves under it. */
const PIE_HINT = 'Hover over to see individual results';
let pieTracked = null;

function buildPie(parties) {
  els.pieSvg.textContent = '';
  pieWedges = parties.map((party) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', PARTY_COLORS[party] || '#9aa7b4');
    path.addEventListener('mouseenter', () => {
      pieTracked = party;
      showPieCaption();
    });
    els.pieSvg.append(path);
    return { party, path, seats: 0 };
  });
}

/* Which party the caption should be reading. The tracked one while it is still
 * an entity; its host if it has since been merged into one; and otherwise the
 * next entity down the pie's own order, a party off the ballot having no seats
 * to report. The search stops only at a party that stands for itself, so it
 * cannot land back inside the merger it has just left. */
function trackedEntity(tracked) {
  if (!tracked || !voters) return null;
  const order = voters.parties;
  const start = order.indexOf(tracked);
  if (start < 0) return null;
  for (let i = 0; i < order.length; i++) {
    const party = order[(start + i) % order.length];
    const item = entityFor(party);
    if (!item || !item.standing) continue;
    if (i === 0 || itemHost(item) === party) return itemHost(item);
  }
  return null;
}

function showPieCaption() {
  const host = trackedEntity(pieTracked);
  if (!host || !run.model) {
    els.pieCaption.textContent = PIE_HINT;
    return;
  }
  // Zero is a reading, not a blank: a party still on the ballot that has been
  // drawn out of every seat is exactly what somebody would be watching for.
  const seats = run.model.partySeats(`party:${host}`);
  els.pieCaption.textContent =
    `${entityLabel(host)} — ${seats} ${seats === 1 ? 'seat' : 'seats'}`;
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
  showPieCaption();
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
  for (const v of variables) v.readoutRow.querySelector('dt').textContent = varFullLabel(v);
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

/* The region pie follows a party for good, as the seats pie does: the figure
 * you asked for stays while the map moves under it, rather than going the
 * instant the pointer leaves the wedge. Tracked separately from the seats pie,
 * being a different question -- one party's votes here against every party's
 * seats everywhere -- but resolved the same way through merges and exclusions.
 *
 * The party carries across a change of region: having asked what the SDLP were
 * doing in one, the question about the next one is usually the same. */
let regionPieTracked = null;

function showRegionCaption(m, r) {
  const host = trackedEntity(regionPieTracked);
  if (!host) {
    regionCaption(PIE_HINT);
    return;
  }
  // Zero is a reading here too: a party still standing that this region gives
  // nothing to is exactly what somebody would be watching the map for.
  const votes = m.regionPartyVotes(`party:${host}`, r);
  const share = m.regionPartyShare(`party:${host}`, r);
  regionCaption(`${entityLabel(host)} — ${nf.format(Math.round(votes))} `
    + `${Math.round(votes) === 1 ? 'vote' : 'votes'} (${pct.format(share)})`);
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
    path.addEventListener('mouseenter', () => {
      regionPieTracked = party;
      showRegionCaption(m, r);
    });
    els.regionPie.append(path);
    from = to;
  });
  showRegionCaption(m, r);
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

/* Whether there is anything to show yet. The panel itself is on the page from
 * the start -- one that appeared the moment a run began read as a fault -- so
 * this is what stands between the line of help and the figures. */
let resultsShown = false;

function showResults(on) {
  resultsShown = on;
  els.resultsHint.hidden = on;
  // Held open only while it is empty; with figures in it, it sizes to them.
  els.results.classList.toggle('is-resting', !on);
  // The view switch has nothing to switch between until there is a count.
  els.viewSwitch.hidden = !on || !voters;
  applyView();
}

function applyView() {
  const region = panelView === 'region' && Boolean(voters);
  els.overall.hidden = !resultsShown || Boolean(region);
  els.regionView.hidden = !resultsShown || !region;
  els.viewOverall.classList.toggle('is-active', !region);
  els.viewRegion.classList.toggle('is-active', Boolean(region));
  els.viewOverall.setAttribute('aria-pressed', String(!region));
  els.viewRegion.setAttribute('aria-pressed', String(Boolean(region)));
  if (region) drawRegion();
  else if (run.model) { drawBars(); drawPie(); }
}

/* --- steering -------------------------------------------------------------- */

/* The Goal selector as the model wants it: a party drawn to win, or a
 * demographic pushed above its threshold, is `above`. */
const goalAbove = (v) => v.above.value === 'above';

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

/* Every rule that can hide a control, in one place. Two loops each setting
 * `hidden` on the same node would only take turns winning, and the seat bonus
 * answers to both the election type and the advanced flag. A node carrying any
 * of these classes is hidden as soon as one of its conditions is unmet.
 *
 * `.real-only` is not here: it is set once, if the boundaries file fails to
 * load, and nothing toggles it afterwards. */
function applyVisibility() {
  closeNote();
  const stv = els.electionType.value === 'stv';
  // Tactical voting is a first-past-the-post affair; under STV a lower
  // preference costs a voter nothing.
  const on = {
    'stv-only': stv,
    'fptp-only': !stv,
    'advanced-only': advanced,
    'simple-only': !advanced,
  };
  for (const node of document.querySelectorAll(
    '.stv-only, .fptp-only, .advanced-only, .simple-only')) {
    node.hidden = [...node.classList].some((c) => on[c] === false);
  }
}

/* Which of a variable's gerrymander controls apply depends on the election
 * being simulated and on whether the fine tuning is out, so this runs whenever
 * either changes. */
function applyElectionType() {
  const stv = els.electionType.value === 'stv';
  applyVisibility();
  for (const v of variables) {
    // Under STV a party has nothing to tune here at all: the target is the
    // count itself, so there is no margin and no slope to put on one.
    const tunable = !(v.isParty && stv);
    // A demographic keeps its threshold in plain sight, because gerrymandering
    // by one means nothing without saying which side of what -- 60% Catholic
    // and 40% Catholic are opposite instructions. A party's winning margin has
    // a sensible answer already, zero, meaning "just wins", so it is fine
    // tuning. Steepness is fine tuning either way.
    v.tLabel.hidden = !(tunable && (advanced || !v.isParty));
    v.t.hidden = v.tLabel.hidden;
    v.sLabel.hidden = !(tunable && advanced);
    v.s.hidden = v.sLabel.hidden;
  }
}

/* The three shape penalties are one knob until they are asked for separately.
 * The three real sliders stay the source of truth -- the run reads them every
 * frame -- so Compactness writes into them and nothing downstream of weightOf()
 * knows the difference. */
const shapeParts = () => [els.shape, els.pshape, els.cut];

/* Moving the one knob moves all three. The readouts are wired to `input`, so
 * they are told rather than left showing the old figure. */
function spreadCompactness() {
  for (const part of shapeParts()) {
    part.value = els.compact.value;
    part.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/* Going back to the one knob, the three it stands for are made equal to the
 * mean of their positions -- the geometric mean of the weights, which is the
 * right average on a log slider -- so the single figure is the truth again. */
function flattenCompactness() {
  const parts = shapeParts();
  const mean = parts.reduce((a, part) => a + Number(part.value), 0) / parts.length;
  els.compact.value = String(mean);
  els.compact.dispatchEvent(new Event('input', { bubbles: true }));
  // Read back rather than reused: the slider has snapped it to a step, and all
  // four must agree exactly.
  spreadCompactness();
}

function setAdvanced(on) {
  const leaving = advanced && !on;
  advanced = on;
  els.advanced.checked = on;
  try {
    localStorage.setItem(ADVANCED_KEY, on ? '1' : '0');
  } catch { /* a private window refuses; the mode still works for this visit */ }
  if (leaving) flattenCompactness();
  // The shape statistics come and go with the sliders they belong to, and a
  // chart showing one that has just left the list falls back like any other.
  rebuildBarOptions();
  if (run.model) drawBars();
  applyElectionType();
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
    },
  });

  map.addLayer({
    id: 'dz-veil',
    type: 'fill',
    source: SRC,
    paint: {
      'fill-color': CONFIG.colors.veil,
      'fill-opacity': VEIL_OPACITY,
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

  // The hovered zone's own edge, dark and a layer of its own so no neighbour's
  // border can draw over it -- borders are drawn once per zone, so a shared
  // edge is drawn twice and the thin grey one would win half the time. A veil
  // alone leaves a small zone ambiguous, and a zone on a region boundary
  // ambiguous whichever side of it the pointer is on.
  //
  // Width zero where it is not wanted, rather than a filter: see veilAmount.
  map.addLayer({
    id: 'dz-hover-line',
    type: 'line',
    source: SRC,
    paint: {
      'line-color': CONFIG.colors.veilLine,
      'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.6, 0],
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.9, 0],
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

/* Log, like the weights and the temperature, but bent at the middle: two
 * decades in the left half, 0.01 to 1, and one in the right, 1 to 10. A single
 * scale over three decades would put 1 two thirds of the way along, and with
 * every other slider on the panel resting at its centre, the one that is not
 * reads as a setting somebody moved rather than the default it is.
 *
 * The kink is in how the track is divided, not in the speed: the value still
 * rises smoothly and monotonically from one end to the other. */
function speedOf() {
  const s = Number(els.speed.value);
  return 10 ** (s < 0 ? 2 * s : s);
}

/* The acceptance rule's temperature. Log like the speed and the weights, since
 * what matters is the factor rather than the difference: 0.1 to 10. */
function temperatureOf() {
  const t = 10 ** Number(els.temp.value);
  return t > 0 ? t : 1;
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

/* Flips between recombinations. Log like the weights, but the "never" detent
 * sits at the right-hand end, because in these units right means less often. */
function recomIntervalOf() {
  const v = Number(els.recom.value);
  return v >= Number(els.recom.max) - 1e-9 ? Infinity : Math.round(10 ** v);
}

function formatInterval(v) {
  return v === Infinity ? 'off' : nf.format(v);
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
  return base;
}

/* The hover highlight, in two tiers over the top of the colours rather than in
 * place of them: the whole region under a thin veil so it can be picked out at
 * a glance, the zone under the pointer under a thicker one so it can be picked
 * out of the region. Both white, and both leaving the region's own colour
 * showing through, which is what the old treatment could not do -- it replaced
 * the fill with orange, so a zone told you nothing about which region it was
 * in and could land on a colour it was indistinguishable from.
 *
 * Mixed into the fill's own colour rather than laid over it, so the highlight
 * costs no extra pass over 3,780 polygons: interpolate carries the base colour
 * some fraction of the way to white.
 *
 * Everything here is driven by feature-state, which is a cheap per-feature
 * write. Doing it with setFilter instead -- one call per zone the pointer
 * crosses -- re-parses the source's tiles on a GeoJSON layer, which on a real
 * map is dozens of re-tiles a second: the map goes to pieces and redraws itself
 * low-poly, with gaps, for as long as the pointer keeps moving. */
/* The region's veil was 0.16 and read as barely there. The zone's goes up with
 * it, keeping the step between them roughly what it was -- the two tiers have
 * to stay apart, and the zone's dark outline is not on its own enough to say
 * which zone when the region around it is this light. */
const VEIL_REGION = 0.28;
const VEIL_ZONE = 0.52;

/* A layer of its own, above the colours and below the borders. It could instead
 * be mixed into the fill's own colour, which saves a pass -- but that colour is
 * re-evaluated for every zone whose region changes, which during a run is most
 * of them every frame, and tripling the work in that expression costs more than
 * the extra layer ever did.
 *
 * Opacity zero for everything but the region under the pointer, rather than a
 * filter naming its zones: setFilter on a GeoJSON source re-parses its tiles,
 * and at one call per zone the pointer crosses the map comes apart and redraws
 * itself low-poly, with gaps, for as long as the pointer is moving. */
const VEIL_OPACITY = [
  'case',
  ['boolean', ['feature-state', 'hover'], false], VEIL_ZONE,
  ['boolean', ['feature-state', 'veil'], false], VEIL_REGION,
  0,
];

/* Which region is veiled, and which zones are currently wearing it. The record
 * is kept so that neither the pointer moving nor the map moving under it has to
 * write a state that is already right. */
let veiledRegion = null;
let veilShadow = null;

/* Where the pointer is and what was under it when it last moved. The map moves
 * under a still pointer all through a run, so the hover has to be recomputed
 * from this rather than only when the mouse does something. */
let hoverAt = null;

/* Re-answer the question the pointer is asking, without it having to ask again:
 * which region the zone under it belongs to now, and what that region's figures
 * come to now. The zone's own properties do not change during a run, so they
 * are reused rather than queried. */
function refreshHover(map) {
  if (!hoverAt) return;
  const region = run.model ? run.model.regionOf(hoverAt.id) : null;
  veilRegion(map, region == null || region < 0 ? null : region);
  showTooltip(hoverAt.point, hoverAt.props);
}

function veilRoom(n) {
  if (!veilShadow || veilShadow.length !== n) veilShadow = new Uint8Array(n);
  return veilShadow;
}

/* The veil goes on and comes off by feature-state, one write per zone.
 *
 * Not by rewriting the layer's paint property, which was the first attempt:
 * changing a paint expression invalidates the layer's paint buffers and
 * MapLibre rebuilds them tile by tile, so a region lights up in pieces, late,
 * and differently each time. Not by setFilter either, which re-parses the whole
 * source. Feature-state is the one that touches only what changed. */
function veilRegion(map, region) {
  if (region === veiledRegion) return;
  veiledRegion = region;
  const m = run.model;
  if (!m) return;
  const worn = veilRoom(m.n);
  // Walks every zone but writes only the ones that change: the region being
  // left and the region being entered, a few hundred of 3,780.
  for (let z = 0; z < m.n; z++) {
    const veil = m.assign[z] === region;
    if (worn[z] === (veil ? 1 : 0)) continue;
    worn[z] = veil ? 1 : 0;
    map.setFeatureState({ source: SRC, id: m.codes[z] }, { veil });
  }
}

/* Push only the zones whose region changed since the last redraw. Zones are
 * only ever unset by clearRegions(), so this never has to write a null.
 *
 * The veil is set here too, because it belongs to the region rather than to the
 * zone: a zone that leaves the region under the pointer must lose it and one
 * that joins must gain it, whether or not the pointer has moved. Doing it in
 * the same write costs nothing -- these are the zones that changed. */
function paintRegions(map) {
  const { model, shadow } = run;
  const worn = veilRoom(model.n);
  let underPointer = false;
  for (let z = 0; z < model.n; z++) {
    const region = model.assign[z];
    if (shadow[z] === region || region < 0) continue;
    shadow[z] = region;
    const veil = region === veiledRegion;
    worn[z] = veil ? 1 : 0;
    map.setFeatureState({ source: SRC, id: model.codes[z] }, { region, veil });
    if (hoverAt && model.codes[z] === hoverAt.id) underPointer = true;
  }
  // The zone the pointer is on changed hands. The veil belongs to its new
  // region now, and everything the tooltip says about a region is about a
  // different region. Done after the loop, since re-veiling walks the zones.
  if (underPointer) refreshHover(map);
}

function clearRegions(map) {
  map.removeFeatureState({ source: SRC });   // also drops hover; it re-sets on move
  run.shadow.fill(-1);
  // The veil went with it, so the record of who was wearing it must go too, or
  // the next hover over the same region number would think it was already on.
  veiledRegion = null;
  if (veilShadow) veilShadow.fill(0);
}

/* --- interaction --------------------------------------------------------- */

/* Three rules hold across the whole tooltip.
 *
 *   The election is always reported, as the seats pie always is -- it is the
 *   map's result, not one variable's readout, and it used to vanish the moment
 *   a demographic outvoted a party for the panel's attention.
 *
 *   Every variable on the page is always here, a party's own row included:
 *   putting one on the page is the act of asking about it.
 *
 *   A variable being steered is accented. Weights are read off the sliders
 *   rather than the model, so the colour follows one being dragged, run or no
 *   run.
 *
 * The first two are about what is shown and the third about how, which is why
 * a party can be listed without being lit.
 */
const steering = (v) => weightOf(v.w) > 0;

function showTooltip(point, props) {
  els.ttName.textContent = props.name || props.code;
  els.ttPop.textContent = props.pop == null ? '—' : nf.format(props.pop);
  // Accented when the run is weighting that term. Population's slider has no
  // off, so in practice it is always lit; the check is here so the rule reads
  // as one rule rather than as an exception written into the markup.
  const popSteered = weightOf(els.popw) > 0;
  els.ttPopLine.classList.toggle('is-steered', popSteered);
  els.ttRegionPopLine.classList.toggle('is-steered', popSteered);
  for (const v of variables) {
    const steered = steering(v);
    v.tip.classList.toggle('is-steered', steered);
    v.regionTip.classList.toggle('is-steered', steered);
    if (v.isParty) {
      const share = elect.share(props.code, v.party);
      const votes = Math.round(elect.votes(props.code) * share);
      v.tip.textContent = `${varFullLabel(v)} ${nf.format(votes)} `
        + `${votes === 1 ? 'vote' : 'votes'} (${pct.format(share)})`;
      v.tip.hidden = false;
    } else {
      // A demographic can still be missing its figure for a zone, which is a
      // fact about the data rather than about what is being steered.
      const value = props[v.def.field];
      const ok = typeof value === 'number';
      v.tip.textContent = ok
        ? `${varFullLabel(v)} ${value.toFixed(v.def.decimals)}` : '';
      v.tip.hidden = !ok;
    }
  }
  // The election is the map's result, so it is reported wherever there is one
  // to report; the zone's per-party lines need a party on the page to be about.
  const party = Boolean(voters);
  els.ttParty.hidden = !variables.some((v) => v.isParty);

  const region = run.model && run.model.regionOf(props.code);
  if (region == null) {
    els.ttRegion.hidden = true;
    els.ttRegionParty.hidden = true;
  } else {
    els.ttRegionName.textContent = `Region ${region + 1}`;
    els.ttRegionPop.textContent = nf.format(Math.round(run.model.regionPop[region]));
    for (const v of variables) {
      if (v.isParty) continue;
      const show = run.model.demoByKey[v.key] !== undefined;
      v.regionTip.textContent = show
        ? `${varFullLabel(v)} `
          + `${run.model.regionDemo(v.key, region).toFixed(v.def.decimals)}`
        : '';
      v.regionTip.hidden = !show;
    }
    els.ttRegionParty.hidden = !party;
    if (party) {
      // The region's result, strongest first, so the winner is the top row.
      // The parties being steered are highlighted; if one misses the top five,
      // the fifth row gives way to it and carries its rank.
      // On the page is what earns a row -- promoted with its rank if it is
      // outside the top five. Being steered is what earns the colour. A party
      // sitting at zero weight is still one you asked about.
      const onPage = variables.filter((v) => v.isParty);
      const targets = new Set(onPage.map((v) => v.key));
      const lit = new Set(onPage.filter(steering).map((v) => v.key));
      const standings = voters.parties
        .filter((name) => entityHost(name) === name)
        .map((name) => ({
        name: entityLabel(name),
        key: `party:${name}`,
        votes: run.model.regionPartyVotes(`party:${name}`, region),
        share: run.model.regionPartyShare(`party:${name}`, region),
        seats: run.model.regionPartySeats(`party:${name}`, region),
      })).sort((a, b) => b.votes - a.votes);
      // Every party on the page keeps its place, then the strongest of the rest
      // fill the list up to five. It used to take the top five and swap the
      // weakest of them out for each promoted party, which works while at most
      // four need promoting but evicts parties that are themselves on the page
      // once more than one is down the order: all nine on the page left the
      // top four swapped out for the bottom four, showing 1st and 6th to 9th.
      //
      // So the five is a floor rather than a ceiling. Six parties on the page
      // means six rows; that is what asking about six parties looks like.
      const keep = new Set();
      standings.forEach((row, i) => { if (targets.has(row.key)) keep.add(i); });
      for (let i = 0; i < standings.length && keep.size < 5; i++) keep.add(i);
      // A rank is worth printing only where a row does not follow the one above
      // it -- that is, where something has been left out in between. A list
      // that runs 1st to 6th unbroken says so by being in order, and numbering
      // the last row 6. only repeats what the five rows above it already said.
      const order = [...keep].sort((a, b) => a - b);
      const rows = order.map((i, k) => (i === (k === 0 ? 0 : order[k - 1] + 1)
        ? standings[i]
        : { ...standings[i], rank: i + 1 }));
      els.ttRegionParty.textContent = '';
      for (const row of rows) {
        els.ttRegionParty.append(el('div', {
          class: lit.has(row.key) ? 'tt-party-row is-target' : 'tt-party-row',
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

  // One paint-property update, and only when the pointer crosses a region
  // boundary -- not on every move, and never a walk over the region's zones,
  // since the expression asks each zone for its own region as it draws.
  const clear = () => {
    if (hovered !== null) {
      map.setFeatureState({ source: SRC, id: hovered }, { hover: false });
      hovered = null;
    }
    hoverAt = null;
    veilRegion(map, null);
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
    hoverAt = { id: f.id, point: e.point, props: f.properties };
    refreshHover(map);
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
    temperature: temperatureOf(),
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
        above: goalAbove(v),
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
  showResults(true);
  els.resultsList.hidden = false;
  els.pie.hidden = !voters;
  shownRegion = 0;
  buildBars(map, n);
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
  showResults(false);
  els.resultsList.hidden = true;
  els.pie.hidden = true;
  setButtons('idle');
}

/* --- the run ------------------------------------------------------------- */

/* Whether the region controls were locked the last time setButtons ran, so the
 * group is folded on the change rather than on every call. Starts false: the
 * page opens idle, with the group open. */
let regionLocked = false;

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
  // Everything in the region group is fixed once a run starts: changing any of
  // it mid-run would mean a different map, not a different reading of this one.
  // Real boundaries are a starting point rather than a state -- from the first
  // move the map is no longer the real one -- so the selector greys with the
  // rest instead of vanishing. Hiding is now only for boundaries that never
  // loaded. The election controls stay live, so a paused map can be re-counted.
  els.n.disabled = state !== 'idle' || realLoaded();
  els.seed.disabled = state !== 'idle';
  els.real.disabled = state !== 'idle';
  // With none of it usable, the group folds itself away for the run and comes
  // back when the run stops. On the change of state only: a group opened by
  // hand mid-run -- to read off an automatic seed, say -- stays open, and
  // pausing does not slam it shut.
  const locked = state !== 'idle';
  if (locked !== regionLocked) {
    regionLocked = locked;
    setGroupOpen('region-settings', !locked);
  }
}

function readout() {
  const m = run.model;
  const phase = {
    build: `Building ${nf.format(m.assigned)}/${nf.format(m.n)}`,
    // With the flip count off the page in simple mode it comes here instead,
    // where it says what it is worth saying: how many versions of the map the
    // run has tried. Advanced mode has the counter in its own row already.
    optimise: advanced ? 'Optimising'
      : `Optimising — ${nf.format(m.moves)} updates`,
    done: 'Stopped — best shown',
  }[run.phase] || '—';
  els.runPhase.textContent = run.paused ? `${phase} — paused` : phase;
  els.runDev.textContent = pct.format(m.maxDeviation);
  els.runMoves.textContent = nf.format(m.moves);
  els.runRecom.textContent = nf.format(m.recombinations);
  for (const v of variables) {
    const live = m.demoByKey[v.key];
    if (v.isParty) {
      // Seats won, and only that: it is the outcome being drawn for, and it is
      // a number with a scale to read it against. The spread that used to come
      // with it in average and extreme modes had neither.
      v.readoutRow.hidden = false;
      v.readout.textContent = `${m.partySeats(v.key)}/${m.totalSeats} won`;
    } else {
      // A demographic only has an answer when it is gerrymandering: how many
      // regions cleared the threshold, and which side of it was the goal,
      // since the same numerator means the opposite thing either way. The
      // spread the other modes would report is in the term's own units against
      // no baseline, and cannot be read.
      //
      // So the row goes rather than standing there holding a dash. A dash said
      // two things -- that the variable exists, and that it has nothing to
      // tell you -- and the list is for the second sort of fact only.
      const counted = live && live.weight > 0 && live.mode === 'gerrymander';
      v.readoutRow.hidden = !counted;
      if (counted) {
        v.readout.textContent = `${m.demoSeats(v.key)}/${m.N} ${goalAbove(v) ? 'above' : 'below'}`;
      }
    }
    v.readoutRow.querySelector('dt').textContent = varFullLabel(v);
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
      run.model.temperature = temperatureOf();
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
          Number(v.s.value), goalAbove(v));
      }
      const demoWeights = termWeights();
      run.model.setWeights(weightOf(els.popw), weightOf(els.shape),
        weightOf(els.pshape), weightOf(els.cut), demoWeights);
      // Both change the move set rather than the score, so best-so-far stays
      // comparable and neither needs a re-base.
      run.model.recomInterval = recomIntervalOf();
      run.model.allowBranchMoves = els.branch.checked;

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
      // Both clocks are bounded by the frame rate: neither can outpace it.
      const slow = now - run.lastBars >= BAR_INTERVAL;
      const fast = now - run.lastPie >= PIE_INTERVAL;
      if (slow) run.lastBars = now;
      if (fast) run.lastPie = now;
      if (panelView === 'region') {
        // One call draws whichever the election calls for, so it answers to
        // whichever clock that one keeps: the votes pie to the fast one, the
        // STV stages to the slow one.
        if (run.model.electionType === 'stv' ? slow : fast) drawRegion();
      } else {
        if (fast) drawPie();
        if (slow) drawBars();
      }
      // The tooltip reports a region's population, its demographics and its
      // standings, all of which move every frame. Keeping the pointer still is
      // not a request to freeze them, so they keep the results panel's own
      // slower clock -- fast enough to be live, slow enough to read.
      if (slow) refreshHover(map);
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
    run.lastPie = 0;
    setButtons('running');
    showResults(true);
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
    temperature: temperatureOf(),
    wPop: weightOf(els.popw),
    wShape: weightOf(els.shape),
    wPopShape: weightOf(els.pshape),
    wCut: weightOf(els.cut),
    demo: Object.fromEntries(variables.map((v) => [v.key, {
      weight: weightOf(v.w),
      mode: v.mode.value,
      threshold: Number(v.t.value),
      steepness: Number(v.s.value),
      above: goalAbove(v),
    }])),
  });
  run.colors = palette(n);
  map.setPaintProperty('dz-fill', 'fill-color', fillExpression(run.colors));

  run.phase = 'build';
  run.paused = false;
  run.lastDraw = 0;
  run.lastBars = 0;
  run.lastPie = 0;
  setButtons('running');
  showResults(true);
  els.resultsList.hidden = false;  // bars are live from the first build step
  els.pie.hidden = !voters;
  shownRegion = 0;                 // a new map, so back to the first region
  buildBars(map, n);
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
function buildBars(map, n) {
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

    // Pointing at a row lights its region on the map, the same veil the map's
    // own hover uses. The bars are a list of regions; this is what says which
    // is which, without a colour key or a hunt for a number.
    row.addEventListener('mouseenter', () => veilRegion(map, region));
    row.addEventListener('mouseleave', () => veilRegion(map, null));

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
    // The real heads carry a marker, so the reference has to carry one too --
    // measured without it, the column is about 19px short and the typical head
    // wraps, which is exactly what this reference exists to prevent.
    infoMark(),
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

/* The panel is either the map's controls or the list of pages, never both: at
 * 398px there is no room to put one beside the other, and the burger is the
 * only way in or out, so there is nothing to hunt for. The gable stays either
 * way, which is what says the panel is still the panel. */
function showMenu(open) {
  els.menuToggle.setAttribute('aria-expanded', String(open));
  els.panelMenu.hidden = !open;
  els.panelBody.hidden = open;
}

/* The settings groups fold away under their own headings, as a variable block
 * does. Written in the HTML rather than built here, so this only has to find
 * each heading and the body it names. Kept by id because the run folds one of
 * them itself. */
const groups = new Map();

function wireGroupToggles() {
  for (const toggle of document.querySelectorAll('.ctl-group-toggle')) {
    const id = toggle.getAttribute('aria-controls');
    const body = document.getElementById(id);
    if (!body) continue;
    groups.set(id, { toggle, body });
    toggle.addEventListener('click', () => setGroupOpen(id, body.hidden));
  }
}

function setGroupOpen(id, open) {
  const g = groups.get(id);
  if (!g) return;
  g.body.hidden = !open;
  g.toggle.setAttribute('aria-expanded', String(open));
}

/* Slider to the figure beside its label. Variables are added and removed, so
 * this is per input rather than a list walked once at boot. */
function wireReadout(input, out, format = null) {
  const show = () => {
    if (format) out.textContent = format(input.value);
    else if (input.dataset.weight !== undefined) out.textContent = formatWeight(weightOf(input));
    else if (input.dataset.interval !== undefined) {
      out.textContent = formatInterval(recomIntervalOf());
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
  els.barsStat.addEventListener('change', () => {
    barStatChosen = true;
    if (run.model) drawBars();
  });

  for (const [input, out] of [[els.popw, els.popwValue], [els.shape, els.shapeValue],
                             [els.pshape, els.pshapeValue], [els.cut, els.cutValue],
                             [els.compact, els.compactValue], [els.bonus, els.bonusValue],
                             [els.recom, els.recomValue]]) {
    wireReadout(input, out);
  }
  // The one knob drives the three, and the checkbox decides which is showing.
  els.compact.addEventListener('input', spreadCompactness);
  els.advanced.addEventListener('change', () => setAdvanced(els.advanced.checked));
  els.menuToggle.addEventListener('click', () => showMenu(els.panelMenu.hidden));
  // Escape closes it, as it closes the add-variable menu.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.panelMenu.hidden) showMenu(false);
  });
  // Whatever was remembered, applied before anything is on screen.
  setAdvanced(advanced);
  wireReadout(els.speed, els.speedValue, () => formatSpeed(speedOf()));
  wireReadout(els.temp, els.tempValue, () => formatSpeed(temperatureOf()));
  wireGroupToggles();
  sizeLabelColumn();

  // The region view names one region and paints its colour; pointing at either
  // lights it on the map, as pointing at its bar does. The name answers "which
  // one is this?" and until now the only way to ask was to find the same number
  // in the bars and hover that instead.
  els.regionTitle.addEventListener('mouseenter', () => {
    const m = run.model;
    if (m && m.N && shownRegion < m.N) veilRegion(map, shownRegion);
  });
  els.regionTitle.addEventListener('mouseleave', () => veilRegion(map, null));

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
  }

  // The page opens with one variable, which is what a variable is for: an
  // empty page would say nothing about what the tool does.
  addVariable(voters ? 'party:Alliance' : DEMOGRAPHICS[0].key);
  applyVariables();
  // Empty, and saying so: this is what puts the help text up and holds the
  // panel open. It calls applyView itself.
  showResults(false);


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
