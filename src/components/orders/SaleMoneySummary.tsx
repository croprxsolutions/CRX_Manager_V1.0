import type { ReactNode } from 'react';
import Card from '../ui/Card';
import { formatUSD as fmt } from '../../lib/money';

interface Props {
  /** The sale's products, before freight, discount and tax. */
  saleTotal: number;
  /** Null when the viewer can see none of the sale's invoices: the tiles give way to `invoiceNote`. */
  invoiced: number | null;
  paid: number | null;
  balanceDue: number | null;
  /** Under Balance due, e.g. "2 invoices, both drafts". */
  balanceNote?: string;
  writtenOff?: number;
  profit?: number | null;
  marginPct?: number | null;
  showProfit: boolean;
  invoiceNote?: string | null;
}

function Tile({ label, value, sub, valueClass = 'text-nav-dark' }: { label: string; value: ReactNode; sub?: string; valueClass?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 p-4">
      <span className="text-sm text-secondary">{label}</span>
      <strong className={`text-xl font-semibold tabular-nums md:text-2xl ${valueClass}`}>{value}</strong>
      {sub && <span className="text-xs text-secondary">{sub}</span>}
    </div>
  );
}

/** One money summary for a sale: what it sold, what was invoiced, paid and still due. */
export default function SaleMoneySummary({
  saleTotal, invoiced, paid, balanceDue, balanceNote, writtenOff = 0, profit, marginPct, showProfit, invoiceNote,
}: Props) {
  return (
    <Card padding={false}>
      <section aria-label="Money summary" className="grid grid-cols-2 md:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
        <Tile label="Sale total" value={fmt(saleTotal)} sub="Products only" />
        {invoiced !== null && (<>
          <Tile label="Invoiced" value={fmt(invoiced)} sub="With freight, discount and tax" />
          <Tile label="Paid" value={fmt(paid ?? 0)} valueClass="text-crx-green" />
          <Tile label="Balance due" value={fmt(Math.max(0, balanceDue ?? 0))} sub={balanceNote}
            valueClass={(balanceDue ?? 0) > 0 ? 'text-red-600' : 'text-crx-green'} />
          {writtenOff > 0 && <Tile label="Written off" value={fmt(writtenOff)} valueClass="text-amber-600" />}
        </>)}
        {showProfit && (
          <Tile
            label="Profit · margin"
            value={<>{profit == null ? '—' : fmt(profit)} <span className="text-base font-medium text-secondary">{marginPct == null ? '—' : `${marginPct.toFixed(1)}%`}</span></>}
            sub="Admins only"
            valueClass="text-crx-green"
          />
        )}
      </section>
      {invoiceNote && <p className="border-t border-gray-100 px-4 py-3 text-sm text-secondary">{invoiceNote}</p>}
    </Card>
  );
}
