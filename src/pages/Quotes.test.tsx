/**
 * Quotes.test.tsx: the redesigned quotes list keeps today's filters, row actions
 * and bulk selection (Quotes UI redesign, Task 7). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

// A query that ignores its filters and answers with the table's rows.
function fixedQuery(rows: unknown): Record<string, unknown> {
  const reply = { data: rows, error: null, count: Array.isArray(rows) ? rows.length : null };
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(reply);
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = {
    from: (table: string) => fixedQuery(H.tables[table] ?? []),
    rpc: () => fixedQuery({ success: true, bookings: [] }),
  };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: vi.fn(), notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: vi.fn() }));
vi.mock('../lib/orderConfirmedEmail', () => ({ sendOrderConfirmedEmail: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../contexts/BelowCostApprovalContext', () => ({
  useBelowCostApproval: () => ({ runWithBelowCostApproval: (run: (reason: string | null) => unknown) => run(null) }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn(), getKeyFor: () => 'idem', resetKeyFor: vi.fn() }),
}));

import Quotes from './Quotes';

const quote = (n: number, status: string, over: Row = {}): Row => ({
  id: `q${n}`,
  quote_number: `Q-TEST-${n}`,
  status,
  tier: 1,
  is_planned: false,
  customer_id: 'c1',
  created_at: '2026-10-01T12:00:00Z',
  expires_at: null,
  deleted_at: null,
  total_price: 100 * n,
  customer: { farm_name: `Test Farm ${n}` },
  ...over,
});

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><Quotes /></MemoryRouter>);

beforeEach(() => { H.tables = {}; });
afterEach(cleanup);

describe('Quotes list', () => {
  it('Planned programs chip toggles the filter', async () => {
    H.tables.quotes = [quote(1, 'draft', { is_planned: true }), quote(2, 'sent')];
    at('/quotes');
    await screen.findByText('Q-TEST-2');
    const chip = screen.getByRole('button', { name: 'Planned programs' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Q-TEST-1')).toBeInTheDocument();
    expect(screen.queryByText('Q-TEST-2')).not.toBeInTheDocument();

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Q-TEST-2')).toBeInTheDocument();
  });

  it('?filter=planned turns the chip on', async () => {
    H.tables.quotes = [quote(1, 'draft', { is_planned: true }), quote(2, 'sent')];
    at('/quotes?filter=planned');
    await screen.findByText('Q-TEST-1');
    expect(screen.getByRole('button', { name: 'Planned programs' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Q-TEST-2')).not.toBeInTheDocument();
  });

  it('row menu offers Convert to order only for sent and revised', async () => {
    H.tables.quotes = [quote(1, 'draft'), quote(2, 'sent'), quote(3, 'revised'), quote(4, 'accepted')];
    at('/quotes');
    await screen.findByText('Q-TEST-1');
    const itemsFor = (n: number) => {
      fireEvent.click(screen.getByRole('button', { name: `Actions for Q-TEST-${n}` }));
      const names = within(screen.getByRole('menu')).getAllByRole('menuitem').map((el) => el.textContent);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      return names;
    };
    expect(itemsFor(1)).toEqual(['Duplicate']);
    expect(itemsFor(2)).toEqual(['Convert to order', 'Duplicate']);
    expect(itemsFor(3)).toEqual(['Convert to order', 'Duplicate']);
    expect(itemsFor(4)).toEqual(['Duplicate']);
  });

  it('header checkbox selects only draft, sent and revised rows', async () => {
    H.tables.quotes = [quote(1, 'draft'), quote(2, 'sent'), quote(3, 'revised'), quote(4, 'accepted'), quote(5, 'declined')];
    at('/quotes');
    await screen.findByText('Q-TEST-1');
    expect(screen.queryByRole('button', { name: /Select All/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Q-TEST-4' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Q-TEST-5' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all quotes' }));
    for (const n of [1, 2, 3]) expect(screen.getByRole('checkbox', { name: `Select Q-TEST-${n}` })).toBeChecked();
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all quotes' }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('Clear appears only when a filter is active', async () => {
    H.tables.quotes = [quote(1, 'draft', { is_planned: true }), quote(2, 'sent')];
    at('/quotes');
    await screen.findByText('Q-TEST-2');
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Planned programs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Planned programs' })).toHaveAttribute('aria-pressed', 'false');

    // The status filter counts too.
    fireEvent.click(screen.getByRole('button', { name: 'All Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'Sent' }));
    expect(screen.queryByText('Q-TEST-1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('status filter options use the plain labels, and the row badge keeps their casing', async () => {
    H.tables.quotes = [quote(1, 'closed_short')];
    at('/quotes');
    // The status Dropdown also renders a hidden native <select>, so look for the badge span.
    expect(await screen.findByText('Closed short', { selector: 'span' })).not.toHaveClass('capitalize');
    fireEvent.click(screen.getByRole('button', { name: 'All Status' }));
    const options = screen.getAllByRole('option').map((el) => el.textContent);
    expect(options).toEqual(['All', 'Draft', 'Sent', 'Revised', 'Accepted', 'Declined', 'Expired', 'Cancelled', 'Fulfilled', 'Closed short']);
  });
});
