import { useState } from 'react';
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../../lib/parseCents';
import { pricingDollarInputToCents } from '../../lib/productPricing';
import type { Product } from '../../types';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';

const PRICE_FIELDS = [
  { field: 'current_cost', label: 'Current Cost' },
  { field: 'tier1_price', label: 'Tier 1 price' },
  { field: 'tier2_price', label: 'Tier 2 price' },
  { field: 'tier3_price', label: 'Tier 3 price' },
] as const;

type PriceField = (typeof PRICE_FIELDS)[number]['field'];
export type QuickPriceFields = Record<PriceField, string>;

interface QuickPriceChangeModalProps {
  product: Pick<Product, 'product_name' | 'sku' | PriceField>;
  onClose: () => void;
  onSubmit: (fields: QuickPriceFields) => void;
}

function amountProblem(typed: string): string | null {
  if (typed.trim() === '') return 'Enter an amount.';
  if (parseDollarsToCents(typed) === null) return MONEY_PRECISION_MESSAGE;
  // parseDollarsToCents reads junk as 0 and drops a minus sign; a price must never be saved from either.
  return pricingDollarInputToCents(typed) === null ? 'Enter a plain dollar amount, such as 12.50.' : null;
}

/**
 * One product's cost and tier prices, typed on a phone. It saves nothing: the caller sends these into
 * the source, reason, preview and approval steps every price change goes through.
 */
export default function QuickPriceChangeModal({ product, onClose, onSubmit }: QuickPriceChangeModalProps) {
  const [fields, setFields] = useState<QuickPriceFields>(() => ({
    current_cost: product.current_cost == null ? '' : String(product.current_cost),
    tier1_price: product.tier1_price == null ? '' : String(product.tier1_price),
    tier2_price: product.tier2_price == null ? '' : String(product.tier2_price),
    tier3_price: product.tier3_price == null ? '' : String(product.tier3_price),
  }));
  const [showProblems, setShowProblems] = useState(false);

  const review = () => {
    if (PRICE_FIELDS.some(({ field }) => amountProblem(fields[field]))) {
      setShowProblems(true);
      return;
    }
    onSubmit({
      current_cost: fields.current_cost.trim(),
      tier1_price: fields.tier1_price.trim(),
      tier2_price: fields.tier2_price.trim(),
      tier3_price: fields.tier3_price.trim(),
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Change"
      accent="Price"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" showChevron={false} onClick={onClose}>Cancel</Button>
          <Button onClick={review}>Review Price Change</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="font-semibold text-nav-dark">{product.product_name}</p>
          <p className="text-sm text-secondary">SKU: {product.sku || '—'}</p>
        </div>
        {PRICE_FIELDS.map(({ field, label }) => (
          <Input
            key={field}
            id={`quick-price-${field}`}
            label={label}
            inputMode="decimal"
            autoComplete="off"
            value={fields[field]}
            error={showProblems ? amountProblem(fields[field]) ?? undefined : undefined}
            onChange={(event) => setFields((current) => ({ ...current, [field]: event.target.value }))}
          />
        ))}
        <p className="text-sm text-secondary">
          These prices are kept and the margins are reconciled. Nothing changes until you review and apply.
        </p>
      </div>
    </Modal>
  );
}
