/**
 * Deliveries.paging.test.tsx — Goal 4: the Deliveries list pages, searches and counts in the database.
 *
 * The list reads one page of 50 from get_deliveries_keyset_page, which also returns the true total and the
 * cards' counts over every visible delivery. The fake function below behaves like the real one for
 * what the page relies on: search, limit, the bookmark of the last row shown (next_cursor / p_after) and
 * the totals. Exports and the load sheet must read
 * every matching row in pages of 500 (the most one call may return), and a failed read must never show
 * zeros or a short list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Row = Record<string, unknown>;
type PageArgs = { p_search?: string | null; p_driver_id?: string | null; p_limit: number; p_offset: number; p_after_id?: string; p_after?: { id: string }; p_today: string };
const FIRST_ID = '00000000-0000-0000-0000-000000000000';

const H = vi.hoisted(() => ({
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] as string[] },
  tables: {} as Record<string, Row[]>,
  deliveries: [] as Row[],
  // get_deliveries_page calls from this one on fail, like a dropped connection.
  failPageFromCall: null as number | null,
  // Just before this get_deliveries_page call, a delivery read on page 1 is cancelled and a new one is
  // saved at the end, so the total stays the same and every later row moves up one place.
  editDeliveriesAtCall: null as number | null,
  // Just before this call, a delivery read on page 1 is cancelled and a new one is saved with an id below
  // every other, in the part a whole-list read has already passed: the total stays the same.
  swapBehindReadAtCall: null as number | null,
  // Every get_deliveries_page call first saves one more delivery, so no read ever sees a still list.
  growEveryPageCall: false,
  // While set, every bookmark is refused as stale.
  refuseBookmarks: false,
  // While set, answers leave next_cursor out (as an older database function would).
  omitNextCursor: false,
  // While set, get_deliveries_page answers only once this settles, so a test can look at the screen mid-read.
  holdPageCalls: null as Promise<void> | null,
  failTable: null as string | null,
  // While set, reads of delivery_items answer only once this settles (the stock check stays pending).
  holdStockCheck: null as Promise<void> | null,
  // Every table the screen reads, in order (the stock check reads inventory).
  tableReads: [] as string[],
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
    (table === 'delivery_items' && H.holdStockCheck ? H.holdStockCheck : Promise.resolve()).then(settle).then(onFulfilled, onRejected);
  return b;
}

function deliveriesPage(args: PageArgs) {
  const search = args.p_search?.toLowerCase();
  const matching = H.deliveries.filter((d) => (!search || String(d.delivery_number).toLowerCase().includes(search))
    && (!args.p_driver_id || d.assigned_driver === args.p_driver_id));
  // The real function refuses any page larger than 500, and a null limit.
  if (typeof args.p_limit !== 'number' || args.p_limit < 1 || args.p_limit > 500) throw new Error('DELIVERIES_PAGE_BAD_ARGS');
  // Like the real function: a read by id returns the rows after that id in id order, each with its place
  // in the chosen order.
  if (args.p_after_id && args.p_offset !== 0) throw new Error('DELIVERIES_PAGE_BAD_ARGS');
  if (args.p_after && (args.p_offset !== 0 || args.p_after_id)) throw new Error('DELIVERIES_PAGE_BAD_ARGS');
  const placed: Row[] = matching.map((d, i) => ({ ...d, sort_position: i + 1 }));
  // A bookmark starts right after its row; here the bookmarked row must still be listed (the tests remove
  // others), and H.refuseBookmarks makes every bookmark stale, as a new day or sort would.
  const start = args.p_after ? placed.findIndex((d) => d.id === args.p_after!.id) + 1 : args.p_offset;
  if (args.p_after && (start === 0 || H.refuseBookmarks)) throw new Error('DELIVERIES_PAGE_STALE_CURSOR');
  const rows = args.p_after_id
    ? placed.filter((d) => String(d.id) > args.p_after_id!).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, args.p_limit)
    : placed.slice(start, start + args.p_limit);
  const nextCursor = !args.p_after_id && start + args.p_limit < placed.length ? { id: String(rows[rows.length - 1].id) } : null;
  const scheduledToday = H.deliveries.filter((d) => d.scheduled_date === args.p_today).length;
  return {
    success: true,
    total_count: matching.length,
    rows,
    next_cursor: nextCursor,
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

// The function's own refusals come back as an error, as PostgREST returns a raised exception.
function answer(args: PageArgs) {
  try {
    const data = deliveriesPage(args);
    if (H.omitNextCursor) delete (data as { next_cursor?: unknown }).next_cursor;
    return { data, error: null };
  } catch (e) {
    return { data: null, error: { message: (e as Error).message } };
  }
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => { H.tableReads.push(table); return serverQuery(table); },
    rpc: vi.fn((name: string, args: PageArgs) => {
      if (name !== 'get_deliveries_keyset_page') return Promise.resolve({ data: null, error: null });
      H.pageCalls.push(args);
      if (H.failPageFromCall !== null && H.pageCalls.length >= H.failPageFromCall) {
        return Promise.resolve({ data: null, error: { message: 'connection reset' } });
      }
      if (H.editDeliveriesAtCall === H.pageCalls.length) {
        H.deliveries.splice(1, 1);
        H.deliveries.push({ ...H.deliveries[0], id: 'del-new', delivery_number: 'DEL-NEW' });
      }
      if (H.swapBehindReadAtCall === H.pageCalls.length) {
        H.deliveries.splice(1, 1);
        H.deliveries.push({ ...H.deliveries[0], id: 'a-new', delivery_number: 'DEL-SWAP' });
      }
      if (H.growEveryPageCall) H.deliveries.push({ ...H.deliveries[0], id: `del-grow-${H.pageCalls.length}`, delivery_number: `DEL-GROW-${H.pageCalls.length}` });
      if (H.holdPageCalls) return H.holdPageCalls.then(() => answer(args));
      return Promise.resolve(answer(args));
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
vi.mock('../components/deliveries/ReceiptsToCheck', () => ({ default: () => null }));
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
  H.editDeliveriesAtCall = null;
  H.growEveryPageCall = false;
  H.swapBehindReadAtCall = null;
  H.holdPageCalls = null;
  H.refuseBookmarks = false;
  H.omitNextCursor = false;
  H.failTable = null;
  H.holdStockCheck = null;
  H.tableReads = [];
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

const showing = () => screen.getByText(/^(Showing|Page \d+) /);

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
    await waitFor(() => expect(showing()).toHaveTextContent(`Page 2 · 50 shown of ${TOTAL}`));
    expect(screen.getByTestId('table-first')).toHaveTextContent('DEL-0050');
    // Page two starts right after page one's last row, not at a row count.
    expect(H.pageCalls[H.pageCalls.length - 1]).toMatchObject({ p_limit: 50, p_offset: 0, p_after: { id: 'del-0049' } });

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(H.exportToCSV).toHaveBeenCalledTimes(1));
    const exported = H.exportToCSV.mock.calls[0][0] as Array<{ delivery_number: string }>;
    expect(exported).toHaveLength(TOTAL);
    // In the shown order, every row once.
    expect(exported.map((d) => d.delivery_number)).toEqual(H.deliveries.map((d) => d.delivery_number));
    // 1,500 rows: reads of 500, each after the last id read, until one comes back short.
    expect(H.pageCalls.slice(-4).map((c) => [c.p_limit, c.p_offset, c.p_after_id])).toEqual([[500, 0, FIRST_ID], [500, 0, 'del-0499'], [500, 0, 'del-0999'], [500, 0, 'del-1499']]);
  });

  it('searches in the database, finds a row past the first page, and starts again at page one', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(showing()).toHaveTextContent('Page 2 · 50 shown'));

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
    expect(screen.queryByText(/^(Showing|Page \d+) /)).not.toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load deliveries. Please try again.');
  });

  it('downloads one CSV for a double click', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    const button = screen.getByRole('button', { name: /Export CSV/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(H.exportToCSV).toHaveBeenCalledTimes(1));
    // One export: a whole read and its confirming second read, never two exports' worth.
    expect(H.pageCalls.filter((c) => c.p_after_id === FIRST_ID)).toHaveLength(2);
  });

  it('reads the same page again from Try again after a failed read', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    H.failPageFromCall = H.pageCalls.length + 1;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Deliveries could not be loaded');

    H.failPageFromCall = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(showing()).toHaveTextContent(`Page 2 · 50 shown of ${TOTAL}`));
    expect(screen.getByTestId('table-first')).toHaveTextContent('DEL-0050');
  });

  it('offers no batch action or export on the old rows while a new page loads', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select DEL-0000' })[0]);
    expect(screen.getByRole('button', { name: /Cancel 1 Selected/ })).toBeInTheDocument();

    let release!: () => void;
    H.holdPageCalls = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Cancel 1 Selected/ })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDisabled();
    // The phone list hides the old rows and their actions too, so none can open the wrong delivery.
    expect(screen.queryAllByRole('checkbox', { name: 'Select DEL-0000' })).toHaveLength(0);

    await act(async () => { release(); });
    await waitFor(() => expect(showing()).toHaveTextContent(`Page 2 · 50 shown of ${TOTAL}`));
    expect(screen.queryByRole('button', { name: /Cancel 1 Selected/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeEnabled();
  });

  it('says the stock check is still running, so no badge is not read as enough stock before it finishes', async () => {
    let release!: () => void;
    H.holdStockCheck = new Promise<void>((resolve) => { release = resolve; });
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    expect(screen.getByText(/Checking stock for shortages/)).toHaveAttribute('role', 'status');

    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByText(/Checking stock for shortages/)).not.toBeInTheDocument());
  });

  it('checks stock on opening, not on every page flip, since the check covers every open delivery', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    await waitFor(() => expect(H.tableReads).toContain('delivery_items'));
    const before = H.tableReads.filter((t) => t === 'delivery_items').length;

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(showing()).toHaveTextContent(`Page 2 · 50 shown of ${TOTAL}`));
    expect(H.tableReads.filter((t) => t === 'delivery_items')).toHaveLength(before);
  });

  it('offers no batch action on the old rows while a typed search has not been applied yet', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select DEL-0000' })[0]);
    expect(screen.getByRole('button', { name: /Cancel 1 Selected/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search deliveries'), { target: { value: 'DEL-1499' } });
    expect(screen.queryByRole('button', { name: /Cancel 1 Selected/ })).not.toBeInTheDocument();
  });

  it('exports from the calendar what the calendar shows, not the list filters it hides', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: 'high' } });
    await waitFor(() => expect(H.pageCalls[H.pageCalls.length - 1]?.p_priority).toBe('high'));

    fireEvent.click(screen.getByRole('button', { name: 'Calendar view' }));
    await waitFor(() => expect(H.pageCalls[H.pageCalls.length - 1]?.p_priority ?? null).toBeNull());
    const calls = H.pageCalls.length;
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(H.exportToCSV).toHaveBeenCalledTimes(1));
    const exportCalls = H.pageCalls.slice(calls);
    expect(exportCalls.length).toBeGreaterThan(0);
    expect(exportCalls.every((c) => (c.p_priority ?? null) === null)).toBe(true);
  });

  it('exports nothing and says so when the export read fails', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    H.failPageFromCall = H.pageCalls.length + 1;
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'The deliveries could not be read for the export. Nothing was exported; try again.'));
    expect(H.exportToCSV).not.toHaveBeenCalled();
  });

  it('reads an export again when deliveries change between its pages, so it never mixes two moments', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    H.editDeliveriesAtCall = H.pageCalls.length + 2;
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    await waitFor(() => expect(H.exportToCSV).toHaveBeenCalledTimes(1));
    const exported = (H.exportToCSV.mock.calls[0][0] as Array<{ delivery_number: string }>).map((d) => d.delivery_number);
    // The first pass read DEL-0001 before it was cancelled and DEL-NEW after it was saved: it does not
    // add up to the total, so the export is read again and holds only the list as it now stands.
    expect(exported).not.toContain('DEL-0001');
    expect(exported).toContain('DEL-0500');
    expect(exported).toContain('DEL-NEW');
    expect(exported).toHaveLength(TOTAL);
    expect(new Set(exported).size).toBe(TOTAL);
  });

  it('reads an export twice and returns it only when both reads match, so a change that keeps the total is not missed', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    H.swapBehindReadAtCall = H.pageCalls.length + 2;
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    await waitFor(() => expect(H.exportToCSV).toHaveBeenCalledTimes(1));
    const exported = (H.exportToCSV.mock.calls[0][0] as Array<{ delivery_number: string }>).map((d) => d.delivery_number);
    // The first pass still held the cancelled DEL-0001 and missed DEL-SWAP, yet added up to the total.
    expect(exported).toContain('DEL-SWAP');
    expect(exported).not.toContain('DEL-0001');
    expect(exported).toHaveLength(TOTAL);
  });

  it('exports nothing and says so when deliveries keep changing during every read', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    H.growEveryPageCall = true;
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

  it('gives a driver every delivery of theirs, in pages of 500, with the stock-check warning', async () => {
    H.auth.role = 'driver';
    H.auth.profile = { id: 'driver-1', role: 'driver' };
    H.failTable = 'inventory';
    // Odd-numbered deliveries belong to driver-1, even ones to another driver.
    H.deliveries.forEach((d, i) => { d.assigned_driver = i % 2 ? 'driver-1' : 'driver-2'; });
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Stock shortage warnings could not be checked');
    expect(screen.getAllByText('DEL-1499').length).toBeGreaterThan(0);
    expect(screen.queryByText('DEL-1498')).not.toBeInTheDocument();
    expect(H.pageCalls.every((c) => c.p_limit === 500 && c.p_driver_id === 'driver-1')).toBe(true);
    // Two pages, read twice: a list read in more than one page is kept only when a second read matches it.
    expect(H.pageCalls.map((c) => c.p_after_id)).toEqual([FIRST_ID, 'del-0999', FIRST_ID, 'del-0999']);
  });
});

describe('Deliveries list pages by bookmark, so a removed delivery never skips one', () => {
  it('shows the same page two after a delivery on page one is removed', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    // Just before the page-two read, DEL-0001 (on page one) is cancelled and DEL-NEW is saved at the end.
    H.editDeliveriesAtCall = H.pageCalls.length + 1;
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(showing()).toHaveTextContent(`Page 2 · 50 shown of ${TOTAL}`));
    // Read by row count, page two would now start at DEL-0051 and DEL-0050 would never be shown.
    expect(screen.getByTestId('table-first')).toHaveTextContent('DEL-0050');
  });

  it('goes back to page one with Previous, read from the top again', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(showing()).toHaveTextContent('Page 2 · 50 shown'));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(showing()).toHaveTextContent(`Showing 1–50 of ${TOTAL}`));
    expect(screen.getByTestId('table-first')).toHaveTextContent('DEL-0000');
    expect(H.pageCalls[H.pageCalls.length - 1].p_after).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('greys out Next on the last page, where the database gives no next bookmark', async () => {
    H.deliveries = H.deliveries.slice(0, 75);
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(showing()).toHaveTextContent('Page 2 · 25 shown of 75'));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('starts again at page one, with no error, when the database refuses the bookmark', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    H.refuseBookmarks = true;
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(H.pageCalls[H.pageCalls.length - 1].p_after).toBeUndefined());
    await waitFor(() => expect(showing()).toHaveTextContent(`Showing 1–50 of ${TOTAL}`));
    expect(screen.getByTestId('table-first')).toHaveTextContent('DEL-0000');
    expect(H.toast).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('steps back a page when every delivery after the bookmark was removed', async () => {
    H.deliveries = H.deliveries.slice(0, 60);
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    // The last ten are cancelled before page two is read.
    H.deliveries = H.deliveries.slice(0, 50);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(H.pageCalls.some((c) => c.p_after)).toBe(true));
    await waitFor(() => expect(showing()).toHaveTextContent('Showing 1–50 of 50'));
    expect(screen.getByTestId('table-first')).toHaveTextContent('DEL-0000');
  });
});

describe('Deliveries list with no bookmark in the answer', () => {
  it('greys out Next instead of reading page one again', async () => {
    H.omitNextCursor = true;
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Scheduled Today');
    await waitFor(() => expect(showing()).toHaveTextContent(`Showing 1–50 of ${TOTAL}`));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
