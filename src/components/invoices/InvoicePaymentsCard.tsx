/**
 * InvoicePaymentsCard — the payments on this invoice (M9, design v73). An admin's ⋯ on a check payment line holds
 * "Mark check as returned", which opens the returned-check form with that check picked. Other payments get no item.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import Card from '../ui/Card';
import Badge from '../ui/Badge';
import ActionMenu from '../ui/ActionMenu';
import RefundOrReturnDialog from '../prepay/RefundOrReturnDialog';
import { supabase } from '../../lib/db';
import { fetchAllRows } from '../../lib/pagedRead';
import { formatCents as fmt } from '../../lib/money';
import { fmtDay, loadReturnedPayments } from '../../lib/m9Reversals';
import { Sentry } from '../../lib/sentry';
import { toSentryError } from '../../lib/sentryError';

interface PaymentLine {
  setId: string;
  customerId: string;
  date: string | null;
  method: string | null;
  reference: string;
  cents: number;
  totalCents: number;
  /** The paying customer: a split payer can be another farm than the invoice's (Sol r1 MED 10). */
  payerName: string | null;
}

interface Props {
  invoiceId: string;
  invoiceNumber: string;
  farmName: string;
  isAdmin: boolean;
  /** A check was marked returned: reload the invoice (it owes again). */
  onChanged: () => void;
  className?: string;
}

interface AllocRow {
  id: string;
  allocation_set_id: string;
  amount_cents: number;
  allocation_sets: { id: string; customer_id: string | null; is_active: boolean; entity_type: string; payment_method: string | null; check_number: string | null; reference_number: string | null; payment_date: string | null; total_payment_cents: number | null; customers?: { farm_name: string | null } | null } | null;
}

export default function InvoicePaymentsCard({ invoiceId, invoiceNumber, farmName, isAdmin, onChanged, className = '' }: Props) {
  const [lines, setLines] = useState<PaymentLine[]>([]);
  // null: the returned status could not be read, so no line offers Return.
  const [returnedOn, setReturnedOn] = useState<Map<string, string> | null>(new Map());
  const loadSeq = useRef(0);
  const [returning, setReturning] = useState<PaymentLine | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const { data, error } = await fetchAllRows<AllocRow>((from, to) => supabase.from('invoice_line_allocations')
      .select('id, allocation_set_id, amount_cents, allocation_sets!invoice_line_allocations_allocation_set_id_fkey ( id, customer_id, is_active, entity_type, payment_method, check_number, reference_number, payment_date, total_payment_cents, customers!allocation_sets_customer_id_fkey ( farm_name ) )', { count: 'exact' })
      .eq('invoice_id', invoiceId).order('id').range(from, to) as never);
    if (error) {
      Sentry.captureException(toSentryError(error), { extra: { context: 'invoice_payments_card' } });
      return;
    }
    const bySet = new Map<string, PaymentLine>();
    for (const r of data ?? []) {
      const s = r.allocation_sets;
      if (!s || !s.is_active || s.entity_type !== 'payment') continue;
      const prev = bySet.get(s.id);
      bySet.set(s.id, {
        setId: s.id, customerId: s.customer_id ?? '', date: s.payment_date, method: s.payment_method,
        reference: s.check_number || s.reference_number || '—', cents: (prev?.cents ?? 0) + Number(r.amount_cents), totalCents: Number(s.total_payment_cents ?? 0),
        payerName: s.customers?.farm_name ?? null,
      });
    }
    const list = [...bySet.values()].sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : 1));
    // The returned status first, so a returned check never offers Return again (Sol r1 MED 8). A failed read
    // shows the payments without the menu.
    let returned: Map<string, string> | null = new Map();
    if (isAdmin && list.length) {
      try { returned = await loadReturnedPayments(list.map((l) => l.setId)); } catch (err) {
        Sentry.captureException(toSentryError(err), { extra: { context: 'invoice_payments_returned' } });
        returned = null;
      }
    }
    if (seq !== loadSeq.current) return;
    setReturnedOn(returned);
    setLines(list);
  }, [invoiceId, isAdmin]);
  useEffect(() => { void load(); }, [load]);

  if (lines.length === 0) return null;

  return (
    <Card padding={false} className={className}>
      <section aria-labelledby="invoice-payments-title">
        <h2 id="invoice-payments-title" className="px-5 pb-3 pt-5 font-heading text-xl font-semibold text-nav-dark">Payments</h2>
        <table className="phone-stack w-full text-sm" aria-label="Payments on this invoice">
          <thead>
            <tr className="border-y border-gray-100 bg-cream-dark/50">
              <th className="px-5 py-2.5 text-left font-medium text-secondary">Date</th>
              <th className="px-4 py-2.5 text-left font-medium text-secondary">Method</th>
              <th className="px-4 py-2.5 text-left font-medium text-secondary">Reference</th>
              <th className="px-4 py-2.5 text-right font-medium text-secondary">Amount</th>
              <th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const returned = returnedOn?.get(l.setId);
              return (
                <tr key={l.setId} className="border-b border-gray-50">
                  <td className="px-5 py-3 tabular-nums">{l.date ? fmtDay(l.date) : '—'}</td>
                  <td data-label="Method" className="px-4 py-3 capitalize">{l.method ?? '—'}</td>
                  <td data-label="Reference" className="px-4 py-3">{l.reference}{returned && <Badge variant="danger" className="ml-2">Returned</Badge>}</td>
                  <td data-label="Amount" className="px-4 py-3 text-right font-semibold tabular-nums">{fmt(l.cents)}</td>
                  <td className="px-4 py-2 text-right">
                    {isAdmin && returnedOn && l.method === 'check' && !returned && (
                      <ActionMenu label={`More actions for check ${l.reference}`} items={[{
                        id: 'return', label: 'Mark check as returned', icon: <RotateCcw className="h-4 w-4 text-red-700" />,
                        description: `Returns all of check ${l.reference} (${fmt(l.totalCents)}). Opens with the check picked.`,
                        onAction: () => setReturning(l),
                      }]} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {returning && (
        <RefundOrReturnDialog
          open
          onClose={() => setReturning(null)}
          onRecorded={() => { onChanged(); void load(); }}
          customerId={returning.customerId}
          farmName={returning.payerName ?? farmName}
          allocationSetId={returning.setId}
          fromLabel={invoiceNumber}
        />
      )}
    </Card>
  );
}
