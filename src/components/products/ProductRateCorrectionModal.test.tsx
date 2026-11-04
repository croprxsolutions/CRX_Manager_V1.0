import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '../../types';

const { mockCorrect } = vi.hoisted(() => ({ mockCorrect: vi.fn() }));
vi.mock('../../lib/productRateLock', () => ({ correctProductRates: mockCorrect }));

import ProductRateCorrectionModal from './ProductRateCorrectionModal';
import { sanitizeError } from '../../lib/db';

const product = {
  id: 'p1', product_name: 'Alpha', rate_per_acre: 13, rate_unit: 'oz', suggested_rate: '13 oz/A', pricing_version: 7,
} as Product;
const values = (rate: number, perAcre: number) => ({
  rate_per_acre: rate, rate_unit: 'oz', suggested_rate: `${rate} oz/A`,
  tier1_price_per_acre: perAcre, tier2_price_per_acre: null, tier3_price_per_acre: null,
});

describe('correct rates while locked', () => {
  it('sends one product with the version it loaded and the reason, then shows per-acre before and after', async () => {
    mockCorrect.mockResolvedValue({ product_id: 'p1', product_name: 'Alpha', pricing_version: 8,
      before: values(13, 4.06), after: values(16, 5) });
    const onCorrected = vi.fn();
    render(<ProductRateCorrectionModal open product={product} profileId="u1" unitOptions={['oz', 'Gal']}
      onClose={vi.fn()} onCorrected={onCorrected} />);
    const save = screen.getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: ' label fix ' } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText('$5.00')).toBeInTheDocument());
    expect(screen.getByText('$4.06')).toBeInTheDocument();
    expect(mockCorrect).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'p1', ratePerAcre: 16, rateUnit: 'oz', suggestedRate: '13 oz/A', expectedPricingVersion: 7, reason: 'label fix',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCorrected).toHaveBeenCalled();
  });

  it('refuses a negative or non-numeric rate before sending', () => {
    render(<ProductRateCorrectionModal open product={product} profileId="u1" unitOptions={['oz']}
      onClose={vi.fn()} onCorrected={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  });

  it('shows the database refusal text without its code', () => {
    expect(sanitizeError(new Error('PRODUCT_RATES_LOCKED: rates are locked; an admin can correct one product')))
      .toBe('Nothing was saved. Rates are locked; an admin can correct one product');
  });
});
