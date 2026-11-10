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
  default: ({ data, columns, filters, loading, loadError, searchValue, onSearchChange }: {
    data: Array<{ id: string; order_number: string }>;
    searchValue?: string;
    onSearchChange?: (v: string) => void;
    columns: Array<{ key: string; render?: (row: unknown) => ReactNode }>;
    filters?: ReactNode;
    loading?: boolean;
    loadError?: boolean;
  }) => (
    <div>
      <input aria-label="Search orders or products…" value={searchValue ?? ''} onChange={(e) => onSearchChange?.(e.target.value)} />
      {filters}
      {loadError ? <span>could not be loaded</span> : <span>{`${data.length} rows shown`}</span>}
      {loading ? <span>rows loading</span> : data.map((row) => (
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
vi.mock('../components/orders/BulkOrderImport', () => ({
  default: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>Finish import</button>,
}));
vi.mock('../components/customers/CustomerDrawer', () => ({ default: () => null }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import Orders from './Orders';

const order = (i: number, status = 'confirmed') => ({
  id: `order-${String(i).padStart(5, '0')}`, order_number: `ORD-${i}`, customer_id: 'customer-1', status,
  order_date: '2026-10-01', total_price: 10, fulfillment_pct: 0, invoiced_pct: 0,
  customer: { farm_name: 'Test Farm', parent_customer_id: null }, customer_name: 'Test Farm',
  farm_group_name: null, active_delivery_count: 0, earliest_delivery_date: null, product_names: '',
});

type PageArgs = { p_limit: number; p_offset: number; p_after?: { id: string } };

/** One reply of get_orders_keyset_page over `all`: the rows after the bookmark (or at the offset), every row's totals, and the next bookmark. */
function pageOf(all: ReturnType<typeof order>[], args: PageArgs) {
  const start = args.p_after ? all.findIndex((o) => o.id > args.p_after!.id) : args.p_offset;
  const from = start < 0 ? all.length : start;
  const rows = all.slice(from, from + args.p_limit);
  const more = from + args.p_limit < all.length;
  return {
    rows, total_count: all.length, total_price_cents: all.length * 1000,
    next_cursor: more ? { k: null, dir: 'asc', t: null, d: '2026-10-01', id: rows[rows.length - 1].id } : null,
  };
}

/** get_orders_keyset_page over `all` (ids sort in list order). Reads `all` on every call, so a test may remove rows between pages. */
function serveOrders(all: ReturnType<typeof order>[]) {
  mockRpc.mockImplementation((_fn: string, args: PageArgs) => Promise.resolve({ data: pageOf(all, args), error: null }));
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
    expect(mockRpc).toHaveBeenCalledWith('get_orders_keyset_page', expect.objectContaining({
      p_sort_dir: 'asc', p_limit: 50, p_offset: 0,
    }));
    // No filter chosen: those arguments are left out, so the database reads them as NULL.
    const firstArgs = mockRpc.mock.calls[0][1];
    for (const k of ['p_search', 'p_status', 'p_planned', 'p_pricing_status', 'p_needs_split_billing', 'p_sort_key']) {
      expect(firstArgs[k]).toBeUndefined();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 · 50 shown of 5,200 orders · $52,000.00 total')).toBeInTheDocument();
    expect(screen.getByText('ORD-50')).toBeInTheDocument();
    // Page two starts after page one's last row (its bookmark), not at a row count.
    expect(mockRpc).toHaveBeenLastCalledWith('get_orders_keyset_page', expect.objectContaining({
      p_limit: 50, p_offset: 0, p_after: expect.objectContaining({ id: 'order-00049' }),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Showing 1–50 of 5,200 orders · $52,000.00 total')).toBeInTheDocument();
    expect(mockRpc.mock.calls[mockRpc.mock.calls.length - 1][1].p_after).toBeUndefined();
  });

  it('an order removed while page one is on screen does not make Next skip one', async () => {
    const all = Array.from({ length: 120 }, (_, i) => order(i));
    serveOrders(all);
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');

    all.splice(3, 1); // someone else removes ORD-3
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(/of 119 orders/);
    // Counting rows would now start at ORD-51; the bookmark starts right after ORD-49.
    expect(screen.getByText('ORD-50')).toBeInTheDocument();
    expect(screen.getByText('Page 2 · 50 shown of 119 orders · $1,190.00 total')).toBeInTheDocument();
  });

  it('the last page has no Next, even when the count would allow one', async () => {
    serveOrders(Array.from({ length: 60 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–50 of 60 orders · $600.00 total');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 · 10 shown of 60 orders · $600.00 total');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('a page whose orders were all removed steps back to the page before', async () => {
    const all = Array.from({ length: 60 }, (_, i) => order(i));
    serveOrders(all);
    renderPage();
    await screen.findByText('Showing 1–50 of 60 orders · $600.00 total');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 · 10 shown of 60 orders · $600.00 total');

    all.splice(50, 10);
    fireEvent.click(screen.getByRole('button', { name: 'Finish import' }));
    expect(await screen.findByText('Showing 1–50 of 50 orders · $500.00 total')).toBeInTheDocument();
  });

  it('a bookmark the database refuses starts again at page one, with no error shown', async () => {
    const all = Array.from({ length: 120 }, (_, i) => order(i));
    serveOrders(all);
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 · 50 shown of 120 orders · $1,200.00 total');

    mockRpc.mockImplementation((_fn: string, args: PageArgs) => Promise.resolve(args.p_after
      ? { data: null, error: { message: 'ORDERS_PAGE_STALE_CURSOR' } }
      : { data: pageOf(all, args), error: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish import' }));
    expect(await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total')).toBeInTheDocument();
    // Fresh page-one rows arrived from a read with no bookmark, not just the label.
    expect(await screen.findByText('ORD-0')).toBeInTheDocument();
    expect(screen.queryByText('ORD-50')).not.toBeInTheDocument();
    expect(mockRpc).toHaveBeenLastCalledWith('get_orders_keyset_page', expect.objectContaining({ p_after: undefined }));
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Failed to load orders. Please try again.');
  });

  it('sends the filters to the database and starts again at page one', async () => {
    serveOrders(Array.from({ length: 120 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 · 50 shown of 120 orders · $1,200.00 total');

    fireEvent.change(screen.getByLabelText('Filter by planned or committed'), { target: { value: 'committed' } });
    fireEvent.change(screen.getByLabelText('Filter by split billing status'), { target: { value: 'needs_split' } });

    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('get_orders_keyset_page', expect.objectContaining({
      p_planned: false, p_needs_split_billing: true, p_offset: 0,
    })));
  });

  it('a new filter hides the old totals while its own read is pending', async () => {
    serveOrders(Array.from({ length: 120 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');

    mockRpc.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByLabelText('Filter by split billing status'), { target: { value: 'needs_split' } });

    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('get_orders_keyset_page', expect.objectContaining({ p_needs_split_billing: true })));
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

    // Unticking one row after "select all" brings the Select All button back.
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(await screen.findByText('1499 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select All 1,500' })).toBeInTheDocument();
  });

  it('a ticked row does not follow the user to another page, and "Select All" does not come back after a filter round trip', async () => {
    serveOrders(Array.from({ length: 120 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 · 50 shown of 120 orders · $1,200.00 total');
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select All 120' }));
    expect(await screen.findByText('120 selected')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter by split billing status'), { target: { value: 'needs_split' } });
    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('get_orders_keyset_page', expect.objectContaining({ p_needs_split_billing: true })));
    fireEvent.change(screen.getByLabelText('Filter by split billing status'), { target: { value: '' } });
    await screen.findByText(/of 120 orders · \$1,200\.00 total/);
    expect(screen.queryByText('120 selected')).not.toBeInTheDocument();
  });

  it('"Select All" does nothing while a new filter is still loading (the rows shown are the old query\'s)', async () => {
    serveOrders(Array.from({ length: 30 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–30 of 30 orders · $300.00 total');

    mockRpc.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByLabelText('Filter by split billing status'), { target: { value: 'needs_split' } });
    await waitFor(() => expect(screen.queryByText(/Showing/)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('"Select All" is greyed out while a page read is running, so a click is never silently dropped', async () => {
    serveOrders(Array.from({ length: 120 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');
    expect(screen.getByRole('button', { name: 'Select All 120' })).toBeEnabled();

    mockRpc.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('rows loading');
    expect(screen.getByRole('button', { name: 'Select All 120' })).toBeDisabled();
  });

  it('while a typed search waits to run, the old rows are hidden and "Select All" is greyed out', async () => {
    serveOrders(Array.from({ length: 120 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');

    fireEvent.change(screen.getByLabelText('Search orders or products…'), { target: { value: 'ORD-2' } });
    expect(screen.getByText('rows loading')).toBeInTheDocument();
    expect(screen.queryByText('ORD-0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select All 120' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('a refresh that fails drops "Select All": no bulk action is offered over rows nobody can see', async () => {
    serveOrders(Array.from({ length: 1500 }, (_, i) => order(i, 'cancelled')));
    renderPage();
    await screen.findByText('50 rows shown');
    fireEvent.click(screen.getByRole('button', { name: 'Select All 1,500' }));
    expect(await screen.findByText('1500 selected')).toBeInTheDocument();

    mockRpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish import' }));

    expect(await screen.findByText('could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('a refresh that succeeds also drops "Select All": an order that left the filter is never acted on (Mason, 2026-11-06)', async () => {
    serveOrders(Array.from({ length: 1500 }, (_, i) => order(i, 'cancelled')));
    renderPage();
    await screen.findByText('50 rows shown');
    fireEvent.click(screen.getByRole('button', { name: 'Select All 1,500' }));
    expect(await screen.findByText('1500 selected')).toBeInTheDocument();

    // Someone reopened order 0: it is no longer in the list.
    serveOrders(Array.from({ length: 1499 }, (_, i) => order(i + 1, 'cancelled')));
    fireEvent.click(screen.getByRole('button', { name: 'Finish import' }));

    expect(await screen.findByText(/of 1,499 orders/)).toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('a refresh that lands while "Select All" is still reading wins: the late read selects nothing', async () => {
    const all = Array.from({ length: 120 }, (_, i) => order(i));
    serveOrders(all);
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockRpc.mockImplementation(async (_fn: string, args: PageArgs) => {
      if (args.p_limit === 1000) await gate;
      return { data: pageOf(all, args), error: null };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select All 120' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish import' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select All 120' })).toBeEnabled());
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('typing a search drops the selection at once, before the search runs', async () => {
    serveOrders(Array.from({ length: 30 }, (_, i) => order(i)));
    renderPage();
    await screen.findByText('Showing 1–30 of 30 orders · $300.00 total');
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    await screen.findByText('1 selected');

    fireEvent.change(screen.getByLabelText('Search orders or products…'), { target: { value: 'ORD-2' } });
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('Deselect while a "Select All" read is still running wins: the late read selects nothing', async () => {
    const all = Array.from({ length: 120 }, (_, i) => order(i));
    serveOrders(all);
    renderPage();
    await screen.findByText('Showing 1–50 of 120 orders · $1,200.00 total');
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    await screen.findByText('1 selected');

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockRpc.mockImplementation(async (_fn: string, args: PageArgs) => {
      if (args.p_limit === 1000) await gate;
      return { data: pageOf(all, args), error: null };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select All 120' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deselect' }));
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select All 120' })).toBeEnabled());
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
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
    const { mutation } = await selectOnlyOrder('confirmed', { data: [{ id: 'order-00001' }], error: null });

    expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 selected order(s) are still active. Cancel or void them first, then delete them.',
    );
    expect(screen.queryByRole('button', { name: 'Confirm order delete' })).not.toBeInTheDocument();
    expect(mutation.update).not.toHaveBeenCalled();
  });

  it('soft-deletes a terminal selected order after confirmation', async () => {
    const { mutation } = await selectOnlyOrder('cancelled', { data: [{ id: 'order-00001' }], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order delete' }));

    await waitFor(() => {
      expect(mutation.update).toHaveBeenCalledWith({ deleted_at: expect.any(String) });
      expect(mutation.in).toHaveBeenCalledWith('id', ['order-00001']);
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
