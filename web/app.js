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
  ttLgd: document.querySelector('.tt-lgd'),
  ttRegion: document.querySelector('.tt-region'),
  statZones: document.getElementById('stat-zones'),
  statPop: document.getElementById('stat-pop'),
  n: document.getElementById('ctl-n'),
  seed: document.getElementById('ctl-seed'),
  temp: document.getElementById('ctl-temp'),
  fps: document.getElementById('ctl-fps'),
  fpsValue: document.getElementById('ctl-fps-value'),
  build: document.getElementById('ctl-build'),
  buildValue: document.getElementById('ctl-build-value'),
  opt: document.getElementById('ctl-opt'),
  optValue: document.getElementById('ctl-opt-value'),
  shape: document.getElementById('ctl-shape'),
  shapeValue: document.getElementById('ctl-shape-value'),
  pshape: document.getElementById('ctl-pshape'),
  pshapeValue: document.getElementById('ctl-pshape-value'),
  go: document.getElementById('ctl-go'),
  pause: document.getElementById('ctl-pause'),
  stop: document.getElementById('ctl-stop'),
  run: document.getElementById('run'),
  runPhase: document.getElementById('run-phase'),
  runDev: document.getElementById('run-dev'),
  runShape: document.getElementById('run-shape'),
  runPShape: document.getElementById('run-pshape'),
  runMoves: document.getElementById('run-moves'),
  runScore: document.getElementById('run-score'),
  runBest: document.getElementById('run-best'),
  results: document.getElementById('results'),
  resultsBody: document.querySelector('#results-table tbody'),
};

/* Live run state. `shadow` is what the map currently shows, so each redraw only
 * pushes the zones that actually changed. */
const run = {
  model: null,
  phase: 'idle',          // idle | build | optimise | done
  raf: 0,
  paused: false,
  lastDraw: 0,
  shadow: null,
  colors: [],
};

/* --- data ---------------------------------------------------------------- */

async function loadZones() {
  const res = await fetch(CONFIG.dataUrl);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${CONFIG.dataUrl}`);
  return res.json();
}

function summarise(geojson) {
  let pop = 0;
  for (const f of geojson.features) pop += f.properties.pop || 0;
  return { zones: geojson.features.length, pop };
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
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
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

function showTooltip(point, props) {
  els.ttName.textContent = props.name || props.code;
  els.ttPop.textContent = props.pop == null ? '—' : nf.format(props.pop);
  els.ttLgd.textContent = props.lgd || '';

  const region = run.model && run.model.regionOf(props.code);
  if (region == null) {
    els.ttRegion.hidden = true;
  } else {
    els.ttRegion.textContent =
      `Region ${region + 1} — ${nf.format(Math.round(run.model.regionPop[region]))}`;
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
  // The legible numbers: 1 is a circle for land, and evenly-spread population
  // for people. The normalised terms are measured per move, so their own
  // values are large and say little.
  els.runShape.textContent = m.meanPenalty.toFixed(2);
  els.runPShape.textContent = m.meanPopPenalty.toFixed(2);
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
      run.model.setShapeWeight(Number(els.shape.value));
      run.model.setPopShapeWeight(Number(els.pshape.value));

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
    }
    run.raf = requestAnimationFrame(frame);
  };
}

function start(map) {
  const n = Math.max(2, Math.min(500, Number(els.n.value) || 18));
  els.n.value = n;
  stop(map, { silent: true });
  clearRegions(map);

  run.model.start(n, Number(els.seed.value) || 0, Number(els.temp.value) || 1,
    Number(els.shape.value), Number(els.pshape.value));
  run.colors = palette(n);
  map.setPaintProperty('dz-fill', 'fill-color', fillExpression(run.colors));

  run.phase = 'build';
  run.paused = false;
  run.lastDraw = 0;
  setButtons('running');
  els.run.hidden = false;
  els.results.hidden = true;
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
  showResults();
}

function showResults() {
  const rows = run.model.summary().sort((a, b) => b.pop - a.pop);
  els.resultsBody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    const swatch = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = run.colors[row.region];
    swatch.appendChild(dot);
    const name = document.createElement('td');
    name.textContent = `Region ${row.region + 1}`;
    const pop = document.createElement('td');
    pop.className = 'num';
    pop.textContent = nf.format(Math.round(row.pop));
    const dev = document.createElement('td');
    dev.className = 'num muted';
    dev.textContent = pct.format(row.deviation);
    tr.append(swatch, name, pop, dev);
    els.resultsBody.appendChild(tr);
  }
  els.results.hidden = false;
}

/* --- boot ---------------------------------------------------------------- */

async function main() {
  const map = createMap();

  for (const [input, out] of [[els.fps, els.fpsValue], [els.build, els.buildValue],
                             [els.opt, els.optValue], [els.shape, els.shapeValue],
                             [els.pshape, els.pshapeValue]]) {
    input.addEventListener('input', () => { out.textContent = input.value; });
    out.textContent = input.value;
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

    const { zones, pop } = summarise(geojson);
    els.statZones.textContent = nf.format(zones);
    els.statPop.textContent = nf.format(pop);
    els.status.hidden = true;

    // Adjacency is data, not a layer -- nothing on screen depends on it, so it
    // loads off the critical path and a failure must not take the map with it.
    DZGraph.load(CONFIG.graphUrl)
      .then((graph) => {
        window.__graph = graph;
        const pops = Object.fromEntries(
          geojson.features.map((f) => [f.properties.code, f.properties.pop]));
        run.model = new RegionModel(graph, pops, zoneGeometry(geojson.features));
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
