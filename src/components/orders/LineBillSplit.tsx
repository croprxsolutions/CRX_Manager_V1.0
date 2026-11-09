import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import Button from '../ui/Button';
import CustomerSearchPicker from '../customers/CustomerSearchPicker';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult, sanitizeError } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { sharesLeft, sharesOverHundred } from '../../lib/billSplitLock';

export interface LineShare {
  id: string;
  order_item_id: string;
  customer_id: string;
  split_percentage: number;
  customer?: { farm_name?: string | null } | null;
}

interface Props {
  items: { id: string; product_name?: string | null }[];
  lineShares: LineShare[];
  hasCard: boolean;
  mainCustomerName: string;
  canEdit: boolean;
  locked: boolean;
  /** Reloads the order; the editor stays locked until it resolves, so the next add checks the new shares. */
  onChanged: () => void | Promise<unknown>;
}

/** A line's own payers, overriding the Bill Split card for that line (billing plan M2). */
export default function LineBillSplit({ items, lineShares, hasCard, mainCustomerName, canEdit, locked, onChanged }: Props) {
  const { toast } = useToast();
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [pct, setPct] = useState('');
  const [saving, setSaving] = useState(false);

  const write = async (context: string, run: () => PromiseLike<{ data: unknown; error: unknown }>) => {
    setSaving(true);
    try {
      checkMutationResult(await run() as never, context);
      setCustomer(null);
      setPct('');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context } });
      toast('error', sanitizeError(err));
    }
    // Refresh either way: a failed reply may still have committed, and a retry should see it.
    // If the order couldn't be reloaded (false), stay locked: the page shows its load failure, and
    // nothing is added against a stale list.
    let reloaded: unknown = true;
    try { reloaded = await onChanged(); } catch { reloaded = false; }
    if (reloaded !== false) setSaving(false);
  };

  const handleAdd = (itemId: string, ownPercents: number[]) => {
    const value = parseFloat(pct);
    if (!customer || Number.isNaN(value) || value <= 0 || value > 100) {
      toast('error', 'Pick a customer and a share between 0 and 100');
      return;
    }
    if (Math.round(value * 100) / 100 !== value) {
      toast('error', 'Use at most two decimals for a share');
      return;
    }
    if (sharesOverHundred([...ownPercents, value])) {
      toast('error', `A line's shares can't total more than 100% (currently ${Math.round((100 - sharesLeft(ownPercents)) * 100) / 100}%)`);
      return;
    }
    void write('Add line share', () => supabase.from('order_item_shares')
      .insert({ order_item_id: itemId, customer_id: customer.id, split_percentage: value }).select());
  };

  if (!showList && lineShares.length === 0) {
    if (!canEdit || locked) return null;
    return (
      <div className="mt-3 border-t border-gray-100 pt-3">
        <Button variant="ghost" size="sm" showChevron={false} onClick={() => setShowList(true)}>Split by line</Button>
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
      <p className="text-xs font-medium text-secondary">By line</p>
      {items.map((item) => {
        const own = lineShares.filter((s) => s.order_item_id === item.id);
        // Added exactly, as the database adds numeric: float sums refuse or mislabel a split that is exactly full.
        const ownPercents = own.map((s) => s.split_percentage);
        const left = sharesLeft(ownPercents);
        const name = item.product_name || 'Line';
        const isOpen = openItemId === item.id;
        return (
          <div key={item.id} className="rounded-lg border border-gray-100 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-nav-dark">{name}</p>
                {own.length === 0 ? (
                  <p className="text-xs text-secondary">{hasCard ? 'Follows the Bill Split' : `Billed to ${mainCustomerName}`}</p>
                ) : (
                  <p className="text-xs text-secondary">
                    {own.map((s) => `${s.customer?.farm_name || 'Unknown'} ${s.split_percentage}%`).join(' · ')}
                    {left > 0 && <span className="text-amber-600"> Other {Math.round(left * 100) / 100}% stays with {mainCustomerName}</span>}
                  </p>
                )}
              </div>
              {canEdit && !locked && (
                <Button variant="ghost" size="sm" showChevron={false} aria-label={`Change split for ${name}`} disabled={saving}
                  onClick={() => { setOpenItemId(isOpen ? null : item.id); setCustomer(null); setPct(''); }}>
                  {isOpen ? 'Done' : 'Change'}
                </Button>
              )}
            </div>
            {isOpen && canEdit && !locked && (
              <div className="mt-3 space-y-2">
                {own.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 text-sm">
                    <span>{s.customer?.farm_name || 'Unknown'}</span>
                    <span className="flex items-center gap-3">
                      <span className="font-semibold text-blue-600">{s.split_percentage}%</span>
                      <button type="button" disabled={saving} aria-label={`Remove ${s.customer?.farm_name || 'Unknown'}`}
                        className="p-2 -m-2 text-red-400 hover:text-red-600 transition-colors"
                        onClick={() => void write('Remove line share', () => supabase.from('order_item_shares').delete().eq('id', s.id).select())}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </span>
                  </div>
                ))}
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
                  <div className="sm:col-span-2">
                    <CustomerSearchPicker
                      value={customer?.id ?? ''}
                      selectedLabel={customer?.name ?? ''}
                      onSelect={(c) => setCustomer(c ? { id: c.id, name: c.farm_name } : null)}
                      excludeIds={own.map((s) => s.customer_id)}
                      placeholder="Search customer..."
                      ariaLabel="Line split customer"
                      disabled={saving}
                    />
                  </div>
                  {/* Locked while saving: the save's reply clears these, which would wipe a newer edit. */}
                  <input type="number" aria-label="Line split percent" value={pct} onChange={(e) => setPct(e.target.value)} disabled={saving}
                    placeholder="%" min="0.01" max="100" step="0.01"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20" />
                  <Button size="sm" showChevron={false} loading={saving} onClick={() => handleAdd(item.id, ownPercents)}>Add</Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
