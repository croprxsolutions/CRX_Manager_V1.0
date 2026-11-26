import { useId } from 'react';
import { MapPin, Pencil, Trash2 } from 'lucide-react';
import { FIELD_OBSTACLE_KINDS, FIELD_OBSTACLE_KIND_LABELS, fieldObstacleName, fieldObstacleToGeoJsonFeature } from '../../lib/fieldObstacles';
import type { FieldMarkerState, FieldObstacle, FieldObstacleKind } from '../../types';
import Button from '../ui/Button';

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formatStamp = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? dateTime.format(timestamp) : 'Unknown date';
};

export function MarkerTypeFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm font-medium">
      Map symbols
      <select className="min-h-11 rounded border border-gray-300 bg-white px-2 text-base" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All marker types</option>
        {FIELD_OBSTACLE_KINDS.map((kind) => <option key={kind} value={kind}>{FIELD_OBSTACLE_KIND_LABELS[kind]}</option>)}
      </select>
      {value && <span className="text-secondary">Symbols filtered. The list shows all markers.</span>}
    </label>
  );
}

export function MarkerKindSelect({ kind, onChange, disabled }: {
  kind: FieldObstacleKind | null;
  onChange: (kind: FieldObstacleKind) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block text-sm font-medium">
      Marker type
      <select id={id} className="mt-1 block min-h-11 w-full rounded border border-gray-300 bg-white px-2 text-base"
        disabled={disabled} value={kind ?? ''} onChange={(event) => onChange(event.target.value as FieldObstacleKind)}>
        {kind === null && <option value="" disabled>Existing marker type</option>}
        {FIELD_OBSTACLE_KINDS.map((value) => <option key={value} value={value}>{FIELD_OBSTACLE_KIND_LABELS[value]}</option>)}
      </select>
    </label>
  );
}

function statusText(state: FieldMarkerState): string | null {
  switch (state.status) {
    case 'loading': return 'Checking field markers…';
    case 'incomplete': return 'Only some markers could be checked. Confirm hazards on site.';
    case 'unavailable': return 'Markers could not be checked for this field. Confirm hazards on site.';
    case 'stale': return `Markers may be out of date. Last checked ${dateTime.format(state.checkedAt)}.`;
    case 'complete': return state.markers.length === 0 ? 'None recorded.' : null;
  }
}

interface MarkerActions {
  add: () => void;
  edit: (marker: FieldObstacle) => void;
  remove: (marker: FieldObstacle) => void;
  canEdit: (marker: FieldObstacle) => boolean;
}

export default function FieldMarkerPanel({ name, read, actions, refresh }: {
  name: string;
  read: FieldMarkerState;
  actions?: MarkerActions;
  refresh: () => void;
}) {
  const message = statusText(read);
  return (
    <section className="min-w-0 rounded-lg border border-gray-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-nav-dark">{name}</h3>
        {actions && <Button type="button" variant="secondary" onClick={actions.add} icon={<MapPin size={18} />}>Add marker</Button>}
      </div>
      {message && <p role="status" className="mt-1 text-sm text-secondary">{message}</p>}
      {read.authorsUnavailable && <p role="status" className="mt-1 text-sm text-secondary">Marker authors could not be checked.</p>}
      {(read.authorsUnavailable || ['unavailable', 'incomplete', 'stale'].includes(read.status)) && (
        <Button type="button" variant="secondary" disabled={read.checking} onClick={refresh} className="mt-2">Check again</Button>
      )}
      <ul className="divide-y divide-gray-200">
        {read.markers.map((marker) => (
          <li key={marker.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0 break-words">
              <p className="font-medium text-nav-dark">{fieldObstacleName(marker)}</p>
              {marker.label && <p className="text-sm">{marker.label}</p>}
              {!fieldObstacleToGeoJsonFeature(marker) && <p className="text-sm text-amber-800">Could not place on the map.</p>}
              <p className="text-xs text-secondary">
                Added by {read.authors.get(marker.created_by ?? '') || 'Unknown'} · {formatStamp(marker.created_at)}
              </p>
              {marker.updated_at !== marker.created_at && (
                <p className="text-xs text-secondary">Last edited {formatStamp(marker.updated_at)}</p>
              )}
            </div>
            {actions?.canEdit(marker) && (
              <div className="flex gap-2">
                <Button type="button" variant="secondary" icon={<Pencil size={16} />} onClick={() => actions.edit(marker)}>Edit</Button>
                <Button type="button" variant="secondary" icon={<Trash2 size={16} />} onClick={() => actions.remove(marker)}>Delete</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
