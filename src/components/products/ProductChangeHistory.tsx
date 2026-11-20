import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import { LoadFailedState } from '../ui/EmptyState';
import { supabase, supabaseUntyped } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { sanitizeError } from '../../lib/errorSanitizer';
import { BUSINESS_TIMEZONE } from '../../lib/dateUtils';
import { useLoad } from '../../hooks/useLoad';
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

type History = { rows: ProductChangeHistoryEntry[]; parentNames: ReadonlyMap<number, string> };

const BOOLEAN_FIELDS = new Set(['is_active', 'is_rup', 'is_full_tote_only']);
const NO_VALUE_FIELDS = new Set(['notes', 'internal_notes', 'quoting_notes', 'product_family_id']);

/** Parent event id -> parent name for the parent copies shown. A failed read shows them without a name. */
async function loadParentNames(rows: ProductChangeHistoryEntry[], isCurrent: () => boolean): Promise<Map<number, string>> {
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
    if (isCurrent()) {
      Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), {
        extra: { context: 'product_change_history_parent_names' },
      });
    }
    return new Map();
  }
}

/** The newest 50 changes, then (if still wanted) the parent names; a failed name read keeps the rows. */
async function readHistory(productId: string, isCurrent: () => boolean): Promise<History> {
  const { data, error } = await supabase.from('product_change_history')
    .select('id, product_id, change_type, parent_event_id, field_name, old_value, new_value, changed_by, changed_by_name, changed_at')
    .eq('product_id', productId)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(50);
  if (error) throw error;
  if (!Array.isArray(data) || data.some((row) => row === null || typeof row !== 'object')) {
    throw new Error('product_change_history returned an unexpected result');
  }
  const rows = data as ProductChangeHistoryEntry[];
  return { rows, parentNames: isCurrent() ? await loadParentNames(rows, isCurrent) : new Map() };
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
  const history = useLoad(`change-history:${productId}`, (isCurrent) => readHistory(productId, isCurrent), {
    refreshToken: reloadToken,
    report: { extra: { context: 'product_change_history' } },
  });
  const retry = () => { void history.reload(); };
  const state = history.status === 'loaded' ? { status: 'loaded' as const, ...history.data } : history;

  return (
    <Card>
      <CardHeader title="Change" accent="History" />
      {state.status === 'loading' && <p className="text-sm text-secondary" role="status">Loading change history…</p>}
      {state.status === 'failed' && <LoadFailedState title="Change history could not be loaded" onRetry={retry} />}
      {history.status === 'loaded' && history.stale && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-sm text-amber-800">
          <span>Could not refresh. This history may be out of date.</span>
          <Button size="sm" variant="secondary" onClick={retry} disabled={history.refreshing}>Try again</Button>
        </div>
      )}
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
