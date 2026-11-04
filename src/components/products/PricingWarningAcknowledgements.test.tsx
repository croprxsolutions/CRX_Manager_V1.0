import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PricingWarning } from '../../lib/productPricing';
import PricingWarningAcknowledgements from './PricingWarningAcknowledgements';

describe('tier-order warning details', () => {
  it('names both offending tiers with exact formatted cents', () => {
    const warning: PricingWarning = {
      product_id: 'product-1',
      warning_codes: ['TIER_ORDER'],
      details: {
        cost_before_cents: 2000n, cost_after_cents: 2000n, margin_floor: null,
        tiers: [], open_quote_count: 0, open_quote_numbers: [],
        tier_order: [{ lower_tier: 1, higher_tier: 2, lower_cents: 3000n, higher_cents: 2900n }],
      },
    };
    render(<PricingWarningAcknowledgements warnings={[warning]} rows={[]} reasons={{}} disabled={false} onReasonChange={() => undefined} />);
    expect(screen.getByText(/Tier 2 \$29\.00 is below Tier 1 \$30\.00/)).toBeInTheDocument();
  });
});
