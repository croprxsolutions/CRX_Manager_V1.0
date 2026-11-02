import { useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { PRICING_SOURCE_CHOICES, pricingSourceValue, type PricingSourceChoice } from './pricingSource';

export interface PricingSourceReason {
  source: string;
  reason: string;
}

interface PricingSourceReasonModalProps {
  open: boolean;
  busy: boolean;
  /** How many products the change covers, for the heading. */
  productCount: number;
  onCancel: () => void;
  onSubmit: (value: PricingSourceReason) => void;
}

/**
 * Asks where a new price or cost came from and why, before a product-page or Products-list change is
 * previewed. The database refuses a price or cost change without both (20261027050000).
 */
export default function PricingSourceReasonModal({
  open,
  busy,
  productCount,
  onCancel,
  onSubmit,
}: PricingSourceReasonModalProps) {
  const [choice, setChoice] = useState<PricingSourceChoice | ''>('');
  const [detail, setDetail] = useState('');
  const [reason, setReason] = useState('');
  const source = pricingSourceValue(choice, detail);
  const ready = source.length > 0 && source.length <= 200 && reason.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      closeDisabled={busy}
      title="Where did this price come from?"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => onSubmit({ source, reason: reason.trim() })}
            disabled={!ready}
            loading={busy}
          >
            Preview changes
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          {productCount === 1 ? 'This change' : `These changes to ${productCount} products`} will be saved in the
          price history with the source and reason below.
        </p>
        <div>
          <label htmlFor="pricing-change-source" className="block text-sm font-medium text-secondary mb-1">Source</label>
          <select id="pricing-change-source" value={choice} disabled={busy}
            onChange={(event) => setChoice(event.target.value as PricingSourceChoice | '')}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20">
            <option value="">Choose a source</option>
            {PRICING_SOURCE_CHOICES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <Input id="pricing-change-source-detail" label="Source detail"
          placeholder="e.g. Helena, Oct 2026" value={detail} maxLength={200} disabled={busy}
          required={choice === 'Other'}
          error={source.length > 200 ? 'Source and detail must be 200 characters or less.' : undefined}
          onChange={(event) => setDetail(event.target.value)} />
        <Input
          id="pricing-change-reason"
          label="Reason for the change"
          placeholder="e.g. Supplier raised cost"
          value={reason}
          maxLength={500}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
    </Modal>
  );
}
