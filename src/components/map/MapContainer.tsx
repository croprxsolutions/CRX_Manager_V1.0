import { useState, useCallback, useRef, type ReactNode } from 'react';
import Map, { AttributionControl, NavigationControl, type MapRef } from 'react-map-gl/maplibre';
import type { MapLibreEvent, Map as MapLibreMap } from 'maplibre-gl';
import './maplibreSetup';
import MapPictureNotice from './MapPictureNotice';
import { MapContainerContext } from './MapContainerContext';
import { useMapPicture } from './useMapPicture';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const DEFAULT_CENTER: [number, number] = [-89.0, 40.0]; // Central Illinois
const DEFAULT_ZOOM = 7;
const MAPBOX_ATTRIBUTION = '<a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener noreferrer">© Mapbox</a> © OpenStreetMap';
const USDA_ATTRIBUTION = 'Imagery: USGS The National Map';

interface MapContainerProps {
  center?: [number, number]; // [lng, lat]
  zoom?: number;
  className?: string;
  children?: ReactNode;
  interactive?: boolean;
  onMapLoad?: (map: MapRef) => void;
}

export default function MapContainer({
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  className = 'h-[400px] w-full rounded-lg overflow-hidden',
  children,
  interactive = true,
  onMapLoad,
}: MapContainerProps) {
  const mapPicture = useMapPicture({ token: MAPBOX_TOKEN });
  const attachPictureMap = mapPicture.onMapLoad;
  const handlePictureError = mapPicture.onError;
  const [viewState, setViewState] = useState({
    longitude: center[0],
    latitude: center[1],
    zoom,
  });
  const mapRef = useRef<MapRef | null>(null);
  // Our own context, not react-map-gl's: lazily loaded children (Customer Detail pins) did not see
  // react-map-gl's context under the dev server. Filled when the map exists, not after tiles load.
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const setMapRef = useCallback((ref: MapRef | null) => {
    mapRef.current = ref;
    setMapInstance(ref?.getMap() ?? null);
    if (ref) attachPictureMap(ref.getMap());
  }, [attachPictureMap]);

  const handleLoad = useCallback(
    (evt: MapLibreEvent) => {
      attachPictureMap(evt.target);
      if (mapRef.current) onMapLoad?.(mapRef.current);
    },
    [onMapLoad, attachPictureMap]
  );
  const handleError = useCallback((evt: { sourceId?: string; error?: { status?: number; statusCode?: number } }) => {
    handlePictureError(evt);
  }, [handlePictureError]);

  return (
    <div className={`${className} relative`}>
      <Map
        ref={setMapRef}
        {...viewState}
        onMove={(evt) => setViewState(evt.viewState)}
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
        <MapContainerContext.Provider value={mapInstance}>
          {children}
        </MapContainerContext.Provider>
      </Map>
      <MapPictureNotice message={mapPicture.notice} />
    </div>
  );
}
