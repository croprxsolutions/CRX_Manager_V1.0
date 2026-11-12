import { useEffect, useState } from 'react';
import { assertRpcResult, supabaseUntyped } from './db';
import { parseLocalDate } from './dateUtils';
import { Sentry } from './sentry';
import { toSentryError } from './sentryError';

/** Same key the database stores registrations under (`_normalize_epa_registration`). */
export function normalizeEpaRegistration(value: string | null | undefined): string | null {
  return (value ?? '').replace(/\s/g, '').toUpperCase() || null;
}

/** "cancelled 3/1/2025", or says the date was not recorded. */
export function cancelledOnText(cancelledOn: string | null | undefined): string {
  return cancelledOn ? `cancelled ${parseLocalDate(cancelledOn).toLocaleDateString()}` : 'cancelled (date not recorded)';
}

/** Registration number (normalized) → the date EPA cancelled it (`YYYY-MM-DD`), or null when not recorded. */
export type CancelledRegistrations = Map<string, string | null>;

interface RegistrationRow {
  epa_registration: string;
  registration_status: string;
  cancelled_on: string | null;
}

/** Which of these numbers are stored as cancelled (REG-1). Only reads; nothing here ever blocks a sale. */
export async function getCancelledRegistrations(numbers: (string | null | undefined)[]): Promise<CancelledRegistrations> {
  const wanted = [...new Set(numbers.map(normalizeEpaRegistration).filter((n): n is string => n !== null))];
  // An empty or NULL list would ask for every registration.
  if (wanted.length === 0) return new Map();
  const { data, error } = await supabaseUntyped.rpc('get_epa_registrations', { p_numbers: wanted });
  if (error) throw error;
  const rows = assertRpcResult<RegistrationRow[]>(data, 'get_epa_registrations');
  return new Map(rows.filter((r) => r.registration_status === 'cancelled').map((r) => [r.epa_registration, r.cancelled_on]));
}

export const CHECK_TIMEOUT_MS = 15_000;

/** Where the registration lookup stands for the current numbers. */
export type LookupState = 'checking' | 'done' | 'failed';
/** Where the product's brand list stands: `slow` is still loading after CHECK_TIMEOUT_MS. */
export type BrandListState = 'loading' | 'slow' | 'loaded' | 'failed';
/** What the page can say: still checking, every number checked, or some could not be checked. */
export type RegistrationCheck = 'checking' | 'complete' | 'incomplete';

/**
 * The one place that decides what the page may claim. "Complete" (so "none cancelled" when nothing
 * was found) only when the product, its whole brand list and the lookup for exactly those numbers
 * have all answered; any failure or timeout is "incomplete", never "complete".
 */
export function registrationCheck(productLoaded: boolean, brands: BrandListState, lookup: LookupState): RegistrationCheck {
  if (!productLoaded) return 'checking';
  if (lookup === 'failed' || brands === 'failed' || brands === 'slow') return 'incomplete';
  if (lookup === 'checking' || brands === 'loading') return 'checking';
  return 'complete';
}

/**
 * Loads the cancelled set for these numbers. A failed read, or none within CHECK_TIMEOUT_MS, is
 * `failed`, never "none cancelled"; a late reply still lands. An answer for other numbers is never used.
 */
export function useCancelledRegistrations(numbers: (string | null | undefined)[]): { cancelled: CancelledRegistrations; lookup: LookupState } {
  const key = [...new Set(numbers.map(normalizeEpaRegistration).filter(Boolean))].sort().join('|');
  const [state, setState] = useState<{ key: string; cancelled: CancelledRegistrations; lookup: LookupState }>(
    { key: '', cancelled: new Map(), lookup: 'done' },
  );
  useEffect(() => {
    let active = true;
    // Each request starts as "checking", so an earlier answer for the same numbers is never reused.
    setState({ key, cancelled: new Map(), lookup: 'checking' });
    getCancelledRegistrations(key ? key.split('|') : [])
      .then((cancelled) => { if (active) setState({ key, cancelled, lookup: 'done' }); })
      .catch((err: unknown) => {
        if (!active) return;
        Sentry.captureException(toSentryError(err), { extra: { context: 'get_epa_registrations' } });
        setState({ key, cancelled: new Map(), lookup: 'failed' });
      });
    const timer = setTimeout(() => {
      if (active) setState((prev) => (prev.key === key && prev.lookup !== 'checking' ? prev : { key, cancelled: new Map(), lookup: 'failed' }));
    }, CHECK_TIMEOUT_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [key]);
  return state.key === key ? state : { cancelled: new Map(), lookup: 'checking' };
}

/** Who carries a number: "This product" or a brand. */
export interface RegistrationSource {
  label: string;
  epaRegistration: string | null | undefined;
}

interface Hit { source: RegistrationSource; key: string; cancelledOn: string | null }
const hitId = (hit: Hit) => `${hit.source.label}|${hit.key}`;

/**
 * Once a cancellation has shown for `scope` (the product), it keeps showing until the page reloads or the
 * product changes, even if a later check fails or no longer covers that number (Mason, 2026-11-12).
 */
export function useStickyCancellations(scope: string, sources: RegistrationSource[], cancelled: CancelledRegistrations) {
  const [seen, setSeen] = useState<{ scope: string; hits: Hit[] }>({ scope, hits: [] });
  const current = sources.flatMap((source): Hit[] => {
    const key = normalizeEpaRegistration(source.epaRegistration);
    return key && cancelled.has(key) ? [{ source, key, cancelledOn: cancelled.get(key) ?? null }] : [];
  });
  const kept = seen.scope === scope ? seen.hits : [];
  const keptOnly = kept.filter((hit) => !current.some((c) => hitId(c) === hitId(hit)));
  const all = [...keptOnly, ...current];
  // The date is in the signature, so a date that arrives later is kept too.
  const withDate = (hit: Hit) => `${hitId(hit)}|${hit.cancelledOn}`;
  const signature = all.map(withDate).sort().join('\n');
  const seenSignature = kept.map(withDate).sort().join('\n');
  useEffect(() => {
    if (seen.scope !== scope || signature !== seenSignature) setSeen({ scope, hits: all });
    // `all` is fully described by `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, signature, seenSignature, seen.scope]);
  return {
    sources: [...sources, ...keptOnly.map((hit) => hit.source)],
    cancelled: new Map([...keptOnly.map((hit): [string, string | null] => [hit.key, hit.cancelledOn]), ...cancelled]) as CancelledRegistrations,
  };
}
