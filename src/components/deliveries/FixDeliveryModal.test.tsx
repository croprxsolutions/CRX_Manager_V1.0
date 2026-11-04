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
  can_fix: true, refusals: [], other_draft_invoices: [], plan_token: 'tok1',
  invoices: [{ id: 'i2', invoice_number: 'INV-2', status: 'posted', total_cents: 12345, paid_cents: 0, prepay_applied_cents: 0, write_off_cents: 0, credit_applied_cents: 0, action: 'void' }],
  items: [{ id: 'di1', order_item_id: 'oi1', product_id: 'p1', product_name: 'Roundup', quantity: 10, unit: 'gal' }],
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
      p_delivery_id: 'd1', p_reason: 'Entered 100, delivered 10', p_plan_token: 'tok1', p_idempotency_key: expect.any(String),
    }));
  });

  it('says an applied credit goes back to its credit memo', async () => {
    const invoice = { ...plan().invoices[0], credit_applied_cents: 4000 };
    H.rpc.mockResolvedValue({ data: plan({ invoices: [invoice] }), error: null });
    renderModal();
    await screen.findByText(/\$40\.00 of applied credit goes back to its credit memo/);
  });

  it('shows why a delivery cannot be fixed and offers no way to submit', async () => {
    H.rpc.mockResolvedValue({ data: plan({ can_fix: false, refusals: [{ code: 'PAYMENT_APPLIED', message: 'A payment is applied to this invoice.' }] }), error: null });
    renderModal();
    await screen.findByText('A payment is applied to this invoice.');
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: /Fix Delivery/ })).toBeDisabled());
  });
  it('makes a plan reloaded after a stale refusal be confirmed again', async () => {
    let previews = 0;
    H.rpc.mockImplementation(async (name: string) => {
      if (name === 'preview_fix_delivery') {
        previews += 1;
        return { data: previews === 1 ? plan() : plan({ plan_token: 'tok2', other_draft_invoices: [{ id: 'i9', invoice_number: 'INV-9', total_cents: 0 }] }), error: null };
      }
      return { data: null, error: { message: 'FIX_DELIVERY_PREVIEW_STALE: changed' } };
    });
    renderModal();
    await screen.findByText(/Invoice INV-2/);
    fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: 'Entered 100, delivered 10' } });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'FIX DEL-7' } });
    fireEvent.click(screen.getByRole('button', { name: /Fix Delivery/ }));
    await screen.findByText(/Draft invoice INV-9/);
    expect(screen.getByLabelText(/to confirm/)).toHaveValue('');
    expect(screen.getByRole('button', { name: /Fix Delivery/ })).toBeDisabled();
  });
  it('keeps the retry key after a lost reply and retires it only when the server says it is another request', async () => {
    let fixCalls = 0;
    H.rpc.mockImplementation(async (name: string) => {
      if (name === 'preview_fix_delivery') return { data: plan(), error: null };
      fixCalls += 1;
      return { data: null, error: { message: fixCalls === 2 ? 'IDEMPOTENCY_INTENT_MISMATCH' : 'Failed to fetch' } };
    });
    renderModal();
    await screen.findByText(/Invoice INV-2/);
    const submit = async () => {
      fireEvent.change(await screen.findByLabelText(/What was wrong/), { target: { value: 'Entered 100, delivered 10' } });
      fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'FIX DEL-7' } });
      fireEvent.click(screen.getByRole('button', { name: /Fix Delivery/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /Fix Delivery/ })).toBeDisabled());
      await screen.findByText(/Invoice INV-2/);
    };
    const keys = () => H.rpc.mock.calls.filter(([n]) => n === 'fix_delivery').map(([, a]) => (a as { p_idempotency_key: string }).p_idempotency_key);
    await submit();
    await submit();
    await submit();
    expect(keys()).toHaveLength(3);
    const [first, second, third] = keys();
    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });

  // A lost reply, then a reload that shows the delivery is no longer completed.
  async function lostReplyThenUndone(replay: { data: unknown; error: unknown }) {
    let previews = 0;
    let fixes = 0;
    H.rpc.mockImplementation(async (name: string) => {
      if (name === 'preview_fix_delivery') {
        previews += 1;
        return { data: previews === 1 ? plan() : plan({ can_fix: false, refusals: [{ code: 'NOT_COMPLETED', message: 'Only a completed delivery can be fixed.' }] }), error: null };
      }
      fixes += 1;
      return fixes === 1 ? { data: null, error: { message: 'Failed to fetch' } } : replay;
    });
    renderModal();
    fireEvent.change(await screen.findByLabelText(/What was wrong/), { target: { value: 'Entered 100, delivered 10' } });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'FIX DEL-7' } });
    fireEvent.click(screen.getByRole('button', { name: /Fix Delivery/ }));
    await screen.findByText('Only a completed delivery can be fixed.');
    await waitFor(() => expect(H.rpc.mock.calls.filter(([n]) => n === 'fix_delivery')).toHaveLength(2));
    const [first, second] = H.rpc.mock.calls.filter(([n]) => n === 'fix_delivery').map(([, a]) => a);
    expect(second).toEqual(first);
  }

  it('offers the re-entry link only when replaying the kept key returns the fix receipt', async () => {
    await lostReplyThenUndone({ data: { success: true, delivery_id: 'd1', delivery_number: 'DEL-7', order_id: 'o1', customer_id: 'c1', invoices: [], commissions_restored: 1 }, error: null });
    expect(await screen.findByText(/This delivery was already undone/)).toBeInTheDocument();
  });

  it('shows no success when the delivery was undone some other way', async () => {
    await lostReplyThenUndone({ data: null, error: { message: 'FIX_DELIVERY_REFUSED: NOT_COMPLETED' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/This delivery was already undone/)).not.toBeInTheDocument();
  });
});
