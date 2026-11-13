import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TypedBrandReview from './TypedBrandReview';

const toast = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));

const saveProductBrand = vi.fn();
vi.mock('../../lib/productBrands', () => ({
  getProductBrands: vi.fn(async () => ({ parentId: 'parent-1', brands: [] })),
  saveProductBrand: (...args: unknown[]) => saveProductBrand(...args),
  productBrandErrorMessage: () => 'brand error',
}));

const reviewTypedBrand = vi.fn();
const getTypedBrandsForReview = vi.fn();
vi.mock('../../lib/deliveryBrands', () => ({
  getTypedBrandsForReview: () => getTypedBrandsForReview(),
  reviewTypedBrand: (...args: unknown[]) => reviewTypedBrand(...args),
  deliveryBrandErrorMessage: () => 'Brands not saved.',
}));

const row = {
  pick_id: 'pick-1', delivery_id: 'D1', delivery_number: 'DEL-1', delivery_item_id: 'L1', product_id: 'P1',
  product_name: 'Glyphosate', brand_name: 'Credit', epa_registration: null, manufacturer: null, quantity: 5, review_note: null,
};

describe('TypedBrandReview', () => {
  it('replays the same add on retry when the link failed, so no second brand is created', async () => {
    getTypedBrandsForReview.mockResolvedValue([row]);
    saveProductBrand.mockResolvedValue({ id: 'brand-9' });
    reviewTypedBrand.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});
    render(<MemoryRouter><TypedBrandReview /></MemoryRouter>);

    expect((await screen.findByText('Add to list')).closest('button')).toBeDisabled(); // restricted-use status must be chosen first
    fireEvent.change(screen.getByLabelText('Is Credit restricted use?'), { target: { value: 'yes' } });
    fireEvent.click(await screen.findByText('Add to list'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', 'Brands not saved.'));
    fireEvent.click(await screen.findByText('Add to list'));
    await waitFor(() => expect(reviewTypedBrand).toHaveBeenCalledTimes(2));

    const addKeys = saveProductBrand.mock.calls.map((c) => c[1]);
    expect(addKeys).toHaveLength(2);
    expect(addKeys[1]).toBe(addKeys[0]);
    // Saved as the admin said: restricted use, and not marked as bought now unless ticked (the jug may be old stock).
    expect(saveProductBrand.mock.calls[0][0]).toEqual(expect.objectContaining({ isRup: true, isCurrentlySourced: false }));
  });

  it('says when the review list could not load and offers a retry', async () => {
    getTypedBrandsForReview.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([row]);
    render(<MemoryRouter><TypedBrandReview /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Try again'));
    expect(await screen.findByText('Brands to review')).toBeTruthy();
  });

  it('offers only Link when the typed name is already listed under another EPA number', async () => {
    getTypedBrandsForReview.mockResolvedValue([{ ...row, review_note: 'number_differs_from_list' }]);
    render(<MemoryRouter><TypedBrandReview /></MemoryRouter>);
    expect(await screen.findByText('Link to existing')).toBeTruthy();
    expect(screen.queryByText('Add to list')).toBeNull();
  });
});
