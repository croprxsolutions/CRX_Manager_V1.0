import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { assertRpcResult, checkMutationResult, supabase } from './db';
import { Sentry } from './sentry';
import type { FieldObstacle, FieldObstacleKind } from '../types';

export const MARKER_NOTE_LIMIT = 500;
export const MARKER_REQUEST_TIMEOUT_MS = 15_000;

export interface MarkerPlacement {
  id: string;
  field_id: string;
  kind: FieldObstacleKind;
  label: string | null;
  point_geojson: FieldObstacle['point_geojson'];
}

interface MarkerSnapshot {
  available: boolean;
  count?: number;
  markers?: FieldObstacle[];
}

export class MarkerSignalError extends Error {}
export class MarkerAccessDenied extends Error {}

export async function readFieldMarkers(fieldId: string, signal: AbortSignal): Promise<MarkerSnapshot> {
  const { data, error, status } = await supabase.rpc('get_field_marker_read', { p_field_id: fieldId }).abortSignal(signal);
  if (error && status === 0) throw new MarkerSignalError('Field marker connection unavailable');
  if (error) throw error;
  return assertRpcResult<MarkerSnapshot>(data, 'get_field_marker_read');
}

export async function readMarkerAuthors(markers: FieldObstacle[], signal: AbortSignal) {
  const ids = [...new Set(markers.flatMap((marker) => marker.created_by ? [marker.created_by] : []))];
  if (ids.length === 0) return { authors: new Map<string, string>(), authorsUnavailable: false };
  const { data, error } = await supabase.from('profile_public_view').select('id, full_name').in('id', ids).abortSignal(signal);
  if (error) {
    if (!signal.aborted) Sentry.captureException(new Error('Could not read field marker authors'), { tags: { action: 'read_field_marker_authors' } });
    return { authors: new Map<string, string>(), authorsUnavailable: true };
  }
  const authors = new Map((data ?? []).flatMap((profile) =>
    profile.id && profile.full_name ? [[profile.id, profile.full_name] as const] : [],
  ));
  return { authors, authorsUnavailable: false };
}

async function markerRequest<T>(actorId: string, request: (authorization: string, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timedOut = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new MarkerSignalError('Field marker write timed out')), { once: true });
  });
  const timeout = setTimeout(() => controller.abort(), MARKER_REQUEST_TIMEOUT_MS);
  async function submit() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (controller.signal.aborted) throw new MarkerSignalError('Field marker write timed out');
    if (isAuthRetryableFetchError(error)) throw new MarkerSignalError('Field marker connection unavailable');
    if (error || session?.user.id !== actorId) throw new Error('The marker account changed.');
    return request(`Bearer ${session.access_token}`, controller.signal);
  }
  try {
    return await Promise.race([submit(), timedOut]);
  } finally {
    clearTimeout(timeout);
  }
}

type MarkerIdentity = Pick<MarkerPlacement, 'id' | 'field_id'>;

function verifyCreatedMarker(row: { id: string; field_id: string; created_by: string | null } | null,
  placement: MarkerIdentity, actorId: string) {
  if (row?.id !== placement.id || row.field_id !== placement.field_id || row.created_by !== actorId) {
    throw new Error('Marker confirmation did not match the saved marker.');
  }
}

async function checkCreateReceipt(placement: MarkerIdentity, authorization: string, signal: AbortSignal) {
  const { data, error, status } = await supabase.rpc('get_field_marker_create_result', {
    p_field_id: placement.field_id, p_marker_id: placement.id,
  }).setHeader('Authorization', authorization).abortSignal(signal);
  if (error && status === 0) throw new MarkerSignalError('Field marker connection unavailable');
  if (error) throw error;
  const result = assertRpcResult<{ state?: unknown }>(data, 'get_field_marker_create_result');
  if (result.state === 'saved' || result.state === 'removed' || result.state === 'missing') return result.state;
  if (result.state === 'unavailable') throw new MarkerAccessDenied('Field marker access is unavailable');
  throw new Error('The field could not be checked for the saved marker.');
}

export function checkPendingMarker(placement: MarkerIdentity, actorId: string) {
  return markerRequest(actorId, (authorization, signal) => checkCreateReceipt(placement, authorization, signal));
}

export function createFieldMarker(
  placement: MarkerPlacement,
  actorId: string,
  startReservedWrite: <T>(send: (sessionSignal: AbortSignal) => Promise<T>) => Promise<T>,
): Promise<'saved' | 'removed' | 'rejected'> {
  return markerRequest(actorId, async (authorization, signal) => {
    const state = await checkCreateReceipt(placement, authorization, signal);
    if (state !== 'missing') return state;
    const response = await startReservedWrite(async (sessionSignal) => {
      if (signal.aborted || sessionSignal.aborted) throw new MarkerSignalError('The pending marker write was canceled');
      const write = new AbortController();
      const cancel = () => write.abort();
      signal.addEventListener('abort', cancel, { once: true });
      sessionSignal.addEventListener('abort', cancel, { once: true });
      try {
        return await supabase.from('field_obstacles').insert(placement).select('id, field_id, created_by')
          .setHeader('Authorization', authorization).abortSignal(write.signal).single();
      } finally {
        signal.removeEventListener('abort', cancel);
        sessionSignal.removeEventListener('abort', cancel);
      }
    });
    if (response.error?.code === '23505') {
      const state = await checkCreateReceipt(placement, authorization, signal);
      if (state !== 'missing') return state;
    }
    if (response.error?.code === '42501') throw new MarkerAccessDenied('Field marker access is unavailable');
    if (response.error?.code === '22023' && ['FIELD_MARKER_POINT_INVALID', 'FIELD_MARKER_NOTE_TOO_LONG'].includes(response.error.message)) {
      const state = await checkCreateReceipt(placement, authorization, signal);
      return state === 'missing' ? 'rejected' : state;
    }
    checkMutationResult(response, 'Add field marker');
    verifyCreatedMarker(response.data, placement, actorId);
    return 'saved';
  });
}

export function editFieldMarker(marker: FieldObstacle, actorId: string, changes: Partial<Pick<MarkerPlacement, 'kind' | 'label' | 'point_geojson'>>) {
  return markerRequest(actorId, async (authorization, signal) => {
    const response = await supabase.from('field_obstacles').update(changes)
      .eq('id', marker.id).eq('field_id', marker.field_id).eq('updated_at', marker.updated_at).select('id')
      .setHeader('Authorization', authorization).abortSignal(signal);
    checkMutationResult(response, 'Edit field marker');
  });
}

export function deleteFieldMarker(marker: FieldObstacle, actorId: string) {
  return markerRequest(actorId, async (authorization, signal) => {
    const response = await supabase.from('field_obstacles').delete()
      .eq('id', marker.id).eq('field_id', marker.field_id).eq('updated_at', marker.updated_at).select('id')
      .setHeader('Authorization', authorization).abortSignal(signal);
    checkMutationResult(response, 'Delete field marker');
  });
}
