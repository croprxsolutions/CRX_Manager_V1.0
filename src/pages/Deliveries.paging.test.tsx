/**
 * Deliveries.paging.test.tsx — Goal 4: the Deliveries list pages, searches and counts in the database.
 *
 * The list reads one page of 50 from get_deliveries_page, which also returns the true total and the
 * cards' counts over every visible delivery. The fake function below behaves like the real one for
 * what the page relies on: search, limit/offset and the totals. Exports and the load sheet must read
 * every matching row (p_limit null), and a failed read must never show zeros or a short list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Row = Record<string, unknown>;
type PageArgs = { p_search?: string | null; p_limit: number | null; p_offset: number; p_today: string };

const H = vi.hoisted(() => ({
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] as string[] },
  tables: {} as Record<string, Row[]>,
  deliveries: [] as Row[],
  // get_deliveries_page calls from this one on fail, like a dropped connection.
  failPageFromCall: null as number | null,
  failTable: null as string | null,
  pageCalls: [] as Array<Record<string, unknown>>,
  toast: vi.fn(),
  exportToCSV: vi.fn(),
}));

function serverQuery(table: string): Record<string, unknown> {
  let rows = H.tables[table] ?? [];
  let range: [number, number] | null = null;
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['eq', 'neq', 'order', 'limit', 'not', 'is', 'gte', 'lte', 'select']) b[m] = self;
  b.in = (column: string, values: unknown[]) => {
    // `delivery.status` filters on the embedded delivery, as PostgREST does with !inner.
    const value = (r: Row) => (column.includes('.') ? (r[column.split('.')[0]] as Row | undefined)?.[column.split('.')[1]] : r[column]);
    rows = rows.filter((r) => values.includes(value(r)));
    return b;
  };
  b.range = (from: number, to: number) => { range = [from, to]; return b; };
  const settle = () => {
    if (H.failTable === table) return { data: null, error: { message: 'connection reset' }, count: null };
    const [from, to] = range ?? [0, Infinity];
    return { data: rows.slice(from, to + 1), error: null, count: rows.length };
  };
  b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve().then(settle).then(onFulfilled, onRejected);
  return b;
}

function deliveriesPage(args: PageArgs) {
  const search = args.p_search?.toLowerCase();
  const matching = H.deliveries.filter((d) => !search || String(d.delivery_number).toLowerCase().includes(search));
  const rows = args.p_limit === null ? matching.slice(args.p_offset) : matching.slice(args.p_offset, args.p_offset + args.p_limit);
  const scheduledToday = H.deliveries.filter((d) => d.scheduled_date === args.p_today).length;
  return {
    success: true,
    total_count: matching.length,
    rows,
    summary: {
      visible_count: H.deliveries.length,
      open_count: H.deliveries.length,
      scheduled_today: scheduledToday,
      in_progress: 0,
      completed_this_week: 0,
      strip: [{ date: args.p_today, count: scheduledToday, unassigned: scheduledToday }],
    },
  };
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => serverQuery(table),
    rpc: vi.fn((name: string, args: PageArgs) => {
      if (name !== 'get_deliveries_page') return Promise.resolve({ data: null, error: null });
      H.pageCalls.push(args);
      if (H.failPageFromCall !== null && H.pageCalls.length >= H.failPageFromCall) {
        return Promise.resolve({ data: null, error: { message: 'connection reset' } });
      }
      return Promise.resolve({ data: deliveriesPage(args), error: null });
    }),
  },
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  assertRpcResult: vi.fn((d) => {
    if (d === null || d === undefined) throw new Error('no result');
    return d;
  }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => H.auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyDeliveryCompleted: vi.fn() }));
vi.mock('../lib/csvExport', () => ({ exportToCSV: H.exportToCSV, fmtDateCSV: vi.fn() }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../components/deliveries/BatchCancelModal', () => ({ default: () => null }));
vi.mock('../components/deliveries/QuickDeliveryModal', () => ({ default: () => null }));
vi.mock('../components/deliveries/DeliveryCalendar', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerDrawer', () => ({ default: () => null }));
// The table only reports the rows it was given and the first delivery number.
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data }: { data: Array<{ delivery_number: string }> }) => (
    <div>
      <p data-testid="table-rows">{data.length}</p>
      <p data-testid="table-first">{data[0]?.delivery_number}</p>
    </div>
  ),
}));

import Deliveries from './Deliveries';
import { localToday } from '../lib/dateUtils';

const TOTAL = 1500;

beforeEach(() => {
  vi.clearAllMocks();
  H.auth.role = 'admin';
  H.auth.profile = { id: 'user-1', role: 'admin' };
  H.failPageFromCall = null;
  H.failTable = null;
  H.pageCalls = [];
  H.deliveries = Array.from({ length: TOTAL }, (_, i) => ({
    id: `del-${String(i).padStart(4, '0')}`,
    delivery_number: `DEL-${String(i).padStart(4, '0')}`,
    status: 'scheduled',
    scheduled_date: localToday(),
    customer_id: 'cust-1',
    assigned_driver: null,
    customer_name: 'Big Farm',
    driver_name: 'Unassigned',
    item_count: 0,
    farm_group_name: null,
  }));
  H.tables = {
    delivery_items: [
      { id: 'item-a', delivery_id: 'del-1499', product_id: 'product-1', quantity: 1, delivery: { status: 'scheduled' } },
    ],
    customers: [{ id: 'cust-1', farm_name: 'Big Farm' }],
    profile_public_view: [],
    inventory: [{ id: 'inv-1', product_id: 'product-1', quantity_available: 100 }],
    delivery_remainders: [],
  };
});

const showing = () => screen.getByText(/^Showing /);

describe('Deliveries list pages in the database', () => {
  it('shows one page with the true totals, pages through, and exports every matching row', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    // The card counts every delivery, not only the 50 on the page.
    const card = (await screen.findByText('Scheduled Today')).closest('div')!.parentElement!;
    expect(card).toHaveTextContent(String(TOTAL));
    expect(screen.getByTestId('table-rows')).toHaveTextContent('50');
    expect(showing()).toHaveTextContent(`Showing 1–50 of ${TOTAL}`);
    expect(H.pageCalls[0]).toMatchObject({ p_limit: 50, p_offset: 0 });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(showing()).toHaveTextContent(`Showing 51–100 of ${TOTAL}`));
    expect(screen.getByTestId('table-first')).toHaveTextContent('DEL-0050');
    expect(H.pageCalls[H.pageCalls.length - 1]).toMatchObject({ p_limit: 50, p_offset: 50 });

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(H.exportToCSV).toHaveBeenCalledTimes(1));
    const exported = H.exportToCSV.mock.calls[0][0] as Array<{ delivery_number: string }>;
    expect(exported).toHaveLength(TOTAL);
    expect(new Set(exported.map((d) => d.delivery_number)).size).toBe(TOTAL);
    expect(H.pageCalls[H.pageCalls.length - 1]).toMatchObject({ p_limit: null, p_offset: 0 });
  });

  it('searches in the database, finds a row past the first page, and starts again at page one', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(showing()).toHaveTextContent('Showing 51–100'));

    fireEvent.change(screen.getByLabelText('Search deliveries'), { target: { value: 'DEL-1499' } });
    await waitFor(() => expect(showing()).toHaveTextContent('Showing 1–1 of 1'), { timeout: 3000 });
    expect(screen.getByTestId('table-first')).toHaveTextContent('DEL-1499');
    expect(H.pageCalls[H.pageCalls.length - 1]).toMatchObject({ p_search: 'DEL-1499', p_limit: 50, p_offset: 0 });
    // The cards still count every delivery, whatever the search.
    expect((screen.getByText('Scheduled Today').closest('div')!.parentElement!)).toHaveTextContent(String(TOTAL));
  });

  it('shows an error, not zeros or the old page, when a page read fails', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    H.failPageFromCall = H.pageCalls.length + 1;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Deliveries could not be loaded');
    expect(screen.queryByText('Scheduled Today')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load deliveries. Please try again.');
  });

  it('exports nothing and says so when the export read fails', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    H.failPageFromCall = H.pageCalls.length + 1;
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'The deliveries could not be read for the export. Nothing was exported; try again.'));
    expect(H.exportToCSV).not.toHaveBeenCalled();
  });

  it('keeps a warning on screen when the stock check fails, so no badge is not read as enough stock', async () => {
    H.failTable = 'inventory';
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Stock shortage warnings could not be checked');
    expect(screen.getByTestId('table-rows')).toHaveTextContent('50');
  });

  it("shows a driver an error, not \"no deliveries\", when their list fails to load", async () => {
    H.auth.role = 'driver';
    H.auth.profile = { id: 'driver-1', role: 'driver' };
    H.failPageFromCall = 1;
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your deliveries could not be loaded');
    expect(screen.queryByText('No deliveries scheduled for today.')).not.toBeInTheDocument();
  });

  it('gives a driver every delivery of theirs in one read, with the stock-check warning', async () => {
    H.auth.role = 'driver';
    H.auth.profile = { id: 'driver-1', role: 'driver' };
    H.failTable = 'inventory';
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Stock shortage warnings could not be checked');
    expect(screen.getAllByText('DEL-1499').length).toBeGreaterThan(0);
    expect(H.pageCalls.every((c) => c.p_limit === null)).toBe(true);
  });
});
