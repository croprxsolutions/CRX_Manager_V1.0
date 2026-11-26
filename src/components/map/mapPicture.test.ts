import { describe, expect, it, vi } from 'vitest';
import {
  applyDisplayedPicture,
  createBlankMapStyle,
  isMapboxHttpTileError,
  MAPBOX_PICTURE_LAYER_ID,
  MAPBOX_PICTURE_SOURCE_ID,
  mapboxTileTemplate,
  USDA_PICTURE_LAYER_ID,
  USDA_PICTURE_SOURCE_ID,
  USDA_TILE_TEMPLATE,
} from './mapPicture';

describe('local map picture style', () => {
  it('starts with a local blank style and native provider tile sizes', () => {
    const style = createBlankMapStyle('pk.test-not-a-real-token', 'satellite');
    expect(style.version).toBe(8);
    expect(style.glyphs).toBeUndefined();
    expect(style.sources?.[MAPBOX_PICTURE_SOURCE_ID]).toMatchObject({
      type: 'raster',
      tileSize: 512,
      tiles: [expect.stringMatching(/satellite-streets-v12\/tiles\/512/)],
    });
    expect(style.sources?.[USDA_PICTURE_SOURCE_ID]).toMatchObject({
      type: 'raster',
      tileSize: 256,
      maxzoom: 16,
      tiles: [USDA_TILE_TEMPLATE],
    });
    expect(style.layers?.map((layer) => layer.id)).toEqual([
      'crx-map-background', MAPBOX_PICTURE_LAYER_ID, USDA_PICTURE_LAYER_ID,
    ]);
  });

  it('uses USDA without creating a Mapbox source when the token is missing', () => {
    const style = createBlankMapStyle(undefined, 'usda');
    expect(style.sources?.[MAPBOX_PICTURE_SOURCE_ID]).toBeUndefined();
    expect(style.sources?.[USDA_PICTURE_SOURCE_ID]).toBeDefined();
    expect(style.layers?.at(-1)).toMatchObject({
      id: USDA_PICTURE_LAYER_ID,
      layout: { visibility: 'visible' },
    });
  });

  it('uses the required Mapbox style mapping and token query', () => {
    expect(mapboxTileTemplate('roads', 'pk.test-not-a-real-token')).toBe(
      'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=pk.test-not-a-real-token',
    );
    expect(mapboxTileTemplate('terrain', 'test')).toContain('/outdoors-v12/');
  });

  it('changes picture visibility without replacing the map or sources', () => {
    const map = {
      isStyleLoaded: vi.fn(() => true),
      getLayer: vi.fn((id: string) => id),
      getSource: vi.fn(() => ({
        tiles: [mapboxTileTemplate('satellite', 'test')],
        setTiles: vi.fn(),
      })),
      setLayoutProperty: vi.fn(),
    };
    applyDisplayedPicture(map as never, 'usda', 'test');
    expect(map.setLayoutProperty).toHaveBeenNthCalledWith(1, MAPBOX_PICTURE_LAYER_ID, 'visibility', 'none');
    expect(map.setLayoutProperty).toHaveBeenNthCalledWith(2, USDA_PICTURE_LAYER_ID, 'visibility', 'visible');
  });

  it('applies visibility while source tiles are still loading when picture layers exist', () => {
    const mapboxSource = {
      tiles: [mapboxTileTemplate('satellite', 'test')],
      setTiles: vi.fn(),
    };
    const map = {
      isStyleLoaded: vi.fn(() => false),
      getLayer: vi.fn((id: string) => id === MAPBOX_PICTURE_LAYER_ID || id === USDA_PICTURE_LAYER_ID ? { id } : undefined),
      getSource: vi.fn(() => mapboxSource),
      setLayoutProperty: vi.fn(),
    };
    applyDisplayedPicture(map as never, 'usda', undefined);
    expect(map.setLayoutProperty).toHaveBeenNthCalledWith(1, MAPBOX_PICTURE_LAYER_ID, 'visibility', 'none');
    expect(map.setLayoutProperty).toHaveBeenNthCalledWith(2, USDA_PICTURE_LAYER_ID, 'visibility', 'visible');
  });
});

describe('Mapbox picture error classification', () => {
  it('counts HTTP errors only for the Mapbox picture source', () => {
    expect(isMapboxHttpTileError({ sourceId: MAPBOX_PICTURE_SOURCE_ID, error: { status: 401 } })).toBe(true);
    expect(isMapboxHttpTileError({ sourceId: MAPBOX_PICTURE_SOURCE_ID, error: { status: 503 } })).toBe(true);
    expect(isMapboxHttpTileError({ sourceId: USDA_PICTURE_SOURCE_ID, error: { status: 401 } })).toBe(false);
    expect(isMapboxHttpTileError({ sourceId: MAPBOX_PICTURE_SOURCE_ID, error: new Error('network') })).toBe(false);
  });
});
