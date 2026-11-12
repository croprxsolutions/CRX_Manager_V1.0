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

/** The product's own EPA number per product id (#1849); a failed read or none within CHECK_TIMEOUT_MS is never "none". */
function useProductRegistrations(productIds: string[]) {
  const key = [...new Set(productIds)].sort().join('|');
  const [state, setState] = useState<{ key: string; numbers: Map<string, string | null>; status: BrandListState }>(
    { key: '', numbers: new Map(), status: 'loading' },
  );
  useEffect(() => {
    if (!key) { setState({ key, numbers: new Map(), status: 'loaded' }); return undefined; }
    let active = true;
    setState({ key, numbers: new Map(), status: 'loading' });
    void supabase.from('products').select('id, epa_registration').in('id', key.split('|')).then(({ data, error }) => {
      if (!active) return;
      // A product the read did not return (hidden or gone) was not checked, so it is never "none cancelled".
      const ids = key.split('|');
      if (error || !data || ids.some((id) => !data.some((p) => p.id === id))) {
        Sentry.captureException(toSentryError(error), { extra: { context: 'delivery brand pick: product EPA numbers' } });
        setState({ key, numbers: new Map(), status: 'failed' });
        return;
      }
      setState({ key, numbers: new Map(data.map((p) => [p.id, p.epa_registration])), status: 'loaded' });
    });
    const timer = setTimeout(() => {
      if (active) setState((prev) => (prev.key === key && prev.status === 'loading' ? { ...prev, status: 'slow' } : prev));
    }, CHECK_TIMEOUT_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [key]);
  return state.key === key ? state : { numbers: new Map<string, string | null>(), status: 'loading' as BrandListState };
}

const worst = (a: LookupState, b: LookupState): LookupState =>
  (a === 'failed' || b === 'failed' ? 'failed' : a === 'checking' || b === 'checking' ? 'checking' : 'done');

/**
 * Which EPA numbers on these delivery lines are stored as cancelled (grand plan §8, #1849): each product's own,
 * every listed or saved brand's, and any typed from the jug. Typed numbers are checked apart, so typing never
 * hides a warning already shown. Only reads; nothing here ever blocks a delivery.
 */
export function useBrandCancellations(lines: DeliveryBrandLine[], drafts: DraftLines): {
  productNumbers: Map<string, string | null>;
  cancelled: CancelledRegistrations;
  check: RegistrationCheck;
} {
  const products = useProductRegistrations(lines.map((l) => l.product_id));
  const listed = useCancelledRegistrations([
    ...products.numbers.values(),
    ...lines.flatMap((l) => [...l.brand_list.map((b) => b.epa_registration), ...l.picks.map((p) => p.epa_registration)]),
  ]);
  const typed = useCancelledRegistrations(lines.flatMap((l) => (drafts[l.delivery_item_id] ?? [])
    .filter((d) => d.brandId === OTHER_BRAND)
    .map((d) => normalizeEpaRegistration(d.typedEpa))
    .filter((n): n is string => n !== null && EPA_FORMAT.test(n))));
  return {
    productNumbers: products.numbers,
    cancelled: new Map([...listed.cancelled, ...typed.cancelled]),
    check: registrationCheck(true, products.status, worst(listed.lookup, typed.lookup)),
  };
}
