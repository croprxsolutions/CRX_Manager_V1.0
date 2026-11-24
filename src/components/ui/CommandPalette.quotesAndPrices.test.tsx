import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The quick search finds quotes (by number or customer name, through the quotes table so the
// database's access rules apply) and shows office staff each product's tier 1 price.

const { mockNavigate, mockRpc, mockFrom, auth } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  auth: { current: { role: 'sales_rep' as string, deniedPages: [] as string[] } },
}));

vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => mockNavigate,
}));
vi.mock('../../lib/db', () => ({
  supabase: { rpc: mockRpc, from: mockFrom },
  assertRpcResult: (data: unknown) => data,
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ role: auth.current.role, deniedPages: auth.current.deniedPages, loading: false }),
}));

import CommandPalette from './CommandPalette';

type Reply = { data: unknown; error: unknown };

/** A chain that records its filters and answers with `reply(filters)`. */
function chain(table: string, reply: (table: string, calls: string[][]) => Reply) {
  const calls: string[][] = [];
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'or', 'is', 'order', 'limit', 'in', 'eq']) {
    self[m] = (...args: unknown[]) => { calls.push([m, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))]); return self; };
  }
  self.then = (resolve: (r: Reply) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply(table, calls)).then(resolve, reject);
  return self;
}

const QUOTE_BY_NUMBER = { id: 'q1', quote_number: 'Q-1042', status: 'sent', created_at: '2026-11-02T00:00:00Z', customer: { farm_name: 'Hill Farms' } };
const QUOTE_BY_NAME = { id: 'q2', quote_number: 'Q-0999', status: 'closed_short', created_at: '2026-10-01T00:00:00Z', customer: { farm_name: 'Q Ranch' } };

function tables(table: string, calls: string[][]): Reply {
  if (table === 'quotes') {
    const byCustomer = calls.some(([m, , opts]) => m === 'or' && opts?.includes('customer'));
    return { data: byCustomer ? [QUOTE_BY_NAME] : [QUOTE_BY_NUMBER], error: null };
  }
  if (table === 'products') return { data: [{ id: 'prod-1', tier1_price: 42.5 }], error: null };
  return { data: [], error: null };
}

function renderAndSearch(text: string) {
  render(<MemoryRouter><CommandPalette open onClose={vi.fn()} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: text } });
}

describe('CommandPalette quotes and prices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    auth.current = { role: 'sales_rep', deniedPages: [] };
    mockFrom.mockImplementation((table: string) => chain(table, tables));
    mockRpc.mockResolvedValue({
      data: [
        { entity_type: 'product', id: 'prod-1', primary_text: 'Roundup PowerMax', secondary_text: 'Herbicide' },
        { entity_type: 'customer', id: 'cust-1', primary_text: 'Hill Farms', secondary_text: 'Robinson' },
      ],
      error: null,
    });
  });

  it('lists matching quotes, newest first, and opens the quote', async () => {
    renderAndSearch('q-1');
    expect(await screen.findByText('Quote Q-1042')).toBeInTheDocument();
    expect(screen.getByText('Hill Farms · sent')).toBeInTheDocument();
    expect(screen.getByText('Quote Q-0999')).toBeInTheDocument();
    expect(screen.getByText('Q Ranch · closed short')).toBeInTheDocument();
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options.findIndex((t) => t.includes('Q-1042'))).toBeLessThan(options.findIndex((t) => t.includes('Q-0999')));

    fireEvent.click(screen.getByText('Quote Q-1042'));
    expect(mockNavigate).toHaveBeenCalledWith('/quotes/q1');
  });

  it('reads quotes from the quotes table, once by number and once by customer name', async () => {
    renderAndSearch('hill');
    await screen.findByText('Quote Q-1042');
    const quoteReads = mockFrom.mock.calls.filter(([t]) => t === 'quotes');
    expect(quoteReads).toHaveLength(2);
  });

  it('shows the tier 1 price beside a product to office staff', async () => {
    renderAndSearch('roundup');
    expect(await screen.findByText('Herbicide · Tier 1 $42.50')).toBeInTheDocument();
  });

  it('shows field staff no prices and no quotes', async () => {
    auth.current = { role: 'driver', deniedPages: [] };
    renderAndSearch('roundup');
    expect(await screen.findByText('Herbicide')).toBeInTheDocument();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(screen.queryByText(/Tier 1/)).not.toBeInTheDocument();
  });

  it('skips quotes for a rep whose Quotes page is turned off', async () => {
    auth.current = { role: 'sales_rep', deniedPages: ['quotes'] };
    renderAndSearch('q-1');
    await screen.findByText('Roundup PowerMax');
    expect(mockFrom.mock.calls.some(([t]) => t === 'quotes')).toBe(false);
  });

  it('keeps the other results when the quote or price read fails', async () => {
    mockFrom.mockImplementation((table: string) => chain(table, () => ({ data: null, error: { message: 'nope' } })));
    renderAndSearch('roundup');
    expect(await screen.findByText('Roundup PowerMax')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Herbicide')).toBeInTheDocument());
    expect(screen.queryByText(/Quote Q-/)).not.toBeInTheDocument();
  });
});
