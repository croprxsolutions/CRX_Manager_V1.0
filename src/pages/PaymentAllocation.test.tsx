/**
 * PaymentAllocation.test.tsx — Tests for the unified payment entry page
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
// One router package for the page and the test, as useUnsavedChanges' useBlocker comes from
// 'react-router' (the same setup as QuoteBuilder.saveNavigation.test.tsx).
import { createMemoryRouter, RouterProvider } from 'react-router';
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

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
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn(), getKeyFor: () => 'test-idem-key', resetKeyFor: vi.fn() }),
}));

// parseCents is deliberately NOT mocked: the real parser refuses more than two
// decimals (null) and a rounding stand-in would let this page's refusal branches
// pass whether or not they work (2026-09-03).

import PaymentAllocation, { autoAllocate } from './PaymentAllocation';

// A data router, as in the app, so the unsaved-changes guard (useBlocker) runs for real.
function renderPayments() {
  const router = createMemoryRouter(
    [
      { path: '/payments', element: <PaymentAllocation /> },
      { path: '/elsewhere', element: <p>Somewhere else</p> },
    ],
    { initialEntries: ['/payments'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
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
    fireEvent.click(await screen.findByRole('option', { name: /Acme Farm/ }));

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
    fireEvent.click(await screen.findByRole('option', { name: /Big Farm/ }));
    fireEvent.change(await screen.findByPlaceholderText('0.00'), { target: { value: '500.00' } });
    fireEvent.change(screen.getByLabelText('Check #'), { target: { value: reference } });
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
    // A check's number is saved as its check number; the duplicate check matched it against reference 1234.
    expect(rpcCalls()[0][1]).toMatchObject({ p_customer_id: 'cust-1', p_total_cents: 50000, p_check_number: '#1234', p_payment_method: 'check' });
    expect(rpcCalls()[0][1].p_reference_number).toBeUndefined();
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
      expect(screen.getByLabelText('Check #')).toBeDisabled();
      expect(screen.getByPlaceholderText('Search by name or account #...')).toBeDisabled();
      // The shared customer box hides its clear button while it is locked.
      expect(screen.queryByRole('button', { name: 'Clear customer' })).not.toBeInTheDocument();

      await act(async () => { finishCheck({ data: [existing], error: null }); await held; });
      expect(await screen.findByText(/already has a \$500\.00 payment/)).toBeInTheDocument();
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '12.345' } });
      fireEvent.click(screen.getByRole('button', { name: /Record Anyway/ }));
      await waitFor(() => expect(rpcCalls()).toHaveLength(1));
      expect(rpcCalls()[0][1]).toMatchObject({ p_total_cents: 50000, p_check_number: '1234' });
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

describe('Record Payments: faster entry', () => {
  const customer = { id: 'cust-1', farm_name: 'Big Farm', account_number: 'A-9', city: null, state: null, is_active: true, prepay_balance_cents: 2500 };
  const invoice = (id: string, number: string, date: string, balanceCents: number) => ({
    id, invoice_number: number, invoice_date: date, due_date: null, invoice_type: 'chemical_sale',
    total_amount_cents: balanceCents, balance_cents: balanceCents,
  });
  const openInvoices = [invoice('i1', 'INV-OLD', '2026-08-01', 5000), invoice('i2', 'INV-NEW', '2026-09-01', 3000)];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => buildChain(
      table === 'customers' ? { data: [customer], error: null }
        : table === 'invoices' ? { data: openInvoices, error: null, count: openInvoices.length } as { data: unknown; error: unknown }
          : { data: [], error: null },
    ));
  });

  // Chooses Big Farm from the keyboard only: type, arrow down, Enter.
  async function chooseByKeyboard() {
    const box = screen.getByRole('combobox', { name: 'Customer' });
    box.focus();
    fireEvent.change(box, { target: { value: 'Big' } });
    await screen.findByRole('option', { name: /Big Farm/ });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('INV-OLD');
  }

  it('a customer chosen with the keyboard moves the cursor to the check amount', async () => {
    renderPayments();
    await chooseByKeyboard();
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('Big Farm');
    await waitFor(() => expect(screen.getByLabelText('Check Amount')).toHaveFocus());
  });

  it('puts the check amount before Notes, in the page and in tab order', async () => {
    renderPayments();
    const amount = screen.getByLabelText('Check Amount');
    const notes = screen.getByLabelText('Notes');
    expect(amount.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(amount).not.toHaveAttribute('tabindex');
    expect(notes).not.toHaveAttribute('tabindex');
  });

  it('Pay full balance fills every open invoice with its balance and an empty check amount with the total, saving nothing', async () => {
    renderPayments();
    await chooseByKeyboard();
    fireEvent.click(screen.getByRole('button', { name: /Pay full balance/ }));

    expect(screen.getByLabelText('Check Amount')).toHaveValue('80.00');
    expect(screen.getAllByPlaceholderText('0.00').slice(1).map((el) => (el as HTMLInputElement).value)).toEqual(['50.00', '30.00']);
    expect(screen.getByText('Allocated:').parentElement!).toHaveTextContent('$80.00');
    expect(screen.getByText('Remaining:').parentElement!).toHaveTextContent('$0.00');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('Pay full balance keeps a larger typed check and leaves the rest to prepay, as before', async () => {
    renderPayments();
    await chooseByKeyboard();
    fireEvent.change(screen.getByLabelText('Check Amount'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Pay full balance/ }));

    expect(screen.getByLabelText('Check Amount')).toHaveValue('100.00');
    expect(screen.getByText('Allocated:').parentElement!).toHaveTextContent('$80.00');
    expect(screen.getByText('$20.00 will become a prepay credit')).toBeInTheDocument();
  });

  it('Pay full balance refuses a typed check smaller than the balance and changes nothing', async () => {
    renderPayments();
    await chooseByKeyboard();
    fireEvent.change(screen.getByLabelText('Check Amount'), { target: { value: '60.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Pay full balance/ }));

    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('$20.00 short of the full balance of $80.00'));
    expect(screen.getByLabelText('Check Amount')).toHaveValue('60.00');
    expect(screen.getByText('Allocated:').parentElement!).toHaveTextContent('$0.00');
  });

  it('keeps the totals bar pinned on screen while the invoice list scrolls', async () => {
    renderPayments();
    await chooseByKeyboard();
    fireEvent.change(screen.getByLabelText('Check Amount'), { target: { value: '80.00' } });
    const totals = screen.getByRole('region', { name: 'Payment totals' });
    expect(totals).toHaveClass('sticky', 'md:bottom-0');
    expect(totals).toHaveTextContent('Check Total: $80.00');
  });

  it('shows the prepay balance with a link to where prepay is applied', async () => {
    renderPayments();
    await chooseByKeyboard();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apply prepay to invoices' })).toHaveAttribute('href', '/prepay?tab=workspace&customer=cust-1');
  });

  it('asks before leaving with a typed amount, and Keep editing stays', async () => {
    const { router } = renderPayments();
    await chooseByKeyboard();
    fireEvent.change(screen.getByLabelText('Check Amount'), { target: { value: '80.00' } });

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await act(async () => { await router.navigate('/elsewhere'); });
    expect(await screen.findByText('Leave without saving?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByText('Leave without saving?')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Check Amount')).toHaveValue('80.00');
    expect(screen.queryByText('Somewhere else')).not.toBeInTheDocument();
  });

  it('leaves without asking when nothing is typed', async () => {
    const { router } = renderPayments();
    await chooseByKeyboard();
    await act(async () => { await router.navigate('/elsewhere'); });
    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
    expect(screen.queryByText('Leave without saving?')).not.toBeInTheDocument();
  });
});

describe('Record Payments: payment date and check number', () => {
  const customer = { id: 'cust-1', farm_name: 'Big Farm', account_number: null, prepay_balance_cents: 0 };
  const openInvoice = {
    id: 'i1', invoice_number: 'INV-1', invoice_date: '2026-09-01', due_date: null, invoice_type: 'chemical_sale',
    total_amount_cents: 50000, balance_cents: 50000,
  };
  const rpcCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'allocate_payment');
  const saved = { data: { total_allocated_cents: 50000, prepay_created_cents: 0, invoices_paid: 1 }, error: null };
  let closedPeriods: unknown[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    // 9:30 PM on Nov 24 in Chicago is already Nov 25 in UTC: the payment is still dated the 24th.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T03:30:00Z'));
    closedPeriods = [];
    mockFrom.mockImplementation((table: string) => buildChain(
      table === 'customers' ? { data: [customer], error: null }
        : table === 'invoices' ? { data: [openInvoice], error: null, count: 1 } as { data: unknown; error: unknown }
          : table === 'accounting_periods' ? { data: closedPeriods, error: null }
            : { data: [], error: null },
    ));
    mockRpc.mockImplementation(() => Promise.resolve(saved));
  });
  afterEach(() => { vi.useRealTimers(); });

  const dateField = () => screen.getByRole('group', { name: 'Payment date' });
  const segment = (type: 'month' | 'day' | 'year') =>
    within(dateField()).getAllByRole('spinbutton').find((el) => el.getAttribute('data-type') === type)!;
  const shownDate = () => ['month', 'day', 'year'].map((t) => segment(t as 'month').textContent).join('/');
  // Steps one part of the date with the arrow keys, as a person does in the field.
  const stepDate = (type: 'month' | 'day', key: 'ArrowUp' | 'ArrowDown', times = 1) => {
    for (let i = 0; i < times; i += 1) fireEvent.keyDown(segment(type), { key });
  };

  async function fillPayment(number = '1234') {
    const view = renderPayments();
    fireEvent.change(screen.getByPlaceholderText('Search by name or account #...'), { target: { value: 'Big' } });
    fireEvent.click(await screen.findByRole('option', { name: /Big Farm/ }));
    await screen.findByText('INV-1');
    fireEvent.change(screen.getByLabelText('Check Amount'), { target: { value: '500.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Auto-Allocate/ }));
    if (number) fireEvent.change(screen.getByLabelText('Check #'), { target: { value: number } });
    return view;
  }
  const apply = () => fireEvent.click(screen.getByRole('button', { name: /Apply Payment/ }));

  it("defaults to today's date in Chicago and sends it with the check number", async () => {
    await fillPayment('1234');
    expect(shownDate()).toBe('11/24/2026');
    apply();
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    expect(rpcCalls()[0][1]).toMatchObject({ p_payment_date: '2026-11-24', p_check_number: '1234', p_payment_method: 'check' });
    expect(rpcCalls()[0][1].p_reference_number).toBeUndefined();
  });

  it('sends the date picked, so a check from an earlier day lands on that day', async () => {
    await fillPayment();
    stepDate('day', 'ArrowDown', 3);
    expect(shownDate()).toBe('11/21/2026');
    apply();
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    expect(rpcCalls()[0][1]).toMatchObject({ p_payment_date: '2026-11-21' });
  });

  it('another method sends a reference number, not a check number', async () => {
    await fillPayment('');
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'ach' } });
    fireEvent.change(screen.getByLabelText('Reference #'), { target: { value: 'ACH-77' } });
    expect(screen.queryByLabelText('Check #')).not.toBeInTheDocument();
    apply();
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    expect(rpcCalls()[0][1]).toMatchObject({ p_payment_method: 'ach', p_reference_number: 'ACH-77' });
    expect(rpcCalls()[0][1].p_check_number).toBeUndefined();
  });

  it('a date after today is blocked with a message and nothing is saved', async () => {
    await fillPayment();
    stepDate('day', 'ArrowUp');
    expect(shownDate()).toBe('11/25/2026');
    expect(screen.getByText('A payment cannot be dated after today (11/24/2026)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply Payment/ })).toBeDisabled();
    apply();
    expect(rpcCalls()).toHaveLength(0);
  });

  it('asks before saving a date more than 31 days back', async () => {
    await fillPayment();
    stepDate('month', 'ArrowDown', 2);
    expect(shownDate()).toBe('9/24/2026');
    apply();
    expect(await screen.findByText('Record a payment dated 61 days ago?')).toBeInTheDocument();
    expect(screen.getByText(/dated 9\/24\/2026, 61 days ago/)).toBeInTheDocument();
    expect(rpcCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    expect(rpcCalls()[0][1]).toMatchObject({ p_payment_date: '2026-09-24' });
  });

  it('a date 31 days back saves without asking', async () => {
    await fillPayment();
    stepDate('month', 'ArrowDown');
    apply();
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    expect(rpcCalls()[0][1]).toMatchObject({ p_payment_date: '2026-10-24' });
  });

  it('a date in a closed month says so plainly and saves nothing', async () => {
    closedPeriods = [{ period_start: '2026-10-01', period_end: '2026-10-31' }];
    await fillPayment();
    stepDate('month', 'ArrowDown');
    apply();
    const message = '10/24/2026 is in a closed month (10/1/2026 to 10/31/2026). Nothing was saved. '
      + 'Date the payment in an open month, or ask an admin to reopen that month in Month-End Close.';
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('error', message);
    expect(rpcCalls()).toHaveLength(0);
    // A new date clears it.
    stepDate('month', 'ArrowUp');
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("the database's closed-month refusal is put in plain words (a rep cannot read closed months first)", async () => {
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'Date 2026-10-24 falls in closed accounting period (2026-10-01 to 2026-10-31)' } }));
    await fillPayment();
    stepDate('month', 'ArrowDown');
    apply();
    expect(await screen.findByText(/10\/24\/2026 is in a closed month \(10\/1\/2026 to 10\/31\/2026\)\. Nothing was saved\./)).toBeInTheDocument();
  });

  it('a retry with a changed date is not taken as the same payment', async () => {
    // The server's retry check: one key, one set of arguments (allocate_payment's request fingerprint).
    const firstArgs = new Map<string, unknown>();
    let replyLost = true;
    mockRpc.mockImplementation((_name: string, args: Record<string, unknown>) => {
      const { p_idempotency_key: key, ...request } = args;
      const known = firstArgs.get(String(key));
      if (known && JSON.stringify(known) !== JSON.stringify(request)) {
        return Promise.resolve({ data: null, error: { message: 'IDEMPOTENCY_ARGUMENT_MISMATCH: key was already used for different allocate_payment arguments' } });
      }
      firstArgs.set(String(key), request);
      if (replyLost) { replyLost = false; return Promise.reject(new Error('Failed to fetch')); }
      return Promise.resolve(saved);
    });
    await fillPayment();
    apply();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to fetch'));

    stepDate('day', 'ArrowDown');
    apply();
    await waitFor(() => expect(rpcCalls()).toHaveLength(2));
    const [first, second] = rpcCalls().map(([, args]) => args);
    expect(second.p_idempotency_key).toBe(first.p_idempotency_key);
    expect([first.p_payment_date, second.p_payment_date]).toEqual(['2026-11-24', '2026-11-23']);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check Payment History, or ask an admin to');
    expect(screen.queryByText('Payment Applied Successfully')).not.toBeInTheDocument();
  });

  it('a retry after a lost reply still reaches the save when the month has since been closed', async () => {
    let replyLost = true;
    mockRpc.mockImplementation(() => {
      if (replyLost) { replyLost = false; return Promise.reject(new Error('Failed to fetch')); }
      return Promise.resolve(saved);
    });
    await fillPayment();
    apply();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to fetch'));

    closedPeriods = [{ period_start: '2026-11-01', period_end: '2026-11-30' }];
    apply();
    await waitFor(() => expect(rpcCalls()).toHaveLength(2));
    const [first, second] = rpcCalls().map(([, args]) => args);
    expect(second.p_idempotency_key).toBe(first.p_idempotency_key);
    expect(screen.queryByText(/is in a closed month/)).not.toBeInTheDocument();
  });

  it('asks before leaving when only the payment date was changed', async () => {
    const { router } = renderPayments();
    stepDate('day', 'ArrowDown');
    await act(async () => { await router.navigate('/elsewhere'); });
    expect(await screen.findByText('Leave without saving?')).toBeInTheDocument();
  });

  it('keeps the picked date for the next check, without counting it as unsaved', async () => {
    const { router } = await fillPayment();
    stepDate('day', 'ArrowDown', 3);
    apply();
    fireEvent.click(await screen.findByRole('button', { name: /Next Check/ }));
    expect(shownDate()).toBe('11/21/2026');
    await act(async () => { await router.navigate('/elsewhere'); });
    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
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
