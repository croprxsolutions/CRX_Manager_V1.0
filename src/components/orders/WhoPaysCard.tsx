import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Lock, Plus, Trash2, User } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { formatUSD as fmt } from '../../lib/money';
import { sharesLeft } from '../../lib/billSplitLock';

/** A card payer. `amount` is their live share of the products in dollars, when the page has it exactly. */
export type WhoPaysShare = { id: string; customerName: string; pct: number; amount?: number };

interface Props {
  mainCustomerName: string;
  shares: WhoPaysShare[];
  /** Dollars of products this split bills (lines with their own payers left out). */
  productsTotal: number;
  lock: { text: string; href?: string; linkLabel?: string } | null;
  /** A field split bills the sale instead of this card. */
  fieldSplitBills: boolean;
  canEdit: boolean;
  saving: boolean;
  /** Resolves true once the payer is saved, so the form closes; false keeps what was typed. */
  onAdd: (customerId: string, pct: number) => void | Promise<boolean>;
  onRemove: (shareId: string) => void;
  customerPicker: ReactNode;
  /** The customer chosen in `customerPicker`. */
  picked?: { id: string; name: string } | null;
  /** Some lines have their own payers, so not every line follows this split. */
  someLinesOwnSplit?: boolean;
  lineSplit?: ReactNode;
}

// The main customer first, then each payer in turn.
const COLORS = ['#1a7a50', '#8fc3a8', '#4f9d78', '#c7e3d3', '#2e5e47', '#a9c9b8'];
const round2 = (n: number) => Math.round(n * 100) / 100;

type Row = { key: string; name: string; pct: number; amount: number; main?: boolean; shareId?: string };

/** Who pays for a sale: the main customer keeps whatever the other payers' percents leave. */
export default function WhoPaysCard({
  mainCustomerName, shares, productsTotal, lock, fieldSplitBills, canEdit, saving,
  onAdd, onRemove, customerPicker, picked, someLinesOwnSplit, lineSplit,
}: Props) {
  // The payer count when the form opened: a reload that brings a new payer (even after a failed reply) closes it.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [pct, setPct] = useState('');
  const [removing, setRemoving] = useState<WhoPaysShare | null>(null);
  const editable = canEdit && !lock;
  const adding = openedAt === shares.length && editable;
  const totalCents = Math.round(productsTotal * 100);

  // Each payer's cents: the page's exact live figure, else floor(cents x percent) as the split writer bills one line.
  // The main customer takes the rest, as _bill_split_line_shares does.
  const rowsFor = (list: Array<WhoPaysShare & { shareId?: string }>): Row[] => {
    const payers = list.map((s) => ({
      key: s.id, name: s.customerName, pct: s.pct, shareId: s.shareId,
      cents: s.amount != null ? Math.round(s.amount * 100) : Number((BigInt(totalCents) * BigInt(Math.round(s.pct * 1_000_000))) / 100_000_000n),
    }));
    const left = sharesLeft(list.map((s) => s.pct));
    const mainCents = totalCents - payers.reduce((sum, p) => sum + p.cents, 0);
    const main = left > 0 ? [{ key: 'main', name: mainCustomerName, pct: round2(left), amount: mainCents / 100, main: true }] : [];
    return [...main, ...payers.map((p) => ({ ...p, pct: round2(p.pct), amount: p.cents / 100 }))];
  };

  const saved = rowsFor(shares.map((s) => ({ ...s, shareId: s.id })));
  const typed = parseFloat(pct);
  const preview = adding && picked && typed > 0
    ? rowsFor([...shares, { id: 'new', customerName: picked.name, pct: typed }])
    : null;

  const openAdd = () => {
    // The card should reach 100%, so the next payer starts at exactly what's left.
    const left = sharesLeft(shares.map((s) => s.pct));
    setPct(shares.length > 0 && left > 0 ? String(left) : '');
    setOpenedAt(shares.length);
  };
  const submit = async () => {
    if (!picked) return;
    if (await onAdd(picked.id, typed)) {
      setOpenedAt(null);
      setPct('');
    }
  };

  const subLine = (r: Row) => {
    const parts = [r.main ? 'Main customer' : '', r.main && preview ? 'keeps the rest' : ''];
    if (!fieldSplitBills) parts.push(`about ${fmt(r.amount)} of products${someLinesOwnSplit ? ' on lines that follow this split' : ''}`);
    return parts.filter(Boolean).join(' · ');
  };

  const bar = (rows: Row[]) => (
    <div role="img" aria-label={rows.map((r) => `${r.name} ${r.pct} percent`).join(', ')} className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
      {rows.map((r, i) => <span key={r.key} style={{ width: `${r.pct}%`, background: COLORS[i % COLORS.length] }} />)}
    </div>
  );

  const list = (rows: Row[], withRemove: boolean) => rows.map((r, i) => (
    <div key={r.key} data-payer className="flex min-h-12 items-center gap-2.5 border-t border-gray-100 py-1.5">
      <span aria-hidden="true" className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium text-nav-dark">{r.name}</span>
        {subLine(r) && <span className="block text-xs text-secondary">{subLine(r)}</span>}
      </span>
      <strong className="tabular-nums">{r.pct}%</strong>
      {withRemove && r.shareId ? (
        <button type="button" aria-label={`Remove ${r.name}`} disabled={saving}
          onClick={() => setRemoving(shares.find((s) => s.id === r.shareId) ?? null)}
          className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-lg text-secondary hover:bg-red-50 hover:text-red-600 disabled:opacity-50 md:h-9 md:w-9">
          <Trash2 className="h-4 w-4" />
        </button>
      ) : <span aria-hidden="true" className="w-11 flex-none md:w-9" />}
    </div>
  ));

  const lockText = () => {
    if (!lock) return null;
    const at = lock.href && lock.linkLabel ? lock.text.indexOf(lock.linkLabel) : -1;
    if (at < 0) return lock.text;
    return <>{lock.text.slice(0, at)}<Link to={lock.href!} className="text-crx-green underline hover:text-crx-green-hover">{lock.linkLabel}</Link>{lock.text.slice(at + lock.linkLabel!.length)}</>;
  };

  const payers = saved.length;

  return (
    <Card>
      <section aria-labelledby="who-pays-title" className="flex min-w-0 flex-col gap-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="who-pays-title" className="font-heading text-xl font-semibold text-nav-dark">Who pays</h3>
            {adding && <p className="text-sm text-secondary">Adding a payer</p>}
          </div>
          {shares.length > 0 && !adding && <span className="text-sm text-secondary">{payers} payer{payers === 1 ? '' : 's'} · 100%</span>}
        </div>

        {lock && (
          <div role="status" className="flex items-start gap-2.5 rounded-lg border border-gray-200 bg-cream px-3 py-2.5 text-sm text-nav-dark">
            <Lock className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span><strong>Locked.</strong> {lockText()}</span>
          </div>
        )}

        {fieldSplitBills && (
          <p className="text-sm text-amber-700">This sale is split by field below, so the field split decides who pays.</p>
        )}

        {adding ? (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2.5">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm font-medium text-secondary">Customer</span>
                {customerPicker}
              </div>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm font-medium text-secondary">Share</span>
                <span className="flex h-11 overflow-hidden md:h-10 rounded-lg border border-gray-300 bg-white focus-within:border-crx-green focus-within:ring-2 focus-within:ring-crx-green/20">
                  <input type="number" aria-label="Share" value={pct} onChange={(e) => setPct(e.target.value)} min="0.01" max="100" step="0.01" disabled={saving}
                    className="w-full min-w-0 px-2.5 text-right text-sm tabular-nums outline-none" />
                  <span aria-hidden="true" className="flex items-center border-l border-gray-200 bg-cream px-2.5 text-sm text-secondary">%</span>
                </span>
              </label>
            </div>
            {preview && (
              <>
                <span className="text-xs font-semibold uppercase tracking-wide text-secondary">Preview</span>
                {bar(preview)}
                <div>{list(preview, false)}</div>
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" className="min-h-11 md:min-h-0" disabled={saving} onClick={() => setOpenedAt(null)}>Cancel</Button>
              <Button className="min-h-11 md:min-h-0" icon={<Check className="h-4 w-4" />} loading={saving} disabled={!picked || !(typed > 0)} onClick={() => void submit()}>
                Add payer
              </Button>
            </div>
          </>
        ) : shares.length === 0 ? (
          <>
            <div className="flex items-center gap-2.5 rounded-lg bg-cream p-3">
              <User className="h-4 w-4 text-secondary" aria-hidden="true" />
              <span className="flex-1"><strong className="font-semibold">{mainCustomerName}</strong> pays 100%</span>
            </div>
            {someLinesOwnSplit && <p className="text-sm text-secondary">Lines with their own payers are split below.</p>}
            {editable && (
              <>
                <Button variant="secondary" className="min-h-11 self-start md:min-h-0" icon={<Plus className="h-4 w-4" />} disabled={saving} onClick={openAdd}>Add a payer</Button>
                <p className="text-sm text-secondary">Split the whole sale by percent. You can also give one line its own payers.</p>
              </>
            )}
          </>
        ) : (
          <>
            {bar(saved)}
            <div>{list(saved, editable)}</div>
            {editable && (
              <Button variant="ghost" size="sm" className="min-h-11 self-start text-crx-green md:min-h-0" icon={<Plus className="h-4 w-4" />} disabled={saving} onClick={openAdd}>
                Add a payer
              </Button>
            )}
            <p className="text-sm text-secondary">
              {someLinesOwnSplit ? 'Lines without their own payers follow this split.' : 'Each line follows this split.'}
              {' '}Charges, discount and tax are worked out on each payer&apos;s invoice.
            </p>
          </>
        )}

        {lineSplit && (
          <details open={someLinesOwnSplit || undefined} className="border-t border-gray-100 pt-3">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-crx-green md:min-h-0 md:py-0">Split by line</summary>
            {lineSplit}
          </details>
        )}
      </section>

      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) onRemove(removing.id); setRemoving(null); }}
        title={`Remove ${removing?.customerName ?? ''}?`}
        message={`Their ${removing ? round2(removing.pct) : ''}% goes back to ${mainCustomerName}, the main customer.`}
        cancelLabel="Keep payer"
        confirmLabel="Remove payer"
      />
    </Card>
  );
}
