import centroid from '@turf/centroid';
import type { Polygon as GeoJSONPolygon } from 'geojson';

export interface BoundaryLabel {
  key: string;
  text: string;
  longitude: number;
  latitude: number;
}

/** The parts of a field-boundary FeatureCollection that labels need. */
export interface BoundaryLabelInput {
  features: Array<{
    properties: { id: string; label: string };
    geometry: { type: string; coordinates?: unknown };
  }>;
}

export function createBoundaryLabels(geojson: BoundaryLabelInput): BoundaryLabel[] {
  return geojson.features.flatMap((feature) => {
    const geometry = feature.geometry;
    const polygons: GeoJSONPolygon['coordinates'][] = geometry.type === 'Polygon'
      ? [geometry.coordinates as GeoJSONPolygon['coordinates']]
      : geometry.type === 'MultiPolygon' ? geometry.coordinates as GeoJSONPolygon['coordinates'][] : [];
    return polygons.flatMap((coordinates: GeoJSONPolygon['coordinates'], index: number) => {
      // A stored outline with no usable corners gets no label instead of crashing the whole map.
      let point: number[];
      try {
        point = centroid({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates },
        }).geometry.coordinates;
      } catch {
        return [];
      }
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return [];
      return [{
        key: `${feature.properties.id}:${index}`,
        text: feature.properties.label,
        longitude: point[0],
        latitude: point[1],
      }];
    });
  });
}
