/**
 * Invoices.batchPrint.test.tsx — To-Do 10.5 follow-up: Print Selected on the Chemical Sales
 * list must not print an invoice whose customer address or shares could not be read. It used to
 * log the failed customer read and print a blank address block, and ignored a failed shares read
 * (a split invoice printed with no share breakdown).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type FailMode = 'error' | 'nodata' | 'notlist' | 'throws';

const H = vi.hoisted(() => ({
  tables: {} as Record<string, unknown>,
  failing: new Map<string, FailMode>(),
  toast: vi.fn(),
  printed: vi.fn(),
  dialogProps: {} as Record<string, unknown>,
  closedRenders: 0,
}));

function replyFor(table: string): { data: unknown; error: unknown; count: number | null } {
  const rows = H.tables[table] ?? [];
  const mode = H.failing.get(table);
  if (mode === 'error') return { data: null, error: { message: 'connection reset', code: 'XX000' }, count: null };
  if (mode === 'nodata') return { data: null, error: null, count: null };
  if (mode === 'notlist') return { data: { unexpected: true }, error: null, count: null };
  return { data: rows, error: null, count: Array.isArray(rows) ? rows.length : 1 };
}

// A query that ignores its filters and answers with the table's rows (or its failure).
function query(table: string): Record<string, unknown> {
  const reply = replyFor(table);
  const throws = H.failing.get(table) === 'throws';
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          (throws ? reject(new Error('socket hang up')) : resolve(reply));
      }
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  // get_bill_split_payers answers with every invoice in the selected invoice's group, as the database does.
  const rpc = (fn: string, args: { p_invoice_id?: string }) => {
    if (fn !== 'get_bill_split_payers') return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
    const all = (H.tables.invoices as Array<Record<string, unknown>>) ?? [];
    const group = all.find((i) => i.id === args.p_invoice_id)?.invoice_group_id;
    const rows = all.filter((i) => group && i.invoice_group_id === group).map((i) => ({ id: i.id, invoice_number: i.invoice_number,
      total_amount_cents: i.total_amount_cents, farm_name: (i.customer as { farm_name?: string } | null)?.farm_name ?? null }));
    return Promise.resolve({ data: rows, error: null, count: rows.length });
  };
  const client = { from: (table: string) => query(table === 'invoices_postable' ? 'invoices' : table), rpc };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
// The real build and guards; only the PDF output is recorded instead of downloaded.
vi.mock('../lib/invoicePdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/invoicePdf')>()),
  generateBatchInvoicePdf: async (list: unknown[]) => { H.printed(list); return { doc: {}, failures: [] }; },
}));
vi.mock('../components/invoices/InvoicePrintDialog', () => ({
  default: (props: { open: boolean; onPrint: (options: Record<string, never>) => void }) => {
    if (props.open) H.dialogProps = props; else H.closedRenders += 1;
    return props.open ? <button type="button" onClick={() => props.onPrint({})}>Print with defaults</button> : null;
  },
}));

import Invoices from './Invoices';

const posted = {
  id: 'inv-1', invoice_number: 'CS-1001', invoice_post_version: 'v1:inv-1', invoice_type: 'chemical_sale',
  status: 'posted', season: 2027, invoice_date: '2026-10-05', created_at: '2026-10-05T15:00:00+00:00',
  customer_id: 'cust-1', customer: { farm_name: 'Test Farm' }, salesman_id: null, order_id: null,
  deleted_at: null, total_amount_cents: 10000, balance_cents: 10000, is_quick_delivery: false,
};
const line = { id: 'it-1', invoice_id: 'inv-1', description: 'Herbicide', quantity: 1, unit_price_cents: 10000, extended_cents: 10000, sort_order: 0 };

async function printSelected() {
  render(<MemoryRouter><Invoices /></MemoryRouter>);
  expect(await screen.findByText('CS-1001')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('checkbox')[0]);
  fireEvent.click(await screen.findByRole('button', { name: /^Print 1 Selected/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Print with defaults' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T12:00:00'));
  H.failing = new Map();
  H.closedRenders = 0;
  H.tables = {
    invoices: [posted],
    invoice_items: [line],
    invoice_shares: [],
    customers: { billing_address: '9 Barn Rd', city: 'Town', state: 'IL', zip: '62000', account_number: 'A-9', payment_terms: 'Net 30' },
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Invoices — Print Selected', () => {
  it('prints with the customer address when every read works', async () => {
    await printSelected();
    await waitFor(() => expect(H.printed).toHaveBeenCalledTimes(1));
    expect(H.printed.mock.calls[0][0][0]).toMatchObject({ invoice_number: 'CS-1001', customer_address: '9 Barn Rd' });
  });

  it("prints a Bill Split payer's invoice with the sale's payer table, as its own page does", async () => {
    const split = { ...posted, invoice_group_id: 'g1', delivery_id: 'd1', customer: { farm_name: 'Farmer' } };
    H.tables.invoices = [
      { ...split, invoice_number: 'CS-1001-1', total_amount_cents: 6000 },
      { ...split, id: 'inv-2', invoice_number: 'CS-1001-2', total_amount_cents: 4000, customer: { farm_name: 'Landlord' } },
    ];
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    expect(await screen.findByText('CS-1001-1')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(await screen.findByRole('button', { name: /^Print 1 Selected/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Print with defaults' }));
    await waitFor(() => expect(H.printed).toHaveBeenCalledTimes(1));
    // Mason, 9 Nov (A): every payer's invoice shows every payer, so batch print ticks the table by default.
    expect(H.dialogProps).toMatchObject({ hasShares: true, sharesOnByDefault: true });
    // Mounted only when opened, so its ticked-by-default state is set from this selection, not the empty first load.
    expect(H.closedRenders).toBe(0);
    expect(H.printed.mock.calls[0][0][0].shares).toMatchObject([
      { invoice_number: 'CS-1001-1', customer_name: 'Farmer', split_percentage: 60, amount_cents: 6000 },
      { invoice_number: 'CS-1001-2', customer_name: 'Landlord', split_percentage: 40, amount_cents: 4000 },
    ]);
  });

  it('passes the stored Bill Split identity through the invoices-list print builder', async () => {
    const split = { ...posted, invoice_group_id: 'stored-group', delivery_id: 'stored-delivery' };
    H.tables.invoices = [split];
    H.tables.invoice_items = [{ ...line, brand_lines: [{ brand_key: 'a', brand_name: 'Alpha', epa_registration: '1-1', quantity: 5, line_delivered: 5, delivery_item_id: 'trip-1' }] }];
    await printSelected();
    await waitFor(() => expect(H.printed).toHaveBeenCalledTimes(1));
    const printed = H.printed.mock.calls[0][0][0];
    expect(printed.bill_split_on_load).toBe(true);
    expect(printed.items[0].brand_lines[0]).toMatchObject({ brand_name: 'Alpha', quantity: 5 });
  });

  it("a payer's misc charge invoice in a Bill Split is printed with the payer table on too", async () => {
    const split = { ...posted, invoice_type: 'misc_charge', invoice_group_id: 'g1', delivery_id: 'd1', customer: { farm_name: 'Farmer' } };
    H.tables.invoices = [
      { ...split, invoice_number: 'CS-1001-1', total_amount_cents: 6000 },
      { ...split, id: 'inv-2', invoice_number: 'CS-1001-2', total_amount_cents: 4000, customer: { farm_name: 'Landlord' } },
    ];
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    expect(await screen.findByText('CS-1001-1')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(await screen.findByRole('button', { name: /^Print 1 Selected/ }));
    await screen.findByRole('button', { name: 'Print with defaults' });
    expect(H.dialogProps).toMatchObject({ hasShares: true, sharesOnByDefault: true });
  });

  const cases: Array<[string, FailMode]> = [
    ['customers', 'error'], ['customers', 'nodata'], ['customers', 'throws'],
    ['invoice_shares', 'error'], ['invoice_shares', 'nodata'], ['invoice_shares', 'notlist'], ['invoice_shares', 'throws'],
  ];
  for (const [table, mode] of cases) {
    it(`prints nothing and says so when the ${table} read ${mode === 'nodata' ? 'returns nothing' : mode}`, async () => {
      // Set after the list has loaded, so only the print's own reads fail.
      render(<MemoryRouter><Invoices /></MemoryRouter>);
      expect(await screen.findByText('CS-1001')).toBeInTheDocument();
      H.failing.set(table, mode);
      fireEvent.click(screen.getAllByRole('checkbox')[0]);
      fireEvent.click(await screen.findByRole('button', { name: /^Print 1 Selected/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Print with defaults' }));
      await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Could not load the invoice details')));
      expect(H.printed).not.toHaveBeenCalled();
    });
  }
});
