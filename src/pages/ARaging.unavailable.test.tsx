/**
 * ARaging.unavailable.test.tsx — KI-95: a customer whose balance get_ar_aging cannot rebuild as of
 * the chosen date comes back flagged with no amounts. The AR Aging tab lists them in a warning,
 * keeps them out of the table and totals and says so; the Accounts Receivable strip says its
 * Total Owed excludes them. Neither shows that customer as owing $0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({
  functions: {} as Record<string, unknown[]>,
  // One toast function for the whole run: ARaging reloads the aging whenever `toast` changes.
  toast: vi.fn(),
}));

// Every query chain, table or function, answers with its rows (none unless a test sets some).
const reply = (rows: unknown[] = []) => {
  const chain: object = new Proxy({}, {
    get: (_target, prop) => (prop === 'then'
      ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject)
      : () => chain),
  });
  return chain;
};

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: () => reply(),
      rpc: (name: string) => reply(H.functions[name]),
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import AccountsReceivable from './AccountsReceivable';
import ARaging from './ARaging';

const amounts = (n: number) => ({
  current_amount: n, days_30: 0, days_60: 0, days_90: 0, over_90: 0, total_outstanding: n,
  prepay_balance_cents: 0, open_credit_cents: 0,
});

beforeEach(() => {
  H.functions = {
    get_ar_aging: [
      { customer_id: 'c1', farm_name: 'Big Farm', ...amounts(100), unavailable_reason: null },
      { customer_id: 'c2', farm_name: 'Small Farm', ...amounts(25), unavailable_reason: null },
      {
        customer_id: 'c3', farm_name: 'Late Payer Farm', current_amount: null, days_30: null, days_60: null,
        days_90: null, over_90: null, total_outstanding: null, prepay_balance_cents: null, open_credit_cents: null,
        unavailable_reason: 'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE',
      },
    ],
  };
});
afterEach(() => cleanup());

describe('AR Aging with a customer that cannot be shown as of the date', () => {
  it('lists them in a warning with the reason, and keeps them out of the table and totals', async () => {
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('1 customer cannot be shown as of this date');
    expect(within(alert).getByText('Late Payer Farm')).toBeTruthy();
    expect(alert.textContent).toContain('a payment, prepay or write-off was entered after this date');
    // The table has the two good customers only, and no $0.00 row for the flagged one.
    expect(screen.getAllByRole('button', { name: 'Big Farm' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Late Payer Farm' })).toBeNull();
    expect(screen.getAllByText('$125.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Excludes 1 customer not shown')).toBeTruthy();
    expect(screen.getByText('excl. 1 not shown')).toBeTruthy();
  });

  it('explains a posting-history flag (20261104120000) in plain words', async () => {
    H.functions.get_ar_aging = [{ ...H.functions.get_ar_aging[2] as object, unavailable_reason: 'HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE' }];
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Late Payer Farm — an invoice's posting history has two changes recorded at the same moment");
  });

  it('shows no warning when every customer can be shown', async () => {
    H.functions.get_ar_aging = H.functions.get_ar_aging.slice(0, 2);
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    await screen.findAllByRole('button', { name: 'Big Farm' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/not shown/)).toBeNull();
  });

  it('when every customer is flagged, the empty table does not say balances are current', async () => {
    H.functions.get_ar_aging = H.functions.get_ar_aging.slice(2);
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    await screen.findByRole('alert');
    expect(await screen.findByText('No balances can be shown for this date')).toBeTruthy();
    expect(screen.queryByText('All customer balances are current.')).toBeNull();
  });

  it("the Accounts Receivable strip says Total Owed excludes them and gives no net position", async () => {
    render(<MemoryRouter initialEntries={['/?tab=payments']}><AccountsReceivable /></MemoryRouter>);
    expect(await screen.findByText(/Excludes 1 customer that can't be shown for today/)).toBeTruthy();
    expect(screen.getAllByText('$125.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Not available')).toBeTruthy();
    expect(screen.queryByText(/true exposure/)).toBeNull();
  });

  it('the strip still gives a net position when no customer is flagged', async () => {
    H.functions.get_ar_aging = H.functions.get_ar_aging.slice(0, 2);
    render(<MemoryRouter initialEntries={['/?tab=payments']}><AccountsReceivable /></MemoryRouter>);
    expect(await screen.findByText(/true exposure/)).toBeTruthy();
    expect(screen.queryByText('Not available')).toBeNull();
  });
});
