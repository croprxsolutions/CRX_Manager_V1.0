import { AlertTriangle, Plus, X } from 'lucide-react';
import {
  cancelledOnText, normalizeEpaRegistration, type CancelledRegistrations, type RegistrationCheck,
} from '../../lib/epaRegistrationStatus';
import {
  isBrandedLine, OTHER_BRAND,
  type DeliveryBrandLine, type DeliveryBrands, type DraftLines, type DraftPick,
} from '../../lib/deliveryBrands';
import type { DeliveryBrandsState } from './useDeliveryBrands';
import { useBrandCancellations } from './useBrandCancellations';

const EMPTY_PICK: DraftPick = { brandId: '', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '' };
/** Grand plan §8 (#1849): a loud red note beside the pick when its EPA number is stored as cancelled; never blocks. */
function CancelledNote({ label, epa, cancelled, testId }: { label: string; epa: string | null | undefined; cancelled: CancelledRegistrations; testId: string }) {
  const key = normalizeEpaRegistration(epa);
  if (!key || !cancelled.has(key)) return null;
  return (
    <div role="alert" data-testid={testId} className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p><span className="font-semibold">Cancelled EPA registration.</span> {label}: EPA Reg. No. {key}, {cancelledOnText(cancelled.get(key))}.
        {' '}The delivery is not blocked. Check the registration with EPA before applying it.</p>
    </div>
  );
}

/**
 * The name and EPA numbers of the brand a row picks: typed from the jug, or the listed brand's current number plus
 * the number recorded on its saved pick, which can differ once the brand record changes.
 */
function pickedBrands(line: DeliveryBrandLine, row: DraftPick): { name: string; epa: string | null }[] {
  if (row.brandId === OTHER_BRAND) return [{ name: row.typedName.trim() || 'Typed brand', epa: row.typedEpa }];
  if (!row.brandId) return [];
  const listed = line.brand_list.filter((b) => b.brand_id === row.brandId).map((b) => ({ name: b.brand_name, epa: b.epa_registration }));
  const saved = line.picks.filter((p) => (p.parent_brand_id ?? p.legacy_brand_id) === row.brandId)
    .map((p) => ({ name: p.brand_name, epa: p.epa_registration }));
  const all = [...listed, ...saved];
  return all.filter((b, i) => all.findIndex((o) => normalizeEpaRegistration(o.epa) === normalizeEpaRegistration(b.epa)) === i);
}

/** Notes the picker shows above its lines: still checking, could not check, and cancelled products on lines it does not show. */
function RegistrationNotices({ check, hidden, productNumbers, cancelled }: {
  check: RegistrationCheck; hidden: DeliveryBrandLine[]; productNumbers: Map<string, string | null>; cancelled: CancelledRegistrations;
}) {
  return (
    <>
      {check === 'checking' && <li role="status" className="text-xs text-secondary">Checking EPA registration status…</li>}
      {check === 'incomplete' && (
        <li role="status" data-testid="registration-check-failed" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Could not check whether these EPA registrations are cancelled. Reload the page to try again. The delivery can still be completed.
        </li>
      )}
      {hidden.map((line) => (
        <li key={line.delivery_item_id}>
          <CancelledNote label={line.product_name || 'Unknown product'} epa={productNumbers.get(line.product_id)} cancelled={cancelled} testId="cancelled-registration-product" />
        </li>
      ))}
    </>
  );
}

const FIELD_CLASS = 'min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green disabled:bg-gray-50';

interface DeliveryBrandPickerProps {
  brands: DeliveryBrands;
  drafts: DraftLines;
  onChange: (lineId: string, draft: DraftPick[]) => void;
  disabled: boolean;
  /** The amount one brand covers when the line is not split: loaded before completion, delivered in a correction. */
  fullQuantity: (line: DeliveryBrandLine) => number;
  /** Lines to show: by default those with a brand list or picks; a correction shows every delivered line. */
  showLine?: (line: DeliveryBrandLine) => boolean;
}

/**
 * Which brand went off the truck, per line whose product has a brand list (Brand PR B, B-2): a listed brand
 * (currently bought first, then old stock), "Other brand…" typed from the jug, and Split for several brands
 * with an amount each. Showing nothing here never stops a completion.
 */
export default function DeliveryBrandPicker({ brands, drafts, onChange, disabled, fullQuantity, showLine = isBrandedLine }: DeliveryBrandPickerProps) {
  const lines = brands.lines.filter(showLine);
  // Every line's product is checked, so a cancelled product on a line with no brand list still warns (Sol r1).
  const registrations = useBrandCancellations(brands.lines, drafts);
  const { cancelled, productNumbers, check } = registrations;
  const isCancelled = (epa: string | null | undefined) => cancelled.has(normalizeEpaRegistration(epa) ?? '');
  const hidden = brands.lines.filter((l) => !showLine(l) && isCancelled(productNumbers.get(l.product_id)));
  if (lines.length === 0 && hidden.length === 0 && check === 'complete') return null;
  const optionText = (b: { brand_name: string; epa_registration: string | null }) => {
    const key = normalizeEpaRegistration(b.epa_registration);
    return `${b.brand_name}${key ? ` · EPA ${b.epa_registration}` : ''}${key && cancelled.has(key) ? ' · CANCELLED' : ''}`;
  };

  return (
    <ul className="space-y-4">
      <RegistrationNotices check={check} hidden={hidden} productNumbers={productNumbers} cancelled={cancelled} />
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
        const remove = (index: number) => {
          const left = rows.filter((_, i) => i !== index);
          // One brand left: its amount field is hidden, so it covers the whole line again.
          onChange(line.delivery_item_id, left.length === 1 ? [{ ...left[0], quantity: '' }] : left);
        };
        const split = () => {
          // On the first split the one brand starts with the whole amount; the driver moves some to the new one.
          const first = rows.length === 1 && rows[0].quantity.trim() === ''
            ? [{ ...rows[0], quantity: String(fullQuantity(line)) }] : rows;
          onChange(line.delivery_item_id, [...first, EMPTY_PICK]);
        };
        return (
          <li key={line.delivery_item_id} className="rounded-xl border border-gray-200 bg-white p-3">
            <p className="font-medium text-nav-dark">{product}</p>
            <CancelledNote label={product} epa={productNumbers.get(line.product_id)} cancelled={cancelled} testId="cancelled-registration-product" />
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
                const picked = pickedBrands(line, row);
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
                            {current.map((b) => <option key={b.brand_id} value={b.brand_id}>{optionText(b)}</option>)}
                          </optgroup>
                        )}
                        {oldStock.length > 0 && (
                          <optgroup label="Not currently bought (old stock)">
                            {oldStock.map((b) => <option key={b.brand_id} value={b.brand_id}>{optionText(b)}</option>)}
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
                    {picked.map((b) => <CancelledNote key={`${b.name}|${b.epa}`} label={b.name} epa={b.epa} cancelled={cancelled} testId="cancelled-registration-pick" />)}
                    {row.brandId === OTHER_BRAND && (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <input className={FIELD_CLASS} aria-label={`Brand name on the jug for ${label}`} placeholder="Brand name on the jug" maxLength={200}
                          value={row.typedName} disabled={disabled} onChange={(e) => update(index, { typedName: e.target.value })} />
                        <input className={FIELD_CLASS} aria-label={`EPA number for ${label} (optional)`} placeholder="EPA number, from the jug label (optional)" inputMode="numeric"
                          value={row.typedEpa} disabled={disabled} onChange={(e) => update(index, { typedEpa: e.target.value })} />
                        <input className={FIELD_CLASS} aria-label={`Manufacturer for ${label} (optional)`} placeholder="Manufacturer (optional)" maxLength={200}
                          value={row.typedManufacturer} disabled={disabled} onChange={(e) => update(index, { typedManufacturer: e.target.value })} />
                      </div>
                    )}
                    {/* One brand covers the whole line, unless its saved amount says otherwise (then it can be fixed). */}
                    {(rows.length > 1 || (row.quantity.trim() !== '' && Number(row.quantity) !== fullQuantity(line))) && (
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
  if (!brands) return null;
  if (!brands.lines.some(isBrandedLine)) {
    // Nothing to pick, but a cancelled product registration still shows (Sol r1).
    return <DeliveryBrandPicker brands={brands} drafts={drafts} onChange={setLineDraft} disabled fullQuantity={(line) => line.quantity} />;
  }
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
