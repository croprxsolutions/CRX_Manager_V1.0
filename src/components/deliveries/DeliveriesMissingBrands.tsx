import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Card from '../ui/Card';
import { Sentry } from '../../lib/sentry';
import { localDatePlusDays, localToday } from '../../lib/dateUtils';
import { getDeliveriesMissingBrands, MISSING_BRAND_REASON_LABELS, type DeliveryMissingBrandsLine } from '../../lib/deliveryBrands';

const DAYS_SHOWN = 90;

/**
 * Admin only (Brand PR B, B-2): the office's follow-up list for brands. A completion never waits on brands, so a
 * line completed with no brand, a split that does not add up, or picks not confirmed lands here. Each row links to
 * its delivery, where "Correct brands" clears it. Read only; shown only when something is waiting.
 */
export default function DeliveriesMissingBrands() {
  const [rows, setRows] = useState<DeliveryMissingBrandsLine[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await getDeliveriesMissingBrands(localDatePlusDays(-DAYS_SHOWN), localToday());
      if (request === requestRef.current) { setRows(next); setLoadFailed(false); }
    } catch (error) {
      if (request === requestRef.current) setLoadFailed(true);
      Sentry.captureException(error, { level: 'warning', extra: { context: 'Deliveries missing brands could not be loaded' } });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (rows.length === 0 && !loadFailed) return null;

  return (
    <Card>
      <h2 className="font-heading text-lg font-semibold text-nav-dark">Deliveries missing brands</h2>
      <p className="mb-3 text-sm text-secondary">
        Delivered in the last {DAYS_SHOWN} days with a brand to check. Open the delivery and use Correct brands.
      </p>
      {loadFailed && (
        <p className="mb-3 text-sm text-amber-800">
          {rows.length === 0 ? 'Deliveries missing brands could not be loaded.' : 'This list could not be refreshed and may be out of date.'}{' '}
          <button type="button" className="font-medium underline" onClick={() => void load()}>Try again</button>
        </p>
      )}
      <ul className="divide-y divide-gray-100">
        {rows.map((row) => (
          <li key={row.delivery_item_id} className="py-2 text-sm text-nav-dark">
            <Link to={`/deliveries/${row.delivery_id}`} className="text-crx-green underline">{row.delivery_number || 'A delivery'}</Link>
            {' · '}{row.delivered_on}{' · '}{row.product_name || 'A product'} ({row.picked_quantity} of {row.quantity_delivered} recorded)
            <span className="block text-amber-800">{row.reasons.map((r) => MISSING_BRAND_REASON_LABELS[r] ?? r).join('; ')}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
