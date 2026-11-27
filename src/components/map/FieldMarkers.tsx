import { useContext, useEffect, useMemo, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import { MapContainerContext } from './MapContainerContext';
import type { Field } from '../../types';

interface FieldGeo {
  id: string;
  field_name: string;
  total_acres: number | null;
  crop_type: string | null;
  customer_name?: string;
  lng: number;
  lat: number;
}

interface FieldMarkersProps {
  fields: Field[];
  onFieldClick?: (fieldId: string) => void;
}

export default function FieldMarkers({ fields, onFieldClick }: FieldMarkersProps) {
  const map = useContext(MapContainerContext);
  const onFieldClickRef = useRef(onFieldClick);

  const markers = useMemo(() => {
    const result: FieldGeo[] = [];
    for (const field of fields) {
      if (!field.centroid_geojson) continue;
      try {
        const geo = JSON.parse(field.centroid_geojson);
        if (geo?.type === 'Point' && Array.isArray(geo.coordinates)) {
          result.push({
            id: field.id,
            field_name: field.field_name,
            total_acres: field.total_acres,
            crop_type: field.crop_type,
            customer_name: (field as Field & { customer_name?: string }).customer_name || field.customer?.farm_name,
            lng: geo.coordinates[0],
            lat: geo.coordinates[1],
          });
        }
      } catch {
        // Skip invalid GeoJSON
      }
    }
    return result;
  }, [fields]);

  useEffect(() => {
    onFieldClickRef.current = onFieldClick;
  }, [onFieldClick]);

  useEffect(() => {
    if (!map || markers.length === 0) return;

    const disposers: Array<() => void> = [];
    for (const field of markers) {
      const markerElement = document.createElement('div');
      markerElement.className = 'cursor-pointer';
      const dot = document.createElement('div');
      dot.className = 'w-4 h-4 rounded-full bg-crx-green border-2 border-white shadow-md transition-transform hover:scale-125';
      markerElement.append(dot);

      const marker = new maplibregl.Marker({ element: markerElement, anchor: 'center' })
        .setLngLat([field.lng, field.lat])
        .addTo(map);

      const popupContent = document.createElement('div');
      popupContent.className = 'text-xs px-1 py-0.5';
      const name = document.createElement('p');
      name.className = 'font-semibold text-nav-dark';
      name.textContent = field.field_name;
      popupContent.append(name);
      if (field.total_acres) {
        const acres = document.createElement('p');
        acres.className = 'text-secondary';
        acres.textContent = `${field.total_acres.toLocaleString()} acres`;
        popupContent.append(acres);
      }
      if (field.crop_type) {
        const crop = document.createElement('p');
        crop.className = 'text-secondary capitalize';
        crop.textContent = field.crop_type;
        popupContent.append(crop);
      }
      if (field.customer_name) {
        const customer = document.createElement('p');
        customer.className = 'text-secondary';
        customer.textContent = field.customer_name;
        popupContent.append(customer);
      }

      const popup = new maplibregl.Popup({
        anchor: 'bottom',
        offset: 12,
        closeButton: false,
        closeOnClick: false,
        className: 'field-marker-popup',
      }).setDOMContent(popupContent).setLngLat([field.lng, field.lat]);
      const handleClick = (event: MouseEvent) => {
        event.stopPropagation();
        onFieldClickRef.current?.(field.id);
      };
      const handleMouseEnter = () => popup.addTo(map);
      const handleMouseLeave = () => popup.remove();
      markerElement.addEventListener('click', handleClick);
      markerElement.addEventListener('mouseenter', handleMouseEnter);
      markerElement.addEventListener('mouseleave', handleMouseLeave);

      disposers.push(() => {
        markerElement.removeEventListener('click', handleClick);
        markerElement.removeEventListener('mouseenter', handleMouseEnter);
        markerElement.removeEventListener('mouseleave', handleMouseLeave);
        popup.remove();
        marker.remove();
      });
    }

    return () => disposers.forEach((dispose) => dispose());
  }, [map, markers]);

  return null;
}
