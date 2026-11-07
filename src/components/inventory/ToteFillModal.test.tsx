import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToteFillPreview } from '../../lib/toteFill';

const { mockFill, mockPreview, mockToast } = vi.hoisted(() => ({ mockFill: vi.fn(), mockPreview: vi.fn(), mockToast: vi.fn() }));
vi.mock('../../lib/toteFill', () => ({ fillToteFromBulk: mockFill, previewToteFill: mockPreview, TOTE_FILL_LOCATION: 'Main Warehouse' }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import ToteFillModal from './ToteFillModal';

const preview = (over: Partial<ToteFillPreview> = {}): ToteFillPreview => ({
  tote_product_id: 'tote', bulk_product_id: 'bulk', parent_id: 'parent', totes: 1, tote_unit: 'Ea', tote_size: 265,
  tote_size_unit: 'Gal', gallons: 265, bulk_unit: 'Gal', bulk_quantity: 265, bulk_before: 1000, bulk_after: 735,
  tote_before: 0, tote_after: 1, shortfall: 0, bulk_cost_cents: 400, tote_cost_cents: 106000,
  estimate_before_cents: 400000, estimate_after_cents: 400000, cost_check: 'equal', ...over,
});

const open = (onFilled = vi.fn(), onClose = vi.fn()) =>
  render(<ToteFillModal toteProductId="tote" toteName="UAN 265 Tote" profileId="u1" onClose={onClose} onFilled={onFilled} />);

describe('fill a tote from bulk', () => {
  beforeEach(() => { mockFill.mockReset(); mockPreview.mockReset(); mockToast.mockReset(); });

  it('previews, then sends exactly the preview it showed with a retry key', async () => {
    const shown = preview();
    mockPreview.mockResolvedValue(shown);
    mockFill.mockResolvedValue({ fill_id: 'f1', bulk_unit: 'Gal', bulk_quantity: 265, bulk_after: 735, tote_after: 1, shortfall: 0, requires_review: false });
    const onFilled = vi.fn();
    const onClose = vi.fn();
    open(onFilled, onClose);
    expect(screen.getByRole('button', { name: 'Fill Tote' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByTestId('tote-fill-preview');
    expect(mockPreview).toHaveBeenCalledWith('tote', 1);
    expect(screen.getByText('735')).toBeInTheDocument();
    expect(screen.getByText(/\$4,000\.00 before/)).toBeInTheDocument();
    expect(screen.getByText(/costs match per gallon/)).toBeInTheDocument();
    expect(screen.getByText(/Purchase cost is not tracked yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fill Tote' }));
    await waitFor(() => expect(onFilled).toHaveBeenCalled());
    expect(mockFill).toHaveBeenCalledWith(shown, expect.stringMatching(/^fill_tote_from_bulk:u1:/));
    expect(onClose).toHaveBeenCalled();
  });

  it('changing the tote count hides the old preview until a new one is taken', async () => {
    mockPreview.mockResolvedValue(preview());
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByTestId('tote-fill-preview');
    fireEvent.change(screen.getByLabelText('Totes to fill'), { target: { value: '2' } });
    expect(screen.queryByTestId('tote-fill-preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Fill Tote' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Totes to fill'), { target: { value: '1' } });
    expect(screen.queryByTestId('tote-fill-preview')).toBeNull();
    fireEvent.change(screen.getByLabelText('Totes to fill'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('warns on a shortfall and flags a missing cost', async () => {
    mockPreview.mockResolvedValue(preview({ bulk_before: 200, bulk_after: -65, shortfall: 65, cost_check: 'missing',
      estimate_before_cents: null, estimate_after_cents: null, tote_cost_cents: null }));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bulk is short 65 Gal');
    expect(screen.getByText(/catalog cost is missing/)).toBeInTheDocument();
    expect(screen.queryByText(/before,/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Fill Anyway' })).toBeEnabled();
  });

  it('when stock changed since the preview, shows the new preview and records nothing until confirmed again', async () => {
    mockPreview.mockResolvedValueOnce(preview({ bulk_before: 300, bulk_after: 35 }))
      .mockResolvedValueOnce(preview({ bulk_before: 35, bulk_after: -230, shortfall: 230 }));
    mockFill.mockRejectedValueOnce({ code: 'P0001', message: 'TOTE_FILL_PREVIEW_CHANGED: stock, units, source or catalog cost changed since the preview; preview again' });
    const onFilled = vi.fn();
    open(onFilled);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fill Tote' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bulk is short 230 Gal');
    expect(mockPreview).toHaveBeenCalledTimes(2);
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Nothing was saved'));
    expect(onFilled).not.toHaveBeenCalled();
    expect(mockFill).toHaveBeenCalledTimes(1);
  });

  it('when the answer is lost, only resends the same preview with the same key, so it cannot fill twice', async () => {
    const shown = preview();
    mockPreview.mockResolvedValue(shown);
    mockFill.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ fill_id: 'f1', bulk_unit: 'Gal', bulk_quantity: 265, bulk_after: 735, tote_after: 1, shortfall: 0, requires_review: false });
    const onFilled = vi.fn();
    open(onFilled);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fill Tote' }));
    const retry = await screen.findByRole('button', { name: 'Try Again' });
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('will not fill twice'));
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(screen.getByLabelText('Totes to fill')).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(onFilled).toHaveBeenCalled());
    expect(mockFill).toHaveBeenCalledTimes(2);
    expect(mockFill.mock.calls[1]).toEqual(mockFill.mock.calls[0]);
    expect(mockPreview).toHaveBeenCalledTimes(1);
  });

  it('closing after a lost answer refreshes the counts', async () => {
    mockPreview.mockResolvedValue(preview());
    mockFill.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const onFilled = vi.fn();
    const onClose = vi.fn();
    open(onFilled, onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fill Tote' }));
    await screen.findByRole('button', { name: 'Try Again' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onFilled).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a refusal by name and keeps the dialog open', async () => {
    mockPreview.mockRejectedValue({ message: 'TOTE_FILL_TOTE_UNIT: "UAN 265 Tote" is stocked in Gal; a tote must be stocked as Ea or Unit (correct its stock unit first)' });
    const onClose = vi.fn();
    open(vi.fn(), onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('is stocked in Gal')));
    expect(screen.queryByTestId('tote-fill-preview')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
