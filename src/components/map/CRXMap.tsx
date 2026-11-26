import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import Map, { AttributionControl, NavigationControl, type MapRef } from 'react-map-gl/maplibre';
import type { MapLibreEvent } from 'maplibre-gl';
import './maplibreSetup';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import LayerToggle from './LayerToggle';
import LocateMe from './LocateMe';
import MapPictureNotice from './MapPictureNotice';
import { type MapPicture } from './mapPreferences';
import { useMapPicture } from './useMapPicture';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const MAPBOX_ATTRIBUTION = '<a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener noreferrer">© Mapbox</a> © OpenStreetMap';
const USDA_ATTRIBUTION = 'Imagery: USGS The National Map';

export type BaseLayerType = MapPicture;

export interface CRXMapProps {
  center?: [number, number];
  zoom?: number;
  baseLayer?: BaseLayerType;
  interactive?: boolean;
  showLayerToggle?: boolean;
  showLocateMe?: boolean;
  printMode?: boolean;
  bounds?: [number, number, number, number] | null; // [minLng, minLat, maxLng, maxLat]
  boundsOptions?: { padding?: number; maxZoom?: number };
  className?: string;
  children?: ReactNode;
  onMapLoad?: (map: MapRef) => void;
  /** Fired after navigation settles so consumers can cheaply refresh viewport-dependent work. */
  onMapMoveEnd?: (center: [number, number]) => void;
  /** Fired when the map surface is clicked. Marker/layer handlers may stop propagation. */
  onMapClick?: (longitude: number, latitude: number) => void;
}

const DEFAULT_CENTER: [number, number] = [-89.0, 40.0];
const DEFAULT_ZOOM = 7;

export default function CRXMap({
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  baseLayer = 'satellite',
  interactive = true,
  showLayerToggle = false,
  showLocateMe = false,
  bounds = null,
  boundsOptions = { padding: 60, maxZoom: 16 },
  printMode = false,
  className = 'h-[500px] w-full',
  children,
  onMapLoad,
  onMapMoveEnd,
  onMapClick,
}: CRXMapProps) {
  const [viewState, setViewState] = useState({
    longitude: center[0],
    latitude: center[1],
    zoom,
  });
  const mapPicture = useMapPicture({ token: MAPBOX_TOKEN, baseLayer, printMode });
  const attachPictureMap = mapPicture.onMapLoad;
  const handlePictureError = mapPicture.onError;

  const mapRef = useRef<MapRef | null>(null);
  const setMapRef = useCallback((ref: MapRef | null) => {
    mapRef.current = ref;
    if (ref) attachPictureMap(ref.getMap());
  }, [attachPictureMap]);

  // Map load lifecycle: show a spinner until the first load, and a retryable error state if
  // the map never loads. Transient tile/network errors AFTER a successful load are ignored.
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const loadedRef = useRef(false);

  const handleLoad = useCallback(
    (evt: MapLibreEvent) => {
      loadedRef.current = true;
      setMapStatus('ready');
      attachPictureMap(evt.target);
      if (mapRef.current) onMapLoad?.(mapRef.current);
      // If bounds were set before map loaded, apply now
      if (bounds) {
        evt.target.fitBounds(
          [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
          { padding: boundsOptions?.padding ?? 60, maxZoom: boundsOptions?.maxZoom ?? 16 }
        );
      }
    },
    [onMapLoad, bounds, boundsOptions, attachPictureMap]
  );

  const handleError = useCallback((evt?: { sourceId?: string; tile?: unknown; error?: { status?: number; statusCode?: number } }) => {
    if (evt) handlePictureError(evt);
    if (loadedRef.current) return;
    // Ignore transient tile/source-scoped errors before first load (a flaky rural connection can
    // drop a tile while the map is still coming up). Only a fatal style/auth load failure — which
    // is NOT source-scoped — should surface the retry overlay; a later successful 'load' clears it.
    if (evt && (evt.sourceId || evt.tile)) return;
    setMapStatus('error');
  }, [handlePictureError]);

  const handleRetry = useCallback(() => {
    loadedRef.current = false;
    setMapStatus('loading');
    setReloadKey((k) => k + 1); // remount the Map to retry the style/tile load
  }, []);

  // Re-fit bounds when they change after initial load
  useEffect(() => {
    if (!bounds || !mapRef.current) return;
    mapRef.current.fitBounds(
      [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
      { padding: boundsOptions?.padding ?? 60, maxZoom: boundsOptions?.maxZoom ?? 16 }
    );
  }, [bounds, boundsOptions]);

  const handleLocate = useCallback((longitude: number, latitude: number) => {
    setViewState((prev) => ({ ...prev, longitude, latitude, zoom: 15 }));
  }, []);

  const handleMoveEnd = useCallback((evt: { viewState: { longitude: number; latitude: number } }) => {
    onMapMoveEnd?.([evt.viewState.longitude, evt.viewState.latitude]);
  }, [onMapMoveEnd]);

  return (
    <div className={`${className} relative rounded-lg overflow-hidden`}>
      <Map
        key={reloadKey}
        ref={setMapRef}
        {...viewState}
        onMove={(evt) => setViewState(evt.viewState)}
        onMoveEnd={handleMoveEnd}
        onClick={(evt) => onMapClick?.(evt.lngLat.lng, evt.lngLat.lat)}
        mapStyle={mapPicture.mapStyle}
        style={{ width: '100%', height: '100%' }}
        interactive={interactive}
        attributionControl={false}
        onLoad={handleLoad}
        onError={handleError as unknown as (e: unknown) => void}
      >
        <AttributionControl
          key={mapPicture.displayedPicture}
          position="bottom-right"
          compact={false}
          customAttribution={mapPicture.displayedPicture === 'usda' ? USDA_ATTRIBUTION : MAPBOX_ATTRIBUTION}
        />
        {interactive && <NavigationControl position="top-right" />}
        {showLocateMe && <LocateMe onLocate={handleLocate} />}
        {children}
      </Map>
      {showLayerToggle && !printMode && (
        <LayerToggle
          activeLayer={mapPicture.displayedPicture}
          mapboxAvailable={mapPicture.mapboxAvailable}
          onChange={mapPicture.selectPicture}
        />
      )}
      <MapPictureNotice message={mapPicture.notice} />
      {mapStatus === 'loading' && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-gray-100/80 pointer-events-none">
          <div className="flex items-center gap-2 text-sm text-secondary">
            <Loader2 className="w-5 h-5 animate-spin text-crx-green" />
            Loading map...
          </div>
        </div>
      )}
      {mapStatus === 'error' && (
        <button
          type="button"
          onClick={handleRetry}
          className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-gray-100 px-4 text-center"
        >
          <AlertTriangle className="w-6 h-6 text-amber-500" />
          <p className="text-sm font-medium text-gray-600">Map could not load</p>
          <span className="flex items-center gap-1.5 text-xs font-medium text-crx-green">
            <RefreshCw className="w-3.5 h-3.5" />
            Tap to retry
          </span>
        </button>
      )}
    </div>
  );
}
