import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CircleDot,
  Droplets,
  Fence,
  MapPin,
  RadioTower,
  RotateCw,
  Sprout,
  TreePine,
  TrendingDown,
  UtilityPole,
  Waves,
  Wheat,
  Wind,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Marker, Popup } from 'react-map-gl/mapbox';
import { fieldObstacleName, fieldObstacleToGeoJsonFeature, isFieldObstacleKind } from '../../lib/fieldObstacles';
import type { FieldObstacle, FieldObstacleKind } from '../../types';

const OBSTACLE_ICONS: Record<FieldObstacleKind, LucideIcon> = {
  oil_well: CircleDot,
  windmill: Wind,
  tower: RadioTower,
  tree_line: TreePine,
  power_line: Zap,
  waterway: Waves,
  other: AlertTriangle,
  field_entrance: MapPin,
  washout: TrendingDown,
  pole: UtilityPole,
  garden: Sprout,
  well: Droplets,
  pivot: RotateCw,
  sensitive_crop: Wheat,
  gate: Fence,
};

interface FieldObstacleLayerProps {
  obstacles: FieldObstacle[];
  interactive?: boolean;
}

export default function FieldObstacleLayer({
  obstacles,
  interactive = true,
}: FieldObstacleLayerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const markers = useMemo(
    () => obstacles.flatMap((obstacle) => {
      const feature = fieldObstacleToGeoJsonFeature(obstacle);
      return feature ? [{ obstacle, feature }] : [];
    }),
    [obstacles],
  );
  const selected = markers.find(({ obstacle }) => obstacle.id === selectedId) ?? null;

  if (markers.length === 0) return null;

  return (
    <>
      {markers.map(({ obstacle, feature }) => {
        const Icon = isFieldObstacleKind(obstacle.kind) ? OBSTACLE_ICONS[obstacle.kind] : MapPin;
        return (
          <Marker
            key={obstacle.id}
            longitude={feature.geometry.coordinates[0]}
            latitude={feature.geometry.coordinates[1]}
            anchor="center"
            style={{ pointerEvents: interactive ? 'auto' : 'none' }}
            onClick={interactive ? (event) => {
              event.originalEvent.stopPropagation();
              setSelectedId(obstacle.id);
            } : undefined}
          >
            <button
              type="button"
              disabled={!interactive}
              title={feature.properties.title}
              aria-label={feature.properties.title}
              className="flex h-11 w-11 items-center justify-center rounded-full disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-crx-green"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-red-600 text-white shadow-md">
                {obstacle.kind === 'field_entrance' && obstacle.entrance_number
                  ? <span aria-hidden="true" className="text-[10px] font-bold">{obstacle.entrance_number}</span>
                  : <Icon aria-hidden="true" className="h-3.5 w-3.5" />}
              </span>
            </button>
          </Marker>
        );
      })}

      {interactive && selected && (
        <Popup
          longitude={selected.feature.geometry.coordinates[0]}
          latitude={selected.feature.geometry.coordinates[1]}
          anchor="bottom"
          offset={16}
          closeButton
          closeOnClick={false}
          onClose={() => setSelectedId(null)}
        >
          <div className="space-y-0.5 px-1 py-1 text-xs">
            <p className="font-semibold text-nav-dark">{selected.feature.properties.label}</p>
            <p className="text-secondary">{fieldObstacleName(selected.obstacle)}</p>
          </div>
        </Popup>
      )}
    </>
  );
}
