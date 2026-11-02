import { useEffect, useState } from 'react';
import Card, { CardHeader } from '../ui/Card';
import { supabaseUntyped } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import type { ProductChangeHistoryEntry } from '../../types';

const FIELD_LABELS: Record<string, string> = {
  product_name: 'Product name', sku: 'SKU', category: 'Category', vendor: 'Vendor',
  manufacturer: 'Manufacturer', container_size: 'Container size', container_unit: 'Container unit',
  container_type: 'Container type', unit_size: 'Unit size', inventory_unit: 'Inventory unit',
  product_form: 'Product form', suggested_rate: 'Suggested rate', rate_per_acre: 'Rate per acre',
  rate_unit: 'Rate unit', notes: 'Notes', internal_notes: 'Internal notes', quoting_notes: 'Quoting notes',
  is_active: 'Active', epa_registration: 'EPA registration', is_rup: 'Restricted use',
  signal_word: 'Signal word', rei_hours: 'REI hours', phi_days: 'PHI days',
  max_label_rate: 'Maximum label rate', max_label_rate_unit: 'Maximum label rate unit',
  use_timing: 'Use timing', product_family_id: 'Product family', return_policy: 'Return policy',
  packaging_variant: 'Packaging variant', is_full_tote_only: 'Full tote only',
};

type LoadState =
  | { status: 'loading' }
  | { status: 'failed'; productId: string }
  | { status: 'loaded'; productId: string; rows: ProductChangeHistoryEntry[] };

function displayValue(value: string | null): string {
  return value === null || value === '' ? 'blank' : value;
}

export default function ProductChangeHistory({ productId, reloadToken = 0 }: { productId: string; reloadToken?: number }) {
  const [loaded, setLoaded] = useState<LoadState>({ status: 'loading' });
  const state = loaded.status !== 'loading' && loaded.productId !== productId
    ? { status: 'loading' as const } : loaded;

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });
    void (async () => {
      const { data, error } = await supabaseUntyped.from('product_change_history')
        .select('id, product_id, change_type, field_name, old_value, new_value, changed_by, changed_by_name, changed_at')
        .eq('product_id', productId)
        .order('changed_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) {
        Sentry.captureException(error, { extra: { context: 'product_change_history' } });
        setLoaded({ status: 'failed', productId });
      } else {
        setLoaded({ status: 'loaded', productId, rows: (data ?? []) as ProductChangeHistoryEntry[] });
      }
    })().catch((error: unknown) => {
      if (cancelled) return;
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'product_change_history' },
      });
      setLoaded({ status: 'failed', productId });
    });
    return () => { cancelled = true; };
  }, [productId, reloadToken]);

  return (
    <Card>
      <CardHeader title="Change" accent="History" />
      {state.status === 'loading' && <p className="text-sm text-secondary" role="status">Loading change history…</p>}
      {state.status === 'failed' && <p className="text-sm text-secondary">Change history could not be loaded. Reload to try again.</p>}
      {state.status === 'loaded' && state.rows.length === 0 && <p className="text-sm text-secondary">No changes recorded yet.</p>}
      {state.status === 'loaded' && state.rows.length > 0 && (
        <ul className="max-h-96 space-y-3 overflow-y-auto" tabIndex={0} aria-label="Product changes, newest first">
          {state.rows.map((row) => (
            <li key={row.id} className="border-b border-gray-100 pb-3 text-sm last:border-0">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-nav-dark">{row.changed_by === null ? 'System' : row.changed_by_name || 'Unknown staff member'}</span>
                <time className="text-secondary" dateTime={row.changed_at}>{new Date(row.changed_at).toLocaleString('en-US')}</time>
              </div>
              {row.change_type === 'created' ? (
                <p>Created</p>
              ) : (
                <p><span className="font-medium">{FIELD_LABELS[row.field_name ?? ''] ?? row.field_name}</span>: {displayValue(row.old_value)} → {displayValue(row.new_value)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
