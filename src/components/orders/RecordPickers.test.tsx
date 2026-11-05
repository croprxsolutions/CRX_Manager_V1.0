import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OrderSearchPicker from './OrderSearchPicker';
import JobSearchPicker from '../jobs/JobSearchPicker';
import PurchaseOrderSearchPicker from '../purchase-orders/PurchaseOrderSearchPicker';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
  withAdminCosts: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/costFields', () => ({
  PURCHASE_ORDER_COLUMNS: 'id, po_number, vendor, status',
  withAdminCosts: mocks.withAdminCosts,
}));

type Call = [string, ...unknown[]];
// Each table's query records its calls; `limit` resolves the table's next result.
let calls: Record<string, Call[]>;
let results: Record<string, Array<{ data: unknown; error: unknown }>>;

beforeEach(() => {
  vi.clearAllMocks();
  calls = {};
  results = {};
  mocks.from.mockImplementation((table: string) => {
    const log = (calls[table] ??= []);
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'or', 'eq', 'in', 'is', 'not', 'order']) {
      builder[m] = (...args: unknown[]) => { log.push([m, ...args]); return builder; };
    }
    builder.limit = (n: number) => {
      log.push(['limit', n]);
      return Promise.resolve(results[table]?.shift() ?? { data: [], error: null });
    };
    return builder;
  });
  mocks.withAdminCosts.mockImplementation(async (_t: string, rows: unknown[], isAdmin: boolean) =>
    isAdmin ? rows.map((r) => ({ ...(r as object), total_cost: 1234.5 })) : rows);
});

function type(name: string, value: string) {
  const input = screen.getByRole('combobox', { name });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
}

describe('OrderSearchPicker', () => {
  // KI-32: the name match ran on the first 50 matching customers only. Each search is now two
  // reads (number, then customer name through an inner join); `results.orders` answers them in that order.
  it('finds an order by any matching customer name, in the old statuses only', async () => {
    results.orders = [
      { data: [], error: null },
      { data: [{ id: 'o-1099', order_number: 'SEED-ORD-1099', customer_id: 'c-7', status: 'confirmed', customer: { farm_name: 'Seed Farm, North' } }], error: null },
    ];
    const onSelect = vi.fn();
    render(<OrderSearchPicker value="" selectedLabel="" onSelect={onSelect} statuses={['confirmed', 'partially_fulfilled']} customerId="c-7" ariaLabel="Order" />);
    type('Order', 'Farm, North');
    fireEvent.click(await screen.findByRole('option', { name: /SEED-ORD-1099 - Seed Farm, North/ }));
    // No separate customer lookup, so no cap on how many customers can match.
    expect(calls.customers).toBeUndefined();
    expect(calls.orders).toEqual(expect.arrayContaining([
      ['or', 'order_number.ilike."%Farm, North%"'],
      ['select', expect.stringContaining('customer:customers!inner(farm_name)')],
      ['or', 'farm_name.ilike."%Farm, North%"', { referencedTable: 'customer' }],
      ['in', 'status', ['confirmed', 'partially_fulfilled']],
      ['is', 'deleted_at', null],
      ['eq', 'customer_id', 'c-7'],
      ['limit', 20],
    ]));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'o-1099' }));
  });

  it('merges the two reads newest first and lists an order matching both once', async () => {
    const older = { id: 'o-a', order_number: 'ORD-A', customer_id: 'c', status: 'confirmed', order_date: '2026-01-01', customer: { farm_name: 'ORD Farm' } };
    const newer = { id: 'o-b', order_number: 'X-B', customer_id: 'c', status: 'confirmed', order_date: '2026-03-01', customer: { farm_name: 'ORD Farm' } };
    results.orders = [{ data: [older], error: null }, { data: [newer, older], error: null }];
    render(<OrderSearchPicker value="" selectedLabel="" onSelect={vi.fn()} statuses={['confirmed']} ariaLabel="Order" />);
    type('Order', 'ORD');
    await screen.findByRole('option', { name: /X-B/ });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('X-B'),
      expect.stringContaining('ORD-A'),
    ]);
  });

  it('shows a failed customer-name read as a failed search with Retry, never as no matches', async () => {
    results.orders = [
      { data: [], error: null },
      { data: null, error: { message: 'down' } },
      { data: [{ id: 'o-1', order_number: 'ORD-1', customer_id: 'c', status: 'confirmed' }], error: null },
      { data: [], error: null },
    ];
    render(<OrderSearchPicker value="" selectedLabel="" onSelect={vi.fn()} statuses={['confirmed']} ariaLabel="Order" />);
    type('Order', 'ORD-1');
    expect(await screen.findByText('Order search failed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /ORD-1/ })).toBeInTheDocument();
  });
});

describe('JobSearchPicker', () => {
  it('keeps the status filter and never offers a deleted job', async () => {
    results.jobs = [{ data: [{ id: 'j-250', job_number: 'SEED-JOB-0250', job_date: '2026-02-13', status: 'completed', customer: { farm_name: 'Seed Farm 0250' } }], error: null }];
    const onSelect = vi.fn();
    render(<JobSearchPicker value="" selectedLabel="" onSelect={onSelect} statuses={['completed']} ariaLabel="Source job" />);
    type('Source job', '0250');
    fireEvent.click(await screen.findByRole('option', { name: /SEED-JOB-0250 \(2026-02-13\) - Seed Farm 0250/ }));
    expect(calls.jobs).toEqual(expect.arrayContaining([
      ['in', 'status', ['completed']],
      ['is', 'deleted_at', null],
    ]));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'j-250' }));
  });

  it("offers only the given customer's jobs and searches again when the customer changes", async () => {
    results.jobs = [{ data: [], error: null }, { data: [], error: null }];
    const { rerender } = render(<JobSearchPicker value="" selectedLabel="" onSelect={vi.fn()} customerId="c-250" ariaLabel="Link to Job" />);
    type('Link to Job', 'SEED-JOB');
    expect(await screen.findByText('No matching jobs')).toBeInTheDocument();
    expect(calls.jobs).toContainEqual(['eq', 'customer_id', 'c-250']);
    rerender(<JobSearchPicker value="" selectedLabel="" onSelect={vi.fn()} customerId="c-1" ariaLabel="Link to Job" />);
    await screen.findByText('No matching jobs');
    await vi.waitFor(() => expect(calls.jobs).toContainEqual(['eq', 'customer_id', 'c-1']));
  });

  it('offers every status when none is given', async () => {
    results.jobs = [{ data: [], error: null }];
    render(<JobSearchPicker value="" selectedLabel="" onSelect={vi.fn()} ariaLabel="Link to Job" />);
    type('Link to Job', 'JOB');
    expect(await screen.findByText('No matching jobs')).toBeInTheDocument();
    expect(calls.jobs.some((c) => c[0] === 'in')).toBe(false);
  });
});

describe('PurchaseOrderSearchPicker', () => {
  it('searches PO number and vendor in the old statuses and gives an admin the PO total', async () => {
    results.purchase_orders = [{ data: [{ id: 'po-250', po_number: 'SEED-PO-0250', vendor: 'Seed Vendor', status: 'submitted' }], error: null }];
    const onSelect = vi.fn();
    render(<PurchaseOrderSearchPicker value="" selectedLabel="" onSelect={onSelect} statuses={['submitted', 'partially_received', 'fully_received']} isAdmin ariaLabel="PO" />);
    type('PO', 'PO-0250');
    fireEvent.click(await screen.findByRole('option', { name: /SEED-PO-0250 — Seed Vendor.*\$1,234\.50/ }));
    expect(calls.purchase_orders).toEqual(expect.arrayContaining([
      ['or', 'po_number.ilike."%PO-0250%",vendor.ilike."%PO-0250%"'],
      ['in', 'status', ['submitted', 'partially_received', 'fully_received']],
    ]));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'po-250', total_cost: 1234.5 }));
  });

  it('fails the search when an admin cost read fails, so no PO is picked without its total', async () => {
    results.purchase_orders = [{ data: [{ id: 'po-1', po_number: 'PO-1', vendor: 'V', status: 'submitted' }], error: null }];
    mocks.withAdminCosts.mockRejectedValueOnce(new Error('cost read failed'));
    render(<PurchaseOrderSearchPicker value="" selectedLabel="" onSelect={vi.fn()} statuses={['submitted']} isAdmin ariaLabel="PO" />);
    type('PO', 'PO-1');
    expect(await screen.findByText('Purchase order search failed.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
  });
});
