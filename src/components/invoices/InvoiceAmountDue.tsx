import type { ReactNode } from 'react';
import Card from '../ui/Card';
import { formatCentsMinus as fmt } from '../../lib/money';
import type { InvoiceBreakdown } from '../../lib/invoiceChargeLines';

interface Props {
  breakdown: InvoiceBreakdown;
  /** The invoice's own total (total_amount_cents); the breakdown rows show only when saved and adding up to it, as on the PDF. */
  totalCents: number;
  /** Unsaved edits on a saved invoice: the saved total stays until Save, with no rows (unsaved rows would read as saved). */
  dirty?: boolean;
  /** The first row: "Products", or "Subtotal" on a field application (its fee is not a product). */
  firstLabel?: 'Products' | 'Subtotal';
  /** Written off so far (write_off_cents). */
  writtenOffCents?: number;
  /** Null on a new invoice: nothing paid or due yet. */
  paidCents: number | null;
  prepayCents: number;
  /** Credit applied, signed as the balance takes it off (credit_applied_cents; negative on a credit memo, whose balance it raises). */
  creditAppliedCents?: number;
  balanceCents: number;
  /** Admins only (cost is admin-only); null hides cost and margin. */
  admin: { costCents: number; marginCents: number; marginPct: number | null } | null;
  /** The standing discount control (admin, chemical-sale draft). */
  discountControl?: ReactNode;
}

function Row({ label, cents, className = 'text-secondary' }: { label: string; cents: number; className?: string }) {
  return (
    <div className={`flex justify-between gap-3 ${className}`}>
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums text-nav-dark">{fmt(cents)}</span>
    </div>
  );
}

/** Admin only. While there are unsaved edits the total is the saved one, but cost and margin follow the edited lines. */
function CostAndMargin({ costCents, marginCents, marginPct, dirty }: NonNullable<Props['admin']> & { dirty: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 rounded-lg bg-gray-50 px-3 py-2 text-secondary">
      <span>Cost <span className="tabular-nums text-nav-dark">{fmt(costCents)}</span></span>
      <span>Margin <span className={`font-medium tabular-nums ${marginCents > 0 ? 'text-crx-green' : 'text-red-600'}`}>
        {fmt(marginCents)}{marginPct != null && ` · ${marginPct.toFixed(1)}%`}
      </span></span>
      {dirty && <span className="w-full text-xs">Cost and margin include your unsaved changes</span>}
    </div>
  );
}

/** What the invoice adds up to (products, charges, discount, tax) and what is still owed. */
export default function InvoiceAmountDue({
  breakdown, totalCents, dirty = false, firstLabel = 'Products', writtenOffCents = 0, paidCents, prepayCents, creditAppliedCents = 0, balanceCents, admin, discountControl,
}: Props) {
  const { productsCents, charges, discount, tax } = breakdown;
  const showRows = !dirty && breakdown.totalCents === totalCents;
  return (
    <Card>
      <section aria-labelledby="invoice-amount-due" className="space-y-3 text-sm">
        <h2 id="invoice-amount-due" className="font-heading text-xl font-semibold text-nav-dark">Amount due</h2>
        {showRows && (
          <>
            {(productsCents !== 0 || charges.length === 0) && <Row label={firstLabel} cents={productsCents} />}
            {charges.map((c) => <Row key={c.label} label={c.label} cents={c.cents} />)}
            {discount && <Row label={discount.label} cents={discount.cents} />}
            {tax && <Row label={tax.label} cents={tax.cents} />}
          </>
        )}
        <div className={`flex justify-between gap-3 text-base font-semibold text-nav-dark ${showRows ? 'border-t border-gray-100 pt-3' : ''}`}>
          <span>Invoice total</span>
          <span className="tabular-nums">{fmt(totalCents)}</span>
        </div>
        {dirty && <p className="text-xs text-secondary">Totals update when you save</p>}
        {paidCents !== null && (
          <>
            <Row label="Paid" cents={paidCents} />
            {prepayCents > 0 && <Row label="Prepay applied" cents={prepayCents} />}
            {writtenOffCents > 0 && <Row label="Written off" cents={writtenOffCents} />}
            {creditAppliedCents !== 0 && <Row label="Credit applied" cents={creditAppliedCents} />}
            <div className="flex justify-between gap-3 text-lg font-semibold text-nav-dark">
              <span>Balance due</span>
              <span className={`whitespace-nowrap tabular-nums ${balanceCents > 0 ? 'text-red-600' : 'text-crx-green'}`}>{fmt(balanceCents)}</span>
            </div>
          </>
        )}
        {admin && <CostAndMargin {...admin} dirty={dirty} />}
        {discountControl && <div className="border-t border-gray-100 pt-3">{discountControl}</div>}
      </section>
    </Card>
  );
}
