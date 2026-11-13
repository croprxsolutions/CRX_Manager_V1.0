import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Send } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import Badge from '../ui/Badge';
import { formatUSD as fmt } from '../../lib/money';
import { formatSharePct, invoiceStatusBadge } from '../../lib/statusLabel';

export type SaleInvoice = {
  id: string;
  number: string;
  payerName: string;
  sharePct?: number;
  status: string;
  total: number;
  balance: number;
  /** Shown when the invoice is not a plain sale, e.g. "Credit memo". */
  typeLabel?: string;
  /** Paid so far, prepay included. */
  paid?: number;
};

interface Props {
  invoices: SaleInvoice[];
  canPost: boolean;
  onPostAll: () => Promise<void>;
  posting: boolean;
  /** Shown when there are no invoices. */
  emptyText?: string;
}

const isDraft = (s: string) => s === 'draft' || s === 'unposted';

/** The sale's invoices, one row per invoice and payer, with a checked "post the drafts" action. */
export default function SaleInvoicesCard({
  invoices, canPost, onPostAll, posting,
  emptyText = 'No invoices yet. Product invoices are made after delivery. Record advance payments as prepay.',
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const drafts = invoices.filter((i) => isDraft(i.status));
  const n = drafts.length;
  const postLabel = `Post ${n} draft${n === 1 ? '' : 's'}`;

  return (
    <Card padding={false}>
      <section aria-labelledby="sale-invoices-title">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3">
          <h2 id="sale-invoices-title" className="font-heading text-xl font-semibold text-nav-dark">Invoices</h2>
          {canPost && n > 0 && (
            <Button size="sm" className="min-h-11 md:min-h-0" icon={<Send className="h-4 w-4" />} loading={posting} onClick={() => setConfirming(true)}>
              {postLabel}…
            </Button>
          )}
        </div>
        {invoices.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-secondary">{emptyText}</p>
        ) : (
          <>
            <ul className="px-2">
              {invoices.map((inv) => (
                <li key={inv.id} className="border-t border-gray-100">
                  <Link to={`/invoices/${inv.id}`} className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-3 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <strong className="font-semibold text-nav-dark">{inv.number}</strong>
                      {(inv.payerName || inv.typeLabel) && (
                        <span className="break-words text-sm text-secondary">
                          {[inv.payerName && (inv.sharePct != null ? `${inv.payerName} · ${formatSharePct(inv.sharePct)}` : inv.payerName), inv.typeLabel]
                            .filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    <span className="flex flex-none flex-col items-end gap-1">
                      <strong className="tabular-nums text-nav-dark">{fmt(inv.total)}</strong>
                      {(inv.paid ?? 0) > 0 && <span className="text-xs tabular-nums text-crx-green">Paid {fmt(inv.paid!)}</span>}
                      {!isDraft(inv.status) && inv.balance !== inv.total && (
                        <span className={`text-xs tabular-nums ${inv.balance > 0 ? 'text-red-600' : 'text-crx-green'}`}>{fmt(inv.balance)} due</span>
                      )}
                      <Badge variant={invoiceStatusBadge(inv.status).variant} normalCase>{invoiceStatusBadge(inv.status).label}</Badge>
                    </span>
                    <ChevronRight className="h-4 w-4 flex-none text-secondary" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
            {invoices.length > 1 && (
              <div className="mx-5 flex justify-between border-t border-gray-100 py-4 font-semibold text-nav-dark">
                <span>Total</span>
                <span className="tabular-nums">{fmt(invoices.reduce((sum, i) => sum + i.total, 0))}</span>
              </div>
            )}
          </>
        )}
      </section>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`${postLabel} on this sale?`}
        footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" className="min-h-11 w-full sm:w-auto" onClick={() => setConfirming(false)}>Keep as drafts</Button>
            <Button className="min-h-11 w-full sm:w-auto" icon={<Send className="h-4 w-4" />}
              onClick={() => { setConfirming(false); void onPostAll(); }}>
              {postLabel}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-secondary">Each invoice is checked again before it posts. Any that fail stay drafts, with the reason.</p>
        <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200">
          {drafts.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className="font-medium text-nav-dark">{d.number}</span>
              <span className="min-w-0 flex-1 break-words text-secondary">{d.payerName}</span>
              <span className="tabular-nums font-medium text-nav-dark">{fmt(d.total)}</span>
            </li>
          ))}
        </ul>
      </Modal>
    </Card>
  );
}
