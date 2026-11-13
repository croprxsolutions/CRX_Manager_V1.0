import { Link } from 'react-router-dom';
import Card from '../ui/Card';
import Badge from '../ui/Badge';
import { formatCentsMinus as fmt } from '../../lib/money';
import { formatSharePct, invoiceStatusBadge } from '../../lib/statusLabel';

export interface InvoicePayerRow {
  payerName: string;
  invoiceId: string;
  invoiceNumber: string;
  pct: number;
  totalCents: number;
  /** The payer invoice's status, when this page has read it. */
  status?: string;
  isThis: boolean;
}

interface Props {
  rows: InvoicePayerRow[];
  saleHref?: string;
  saleNumber?: string;
}

/** Every payer on this delivery: their share, their invoice and its amount, with this invoice marked. */
export default function InvoicePayersTable({ rows, saleHref, saleNumber }: Props) {
  const pctTotal = rows.reduce((sum, r) => sum + r.pct, 0);
  const centsTotal = rows.reduce((sum, r) => sum + r.totalCents, 0);
  return (
    <Card>
      <section aria-labelledby="invoice-who-pays">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="invoice-who-pays" className="font-heading text-xl font-semibold text-nav-dark">Who pays</h2>
          <span className="text-sm text-secondary">{rows.length} payers</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs text-secondary">
              <th className="rounded-l-lg px-3 py-2 font-medium">Payer</th>
              <th className="px-2 py-2 text-right font-medium">Share</th>
              <th className="rounded-r-lg px-3 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.invoiceId} className={`border-b border-gray-100 align-top ${r.isThis ? 'bg-gray-50/60' : ''}`}>
                <td className="px-3 py-3">
                  <div className="break-words font-medium text-nav-dark">{r.payerName}</div>
                  {r.isThis ? (
                    <div className="text-xs text-secondary"><span className="font-mono text-nav-dark">{r.invoiceNumber}</span> · this invoice</div>
                  ) : (
                    <Link to={`/invoices/${r.invoiceId}`} className="inline-flex min-h-11 items-center font-mono text-xs text-crx-green underline hover:text-crx-green-hover md:min-h-0">
                      {r.invoiceNumber}
                    </Link>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums">{formatSharePct(r.pct)}</td>
                <td className="px-3 py-3 text-right">
                  <div className="whitespace-nowrap font-semibold tabular-nums text-nav-dark">{fmt(r.totalCents)}</div>
                  {r.status && (
                    <Badge variant={invoiceStatusBadge(r.status).variant} className="mt-1" normalCase>{invoiceStatusBadge(r.status).label}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold text-nav-dark">
              <td className="px-3 pt-3">Delivery total</td>
              <td className="whitespace-nowrap px-2 pt-3 text-right tabular-nums">{formatSharePct(pctTotal)}</td>
              <td className="whitespace-nowrap px-3 pt-3 text-right tabular-nums">{fmt(centsTotal)}</td>
            </tr>
          </tfoot>
        </table>
        {saleHref && saleNumber && (
          <p className="mt-4 text-sm text-secondary">
            Shares come from sale <Link to={saleHref} className="text-crx-green underline hover:text-crx-green-hover">{saleNumber}</Link>.
          </p>
        )}
      </section>
    </Card>
  );
}
