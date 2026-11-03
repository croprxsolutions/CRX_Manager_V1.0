import { useEffect, useState } from 'react';
import { supabase } from '../lib/db';
import { Sentry } from '../lib/sentry';

// Names of active warehouses, default first. Receiving offers only these; the
// receive_po_items RPC refuses any other location (KI-85).
export function useActiveWarehouses(): string[] {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('warehouses')
        .select('name')
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .order('name');
      if (cancelled) return;
      if (error || !Array.isArray(data)) {
        Sentry.captureException(error ?? new Error('warehouses read returned no list'), { tags: { source: 'fetch', action: 'load_active_warehouses' } });
        return;
      }
      setNames(data.map((row: { name: string }) => row.name));
    })();
    return () => { cancelled = true; };
  }, []);

  return names;
}

// Picker options: the active warehouses, plus the current choice if the list has not
// loaded or no longer holds it, so the picker never shows a value it is not sending.
export function warehouseOptions(active: string[], current: string): string[] {
  return active.includes(current) ? active : [current, ...active];
}
