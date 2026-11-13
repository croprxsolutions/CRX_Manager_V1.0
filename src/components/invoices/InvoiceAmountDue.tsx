import type { ReactNode } from 'react';
import Card from '../ui/Card';
import { formatCentsMinus as fmt } from '../../lib/money';
import type { InvoiceBreakdown } from '../../lib/invoiceChargeLines';

interface Props {
  breakdown: InvoiceBreakdown;
  /** Null on a new invoice: nothing paid or due yet. */
  paidCents: number | null;
  prepayCents: number;
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

/** What the invoice adds up to (products, charges, discount, tax) and what is still owed. */
export default function InvoiceAmountDue({ breakdown, paidCents, prepayCents, balanceCents, admin, discountControl }: Props) {
  const { productsCents, charges, discount, tax, totalCents } = breakdown;
  return (
    <Card>
      <section aria-labelledby="invoice-amount-due" className="space-y-3 text-sm">
        <h2 id="invoice-amount-due" className="font-heading text-xl font-semibold text-nav-dark">Amount due</h2>
        {(productsCents !== 0 || charges.length === 0) && <Row label="Products" cents={productsCents} />}
        {charges.map((c) => <Row key={c.label} label={c.label} cents={c.cents} />)}
        {discount && <Row label={discount.label} cents={discount.cents} />}
        {tax && <Row label={tax.label} cents={tax.cents} />}
        <div className="flex justify-between gap-3 border-t border-gray-100 pt-3 text-base font-semibold text-nav-dark">
          <span>Invoice total</span>
          <span className="tabular-nums">{fmt(totalCents)}</span>
        </div>
        {paidCents !== null && (
          <>
            <Row label="Paid" cents={paidCents} />
            {prepayCents > 0 && <Row label="Prepay applied" cents={prepayCents} />}
            <div className="flex justify-between gap-3 text-lg font-semibold text-nav-dark">
              <span>Balance due</span>
              <span className={`whitespace-nowrap tabular-nums ${balanceCents > 0 ? 'text-red-600' : 'text-crx-green'}`}>{fmt(balanceCents)}</span>
            </div>
          </>
        )}
        {admin && (
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 rounded-lg bg-gray-50 px-3 py-2 text-secondary">
            <span>Cost <span className="tabular-nums text-nav-dark">{fmt(admin.costCents)}</span></span>
            <span>Margin <span className={`font-medium tabular-nums ${admin.marginCents > 0 ? 'text-crx-green' : 'text-red-600'}`}>
              {fmt(admin.marginCents)}{admin.marginPct != null && ` · ${admin.marginPct.toFixed(1)}%`}
            </span></span>
          </div>
        )}
        {discountControl && <div className="border-t border-gray-100 pt-3">{discountControl}</div>}
      </section>
    </Card>
  );
}
