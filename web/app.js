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

/* --- data ---------------------------------------------------------------- */

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
  const shown = new Set(activeDemos());
  for (const u of demoUI) {
    const v = props[u.def.field];
    const show = shown.has(u) && typeof v === 'number';
    u.tip.textContent = show
      ? `${u.def.label.toLowerCase()} ${v.toFixed(u.def.decimals)}` : '';
    u.tip.hidden = !show;
  }

  const region = run.model && run.model.regionOf(props.code);
  if (region == null) {
    els.ttRegion.hidden = true;
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
      const demoWeights = {};
      for (const u of demoUI) {
        run.model.setDemographic(u.def.key, u.mode.value, Number(u.t.value),
          Number(u.s.value), u.above.checked);
        demoWeights[u.def.key] = weightOf(u.w);
      }
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

  run.model.start(n, Number(els.seed.value) || 0, {
    temperature: Number(els.temp.value) || 1,
    wPop: weightOf(els.popw),
    wShape: weightOf(els.shape),
    wPopShape: weightOf(els.pshape),
    wCut: weightOf(els.cut),
    demo: Object.fromEntries(demoUI.map((u) => [u.def.key, {
      weight: weightOf(u.w),
      mode: u.mode.value,
      threshold: Number(u.t.value),
      steepness: Number(u.s.value),
      above: u.above.checked,
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
  buildBars(n);
  drawBars();
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

    row.append(label, track);
    els.bars.appendChild(row);
    return { row, fill, value };
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
  });

  // The labels report the actual extremes, not the padded domain -- the padding
  // exists so the smallest bar is visible, not to be read off the axis.
  els.barsMin.textContent = stat.format(lo);
  els.barsMax.textContent = stat.format(hi);
}

/* --- boot ---------------------------------------------------------------- */

async function main() {
  const map = createMap();

  buildDemoControls();

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

  try {
    const [geojson] = await Promise.all([
      loadZones(),
      new Promise((resolve) => map.on('load', resolve)),
    ]);

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
          zoneDemographics(geojson.features));
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
