/**
 * PaymentHistory.dateFilter.test.tsx — a From/To date filter with Today / This month quick
 * choices; the totals cover only the payments shown. Days are Chicago business days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';
import { dayParam, firstOfBusinessMonth, isDayInRange, paymentBusinessDate } from '../lib/paymentDateRange';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, toast: vi.fn() }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => buildInMemoryQuery(H.tables[table] ?? []),
      rpc: vi.fn(),
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }) }));

import PaymentHistory from './PaymentHistory';

// 9:30 PM Chicago on Nov 24 is already Nov 25 in UTC: "Today" must still be Nov 24.
const NOW = new Date('2026-11-25T03:30:00Z');

const payment = (id: string, cents: number, extra: Partial<Row>): Row => ({
  id, customer_id: 'c1', total_payment_cents: cents, total_allocated_cents: cents, payment_method: 'check',
  check_number: `CHK-${id}`, reference_number: null, payment_date: null, season: 2027, is_active: true, notes: null,
  created_at: '2026-01-01T12:00:00Z', customers: { farm_name: 'Big Farm' }, ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  H.tables = {
    allocation_sets: [
      payment('today', 10000, { payment_date: '2026-11-24', created_at: '2026-11-24T15:00:00Z' }),
      // No payment date: entered 8 PM Chicago Nov 24 (Nov 25 in UTC) — counts as today.
      payment('evening', 5000, { created_at: '2026-11-25T02:00:00Z' }),
      payment('voided', 99900, { payment_date: '2026-11-24', is_active: false, created_at: '2026-11-24T16:00:00Z' }),
      payment('early', 2500, { payment_date: '2026-11-03', created_at: '2026-11-03T15:00:00Z' }),
      payment('october', 100000, { payment_date: '2026-10-30', created_at: '2026-10-30T15:00:00Z' }),
    ],
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const activeTotal = () => screen.getByText('Active Payments').closest('div')!.parentElement!;

describe('Payment History date filter', () => {
  it('starts on all dates, and Today / This month total only the payments in those days', async () => {
    render(<MemoryRouter><PaymentHistory /></MemoryRouter>);
    expect(await screen.findByText('CHK-october')).toBeInTheDocument();
    expect(activeTotal()).toHaveTextContent('$1,175.00');
    expect(activeTotal()).toHaveTextContent('4 payment(s) all time');

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(activeTotal()).toHaveTextContent('$150.00');
    expect(activeTotal()).toHaveTextContent('2 payment(s) today');
    expect(screen.getByText('CHK-evening')).toBeInTheDocument();
    expect(screen.queryByText('CHK-early')).not.toBeInTheDocument();
    expect(screen.queryByText('CHK-october')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(activeTotal()).toHaveTextContent('$175.00');
    expect(screen.getByText('CHK-early')).toBeInTheDocument();
    expect(screen.queryByText('CHK-october')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All dates' }));
    expect(activeTotal()).toHaveTextContent('$1,175.00');
  });
});

describe('Payment History counts checks entered on Prepay Credits (KI-207)', () => {
  const credit = (id: string, cents: number, extra: Partial<Row>): Row => ({
    id, customer_id: 'c1', source_type: 'check', allocation_set_id: null, original_amount_cents: cents,
    source_reference: 'PRE-1', created_at: '2026-11-24T18:00:00Z', customers: { farm_name: 'Big Farm' }, ...extra,
  });

  it('adds them to the totals as one check per entry, like Month-End Close', async () => {
    H.tables.prepay_credits = [
      // One $300 check split across two buckets: same customer, time and reference.
      credit('p1', 20000, {}),
      credit('p2', 10000, {}),
      // Left over from a Record Payments overpayment: already in allocation_sets, never counted twice.
      credit('p3', 7000, { allocation_set_id: 'today' }),
      // Not a check.
      credit('p4', 4000, { source_type: 'manual_adjustment', source_reference: 'ADJ' }),
      // Last month.
      credit('p5', 9900, { created_at: '2026-10-15T18:00:00Z', source_reference: 'PRE-OCT' }),
    ];
    render(<MemoryRouter><PaymentHistory /></MemoryRouter>);
    expect(await screen.findByText('CHK-october')).toBeInTheDocument();
    expect(activeTotal()).toHaveTextContent('$1,574.00');

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(activeTotal()).toHaveTextContent('$450.00');
    expect(activeTotal()).toHaveTextContent('3 payment(s) today');
    expect(screen.getByText(/include 1 check\(s\) entered on Prepay Credits \(\$300\.00\)/)).toHaveTextContent('Export CSV lists each one');
  });
});

describe('Payment History date filter and the opened payment', () => {
  it('closes the opened payment\'s allocations when the new dates hide it, and keeps them when they do not', async () => {
    H.tables.invoice_line_allocations = [{
      id: 'a1', allocation_set_id: 'october', invoice_id: 'i1', amount_cents: 100000, split_percentage: 100,
      bill_to_customer_id: 'c1', created_at: '2026-10-30T15:00:00Z',
      invoices: { invoice_number: 'INV-OCT' }, customers: { farm_name: 'Big Farm' },
    }];
    render(<MemoryRouter><PaymentHistory /></MemoryRouter>);
    const row = (await screen.findByText('CHK-october')).closest('tr')!;
    fireEvent.click(within(row).getAllByRole('button')[0]);
    expect(await screen.findByText('INV-OCT')).toBeInTheDocument();

    // All dates still shows October's payment, so its panel stays open.
    fireEvent.click(screen.getByRole('button', { name: 'All dates' }));
    expect(screen.getByText('INV-OCT')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(screen.queryByText('CHK-october')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoice Allocations')).not.toBeInTheDocument();
    expect(screen.queryByText('INV-OCT')).not.toBeInTheDocument();
  });
});

describe('payment date range helpers', () => {
  it('uses the payment date, else the Chicago day it was entered', () => {
    expect(paymentBusinessDate('2026-11-24', '2026-11-30T12:00:00Z')).toBe('2026-11-24');
    expect(paymentBusinessDate(null, '2026-11-25T02:00:00Z')).toBe('2026-11-24');
    expect(paymentBusinessDate(null, '2026-11-25T07:00:00Z')).toBe('2026-11-25');
  });

  it('treats From and To as inclusive and an empty end as open', () => {
    expect(isDayInRange('2026-11-24', '2026-11-24', '2026-11-24')).toBe(true);
    expect(isDayInRange('2026-11-23', '2026-11-24', null)).toBe(false);
    expect(isDayInRange('2026-11-25', null, '2026-11-24')).toBe(false);
    expect(isDayInRange('2020-01-01', null, null)).toBe(true);
  });

  it('starts the month on the Chicago month, not the UTC one', () => {
    // 7 PM Chicago on Oct 31 is Nov 1 in UTC.
    expect(firstOfBusinessMonth(new Date('2026-11-01T00:00:00Z'))).toBe('2026-10-01');
  });
});

describe('Payment History opened on a range from a link', () => {
  it('reads ?from=&to= and totals only that range', async () => {
    render(<MemoryRouter initialEntries={['/payment-history?from=2026-11-01&to=2026-11-30']}><PaymentHistory /></MemoryRouter>);
    expect(await screen.findByText('CHK-early')).toBeInTheDocument();
    expect(activeTotal()).toHaveTextContent('$175.00');
    expect(activeTotal()).toHaveTextContent('in selected dates');
    expect(screen.queryByText('CHK-october')).not.toBeInTheDocument();
  });

  it('ignores a value that is not a day', () => {
    expect(dayParam('2026-11-01')).toBe('2026-11-01');
    expect(dayParam('11/01/2026')).toBeNull();
    expect(dayParam(null)).toBeNull();
    expect(dayParam('2026-02-31')).toBeNull();
  });
});
