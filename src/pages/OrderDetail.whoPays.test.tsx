/**
 * The Who pays card and the invoice rows on the sale page: what survives moving between sales, and that the card's
 * amounts and the invoice rows' shares agree with what was billed (review of #1870).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

const { mockFrom, mockToast, deletes } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  deletes: [] as unknown[][],
}));

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => mockFrom(table === 'invoices_postable' ? 'invoices' : table),
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
  },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  describePostInvoiceBlock: vi.fn(() => null),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'k', resetKey: vi.fn(), getKeyFor: () => 'k', resetKeyFor: vi.fn() }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: vi.fn(), buildEmailHtml: vi.fn(() => '') }));
vi.mock('../lib/dateUtils', () => ({ parseLocalDate: vi.fn((d: string) => new Date(d)) }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
// The picker picks Cedar Ridge Ag in one click and shows what is picked.
vi.mock('../components/customers/CustomerSearchPicker', () => ({
  default: ({ onSelect, ariaLabel, selectedLabel }: { onSelect: (c: { id: string; farm_name: string }) => void; ariaLabel: string; selectedLabel?: string }) => (
    <>
      <button type="button" aria-label={ariaLabel} onClick={() => onSelect({ id: 'cust-2', farm_name: 'Cedar Ridge Ag' })}>{selectedLabel || 'pick'}</button>
      <button type="button" aria-label={`${ariaLabel} (no name)`} onClick={() => onSelect({ id: 'cust-8', farm_name: '' })}>pick nameless</button>
    </>
  ),
}));

import OrderDetail from './OrderDetail';

// A query answered from what was asked, when it is awaited. Deletes are recorded with their filters.
function answerChain(table: string, answer: (calls: string[]) => { data: unknown; error: unknown; count?: number }): Record<string, unknown> {
  const calls: string[] = [];
  const eqs: unknown[] = [];
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'maybeSingle', 'single']) {
    self[m] = (...args: unknown[]) => { calls.push(m); if (m === 'eq') eqs.push(args); return self; };
  }
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(() => {
    if (calls.includes('delete')) deletes.push([table, ...eqs]);
    return answer(calls);
  }).then(ok, bad);
  return self;
}

type Sale = { id: string; number: string; shares: unknown[]; items?: unknown[]; invoices?: unknown[]; status?: string; allocations?: unknown[] };
const share = (id: string, orderId: string, customerId: string, name: string, pct: number, createdAt = '2026-11-01T10:00:00Z') =>
  ({ id, order_id: orderId, customer_id: customerId, customer_name: name, split_percentage: pct, sort_order: 1, created_at: createdAt });

const saleA: Sale = { id: 'ord-a', number: 'ORD-0101', shares: [share('s-a', 'ord-a', 'cust-2', 'Cedar Ridge Ag', 35)] };
const saleB: Sale = { id: 'ord-b', number: 'ORD-0102', shares: [share('s-b', 'ord-b', 'cust-3', 'Birch Lane Co', 20)] };

let current: Sale = saleA;
function mockSale() {
  mockFrom.mockImplementation((table: string) => answerChain(table, (calls) => {
    const sale = current;
    if (table === 'orders') {
      return { data: { id: sale.id, order_number: sale.number, status: 'confirmed', customer_id: 'cust-1', row_version: 1,
        order_date: '2026-03-15', total_price: 1000, notes: '', created_at: '2026-03-15T00:00:00Z', ...(sale.status && { status: sale.status }) }, error: null };
    }
    if (table === 'customers' && calls.includes('maybeSingle')) return { data: { id: 'cust-1', farm_name: 'Maple Hollow Farms' }, error: null };
    if (table === 'order_shares') return { data: sale.shares, error: null };
    if (table === 'order_items') return { data: sale.items ?? [], error: null, count: (sale.items ?? []).length };
    if (table === 'invoices') return { data: sale.invoices ?? [], error: null };
    if (table === 'order_item_field_allocations') return { data: sale.allocations ?? [], error: null, count: (sale.allocations ?? []).length };
    return { data: [], error: null, count: 0 };
  }));
}

let go: (to: string) => void = () => {};
function GoTo() { const navigate = useNavigate(); useEffect(() => { go = navigate; }); return null; }
function renderSale(sale: Sale) {
  current = sale;
  mockSale();
  return render(
    <MemoryRouter initialEntries={[`/orders/${sale.id}`]}>
      <GoTo />
      <Routes><Route path="/orders/:id" element={<OrderDetail />} /></Routes>
    </MemoryRouter>,
  );
}
async function moveTo(sale: Sale) {
  current = sale;
  act(() => go(`/orders/${sale.id}`));
  expect(await screen.findByRole('heading', { level: 1, name: sale.number })).toBeInTheDocument();
}
const whoPays = () => screen.getByRole('region', { name: 'Who pays' });

describe('Who pays across sales', () => {
  beforeEach(() => { vi.clearAllMocks(); deletes.length = 0; });

  it('a Remove dialog opened on one sale closes when the page moves to the next, so it cannot delete the first sale\'s payer', async () => {
    renderSale(saleA);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Cedar Ridge Ag' }));
    expect(screen.getByRole('dialog', { name: 'Remove Cedar Ridge Ag?' })).toBeInTheDocument();
    await moveTo(saleB);
    expect(await screen.findByRole('button', { name: 'Remove Birch Lane Co' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove payer' })).not.toBeInTheDocument();
    expect(deletes).toEqual([]);
  });

  it('Cancel drops the picked customer: reopening the form starts with no one picked', async () => {
    renderSale(saleA);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a payer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bill split customer' }));
    expect(screen.getByRole('button', { name: 'Bill split customer' })).toHaveTextContent('Cedar Ridge Ag');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    expect(screen.getByRole('button', { name: 'Bill split customer' })).toHaveTextContent('pick');
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '10' } });
    expect(screen.getByRole('button', { name: 'Add payer' })).toBeDisabled();
  });

  it('a customer picked on one sale is not offered on the next', async () => {
    renderSale(saleA);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a payer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bill split customer' }));
    await moveTo(saleB);
    fireEvent.click(await within(whoPays()).findByRole('button', { name: 'Add a payer' }));
    expect(screen.getByRole('button', { name: 'Bill split customer' })).toHaveTextContent('pick');
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '10' } });
    expect(screen.getByRole('button', { name: 'Add payer' })).toBeDisabled();
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
  });
});

describe('Who pays and the invoice rows agree with the bill', () => {
  beforeEach(() => { vi.clearAllMocks(); deletes.length = 0; });

  const line = (id: string, total: number) => ({ id, order_id: 'ord-a', product_name: `Product ${id}`, total_units_needed: 1,
    quantity_delivered: 0, price_per_unit: total, total_price: total, section_name: null });
  const draft = (id: string, customerId: string, cents: number, createdAt = '2026-11-02T10:00:00Z') => ({
    id, order_id: 'ord-a', invoice_number: `CS-${id}`, invoice_type: 'chemical_sale', status: 'draft', customer_id: customerId,
    invoice_group_id: 'grp-1', deleted_at: null, total_amount_cents: cents, paid_amount_cents: 0, prepay_applied_cents: 0,
    balance_cents: cents, write_off_cents: 0, created_at: createdAt, invoice_post_version: `v1:${id}`,
  });
  const payerRow = (name: string) => within(whoPays()).getByText(name).closest('[data-payer]') as HTMLElement;

  it('each payer\'s amount is billed line by line: floor(cents x percent) per line, the main customer the rest', async () => {
    // 33.33% of 10c, 20c and 5c floors to 3c, 6c and 1c: 10c line by line. The whole 35c split at once would give 11c.
    renderSale({ ...saleA, shares: [share('s-a', 'ord-a', 'cust-2', 'Cedar Ridge Ag', 33.33)], items: [line('l1', 0.1), line('l2', 0.2), line('l3', 0.05)] });
    expect(await within(await screen.findByRole('region', { name: 'Who pays' })).findByText('about $0.10 of products')).toBeInTheDocument();
    expect(within(payerRow('Maple Hollow Farms')).getByText('Main customer · about $0.25 of products')).toBeInTheDocument();
  });

  it('a share the main customer holds folds into the main row: one row, one count', async () => {
    renderSale({ ...saleA, shares: [share('s-own', 'ord-a', 'cust-1', 'Maple Hollow Farms', 30), share('s-a', 'ord-a', 'cust-2', 'Cedar Ridge Ag', 40)],
      items: [line('l1', 100)] });
    expect(await screen.findByText('2 payers · 100%')).toBeInTheDocument();
    expect(within(whoPays()).getAllByText('Maple Hollow Farms')).toHaveLength(1);
    expect(within(payerRow('Maple Hollow Farms')).getByText('60%')).toBeInTheDocument();
    expect(within(payerRow('Maple Hollow Farms')).getByText('Main customer · about $60.00 of products')).toBeInTheDocument();
    expect(within(payerRow('Cedar Ridge Ag')).getByText('about $40.00 of products')).toBeInTheDocument();
  });

  it('a split draft shows the card\'s share while the card is the one it was billed at', async () => {
    renderSale({ ...saleA, invoices: [draft('1', 'cust-1', 6500), draft('2', 'cust-2', 3500)] });
    expect(await screen.findByText('Maple Hollow Farms · 65%')).toBeInTheDocument();
    expect(screen.getByText('Cedar Ridge Ag · 35%')).toBeInTheDocument();
  });

  it('a split draft hides the share once a payer was added after it was billed', async () => {
    renderSale({ ...saleA, shares: [share('s-a', 'ord-a', 'cust-2', 'Cedar Ridge Ag', 50, '2026-11-03T10:00:00Z')],
      invoices: [draft('1', 'cust-1', 6000), draft('2', 'cust-2', 4000)] });
    expect(within(await screen.findByRole('link', { name: /CS-1/ })).getByText('Maple Hollow Farms')).toBeInTheDocument();
    expect(screen.queryByText(/Maple Hollow Farms · \d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cedar Ridge Ag · \d/)).not.toBeInTheDocument();
  });

  it('a split draft for a payer no longer on the card hides the shares instead of showing 0%', async () => {
    renderSale({ ...saleA, invoices: [draft('1', 'cust-1', 5000), draft('2', 'cust-2', 3500), { ...draft('3', 'cust-9', 1500), customer_id: 'cust-9' }] });
    expect(await screen.findByText('CS-3')).toBeInTheDocument();
    expect(screen.queryByText(/· 0%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/· 65%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/· 35%/)).not.toBeInTheDocument();
  });
});

describe('The sale page notes say what is true', () => {
  beforeEach(() => { vi.clearAllMocks(); deletes.length = 0; });

  it('one paid invoice reads "1 invoice, paid", not posted', async () => {
    renderSale({ ...saleA, shares: [], invoices: [{ id: 'i1', order_id: 'ord-a', invoice_number: 'CS-1', invoice_type: 'chemical_sale', status: 'paid',
      customer_id: 'cust-1', invoice_group_id: null, deleted_at: null, total_amount_cents: 1000, paid_amount_cents: 1000, prepay_applied_cents: 0,
      balance_cents: 0, write_off_cents: 0, created_at: '2026-11-02T10:00:00Z' }] });
    expect(await screen.findByText('1 invoice, paid')).toBeInTheDocument();
  });

  it('a delivered sale split by field with no invoices points to Create split invoices', async () => {
    renderSale({ ...saleA, shares: [], status: 'fulfilled', items: [{ id: 'l1', order_id: 'ord-a', product_name: 'Product l1', total_units_needed: 1,
      quantity_delivered: 1, price_per_unit: 10, total_price: 10, section_name: null }],
    allocations: [{ id: 'a1', order_item_id: 'l1', field_id: 'f1', acres: 10, created_at: '2026-11-01T10:00:00Z' }] });
    expect(await screen.findByRole('button', { name: /Create split invoices/ })).toBeInTheDocument();
    expect(screen.getByText('No invoices yet. This sale is split by field, so bill it with Create split invoices.')).toBeInTheDocument();
  });

  it('a payer whose customer has no farm name is refused with a reason, not silently', async () => {
    renderSale({ ...saleA, shares: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a payer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bill split customer (no name)' }));
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add payer' }));
    await vi.waitFor(() => expect(mockToast).toHaveBeenCalledWith('error',
      'That customer has no farm name, so it cannot be added as a payer. Add the name on the customer first.'));
  });
});
