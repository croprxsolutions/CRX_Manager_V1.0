import { Plus, X } from 'lucide-react';
import {
  isBrandedLine, OTHER_BRAND,
  type DeliveryBrandLine, type DeliveryBrands, type DraftLines, type DraftPick,
} from '../../lib/deliveryBrands';
import type { DeliveryBrandsState } from './useDeliveryBrands';

const EMPTY_PICK: DraftPick = { brandId: '', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '' };
const FIELD_CLASS = 'min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green disabled:bg-gray-50';

interface DeliveryBrandPickerProps {
  brands: DeliveryBrands;
  drafts: DraftLines;
  onChange: (lineId: string, draft: DraftPick[]) => void;
  disabled: boolean;
  /** The amount one brand covers when the line is not split: loaded before completion, delivered in a correction. */
  fullQuantity: (line: DeliveryBrandLine) => number;
  /** Lines to leave out (a correction skips lines that delivered nothing). */
  hideLine?: (line: DeliveryBrandLine) => boolean;
}

/**
 * Which brand went off the truck, per line whose product has a brand list (Brand PR B, B-2): a listed brand
 * (currently bought first, then old stock), "Other brand…" typed from the jug, and Split for several brands
 * with an amount each. Showing nothing here never stops a completion.
 */
export default function DeliveryBrandPicker({ brands, drafts, onChange, disabled, fullQuantity, hideLine }: DeliveryBrandPickerProps) {
  const lines = brands.lines.filter((l) => isBrandedLine(l) && !hideLine?.(l));
  if (lines.length === 0) return null;

  return (
    <ul className="space-y-4">
      {lines.map((line) => {
        const draft = drafts[line.delivery_item_id] ?? [];
        const rows = draft.length > 0 ? draft : [EMPTY_PICK];
        const product = line.product_name || 'Unknown product';
        const unit = line.unit_size || 'units';
        const current = line.brand_list.filter((b) => b.is_currently_sourced);
        const oldStock = line.brand_list.filter((b) => !b.is_currently_sourced);
        const update = (index: number, patch: Partial<DraftPick>) => {
          // Going back to "Pick a brand…" on the only row clears the line.
          if (rows.length === 1 && patch.brandId === '') { onChange(line.delivery_item_id, []); return; }
          onChange(line.delivery_item_id, rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
        };
        const remove = (index: number) => onChange(line.delivery_item_id, rows.filter((_, i) => i !== index));
        const split = () => {
          // The first brand starts with the whole amount; the driver moves some of it to the new one.
          const first = rows.map((r) => (r.quantity.trim() === '' ? { ...r, quantity: String(fullQuantity(line)) } : r));
          onChange(line.delivery_item_id, [...first, EMPTY_PICK]);
        };
        return (
          <li key={line.delivery_item_id} className="rounded-xl border border-gray-200 bg-white p-3">
            <p className="font-medium text-nav-dark">{product}</p>
            {draft.length === 0 && <p className="text-sm text-amber-700">No brand picked yet.</p>}
            <div className="mt-2 space-y-3">
              {rows.map((row, index) => {
                const listed = row.brandId && row.brandId !== OTHER_BRAND;
                const onList = listed && line.brand_list.some((b) => b.brand_id === row.brandId);
                // A saved pick whose brand has since left the list keeps its name on screen.
                const savedName = listed && !onList
                  ? line.picks.find((p) => (p.parent_brand_id ?? p.legacy_brand_id) === row.brandId)?.brand_name ?? 'Saved brand'
                  : null;
                const label = `Brand for ${product}${rows.length > 1 ? ` (${index + 1})` : ''}`;
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={label}
                        className={FIELD_CLASS}
                        value={row.brandId}
                        disabled={disabled}
                        onChange={(e) => update(index, { brandId: e.target.value })}
                      >
                        <option value="">Pick a brand…</option>
                        {savedName && <option value={row.brandId}>{savedName} (no longer listed)</option>}
                        {current.length > 0 && (
                          <optgroup label="Currently bought">
                            {current.map((b) => <option key={b.brand_id} value={b.brand_id}>{b.brand_name}{b.epa_registration ? ` · EPA ${b.epa_registration}` : ''}</option>)}
                          </optgroup>
                        )}
                        {oldStock.length > 0 && (
                          <optgroup label="Not currently bought (old stock)">
                            {oldStock.map((b) => <option key={b.brand_id} value={b.brand_id}>{b.brand_name}{b.epa_registration ? ` · EPA ${b.epa_registration}` : ''}</option>)}
                          </optgroup>
                        )}
                        <option value={OTHER_BRAND}>Other brand…</option>
                      </select>
                      {(draft.length > 1 || (draft.length === 1 && row.brandId)) && (
                        <button
                          type="button"
                          onClick={() => remove(index)}
                          disabled={disabled}
                          aria-label={`Remove ${label}`}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-gray-100 disabled:opacity-50"
                        >
                          <X className="h-5 w-5" />
                        </button>
                      )}
                    </div>
                    {row.brandId === OTHER_BRAND && (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <input className={FIELD_CLASS} aria-label={`Brand name on the jug for ${product}`} placeholder="Brand name on the jug" maxLength={200}
                          value={row.typedName} disabled={disabled} onChange={(e) => update(index, { typedName: e.target.value })} />
                        <input className={FIELD_CLASS} aria-label={`EPA number for ${product} (optional)`} placeholder="EPA number, from the jug label (optional)" inputMode="numeric"
                          value={row.typedEpa} disabled={disabled} onChange={(e) => update(index, { typedEpa: e.target.value })} />
                        <input className={FIELD_CLASS} aria-label={`Manufacturer for ${product} (optional)`} placeholder="Manufacturer (optional)" maxLength={200}
                          value={row.typedManufacturer} disabled={disabled} onChange={(e) => update(index, { typedManufacturer: e.target.value })} />
                      </div>
                    )}
                    {rows.length > 1 && (
                      <label className="flex items-center gap-2 text-sm text-secondary">
                        Amount
                        <input className={`${FIELD_CLASS} w-32`} type="number" min="0" step="any" inputMode="decimal"
                          aria-label={`Amount of ${label}`} value={row.quantity} disabled={disabled}
                          onChange={(e) => update(index, { quantity: e.target.value })} />
                        {unit}
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            {draft.length > 0 && (
              <button
                type="button"
                onClick={split}
                disabled={disabled}
                className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-crx-green hover:underline disabled:opacity-50"
              >
                <Plus className="h-4 w-4" /> Split: add another brand
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The picker with its Save button and saved/unsaved status, for an open delivery. */
export function DeliveryBrandsPanel({ state, busy }: { state: DeliveryBrandsState; busy: boolean }) {
  const { brands, drafts, setLineDraft, dirty, saving, savedAt, loadFailed, save, reload } = state;
  if (loadFailed) {
    return (
      <p className="text-sm text-amber-800">
        Brands could not be loaded. The delivery can still be completed.{' '}
        <button type="button" className="font-medium underline" onClick={() => void reload()}>Try again</button>
      </p>
    );
  }
  if (!brands || !brands.lines.some(isBrandedLine)) return null;
  return (
    <section aria-label="Brands delivered" className="space-y-3">
      <h2 className="font-heading text-xl font-bold text-nav-dark">Brands delivered</h2>
      <p className="text-sm text-secondary">Pick the brand on each jug. If it is not listed, choose Other brand and type it.</p>
      <DeliveryBrandPicker
        brands={brands}
        drafts={drafts}
        onChange={setLineDraft}
        disabled={busy || saving}
        fullQuantity={(line) => line.quantity}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || busy || saving}
          className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-nav-dark hover:bg-gray-50 disabled:opacity-50"
        >
          {saving ? 'Saving brands…' : 'Save brands'}
        </button>
        <span role="status" className={`text-sm ${dirty ? 'text-amber-800' : 'text-secondary'}`}>
          {dirty ? 'Brand choices not saved yet. Complete saves them first.' : savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
      </div>
    </section>
  );
}
