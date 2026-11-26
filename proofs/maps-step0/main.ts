import * as maplibregl from 'maplibre-gl';
import type { RasterTileSource } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import mapLibreCss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import drawCss from '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css?inline';
import mapboxCss from 'mapbox-gl/dist/mapbox-gl.css?inline';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const PICTURE_SOURCE_ID = 'proof-picture';
const PICTURE_LAYER_ID = 'proof-picture-layer';
const DRAW_CONTROL_ID = 'proof-draw-control';
const STAGING_PROOF_PATH = '/api/maps-step0-draw/';
const USDA_HOST = 'basemap.nationalmap.gov';
const MAPBOX_HOST = 'api.mapbox.com';
const stagingProof = import.meta.env.BASE_URL === STAGING_PROOF_PATH;
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const livePicturesEnabled = stagingProof && location.hostname === 'staging.croprxsolutions.app'
  && /^pk\.[\w.-]+$/.test(mapboxToken ?? '');
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
  getCamera: () => number[];
  moveCamera: () => void;
  getRasterPixel: () => number[];
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
  style.textContent = `${mapLibreCss}\n${scopeDrawCss(drawCss)}\n${livePicturesEnabled ? mapboxCss : ''}
    html, body, #proof-shell { width: 100%; height: 100%; margin: 0; }
    #proof-shell { position: fixed; inset: 0; }
    #proof-map { position: absolute; inset: 0; }
    #proof-toolbar { position: absolute; top: 12px; left: 12px; right: 60px; width: fit-content; max-width: calc(100% - 88px); z-index: 3; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px; border-radius: 6px; background: white; box-shadow: 0 1px 5px #0003; font: 14px sans-serif; }
    #proof-toolbar button { min-height: 44px; padding: 0 10px; }
    #proof-draw-control { border-radius: 4px; }
    #proof-credits { position: absolute; z-index: 3; bottom: 0; right: 0; background: white; font: 12px sans-serif; }
    #proof-credits span:not([hidden]) { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 6px; }
    #proof-credits .mapboxgl-ctrl-logo { margin: 0; }`;
  document.head.append(style);
}

function tileTemplate(picture: Picture | `${Picture}-outage`): string {
  const tileQuery = 'z={z}&x={x}&y={y}';
  const outageQuery = picture.endsWith('-outage') ? `&attempt=${outageAttempt}` : '';
  if (stagingProof && picture.endsWith('-outage')) {
    return `${location.origin}/api/maps-step0?drawingOutage=1&picture=${picture[0]}&${tileQuery}${outageQuery}`;
  }
  if (livePictures && (picture === 'A' || picture === 'B')) {
    return `proof-live://${picture.toLowerCase()}/${pictureAttempt}/{z}/{x}/{y}`;
  }
  return `${location.origin}${import.meta.env.BASE_URL}tiles/${picture}.png?${tileQuery}${outageQuery}`;
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
  center: stagingProof ? [-93, 41] : [0, 0],
  zoom: stagingProof ? 12 : 2,
  attributionControl: false,
  interactive: true,
  canvasContextAttributes: { preserveDrawingBuffer: !stagingProof },
});

const draw = new MapboxDraw({
  displayControlsDefault: false,
  controls: { polygon: true, trash: true },
});

const toolbar = document.querySelector('#proof-toolbar')!;
const status = toolbar.querySelector<HTMLOutputElement>('#proof-status')!;
const retryButton = toolbar.querySelector<HTMLButtonElement>('#retry-picture')!;
const livePicturesButton = toolbar.querySelector<HTMLButtonElement>('#live-pictures')!;
const pictureAButton = toolbar.querySelector<HTMLButtonElement>('#switch-picture-a')!;
const pictureBButton = toolbar.querySelector<HTMLButtonElement>('#switch-picture-b')!;
const usdaCredit = document.querySelector<HTMLElement>('#usda-credit')!;
const mapboxCredit = document.querySelector<HTMLElement>('#mapbox-credit')!;
const mapboxFeedback = document.querySelector<HTMLAnchorElement>('#mapbox-feedback')!;
const saveKey = 'maps-step0-synthetic-draft';
let savedDraftJson: string | null = null;
let chosenPicture: Picture = 'A';
let showingPicture: Picture | undefined = 'A';
let pictureAttempt = 0;
let liveAttemptWithImage = 0;
let liveRequestsPending = 0;
let liveBatchHasImage = false;
let liveBatchHasError = false;
let creditsPending = false;
let outagePicture: Picture | undefined;
let outageAttempt = 0;
let outageTimeout: number | undefined;
let livePictures = false;

function clearOutage(): void {
  outagePicture = undefined;
  window.clearTimeout(outageTimeout);
  outageTimeout = undefined;
}

function pictureName(picture: Picture): string {
  if (!livePictures) return `Picture ${picture}`;
  return picture === 'A' ? 'USDA' : 'Mapbox';
}

function updateCredits(picture: Picture | undefined): void {
  usdaCredit.hidden = !livePictures || picture !== 'A';
  mapboxCredit.hidden = !livePictures || picture !== 'B';
  const center = map.getCenter();
  mapboxFeedback.href = `https://apps.mapbox.com/feedback/#/${center.lng}/${center.lat}/${map.getZoom()}`;
}

function setPictureTiles(picture: Picture | `${Picture}-outage`): void {
  const source = map.getSource(PICTURE_SOURCE_ID) as RasterTileSource;
  pictureAttempt += 1;
  liveRequestsPending = 0;
  if (picture === 'A' || picture === 'B') {
    showingPicture = picture;
    creditsPending = livePictures;
    map.setLayoutProperty(PICTURE_LAYER_ID, 'visibility', 'visible');
    // Keep old raster pixels and their successor's credit from appearing together.
    map.setPaintProperty(PICTURE_LAYER_ID, 'raster-opacity', livePictures ? 0 : 1);
    updateCredits(undefined);
  }
  source.setTiles([tileTemplate(picture)]);
}

function recoverPicture(failed: Picture): void {
  if (failed !== showingPicture) return;
  retryButton.disabled = false;
  if (failed !== chosenPicture) {
    showingPicture = undefined;
    creditsPending = false;
    map.setLayoutProperty(PICTURE_LAYER_ID, 'visibility', 'none');
    updateCredits(undefined);
    status.value = 'Both pictures unavailable · drawing stays open';
    return;
  }
  const fallback = failed === 'A' ? 'B' : 'A';
  setPictureTiles(fallback);
  status.value = `${pictureName(failed)} unavailable · showing ${livePictures ? pictureName(fallback) : fallback}`;
}

if (livePicturesEnabled) {
  maplibregl.addProtocol('proof-live', async (request, controller) => {
    const tile = new URL(request.url);
    const picture = tile.hostname === 'a' ? 'A' : 'B';
    const [, attempt, zoom, column, row] = tile.pathname.split('/');
    const stillCurrent = () => !controller.signal.aborted && Number(attempt) === pictureAttempt;
    if (!stillCurrent()) throw new DOMException('Tile belongs to an earlier picture', 'AbortError');
    if (liveRequestsPending === 0) {
      liveBatchHasImage = false;
      liveBatchHasError = false;
    }
    liveRequestsPending += 1;
    const providerUrl = picture === 'A'
      ? `https://${USDA_HOST}/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${zoom}/${row}/${column}`
      : `https://${MAPBOX_HOST}/styles/v1/mapbox/satellite-streets-v12/tiles/256/${zoom}/${column}/${row}?access_token=${encodeURIComponent(mapboxToken ?? '')}`;
    const tileRequest = new AbortController();
    const cancelTile = () => tileRequest.abort();
    controller.signal.addEventListener('abort', cancelTile, { once: true });
    const timeout = window.setTimeout(cancelTile, 8000);
    try {
      const response = await fetch(providerUrl, { signal: tileRequest.signal });
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/')) {
        throw new Error('Picture provider returned no image');
      }
      const data = await response.arrayBuffer();
      if (!stillCurrent()) throw new Error('Tile belongs to an earlier picture');
      liveAttemptWithImage = pictureAttempt;
      liveBatchHasImage = true;
      return {
        data,
        cacheControl: response.headers.get('Cache-Control') ?? undefined,
        expires: response.headers.get('Expires') ?? undefined,
      };
    } catch {
      if (stillCurrent()) liveBatchHasError = true;
      const error = new Error('Live picture tile unavailable');
      error.name = 'ProofPictureTileUnavailable';
      throw error;
    } finally {
      window.clearTimeout(timeout);
      controller.signal.removeEventListener('abort', cancelTile);
      if (Number(attempt) === pictureAttempt) {
        liveRequestsPending -= 1;
        if (liveRequestsPending === 0 && liveBatchHasError && !liveBatchHasImage) recoverPicture(picture);
      }
    }
  });
  map.on('sourcedata', (event) => {
    if (!creditsPending || event.sourceId !== PICTURE_SOURCE_ID || !event.isSourceLoaded
      || liveAttemptWithImage !== pictureAttempt || !showingPicture) return;
    creditsPending = false;
    updateCredits(showingPicture);
    map.setPaintProperty(PICTURE_LAYER_ID, 'raster-opacity', 1);
  });
}

const proof: ProofApi = {
  ready: false,
  startPolygon: () => draw.changeMode('draw_polygon'),
  startDirectSelect: () => {
    const feature = draw.getAll().features[0];
    if (!feature?.id) throw new Error('Draw a polygon before entering direct select');
    draw.changeMode('direct_select', { featureId: String(feature.id) });
  },
  switchPicture: (picture) => {
    if (!proof.ready) return;
    chosenPicture = picture;
    clearOutage();
    retryButton.disabled = true;
    setPictureTiles(picture);
    status.value = pictureName(picture);
  },
  getDraft: () => draw.getAll(),
  getMode: () => draw.getMode(),
  getLayerOrder: () => map.getStyle().layers.map((layer) => layer.id),
  getPictureTiles: () => getRasterTiles(map),
  getCamera: () => [
    ...map.getCenter().toArray(), map.getZoom(), map.getBearing(), map.getPitch(),
    ...Object.values(map.getPadding()),
  ],
  moveCamera: () => map.jumpTo({ center: [21, 12], zoom: 3.25, bearing: 16, pitch: 18 }),
  getRasterPixel: () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const mapCanvas = map.getCanvas();
    context.drawImage(mapCanvas, 40, mapCanvas.height - 40, 1, 1, 0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  },
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
    maxzoom: stagingProof ? 16 : 8,
  });
  map.addLayer({
    id: PICTURE_LAYER_ID,
    type: 'raster',
    source: PICTURE_SOURCE_ID,
    paint: { 'raster-fade-duration': 0 },
  });
  map.addControl(draw as unknown as maplibregl.IControl, 'top-right');

  const drawControl = map
    .getContainer()
    .querySelector<HTMLElement>('.maplibregl-ctrl-top-right .maplibregl-ctrl-group');
  if (!drawControl) throw new Error('MapLibre Draw control was not added');
  drawControl.id = DRAW_CONTROL_ID;

  proof.ready = true;
  livePicturesButton.hidden = !livePicturesEnabled;
  try {
    const savedDraft = sessionStorage.getItem(saveKey);
    if (savedDraft) {
      draw.set(JSON.parse(savedDraft));
      savedDraftJson = JSON.stringify(draw.getAll());
    }
    status.value = savedDraft ? 'Reopened synthetic draft · picture A' : 'Picture A';
  } catch {
    status.value = 'Saved synthetic draft could not be reopened · picture A';
  }
});

map.on('error', (event) => {
  const error = event.error;
  if (!error) return;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : 'Error';
  if (name === 'AbortError' || name === 'ProofPictureTileUnavailable') return;
  if ('status' in error && 'url' in error && typeof error.url === 'string') {
    const url = new URL(error.url);
    const failedFixture = url.origin === location.origin && (stagingProof
      ? url.pathname === '/api/maps-step0' && url.searchParams.get('drawingOutage') === '1'
      : /^\/tiles\/[AB]-outage\.png$/.test(url.pathname));
    if (failedFixture) {
      const failedPicture = outagePicture;
      if (failedPicture && url.searchParams.get('attempt') === String(outageAttempt)) {
        clearOutage();
        recoverPicture(failedPicture);
      }
      return;
    }
  }
  // eslint-disable-next-line no-console -- the spec fails on any console.error, so map errors must reach it
  console.error('MapLibre proof error:', name);
});

toolbar.querySelector('#start-polygon')!.addEventListener('click', () => {
  if (proof.ready) proof.startPolygon();
});
pictureAButton.addEventListener('click', () => proof.switchPicture('A'));
pictureBButton.addEventListener('click', () => proof.switchPicture('B'));
livePicturesButton.addEventListener('click', () => {
  if (!proof.ready || !livePicturesEnabled) return;
  livePictures = !livePictures;
  livePicturesButton.textContent = livePictures ? 'Use synthetic pictures' : 'Use live USDA and Mapbox';
  pictureAButton.textContent = pictureName('A');
  pictureBButton.textContent = pictureName('B');
  proof.switchPicture(chosenPicture);
});
map.on('moveend', () => {
  if (!mapboxCredit.hidden) updateCredits('B');
});
toolbar.querySelector('#fail-picture')!.addEventListener('click', () => {
  if (!proof.ready || outagePicture || !retryButton.disabled) return;
  outagePicture = chosenPicture;
  outageAttempt += 1;
  status.value = `Testing ${pictureName(chosenPicture)} outage`;
  outageTimeout = window.setTimeout(() => {
    clearOutage();
    retryButton.disabled = false;
    status.value = 'Outage check timed out · choose Retry';
  }, 12000);
  setPictureTiles(`${outagePicture}-outage`);
});
retryButton.addEventListener('click', () => proof.switchPicture(chosenPicture));
toolbar.querySelector('#save-draft')!.addEventListener('click', () => {
  if (!proof.ready) return;
  const draft = draw.getAll();
  if (draw.getMode() === 'draw_polygon' || !draft.features.length) {
    status.value = 'Finish a polygon before saving';
    return;
  }
  try {
    const draftJson = JSON.stringify(draft);
    sessionStorage.setItem(saveKey, draftJson);
    savedDraftJson = draftJson;
    status.value = 'Saved synthetic draft in this tab';
  } catch {
    status.value = 'This tab could not save the synthetic draft';
  }
});
toolbar.querySelector('#reopen-draft')!.addEventListener('click', () => {
  if (!proof.ready) return;
  const draft = draw.getAll();
  if (draw.getMode() === 'draw_polygon' || (draft.features.length && JSON.stringify(draft) !== savedDraftJson)) {
    status.value = 'Save or clear the current sketch before reopening';
    return;
  }
  location.reload();
});
