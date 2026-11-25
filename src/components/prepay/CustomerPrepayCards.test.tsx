/**
 * CustomerPrepayCards (M9 design v73): the customer's Prepay Credits card with the "doesn't tie" badge (both numbers
 * on screen), the admin's "Record refund or returned check" button, and the Prepay History rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({ tie: vi.fn(), history: vi.fn() }));
vi.mock('../../lib/m9Reversals', async () => {
  const actual = await vi.importActual<typeof import('../../lib/m9Reversals')>('../../lib/m9Reversals');
  return { ...actual, fetchPrepayTie: H.tie, loadPrepayHistory: H.history };
});
vi.mock('./RefundOrReturnDialog', () => ({ default: () => null }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import CustomerPrepayCards from './CustomerPrepayCards';

const credits = [
  { id: 'k1', bucket_label: 'Spring 2026 prepay', original_amount_cents: 100000, balance_cents: 20000, source_reference: '5521', reference_number: '5521', created_at: '2026-03-02T15:00:00Z' },
  { id: 'k2', bucket_label: 'Fall 2026 prepay', original_amount_cents: 50000, balance_cents: 30000, source_reference: '6107', reference_number: '6107', created_at: '2026-09-15T15:00:00Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  H.tie.mockResolvedValue([{ customer_id: 'c1', farm_name: 'Prairie Ridge Farms', stored_cents: 52500, credits_cents: 50000, expected_cents: 50000, difference_cents: 2500, ok: false }]);
  H.history.mockResolvedValue([
    { key: 'r1', at: '2026-11-20T15:00:00Z', day: '2026-11-20', kind: 'refund', what: 'Refund paid outside CRX', sub: 'Grower overpaid for spring', ref: 'Check · QuickBooks check 1042', by: 'Mason W.', cents: -15000, afterCents: 50000 },
    { key: 'r2', at: '2026-11-03T15:00:00Z', day: '2026-11-03', kind: 'bounce', what: 'Check came back (bounced)', sub: 'Bank returned it: insufficient funds', ref: 'Check 6230', by: 'Mason W.', cents: -40000, afterCents: 65000 },
  ]);
});
afterEach(cleanup);

const show = (isAdmin: boolean, list = credits) => render(
  <MemoryRouter><CustomerPrepayCards customerId="c1" farmName="Prairie Ridge Farms" credits={list} isAdmin={isAdmin} onChanged={vi.fn()} /></MemoryRouter>,
);

describe('CustomerPrepayCards', () => {
  it("shows the admin the doesn't-tie badge with the stored and credits numbers, and the refund button", async () => {
    show(true);
    expect(await screen.findByText("Doesn't tie · $25.00")).toBeInTheDocument();
    expect(screen.getByText(/Stored balance \$525\.00 · credits add up to \$500\.00\. Refunds use \$500\.00, what the credits hold\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Month-End check' })).toHaveAttribute('href', '/month-end');
    expect(screen.getByTestId('available-prepay')).toHaveTextContent('$500.00');
    expect(screen.getByRole('button', { name: /Record refund or returned check/ })).toBeInTheDocument();
  });

  it('lists refunds and returned checks in the Prepay History with who, reference and balance after', async () => {
    show(true);
    expect(await screen.findByText('Refund paid outside CRX')).toBeInTheDocument();
    expect(screen.getByText('Check came back (bounced)')).toBeInTheDocument();
    expect(screen.getByText('Check · QuickBooks check 1042 · by Mason W.')).toBeInTheDocument();
    expect(screen.getByText('−$150.00')).toBeInTheDocument();
    expect(screen.getByText('$650.00')).toBeInTheDocument();
  });

  it('a rep sees the credits but no badge, no mismatch line, no button and no history', async () => {
    show(false);
    expect(screen.getByText('Fall 2026 prepay')).toBeInTheDocument();
    expect(screen.queryByText(/Doesn't tie/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stored balance/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record refund or returned check/ })).not.toBeInTheDocument();
    expect(screen.queryByText('History')).not.toBeInTheDocument();
    expect(H.tie).not.toHaveBeenCalled();
    expect(H.history).not.toHaveBeenCalled();
  });

  it('no badge when the balance ties; an admin sees the empty state with the button when there is no prepay', async () => {
    H.tie.mockResolvedValue([{ customer_id: 'c1', farm_name: 'x', stored_cents: 0, credits_cents: 0, expected_cents: 0, difference_cents: 0, ok: true }]);
    H.history.mockResolvedValue([]);
    show(true, []);
    expect(await screen.findByText('No prepay for this customer')).toBeInTheDocument();
    expect(await screen.findByText('No prepay activity yet')).toBeInTheDocument();
    expect(screen.queryByText(/Doesn't tie/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record refund or returned check/ })).toBeInTheDocument();
  });
});
