import { createContext } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

export const MapContainerContext = createContext<MapLibreMap | null>(null);
