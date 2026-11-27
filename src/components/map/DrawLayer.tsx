import { useCallback, useEffect, useMemo, useRef } from 'react';
import area from '@turf/area';
import centroid from '@turf/centroid';
import DrawControl from './DrawControl';
import type { Feature, Polygon } from 'geojson';

export interface DrawnPolygon {
  drawId: string;
  polygon: Feature<Polygon>;
  acres: number;
  label: string;
}

interface DrawLayerProps {
  /** Multi-polygon mode */
  initialPolygons?: DrawnPolygon[];
  onPolygonsChange?: (polygons: DrawnPolygon[]) => void;
  /** Lets a field with no saved boundary clear its only in-session part. */
  allowRemoveSinglePart?: boolean;
  /** Temporarily prevents boundary editing without unmounting Mapbox Draw. */
  disabled?: boolean;
  /** Reports whether the user is currently placing boundary vertices. */
  onDrawingStateChange?: (isDrawing: boolean) => void;
  /** Legacy single-polygon mode (backward compat) */
  initialGeoJSON?: Feature<Polygon> | null;
  onBoundaryChange?: (boundary: Feature<Polygon>, acres: number, center: [number, number]) => void;
  onBoundaryDelete?: () => void;
}

/** Wrapper around DrawControl that auto-calculates acreage and centroid from drawn polygons */
export default function DrawLayer({
  initialPolygons,
  onPolygonsChange,
  allowRemoveSinglePart = false,
  disabled = false,
  onDrawingStateChange,
  initialGeoJSON,
  onBoundaryChange,
  onBoundaryDelete,
}: DrawLayerProps) {
  const isMultiMode = !!onPolygonsChange;

  // Determine initial features for DrawControl
  const initialFeatures = useMemo(
    () => initialPolygons && initialPolygons.length > 0
      ? initialPolygons.map((p) => p.polygon)
      : initialGeoJSON
      ? [initialGeoJSON]
      : undefined,
    [initialGeoJSON, initialPolygons],
  );

  // Draw can fire several events before the parent re-renders; start each from the last emitted list.
  const latestPolygonsRef = useRef(initialPolygons);
  useEffect(() => { latestPolygonsRef.current = initialPolygons; }, [initialPolygons]);
  const emitPolygons = useCallback((next: DrawnPolygon[]) => {
    latestPolygonsRef.current = next;
    onPolygonsChange?.(next);
  }, [onPolygonsChange]);

  const handleCreate = useCallback(
    (feature: GeoJSON.Feature) => {
      if (feature.geometry.type !== 'Polygon') return;

      const polygon = feature as Feature<Polygon>;
      const sqMeters = area(polygon);
      const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
      const center = centroid(polygon);
      const [lng, lat] = center.geometry.coordinates;

      // Multi-polygon mode: append to list
      const current = latestPolygonsRef.current;
      if (isMultiMode && current) {
        const newPoly: DrawnPolygon = {
          drawId: (feature.id as string) || crypto.randomUUID(),
          polygon,
          acres,
          label: `Polygon ${current.length + 1}`,
        };
        emitPolygons([...current, newPoly]);
        return;
      }

      // Legacy single-polygon mode
      onBoundaryChange?.(polygon, acres, [lng, lat]);
    },
    [isMultiMode, emitPolygons, onBoundaryChange]
  );

  const handleUpdate = useCallback(
    (features: GeoJSON.Feature[]) => {
      const polygons = features.filter(
        (feature): feature is Feature<Polygon> => feature.geometry.type === 'Polygon',
      );
      if (polygons.length === 0) return;

      const current = latestPolygonsRef.current;
      if (isMultiMode && current) {
        const updatedById = new Map(polygons.map((polygon) => {
          const sqMeters = area(polygon);
          const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
          return [String(polygon.id ?? ''), { polygon, acres }] as const;
        }));
        const updated = current.map((part) => {
          const change = updatedById.get(part.drawId);
          return change ? { ...part, ...change } : part;
        });
        emitPolygons(updated);
        return;
      }

      for (const polygon of polygons) {
        const sqMeters = area(polygon);
        const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
        const center = centroid(polygon);
        const [lng, lat] = center.geometry.coordinates;
        onBoundaryChange?.(polygon, acres, [lng, lat]);
      }
    },
    [isMultiMode, emitPolygons, onBoundaryChange]
  );

  const handleDelete = useCallback(
    (featureIds: string[]) => {
      const current = latestPolygonsRef.current;
      if (isMultiMode && current) {
        const remaining = current.filter((p) => !featureIds.includes(p.drawId));
        emitPolygons(remaining);
        return;
      }
      onBoundaryDelete?.();
    },
    [isMultiMode, emitPolygons, onBoundaryDelete]
  );

  return (
    <DrawControl
      initialGeoJSON={initialFeatures && initialFeatures.length > 0 ? initialFeatures : null}
      onDrawCreate={handleCreate}
      onDrawUpdate={handleUpdate}
      onDrawDelete={handleDelete}
      allowRemoveSinglePart={allowRemoveSinglePart}
      disabled={disabled}
      onDrawingStateChange={onDrawingStateChange}
    />
  );
}
