import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MailWarning } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import Button from '../ui/Button';
import { RECEIPTS_TO_CHECK_PAGE, receiptsToCheckFilter } from '../../lib/receiptsToCheck';

// KI-25: customer receipts the server could not confirm it sent (needs_check), plus owed ones still waiting after
// an hour. The office opens the delivery and uses Email Confirmation. Visible to admins and sales reps (RLS).
interface ReceiptRow {
  id: string;
  delivery_id: string;
  status: string;
  last_error: string | null;
  created_at: string;
  deliveries: { delivery_number: string | null; status: string | null } | null;
  customers: { farm_name: string | null; email: string | null } | null;
}

// Email Confirmation only shows on a completed delivery whose customer has an email, so say what to do otherwise.
function nextStep(row: ReceiptRow): string | null {
  if (row.deliveries?.status !== 'completed') return 'Delivery is no longer completed, so no receipt is owed.';
  if (!row.customers?.email?.trim()) return 'No customer email on file. Add one, or contact the customer directly.';
  return null;
}

export default function ReceiptsToCheck() {
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      setLoading(true);
      void supabase
        .from('delivery_receipt_queue')
        .select(
          'id, delivery_id, status, last_error, created_at, deliveries(delivery_number, status), customers(farm_name, email)',
          { count: 'exact' },
        )
        .or(receiptsToCheckFilter(new Date()))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }) // a stable order, so "Show more" never skips or repeats a row
        .range(0, pages * RECEIPTS_TO_CHECK_PAGE - 1)
        .then(({ data, error, count }) => {
          if (!live || mine !== latest) return; // a newer load has started; its answer wins
          setLoading(false);
          if (error) {
            Sentry.captureException(error, { level: 'warning', extra: { context: 'Receipts to check list failed to load' } });
            setFailed(true);
            return;
          }
          const list = (data ?? []) as unknown as ReceiptRow[];
          setFailed(false);
          setRows(list);
          setTotal(Math.max(count ?? 0, list.length));
        });
    };
    load();
    // The sender keeps working in the background, so re-check whenever the office comes back to this tab.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pages]);

  if (failed) {
    return (
      <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Could not load the list of customer receipts to check. Refresh the page to try again.
      </p>
    );
  }
  if (rows.length === 0) return null;
  return (
    <section aria-label="Customer receipts to check" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <h2 className="flex items-center gap-2 font-semibold">
        <MailWarning className="w-4 h-4" aria-hidden="true" />
        Customer receipts to check ({total})
      </h2>
      <p className="mt-1 text-amber-800">
        These delivery receipts were not confirmed as emailed. Open the delivery and use Email Confirmation if the customer still needs one.
      </p>
      <ul className="mt-2 divide-y divide-amber-200">
        {rows.map((row) => {
          const step = nextStep(row);
          return (
            <li key={row.id} className="py-2 flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
              <Link to={`/deliveries/${row.delivery_id}`} className="font-medium text-amber-900 underline">
                {row.deliveries?.delivery_number || 'Delivery'}
              </Link>
              <span>{row.customers?.farm_name || 'Customer'}</span>
              <span className="text-amber-800">
                {row.status === 'needs_check' ? (row.last_error || 'Needs checking.') : 'Still waiting to send after an hour.'}
                {step && <> {step}</>}
              </span>
              <span className="text-xs text-amber-700 sm:ml-auto">{new Date(row.created_at).toLocaleDateString()}</span>
            </li>
          );
        })}
      </ul>
      {rows.length < total && (
        <div className="mt-2">
          <Button variant="secondary" size="sm" showChevron={false} loading={loading} onClick={() => setPages((p) => p + 1)}>
            Show more ({total - rows.length} not shown)
          </Button>
        </div>
      )}
    </section>
  );
}
