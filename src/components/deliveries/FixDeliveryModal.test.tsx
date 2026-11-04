import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const H = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }));
vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabaseUntyped: { rpc: H.rpc } };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1' }, role: 'admin' }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import FixDeliveryModal from './FixDeliveryModal';

const plan = (over = {}) => ({
  delivery_id: 'd1', delivery_number: 'DEL-7', order_id: 'o1', order_number: 'ORD-1', customer_id: 'c1',
  can_fix: true, refusals: [], other_draft_invoices: [],
  invoices: [{ id: 'i2', invoice_number: 'INV-2', status: 'posted', total_cents: 12345, paid_cents: 0, prepay_applied_cents: 0, action: 'void' }],
  items: [{ product_name: 'Roundup', quantity: 10, unit: 'gal' }],
  ...over,
});

function renderModal() {
  render(
    <MemoryRouter initialEntries={['/deliveries/d1']}>
      <Routes>
        <Route path="/deliveries/d1" element={<FixDeliveryModal open onClose={vi.fn()} deliveryId="d1" deliveryNumber="DEL-7" />} />
        <Route path="/deliveries/new" element={<p>New delivery page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('FixDeliveryModal', () => {
  it('shows the plan, needs a reason and the typed confirmation, then re-opens the order as a new delivery', async () => {
    H.rpc.mockImplementation(async (name: string) => name === 'preview_fix_delivery'
      ? { data: plan(), error: null }
      : { data: { success: true, delivery_id: 'd1', delivery_number: 'DEL-7', order_id: 'o1', customer_id: 'c1', invoices: [], commissions_restored: 1 }, error: null });
    renderModal();
    await screen.findByText(/Invoice INV-2 \(\$123\.45\) will be voided/);
    const button = screen.getByRole('button', { name: /Fix Delivery/ });
    fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: 'Entered 100, delivered 10' } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'FIX DEL-7' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await screen.findByText('New delivery page');
    expect(H.rpc).toHaveBeenCalledWith('fix_delivery', expect.objectContaining({
      p_delivery_id: 'd1', p_reason: 'Entered 100, delivered 10', p_expected_invoice_ids: ['i2'], p_idempotency_key: expect.any(String),
    }));
  });

  it('shows why a delivery cannot be fixed and offers no way to submit', async () => {
    H.rpc.mockResolvedValue({ data: plan({ can_fix: false, refusals: [{ code: 'PAYMENT_APPLIED', message: 'A payment is applied to this invoice.' }] }), error: null });
    renderModal();
    await screen.findByText('A payment is applied to this invoice.');
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: /Fix Delivery/ })).toBeDisabled());
  });
});
