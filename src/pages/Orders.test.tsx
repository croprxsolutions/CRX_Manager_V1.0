import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildPaginatedQueryChain as buildChain, type QueryResult } from '../test-utils/supabaseChain';

const {
  mockFrom,
  mockRpc,
  mockToast,
  mockCheckMutationResult,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockCheckMutationResult: vi.fn(),
}));

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: mockCheckMutationResult,
  assertRpcResult: (data: unknown, name: string) => {
    if (data === null || data === undefined) throw new Error(`${name} returned no data`);
    return data;
  },
  sanitizeError: (error: unknown) => error instanceof Error ? error.message : 'Request failed',
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', deniedPages: [] }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../components/ui/PageHeader', () => ({
  default: ({ actions }: { actions?: ReactNode }) => <div>{actions}</div>,
}));
// The table shows each row's tick box (the first column) and the filters, so selection can be driven.
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data, columns, filters, loadError }: {
    data: Array<{ id: string; order_number: string }>;
    columns: Array<{ key: string; render?: (row: unknown) => ReactNode }>;
    filters?: ReactNode;
    loadError?: boolean;
  }) => (
    <div>
      {filters}
      {loadError ? <span>could not be loaded</span> : <span>{`${data.length} rows shown`}</span>}
      {data.map((row) => (
        <div key={row.id}>
          {row.order_number}
          {columns[0].key === '_select' && columns[0].render?.(row)}
        </div>
      ))}
    </div>
  ),
}));
vi.mock('../components/ui/BulkDeleteConfirmModal', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open
    ? <button onClick={onConfirm}>Confirm order delete</button>
    : null,
}));
vi.mock('../components/orders/BulkOrderImport', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerDrawer', () => ({ default: () => null }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import Orders from './Orders';

const order = (i: number, status = 'confirmed') => ({
  id: `order-${i}`, order_number: `ORD-${i}`, customer_id: 'customer-1', status,
  order_date: '2026-10-01', total_price: 10, fulfillment_pct: 0, invoiced_pct: 0,
  customer: { farm_name: 'Test Farm', parent_customer_id: null }, customer_name: 'Test Farm',
  farm_group_name: null, active_delivery_count: 0, earliest_delivery_date: null, product_names: '',
});

/** get_orders_page over `all`: each call returns its p_offset/p_limit slice and the totals of every row. */
function serveOrders(all: ReturnType<typeof order>[]) {
  mockRpc.mockImplementation((_fn: string, args: { p_limit: number; p_offset: number }) => Promise.resolve({
    data: { rows: all.slice(args.p_offset, args.p_offset + args.p_limit), total_count: all.length, total_price_cents: all.length * 1000 },
    error: null,
  }));
}

function renderPage() {
  return render(<MemoryRouter><Orders /></MemoryRouter>);
}

describe('Orders list pages through the database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckMutationResult.mockImplementation((result: QueryResult) => {
      if (result.error) throw new Error(result.error.message);
    });
  });

  it('shows one page and the true count and total of every matching order', async () => {
    serveOrders(Array.from({ length: 5200 }, (_, i) => order(i)));
    renderPage();

    expect(await screen.findByText('50 rows shown')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–50 of 5,200 orders · $52,000.00 total')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('get_orders_page', expect.objectContaining({
      p_sort_dir: 'asc', p_limit: 50, p_offset: 0,
    }));
    // No filter chosen: those arguments are left out, so the database reads them as NULL.
    const firstArgs = mockRpc.mock.calls[0][1];
    for (const k of ['p_search', 'p_status', 'p_planned', 'p_pricing_status', 'p_needs_split_billing', 'p_sort_key']) {
      expect(firstArgs[k]).toBeUndefined();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 51–100 of 5,200 orders · $52,000.00 total')).toBeInTheDocument();
    expect(screen.getByText('ORD-50')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenLastCalledWith('get_orders_page', expect.objectContaining({ p_limit: 50, p_offset: 50 }));
  });

  it('sends the filters to the database and starts again at page one', async () => {
    serveOrders(Array.from({ length: 120 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 51–100 of 120 orders · $1,200.00 total');

    fireEvent.change(screen.getByLabelText('Filter by planned or committed'), { target: { value: 'committed' } });
    fireEvent.change(screen.getByLabelText('Filter by split billing status'), { target: { value: 'needs_split' } });

    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('get_orders_page', expect.objectContaining({
      p_planned: false, p_needs_split_billing: true, p_offset: 0,
    })));
  });

  it('a new filter hides the old totals while its own read is pending', async () => {
    serveOrders(Array.from({ length: 120 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');

    mockRpc.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByLabelText('Filter by split billing status'), { target: { value: 'needs_split' } });

    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('get_orders_page', expect.objectContaining({ p_needs_split_billing: true })));
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Select All 120/ })).not.toBeInTheDocument();
  });

  it('a failed read says so and shows no count or total', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });
    renderPage();

    expect(await screen.findByText('could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/total/)).not.toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load orders. Please try again.');
  });

  it('a reply with no totals counts as a failed read, never as $0', async () => {
    mockRpc.mockResolvedValue({ data: { rows: [] }, error: null });
    renderPage();

    expect(await screen.findByText('could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
  });

  it('"Select All" with more orders than the page reads every matching order for export', async () => {
    serveOrders(Array.from({ length: 1500 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('50 rows shown');

    fireEvent.click(screen.getByRole('button', { name: 'Select All 1,500' }));

    expect(await screen.findByText('1500 selected')).toBeInTheDocument();
    // Pages of 1000 with the 50-row seam overlap, read twice to confirm the list did not change.
    const pageCalls = mockRpc.mock.calls.map(([, args]) => [args.p_offset, args.p_limit]).filter(([, limit]) => limit === 1000);
    expect(pageCalls).toEqual([[0, 1000], [950, 1000], [1450, 1000], [0, 1000], [950, 1000], [1450, 1000]]);
    expect(screen.getByRole('button', { name: 'Deselect All' })).toBeInTheDocument();
  });
});

describe('Orders bulk-delete lifecycle guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckMutationResult.mockImplementation((result: QueryResult) => {
      if (result.error) throw new Error(result.error.message);
    });
  });

  async function selectOnlyOrder(status: string, mutationResult: QueryResult) {
    serveOrders([order(1, status)]);
    const mutation = buildChain(mutationResult);
    mockFrom.mockImplementation(() => mutation);
    renderPage();
    await screen.findByText('1 rows shown');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    // Wrapped: the chain is thenable, so returning it bare from an async function would unwrap it.
    return { mutation };
  }

  it('refuses an active selected order before opening confirmation', async () => {
    const { mutation } = await selectOnlyOrder('confirmed', { data: [{ id: 'order-1' }], error: null });

    expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 selected order(s) are still active. Cancel or void them first, then delete them.',
    );
    expect(screen.queryByRole('button', { name: 'Confirm order delete' })).not.toBeInTheDocument();
    expect(mutation.update).not.toHaveBeenCalled();
  });

  it('soft-deletes a terminal selected order after confirmation', async () => {
    const { mutation } = await selectOnlyOrder('cancelled', { data: [{ id: 'order-1' }], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order delete' }));

    await waitFor(() => {
      expect(mutation.update).toHaveBeenCalledWith({ deleted_at: expect.any(String) });
      expect(mutation.in).toHaveBeenCalledWith('id', ['order-1']);
      expect(mockToast).toHaveBeenCalledWith('success', 'Deleted 1 order(s)');
    });
  });

  it('translates the database race guard into plain English', async () => {
    await selectOnlyOrder('voided', { data: null, error: { message: 'ORDER_MUST_BE_TERMINAL_BEFORE_DELETE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order delete' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        'An order became active before deletion. Refresh the list, then cancel or void it first.',
      );
    });
    expect(mockCheckMutationResult).not.toHaveBeenCalled();
  });
});
