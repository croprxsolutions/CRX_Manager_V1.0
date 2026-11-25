import { useState } from 'react';
import type { MapRef } from 'react-map-gl/mapbox';
import type { Field, FieldMarkerState } from '../../types';
import { useFieldMarkerEditor } from '../../hooks/useFieldMarkerEditor';
import { useFieldMarkers } from '../../hooks/useFieldMarkers';
import CRXMap from './CRXMap';
import FieldBoundaryLayer from './FieldBoundaryLayer';
import FieldObstacleLayer from './FieldObstacleLayer';
import FieldMarkerPanel, { MarkerTypeFilter } from './FieldMarkerPanel';
import FieldMarkerEditor from './FieldMarkerEditor';

interface CrewFieldMarkerMapProps {
  fields: Field[];
  actorId: string;
  jobByField: ReadonlyMap<string, string>;
  office: boolean;
  placementAllowed?: boolean;
  refreshKey?: number;
  active?: boolean;
  onFieldClick: (fieldId: string) => void;
  onMapLoad: (map: MapRef) => void;
}

function draftReadUnavailable(read: FieldMarkerState | undefined) {
  return !read || read.status === 'unavailable' || (read.status === 'loading' && !read.checkedAt);
}

export default function CrewFieldMarkerMap({ fields, actorId, jobByField, office, placementAllowed = true, refreshKey, active = true, onFieldClick, onMapLoad }: CrewFieldMarkerMapProps) {
  const { forField, refresh, revokeField, forgetDeletedMarker } = useFieldMarkers(actorId, fields.map((field) => field.id), refreshKey, active);
  const editor = useFieldMarkerEditor(actorId, office, forField, refresh, {
    placementAllowed,
    scope: (fieldId) => fields.some((field) => field.id === fieldId) ? jobByField.get(fieldId) : undefined,
    onAccessDenied: revokeField,
    onDeleted: forgetDeletedMarker,
  });
  const [filter, setFilter] = useState('');
  const editingField = fields.find((field) => field.id === editor.draft?.field.id);
  const draftRead = editingField && forField(editingField.id);
  const ready = placementAllowed && draftRead?.status === 'complete';
  const draftUnavailable = draftReadUnavailable(draftRead);
  const markers = fields.flatMap((field) => forField(field.id).markers);
  const visible = filter ? markers.filter((marker) => marker.kind === filter) : markers;

  return (
    <section className="space-y-3 p-3">
      <MarkerTypeFilter value={filter} onChange={setFilter} />
      {editor.draft && !draftUnavailable && <p role="status" className="text-sm font-semibold">Marker for {editor.draft.field.name}</p>}
      <CRXMap className="h-[min(58vh,480px)] min-h-[360px] rounded-xl border border-gray-200"
        onMapLoad={onMapLoad} showLayerToggle showLocateMe onMapClick={ready ? editor.place : undefined}>
        <FieldBoundaryLayer fields={fields} showLabels onFieldClick={editor.draft || editor.target || editor.saving ? undefined : onFieldClick} />
        {/* Keep the unsaved placement visible even when saved symbols are filtered. */}
        <FieldObstacleLayer obstacles={ready && editor.preview ? [...visible, editor.preview] : visible} interactive={!editor.placing} />
      </CRXMap>
      <FieldMarkerEditor editor={editor} ready={ready} unavailable={draftUnavailable} />
      {fields.map((field) => {
        const read = forField(field.id);
        return (
          <FieldMarkerPanel key={field.id} name={field.field_name} read={read} refresh={refresh}
            actions={placementAllowed && read.status === 'complete' && !editor.draft && !editor.target && !editor.saving ? {
              add: () => editor.begin({ id: field.id, name: field.field_name }),
              edit: (marker) => editor.begin({ id: field.id, name: field.field_name }, marker),
              remove: editor.setTarget,
              canEdit: editor.canEdit,
            } : undefined} />
        );
      })}
    </section>
  );
}
