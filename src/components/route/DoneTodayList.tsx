/**
 * My Route's "Done today": the stops completed today, so a driver can check a finished stop saved.
 * Read-only. Loads when opened (and again each time it is reopened); tapping a stop opens its delivery
 * detail, which is where FieldStop already sends a completed stop.
 */
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchDoneTodayStops, type DoneTodayStop } from '../../lib/routeStops';
import { Sentry } from '../../lib/sentry';

function completedTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function DoneTodayList({ isDriver }: { isDriver: boolean }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [stops, setStops] = useState<DoneTodayStop[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(false);
    try {
      const rows = await fetchDoneTodayStops(isDriver);
      if (seq !== requestSeq.current) return;
      setStops(rows);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-route-done-today' } });
      setStops([]);
      setLoadError(true);
    }
    setLoading(false);
  }, [isDriver]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
    else requestSeq.current += 1;
  };

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-left font-semibold text-gray-900"
      >
        <CheckCircle2 className="w-5 h-5 text-crx-green shrink-0" aria-hidden="true" />
        Done today
        {open && !loading && !loadError && <span className="text-gray-700 font-normal">({stops.length})</span>}
        <ChevronDown className={`ml-auto w-5 h-5 text-gray-600 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="mt-2">
          {loading ? (
            <p className="px-1 py-3 text-base text-gray-700">Loading…</p>
          ) : loadError ? (
            <div className="px-1 py-3">
              <p className="text-base text-gray-900">Couldn't load today's finished stops.</p>
              <button type="button" onClick={() => void load()} className="mt-1 inline-flex min-h-[44px] items-center text-base font-medium text-crx-green underline">
                Try again
              </button>
            </div>
          ) : stops.length === 0 ? (
            <p className="px-1 py-3 text-base text-gray-700">No stops completed yet today.</p>
          ) : (
            <ul className="space-y-2">
              {stops.map((stop) => (
                <li key={stop.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/deliveries/${stop.id}`)}
                    className="flex min-h-[64px] w-full items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left hover:border-crx-green"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block font-semibold text-gray-900 break-words">{stop.farm_name || 'Unknown customer'}</span>
                      <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-gray-700">
                        {stop.delivery_number && <span>{stop.delivery_number}</span>}
                        {completedTime(stop.completed_at) && <span>Completed {completedTime(stop.completed_at)}</span>}
                        {stop.signed_by && <span className="break-words">Signed by {stop.signed_by}</span>}
                      </span>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-500 shrink-0" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
