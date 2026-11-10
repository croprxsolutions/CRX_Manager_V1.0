import { useEffect, useState } from 'react';
import { supabase } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';
import { Sentry } from './sentry';

/** Active vendor names, for picking a sale line's vendor (billing plan M3). */
export function useVendorNames(enabled: boolean): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    void (async () => {
      const { data, error } = await fetchAllRows<{ id: string; name: string }>((from, to) => pageWithList(
        supabase.from('vendors').select('id, name', { count: 'exact' }).is('deleted_at', null).order('name').order('id').range(from, to)
      ));
      if (stale) return;
      if (error || !data) {
        Sentry.captureException(error ? new Error(error.message) : new Error('The vendor read returned no list'), { extra: { context: 'load_vendor_names' } });
        return;
      }
      setNames(data.map((v) => v.name));
    })();
    return () => { stale = true; };
  }, [enabled]);
  return names;
}
