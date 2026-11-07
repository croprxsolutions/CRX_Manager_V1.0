import { useCallback, useEffect, useState } from 'react';
import Card, { CardHeader } from '../ui/Card';
import { LoadFailedState } from '../ui/EmptyState';
import { supabase, supabaseUntyped } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { sanitizeError } from '../../lib/errorSanitizer';
import { BUSINESS_TIMEZONE } from '../../lib/dateUtils';
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
  | { status: 'loaded'; productId: string; rows: ProductChangeHistoryEntry[]; parentNames: ReadonlyMap<number, string> };

const BOOLEAN_FIELDS = new Set(['is_active', 'is_rup', 'is_full_tote_only']);
const NO_VALUE_FIELDS = new Set(['notes', 'internal_notes', 'quoting_notes', 'product_family_id']);

/** Parent event id -> parent name for the parent copies shown. A failed read shows them without a name. */
async function loadParentNames(rows: ProductChangeHistoryEntry[]): Promise<Map<number, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.change_type === 'parent_copy' && row.parent_event_id != null ? [row.parent_event_id] : [])))];
  if (ids.length === 0) return new Map();
  try {
    const { data, error } = await supabaseUntyped.from('product_parent_events')
      .select('id, product_parents(name)')
      .in('id', ids);
    if (error) throw error;
    // Many-to-one, so PostgREST sends one parent object; the untyped client types it as a list.
    return new Map(((data ?? []) as unknown as Array<{ id: number; product_parents: { name: string } | null }>)
      .flatMap((event) => (event.product_parents ? [[event.id, event.product_parents.name] as const] : [])));
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), {
      extra: { context: 'product_change_history_parent_names' },
    });
    return new Map();
  }
}

function parentPrefix(row: ProductChangeHistoryEntry, names: ReadonlyMap<number, string>): string {
  if (row.change_type !== 'parent_copy') return '';
  const name = row.parent_event_id == null ? undefined : names.get(row.parent_event_id);
  return name ? `Changed on parent ${name}: ` : 'Changed on parent: ';
}

function displayValue(field: string | null, value: string | null): string {
  if (BOOLEAN_FIELDS.has(field ?? '') && value !== null) return value === 'true' ? 'Yes' : 'No';
  return value === null || value === '' ? 'blank' : value;
}

export default function ProductChangeHistory({ productId, reloadToken = 0 }: { productId: string; reloadToken?: number }) {
  const [loaded, setLoaded] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const state = loaded.status !== 'loading' && loaded.productId !== productId
    ? { status: 'loading' as const } : loaded;

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });
    void (async () => {
      const { data, error } = await supabase.from('product_change_history')
        .select('id, product_id, change_type, parent_event_id, field_name, old_value, new_value, changed_by, changed_by_name, changed_at')
        .eq('product_id', productId)
        .order('changed_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) {
        Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), {
          extra: { context: 'product_change_history' },
        });
        setLoaded({ status: 'failed', productId });
      } else {
        const rows = (data ?? []) as ProductChangeHistoryEntry[];
        const parentNames = await loadParentNames(rows);
        if (!cancelled) setLoaded({ status: 'loaded', productId, rows, parentNames });
      }
    })().catch((error: unknown) => {
      if (cancelled) return;
      Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), {
        extra: { context: 'product_change_history' },
      });
      setLoaded({ status: 'failed', productId });
    });
    return () => { cancelled = true; };
  }, [productId, reloadToken, attempt]);

  return (
    <Card>
      <CardHeader title="Change" accent="History" />
      {state.status === 'loading' && <p className="text-sm text-secondary" role="status">Loading change history…</p>}
      {state.status === 'failed' && <LoadFailedState title="Change history could not be loaded" onRetry={retry} />}
      {state.status === 'loaded' && state.rows.length === 0 && <p className="text-sm text-secondary">No changes recorded yet.</p>}
      {state.status === 'loaded' && state.rows.length > 0 && (<>
        <ul className="max-h-96 space-y-3 overflow-y-auto" tabIndex={0} aria-label="Product changes, newest first">
          {state.rows.map((row) => (
            <li key={row.id} className="border-b border-gray-100 pb-3 text-sm last:border-0">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-nav-dark">{row.changed_by === null ? 'System' : row.changed_by_name || 'Unknown staff member'}</span>
                <time className="text-secondary" dateTime={row.changed_at}>{new Date(row.changed_at).toLocaleString('en-US', { timeZone: BUSINESS_TIMEZONE })}</time>
              </div>
              {row.change_type === 'created' ? (
                <p>Created</p>
              ) : NO_VALUE_FIELDS.has(row.field_name ?? '') ? (
                <p>{parentPrefix(row, state.parentNames)}{FIELD_LABELS[row.field_name ?? ''] ?? row.field_name} changed</p>
              ) : (
                <p>{parentPrefix(row, state.parentNames)}<span className="font-medium">{FIELD_LABELS[row.field_name ?? ''] ?? row.field_name}</span>: {displayValue(row.field_name, row.old_value)} → {displayValue(row.field_name, row.new_value)}</p>
              )}
            </li>
          ))}
        </ul>
        {state.rows.length === 50 && <p className="mt-2 text-xs text-secondary">Showing the newest 50 changes.</p>}
        </>
      )}
    </Card>
  );
}
