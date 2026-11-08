import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MailWarning } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { receiptsToCheckFilter } from '../../lib/receiptsToCheck';

// KI-25: customer receipts the server could not confirm it sent (needs_check), plus owed ones still waiting after
// an hour. The office opens the delivery and uses Email Confirmation. Visible to admins and sales reps (RLS).
interface ReceiptRow {
  id: string;
  delivery_id: string;
  status: string;
  last_error: string | null;
  created_at: string;
  deliveries: { delivery_number: string | null } | null;
  customers: { farm_name: string | null } | null;
}

export default function ReceiptsToCheck() {
  const [rows, setRows] = useState<ReceiptRow[]>([]);

  useEffect(() => {
    let live = true;
    const { or, since } = receiptsToCheckFilter(new Date());
    void supabase
      .from('delivery_receipt_queue')
      .select('id, delivery_id, status, last_error, created_at, deliveries(delivery_number), customers(farm_name)')
      .or(or)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (error) {
          Sentry.captureException(error, { level: 'warning', extra: { context: 'Receipts to check list failed to load' } });
          return;
        }
        if (live) setRows((data ?? []) as unknown as ReceiptRow[]);
      });
    return () => { live = false; };
  }, []);

  if (rows.length === 0) return null;
  return (
    <section aria-label="Customer receipts to check" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <h2 className="flex items-center gap-2 font-semibold">
        <MailWarning className="w-4 h-4" aria-hidden="true" />
        Customer receipts to check ({rows.length})
      </h2>
      <p className="mt-1 text-amber-800">
        These delivery receipts were not confirmed as emailed. Open the delivery and use Email Confirmation if the customer still needs one.
      </p>
      <ul className="mt-2 divide-y divide-amber-200">
        {rows.map((row) => (
          <li key={row.id} className="py-2 flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
            <Link to={`/deliveries/${row.delivery_id}`} className="font-medium text-amber-900 underline">
              {row.deliveries?.delivery_number || 'Delivery'}
            </Link>
            <span>{row.customers?.farm_name || 'Customer'}</span>
            <span className="text-amber-800">
              {row.status === 'needs_check' ? (row.last_error || 'Needs checking.') : 'Still waiting to send after an hour.'}
            </span>
            <span className="text-xs text-amber-700 sm:ml-auto">{new Date(row.created_at).toLocaleDateString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
