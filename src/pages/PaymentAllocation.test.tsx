/**
 * PaymentAllocation.test.tsx — Tests for the unified payment entry page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  hasRpcCode: (e: unknown, code: string) => String((e as { message?: unknown } | null)?.message ?? '').startsWith(code),
  rpcAuthErrorMessage: (e: unknown) => (String((e as { message?: unknown } | null)?.message ?? '').startsWith('ACTOR_MISMATCH') ? 'Your sign-in could not be verified.' : null),
  RpcErrorCodes: new Proxy({}, { get: (_target, name) => name }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

// parseCents is deliberately NOT mocked: the real parser refuses more than two
// decimals (null) and a rounding stand-in would let this page's refusal branches
// pass whether or not they work (2026-09-03).

import PaymentAllocation, { autoAllocate } from './PaymentAllocation';

function renderPayments() {
  return render(
    <MemoryRouter initialEntries={['/payments']}>
      <Routes>
        <Route path="/payments" element={<PaymentAllocation />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PaymentAllocation page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
  });

  it('renders the Payments heading', async () => {
    renderPayments();
    await waitFor(() => {
      expect(screen.getByText('Payments')).toBeInTheDocument();
    });
  });

  it('renders customer search input', async () => {
    renderPayments();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search by name/i)).toBeInTheDocument();
    });
  });

  it('shows payment method selector', async () => {
    renderPayments();
    await waitFor(() => {
      expect(screen.getByText('Method')).toBeInTheDocument();
    });
  });

  it('names a refused check amount right under the field while the actions stay disabled', async () => {
    mockFrom.mockImplementation((table: string) => (table === 'customers'
      ? buildChain({ data: [{ id: 'cust-1', farm_name: 'Acme Farm', account_number: 'A-1', prepay_balance_cents: 0 }], error: null })
      : buildChain({ data: [], error: null })));
    renderPayments();
    fireEvent.change(await screen.findByPlaceholderText(/search by name/i), { target: { value: 'Ac' } });
    fireEvent.click(await screen.findByRole('button', { name: /Acme Farm/ }));

    const amount = await screen.findByPlaceholderText('0.00');
    fireEvent.change(amount, { target: { value: '12.345' } });
    // Before the fix the refusal was invisible: null became 0, both action buttons were
    // disabled, and the handler toasts could never fire (CodeRabbit on PR #588).
    expect(screen.getByText('Enter an amount with no more than two decimal places.')).toBeInTheDocument();
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /Auto-Allocate/ })).toBeDisabled();
    expect(mockToast).not.toHaveBeenCalled();

    fireEvent.change(amount, { target: { value: '12.34' } });
    expect(screen.queryByText('Enter an amount with no more than two decimal places.')).not.toBeInTheDocument();
    expect(amount).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('PaymentAllocation duplicate and retry warnings', () => {
  const customer = { id: 'cust-1', farm_name: 'Big Farm', account_number: null, prepay_balance_cents: 0 };
  const existing = { id: 'p1', reference_number: '1234', check_number: null, payment_date: '2026-10-05' };
  const rpcCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'allocate_payment');

  function tables(allocationSets: { data: unknown; error: unknown }) {
    mockFrom.mockImplementation((table: string) => buildChain(
      table === 'allocation_sets' ? allocationSets
        : table === 'customers' ? { data: [customer], error: null }
          : { data: [], error: null, count: 0 } as { data: unknown; error: unknown },
    ));
  }

  async function fillPayment(reference: string) {
    renderPayments();
    fireEvent.change(screen.getByPlaceholderText('Search by name or account #...'), { target: { value: 'Big' } });
    fireEvent.click(await screen.findByRole('button', { name: /Big Farm/ }));
    fireEvent.change(await screen.findByPlaceholderText('0.00'), { target: { value: '500.00' } });
    fireEvent.change(screen.getByPlaceholderText('Check # or ref...'), { target: { value: reference } });
    await screen.findByText('No open invoices for this customer');
    fireEvent.click(await screen.findByRole('button', { name: /Apply Payment/ }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockImplementation(() => Promise.resolve({ data: { total_allocated_cents: 0, prepay_created_cents: 50000, invoices_paid: 0 }, error: null }));
  });

  it('saves nothing on a matching payment until the user chooses Record Anyway', async () => {
    tables({ data: [existing], error: null });
    await fillPayment('#1234');

    expect(await screen.findByText('Possible Duplicate Payment')).toBeInTheDocument();
    expect(screen.getByText(/already has a \$500\.00 payment with reference 1234/)).toBeInTheDocument();
    expect(rpcCalls()).toHaveLength(0);

    // One warning also says where the money goes, so a double tap cannot land on a second modal.
    expect(screen.getByText(/\$500\.00 will be added as prepay credit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Record Anyway/ }));
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    expect(screen.queryByText('Full Prepay Credit')).not.toBeInTheDocument();
    expect(rpcCalls()[0][1]).toMatchObject({ p_customer_id: 'cust-1', p_total_cents: 50000, p_reference_number: '#1234', p_payment_method: 'check' });
  });

  describe('while the duplicate check is running', () => {
    let finishCheck: (result: { data: unknown; error: unknown }) => void;
    let held: Promise<{ data: unknown; error: unknown }>;

    beforeEach(() => {
      held = new Promise((resolve) => { finishCheck = resolve; });
      mockFrom.mockImplementation((table: string) => {
        const chain = buildChain(table === 'customers' ? { data: [customer], error: null } : { data: [], error: null });
        if (table === 'allocation_sets') chain.then = held.then.bind(held);
        return chain;
      });
    });

    it('locks the form, so the warning and the save use what was checked', async () => {
      await fillPayment('1234');
      await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeDisabled());
      expect(screen.getByPlaceholderText('Check # or ref...')).toBeDisabled();
      expect(screen.getByPlaceholderText('Search by name or account #...')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Clear customer' })).toBeDisabled();

      await act(async () => { finishCheck({ data: [existing], error: null }); await held; });
      expect(await screen.findByText(/already has a \$500\.00 payment/)).toBeInTheDocument();
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '12.345' } });
      fireEvent.click(screen.getByRole('button', { name: /Record Anyway/ }));
      await waitFor(() => expect(rpcCalls()).toHaveLength(1));
      expect(rpcCalls()[0][1]).toMatchObject({ p_total_cents: 50000, p_reference_number: '1234' });
    });

    it('leaving the page drops the save', async () => {
      await fillPayment('1234');
      await waitFor(() => expect(screen.getByPlaceholderText('0.00')).toBeDisabled());
      cleanup();
      await act(async () => { finishCheck({ data: [], error: null }); await held; });
      expect(rpcCalls()).toHaveLength(0);
      expect(screen.queryByText('Full Prepay Credit')).not.toBeInTheDocument();
    });
  });

  it('Cancel leaves the payment unsaved', async () => {
    tables({ data: [existing], error: null });
    await fillPayment('1234');
    await screen.findByText('Possible Duplicate Payment');
    fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
    await waitFor(() => expect(screen.queryByText('Possible Duplicate Payment')).not.toBeInTheDocument());
    expect(screen.queryByText('Full Prepay Credit')).not.toBeInTheDocument();
    expect(rpcCalls()).toHaveLength(0);
  });

  it('no match goes straight to the usual flow', async () => {
    tables({ data: [{ ...existing, reference_number: '999' }], error: null });
    await fillPayment('1234');
    fireEvent.click(await screen.findByRole('button', { name: /^Continue/ }));
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    expect(screen.queryByText('Possible Duplicate Payment')).not.toBeInTheDocument();
  });

  it('a failed duplicate check saves nothing', async () => {
    tables({ data: null, error: { message: 'read failed' } });
    await fillPayment('1234');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('This attempt was not saved')));
    expect(screen.queryByText('Full Prepay Credit')).not.toBeInTheDocument();
    expect(rpcCalls()).toHaveLength(0);
  });

  it('a refused edited retry stays on screen and points the user at Payment History', async () => {
    tables({ data: [], error: null });
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'IDEMPOTENCY_ARGUMENT_MISMATCH: key k was already used for different allocate_payment arguments' } }));
    await fillPayment('1234');
    fireEvent.click(await screen.findByRole('button', { name: /^Continue/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check Payment History, or ask an admin to');
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('a forged-actor refusal shows the friendly sign-in message, not the raw token', async () => {
    tables({ data: [], error: null });
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'ACTOR_MISMATCH: p_performed_by does not match authenticated user' } }));
    await fillPayment('1234');
    fireEvent.click(await screen.findByRole('button', { name: /^Continue/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Your sign-in could not be verified.'));
  });
});

describe('autoAllocate', () => {
  it('allocates full amount to single invoice', () => {
    const result = autoAllocate(10000, [{ id: 'inv-1', balance_cents: 10000 }]);
    expect(result.get('inv-1')).toBe(10000);
  });

  it('allocates across multiple invoices oldest first', () => {
    const invoices = [
      { id: 'inv-1', balance_cents: 5000 },
      { id: 'inv-2', balance_cents: 3000 },
      { id: 'inv-3', balance_cents: 4000 },
    ];
    const result = autoAllocate(7000, invoices);
    expect(result.get('inv-1')).toBe(5000);
    expect(result.get('inv-2')).toBe(2000);
    expect(result.has('inv-3')).toBe(false);
  });

  it('returns empty map for zero amount', () => {
    const result = autoAllocate(0, [{ id: 'inv-1', balance_cents: 5000 }]);
    expect(result.size).toBe(0);
  });

  it('returns empty map for negative amount', () => {
    const result = autoAllocate(-100, [{ id: 'inv-1', balance_cents: 5000 }]);
    expect(result.size).toBe(0);
  });

  it('skips invoices with zero balance', () => {
    const invoices = [
      { id: 'inv-1', balance_cents: 0 },
      { id: 'inv-2', balance_cents: 3000 },
    ];
    const result = autoAllocate(5000, invoices);
    expect(result.has('inv-1')).toBe(false);
    expect(result.get('inv-2')).toBe(3000);
  });

  it('handles NaN/Infinity gracefully', () => {
    expect(autoAllocate(NaN, [{ id: 'inv-1', balance_cents: 5000 }]).size).toBe(0);
    expect(autoAllocate(Infinity, [{ id: 'inv-1', balance_cents: 5000 }]).size).toBe(0);
  });
});
