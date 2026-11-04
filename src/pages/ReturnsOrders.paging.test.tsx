/**
 * ReturnsOrders.paging.test.tsx — Goal 4 part 2b (N10): a new return offers every returnable
 * order of the chosen customer.
 *
 * The "Original Order" picker read the customer's orders in one request, which the server
 * silently stops at 1,000 rows, so a customer's oldest orders could not be picked. A failed
 * read showed an empty picker as if the customer had no orders. The fake server caps every
 * reply at 1,000 rows like the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildInMemoryQuery, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  // A table whose reads wait until this promise settles.
  held: {} as Partial<Record<string, Promise<void>>>,
  toast: vi.fn(),
}));

// Delays an in-memory query's answer until the table's hold is released.
function heldQuery(q: Record<string, unknown>, gate: Promise<void>): Record<string, unknown> {
  return new Proxy(q, {
    get(target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          gate.then(() => (target.then as (a: unknown, b: unknown) => unknown).call(target, resolve, reject));
      }
      const value = target[prop as string];
      return typeof value === 'function' ? (...args: unknown[]) => heldQuery(value.apply(target, args), gate) : value;
    },
  });
}

// A query whose every method chains and whose answer is a read error.
function failingQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'connection reset' }, count: null });
      }
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (H.failing.has(table) ? failingQuery()
        : H.held[table] ? heldQuery(buildInMemoryQuery(H.tables[table] ?? []) as unknown as Record<string, unknown>, H.held[table])
        : buildInMemoryQuery(H.tables[table] ?? [])),
      // The Returns screen's read-only lookups (20261021155000) answer with empty lists here.
      rpc: vi.fn(async (name: string) => ({
        data: name === 'get_split_payer_return_orders' || name === 'get_return_line_allowances' ? [] : null,
        error: null,
      })),
    },
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'actor-1' }, role: 'admin' }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/reportPdf', () => ({ downloadReportPdf: vi.fn() }));

import { MemoryRouter } from 'react-router-dom';
import Returns from './Returns';

const TOTAL = SERVER_ROW_CAP + 5;
vi.setConfig({ testTimeout: 120_000 });
configure({ asyncUtilTimeout: 30_000 });
const pad = (i: number) => String(i).padStart(4, '0');

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Set();
  H.held = {};
  H.tables = {
    customers: [{ id: 'customer-1', farm_name: 'Big Farm', assigned_tier: null, is_active: true }],
    // Newest first, the order the picker asks the server for. A draft, a deleted order and
    // another customer's order must not be offered.
    orders: [
      ...Array.from({ length: TOTAL }, (_, i) => ({
        id: `order-${pad(i)}`, order_number: `ORD-${pad(i)}`, customer_id: 'customer-1',
        order_date: '2026-08-01', status: 'fulfilled', deleted_at: null,
      })),
      { id: 'draft', order_number: 'ORD-DRAFT', customer_id: 'customer-1', order_date: '2026-08-01', status: 'draft', deleted_at: null },
      { id: 'gone', order_number: 'ORD-GONE', customer_id: 'customer-1', order_date: '2026-08-01', status: 'fulfilled', deleted_at: '2026-09-01' },
      { id: 'other', order_number: 'ORD-OTHER', customer_id: 'customer-2', order_date: '2026-08-01', status: 'fulfilled', deleted_at: null },
    ],
  };
});
afterEach(cleanup);

async function pickCustomer() {
  render(<MemoryRouter><Returns /></MemoryRouter>);
  await screen.findByText('No returns yet');
  fireEvent.click(screen.getAllByRole('button', { name: 'New Return' })[0]);
  const dialog = await screen.findByRole('dialog', { name: 'New Return / RMA' });
  const customer = within(dialog).getByLabelText('Customer');
  await waitFor(() => expect(customer.querySelectorAll('option')).toHaveLength(2));
  fireEvent.change(customer, { target: { value: 'customer-1' } });
  return within(dialog).getByLabelText('Original Order');
}

describe('new return order picker past the 1,000-row server cap (N10)', () => {
  it("offers all 1,005 of the customer's returnable orders", async () => {
    const picker = await pickCustomer();
    // "Select Order" plus every order; a read stopped at 1,000 offers 1,000.
    await waitFor(() => expect(picker.querySelectorAll('option')).toHaveLength(TOTAL + 1));
    const offered = [...picker.querySelectorAll('option')].slice(1).map((o) => o.getAttribute('value'));
    expect(offered).toEqual(Array.from({ length: TOTAL }, (_, i) => `order-${pad(i)}`));
    expect(H.toast).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('a failed read says the orders could not be loaded', async () => {
    H.failing.add('orders');
    const picker = await pickCustomer();
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', "This customer's orders could not be loaded. Pick the customer again to retry."));
    expect(picker.querySelectorAll('option')).toHaveLength(1);
  });
});

describe('Return product from a delivery', () => {
  it("opens New Return with the delivery's customer and order already picked", async () => {
    render(<MemoryRouter initialEntries={['/returns?customer=customer-1&order=order-0003']}><Returns /></MemoryRouter>);
    const dialog = await screen.findByRole('dialog', { name: 'New Return / RMA' });
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>('Customer').value).toBe('customer-1'));
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>('Original Order').value).toBe('order-0003'));
  });

  it('clears the pre-filled customer, without calling it inactive, when the customer list failed to load', async () => {
    H.failing.add('customers');
    render(<MemoryRouter initialEntries={['/returns?customer=customer-1&order=order-0003']}><Returns /></MemoryRouter>);
    const dialog = await screen.findByRole('dialog', { name: 'New Return / RMA' });
    // Nothing proves the customer active, and create_return does not check, so the pre-fill must not stay.
    await waitFor(() => expect(within(dialog).getByLabelText<HTMLSelectElement>('Customer').value).toBe(''));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load customers. Close the form and try again.'));
    await new Promise((r) => setTimeout(r, 50));
    expect(H.toast).not.toHaveBeenCalledWith('error', expect.stringContaining('inactive'));
  });

  it('a late inactive-customer check leaves a customer changed since alone', async () => {
    let release = () => {};
    H.held.customers = new Promise<void>((r) => { release = r; });
    render(<MemoryRouter initialEntries={['/returns?customer=gone-customer&order=order-0003']}><Returns /></MemoryRouter>);
    const dialog = await screen.findByRole('dialog', { name: 'New Return / RMA' });
    fireEvent.change(within(dialog).getByLabelText('Customer'), { target: { value: '' } });
    release();
    const customer = within(dialog).getByLabelText<HTMLSelectElement>('Customer');
    await waitFor(() => expect(customer.querySelectorAll('option')).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(H.toast).not.toHaveBeenCalledWith('error', expect.stringContaining('inactive'));
  });

  it('a late inactive-customer check after the form was closed shows nothing', async () => {
    let release = () => {};
    H.held.customers = new Promise<void>((r) => { release = r; });
    render(<MemoryRouter initialEntries={['/returns?customer=gone-customer&order=order-0003']}><Returns /></MemoryRouter>);
    const dialog = await screen.findByRole('dialog', { name: 'New Return / RMA' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(H.toast).not.toHaveBeenCalledWith('error', expect.stringContaining('inactive'));
  });

  it("an older form's late customer read leaves a newer form's customer list alone", async () => {
    let release = () => {};
    H.held.customers = new Promise<void>((r) => { release = r; });
    render(<MemoryRouter initialEntries={['/returns?customer=customer-1&order=order-0003']}><Returns /></MemoryRouter>);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'New Return / RMA' })).getByRole('button', { name: 'Cancel' }));
    H.held = {};
    H.tables.customers = [...H.tables.customers, { id: 'customer-2', farm_name: 'Other Farm', assigned_tier: null, is_active: true }];
    fireEvent.click(screen.getAllByRole('button', { name: 'New Return' })[0]);
    const customer = within(await screen.findByRole('dialog', { name: 'New Return / RMA' })).getByLabelText('Customer');
    await waitFor(() => expect(customer.querySelectorAll('option')).toHaveLength(3));
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(customer.querySelectorAll('option')).toHaveLength(3);
  });

  it('keeps a pre-filled return unsubmittable until the active-customer check settles', async () => {
    let release = () => {};
    H.held.customers = new Promise<void>((r) => { release = r; });
    render(<MemoryRouter initialEntries={['/returns?customer=customer-1&order=order-0003']}><Returns /></MemoryRouter>);
    const create = within(await screen.findByRole('dialog', { name: 'New Return / RMA' })).getByRole('button', { name: 'Create Return' });
    expect(create).toBeDisabled();
    release();
    await waitFor(() => expect(create).toBeEnabled());
  });
});
