import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserX } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { parseLocalDate } from '../../lib/dateUtils';
import Button from '../ui/Button';

// A scheduled delivery with no driver is on nobody's My Route, so the office is told here. "Open, no driver"
// is the same rule the database uses for a driver's Available list (get_available_deliveries_for_driver):
// status scheduled, assigned_driver empty, not deleted. Read only; visible to admins and sales reps (RLS).
const PAGE = 25;

interface UnassignedRow {
  id: string;
  delivery_number: string | null;
  scheduled_date: string | null;
  customer: { farm_name: string | null } | null;
}

export default function UnassignedDeliveriesBanner() {
  const [rows, setRows] = useState<UnassignedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      setLoading(true);
      void supabase
        .from('deliveries')
        .select('id, delivery_number, scheduled_date, customer:customers(farm_name)', { count: 'exact' })
        .eq('status', 'scheduled')
        .is('assigned_driver', null)
        .is('deleted_at', null)
        .order('scheduled_date', { ascending: true })
        .order('id', { ascending: true }) // a stable order, so "Show more" never skips or repeats a row
        .range(0, pages * PAGE - 1)
        .then(({ data, error, count }) => {
          if (!live || mine !== latest) return; // a newer load has started; its answer wins
          setLoading(false);
          if (error) {
            // A warning only: the list below still shows "Unassigned" in the Driver column.
            Sentry.captureException(error, { level: 'warning', extra: { context: 'Unassigned deliveries banner failed to load' } });
            return;
          }
          const list = (data ?? []) as unknown as UnassignedRow[];
          setRows(list);
          setTotal(Math.max(count ?? 0, list.length));
        });
    };
    load();
    // Drivers can take deliveries at any time, so re-check whenever the office comes back to this tab.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pages]);

  if (total === 0) return null;
  const noun = total === 1 ? 'scheduled delivery has' : 'scheduled deliveries have';
  return (
    <section aria-label="Scheduled deliveries with no driver" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <UserX className="w-4 h-4" aria-hidden="true" />
          {total} {noun} no driver
        </h2>
        <Button variant="secondary" size="sm" showChevron={false} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show them'}
        </Button>
      </div>
      <p className="mt-1 text-amber-800">They are not on any driver's route. Open one and assign a driver.</p>
      {open && (
        <>
          <ul className="mt-2 divide-y divide-amber-200">
            {rows.map((row) => (
              <li key={row.id} className="py-2 flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
                <Link to={`/deliveries/${row.id}`} className="font-medium text-amber-900 underline">
                  {row.delivery_number || 'Delivery'}
                </Link>
                <span>{row.customer?.farm_name || 'Customer'}</span>
                <span className="text-xs text-amber-700 sm:ml-auto">
                  {row.scheduled_date ? parseLocalDate(row.scheduled_date).toLocaleDateString() : 'No date'}
                </span>
              </li>
            ))}
          </ul>
          {rows.length < total && (
            <div className="mt-2">
              <Button variant="secondary" size="sm" showChevron={false} loading={loading} onClick={() => setPages((p) => p + 1)}>
                Show more ({total - rows.length} not shown)
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
