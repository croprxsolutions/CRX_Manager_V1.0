/**
 * RefundOrReturnDialog (M9 screens, design v73): one admin dialog with two choices, the refund form with its
 * errors and confirm, and the returned-check picker with its two dates and "what happens".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReturnableCheck } from '../../lib/m9Reversals';

const H = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn(), basics: vi.fn(), checks: vi.fn(), effect: vi.fn(), one: vi.fn() }));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { rpc: H.rpc } };
});
vi.mock('../../lib/m9Reversals', async () => {
  const actual = await vi.importActual<typeof import('../../lib/m9Reversals')>('../../lib/m9Reversals');
  return { ...actual, loadDialogBasics: H.basics, loadReturnableChecks: H.checks, loadReturnEffect: H.effect, loadReturnableCheck: H.one };
});
vi.mock('../../lib/dateUtils', async () => {
  const actual = await vi.importActual<typeof import('../../lib/dateUtils')>('../../lib/dateUtils');
  return { ...actual, todayInBusinessTz: () => '2026-11-23' };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1', role: 'admin' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import RefundOrReturnDialog from './RefundOrReturnDialog';

const check = (extra: Partial<ReturnableCheck>): ReturnableCheck => ({
  allocationSetId: 'set-6107', creditId: null, customerId: 'c1', number: '6107', date: '2026-09-15', amountCents: 170000,
  prepayCheck: false, meta: 'Paid INV-20290 $1,200.00 · created Fall 2026 prepay $500.00', closedMonth: true, disabledReason: null, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  H.basics.mockResolvedValue({
    credits: [
      { id: 'k-fall', label: 'Fall 2026 prepay', balance_cents: 30000, created_at: '2026-09-15T15:00:00Z' },
      { id: 'k-spring', label: 'Spring 2026 prepay', balance_cents: 20000, created_at: '2026-03-02T15:00:00Z' },
    ],
    closed: [{ period_start: '2026-10-01', period_end: '2026-10-31' }, { period_start: '2026-09-01', period_end: '2026-09-30' }],
    owesCents: 324000,
  });
  H.checks.mockResolvedValue([
    check({ allocationSetId: 'set-6311', number: '6311', date: '2026-11-10', amountCents: 90000, meta: 'Paid INV-20512 $900.00', closedMonth: false }),
    check({ allocationSetId: null, creditId: 'k-6230', number: '6230', date: '2026-10-14', amountCents: 40000, prepayCheck: true, meta: 'Fall 2026 prepay $400.00', disabledReason: 'Already returned Nov 3' }),
    check({}),
    check({ allocationSetId: null, creditId: 'k-5521', number: '5521', date: '2026-03-02', amountCents: 100000, prepayCheck: true, meta: 'Spring 2026 prepay $1,000.00 ($200.00 left)', closedMonth: false }),
  ]);
  H.effect.mockResolvedValue({
    invoices: [
      { id: 'i-290', number: 'INV-20290', cents: 120000, dueDate: '2026-10-15', overdue: true, viaPrepay: null, paidOn: null },
      { id: 'i-311', number: 'INV-20311', cents: 20000, dueDate: '2026-12-02', overdue: false, viaPrepay: 'Fall 2026 prepay', paidOn: '2026-10-02' },
    ],
    prepayRemovedCents: 30000, removedLabel: 'Fall 2026 prepay', totalCents: 170000,
  });
});
afterEach(cleanup);

const open = (props: Partial<Parameters<typeof RefundOrReturnDialog>[0]> = {}) => {
  const onRecorded = vi.fn();
  render(<RefundOrReturnDialog open onClose={vi.fn()} onRecorded={onRecorded} customerId="c1" farmName="Prairie Ridge Farms" {...props} />);
  return { onRecorded };
};

describe('RefundOrReturnDialog: the two choices', () => {
  it('opens on the two choices with no form and no Continue step', async () => {
    open();
    expect(await screen.findByText('Prairie Ridge Farms · prepay available $500.00')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Refund paid outside CRX/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Check came back \(bounced\)/ })).not.toBeChecked();
    expect(screen.queryByLabelText(/^Amount/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue/ })).not.toBeInTheDocument();
    expect(screen.getByText('Pick what happened to see the form')).toBeInTheDocument();
  });

  it('picking a refund opens its form right below, today and oldest first by default', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Refund paid outside CRX/ }));
    expect(screen.getByLabelText(/^Amount/)).toBeInTheDocument();
    expect(screen.getByText('Up to $500.00 available')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Oldest prepay first/ })).toBeChecked();
  });
});

describe('RefundOrReturnDialog: refund paid outside CRX', () => {
  it('refuses before saving: over the available prepay, and a reason is required', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Refund paid outside CRX/ }));
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '650' } });
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: 'QuickBooks check 1057' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record refund…' }));
    expect(screen.getByText('More than the $500.00 available.')).toBeInTheDocument();
    expect(screen.getByText('Add a reason. It shows in the prepay history.')).toBeInTheDocument();
    expect(screen.getByText('Fix the 2 fields above to continue')).toBeInTheDocument();
    expect(screen.queryByText(/Record a .* refund\?/)).not.toBeInTheDocument();
    expect(H.rpc).not.toHaveBeenCalled();
  });

  it('shows the oldest-first draw and the balance change, confirms, then records the refund', async () => {
    H.rpc.mockResolvedValue({ data: { reversal_id: 'r1', amount_cents: 30000, prepay_balance_cents: 20000 }, error: null });
    const { onRecorded } = open();
    fireEvent.click(await screen.findByRole('radio', { name: /Refund paid outside CRX/ }));
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '300' } });
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: 'QuickBooks check 1057' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Grower overpaid for spring' } });
    expect(screen.getByText('Spring 2026 prepay $200.00, then Fall 2026 prepay $100.00')).toBeInTheDocument();
    expect(screen.getByTestId('refund-summary')).toHaveTextContent('Prepay $500.00 → $200.00');

    fireEvent.click(screen.getByRole('button', { name: 'Record refund…' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Record a $300.00 refund?')).toBeInTheDocument();
    expect(within(confirm).getByText('Nov 23, 2026')).toBeInTheDocument();
    expect(within(confirm).getByText('Check · QuickBooks check 1057')).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Record refund' }));

    await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('record_outside_refund', expect.objectContaining({
      p_customer_id: 'c1', p_amount_cents: 30000, p_paid_on: '2026-11-23', p_reference: 'QuickBooks check 1057',
      p_reason: 'Grower overpaid for spring (paid by Check)', p_performed_by: 'admin-1', p_allow_duplicate_reference: false,
    })));
    expect(H.rpc.mock.calls[0][1].p_credit_id).toBeUndefined();
    expect(H.rpc.mock.calls[0][1].p_idempotency_key).toEqual(expect.any(String));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('success', 'Refund of $300.00 recorded. Prepay is now $200.00.'));
    expect(onRecorded).toHaveBeenCalled();
  });

  it('"A credit I pick" with no credit picked is refused, never drawn oldest first (Sol r1 H1)', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Refund paid outside CRX/ }));
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: 'QB 1' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'why' } });
    fireEvent.click(screen.getByRole('radio', { name: 'A credit I pick' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record refund…' }));
    expect(screen.getByText('Pick the credit to take it from.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('entering the same refund again, even after closing the dialog, sends the same retry key (Sol r3 H2)', async () => {
    H.rpc.mockResolvedValue({ data: null, error: { message: 'NETWORK: the reply was lost' } });
    const fill = async (amount: string) => {
      fireEvent.click(await screen.findByRole('radio', { name: /Refund paid outside CRX/ }));
      fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: amount } });
      fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: 'QuickBooks check 1057' } });
      fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Grower overpaid' } });
      fireEvent.click(screen.getByRole('button', { name: 'Record refund…' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Record refund' }));
      await waitFor(() => expect(H.toast).toHaveBeenCalled());
      H.toast.mockClear();
    };
    const first = render(<RefundOrReturnDialog open onClose={vi.fn()} onRecorded={vi.fn()} customerId="c1" farmName="Prairie Ridge Farms" />);
    await fill('300');
    first.unmount();
    render(<RefundOrReturnDialog open onClose={vi.fn()} onRecorded={vi.fn()} customerId="c1" farmName="Prairie Ridge Farms" />);
    await fill('300');
    expect(H.rpc).toHaveBeenCalledTimes(2);
    const [a, b] = H.rpc.mock.calls.map((c) => c[1].p_idempotency_key);
    expect(b).toBe(a);
    expect(a).toMatch(/^record_outside_refund:admin-1:[0-9a-f]{16}$/);
    cleanup();
    render(<RefundOrReturnDialog open onClose={vi.fn()} onRecorded={vi.fn()} customerId="c1" farmName="Prairie Ridge Farms" />);
    await fill('301');
    expect(H.rpc.mock.calls[2][1].p_idempotency_key).not.toBe(a);
  });

  it('asks before recording a second refund with the same reference', async () => {
    H.rpc.mockResolvedValueOnce({ data: null, error: { message: 'REFUND_DUPLICATE_REFERENCE: a refund with reference "x" is already recorded' } })
      .mockResolvedValueOnce({ data: { reversal_id: 'r2', amount_cents: 1000, prepay_balance_cents: 49000 }, error: null });
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Refund paid outside CRX/ }));
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: 'QB 1' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'second check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record refund…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Record refund' }));
    const again = await screen.findByRole('button', { name: 'Record a second refund' });
    expect(screen.getByText(/already recorded for this customer/)).toBeInTheDocument();
    fireEvent.click(again);
    await waitFor(() => expect(H.rpc).toHaveBeenLastCalledWith('record_outside_refund', expect.objectContaining({ p_allow_duplicate_reference: true })));
    // A second refund the admin confirmed gets its own fresh key, never the first refund's (Sol r3 H2).
    expect(H.rpc.mock.calls[1][1].p_idempotency_key).not.toBe(H.rpc.mock.calls[0][1].p_idempotency_key);
  });

  it('the duplicate go-ahead is taken back when the refund changes (Sol r1 H3)', async () => {
    H.rpc.mockResolvedValue({ data: null, error: { message: 'REFUND_DUPLICATE_REFERENCE: already recorded' } });
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Refund paid outside CRX/ }));
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: 'QB 1' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'second check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record refund…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Record refund' }));
    await screen.findByRole('button', { name: 'Record a second refund' });
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    fireEvent.change(await screen.findByLabelText(/^Reason/), { target: { value: 'a different reason' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record refund…' }));
    expect(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Record refund' })).toBeInTheDocument();
    expect(screen.queryByText(/already recorded for this customer/)).not.toBeInTheDocument();
  });
});

describe('RefundOrReturnDialog: check came back', () => {
  it('lists checks with returned ones disabled, tagged prepay check and closed month', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Check came back/ }));
    const r6230 = await screen.findByRole('radio', { name: /Check 6230/ });
    expect(r6230).toBeDisabled();
    expect(screen.getByText('Already returned Nov 3')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Check 5521/ })).toBeEnabled();
    expect(screen.getAllByText('Prepay check')).toHaveLength(2);
    expect(screen.getAllByText('Sep · closed month').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a check by number' }), { target: { value: '63' } });
    expect(screen.queryByRole('radio', { name: /Check 6107/ })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Check 6311/ })).toBeInTheDocument();
  });

  it('shows what happens, keeps the entry date today and records with the bank date', async () => {
    H.rpc.mockResolvedValue({ data: { reversal_id: 'r3', amount_cents: 170000, prepay_balance_cents: 20000 }, error: null });
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Check came back/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Check 6107/ }));
    expect(await screen.findByText('INV-20290 goes back to unpaid')).toBeInTheDocument();
    expect(screen.getByText('INV-20311 goes back to unpaid')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Remaining Fall 2026 prepay is removed')).toBeInTheDocument();
    expect(screen.getByText(/\$1,200\.00 \+ \$200\.00 \+ \$300\.00 · customer owes \$3,240\.00 → \$4,640\.00/)).toBeInTheDocument();
    expect(screen.getByTestId('entry-date')).toHaveTextContent('Nov 23, 2026 (today)');
    expect(screen.getByText('Always today. September stays closed.')).toBeInTheDocument();
    expect(screen.getByText('2 invoices back to unpaid · prepay −$300.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Record returned check…' }));
    expect(screen.getByText('Add a reason. It shows in the prepay history.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Bank returned it: insufficient funds' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record returned check…' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Return check 6107 ($1,700.00)?')).toBeInTheDocument();
    expect(within(confirm).getByText('September stays closed. Nothing in a closed month changes.')).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Record returned check' }));
    await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('record_returned_check', expect.objectContaining({
      p_allocation_set_id: 'set-6107', p_returned_date: '2026-11-23', p_reason: 'Bank returned it: insufficient funds', p_performed_by: 'admin-1',
    })));
  });

  it('keeps the picked check in the list while searching, and a reason does not carry into the other choice (Sol LOW)', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Check came back/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Check 6107/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a check by number' }), { target: { value: '6311' } });
    expect(screen.getByRole('radio', { name: /Check 6107/ })).toBeChecked();
    fireEvent.change(await screen.findByLabelText(/^Reason/), { target: { value: 'Insufficient funds' } });
    fireEvent.click(screen.getByRole('radio', { name: /Refund paid outside CRX/ }));
    expect(screen.getByLabelText(/^Reason/)).toHaveValue('');
  });

  it('keeps Record returned check… disabled while What happens loads', async () => {
    let release!: (v: unknown) => void;
    H.effect.mockReturnValue(new Promise((r) => { release = r; }));
    open();
    fireEvent.click(await screen.findByRole('radio', { name: /Check came back/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Check 6107/ }));
    expect(screen.getByRole('button', { name: /Record returned check/ })).toBeDisabled();
    release({ invoices: [], prepayRemovedCents: 0, removedLabel: 'prepay', totalCents: 170000 });
    await waitFor(() => expect(screen.getByRole('button', { name: /Record returned check/ })).toBeEnabled());
  });

  it('opened from a payment line: the check is already picked, with no choice step and no list', async () => {
    H.one.mockResolvedValue(check({}));
    open({ allocationSetId: 'set-6107', fromLabel: 'INV-20290' });
    expect(await screen.findByText('Mark check as returned')).toBeInTheDocument();
    expect(screen.getByText('Prairie Ridge Farms · from INV-20290')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Refund paid outside CRX/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(await screen.findByText('INV-20290 goes back to unpaid')).toBeInTheDocument();
  });
});
