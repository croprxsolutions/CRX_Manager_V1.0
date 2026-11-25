import { useLayoutEffect, useRef, useState } from 'react';
import { checkPendingMarker, createFieldMarker, deleteFieldMarker, editFieldMarker, MarkerAccessDenied, MarkerSignalError, MARKER_NOTE_LIMIT, type MarkerPlacement } from '../lib/fieldMarkerData';
import { isFieldObstacleKind } from '../lib/fieldObstacles';
import { clearPendingMarker, PendingMarkerStorageError, readPendingMarker, reservePendingMarker, startReservedMarkerWrite } from '../lib/fieldMarkerPending';
import { Sentry } from '../lib/sentry';
import { toSentryError } from '../lib/sentryError';
import type { FieldMarkerState, FieldObstacle, FieldObstacleKind } from '../types';

interface Draft {
  field: { id: string; name: string };
  id: string;
  marker: FieldObstacle | null;
  kind: FieldObstacleKind | null;
  note: string;
  point: [number, number] | null;
  submitted: boolean;
}

function pendingDraft(field: Draft['field'], placement: MarkerPlacement): Draft {
  return {
    field, id: placement.id, marker: null, kind: placement.kind, note: placement.label ?? '',
    point: placement.point_geojson.coordinates as [number, number], submitted: true,
  };
}

function markerDraftPreview(draft: Draft | null, actorId: string): FieldObstacle | null {
  return draft?.point ? {
    id: `draft-${draft.id}`, field_id: draft.field.id, kind: draft.kind ?? draft.marker?.kind ?? 'other',
    label: 'Unsaved marker', point_geojson: { type: 'Point', coordinates: draft.point },
    entrance_number: draft.marker?.entrance_number ?? null,
    created_by: actorId, created_at: '', updated_at: '',
  } : null;
}

function submittedLabel(draft: Draft) {
  if (draft.marker && draft.note === (draft.marker.label ?? '')) return draft.marker.label;
  return draft.note.trim() || null;
}

type WriteResult = void | { message: string; keepDraft?: boolean };
const removedMarkerMessage = 'This marker was saved and has since been removed.';
const createMarkerMessages = {
  saved: 'Marker added.',
  removed: removedMarkerMessage,
  rejected: 'The marker was rejected. Check its placement and note, then add it again.',
};
const pendingInOtherTab = {
  message: 'Another tab has a pending save for this field. Finish it there, then save this draft. To recover it here, cancel this draft and choose Add marker again.',
  keepDraft: true,
};

function pendingReadMessage(error: unknown) {
  if (error instanceof PendingMarkerStorageError) return error.message;
  if (error instanceof MarkerSignalError) return 'Could not check this field’s pending saves. Check the connection and try again.';
  return 'Could not check this field’s pending saves on this device. Try again.';
}

function pendingWriteMessage(error: unknown) {
  return error instanceof PendingMarkerStorageError ? error.message : 'Could not keep this marker on this device. No save was sent.';
}

async function finishPendingMarker(actorId: string, placement: MarkerPlacement, message: string) {
  try {
    await clearPendingMarker(actorId, placement);
    return message;
  } catch (error) {
    Sentry.captureException(toSentryError(error), { tags: { action: 'clear_pending_field_marker' } });
    return message + ' This device will check the pending save again before you add another marker.';
  }
}

export function useFieldMarkerEditor(
  actorId: string,
  office: boolean,
  forField: (id: string) => FieldMarkerState,
  refresh: () => void,
  { placementAllowed = true, scope = '', onAccessDenied, onDeleted }: {
    placementAllowed?: boolean;
    scope?: string | ((fieldId: string) => string | undefined);
    onAccessDenied?: (fieldId: string) => void;
    onDeleted?: (fieldId: string, markerId: string) => void;
  } = {},
) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [target, setDeleteTarget] = useState<FieldObstacle | null>(null);
  const [placing, setPlacing] = useState(false);
  const [operation, setOperation] = useState<'checking' | 'saving' | null>(null);
  const [resultMessage, setMessage] = useState('');
  const mounted = useRef(false);
  const busy = useRef(false);
  const viewVersion = useRef(0);
  const initialScope = useRef<string | undefined>(undefined);
  const scopeFor = (fieldId: string) => typeof scope === 'function' ? scope(fieldId) : scope;
  const currentView = useRef({ actorId, scopeFor, forField, placementAllowed });
  const selectedFieldId = draft?.field.id ?? target?.field_id;
  const selectedScope = selectedFieldId ? scopeFor(selectedFieldId) : undefined;
  const accessDenied = selectedFieldId ? forField(selectedFieldId).accessDenied === true : false;
  useLayoutEffect(() => {
    currentView.current = { actorId, scopeFor, forField, placementAllowed };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    if (!selectedFieldId || (initialScope.current === selectedScope && !accessDenied)) return;
    viewVersion.current += 1;
    setDraft(null);
    setDeleteTarget(null);
    setPlacing(false);
    setMessage(draft && !draft.submitted ? 'The unsaved marker draft closed. Check this field before adding it again.' : '');
  }, [selectedFieldId, selectedScope, accessDenied, draft]);

  const canEdit = (marker: FieldObstacle) => office || marker.created_by === actorId;

  function begin(field: Draft['field'], marker: FieldObstacle | null = null) {
    if (busy.current || draft || target || !placementAllowed || forField(field.id).status !== 'complete') return;
    if (!marker) {
      void openCreate(field);
      return;
    }
    initialScope.current = scopeFor(field.id);
    const kind = isFieldObstacleKind(marker.kind) ? marker.kind : null;
    setDraft({ field, id: marker.id, marker, kind, note: marker.label ?? '', point: null, submitted: false });
    setMessage('');
  }

  async function openCreate(field: Draft['field']) {
    const expectedScope = scopeFor(field.id);
    const canOpen = () => mounted.current && currentView.current.actorId === actorId
      && currentView.current.placementAllowed
      && currentView.current.scopeFor(field.id) === expectedScope
      && currentView.current.forField(field.id).status === 'complete';
    busy.current = true;
    setOperation('checking');
    try {
      const pending = await readPendingMarker(actorId, field.id);
      if (!canOpen()) return;
      if (pending) {
        const receipt = await checkPendingMarker(pending, actorId);
        if (!canOpen()) return;
        if (receipt !== 'missing') {
          const message = await finishPendingMarker(actorId, pending, receipt === 'removed' ? removedMarkerMessage : 'The pending marker was already saved.');
          if (canOpen()) {
            setMessage(message);
            refresh();
          }
          return;
        }
      }
      initialScope.current = expectedScope;
      setDraft(pending ? pendingDraft(field, pending) : {
        field, id: crypto.randomUUID(), marker: null, kind: 'field_entrance', note: '', point: null, submitted: false,
      });
      setPlacing(!pending);
      setMessage(pending ? 'A previous marker save is pending. Retry this marker to check what happened.' : '');
    } catch (error) {
      if (error instanceof MarkerAccessDenied && canOpen()) {
        onAccessDenied?.(field.id);
        setMessage('This field’s markers are no longer available.');
        return;
      }
      if (!(error instanceof MarkerSignalError)) Sentry.captureException(toSentryError(error), { tags: { action: 'read_pending_field_marker' } });
      if (canOpen()) setMessage(pendingReadMessage(error));
    } finally {
      busy.current = false;
      if (mounted.current) setOperation(null);
    }
  }

  function setTarget(marker: FieldObstacle) {
    if (busy.current) return;
    initialScope.current = scopeFor(marker.field_id);
    setDeleteTarget(marker);
  }

  function place(longitude: number, latitude: number) {
    if (!draft || !placing || busy.current || !placementAllowed || !Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return;
    const wrappedLongitude = Math.abs(longitude) <= 180 ? longitude : ((longitude + 180) % 360 + 360) % 360 - 180;
    setDraft({ ...draft, point: [wrappedLongitude, latitude] });
    setPlacing(false);
  }

  function patch(changes: Partial<Pick<Draft, 'kind' | 'note'>>) {
    if (draft && !draft.submitted && !busy.current) setDraft({ ...draft, ...changes });
  }

  function cancel() {
    if (busy.current) return;
    setDraft(null);
    setDeleteTarget(null);
    setPlacing(false);
    setMessage(draft?.submitted ? 'Pending marker kept on this device.' : '');
  }

  async function run(write: (inSameView: () => boolean) => Promise<WriteResult>, successMessage: string, failureMessage: string) {
    const version = viewVersion.current;
    const inSameView = () => mounted.current && viewVersion.current === version;
    busy.current = true;
    setOperation('saving');
    setMessage('');
    try {
      const result = await write(inSameView);
      if (!inSameView()) return;
      if (!result?.keepDraft) setDraft(null);
      setDeleteTarget(null);
      setPlacing(false);
      setMessage(result?.message ?? successMessage);
    } catch (error) {
      Sentry.captureException(toSentryError(error), { tags: { source: 'critical_action', action: 'write_field_marker' } });
      if (inSameView()) {
        setDeleteTarget(null);
        setMessage(failureMessage);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setOperation(null);
      if (inSameView()) refresh();
    }
  }

  async function save() {
    if (!draft || busy.current || !placementAllowed || forField(draft.field.id).status !== 'complete') return;
    const label = submittedLabel(draft);
    if (label !== (draft.marker?.label ?? null) && label && [...label].length > MARKER_NOTE_LIMIT) {
      setMessage(`Keep the marker note at ${MARKER_NOTE_LIMIT} characters or fewer.`);
      return;
    }
    const point = draft.point ? { type: 'Point' as const, coordinates: draft.point } : undefined;
    const marker = draft.marker;
    if (marker) {
      if (!canEdit(marker)) return;
      const changes = { ...(draft.kind && { kind: draft.kind }), label, ...(point && { point_geojson: point }) };
      await run(() => editFieldMarker(marker, actorId, changes),
        'Marker updated.', 'The marker could not be updated. Cancel and reopen it to check the latest version.');
    } else if (point && draft.kind) {
      await saveNewMarker(draft.field, { id: draft.id, field_id: draft.field.id, kind: draft.kind, label, point_geojson: point });
    }
  }

  async function saveNewMarker(field: Draft['field'], placement: MarkerPlacement) {
    await run(async (inSameView) => {
      let pending: MarkerPlacement;
      try {
        pending = await reservePendingMarker(actorId, placement);
      } catch (error) {
        return { message: pendingWriteMessage(error), keepDraft: true };
      }
      if (!inSameView()) return;
      if (pending.id !== placement.id) return pendingInOtherTab;
      setDraft(pendingDraft(field, pending));
      if (!currentView.current.placementAllowed || currentView.current.forField(field.id).status !== 'complete') {
        return { keepDraft: true, message: 'Check this field before retrying the marker.' };
      }
      const state = await createFieldMarker(pending, actorId, (send) => startReservedMarkerWrite(actorId, pending, inSameView, send)).catch((error: unknown) => {
        if (error instanceof MarkerAccessDenied && inSameView()) onAccessDenied?.(field.id);
        throw error;
      });
      return { message: await finishPendingMarker(actorId, pending, createMarkerMessages[state]) };
    }, 'Marker added.', 'The save could not be confirmed. Check the connection and retry this marker.');
  }

  async function remove() {
    if (!target || busy.current || !canEdit(target)) return;
    if (!placementAllowed || forField(target.field_id).status !== 'complete') {
      setDeleteTarget(null);
      setMessage('Check this field again before deleting its marker.');
      return;
    }
    await run(async (inSameView) => {
      await deleteFieldMarker(target, actorId);
      if (inSameView()) onDeleted?.(target.field_id, target.id);
    }, 'Marker deleted.',
      'The deletion could not be confirmed. Check the field again before retrying.');
  }

  const preview = markerDraftPreview(draft, actorId);
  const message = operation === 'checking' ? 'Checking this device for a pending marker…' : resultMessage;
  return { draft, preview, target, setTarget, placing, setPlacing, saving: operation !== null, message, canEdit, begin, place, patch, cancel, save, remove };
}
