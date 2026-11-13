/**
 * OrderDetail.test.tsx — Tests for the order detail page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const {
  mockFrom, mockRpc, mockToast, mockNavigate,
  mockLogActivity, mockNotifyOrderStatusChange, mockSanitizeError,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  mockLogActivity: vi.fn(),
  mockNotifyOrderStatusChange: vi.fn(),
  mockSanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
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

function buildPendingChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = new Promise(() => {});
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  // The version-bearing reads use the invoices_postable view (20261022090000): same rows as invoices here.
  supabase: { from: (table: string) => mockFrom(table === 'invoices_postable' ? 'invoices' : table), rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  describePostInvoiceBlock: vi.fn(() => null),
  sanitizeError: mockSanitizeError,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: mockLogActivity }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: mockNotifyOrderStatusChange }));
vi.mock('../lib/emailService', () => ({
  sendEmail: vi.fn(),
  buildEmailHtml: vi.fn(() => '<p>test</p>'),
}));
vi.mock('../lib/dateUtils', () => ({
  parseLocalDate: vi.fn((d: string) => new Date(d)),
}));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerSearchPicker', () => ({
  default: ({ onSelect, ariaLabel }: { onSelect: (c: { id: string; farm_name: string }) => void; ariaLabel: string }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => onSelect({ id: 'cust-2', farm_name: 'Cedar Ridge Ag' })}>pick</button>
  ),
}));

import OrderDetail from './OrderDetail';
import { checkMutationResult } from '../lib/db';

// A query whose answer depends on what was asked (an insert, a delete or a read), decided when it is awaited.
function answerChain(answer: (calls: string[]) => { data: unknown; error: unknown }): Record<string, unknown> {
  const calls: string[] = [];
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'maybeSingle', 'single']) {
    self[m] = () => { calls.push(m); return self; };
  }
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(() => answer(calls)).then(ok, bad);
  return self;
}

const shareOrder = {
  row_version: 1, id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
  order_date: '2026-03-15', total_price: 1333.2, notes: '', created_at: '2026-03-15T00:00:00Z',
};
const cedarShare = { id: 's1', order_id: 'ord-123', customer_id: 'cust-2', customer_name: 'Cedar Ridge Ag', split_percentage: 35, sort_order: 1 };

// The order with a saved card in `db.shares`: an insert adds Cedar Ridge Ag, a delete removes it.
function mockShareOrder(db: { shares: unknown[] }) {
  mockFrom.mockImplementation((table: string) => answerChain((calls) => {
    if (table === 'orders') return { data: shareOrder, error: null };
    if (table === 'customers' && calls.includes('maybeSingle')) return { data: { id: 'cust-1', farm_name: 'Maple Hollow Farms' }, error: null };
    if (table === 'order_shares') {
      if (calls.includes('insert')) { db.shares = [cedarShare]; return { data: [cedarShare], error: null }; }
      if (calls.includes('delete')) { db.shares = []; return { data: [cedarShare], error: null }; }
      return { data: db.shares, error: null };
    }
    return { data: [], error: null };
  }));
}

async function addCedarAt35() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add a payer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Bill split customer' }));
  fireEvent.change(screen.getByLabelText('Share'), { target: { value: '35' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add payer' }));
}

function renderOrderDetail(id = 'ord-123') {
  return render(
    <MemoryRouter initialEntries={[`/orders/${id}`]}>
      <Routes>
        <Route path="/orders/:id" element={<OrderDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrderDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it('shows loading skeleton while fetching', () => {
    mockFrom.mockImplementation(() => buildPendingChain());
    renderOrderDetail();
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows order not found for invalid ID', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: null, error: null }));
    renderOrderDetail('bad-id');
    await waitFor(() => {
      expect(screen.getByText('Order not found')).toBeInTheDocument();
    });
  });

  it('renders order detail when data loads', async () => {
    const orderData = {
      row_version: 1,
      id: 'ord-123',
      order_number: 'ORD-0099',
      status: 'confirmed',
      customer_id: 'cust-1',
      order_date: '2026-03-15',
      total_cents: 50000,
      total_cost: 30000,
      total_price: 50000,
      total_profit: 20000,
      total_margin_pct: 40.0,
      order_name: 'Spring Order',
      notes: '',
      created_at: '2026-03-15T00:00:00Z',
      delivery_priority: 'normal',
      po_number: null,
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        return buildChain({ data: orderData, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderOrderDetail();
    await waitFor(() => {
      const matches = screen.getAllByText('ORD-0099');
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('a posted return credit does not enable invoicing before delivery', async () => {
    const orderData = {
      row_version: 1,
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    const returnCredit = {
      id: 'credit-1', order_id: 'ord-123', invoice_number: 'CM-0001',
      invoice_type: 'credit_memo', status: 'posted', deleted_at: null,
      total_amount_cents: -15000, paid_amount_cents: 0, prepay_applied_cents: 0,
      balance_cents: -15000, write_off_cents: 0,
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: orderData, error: null });
      if (table === 'invoices') return buildChain({ data: [returnCredit], error: null });
      return buildChain({ data: [], error: null });
    });

    renderOrderDetail();

    expect((await screen.findAllByRole('link', { name: /CM-0001/ })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Create.*Invoice/i })).not.toBeInTheDocument();
  });

  it('#67: shows a plain Cancel Order action on a confirmed order, not the old dead-option Change Status dropdown', async () => {
    const orderData = {
      row_version: 1,
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    mockFrom.mockImplementation((table: string) =>
      table === 'orders' ? buildChain({ data: orderData, error: null }) : buildChain({ data: [], error: null }),
    );
    renderOrderDetail();
    // The only manual status transition the handler allows is → cancelled, so #67
    // replaced the dropdown (whose fulfilled/partially_fulfilled options always
    // errored) with one honest Cancel Order action.
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Cancel order…' })).toBeInTheDocument();
    expect(screen.queryByText('Change Status')).not.toBeInTheDocument();
  });

  it('refreshes without duplicate side effects when cancellation returns no new-success marker', async () => {
    let orderReads = 0;
    const orderData = {
      row_version: 1,
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        orderReads += 1;
        return buildChain({ data: orderData, error: null });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((rpcName: string) => Promise.resolve(
      rpcName === 'cancel_order'
        ? {
            data: {
              mode: 'full_cancel',
              status: 'cancelled',
              holds_released: 0,
              commissions_cancelled: 0,
              draft_invoices_cancelled: 0,
              posted_invoices_flagged: 0,
              paid_commissions_flagged: 0,
            },
            error: null,
          }
        : { data: null, error: null },
    ));

    renderOrderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel order…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Order' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('cancel_order', {
      p_order_id: 'ord-123',
      p_performed_by: 'user-1',
      p_idempotency_key: 'test-idem-key',
    }));
    await waitFor(() => {
      expect(orderReads).toBeGreaterThanOrEqual(2);
      expect(mockLogActivity).not.toHaveBeenCalled();
      expect(mockNotifyOrderStatusChange).not.toHaveBeenCalled();
    });
  });

  it('labels a partially fulfilled order as Cancel Remaining Quantity and explains the short-close behavior', async () => {
    const orderData = {
      row_version: 1,
      id: 'ord-123', order_number: 'ORD-0099', status: 'partially_fulfilled', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    mockFrom.mockImplementation((table: string) =>
      table === 'orders' ? buildChain({ data: orderData, error: null }) : buildChain({ data: [], error: null }),
    );
    mockRpc.mockImplementation((rpcName: string) => Promise.resolve(
      rpcName === 'cancel_order'
        ? {
            data: {
              success: true,
              mode: 'remainder_closed',
              status: 'fulfilled',
              released_quantity: 6,
              holds_released: 0,
              commissions_cancelled: 0,
              commissions_recomputed: 1,
              draft_invoices_cancelled: 0,
              posted_invoices_flagged: 0,
              paid_commissions_flagged: 0,
            },
            error: null,
          }
        : { data: null, error: null },
    ));

    renderOrderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel remaining quantity…' }));

    expect(await screen.findByRole('heading', { name: 'Cancel Remaining Quantity' })).toBeInTheDocument();
    expect(screen.getByText(/Completed deliveries and their invoices stay intact/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Remaining' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('cancel_order', {
      p_order_id: 'ord-123',
      p_performed_by: 'user-1',
      p_idempotency_key: 'test-idem-key',
    }));
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'success',
        expect.stringContaining('Remaining quantity cancelled; delivered quantity kept as fulfilled.'),
      );
      expect(mockLogActivity).not.toHaveBeenCalled();
      expect(mockNotifyOrderStatusChange).not.toHaveBeenCalled();
    });
  });

  it('posts split draft invoices through one atomic group RPC', async () => {
    const orderData = {
      row_version: 1,
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    const splitDrafts = [
      {
        id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1', invoice_post_version: 'v1:inv-1',
        status: 'draft', invoice_type: 'chemical_sale', invoice_date: '2026-03-15',
        due_date: null, total_amount_cents: 25000, balance_cents: 25000,
      },
      {
        id: 'inv-2', invoice_number: 'INV-2', invoice_group_id: 'group-1', invoice_post_version: 'v1:inv-2',
        status: 'draft', invoice_type: 'chemical_sale', invoice_date: '2026-03-15',
        due_date: null, total_amount_cents: 25000, balance_cents: 25000,
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: orderData, error: null });
      if (table === 'invoices') return buildChain({ data: splitDrafts, error: null });
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({
      data: { posted_invoice_ids: ['inv-1', 'inv-2'], member_count: 2 },
      error: null,
    });

    renderOrderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Post 2 drafts…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post 2 drafts' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(
      'post_invoice_group',
      expect.objectContaining({
        p_invoice_group_id: 'group-1',
        p_performed_by: 'user-1',
        // Every member the page loaded, with the version it loaded.
        p_expected_versions: { 'inv-1': 'v1:inv-1', 'inv-2': 'v1:inv-2' },
      }),
    ));
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice')).toBe(false);
  });

  it('sanitizes an internal contention token when posting draft invoices', async () => {
    const orderData = {
      row_version: 1,
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    const splitDrafts = [{
      id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1', invoice_post_version: 'v1:inv-1',
      status: 'draft', invoice_type: 'chemical_sale', invoice_date: '2026-03-15',
      due_date: null, total_amount_cents: 25000, balance_cents: 25000,
    }];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: orderData, error: null });
      if (table === 'invoices') return buildChain({ data: splitDrafts, error: null });
      return buildChain({ data: [], error: null });
    });
    const contention = { message: 'RETURN_CREDIT_SOURCE_CONCURRENT' };
    mockRpc.mockResolvedValue({ data: null, error: contention });

    renderOrderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Post 1 draft…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post 1 draft' }));

    await waitFor(() => expect(mockSanitizeError).toHaveBeenCalledWith(contention));
    expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Wait a moment and try again'),
    );
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('RETURN_CREDIT_SOURCE_CONCURRENT'));
  });

  it('an added payer shows without a reload', async () => {
    const db = { shares: [] as unknown[] };
    mockShareOrder(db);
    renderOrderDetail();
    await addCedarAt35();
    expect(await screen.findByRole('button', { name: 'Remove Cedar Ridge Ag' })).toBeInTheDocument();
    expect(screen.getByText('2 payers · 100%')).toBeInTheDocument();
  });

  // Staging (13 Nov): the share was saved but the card showed it only after a reload. A reply that fails after the
  // row is written (a 500 or a dropped connection) skipped the reload, so the card kept the list from before.
  it('an added payer shows even when the save reply fails after the row is written', async () => {
    const db = { shares: [] as unknown[] };
    mockShareOrder(db);
    vi.mocked(checkMutationResult).mockImplementationOnce(() => { throw new Error('upstream 500'); });
    renderOrderDetail();
    await addCedarAt35();
    expect(await screen.findByRole('button', { name: 'Remove Cedar Ridge Ag' })).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('error', 'upstream 500');
  });

  it('a removed payer goes without a reload, even when the reply fails after the row is deleted', async () => {
    const db = { shares: [cedarShare] as unknown[] };
    mockShareOrder(db);
    vi.mocked(checkMutationResult).mockImplementationOnce(() => { throw new Error('upstream 500'); });
    renderOrderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Cedar Ridge Ag' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove payer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Cedar Ridge Ag' })).not.toBeInTheDocument());
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'Maple Hollow Farms pays 100%')).toBeInTheDocument();
  });

  describe('sale page layout', () => {
    const saleOrder = {
      row_version: 1, id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_price: 500, total_profit: 200, total_margin_pct: 40, order_name: null,
      notes: '', created_at: '2026-03-15T00:00:00Z', customer_po_number: '4471', salesman_id: 'rep-9', is_planned: false,
    };
    function mockSale(over: { order?: object; customer?: object; invoices?: unknown[]; taxRate?: unknown } = {}) {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'orders') return buildChain({ data: { ...saleOrder, ...over.order }, error: null });
        if (table === 'customers') return buildChain({ data: { id: 'cust-1', farm_name: 'Maple Hollow Farms', ...over.customer }, error: null });
        if (table === 'invoices') return buildChain({ data: over.invoices ?? [], error: null });
        if (table === 'profile_public_view') return buildChain({ data: [{ id: 'rep-9', full_name: 'Test Rep' }], error: null });
        if (table === 'app_settings') return buildChain(over.taxRate === undefined ? { data: { setting_value: '6.25' }, error: null } : over.taxRate as { data: unknown; error: unknown });
        return buildChain({ data: [], error: null });
      });
    }

    it('names the order once, as the page heading, with who and when under it', async () => {
      mockSale();
      renderOrderDetail();
      const h1 = await screen.findByRole('heading', { level: 1, name: 'ORD-0099' });
      expect(h1).toBeInTheDocument();
      expect(screen.getAllByRole('heading', { name: 'ORD-0099' })).toHaveLength(1);
      expect(await screen.findByText(/Maple Hollow Farms · PO 4471 · Ordered .* · Sales: Test Rep/)).toBeInTheDocument();
      expect(screen.getByText('Confirmed')).toBeInTheDocument();
    });

    it('Print opens a menu with the order summary and pick list', async () => {
      mockSale();
      renderOrderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Print' }));
      expect(screen.getByRole('menuitem', { name: 'Order summary PDF' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Pick list PDF' })).toBeInTheDocument();
    });

    it('More actions holds Create task, Record payment and, for an admin, a red Cancel order', async () => {
      mockSale();
      renderOrderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      expect(screen.getByRole('menuitem', { name: 'Create task' })).toBeInTheDocument();
      const cancel = screen.getByRole('menuitem', { name: 'Cancel order…' });
      expect(cancel.className).toMatch(/text-red/);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Record payment' }));
      expect(mockNavigate).toHaveBeenCalledWith('/payments');
    });

    it('a fulfilled order offers a red Void order to an admin, and no Schedule delivery', async () => {
      mockSale({ order: { status: 'fulfilled' } });
      renderOrderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      expect(screen.getByRole('menuitem', { name: 'Void order…' }).className).toMatch(/text-red/);
      expect(screen.queryByRole('menuitem', { name: 'Cancel order…' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Schedule delivery/i })).not.toBeInTheDocument();
    });

    it('shows one money summary with profit for an admin', async () => {
      mockSale();
      renderOrderDetail();
      expect(await screen.findByText('Sale total')).toBeInTheDocument();
      expect(screen.getByText('Profit · margin')).toBeInTheDocument();
      expect(screen.getByText('Balance due')).toBeInTheDocument();
    });

    it('with no invoices yet, the Invoices card says when they are made', async () => {
      mockSale();
      renderOrderDetail();
      expect(await screen.findByText('No invoices yet. Product invoices are made after delivery. Record advance payments as prepay.')).toBeInTheDocument();
      expect(screen.queryByText(/Product invoices are created after delivery/)).not.toBeInTheDocument();
    });

    it('asks before posting all drafts, then posts them', async () => {
      const draft = (n: number) => ({
        id: `inv-${n}`, invoice_number: `INV-${n}`, invoice_group_id: null, invoice_post_version: `v1:inv-${n}`, customer_id: 'cust-1',
        status: 'draft', invoice_type: 'chemical_sale', total_amount_cents: 25000, paid_amount_cents: 0, prepay_applied_cents: 0, balance_cents: 25000,
      });
      mockSale({ invoices: [draft(1), draft(2)] });
      renderOrderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Post 2 drafts…' }));
      expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice')).toBe(false);
      expect(screen.getByRole('dialog', { name: 'Post 2 drafts on this sale?' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Post 2 drafts' }));
      await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')).toHaveLength(2));
    });

    it('the Billing card shows the tax rate from Settings and the customer\'s standing discount', async () => {
      mockSale({ customer: { standing_discount_pct: 3 } });
      renderOrderDetail();
      expect(await screen.findByText('6.25%, set in Settings › Billing. Posted invoices keep the tax they had.')).toBeInTheDocument();
      expect(screen.getByText('Standing discount 3%')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Customer' })).toHaveAttribute('href', '/customers/cust-1');
    });

    it('a tax rate that fails to load is left out, and no discount row shows without one', async () => {
      mockSale({ taxRate: { data: null, error: { message: 'denied' } } });
      renderOrderDetail();
      expect(await screen.findByText('Set in Settings › Billing. Posted invoices keep the tax they had.')).toBeInTheDocument();
      expect(screen.queryByText(/Standing discount/)).not.toBeInTheDocument();
    });

    it('Who pays opens Split by line in one click', async () => {
      const line = { id: 'l1', order_id: 'ord-123', product_name: 'Glyphosate', total_units_needed: 4, quantity_delivered: 0, price_per_unit: 10, total_price: 40, section_name: null };
      mockFrom.mockImplementation((table: string) => answerChain((calls) => {
        if (table === 'orders') return { data: saleOrder, error: null };
        if (table === 'customers' && calls.includes('maybeSingle')) return { data: { id: 'cust-1', farm_name: 'Maple Hollow Farms' }, error: null };
        if (table === 'order_items') return { data: [line], error: null, count: 1 } as { data: unknown; error: unknown };
        // Paged reads need a count, or the field split reads as failed and hides the line split.
        return { data: [], error: null, count: 0 } as { data: unknown; error: unknown };
      }));
      renderOrderDetail();
      fireEvent.click(await screen.findByText('Split by line'));
      expect(screen.queryByRole('button', { name: 'Split by line' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change split for Glyphosate' })).toBeInTheDocument();
    });
  });
});
