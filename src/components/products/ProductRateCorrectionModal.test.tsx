import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '../../types';

const { mockCorrect, mockPreview } = vi.hoisted(() => ({ mockCorrect: vi.fn(), mockPreview: vi.fn() }));
vi.mock('../../lib/productRateLock', () => ({ correctProductRates: mockCorrect, previewProductRateCorrection: mockPreview }));

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
  it('previews per-acre prices, then sends one product with the version it loaded and the reason', async () => {
    mockPreview.mockResolvedValue({ before: values(13, 4.06), after: values(16, 5) });
    mockCorrect.mockResolvedValue({ product_id: 'p1', product_name: 'Alpha', pricing_version: 8,
      before: values(13, 4.06), after: values(16, 5.25) });
    const onCorrected = vi.fn();
    render(<ProductRateCorrectionModal open product={product} profileId="u1" unitOptions={['oz', 'Gal']}
      onClose={vi.fn()} onCorrected={onCorrected} />);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: ' label fix ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('Per-acre prices if you save:')).toBeInTheDocument());
    expect(screen.getByText('$5.00')).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledWith({ productId: 'p1', ratePerAcre: 16, rateUnit: 'oz' });
    expect(mockCorrect).not.toHaveBeenCalled();
    // Changing the rate after a preview needs a new preview before it can save.
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '17' } });
    expect(screen.queryByRole('button', { name: 'Save correction' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(screen.getByText('Saved and logged. Per-acre prices now:')).toBeInTheDocument());
    // The saved result's After price, which differs from the preview's $5.00.
    expect(screen.getByText('$5.25')).toBeInTheDocument();
    expect(mockCorrect).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'p1', ratePerAcre: 16, rateUnit: 'oz', suggestedRate: '13 oz/A', expectedPricingVersion: 7, reason: 'label fix',
      expected: { prices: values(16, 5), rate_per_acre: '13', rate_unit: 'oz', suggested_rate: '13 oz/A' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCorrected).toHaveBeenCalled();
  });

  it('freezes the form while a save is pending, so the saved rate is the one shown', async () => {
    mockPreview.mockResolvedValue({ before: values(13, 4.06), after: values(16, 5) });
    mockCorrect.mockReset().mockReturnValueOnce(new Promise(() => undefined));
    render(<ProductRateCorrectionModal open product={product} profileId="u1" unitOptions={['oz']}
      onClose={vi.fn()} onCorrected={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'label fix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(screen.getByLabelText('Rate Per Acre')).toBeDisabled());
    expect(screen.getByLabelText('Reason (required)')).toBeDisabled();
  });

  it('refuses a negative or non-numeric rate before sending', () => {
    render(<ProductRateCorrectionModal open product={product} profileId="u1" unitOptions={['oz']}
      onClose={vi.fn()} onCorrected={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('reloads the product when it changed or rates were unlocked meanwhile', async () => {
    mockPreview.mockResolvedValue({ before: values(13, 4.06), after: values(16, 5) });
    mockCorrect.mockRejectedValue(new Error('PRODUCT_RATES_NOT_LOCKED: rates are open; change them on the product page'));
    const onCorrected = vi.fn();
    render(<ProductRateCorrectionModal open product={product} profileId="u1" unitOptions={['oz']}
      onClose={vi.fn()} onCorrected={onCorrected} />);
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(onCorrected).toHaveBeenCalled());
  });

  it('asks for a new preview when the prices moved since the one shown', async () => {
    mockPreview.mockResolvedValue({ before: values(13, 4.06), after: values(16, 5) });
    mockCorrect.mockRejectedValue(new Error('PRODUCT_RATE_PREVIEW_CHANGED: the per-acre prices changed since the preview; preview again'));
    const onCorrected = vi.fn();
    render(<ProductRateCorrectionModal open product={product} profileId="u1" unitOptions={['oz']}
      onClose={vi.fn()} onCorrected={onCorrected} />);
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save correction' }));
    expect(await screen.findByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save correction' })).toBeNull();
    expect(onCorrected).not.toHaveBeenCalled();
  });

  it('will not save prices it could not show exactly', async () => {
    mockPreview.mockResolvedValue({ before: values(13, 4.06), after: values(16, 80_000_000_000_000) });
    render(<ProductRateCorrectionModal open product={product} profileId="u1" unitOptions={['oz']}
      onClose={vi.fn()} onCorrected={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Rate Per Acre'), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('button', { name: 'Save correction' })).toBeDisabled();
    expect(screen.getByText('Invalid amount')).toBeInTheDocument();
  });

  it('shows the database refusal text without its code', () => {
    expect(sanitizeError(new Error('PRODUCT_RATES_LOCKED: rates are locked; an admin can correct one product')))
      .toBe('Nothing was saved. Rates are locked; an admin can correct one product');
  });
});
