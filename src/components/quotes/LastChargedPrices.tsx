import Card, { CardHeader } from '../ui/Card';
import { History } from 'lucide-react';
import { LoadFailedState } from '../ui/EmptyState';
import { formatCents } from '../../lib/money';
import { formatChargedOn, formatChargedTier } from '../../lib/lastChargedPrices';
import { useLastChargedPrices, type LastChargedLine, type LastChargedState } from '../../hooks/useLastChargedPrices';

export type { LastChargedLine };

/**
 * "What did we charge this customer before?" (To-Do 0.3): for each product on the quote, the last
 * price charged to this customer, with its tier and date. Shown to admins and sales reps, never in
 * Customer View or on the PDF. Read-only: it never changes a quote price. The page loads the data
 * (useLastChargedPrices) and renders this card from it; the default export loads its own.
 */
export function LastChargedPricesCard({ products, state, onRetry }: {
  products: LastChargedLine[];
  state: LastChargedState;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader title="Last" accent="Charged" />
      <p className="text-xs text-secondary mb-3 flex items-center gap-1">
        <History className="w-3.5 h-3.5" aria-hidden="true" />
        The last price this customer was charged for each product: from posted, paid or overdue
        invoices, or from confirmed or delivered orders not yet invoiced. For reference only; it does
        not change this quote.
      </p>
      {state.status === 'loading' && (
        <p className="text-sm text-secondary" role="status">Loading last charged prices…</p>
      )}
      {state.status === 'failed' && (
        <LoadFailedState title="Last charged prices could not be loaded" onRetry={onRetry} />
      )}
      {state.status === 'loaded' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Last price charged to this customer for each product on this quote</caption>
            <thead>
              <tr className="text-left text-xs text-secondary uppercase tracking-wide border-b border-gray-200">
                <th scope="col" className="py-2 pr-3 font-medium">Product</th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">Last charged</th>
                <th scope="col" className="py-2 pr-3 font-medium">Tier</th>
                <th scope="col" className="py-2 pr-3 font-medium">Date</th>
                <th scope="col" className="py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const charge = state.byProduct.get(product.productId);
                return (
                  <tr key={product.productId} className="border-b border-gray-100 last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal text-nav-dark">{product.productName}</th>
                    {charge ? (
                      <>
                        <td className="py-2 pr-3 text-right">
                          <span className="font-mono">{formatCents(charge.unit_price_cents)}</span>
                          {/* The size that line was sold in: the price is per this unit. */}
                          {charge.unit_size && <span className="text-secondary"> / {charge.unit_size}</span>}
                        </td>
                        <td className="py-2 pr-3">{formatChargedTier(charge.price_tier)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{formatChargedOn(charge.charged_on)}</td>
                        <td className="py-2">{charge.source === 'invoice' ? 'Invoice' : 'Order'}</td>
                      </>
                    ) : (
                      <td className="py-2 text-secondary" colSpan={4}>Never charged to this customer</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Loads and renders the card on its own. */
export default function LastChargedPrices({ customerId, lines }: { customerId: string; lines: LastChargedLine[] }) {
  const { products, state, retry } = useLastChargedPrices(customerId, lines);
  if (!customerId || products.length === 0) return null;
  return <LastChargedPricesCard products={products} state={state} onRetry={retry} />;
}
