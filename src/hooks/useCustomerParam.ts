import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { toSentryError } from '../lib/sentryError';

/** The search parameter the A/R screens share, so a customer picked on one tab is still picked on the next. */
export const CUSTOMER_PARAM = 'customer';

// Farm names already known this session. The A/R workspace mounts only the open tab, so without
// this every tab switch would show an empty customer box until its own read came back.
const knownNames = new Map<string, string>();

/**
 * The A/R screens' chosen customer, kept in the address (`?customer=<id>`) so it carries between
 * the A/R Workspace tabs and survives a refresh. The farm name is a label only: every screen
 * filters by the id, so a name that cannot be read is shown as such and changes nothing else.
 */
export function useCustomerParam() {
  const [searchParams, setSearchParams] = useSearchParams();
  const customerId = searchParams.get(CUSTOMER_PARAM) ?? '';
  const [readName, setReadName] = useState<{ id: string; name: string | null } | null>(null);

  useEffect(() => {
    if (!customerId || knownNames.has(customerId)) return;
    let cancelled = false;
    void Promise.resolve(supabase.from('customers').select('id, farm_name').eq('id', customerId).maybeSingle())
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          if (error) Sentry.captureException(toSentryError(error), { extra: { context: 'customer_param_label' } });
          setReadName({ id: customerId, name: null });
          return;
        }
        knownNames.set(customerId, data.farm_name);
        setReadName({ id: customerId, name: data.farm_name });
      });
    return () => { cancelled = true; };
  }, [customerId]);

  const customerName = knownNames.get(customerId)
    ?? (readName?.id === customerId && readName.name !== null ? readName.name : '');
  const nameFailed = !!customerId && !customerName && readName?.id === customerId && readName.name === null;

  const setCustomer = useCallback((customer: { id: string; farm_name: string } | null) => {
    if (customer) knownNames.set(customer.id, customer.farm_name);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (customer) next.set(CUSTOMER_PARAM, customer.id);
      else next.delete(CUSTOMER_PARAM);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  return {
    customerId,
    /** The chosen customer's farm name, or '' while it loads or when it could not be read. */
    customerName,
    /** What the customer box shows for the chosen customer. */
    customerLabel: nameFailed ? 'Customer name could not be loaded' : customerName,
    setCustomer,
  };
}
