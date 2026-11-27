import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';
import DeliveryRemainders from './DeliveryRemainders';

const toast = vi.fn();
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'office-user' } }) }));
vi.mock('../lib/db', () => ({
  supabase: { from: () => buildInMemoryQuery([{
    id: 'remainder-1',
    original_delivery_id: 'delivery-1',
    order_id: 'order-1',
    customer_id: 'customer-1',
    product_id: 'product-1',
    quantity_remaining: 2,
    unit_size: 'Gal',
    status: 'pending',
    followup_delivery_id: null,
    created_at: '2026-11-26T16:00:00.000Z',
    customer: { farm_name: 'Test Farm' },
    product: { product_name: 'Test Product' },
    original_delivery: { delivery_number: 'DEL-801' },
    order: { order_number: 'ORD-129' },
  }]) },
  sanitizeError: (error: unknown) => String(error),
  assertRpcResult: (data: unknown) => data,
}));

describe('Delivery Remainders list', () => {
  it('waits for the read before showing summary counts', async () => {
    render(<MemoryRouter><DeliveryRemainders /></MemoryRouter>);
    expect(screen.queryByText('Pending Items')).not.toBeInTheDocument();
    expect(await screen.findByText('Pending Items')).toBeInTheDocument();
  });

  it('finds an item by order number and explains when a status filter excludes it', async () => {
    render(<MemoryRouter><DeliveryRemainders /></MemoryRouter>);
    expect(await screen.findByText('ORD-129')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search remainders...'), { target: { value: 'ORD-129' } });
    expect(screen.getByText('Test Product')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'scheduled' } });
    expect(screen.getByText('No remainders match these filters')).toBeInTheDocument();
    expect(screen.queryByText('Test Product')).not.toBeInTheDocument();
  });
});
