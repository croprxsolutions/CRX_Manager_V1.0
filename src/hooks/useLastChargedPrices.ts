import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sentry } from '../lib/sentry';
import { fetchLastChargedPrices } from '../lib/lastChargedPrices';
import type { LastChargedPrice } from '../types';

export interface LastChargedLine {
  productId: string;
  productName: string;
}

// A result remembers the customer and product list it was loaded for, so a changed customer or list
// shows "Loading" at once instead of the old result (where a newly added product would read
// "Never charged" for a moment).
export type LastChargedState =
  | { status: 'loading' }
  | { status: 'failed'; requestKey: string }
  | { status: 'loaded'; requestKey: string; byProduct: Map<string, LastChargedPrice> };

/**
 * "What did we charge this customer before?" (To-Do 0.3): one row per product on the quote, the last
 * price charged to this customer. Loads when the customer or product set changes, whichever tab is
 * showing. `enabled` is the staff-only gate (admin or sales rep, never Customer View).
 */
export function useLastChargedPrices(customerId: string, lines: LastChargedLine[], enabled = true) {
  // One row per product, in quote order; a product on two lines has one last charge.
  const products = useMemo(() => {
    const seen = new Map<string, LastChargedLine>();
    for (const line of lines) {
      if (line.productId && !seen.has(line.productId)) seen.set(line.productId, line);
    }
    return [...seen.values()];
  }, [lines]);
  const productKey = products.map((p) => p.productId).join(',');
  const requestKey = `${customerId}|${productKey}`;
  const [loadState, setState] = useState<LastChargedState>({ status: 'loading' });
  const state: LastChargedState = loadState.status !== 'loading' && loadState.requestKey !== requestKey
    ? { status: 'loading' }
    : loadState;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !customerId || productKey === '') return;
    let cancelled = false;
    setState({ status: 'loading' });
    fetchLastChargedPrices(customerId, productKey.split(','))
      .then((byProduct) => { if (!cancelled) setState({ status: 'loaded', requestKey, byProduct }); })
      .catch((error: unknown) => {
        if (cancelled) return;
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
          extra: { context: 'get_last_charged_prices' },
        });
        setState({ status: 'failed', requestKey });
      });
    return () => { cancelled = true; };
  }, [enabled, customerId, productKey, requestKey, attempt]);

  return { products, state, retry };
}
