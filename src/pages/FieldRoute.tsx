/**
 * Field Mode — driver mobile workspace ("My Route").
 *
 * Phone-first list of open delivery stops the logged-in user can see. Access is
 * enforced server-side by the `del_select` RLS policy: admins/sales-reps see all
 * open stops; a driver sees only stops ASSIGNED to them. Assignment is done by a
 * dispatcher (desktop or an admin in Field Mode) — there is no driver self-claim
 * (drivers can't see unassigned stops under RLS; owner decision 2026-06-14).
 *
 * Additive surface — never edits DeliveryDetail.tsx. Tapping a stop opens the
 * per-stop runner (/my-route/:id). See docs/roadmap/field-mode-build-plan.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, Wifi, WifiOff, ChevronRight, RefreshCw, PackageCheck, AlertTriangle } from 'lucide-react';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { supabase } from '../lib/db';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../contexts/AuthContext';
import { getQueueSummary, type OfflineQueueSummary } from '../lib/offlineQueue';
import { parseLocalDate } from '../lib/dateUtils';
import { Sentry } from '../lib/sentry';
import { fetchDriverFarms } from '../lib/driverFarms';
import { OPEN_STOP_STATUSES, ROUTE_NO_SIGNAL_MESSAGE, sortRouteStops } from '../lib/routeStops';
import DoneTodayList from '../components/route/DoneTodayList';
import SavedCopyBanner from '../components/route/SavedCopyBanner';
import { readTodaySnapshot, saveTodaySnapshot } from '../lib/todaySnapshot';

const EMPTY_QUEUE_SUMMARY: OfflineQueueSummary = {
  ownedTotal: 0,
  ownedAutoSyncable: 0,
  ownedNeedsAttention: 0,
  ownedOfficeResolved: 0,
  otherUserTotal: 0,
  ownerUnknownTotal: 0,
  nextAutoSyncAt: null,
};

interface StopRow {
  id: string;
  delivery_number: string | null;
  status: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  priority: string | null;
  assigned_driver: string | null;
  delivery_notes: string | null;
  customer_id: string | null;
  customer: { farm_name: string | null } | null;
}

// What My Route keeps on the phone for a dead spot: only what the list shows (src/lib/todaySnapshot.ts).
const ROUTE_SNAPSHOT = 'route';
type SavedStop = Omit<StopRow, 'priority' | 'customer_id'>;

function toSavedStop(row: StopRow): SavedStop {
  return {
    id: row.id, delivery_number: row.delivery_number, status: row.status, scheduled_date: row.scheduled_date,
    scheduled_time: row.scheduled_time, assigned_driver: row.assigned_driver, delivery_notes: row.delivery_notes,
    customer: { farm_name: row.customer?.farm_name ?? null },
  };
}

/** Today's saved route (read-only), or null when there is none. */
function readSavedRoute(userId: string | null): { stops: StopRow[]; savedAt: string } | null {
  const saved = readTodaySnapshot<SavedStop[]>(ROUTE_SNAPSHOT, userId);
  if (!saved || !Array.isArray(saved.data)) return null;
  return { stops: saved.data.map((row) => ({ ...row, priority: null, customer_id: null })), savedAt: saved.savedAt };
}

function formatStopDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = parseLocalDate(dateStr);
  if (!d) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function FieldRoute() {
  const navigate = useNavigate();
  const isOnline = useOnlineStatus();
  const { profile } = useAuth();
  const isDriver = profile?.role === 'driver';
  const userId = profile?.id ?? null;

  const [stops, setStops] = useState<StopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // When the last load failed and today's saved copy is shown instead: when that copy was loaded.
  const [savedCopyAt, setSavedCopyAt] = useState<string | null>(null);
  const [queueSummary, setQueueSummary] = useState<OfflineQueueSummary>(EMPTY_QUEUE_SUMMARY);
  const stopRequestSequence = useRef(0);

  const fetchStops = useCallback(async () => {
    const requestSequence = ++stopRequestSequence.current;
    setLoading(true);
    setLoadError(false);
    // No app-side filter: del_select RLS scopes a driver to their assigned rows
    // (admins/reps see all). Ordering: in_progress first, then date.
    const { data, error } = await supabase
      .from('deliveries')
      // A driver's farm names come from the driver lookup below, never the customers table (#2018).
      .select(`id, delivery_number, status, scheduled_date, scheduled_time, priority, assigned_driver, delivery_notes, customer_id${isDriver ? '' : ', customer:customers(farm_name)'}`)
      .is('deleted_at', null)
      .in('status', OPEN_STOP_STATUSES)
      .order('scheduled_date', { ascending: true })
      .order('scheduled_time', { ascending: true, nullsFirst: false });

    if (requestSequence !== stopRequestSequence.current) return;

    // A failed load shows today's saved copy when there is one (read-only), else the error.
    const showLoadFailure = () => {
      const saved = readSavedRoute(userId);
      setStops(saved?.stops ?? []);
      setSavedCopyAt(saved?.savedAt ?? null);
      setLoadError(!saved);
      setLoading(false);
    };

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-route' } });
      showLoadFailure();
      return;
    }

    let rows = sortRouteStops((data || []) as unknown as StopRow[]);
    // A driver reads farm names through get_driver_customers (#2018), not the customers table.
    if (isDriver) {
      try {
        const farms = await fetchDriverFarms(rows.map((row) => row.customer_id));
        if (requestSequence !== stopRequestSequence.current) return;
        rows = rows.map((row) => ({ ...row, customer: { farm_name: farms.get(row.customer_id ?? '')?.farm_name ?? null } }));
      } catch (farmErr) {
        if (requestSequence !== stopRequestSequence.current) return;
        Sentry.captureException(farmErr, { tags: { source: 'fetch', page: 'field-route' } });
        showLoadFailure();
        return;
      }
    }
    if (userId) saveTodaySnapshot(ROUTE_SNAPSHOT, userId, rows.map(toSavedStop));
    setSavedCopyAt(null);
    setStops(rows);
    setLoading(false);
  }, [isDriver, userId]);

  useEffect(() => {
    void fetchStops();
    return () => {
      stopRequestSequence.current += 1;
    };
  }, [fetchStops]);

  useEffect(() => {
    let active = true;
    const checkQueue = () => {
      getQueueSummary(profile?.id ?? null)
        .then((summary) => { if (active) setQueueSummary(summary); })
        .catch(() => { /* IndexedDB unavailable — ignore */ });
    };
    checkQueue();
    const interval = setInterval(checkQueue, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isOnline, profile?.id, stops]);

  const ownedWaiting = queueSummary.ownedTotal
    - queueSummary.ownedNeedsAttention
    - queueSummary.ownedOfficeResolved;
  const hasSavedOfflineWork = queueSummary.ownedTotal > 0
    || queueSummary.otherUserTotal > 0
    || queueSummary.ownerUnknownTotal > 0;

  return (
    <div className="max-w-2xl mx-auto px-4 py-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <Truck className="w-5 h-5 text-crx-green" />
          My Route
        </h1>
        <button
          type="button"
          onClick={fetchStops}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 active:scale-95"
          aria-label="Refresh stops"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* Online / offline status */}
      <div
        className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 mb-3 text-sm font-medium ${
          isOnline ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
        }`}
      >
        {isOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4 shrink-0" />}
        <span className="min-w-0 flex-1">{isOnline ? 'Online' : ROUTE_NO_SIGNAL_MESSAGE}</span>
        {hasSavedOfflineWork && (
          <span className="ml-auto inline-flex items-center gap-1 text-amber-800">
            <PackageCheck className="w-4 h-4" />
            {queueSummary.ownedOfficeResolved > 0
              ? `${queueSummary.ownedOfficeResolved} office resolution${queueSummary.ownedOfficeResolved !== 1 ? 's' : ''} to acknowledge`
              : queueSummary.ownedNeedsAttention > 0
              ? `${queueSummary.ownedNeedsAttention} need attention`
              : ownedWaiting > 0
                ? `${ownedWaiting} waiting to sync`
                : queueSummary.otherUserTotal > 0
                  ? 'Another user has saved offline work'
                  : 'Older offline work needs support'}
          </span>
        )}
      </div>

      <SavedCopyBanner
        what="your route"
        savedAt={savedCopyAt}
        blocked="You can't complete stops until signal returns."
        onRetry={() => void fetchStops()}
        retrying={loading}
        className="mb-3"
      />

      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : loadError ? (
        <div className="text-center py-12">
          <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
          <p className="text-gray-700 font-medium">Couldn't load your stops</p>
          <button
            type="button"
            onClick={fetchStops}
            className="mt-3 inline-flex min-h-[44px] items-center px-3 text-base text-crx-green font-medium underline"
          >
            Try again
          </button>
        </div>
      ) : stops.length === 0 ? (
        <div className="text-center py-12">
          <Truck className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">No open stops right now</p>
          <button
            type="button"
            onClick={() => navigate('/deliveries')}
            className="mt-3 inline-flex min-h-[44px] items-center px-3 text-base text-crx-green font-medium underline"
          >
            Go to all deliveries
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {stops.map((stop) => {
            const dateLabel = formatStopDate(stop.scheduled_date);
            return (
              <li key={stop.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/my-route/${stop.id}`)}
                  className="w-full text-left bg-white border border-gray-200 rounded-xl px-4 py-3 min-h-[80px] flex items-center gap-3 hover:border-crx-green active:scale-[0.99] transition"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900 truncate">
                        {stop.customer?.farm_name || 'Unknown customer'}
                      </span>
                      <Badge variant={statusToBadgeVariant[stop.status] || 'default'}>
                        {stop.status === 'in_progress' ? 'In progress' : 'Not started'}
                      </Badge>
                    </div>
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {stop.delivery_number && <span>{stop.delivery_number}</span>}
                      {dateLabel && <span>{dateLabel}</span>}
                      {stop.scheduled_time && <span>{stop.scheduled_time}</span>}
                      {!stop.assigned_driver && <span className="text-amber-600">Unassigned</span>}
                    </div>
                    {stop.delivery_notes && (
                      <p className="text-base text-gray-900 mt-1 whitespace-pre-wrap break-words">{stop.delivery_notes}</p>
                    )}
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <DoneTodayList isDriver={isDriver} />
    </div>
  );
}
