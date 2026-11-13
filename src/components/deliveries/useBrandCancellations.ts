import { useEffect, useState } from 'react';
import { supabase } from '../../lib/db';
import {
  CHECK_TIMEOUT_MS, normalizeEpaRegistration, registrationCheck, useCancelledRegistrations,
  type BrandListState, type CancelledRegistrations, type LookupState, type RegistrationCheck,
} from '../../lib/epaRegistrationStatus';
import { Sentry } from '../../lib/sentry';
import { toSentryError } from '../../lib/sentryError';
import { OTHER_BRAND, type DeliveryBrandLine, type DraftLines } from '../../lib/deliveryBrands';

/** Same shape the database accepts for a typed EPA number, so half-typed numbers are not looked up. */
const EPA_FORMAT = /^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$/;

/**
 * The product's own EPA number per product id (#1849); a failed read or none within CHECK_TIMEOUT_MS is never "none".
 * A new `refresh` rereads; numbers already read for the same products stay while it runs or if it fails.
 */
function useProductRegistrations(productIds: string[], refresh: string) {
  const ids = [...new Set(productIds)].sort().join('|');
  const key = `${ids}#${refresh}`;
  const [state, setState] = useState<{ key: string; ids: string; numbers: Map<string, string | null>; status: BrandListState }>(
    { key: '', ids: '', numbers: new Map(), status: 'loading' },
  );
  useEffect(() => {
    if (!ids) { setState({ key, ids, numbers: new Map(), status: 'loaded' }); return undefined; }
    let active = true;
    const keep = (prev: typeof state) => (prev.ids === ids ? prev.numbers : new Map<string, string | null>());
    setState((prev) => ({ key, ids, numbers: keep(prev), status: 'loading' }));
    const fail = (err: unknown) => {
      if (!active) return;
      Sentry.captureException(toSentryError(err), { extra: { context: 'delivery brand pick: product EPA numbers' } });
      setState((prev) => ({ key, ids, numbers: keep(prev), status: 'failed' }));
    };
    const wanted = ids.split('|');
    supabase.from('products').select('id, epa_registration').in('id', wanted).then(({ data, error }) => {
      // A product the read did not return (hidden or gone) was not checked, so it is never "none cancelled".
      if (error || !data || wanted.some((id) => !data.some((p) => p.id === id))) { fail(error); return; }
      if (active) setState({ key, ids, numbers: new Map(data.map((p) => [p.id, p.epa_registration])), status: 'loaded' });
    }, fail);
    const timer = setTimeout(() => {
      if (active) setState((prev) => (prev.key === key && prev.status === 'loading' ? { ...prev, status: 'slow' } : prev));
    }, CHECK_TIMEOUT_MS);
    return () => { active = false; clearTimeout(timer); };
    // `ids` is part of `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (state.key === key) return state;
  return { numbers: state.ids === ids ? state.numbers : new Map<string, string | null>(), status: 'loading' as BrandListState };
}

/**
 * Cancellations found for `scope` (the delivery) keep showing until the page reloads, even if a later check
 * fails (Mason, 2026-11-12, #1844). A registration is never un-cancelled, so nothing is ever taken back out.
 */
function useSticky(scope: string, found: CancelledRegistrations): CancelledRegistrations {
  const [seen, setSeen] = useState<{ scope: string; cancelled: CancelledRegistrations }>({ scope, cancelled: new Map() });
  const kept = seen.scope === scope ? seen.cancelled : new Map<string, string | null>();
  // A date that arrives later replaces "not recorded".
  const merged: CancelledRegistrations = new Map([...kept, ...[...found].filter(([n, on]) => on !== null || !kept.get(n))]);
  const signature = (m: CancelledRegistrations) => [...m].map(([n, on]) => `${n}=${on}`).sort().join('|');
  const mergedSignature = signature(merged);
  const keptSignature = signature(kept);
  useEffect(() => {
    if (seen.scope !== scope || mergedSignature !== keptSignature) setSeen({ scope, cancelled: merged });
    // `merged` is fully described by `mergedSignature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, seen.scope, mergedSignature, keptSignature]);
  return merged;
}

const worst = (a: LookupState, b: LookupState): LookupState =>
  (a === 'failed' || b === 'failed' ? 'failed' : a === 'checking' || b === 'checking' ? 'checking' : 'done');

/**
 * Which EPA numbers on these delivery lines are stored as cancelled (grand plan §8, #1849): each product's own,
 * every listed or saved brand's, and any typed from the jug. Typed numbers are checked apart, so typing never
 * hides a warning already shown. Only reads; nothing here ever blocks a delivery.
 */
export function useBrandCancellations(lines: DeliveryBrandLine[], drafts: DraftLines, scope: string, refresh: string): {
  productNumbers: Map<string, string | null>;
  cancelled: CancelledRegistrations;
  check: RegistrationCheck;
} {
  const products = useProductRegistrations(lines.map((l) => l.product_id), refresh);
  const listed = useCancelledRegistrations([
    ...products.numbers.values(),
    ...lines.flatMap((l) => [...l.brand_list.map((b) => b.epa_registration), ...l.picks.map((p) => p.epa_registration)]),
  ], refresh);
  const typed = useCancelledRegistrations(lines.flatMap((l) => (drafts[l.delivery_item_id] ?? [])
    .filter((d) => d.brandId === OTHER_BRAND)
    .map((d) => normalizeEpaRegistration(d.typedEpa))
    .filter((n): n is string => n !== null && EPA_FORMAT.test(n))));
  return {
    productNumbers: products.numbers,
    cancelled: useSticky(scope, new Map([...listed.cancelled, ...typed.cancelled])),
    check: registrationCheck(true, products.status, worst(listed.lookup, typed.lookup)),
  };
}
