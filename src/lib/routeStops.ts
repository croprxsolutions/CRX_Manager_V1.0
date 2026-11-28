/**
 * Shared rules for the driver's route (My Route list and the per-stop runner): which stops are open, the
 * order My Route shows them in, the stop that "Next Stop" opens, and the no-signal wording.
 */
import { supabase } from './db';
import { businessDayStartIso, todayInBusinessTz } from './dateUtils';
import { fetchDriverFarms } from './driverFarms';

/** The statuses My Route lists. */
export const OPEN_STOP_STATUSES = ['scheduled', 'in_progress'];

/**
 * What both driver screens say with no signal. Starting and completing a stop are never queued offline
 * (Goal 5, Mason 2026-10-15: FieldStop's Arrive and Complete refuse without signal), so neither screen may
 * claim changes are saved on the phone.
 */
export const ROUTE_NO_SIGNAL_MESSAGE = 'No signal. Stops can only be started or completed with signal; nothing on your route is saved offline.';

interface RouteOrderFields {
  status: string;
  scheduled_date: string | null;
}

/** My Route's order: in-progress stops first, then by date. The query already sorts by date and time; the sort is stable. */
export function sortRouteStops<T extends RouteOrderFields>(rows: T[]): T[] {
  const rank = (status: string) => (status === 'in_progress' ? 0 : 1);
  return rows.slice().sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (a.scheduled_date || '').localeCompare(b.scheduled_date || '');
  });
}

/**
 * The next stop on today's route after `currentId`, in My Route's order: an in-progress stop, or an open stop
 * scheduled today or earlier. Null when none remain (later days stay on My Route). Throws on a failed read.
 */
export async function fetchNextRouteStopId(currentId: string): Promise<string | null> {
  // No app-side driver filter, as on My Route: del_select scopes a driver to their assigned rows.
  const { data, error } = await supabase
    .from('deliveries')
    .select('id, status, scheduled_date, scheduled_time')
    .is('deleted_at', null)
    .in('status', OPEN_STOP_STATUSES)
    .order('scheduled_date', { ascending: true })
    .order('scheduled_time', { ascending: true, nullsFirst: false });
  if (error) throw error;
  const today = todayInBusinessTz();
  const rows = (data ?? []) as unknown as (RouteOrderFields & { id: string })[];
  const next = sortRouteStops(rows).find((row) => row.id !== currentId
    && (row.status === 'in_progress' || (!!row.scheduled_date && row.scheduled_date <= today)));
  return next?.id ?? null;
}

/** A stop completed today, as the "Done today" list on My Route shows it. */
export interface DoneTodayStop {
  id: string;
  delivery_number: string | null;
  completed_at: string | null;
  signed_by: string | null;
  farm_name: string | null;
}

interface DoneTodayRow extends Omit<DoneTodayStop, 'farm_name'> {
  customer_id: string | null;
  customer?: { farm_name: string | null } | null;
}

/**
 * Stops completed since the start of today (business time zone), newest first. Read-only; throws on a failed
 * read. A driver's farm names come from the driver lookup, never the customers table (#2018), as on My Route.
 */
export async function fetchDoneTodayStops(isDriver: boolean): Promise<DoneTodayStop[]> {
  const { data, error } = await supabase
    .from('deliveries')
    .select(`id, delivery_number, customer_id, completed_at, signed_by${isDriver ? '' : ', customer:customers(farm_name)'}`)
    .is('deleted_at', null)
    .eq('status', 'completed')
    .gte('completed_at', businessDayStartIso(todayInBusinessTz()))
    .order('completed_at', { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as unknown as DoneTodayRow[];
  const farms = isDriver ? await fetchDriverFarms(rows.map((row) => row.customer_id)) : null;
  return rows.map(({ customer_id, customer, ...row }) => ({
    ...row,
    farm_name: (farms ? farms.get(customer_id ?? '')?.farm_name : customer?.farm_name) ?? null,
  }));
}
