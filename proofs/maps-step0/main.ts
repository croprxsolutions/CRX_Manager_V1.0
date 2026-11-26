import * as maplibregl from 'maplibre-gl';
import type { RasterTileSource } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import mapLibreCss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import drawCss from '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css?inline';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const PICTURE_SOURCE_ID = 'proof-picture';
const PICTURE_LAYER_ID = 'proof-picture-layer';
const DRAW_CONTROL_ID = 'proof-draw-control';
const DRAW_CLASSES = MapboxDraw.constants.classes as unknown as Record<
  'CANVAS' | 'CONTROL_BASE' | 'CONTROL_PREFIX' | 'CONTROL_GROUP' | 'ATTRIBUTION',
  string
>;

// Mapbox Draw reads these once when it creates controls and handles canvas events.
DRAW_CLASSES.CANVAS = 'maplibregl-canvas';
DRAW_CLASSES.CONTROL_BASE = 'maplibregl-ctrl';
DRAW_CLASSES.CONTROL_PREFIX = 'maplibregl-ctrl-';
DRAW_CLASSES.CONTROL_GROUP = 'maplibregl-ctrl-group';
DRAW_CLASSES.ATTRIBUTION = 'maplibregl-ctrl-attrib';

type Picture = 'A' | 'B';
type Coordinate = [number, number];
type ProofApi = {
  ready: boolean;
  startPolygon: () => void;
  startDirectSelect: () => void;
  switchPicture: (picture: Picture) => void;
  getDraft: () => ReturnType<MapboxDraw['getAll']>;
  getMode: () => string;
  getLayerOrder: () => string[];
  getPictureTiles: () => string[];
  project: (coordinate: Coordinate) => { x: number; y: number };
  trash: () => void;
  mapInstanceId: string;
};

declare global {
  interface Window {
    __proof?: ProofApi;
  }
}

function scopeDrawCss(css: string): string {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const scopedRules: string[] = [];

  for (const [, selectorText, declarations] of rules) {
    const selectors = selectorText.split(',').map((selector) => selector.trim());
    const scopedSelectors = selectors.map((selector) => {
      if (selector.startsWith('.mapboxgl-map')) {
        return selector
          .replaceAll('mapboxgl-map', 'maplibregl-map')
          .replaceAll('mapboxgl-canvas-container', 'maplibregl-canvas-container')
          .replaceAll('mapboxgl-interactive', 'maplibregl-interactive')
          .replace(/^\.maplibregl-map/, '#proof-map.maplibregl-map');
      }
      if (selector.startsWith('.mapbox-gl-draw_ctrl-top') || selector.startsWith('.mapbox-gl-draw_ctrl-bottom')) {
        return `#${DRAW_CONTROL_ID}${selector}`;
      }
      if (selector.startsWith('.mapbox-gl-draw_ctrl-draw-btn')) {
        return `#${DRAW_CONTROL_ID} ${selector}`;
      }
      if (selector.startsWith('.mapbox-gl-draw_boxselect')) {
        return `#proof-map ${selector}`;
      }
      return `#${DRAW_CONTROL_ID} ${selector}`;
    });
    scopedRules.push(`${scopedSelectors.join(', ')} {${declarations}}`);
  }

  return scopedRules.join('\n');
}

function addScopedStyles(): void {
  const style = document.createElement('style');
  style.id = 'proof-styles';
  style.textContent = `${mapLibreCss}\n${scopeDrawCss(drawCss)}
    html, body, #proof-shell { width: 100%; height: 100%; margin: 0; }
    #proof-shell { position: fixed; inset: 0; }
    #proof-map { position: absolute; inset: 0; }
    #proof-toolbar { position: absolute; top: 12px; left: 12px; z-index: 3; display: flex; gap: 8px; align-items: center; padding: 8px; border-radius: 6px; background: white; box-shadow: 0 1px 5px #0003; font: 14px sans-serif; }
    #proof-toolbar button { min-height: 36px; padding: 0 10px; }
    #proof-draw-control { border-radius: 4px; }`;
  document.head.append(style);
}

function tileTemplate(picture: Picture): string {
  return `${window.location.origin}/tiles/${picture}/{z}/{x}/{y}.png`;
}

function getRasterTiles(map: maplibregl.Map): string[] {
  const source = map.getStyle().sources[PICTURE_SOURCE_ID];
  if (!source || source.type !== 'raster') throw new Error('Proof raster source is missing');
  return source.tiles ?? [];
}

addScopedStyles();

const mapInstanceId = crypto.randomUUID();
const map = new maplibregl.Map({
  container: 'proof-map',
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'proof-background',
        type: 'background',
        paint: { 'background-color': '#e9e9e9' },
      },
    ],
  },
  center: [0, 0],
  zoom: 2,
  attributionControl: false,
  interactive: true,
});

const draw = new MapboxDraw({
  displayControlsDefault: false,
  controls: { polygon: true, trash: true },
});

const proof: ProofApi = {
  ready: false,
  startPolygon: () => draw.changeMode('draw_polygon'),
  startDirectSelect: () => {
    const feature = draw.getAll().features[0];
    if (!feature?.id) throw new Error('Draw a polygon before entering direct select');
    draw.changeMode('direct_select', { featureId: String(feature.id) });
  },
  switchPicture: (picture) => {
    if (picture !== 'A' && picture !== 'B') throw new Error(`Unknown proof picture: ${picture}`);
    const source = map.getSource(PICTURE_SOURCE_ID) as RasterTileSource | undefined;
    if (!source) throw new Error('Proof raster source is not ready');
    source.setTiles([tileTemplate(picture)]);
  },
  getDraft: () => draw.getAll(),
  getMode: () => draw.getMode(),
  getLayerOrder: () => map.getStyle().layers.map((layer) => layer.id),
  getPictureTiles: () => getRasterTiles(map),
  project: (coordinate) => map.project(coordinate),
  trash: () => draw.trash(),
  mapInstanceId,
};
window.__proof = proof;

map.on('load', () => {
  map.addSource(PICTURE_SOURCE_ID, {
    type: 'raster',
    tiles: [tileTemplate('A')],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 8,
  });
  map.addLayer({ id: PICTURE_LAYER_ID, type: 'raster', source: PICTURE_SOURCE_ID });
  map.addControl(draw as unknown as maplibregl.IControl, 'top-right');

  const drawControl = map
    .getContainer()
    .querySelector<HTMLElement>('.maplibregl-ctrl-top-right .maplibregl-ctrl-group');
  if (!drawControl) throw new Error('MapLibre Draw control was not added');
  drawControl.id = DRAW_CONTROL_ID;

  proof.ready = true;
  document.querySelector('#proof-status')!.textContent = 'Ready · picture A';
});

map.on('error', (event) => {
  // eslint-disable-next-line no-console -- the spec fails on any console.error, so map errors must reach it
  if (event.error) console.error('MapLibre proof error:', event.error.message);
});

document.querySelector('#start-polygon')!.addEventListener('click', () => proof.startPolygon());
document.querySelector('#switch-picture-a')!.addEventListener('click', () => {
  proof.switchPicture('A');
  document.querySelector('#proof-status')!.textContent = 'Ready · picture A';
});
document.querySelector('#switch-picture-b')!.addEventListener('click', () => {
  proof.switchPicture('B');
  document.querySelector('#proof-status')!.textContent = 'Ready · picture B';
});
