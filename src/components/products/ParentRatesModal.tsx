import { useEffect, useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { formatExactUSD } from '../../lib/money';
import { Sentry } from '../../lib/sentry';
import {
  correctParentRates, loadOpenWork, previewParentRates, setParentRates,
  type OpenWorkEntry, type ParentRatePreview, type ProductParent,
} from '../../lib/productParents';
import { ReasonField } from './ProductParentPanel';

const TIERS = [1, 2, 3] as const;
const perAcre = (value: number | null | undefined) => (value == null ? 'none' : formatExactUSD(value));

/** Open quotes, orders and jobs using these sizes. Informational: a rate change reprices none of them. */
export function OpenWorkList({ productIds }: { productIds: string[] }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'failed' } | { status: 'loaded'; entries: OpenWorkEntry[] }>({ status: 'loading' });
  const idsKey = productIds.join(',');
  useEffect(() => {
    let cancelled = false;
    loadOpenWork(idsKey ? idsKey.split(',') : [])
      .then((entries) => { if (!cancelled) setState({ status: 'loaded', entries }); })
      .catch((error: unknown) => {
        Sentry.captureException(error, { extra: { context: 'product_parent_open_work' } });
        if (!cancelled) setState({ status: 'failed' });
      });
    return () => { cancelled = true; };
  }, [idsKey]);
  if (state.status === 'loading') return <p className="text-sm text-secondary" role="status">Checking open quotes, orders and jobs…</p>;
  if (state.status === 'failed') return <p className="text-sm text-secondary">Couldn&apos;t list open quotes, orders and jobs. Saving still changes no saved line.</p>;
  if (state.entries.length === 0) return <p className="text-sm text-secondary">No open quotes, orders or jobs use these sizes.</p>;
  return (
    <div className="text-sm">
      <p className="text-secondary">Open work using these sizes. Nothing saved on them changes; a rep can revise a sent quote with today&apos;s price.</p>
      <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-5 text-nav-dark">
        {state.entries.map((entry, index) => <li key={`${entry.product_id}-${entry.kind}-${entry.number}-${index}`}>{entry.message}</li>)}
      </ul>
    </div>
  );
}

const hasAnyCode = (error: unknown, codes: ReadonlyArray<Parameters<typeof hasRpcCode>[1]>) => codes.some((code) => hasRpcCode(error, code));
const previewWentStale = (error: unknown) => hasAnyCode(error, [
  RpcErrorCodes.PRODUCT_RATE_PREVIEW_CHANGED, RpcErrorCodes.PRODUCT_RATES_STALE,
  RpcErrorCodes.PRODUCT_PARENT_RATES_STALE, RpcErrorCodes.PRODUCT_PARENT_STALE,
]);
const lockSwitched = (error: unknown) => hasAnyCode(error, [RpcErrorCodes.PRODUCT_RATES_LOCKED, RpcErrorCodes.PRODUCT_RATES_NOT_LOCKED]);

function RateUnitSelect({ seedOrEach, unit, unitOptions, onChange }: {
  seedOrEach: boolean; unit: string; unitOptions: string[]; onChange: (unit: string) => void;
}) {
  if (seedOrEach) return <p className="text-sm text-secondary">Rate unit: each size uses its own stock unit.</p>;
  return (
    <div>
      <label htmlFor="parent-rate-unit" className="mb-1 block text-sm font-medium text-secondary">Rate Unit</label>
      <select id="parent-rate-unit" value={unit} onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20">
        <option value="">-- Select --</option>
        {unit && !unitOptions.includes(unit) && <option value={unit}>{unit} (existing)</option>}
        {unitOptions.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </div>
  );
}

function RatePreviewTable({ previewed, seedOrEach }: { previewed: ParentRatePreview; seedOrEach: boolean }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-secondary">Per-acre prices if you save:</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-secondary">
              <th className="font-medium">Size</th>
              {TIERS.map((tier) => <th key={tier} className="font-medium">Tier {tier}</th>)}
            </tr>
          </thead>
          <tbody>
            {previewed.sizes.map((size) => (
              <tr key={size.product_id}>
                <td className="pr-2">{size.product_name}{seedOrEach && size.inventory_unit ? ` (per ${size.inventory_unit})` : ''}</td>
                {TIERS.map((tier) => (
                  <td key={tier} className="pr-2">
                    {perAcre(size.before_prices[`tier${tier}_price_per_acre`])} → <span className="font-medium text-nav-dark">{perAcre(size.prices[`tier${tier}_price_per_acre`])}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <OpenWorkList productIds={previewed.sizes.map((size) => size.product_id)} />
    </div>
  );
}

/** The typed rates as sent: text, so the decimal arrives exactly; seed and each sizes keep their own unit. */
function rateInputs(rate: string, unit: string, suggested: string, seedOrEach: boolean) {
  const trimmed = rate.trim();
  // 9 whole digits and 6 decimals, the database's limit.
  const rateValid = trimmed === '' || /^\d{1,9}(\.\d{1,6})?$/.test(trimmed);
  return { rateValid, rates: { rate_per_acre: trimmed === '' ? null : trimmed, rate_unit: seedOrEach ? null : unit, suggested_rate: suggested } };
}

// Every new per-acre price reads as an exact dollar amount, so the admin saves what they saw.
const allShownExactly = (previewed: ParentRatePreview) => previewed.sizes.every((size) =>
  TIERS.every((tier) => perAcre(size.prices[`tier${tier}_price_per_acre`]) !== 'Invalid amount'));

const introText = (parent: ProductParent, ratesLocked: boolean) => (ratesLocked
  ? `Rates are locked. This corrects ${parent.name} and all ${parent.sizes.length} size(s), is logged with your reason, and reprices their per-acre prices.`
  : `Sets the rates of ${parent.name} and all ${parent.sizes.length} size(s), and reprices their per-acre prices.`);

/**
 * The parent's rates for every size. Rates open: preview, then save. Rates locked: the same, with a
 * reason, as a logged correction. The save sends the preview back so the database refuses any size
 * that changed since.
 */
export default function ParentRatesModal({ parent, profileId, ratesLocked, unitOptions, onClose, onSaved }: {
  parent: ProductParent;
  profileId: string;
  ratesLocked: boolean;
  unitOptions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const seedOrEach = parent.product_form === 'seed' || parent.product_form === 'each';
  const [rate, setRate] = useState(() => parent.rate_per_acre ?? '');
  const [unit, setUnit] = useState(() => parent.rate_unit ?? '');
  const [suggested, setSuggested] = useState(() => parent.suggested_rate ?? '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ input: string; result: ParentRatePreview } | null>(null);

  const { rateValid, rates } = rateInputs(rate, unit, suggested, seedOrEach);
  const previewInput = JSON.stringify(rates);
  const previewed = preview?.input === previewInput ? preview.result : null;
  const shownExactly = previewed != null && allShownExactly(previewed);
  const needsReason = ratesLocked;
  const canPreview = rateValid && (!needsReason || reason.trim() !== '') && !saving;
  const { getKey, resetKey } = useIdempotencyKey(ratesLocked ? 'correct_parent_rates' : 'set_parent_rates', profileId,
    JSON.stringify([parent.id, previewed?.parent_version, previewed?.sizes.map((size) => [size.product_id, size.pricing_version]), previewInput, reason.trim()]));

  const refuse = (error: unknown) => {
    toast('error', sanitizeError(error));
    if (previewWentStale(error)) setPreview(null);
    // The lock switched since this page loaded: reload so the right action shows.
    if (lockSwitched(error)) onSaved();
  };
  const showPreview = async () => {
    setSaving(true);
    try {
      setPreview({ input: previewInput, result: await previewParentRates(parent.id, rates) });
    } catch (error) {
      refuse(error);
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (!previewed) return;
    if (previewed.rates_locked !== ratesLocked) {
      toast('error', 'Nothing was saved. The rate lock changed since this page loaded. Reload and try again.');
      onSaved();
      return;
    }
    setSaving(true);
    try {
      if (ratesLocked) await correctParentRates(previewed, rates, reason.trim(), getKey());
      else await setParentRates([{ preview: previewed, rates }], getKey());
      resetKey();
      toast('success', `Rates saved on ${parent.name} and all ${previewed.sizes.length} size(s)`);
      onSaved();
    } catch (error) {
      refuse(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      size="large"
      title={ratesLocked ? 'Correct parent rates' : 'Parent rates'}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          {previewed
            ? <Button onClick={() => void save()} loading={saving} disabled={!canPreview || !shownExactly}>{ratesLocked ? 'Save correction' : 'Save rates'}</Button>
            : <Button onClick={() => void showPreview()} loading={saving} disabled={!canPreview}>Preview</Button>}
        </>
      )}
    >
      <fieldset disabled={saving} className="space-y-3">
        <p className="text-sm text-secondary">{introText(parent, ratesLocked)}</p>
        <Input label="Suggested Rate" value={suggested} onChange={(event) => setSuggested(event.target.value)} />
        <Input label="Rate Per Acre" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)}
          error={rateValid ? undefined : 'Enter zero or more, up to 9 digits and 6 decimals, or leave blank'} />
        <RateUnitSelect seedOrEach={seedOrEach} unit={unit} unitOptions={unitOptions} onChange={setUnit} />
        {needsReason && <ReasonField id="parent-rates-reason" label="Reason" value={reason} onChange={setReason} />}
        {previewed && <RatePreviewTable previewed={previewed} seedOrEach={seedOrEach} />}
      </fieldset>
    </Modal>
  );
}
