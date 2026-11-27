import { useMemo, useEffect, useState } from 'react';
import { Source, Layer, Marker, useMap } from 'react-map-gl/maplibre';
import type { MapMouseEvent } from 'maplibre-gl';
import { createBoundaryLabels, type BoundaryLabel } from './boundaryLabels';
import { billableAcres } from '../../lib/fieldGeometry';
import type { Customer, Field } from '../../types';

type FieldWithCustomer = Pick<Field, 'id' | 'field_name' | 'total_acres' | 'crop_type' | 'boundary_geojson' | 'override_acres' | 'measured_acres'> & {
  customer_name?: string | null;
  customer?: Pick<Customer, 'farm_name'> | null;
  billable_acres?: number | null;
};

interface FieldBoundaryLayerProps {
  fields: FieldWithCustomer[];
  showLabels?: boolean;
  /** Optional per-field prefix for boundary labels, such as a route number. */
  labelById?: Map<string, string>;
  onFieldClick?: (fieldId: string) => void;
  /** Phase 6 (2026-04-30): when set, fields with id in this set render highlighted. Lets the map double as a selection picker. */
  selectedIds?: Set<string>;
  /** Hover state can be shared with a companion table. */
  hoveredId?: string | null;
  onFieldHover?: (fieldId: string | null) => void;
}


function createBoundaryGeojson(
  fields: FieldWithCustomer[],
  labelById?: Map<string, string>,
  selectedIds?: Set<string>,
  hoveredId?: string | null,
) {
  const features = fields
    .filter((field) => field.boundary_geojson)
    .map((field) => {
      try {
        const geometry = typeof field.boundary_geojson === 'string'
          ? JSON.parse(field.boundary_geojson)
          : field.boundary_geojson;
        const acres = field.billable_acres ?? billableAcres(field.override_acres, field.measured_acres, field.total_acres);
        const name = labelById?.get(field.id)
          ? `${labelById.get(field.id)} · ${field.field_name}`
          : field.field_name;
        return {
          type: 'Feature' as const,
          properties: {
            id: field.id,
            field_name: field.field_name,
            label: acres != null ? `${name}\n${acres} ac` : name,
            total_acres: field.total_acres,
            crop_type: field.crop_type,
            customer_name: field.customer_name || field.customer?.farm_name || '',
            selected: selectedIds ? selectedIds.has(field.id) : false,
            hovered: hoveredId === field.id,
          },
          geometry,
        };
      } catch {
        return null;
      }
    })
    .filter((feature): feature is NonNullable<typeof feature> => feature !== null);

  return { type: 'FeatureCollection' as const, features };
}

function useVisibleBoundaryLabels(labels: BoundaryLabel[], map: ReturnType<typeof useMap>['current'], enabled: boolean) {
  const [visible, setVisible] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!map || !enabled) {
      setVisible((current) => current.size === 0 ? current : new Set());
      return;
    }

    const update = () => {
      const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      const next = new Set<string>();
      const { clientWidth: width, clientHeight: height } = map.getContainer();
      if (!width || !height) return;

      for (const label of labels) {
        const point = map.project([label.longitude, label.latitude]);
        const lines = label.text.split('\n');
        const widthEstimate = Math.min(180, Math.max(28, ...lines.map((line) => line.length * 6.5)));
        const lineCount = lines.reduce((count, line) => count + Math.max(1, Math.ceil(line.length * 6.5 / 180)), 0);
        const heightEstimate = lineCount * 15;
        const box = {
          left: point.x - widthEstimate / 2,
          top: point.y - heightEstimate / 2,
          right: point.x + widthEstimate / 2,
          bottom: point.y + heightEstimate / 2,
        };
        if (box.right < 0 || box.left > width || box.bottom < 0 || box.top > height) continue;
        if (occupied.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
        occupied.push(box);
        next.add(label.key);
      }

      setVisible((current) => current.size === next.size && [...current].every((key) => next.has(key)) ? current : next);
    };

    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };
    map.on('moveend', schedule);
    map.on('resize', schedule);
    schedule();
    return () => {
      map.off('moveend', schedule);
      map.off('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [enabled, labels, map]);

  return visible;
}

function useBoundaryInteractions(
  map: ReturnType<typeof useMap>['current'],
  onFieldClick?: (fieldId: string) => void,
  onFieldHover?: (fieldId: string | null) => void,
) {
  useEffect(() => {
    if (!map || !onFieldClick) return;
    const handleClick = (event: MapMouseEvent) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: ['field-boundaries-fill'] })[0];
      const fieldId = feature?.properties?.id;
      if (fieldId) onFieldClick(fieldId);
    };
    const handleMouseMove = (event: MapMouseEvent) => {
      map.getCanvas().style.cursor = 'pointer';
      const feature = map.queryRenderedFeatures(event.point, { layers: ['field-boundaries-fill'] })[0];
      onFieldHover?.(feature?.properties?.id ?? null);
    };
    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
      onFieldHover?.(null);
    };
    const handleMouseEnter = () => { map.getCanvas().style.cursor = 'pointer'; };

    map.on('click', 'field-boundaries-fill', handleClick);
    if (onFieldHover) {
      map.on('mousemove', 'field-boundaries-fill', handleMouseMove);
      map.on('mouseleave', 'field-boundaries-fill', handleMouseLeave);
    } else {
      map.on('mouseenter', 'field-boundaries-fill', handleMouseEnter);
      map.on('mouseleave', 'field-boundaries-fill', handleMouseLeave);
    }
    return () => {
      map.off('click', 'field-boundaries-fill', handleClick);
      if (onFieldHover) {
        map.off('mousemove', 'field-boundaries-fill', handleMouseMove);
        map.off('mouseleave', 'field-boundaries-fill', handleMouseLeave);
      } else {
        map.off('mouseenter', 'field-boundaries-fill', handleMouseEnter);
        map.off('mouseleave', 'field-boundaries-fill', handleMouseLeave);
      }
    };
  }, [map, onFieldClick, onFieldHover]);
}

export default function FieldBoundaryLayer({
  fields,
  showLabels = true,
  labelById,
  onFieldClick,
  selectedIds,
  hoveredId,
  onFieldHover,
}: FieldBoundaryLayerProps) {
  const geojson = useMemo(() => createBoundaryGeojson(fields, labelById, selectedIds, hoveredId), [fields, hoveredId, labelById, selectedIds]);
  // Labels depend only on the fields, not hover/selection, so hovering never re-runs label placement.
  const labelCandidates = useMemo(
    () => (showLabels ? createBoundaryLabels(createBoundaryGeojson(fields, labelById)) : []),
    [fields, labelById, showLabels],
  );
  const { current: map } = useMap();
  const visibleLabels = useVisibleBoundaryLabels(labelCandidates, map, showLabels);
  useBoundaryInteractions(map, onFieldClick, onFieldHover);

  return (
    <>
    <Source id="field-boundaries" type="geojson" data={geojson}>
      <Layer
        id="field-boundaries-fill"
        type="fill"
        paint={{
          'fill-color': ['case', ['get', 'selected'], '#f59e0b', ['get', 'hovered'], '#2563eb', '#28A26A'],
          // Phase 6: selected fields render at higher opacity so the user can see
          // which ones are picked at a glance — without losing the unselected ones.
          'fill-opacity': ['case', ['get', 'selected'], 0.6, ['get', 'hovered'], 0.4, 0.18],
        }}
      />
      <Layer
        id="field-boundaries-outline"
        type="line"
        paint={{
          'line-color': ['case', ['get', 'selected'], '#b45309', ['get', 'hovered'], '#1d4ed8', '#28A26A'],
          'line-width': ['case', ['get', 'selected'], 3, ['get', 'hovered'], 3, 2],
        }}
      />
    </Source>
      {showLabels && labelCandidates.filter((candidate) => visibleLabels.has(candidate.key)).map((candidate) => (
        <Marker
          key={candidate.key}
          longitude={candidate.longitude}
          latitude={candidate.latitude}
          anchor="center"
          style={{ pointerEvents: 'none' }}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none whitespace-pre-wrap text-center text-xs text-white"
            style={{ maxWidth: 180, textShadow: '-1px -1px 1px #000, 1px -1px 1px #000, -1px 1px 1px #000, 1px 1px 1px #000' }}
          >
            {candidate.text}
          </span>
        </Marker>
      ))}
    </>
  );
}
