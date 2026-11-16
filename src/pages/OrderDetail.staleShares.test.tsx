/**
 * The Who pays card when moving between sales: sale A's payers never show, or get deleted, under sale B (attack run on #1870).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

import OrderDetail from '../pages/OrderDetail';

// A query answered from what was asked, when it is awaited. Deletes are recorded with their filters.
function answerChain(table: string, answer: (calls: string[], eqs: unknown[][]) => { data: unknown; error: unknown; count?: number }): Record<string, unknown> {
  const calls: string[] = [];
  const eqs: unknown[][] = [];
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'maybeSingle', 'single']) {
    self[m] = (...args: unknown[]) => { calls.push(m); if (m === 'eq') eqs.push(args); return self; };
  }
  // Each read is answered for the order it asked about (its eq filter), not for whatever sale is on screen when it lands.
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => (table === 'order_shares' && !calls.includes('delete') && askedFor(eqs) === holdFor ? held : Promise.resolve()).then(() => {
    if (calls.includes('delete')) deletes.push([table, ...eqs]);
    return answer(calls, eqs);
  }).then(ok, bad);
  return self;
}

type Sale = { id: string; number: string; shares: unknown[]; items?: unknown[]; invoices?: unknown[]; status?: string; allocations?: unknown[] };
const share = (id: string, orderId: string, customerId: string, name: string, pct: number, createdAt = '2026-11-01T10:00:00Z') =>
  ({ id, order_id: orderId, customer_id: customerId, customer_name: name, split_percentage: pct, sort_order: 1, created_at: createdAt });

const saleA: Sale = { id: 'ord-a', number: 'ORD-0101', shares: [share('s-a', 'ord-a', 'cust-2', 'Cedar Ridge Ag', 35)] };
const saleB: Sale = { id: 'ord-b', number: 'ORD-0102', shares: [share('s-b', 'ord-b', 'cust-3', 'Birch Lane Co', 20)] };

let current: Sale = saleA;
let release: () => void = () => {};
let held: Promise<void> = Promise.resolve();
let holdFor: string | null = null; // the order whose order_shares read is held back
const sales = () => [saleA, saleB];
function askedFor(eqs: unknown[][]): string | undefined {
  return eqs.map((e) => e[1]).find((v): v is string => typeof v === 'string' && sales().some((sale) => sale.id === v));
}
function mockSale() {
  mockFrom.mockImplementation((table: string) => answerChain(table, (calls, eqs) => {
    const asked = askedFor(eqs);
    const sale = sales().find((x) => x.id === asked) ?? current;
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

describe('Who pays across sales', () => {
  beforeEach(() => { vi.clearAllMocks(); deletes.length = 0; holdFor = null; });

  it('while sale B is still loading its payers, the card under B shows none of sale A\'s payers and nothing is deleted', async () => {
    renderSale(saleA);
    expect(await screen.findByRole('button', { name: 'Remove Cedar Ridge Ag' })).toBeInTheDocument();
    held = new Promise<void>((r) => { release = r; });
    holdFor = saleB.id;
    await moveTo(saleB); // B's heading is on screen; its order_shares read has not answered yet
    const stale = screen.queryByRole('button', { name: 'Remove Cedar Ridge Ag' });
    const shownUnderB = !!stale;
    if (stale) {
      fireEvent.click(stale);
      fireEvent.click(await screen.findByRole('button', { name: 'Remove payer' }));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }
    release();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(shownUnderB).toBe(false);
    expect(deletes).toEqual([]);
  });
  it('a Remove reached in the gap and confirmed after B has loaded deletes nothing of sale A', async () => {
    renderSale(saleA);
    expect(await screen.findByRole('button', { name: 'Remove Cedar Ridge Ag' })).toBeInTheDocument();
    held = new Promise<void>((r) => { release = r; });
    holdFor = saleB.id;
    await moveTo(saleB);
    const stale = screen.queryByRole('button', { name: 'Remove Cedar Ridge Ag' });
    if (stale) fireEvent.click(stale);
    release();
    expect(await screen.findByRole('button', { name: 'Remove Birch Lane Co' })).toBeInTheDocument();
    const confirm = screen.queryByRole('button', { name: 'Remove payer' });
    if (confirm) { fireEvent.click(confirm); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); }
    expect(deletes).toEqual([]);
  });

  it("a late reply for sale A, landing after sale B has loaded, never puts A's payers on B", async () => {
    held = new Promise<void>((r) => { release = r; });
    holdFor = saleA.id; // A's payers read is still out when the user moves to B
    renderSale(saleA);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); // A's load is waiting on its payers
    holdFor = null;
    await moveTo(saleB);
    expect(await screen.findByRole('button', { name: 'Remove Birch Lane Co' })).toBeInTheDocument();
    release(); // A's reply arrives now
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByRole('button', { name: 'Remove Birch Lane Co' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Cedar Ridge Ag' })).not.toBeInTheDocument();
  });

  it('a Remove confirm left open for a payer that is no longer on the sale deletes nothing', async () => {
    renderSale(saleA);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Cedar Ridge Ag' }));
    expect(await screen.findByRole('button', { name: 'Remove payer' })).toBeInTheDocument();
    saleA.shares = []; // e.g. removed in another tab; the next read no longer has it
    await moveTo(saleB);
    const confirm = screen.queryByRole('button', { name: 'Remove payer' });
    if (confirm) { fireEvent.click(confirm); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); }
    expect(deletes).toEqual([]);
    saleA.shares = [share('s-a', 'ord-a', 'cust-2', 'Cedar Ridge Ag', 35)];
  });
});
