/**
 * AccountsReceivable.customerCarry.test.tsx — the A/R Workspace tabs share one customer box:
 * a customer picked on one tab is still picked on the next (kept in ?customer=), and each tab
 * narrows its own list to that customer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, toast: vi.fn() }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => {
        const q = buildInMemoryQuery(H.tables[table] ?? []);
        // The customer box's name search ignores the typed text here and offers every active customer.
        if (table === 'customers') q.or = () => q;
        return q;
      },
      rpc: () => pagedRpcReply({ data: [], error: null }),
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn(), getKeyFor: () => 'idem', resetKeyFor: vi.fn() }),
}));

import AccountsReceivable from './AccountsReceivable';

function Where() {
  return <output data-testid="where">{useLocation().search}</output>;
}

const at = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <AccountsReceivable />
    <Where />
  </MemoryRouter>,
);

const payment = (id: string, customerId: string, farm: string, check: string) => ({
  id, customer_id: customerId, total_payment_cents: 1000, total_allocated_cents: 1000, payment_method: 'check',
  check_number: check, reference_number: null, payment_date: '2026-10-01', season: 2027, is_active: true, notes: null,
  created_at: '2026-10-01T12:00:00Z', customers: { farm_name: farm },
});

beforeEach(() => {
  vi.clearAllMocks();
  H.tables = {
    customers: [
      { id: 'c1', farm_name: 'Big Farm', account_number: 'A1', is_active: true, prepay_balance_cents: 500 },
      { id: 'c2', farm_name: 'Small Farm', account_number: 'A2', is_active: true, prepay_balance_cents: 700 },
    ],
    allocation_sets: [payment('p1', 'c1', 'Big Farm', 'CHK-BIG'), payment('p2', 'c2', 'Small Farm', 'CHK-SMALL')],
  };
});
afterEach(cleanup);

describe('A/R Workspace shared customer box', () => {
  it('a customer picked on Payment History narrows it and is still picked on the other tabs', async () => {
    at('/accounts-receivable?tab=payments');
    expect(await screen.findByText('CHK-SMALL')).toBeInTheDocument();

    const box = screen.getByRole('combobox', { name: 'Payment History customer' });
    fireEvent.change(box, { target: { value: 'Big' } });
    fireEvent.click(await screen.findByRole('option', { name: /Big Farm/ }));

    expect(screen.getByTestId('where')).toHaveTextContent('customer=c1');
    expect(screen.getByText('CHK-BIG')).toBeInTheDocument();
    expect(screen.queryByText('CHK-SMALL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    expect(screen.getByTestId('where')).toHaveTextContent('tab=ledger');
    expect(screen.getByTestId('where')).toHaveTextContent('customer=c1');
    expect(screen.getByRole('combobox', { name: 'Select customer' })).toHaveValue('Big Farm');

    fireEvent.click(screen.getByRole('button', { name: 'Prepayments' }));
    expect(await screen.findByRole('combobox', { name: 'Prepayments customer' })).toHaveValue('Big Farm');
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Big Farm/ }).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Small Farm/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'AR Aging' }));
    expect(screen.getByTestId('where')).toHaveTextContent('customer=c1');
  });

  it('a link with ?customer= opens with that customer named, and clearing shows everyone again', async () => {
    at('/accounts-receivable?tab=payments&customer=c2');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Payment History customer' })).toHaveValue('Small Farm'));
    expect(await screen.findByText('CHK-SMALL')).toBeInTheDocument();
    expect(screen.queryByText('CHK-BIG')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear customer' }));
    expect(screen.getByTestId('where')).not.toHaveTextContent('customer=');
    expect(await screen.findByText('CHK-BIG')).toBeInTheDocument();
    expect(screen.getByText('CHK-SMALL')).toBeInTheDocument();
  });
});
