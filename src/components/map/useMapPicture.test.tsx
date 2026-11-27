import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAP_PICTURE_STORAGE_KEY } from './mapPreferences';
import { MAPBOX_PICTURE_LAYER_ID, mapboxTileTemplate, USDA_PICTURE_LAYER_ID } from './mapPicture';
import { useMapPicture } from './useMapPicture';

function fakeMap(token: string) {
  const source = {
    tiles: [mapboxTileTemplate('satellite', token)],
    setTiles: vi.fn(),
  };
  return {
    source,
    map: {
      getLayer: vi.fn((id: string) => id),
      getSource: vi.fn(() => source),
      isStyleLoaded: vi.fn(() => true),
      setLayoutProperty: vi.fn(),
    },
  };
}

describe('useMapPicture', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('shows USDA without changing the saved choice when no Mapbox token exists', () => {
    window.localStorage.setItem(MAP_PICTURE_STORAGE_KEY, 'roads');
    const { result } = renderHook(() => useMapPicture({ token: '' }));

    expect(result.current.displayedPicture).toBe('usda');
    expect(result.current.notice).toBe('Mapbox picture unavailable — showing USDA');
    expect(result.current.mapboxAvailable).toBe(false);
    act(() => result.current.selectPicture('roads'));
    expect(window.localStorage.getItem(MAP_PICTURE_STORAGE_KEY)).toBe('roads');
    expect(result.current.displayedPicture).toBe('usda');
  });

  it('falls back after three Mapbox HTTP errors without saving the fallback', () => {
    const token = 'pk.test-not-a-real-token';
    const { result } = renderHook(() => useMapPicture({ token }));
    const { map } = fakeMap(token);
    act(() => result.current.onMapLoad(map as never));
    const mapboxError = { sourceId: 'crx-mapbox-picture', error: { status: 401 } };

    act(() => {
      result.current.onError(mapboxError);
      result.current.onError(mapboxError);
      result.current.onError(mapboxError);
    });

    expect(result.current.displayedPicture).toBe('usda');
    expect(result.current.notice).toBe('Mapbox picture unavailable — showing USDA');
    expect(window.localStorage.getItem(MAP_PICTURE_STORAGE_KEY)).toBeNull();
    expect(map.setLayoutProperty).toHaveBeenLastCalledWith(USDA_PICTURE_LAYER_ID, 'visibility', 'visible');
    expect(map.setLayoutProperty).toHaveBeenCalledWith(MAPBOX_PICTURE_LAYER_ID, 'visibility', 'none');
  });

  it('falls back on Mapbox errors that arrive before the map load event', () => {
    const token = 'pk.test-not-a-real-token';
    const { result } = renderHook(() => useMapPicture({ token }));
    const mapboxError = { sourceId: 'crx-mapbox-picture', error: { status: 401 } };
    act(() => {
      result.current.onError(mapboxError);
      result.current.onError(mapboxError);
      result.current.onError(mapboxError);
    });
    expect(result.current.displayedPicture).toBe('usda');
  });

  it('still falls back when Mapbox starts failing long after load', () => {
    vi.useFakeTimers();
    try {
      const token = 'pk.test-not-a-real-token';
      const { result } = renderHook(() => useMapPicture({ token }));
      act(() => result.current.onMapLoad(fakeMap(token).map as never));
      vi.advanceTimersByTime(60_000);
      const mapboxError = { sourceId: 'crx-mapbox-picture', error: { status: 503 } };
      act(() => {
        result.current.onError(mapboxError);
        result.current.onError(mapboxError);
        result.current.onError(mapboxError);
      });
      expect(result.current.displayedPicture).toBe('usda');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores late errors from the picture that is no longer shown', () => {
    const token = 'pk.test-not-a-real-token';
    const { result } = renderHook(() => useMapPicture({ token }));
    act(() => result.current.onMapLoad(fakeMap(token).map as never));
    act(() => result.current.onError({ sourceId: 'crx-usda-picture', error: { status: 404 } }));
    expect(result.current.notice).toBeNull();

    act(() => result.current.selectPicture('usda'));
    const mapboxError = { sourceId: 'crx-mapbox-picture', error: { status: 401 } };
    act(() => {
      result.current.onError(mapboxError);
      result.current.onError(mapboxError);
      result.current.onError(mapboxError);
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.displayedPicture).toBe('usda');
  });

  it('shows the USDA notice only after 3 USDA tile errors', () => {
    const { result } = renderHook(() => useMapPicture({ token: '', baseLayer: 'usda' }));
    const usdaError = { sourceId: 'crx-usda-picture', error: { status: 503 } };
    act(() => result.current.onError(usdaError));
    expect(result.current.notice).toBeNull();
    act(() => {
      result.current.onError(usdaError);
      result.current.onError(usdaError);
    });
    expect(result.current.notice).not.toBeNull();
  });

  it('ignores Mapbox errors arriving in the same tick as a switch to USDA', () => {
    const token = 'pk.test-not-a-real-token';
    const { result } = renderHook(() => useMapPicture({ token }));
    act(() => result.current.onMapLoad(fakeMap(token).map as never));
    const mapboxError = { sourceId: 'crx-mapbox-picture', error: { status: 401 } };
    act(() => {
      result.current.selectPicture('usda');
      result.current.onError(mapboxError);
      result.current.onError(mapboxError);
      result.current.onError(mapboxError);
    });
    expect(result.current.notice).toBeNull();
  });

  it('ignores late errors from a Mapbox style the user switched away from', () => {
    const token = 'pk.test-not-a-real-token';
    const { result } = renderHook(() => useMapPicture({ token }));
    act(() => result.current.onMapLoad(fakeMap(token).map as never));
    act(() => result.current.selectPicture('roads'));
    const oldStyleError = {
      sourceId: 'crx-mapbox-picture',
      error: { status: 503, url: 'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/1/1/1@2x' },
    };
    act(() => {
      result.current.onError(oldStyleError);
      result.current.onError(oldStyleError);
      result.current.onError(oldStyleError);
    });
    expect(result.current.displayedPicture).toBe('roads');
  });

  it('applies a picture chosen before the style is ready once the style arrives', () => {
    const token = 'pk.test-not-a-real-token';
    const { result } = renderHook(() => useMapPicture({ token }));
    const { map } = fakeMap(token);
    let styleReady = false;
    let onStyle: (() => void) | undefined;
    map.getLayer = vi.fn((id: string) => (styleReady ? id : undefined)) as never;
    const mapWithOnce = { ...map, once: vi.fn((_event: string, callback: () => void) => { onStyle = callback; }) };
    act(() => result.current.onMapLoad(mapWithOnce as never));
    act(() => result.current.selectPicture('usda'));
    expect(map.setLayoutProperty).not.toHaveBeenCalled();

    styleReady = true;
    act(() => onStyle?.());
    expect(map.setLayoutProperty).toHaveBeenCalledWith(USDA_PICTURE_LAYER_ID, 'visibility', 'visible');
  });

  it('saves an explicit picture choice and swaps Mapbox styles in the same source', () => {
    const token = 'pk.test-not-a-real-token';
    const { result } = renderHook(() => useMapPicture({ token }));
    const { map, source } = fakeMap(token);
    act(() => result.current.onMapLoad(map as never));
    act(() => result.current.selectPicture('roads'));

    expect(window.localStorage.getItem(MAP_PICTURE_STORAGE_KEY)).toBe('roads');
    expect(source.setTiles).toHaveBeenCalledWith([mapboxTileTemplate('roads', token)]);
    expect(result.current.displayedPicture).toBe('roads');
  });
});
