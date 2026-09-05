/* NI Data Zones — interactive map.
 *
 * Structure is deliberately split into data / map / layers / interaction so the
 * dynamic features planned next slot in without restructuring:
 *   - recolour by any metric  -> map.setPaintProperty('dz-fill', 'fill-color', expr)
 *   - swap the dataset        -> map.getSource(SRC).setData(next)
 * Hover uses feature-state, so nothing re-renders per mouse move.
 */
'use strict';

const CONFIG = {
  dataUrl: 'data/dz.geojson',
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

const els = {
  status: document.getElementById('status'),
  tooltip: document.getElementById('tooltip'),
  ttName: document.querySelector('.tt-name'),
  ttPop: document.querySelector('.tt-pop-value'),
  ttLgd: document.querySelector('.tt-lgd'),
  statZones: document.getElementById('stat-zones'),
  statPop: document.getElementById('stat-pop'),
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
      'fill-color': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        CONFIG.colors.fillHover,
        CONFIG.colors.fill,
      ],
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

/* --- interaction --------------------------------------------------------- */

function showTooltip(point, props) {
  els.ttName.textContent = props.name || props.code;
  els.ttPop.textContent = props.pop == null ? '—' : nf.format(props.pop);
  els.ttLgd.textContent = props.lgd || '';
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

/* --- boot ---------------------------------------------------------------- */

async function main() {
  const map = createMap();

  try {
    const [geojson] = await Promise.all([
      loadZones(),
      new Promise((resolve) => map.on('load', resolve)),
    ]);

    addZoneLayers(map, geojson);
    wireHover(map);

    // Debug handle: lets you poke at the map from the console, e.g.
    //   __map.setPaintProperty('dz-fill', 'fill-color', '#c00')
    window.__map = map;

    const { zones, pop } = summarise(geojson);
    els.statZones.textContent = nf.format(zones);
    els.statPop.textContent = nf.format(pop);
    els.status.hidden = true;
  } catch (err) {
    els.status.textContent = `Could not load zones — ${err.message}`;
    els.status.classList.add('error');
    console.error(err);
  }
}

main();
