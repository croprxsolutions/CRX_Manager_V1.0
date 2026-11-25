/**
 * CustomerPrepayCards — the customer's Prepay Credits and Prepay History (M9, design v73).
 * Admins also see the prepay balance check ("Doesn't tie" with both numbers), the "Record refund or returned check"
 * button and the history (it reads refunds and returned checks, which only admins may read).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Banknote, CircleX, FileCheck2, History, RotateCcw, Undo2, Wallet } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import HelpTip from '../ui/HelpTip';
import { formatCents as fmt, formatCentsMinus } from '../../lib/money';
import { Sentry } from '../../lib/sentry';
import { toSentryError } from '../../lib/sentryError';
import { businessDay, fetchPrepayTie, fmtDay, loadPrepayHistory, type HistoryKind, type HistoryRow, type PrepayTie } from '../../lib/m9Reversals';
import RefundOrReturnDialog from './RefundOrReturnDialog';
import { useIsPhone } from '../../hooks/useIsPhone';

export interface CustomerPrepayCredit {
  id: string;
  bucket_label: string | null;
  original_amount_cents: number;
  balance_cents: number;
  source_reference?: string | null;
  reference_number?: string | null;
  created_at?: string;
}

interface Props {
  customerId: string;
  farmName: string;
  credits: CustomerPrepayCredit[];
  isAdmin: boolean;
  /** A refund or return was recorded: reload the financials. */
  onChanged: () => void;
}

const ICONS: Record<HistoryKind, { icon: typeof Wallet; cls: string }> = {
  in: { icon: Banknote, cls: 'bg-crx-green-light text-crx-green' },
  out: { icon: FileCheck2, cls: 'bg-gray-100 text-secondary' },
  refund: { icon: Undo2, cls: 'bg-amber-50 text-amber-700' },
  bounce: { icon: CircleX, cls: 'bg-red-50 text-red-700' },
};
const signed = (cents: number) => (cents > 0 ? `+${fmt(cents)}` : formatCentsMinus(cents));

/** "Check 5521 · Mar 2, 2026": where a credit came from and when. */
const creditSource = (c: CustomerPrepayCredit) => [
  c.source_reference || c.reference_number ? `Check ${c.source_reference || c.reference_number}` : '',
  c.created_at ? fmtDay(businessDay(c.created_at)) : '',
].filter(Boolean).join(' · ');

function Title({ title, accent }: { title: string; accent: string }) {
  return <h3 className="font-heading text-lg font-semibold text-nav-dark">{title} <span className="font-light text-secondary">{accent}</span></h3>;
}

export default function CustomerPrepayCards({ customerId, farmName, credits, isAdmin, onChanged }: Props) {
  const [tie, setTie] = useState<PrepayTie | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  // One layout at a time (as DataTable): cards on phones, tables from 768px.
  const isPhone = useIsPhone();

  const load = useCallback(() => {
    if (!isAdmin) return;
    setHistoryFailed(false);
    fetchPrepayTie(customerId).then((rows) => setTie(rows.find((r) => r.customer_id === customerId) ?? null)).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'prepay_tie_customer' } });
      setTie(null);
    });
    loadPrepayHistory(customerId).then(setHistory).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'prepay_history' } });
      setHistoryFailed(true);
    });
  }, [customerId, isAdmin]);
  useEffect(() => { load(); }, [load]);

  const available = credits.reduce((s, c) => s + c.balance_cents, 0);
  const mismatch = isAdmin && tie !== null && !tie.ok;
  if (!isAdmin && credits.length === 0) return null;

  const creditsCard = (
    <Card padding={false}>
      <div className="p-5 pb-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Title title="Prepay" accent="Credits" />
          {mismatch && (
            <span className="inline-flex items-center gap-0.5">
              <span id="tie-badge" className="inline-flex h-6 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs font-medium text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />Doesn't tie · {fmt(Math.abs(tie.difference_cents))}
              </span>
              <HelpTip text="The prepay balance check: the customer's stored prepay total does not match what its credits add up to. Month-End lists every customer that does not tie." />
            </span>
          )}
          <span className="flex-1" />
          {isAdmin && (
            <Button variant="secondary" size="sm" showChevron={false} icon={<RotateCcw className="h-4 w-4" />} onClick={() => setDialogOpen(true)} className="max-md:w-full">
              Record refund or returned check
            </Button>
          )}
        </div>
        {credits.length > 0 && (
          <div className="mt-2.5 flex items-baseline justify-between gap-3">
            <span className="text-secondary">Available prepay</span>
            <span data-testid="available-prepay" className="font-heading text-2xl font-semibold tabular-nums text-crx-green">{fmt(available)}</span>
          </div>
        )}
        {mismatch && (
          <p className="mt-2 flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Stored balance {fmt(tie.stored_cents)} · credits add up to {fmt(tie.credits_cents)}. Refunds use {fmt(tie.credits_cents)}, what the credits hold.{' '}
              <Link to="/month-end" className="font-semibold text-inherit underline">Open Month-End check</Link></span>
          </p>
        )}
      </div>
      {credits.length === 0 ? (
        <div className="flex flex-col items-center px-5 pb-8 pt-2 text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-crx-green-light text-crx-green" aria-hidden="true"><Wallet className="h-5 w-5" /></span>
          <b className="text-[15px] text-nav-dark">No prepay for this customer</b>
          <p className="mt-1 max-w-sm text-sm text-secondary">Prepay shows here when a payment leaves money over. A returned check can still be recorded with the button above.</p>
        </div>
      ) : (
        isPhone ? (
        <ul className="border-t border-gray-100" aria-label="Open prepay credits">
          {credits.map((c) => (
            <li key={c.id} className="border-b border-gray-50 px-4 py-3.5 text-sm last:border-b-0">
              <div className="flex items-baseline justify-between gap-3"><b className="text-nav-dark">{c.bucket_label || 'Prepay'}</b><b className="tabular-nums text-crx-green">{fmt(c.balance_cents)}</b></div>
              <div className="flex items-baseline justify-between gap-3 text-xs text-secondary">
                <span>{creditSource(c)}</span><span className="tabular-nums">of {fmt(c.original_amount_cents)}</span>
              </div>
            </li>
          ))}
        </ul>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Open prepay credits">
            <thead>
              <tr className="border-y border-gray-100 bg-cream-dark/50">
                <th className="px-5 py-2.5 text-left font-medium text-secondary">Credit</th>
                <th className="px-4 py-2.5 text-right font-medium text-secondary">Original</th>
                <th className="px-4 py-2.5 text-right font-medium text-secondary">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((c) => (
                <tr key={c.id} className="border-b border-gray-50">
                  <td className="px-5 py-3">
                    <b className="text-nav-dark">{c.bucket_label || 'Prepay'}</b>
                    {creditSource(c) && <div className="text-xs text-secondary">{creditSource(c)}</div>}
                  </td>
                  <td data-label="Original" className="px-4 py-3 text-right tabular-nums">{fmt(c.original_amount_cents)}</td>
                  <td data-label="Remaining" className="px-4 py-3 text-right font-semibold tabular-nums text-crx-green">{fmt(c.balance_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )
      )}
    </Card>
  );

  const historyCard = isAdmin && (
    <Card padding={false}>
      <div id="prepay-history" className="flex flex-wrap items-center gap-2.5 p-5 pb-3">
        <Title title="Prepay" accent="History" />
        <span className="flex-1" />
        {history && history.length > 0 && <span className="text-xs text-secondary">Newest first · every change is its own row</span>}
      </div>
      {historyFailed ? (
        <p role="alert" className="px-5 pb-5 text-sm text-red-600">The prepay history could not be loaded. Reload the page to try again.</p>
      ) : history === null ? (
        <div className="mx-5 mb-5 h-24 animate-pulse rounded-lg bg-gray-100" />
      ) : history.length === 0 ? (
        <div className="flex flex-col items-center px-5 pb-8 text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-crx-green-light text-crx-green" aria-hidden="true"><History className="h-5 w-5" /></span>
          <b className="text-[15px] text-nav-dark">No prepay activity yet</b>
          <p className="mt-1 max-w-sm text-sm text-secondary">Money received, applied, refunded or reversed will be listed here, newest first.</p>
        </div>
      ) : (
        isPhone ? (
        <ul className="border-t border-gray-100" aria-label="Prepay history">
          {history.map((h) => {
            const { icon: Icon, cls } = ICONS[h.kind];
            return (
              <li key={h.key} className="flex gap-2.5 border-b border-gray-50 px-4 py-3.5 text-sm last:border-b-0">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${cls}`} aria-hidden="true"><Icon className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3"><b className="text-nav-dark">{h.what}</b><b className={`tabular-nums ${h.cents > 0 ? 'text-crx-green' : 'text-nav-dark'}`}>{signed(h.cents)}</b></div>
                  {h.sub && <div className="text-xs text-secondary">{h.sub}</div>}
                  <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-secondary"><span>{fmtDay(h.day)} · {h.by}</span><span className="tabular-nums">after {fmt(h.afterCents)}</span></div>
                  {h.ref && <div className="text-xs text-secondary">{h.ref}</div>}
                </div>
              </li>
            );
          })}
        </ul>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Prepay history">
            <thead>
              <tr className="border-y border-gray-100 bg-cream-dark/50">
                <th className="px-5 py-2.5 text-left font-medium text-secondary">Date</th>
                <th className="px-4 py-2.5 text-left font-medium text-secondary">What happened</th>
                <th className="px-4 py-2.5 text-right font-medium text-secondary">Amount</th>
                <th className="px-4 py-2.5 text-right font-medium text-secondary">Prepay after</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const { icon: Icon, cls } = ICONS[h.kind];
                return (
                  <tr key={h.key} className="border-b border-gray-50 align-top">
                    <td className="whitespace-nowrap px-5 py-3 tabular-nums">{fmtDay(h.day)}</td>
                    <td data-label="What happened" className="px-4 py-3">
                      <div className="flex gap-2.5">
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${cls}`} aria-hidden="true"><Icon className="h-4 w-4" /></span>
                        <div className="min-w-0">
                          <b className="text-nav-dark">{h.what}</b>
                          {h.sub && <div className="text-xs text-secondary">{h.sub}</div>}
                          <div className="text-xs text-secondary">{[h.ref, `by ${h.by}`].filter(Boolean).join(' · ')}</div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Amount" className={`whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums ${h.cents > 0 ? 'text-crx-green' : 'text-nav-dark'}`}>{signed(h.cents)}</td>
                    <td data-label="Prepay after" className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{fmt(h.afterCents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )
      )}
    </Card>
  );

  return (
    <>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {creditsCard}
        {historyCard}
      </div>
      {isAdmin && (
        <RefundOrReturnDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onRecorded={() => { onChanged(); load(); }}
          customerId={customerId}
          farmName={farmName}
        />
      )}
    </>
  );
}
