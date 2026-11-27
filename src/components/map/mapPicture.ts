import type { Map as MapLibreMap, RasterTileSource, StyleSpecification } from 'maplibre-gl';
import type { MapPicture } from './mapPreferences';

export const MAPBOX_PICTURE_SOURCE_ID = 'crx-mapbox-picture';
export const MAPBOX_PICTURE_LAYER_ID = 'crx-mapbox-picture-layer';
export const USDA_PICTURE_SOURCE_ID = 'crx-usda-picture';
export const USDA_PICTURE_LAYER_ID = 'crx-usda-picture-layer';

export const USDA_TILE_TEMPLATE =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';

export type MapboxPicture = Exclude<MapPicture, 'usda'>;

const MAPBOX_STYLES: Record<MapboxPicture, string> = {
  satellite: 'satellite-streets-v12',
  roads: 'streets-v12',
  terrain: 'outdoors-v12',
};

export function mapboxTileTemplate(picture: MapboxPicture, token: string): string {
  return `https://api.mapbox.com/styles/v1/mapbox/${MAPBOX_STYLES[picture]}/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`;
}

export function createBlankMapStyle(token: string | undefined, displayedPicture: MapPicture): StyleSpecification {
  const sources: StyleSpecification['sources'] = {
    [USDA_PICTURE_SOURCE_ID]: {
      type: 'raster',
      tiles: [USDA_TILE_TEMPLATE],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 16,
    },
  };
  const layers: StyleSpecification['layers'] = [
    {
      id: 'crx-map-background',
      type: 'background',
      paint: { 'background-color': '#e9e9e9' },
    },
  ];

  if (token) {
    sources[MAPBOX_PICTURE_SOURCE_ID] = {
      type: 'raster',
      tiles: [mapboxTileTemplate(displayedPicture === 'usda' ? 'satellite' : displayedPicture, token)],
      tileSize: 512,
      minzoom: 0,
      maxzoom: 22,
    };
    layers.push({
      id: MAPBOX_PICTURE_LAYER_ID,
      type: 'raster',
      source: MAPBOX_PICTURE_SOURCE_ID,
      layout: { visibility: displayedPicture === 'usda' ? 'none' : 'visible' },
    });
  }

  layers.push({
    id: USDA_PICTURE_LAYER_ID,
    type: 'raster',
    source: USDA_PICTURE_SOURCE_ID,
    layout: { visibility: displayedPicture === 'usda' ? 'visible' : 'none' },
  });

  return { version: 8, sources, layers };
}

export function applyDisplayedPicture(
  map: MapLibreMap,
  picture: MapPicture,
  token: string | undefined,
): void {
  const showUsda = picture === 'usda' || !token;
  const mapboxLayer = map.getLayer(MAPBOX_PICTURE_LAYER_ID);
  const usdaLayer = map.getLayer(USDA_PICTURE_LAYER_ID);
  const source = map.getSource(MAPBOX_PICTURE_SOURCE_ID) as RasterTileSource | undefined;
  if (!usdaLayer || (!showUsda && (!mapboxLayer || !source))) return;

  if (!showUsda && token && source) {
    const tile = mapboxTileTemplate(picture, token);
    // `tiles` is unset until the source finishes loading; the map may call this right after creation.
    if (source.tiles?.[0] !== tile) source.setTiles([tile]);
  }
  if (mapboxLayer) {
    map.setLayoutProperty(MAPBOX_PICTURE_LAYER_ID, 'visibility', showUsda ? 'none' : 'visible');
  }
  map.setLayoutProperty(USDA_PICTURE_LAYER_ID, 'visibility', showUsda ? 'visible' : 'none');
}

export function isMapboxHttpTileError(event: {
  sourceId?: string;
  error?: unknown;
}): boolean {
  if (event.sourceId !== MAPBOX_PICTURE_SOURCE_ID) return false;
  if (!event.error || typeof event.error !== 'object') return false;
  const error = event.error as { status?: unknown; statusCode?: unknown };
  const status = error.status ?? error.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600;
}
