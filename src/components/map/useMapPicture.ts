import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type { MapPicture } from './mapPreferences';
import { readMapPicturePreference, saveMapPicturePreference } from './mapPreferences';
import { applyDisplayedPicture, createBlankMapStyle, isMapboxHttpTileError, mapboxTileTemplate, USDA_PICTURE_LAYER_ID } from './mapPicture';

const MAPBOX_FALLBACK_NOTICE = 'Mapbox picture unavailable — showing USDA';
const USDA_UNAVAILABLE_NOTICE = 'USDA aerial unavailable — field outlines remain visible';
const FALLBACK_WINDOW_MS = 10_000;

interface UseMapPictureOptions {
  token?: string;
  baseLayer?: MapPicture;
  printMode?: boolean;
}

interface MapPictureErrorEvent {
  sourceId?: string;
  error?: { status?: number; statusCode?: number; url?: string };
}

interface UseMapPictureResult {
  mapStyle: StyleSpecification;
  displayedPicture: MapPicture;
  mapboxAvailable: boolean;
  notice: string | null;
  onMapLoad: (map: MapLibreMap) => void;
  onError: (event: MapPictureErrorEvent) => void;
  selectPicture: (picture: MapPicture) => void;
}

/** Adds an error now; true once 3 fall inside the rolling window. Mutates the list in place. */
function recordRecentError(times: number[]): boolean {
  const now = Date.now();
  const recent = times.filter((at) => now - at <= FALLBACK_WINDOW_MS);
  recent.push(now);
  times.splice(0, times.length, ...recent);
  return recent.length >= 3;
}

export function useMapPicture({ token, baseLayer = 'satellite', printMode = false }: UseMapPictureOptions): UseMapPictureResult {
  const mapboxToken = token || undefined;
  const mapboxAvailable = !!mapboxToken;
  const [savedChoice, setSavedChoice] = useState(() => readMapPicturePreference(baseLayer));
  const requestedPicture = printMode ? 'roads' : savedChoice;
  const initialPicture = mapboxAvailable ? requestedPicture : 'usda';
  const [displayedPicture, setDisplayedPicture] = useState<MapPicture>(initialPicture);
  const [notice, setNotice] = useState<string | null>(
    !mapboxAvailable && requestedPicture !== 'usda' ? MAPBOX_FALLBACK_NOTICE : null,
  );
  const [mapStyle] = useState(() => createBlankMapStyle(mapboxToken, initialPicture));
  const mapRef = useRef<MapLibreMap | null>(null);
  // The handlers read the picture on screen now, so a late error from a hidden source is ignored.
  const displayedRef = useRef<MapPicture>(initialPicture);
  const mapboxErrorsRef = useRef<number[]>([]);
  const usdaErrorsRef = useRef<number[]>([]);
  const fallbackUsedRef = useRef(false);

  // Called when the map is created and again on load. A choice made before the style is ready is
  // applied as soon as the style arrives, without waiting for picture tiles (which may hang).
  const onMapLoad = useCallback((map: MapLibreMap) => {
    mapRef.current = map;
    const apply = () => applyDisplayedPicture(map, displayedRef.current, mapboxToken);
    if (map.getLayer(USDA_PICTURE_LAYER_ID)) apply();
    else map.once('styledata', apply);
  }, [mapboxToken]);

  const onError = useCallback((event: MapPictureErrorEvent) => {
    if (event.sourceId === 'crx-usda-picture') {
      // Same 3-in-10 s rule as Mapbox, so one dropped tile does not leave a lasting notice.
      if (displayedRef.current === 'usda' && recordRecentError(usdaErrorsRef.current)) setNotice(USDA_UNAVAILABLE_NOTICE);
      return;
    }
    if (!isMapboxHttpTileError(event)) return;
    // Any 3 Mapbox errors inside a rolling 10 s window, before or after load, while Mapbox is shown.
    if (displayedRef.current === 'usda' || fallbackUsedRef.current) return;
    // A late error from a Mapbox style the user already switched away from does not count.
    const url = event.error?.url;
    if (url && !url.startsWith(mapboxTileTemplate(displayedRef.current, '').split('/tiles/')[0] + '/')) return;
    if (recordRecentError(mapboxErrorsRef.current)) {
      fallbackUsedRef.current = true;
      displayedRef.current = 'usda';
      setDisplayedPicture('usda');
      setNotice(MAPBOX_FALLBACK_NOTICE);
    }
  }, []);

  const selectPicture = useCallback((picture: MapPicture) => {
    if (printMode || (picture !== 'usda' && !mapboxAvailable)) return;
    setSavedChoice(picture);
    saveMapPicturePreference(picture);
    displayedRef.current = picture;
    setDisplayedPicture(picture);
    setNotice(null);
    mapboxErrorsRef.current = [];
    usdaErrorsRef.current = [];
    fallbackUsedRef.current = false;
  }, [mapboxAvailable, printMode]);

  useEffect(() => {
    displayedRef.current = displayedPicture;
    if (mapRef.current) applyDisplayedPicture(mapRef.current, displayedPicture, mapboxToken);
  }, [displayedPicture, mapboxToken]);

  return {
    mapStyle,
    displayedPicture,
    mapboxAvailable,
    notice,
    onMapLoad,
    onError,
    selectPicture,
  };
}
