/**
 * PrepaymentManagerPanel.checkLock.test.tsx — M9 (20270301180000): a Prepayment Manager check's amount is locked
 * (shown read-only, sent unchanged so notes still save) and its delete removes the whole check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  toast: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => buildInMemoryQuery(H.tables[table] ?? []),
      rpc: H.rpc,
    },
  };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin', profile: { id: 'user-1', role: 'admin' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }) }));

import PrepaymentManagerPanel from './PrepaymentManagerPanel';

const credit = (id: string, ref: string, extra: Row = {}) => ({
  id, customer_id: 'c1', original_amount_cents: 30000, balance_cents: 30000, reference_number: ref,
  bucket_label: null, notes: null, payment_method: 'check', source_type: 'check', source_reference: ref, allocation_set_id: null,
  created_at: '2026-10-01', ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  H.tables = {
    customers: [{ id: 'c1', farm_name: 'Alpha Farm', is_active: true, prepay_balance_cents: 50000 }],
    invoices: [],
    prepay_credits: [credit('k1', 'CHK-1001')],
  };
});
afterEach(cleanup);

async function openCredits() {
  render(<MemoryRouter><PrepaymentManagerPanel /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /Alpha Farm/ }));
  await screen.findAllByText('CHK-1001');
}

describe('Prepay Manager: Prepayment Manager check amounts (M9)', () => {
  it('shows a check balance read-only with the hint, and saves a notes edit with the balance unchanged', async () => {
    H.rpc.mockResolvedValue({ data: { success: true }, error: null });
    await openCredits();
    fireEvent.click(screen.getByTitle('Edit credit'));

    expect(screen.getByTestId('locked-check-balance')).toHaveTextContent('$300.00');
    expect(screen.getByText('Check amounts are locked. To correct a mistyped check, delete the whole check and enter it again.')).toBeInTheDocument();
    expect(screen.queryByText(/Refund paid outside CRX/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Balance ($)')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'call before Friday' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('edit_prepay_credit', expect.objectContaining({
      p_credit_id: 'k1', p_new_balance_cents: 30000, p_notes: 'call before Friday',
    })));
  });

  it("keeps the balance editable for a payment's overpayment credit", async () => {
    H.tables.prepay_credits = [credit('k1', 'CHK-1001', { source_type: 'overpayment', allocation_set_id: 'set-1' })];
    await openCredits();
    fireEvent.click(screen.getByTitle('Edit credit'));
    expect(screen.getByLabelText('Balance ($)')).toBeInTheDocument();
    expect(screen.queryByTestId('locked-check-balance')).not.toBeInTheDocument();
  });

  it('deleting a check shows the whole check before it goes, and the toast names all its parts', async () => {
    H.tables.prepay_credits = [credit('k1', 'CHK-1001'), credit('k2', 'CHK-1001', { balance_cents: 20000, original_amount_cents: 20000 }),
      credit('k3', 'CHK-1001', { created_at: '2026-10-02', balance_cents: 40000, original_amount_cents: 40000 })];  // another check with the same number, entered later
    H.rpc.mockResolvedValue({ data: { success: true, credit_id: 'k1', credit_ids: ['k1', 'k2'], deleted_balance_cents: 50000 }, error: null });
    await openCredits();
    fireEvent.click(screen.getAllByTitle('Delete credit').find((b) => b.closest('tr')?.textContent?.includes('$300.00'))!);

    expect(screen.getByText(/This deletes the whole check: every part of it goes to \$0 together/)).toBeInTheDocument();
    expect(screen.getByTestId('whole-check-total')).toHaveTextContent('$500.00 (2 parts)');
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'entered wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /Delete Whole Check/ }));

    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('success', 'Deleted the whole check CHK-1001: all 2 parts ($500.00)'));
    expect(H.rpc).toHaveBeenCalledWith('delete_prepay_credit', expect.objectContaining({ p_credit_id: 'k1', p_reason: 'entered wrong' }));
  });
});
