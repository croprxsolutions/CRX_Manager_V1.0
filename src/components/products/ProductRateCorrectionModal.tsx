import { useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { formatExactUSD } from '../../lib/money';
import { correctProductRates, previewProductRateCorrection } from '../../lib/productRateLock';
import type { Product, ProductRatePreview, ProductRateWriteResult } from '../../types';

const TIERS = [1, 2, 3] as const;
const perAcre = (value: number | null) => (value == null ? 'none' : formatExactUSD(value));

function PerAcreTable({ prices }: { prices: ProductRatePreview }) {
  return (
    <table className="w-full text-left text-sm">
      <thead><tr className="text-secondary"><th className="font-medium">Tier</th><th className="font-medium">Before</th><th className="font-medium">After</th></tr></thead>
      <tbody>
        {TIERS.map((tier) => (
          <tr key={tier}>
            <td>Tier {tier}</td>
            <td>{perAcre(prices.before[`tier${tier}_price_per_acre`])}</td>
            <td className="font-medium text-nav-dark">{perAcre(prices.after[`tier${tier}_price_per_acre`])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * While rates are locked, an admin corrects one product's rates with a reason. It previews the new
 * per-acre prices first; the database then checks the product has not changed since this page loaded
 * it, logs the correction, and reprices per acre.
 */
export default function ProductRateCorrectionModal({ open, product, profileId, unitOptions, onClose, onCorrected }: {
  open: boolean;
  product: Product;
  profileId: string;
  unitOptions: string[];
  onClose: () => void;
  onCorrected: () => void;
}) {
  const { toast } = useToast();
  const [rate, setRate] = useState(product.rate_per_acre == null ? '' : String(product.rate_per_acre));
  const [unit, setUnit] = useState(product.rate_unit ?? '');
  const [suggested, setSuggested] = useState(product.suggested_rate ?? '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ input: string; prices: ProductRatePreview } | null>(null);
  const [result, setResult] = useState<ProductRateWriteResult | null>(null);
  const { getKey, resetKey } = useIdempotencyKey('correct_product_rates', profileId,
    JSON.stringify([product.id, product.pricing_version, rate, unit, suggested, reason.trim()]));

  // 9 whole digits keep the rate exact as a JavaScript number on its way to the database.
  const rateValid = rate.trim() === '' || /^\d{1,9}(\.\d{1,6})?$/.test(rate.trim());
  const ratePerAcre = rate.trim() === '' ? null : Number(rate.trim());
  const previewInput = JSON.stringify([rate.trim(), unit]);
  const previewed = preview?.input === previewInput ? preview.prices : null;
  // Nothing is confirmed that the window could not show as an exact amount.
  const shownExactly = previewed != null
    && TIERS.every((tier) => perAcre(previewed.after[`tier${tier}_price_per_acre`]) !== 'Invalid amount');
  const canSave = rateValid && reason.trim() !== '' && !saving && Number.isInteger(product.pricing_version);

  const refuse = (error: unknown) => {
    toast('error', sanitizeError(error));
    // The product or the lock changed since this page loaded it: reload rather than retry.
    if (hasRpcCode(error, RpcErrorCodes.PRODUCT_RATES_STALE) || hasRpcCode(error, RpcErrorCodes.PRODUCT_RATES_NOT_LOCKED)) onCorrected();
    // A unit conversion changed since the preview: show the new prices before another save.
    if (hasRpcCode(error, RpcErrorCodes.PRODUCT_RATE_PREVIEW_CHANGED)) setPreview(null);
  };
  const showPreview = async () => {
    setSaving(true);
    try {
      const prices = await previewProductRateCorrection({ productId: product.id, ratePerAcre, rateUnit: unit });
      setPreview({ input: previewInput, prices });
    } catch (error) {
      refuse(error);
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (!previewed) return;
    setSaving(true);
    try {
      const corrected = await correctProductRates({
        productId: product.id,
        ratePerAcre,
        rateUnit: unit,
        suggestedRate: suggested,
        expectedPricingVersion: product.pricing_version,
        expectedPrices: previewed.after,
        reason: reason.trim(),
        performedBy: profileId,
        idempotencyKey: getKey(),
      });
      resetKey();
      setResult(corrected);
      toast('success', 'Rates corrected');
    } catch (error) {
      refuse(error);
    } finally {
      setSaving(false);
    }
  };
  const finish = () => {
    if (result) onCorrected();
    else onClose();
  };

  return (
    <Modal
      open={open}
      onClose={finish}
      closeDisabled={saving}
      title="Correct rates"
      footer={result ? <Button onClick={finish}>Done</Button> : (
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          {previewed
            ? <Button onClick={() => void save()} loading={saving} disabled={!canSave || !shownExactly}>Save correction</Button>
            : <Button onClick={() => void showPreview()} loading={saving} disabled={!canSave}>Preview</Button>}
        </>
      )}
    >
      {result ? (
        <div className="space-y-2 text-sm">
          <p className="text-secondary">Saved and logged. Per-acre prices now:</p>
          <PerAcreTable prices={result} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-secondary">
            Rates are locked. This changes only this product, is logged with your reason, and reprices its per-acre prices.
          </p>
          <Input label="Suggested Rate" value={suggested} onChange={(e) => setSuggested(e.target.value)} />
          <Input label="Rate Per Acre" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)}
            error={rateValid ? undefined : 'Enter zero or more, up to 9 digits and 6 decimals, or leave blank'} />
          <div>
            <label htmlFor="product-rate-correction-unit" className="block text-sm font-medium text-secondary mb-1">Rate Unit</label>
            <select
              id="product-rate-correction-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">-- Select --</option>
              {unit && !unitOptions.includes(unit) && <option value={unit}>{unit} (existing)</option>}
              {unitOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="product-rate-correction-reason" className="block text-sm font-medium text-secondary">Reason (required)</label>
            <textarea
              id="product-rate-correction-reason"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {previewed && (
            <div className="space-y-2">
              <p className="text-sm text-secondary">Per-acre prices if you save:</p>
              <PerAcreTable prices={previewed} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
