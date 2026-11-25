// Field-app parity #16: per-job "Map" — plots THIS job's selected field locations
// (boundaries + centroid pins) on the shared CRXMap.
//
// Codex #16 P2: geometry is fetched server-side-scoped via get_job_fields_with_geojson,
// which returns ONLY the fields selected on THIS job and gates on the same visibility
// predicate as jobs_select. We do NOT pull the whole customer's fields to the browser.
// Fields with no geometry render a clear 'no boundary on file' state — never a broken map.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, AlertCircle, Map as MapIcon } from 'lucide-react';
import SectionCard from '../ui/SectionCard';
import Button from '../ui/Button';
import CRXMap from '../map/CRXMap';
import FieldBoundaryLayer from '../map/FieldBoundaryLayer';
import FieldMarkerLayer from '../map/FieldMarkerLayer';
import FieldObstacleLayer from '../map/FieldObstacleLayer';
import { useFitBounds } from '../../hooks/useFitBounds';
import { useFieldMarkers } from '../../hooks/useFieldMarkers';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import type { Field, FieldObstacle } from '../../types';
import { getJobFieldRouteNumbers } from './jobFieldRouteOrder';
import { toSentryError } from '../../lib/sentryError';
import { fieldObstacleToGeoJsonFeature } from '../../lib/fieldObstacles';
import { isNetworkFailure } from '../../lib/deliveryEvidence';
import FieldMarkerPanel, { MarkerTypeFilter } from '../map/FieldMarkerPanel';

// Exactly the columns get_job_fields_with_geojson returns.
interface JobMapFieldRow {
  id: string;
  customer_id: string;
  field_name: string;
  total_acres: number | null;
  measured_acres: number | null;
  override_acres: number | null;
  centroid_geojson: string | null;
  boundary_geojson: string | null;
  sort_order: number | null;
}

type JobMapField = Field & { sort_order: number | null };

function noGeometryMessage(filter: string, obstacles: FieldObstacle[], visibleObstacles: FieldObstacle[]) {
  if (filter && visibleObstacles.length > 0) return 'Markers matching this symbol filter could not be placed on the map.';
  return filter && obstacles.some(fieldObstacleToGeoJsonFeature)
    ? 'No mapped markers match this symbol filter.'
    : "None of this job's fields have a mapped boundary or location on file. Import or draw a boundary for these fields to see them on the map.";
}

/** Map a scoped RPC row into the Field shape the map layers consume. */
function toField(r: JobMapFieldRow): JobMapField {
  return {
    id: r.id,
    customer_id: r.customer_id,
    field_name: r.field_name,
    legal_description: null,
    county: null,
    state: null,
    total_acres: r.total_acres,
    // Two-acre model: keep these so FieldBoundaryLayer's billable-acre label is correct
    // (override ?? measured ?? total) instead of falling back to stale legacy total_acres.
    measured_acres: r.measured_acres,
    override_acres: r.override_acres,
    fsa_farm_number: null,
    fsa_tract_number: null,
    fsa_field_number: null,
    crop_type: null,
    soil_type: null,
    irrigation: false,
    notes: null,
    is_active: true,
    centroid_geojson: r.centroid_geojson,
    boundary_geojson: r.boundary_geojson,
    sort_order: r.sort_order,
    created_at: '',
    updated_at: '',
  };
}

interface JobFieldMapProps {
  /** The job whose selected fields are plotted. */
  jobId: string;
  /** Changes after each successful job load, so the always-visible map reloads after a save. */
  refreshKey?: number;
}

function JobFieldCheckStatus({ checking, failed, retry }: { checking: boolean; failed: boolean; retry: () => void }) {
  if (checking) return <p role="status" className="text-sm">Checking this job’s fields…</p>;
  if (!failed) return null;
  return (
    <div className="space-y-2">
      <p role="status" className="text-sm text-amber-800">Could not recheck this job’s fields. Some locations may be out of date.</p>
      <Button type="button" variant="secondary" onClick={retry}>Reload job fields</Button>
    </div>
  );
}

function JobFieldLoadStatus({ failed, checking, retry }: { failed?: boolean; checking: boolean; retry: () => void }) {
  const message = failed
    ? checking ? 'Checking this job’s fields…' : 'Could not load this job’s fields.'
    : 'Loading map…';
  return (
    <SectionCard id="job-map" icon={<MapIcon className="w-5 h-5" />} title="Field Map">
      <div className="space-y-2 py-10 text-center">
        <p role="status" className="text-sm text-gray-500">{message}</p>
        {failed && <Button type="button" variant="secondary" disabled={checking} onClick={retry}>Check again</Button>}
      </div>
    </SectionCard>
  );
}

export default function JobFieldMap({ jobId, refreshKey }: JobFieldMapProps) {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [retry, setRetry] = useState(0);
  const fieldCheckInProgress = useRef(false);
  const retryFields = useCallback(() => {
    if (fieldCheckInProgress.current) return;
    fieldCheckInProgress.current = true;
    setRetry((previous) => previous + 1);
  }, []);
  const scope = `${profile?.id ?? ''}:${jobId}`;
  const attempt = `${refreshKey ?? ''}:${retry}`;
  const [result, setResult] = useState<{ scope: string; attempt: string; fields: JobMapField[]; failed: boolean }>();
  const [filter, setFilter] = useState('');
  const current = result?.scope === scope ? result : undefined;
  const checking = current?.attempt !== attempt;
  const jobFields = useMemo(() => current?.fields ?? [], [current]);
  const { forField, refresh } = useFieldMarkers(profile?.id, jobFields.map((field) => field.id), refreshKey);
  const obstacles = useMemo(() => jobFields.flatMap((field) => forField(field.id).markers), [jobFields, forField]);
  const visibleObstacles = useMemo(() => filter ? obstacles.filter((marker) => marker.kind === filter) : obstacles, [filter, obstacles]);

  useEffect(() => {
    function refreshAssignmentsOnResume() {
      if (document.visibilityState === 'visible') retryFields();
    }
    document.addEventListener('visibilitychange', refreshAssignmentsOnResume);
    return () => document.removeEventListener('visibilitychange', refreshAssignmentsOnResume);
  }, [retryFields]);

  useEffect(() => {
    let cancelled = false;
    fieldCheckInProgress.current = true;
    async function load() {
      if (!jobId) {
        setResult({ scope, attempt, fields: [], failed: false });
        fieldCheckInProgress.current = false;
        return;
      }
      try {
        // Server-side scoped: returns ONLY this job's selected fields, gated by job
        // visibility (admin / sales_rep / the assigned applicator). No over-fetch.
        const { data, error } = await supabase.rpc('get_job_fields_with_geojson', {
          p_job_id: jobId,
        });
        if (error) throw error;
        const rows = assertRpcResult<JobMapFieldRow[]>(data, 'get_job_fields_with_geojson');
        if (!cancelled) setResult({ scope, attempt, fields: rows.map(toField), failed: false });
      } catch (err) {
        Sentry.captureException(toSentryError(err), {
          tags: { source: 'fetch', action: 'job_field_map' },
        });
        if (!cancelled) setResult((previous) => ({
          scope, attempt, failed: true,
          fields: previous?.scope === scope && isNetworkFailure(err) ? previous.fields : [],
        }));
      } finally {
        if (!cancelled) fieldCheckInProgress.current = false;
      }
    }
    load();
    return () => {
      cancelled = true;
      fieldCheckInProgress.current = false;
    };
  }, [attempt, jobId, scope]);

  const fieldsWithGeometry = useMemo(
    () => jobFields.filter((f) => f.boundary_geojson || f.centroid_geojson),
    [jobFields]
  );
  const fieldsWithoutGeometry = useMemo(
    () => jobFields.filter((f) => !f.boundary_geojson && !f.centroid_geojson),
    [jobFields]
  );
  const routeNumberById = useMemo(() => getJobFieldRouteNumbers(jobFields), [jobFields]);

  const plottedPoints = useMemo(() => visibleObstacles.flatMap((marker) => {
    const feature = fieldObstacleToGeoJsonFeature(marker);
    return feature ? [JSON.stringify(feature.geometry)] : [];
  }), [visibleObstacles]);
  const geoStrings = useMemo(() => [
    ...fieldsWithGeometry.flatMap((f) => [f.boundary_geojson, f.centroid_geojson]),
    ...plottedPoints,
  ], [fieldsWithGeometry, plottedPoints]);
  const bounds = useFitBounds(geoStrings);
  const hasMapGeometry = fieldsWithGeometry.length > 0 || plottedPoints.length > 0;

  if (!current || (current.failed && current.fields.length === 0)) {
    return <JobFieldLoadStatus failed={current?.failed} checking={checking} retry={retryFields} />;
  }

  if (jobFields.length === 0) {
    return (
      <SectionCard id="job-map" icon={<MapIcon className="w-5 h-5" />} title="Field Map">
        <div className="text-center py-12 text-gray-500">
          <MapPin className="w-10 h-10 mx-auto mb-2 text-gray-300" />
          <p className="text-sm">No field locations are selected on this job.</p>
          <p className="text-xs mt-1">Add fields in the Fields section to see them on the map.</p>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="job-map"
      icon={<MapIcon className="w-5 h-5" />}
      title={`Field Map (${jobFields.length} location${jobFields.length === 1 ? '' : 's'})`}
    >
      <div className="space-y-3 p-4 sm:p-5">
      <JobFieldCheckStatus checking={checking} failed={current.failed} retry={retryFields} />
      <MarkerTypeFilter value={filter} onChange={setFilter} />

      {hasMapGeometry ? (
        <CRXMap
          className="h-[480px] w-full rounded-lg overflow-hidden"
          showLayerToggle
          showLocateMe
          bounds={bounds}
        >
          <FieldBoundaryLayer
            fields={fieldsWithGeometry}
            labelById={routeNumberById}
            onFieldClick={(fieldId) => navigate(`/fields/${fieldId}/dashboard`)}
          />
          {/* Codex P3: pass onFieldClick so the marker popup's "View Dashboard" action
              actually navigates (it renders a dead button without a handler). */}
          <FieldMarkerLayer
            fields={fieldsWithGeometry}
            labelById={routeNumberById}
            showAll
            onFieldClick={(fieldId) => navigate(`/fields/${fieldId}/dashboard`)}
          />
          <FieldObstacleLayer obstacles={visibleObstacles} />
        </CRXMap>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-amber-800">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p className="text-sm">
            {noGeometryMessage(filter, obstacles, visibleObstacles)}
          </p>
        </div>
      )}

      {fieldsWithoutGeometry.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500 mb-1">
            No boundary on file for {fieldsWithoutGeometry.length} field
            {fieldsWithoutGeometry.length === 1 ? '' : 's'}:
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {fieldsWithoutGeometry.map((f) => (
              <li
                key={f.id}
                className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600"
              >
                <MapPin className="w-3 h-3 text-gray-400" />
                {f.field_name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {jobFields.map((field) => (
        <FieldMarkerPanel key={field.id} name={field.field_name} read={forField(field.id)} refresh={refresh} />
      ))}
      </div>
    </SectionCard>
  );
}
