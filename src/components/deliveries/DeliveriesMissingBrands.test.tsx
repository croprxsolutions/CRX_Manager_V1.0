import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DeliveriesMissingBrands from './DeliveriesMissingBrands';

const getDeliveriesMissingBrands = vi.fn();
vi.mock('../../lib/deliveryBrands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/deliveryBrands')>()),
  getDeliveriesMissingBrands: (from: string, to: string) => getDeliveriesMissingBrands(from, to),
}));

describe('DeliveriesMissingBrands', () => {
  it('lists an unconfirmed completion with plain reasons and a link to its delivery', async () => {
    getDeliveriesMissingBrands.mockResolvedValue([{
      delivery_id: 'D1', delivery_number: 'DEL-7', delivered_on: '2026-11-12', delivery_item_id: 'L1',
      product_name: 'Glyphosate', quantity_delivered: 10, picked_quantity: 6, reasons: ['picks_not_confirmed', 'split_does_not_match_delivered'],
    }]);
    render(<MemoryRouter><DeliveriesMissingBrands /></MemoryRouter>);
    expect(await screen.findByText('DEL-7')).toHaveAttribute('href', '/deliveries/D1');
    expect(screen.getByText('Brands not confirmed at completion; Split does not match delivered')).toBeInTheDocument();
    expect(screen.getByText(/Glyphosate \(6 of 10 recorded\)/)).toBeInTheDocument();
    const [from, to] = getDeliveriesMissingBrands.mock.calls[0];
    expect(from < to).toBe(true);
  });

  it('shows nothing when no delivery is waiting, and a retry when the list fails', async () => {
    getDeliveriesMissingBrands.mockResolvedValueOnce([]);
    const { container, unmount } = render(<MemoryRouter><DeliveriesMissingBrands /></MemoryRouter>);
    await vi.waitFor(() => expect(getDeliveriesMissingBrands).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    getDeliveriesMissingBrands.mockRejectedValueOnce(new Error('down'));
    render(<MemoryRouter><DeliveriesMissingBrands /></MemoryRouter>);
    expect(await screen.findByText('Deliveries missing brands could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });
});
