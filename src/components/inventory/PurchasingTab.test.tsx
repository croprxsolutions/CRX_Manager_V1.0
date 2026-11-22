import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockToast } = vi.hoisted(() => ({ mockRpc: vi.fn(), mockToast: vi.fn() }));
vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { rpc: mockRpc } };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import PurchasingTab, { suggestionText, type PurchasingPlan } from './PurchasingTab';

// Shaped like get_purchasing_plan's answer (20270127110000); numerics arrive as JSON numbers.
const PLAN: PurchasingPlan = {
  today: '2027-02-01', lead_days: 14, months_ahead: 6, horizon_end: '2027-07-31',
  firm_needs_date: [{ quote_number: 'Q-1', customer_name: 'North Farm', section_name: 'Field A', product_id: 'p1', product_name: 'Herbicide X', quantity: 40 }],
  drawn_section_unknown: [{ quote_number: 'Q-2', customer_name: 'South Farm', product_name: 'Herbicide X', quantity: 60 }],
  review: [{ quote_id: 'q3', section_id: 's3', quote_number: 'Q-3', customer_name: 'East Farm', section_name: 'Field C',
    timing: 'pre_plant', confidence: 'likely', needed_by_date: '2027-03-01', window_end: '2027-05-15' }],
  products: [{
    product_id: 'p1', product_name: 'Herbicide X', stock_unit: 'Gal', on_hand: 100, incoming: 0, drafted: 5,
    committed: 160, suggested: 110, could_add: 0, over_drawn: 0, not_complete: true, reasons: ['needs_date'],
    suggestions: [
      { need_date: '2027-03-01', order_by: '2027-02-15', order_now: false, quantity: 30 },
      { need_date: '2027-04-01', order_by: '2027-03-18', order_now: false, quantity: 80 },
    ],
    rows: [{ kind: 'order', class: 'committed', bucket: 'dated', need_date: '2027-02-01', raw_date: '2027-02-01', overdue: false, quantity: 50,
      confidence: null, estimated: null, quote_number: null, order_number: 'O-9', job_number: null, customer_name: 'West Farm', section_name: null },
    { kind: 'hold', class: 'committed', bucket: 'dated', need_date: '2027-01-20', raw_date: '2027-01-05', overdue: true, quantity: 5,
      confidence: null, estimated: null, quote_number: null, order_number: null, job_number: null, customer_name: null, section_name: null }],
    purchase_orders: [],
  }],
};

describe('PurchasingTab', () => {
  beforeEach(() => { mockRpc.mockReset(); mockToast.mockReset(); });

  it('shows the firm-needs-a-date box, the unknown-section bucket, the review list and the buy suggestions', async () => {
    mockRpc.mockResolvedValue({ data: PLAN, error: null });
    render(<PurchasingTab />);
    expect(await screen.findByText(/Firm, needs a date: 1 booking line./)).toBeInTheDocument();
    expect(screen.getByText(/North Farm · Booking Q-1 · Field A · Herbicide X: 40 Gal/)).toBeInTheDocument();
    expect(screen.getByText('Drawn, section unknown')).toBeInTheDocument();
    expect(screen.getByText(/South Farm · Booking Q-2 · Herbicide X: 60/)).toBeInTheDocument();
    expect(screen.getByText('East Farm')).toBeInTheDocument();
    expect(screen.getByText('not complete')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('get_purchasing_plan', { p_months_ahead: 6 });

    fireEvent.click(screen.getByRole('button', { name: /Show details for Herbicide X/ }));
    expect(screen.getByText(/Order 30 Gal by Feb 15, 2027/)).toBeInTheDocument();
    expect(screen.getByText(/Order 80 Gal by Mar 18, 2027/)).toBeInTheDocument();
    expect(screen.getByText('Order O-9')).toBeInTheDocument();
    // An overdue line shows its original date; a hold is not assumed to be manual.
    expect(screen.getByText('Jan 5, 2027 · overdue')).toBeInTheDocument();
    expect(screen.getByText('Stock hold')).toBeInTheDocument();
    expect(screen.getByText(/Not complete: firm need without a date/)).toBeInTheDocument();
  });

  it('shows cover, late POs, follow-ups, unbacked holds and Check data from the #1989 plan', async () => {
    const p = PLAN.products[0];
    mockRpc.mockResolvedValue({ data: {
      ...PLAN,
      check_data: [{ kind: 'po_line', id: 'pl1', product_id: 'p1', product_name: 'Herbicide X' }],
      products: [{
        ...p, has_late_cover: true, has_followup: true, hold_unbacked: 7,
        rows: [{ ...p.rows[0], kind: 'booking', quote_number: 'Q-5', order_number: null, overdue_followup: true }],
        coverage: [{ group: 'committed', booked: 160, on_time: 100, late: 20, not_covered: 40, from_shelf: 100,
          pos: [{ po_id: 'po1', po_number: 'PO-7', qty: 20, expected_date: '2027-03-10', late: true, po_overdue: false, po_undated: false }] }],
      }],
    }, error: null });
    render(<PurchasingTab />);
    expect(await screen.findByText(/Check data: 1 record holds an impossible quantity or date/)).toBeInTheDocument();
    expect(screen.getByText('PO line · Herbicide X')).toBeInTheDocument();
    expect(screen.getByText('PO arrives late')).toBeInTheDocument();
    expect(screen.getByText('follow up')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show details for Herbicide X/ }));
    expect(screen.getByText('Shelf 100; PO PO-7 20 (arrives late, Mar 10, 2027)')).toBeInTheDocument();
    expect(screen.getByText(/Held but not on the shelf: 7/)).toBeInTheDocument();
    expect(screen.getByText(/· follow up/)).toBeInTheDocument();
  });

  it('an older plan without the #1989 keys still renders', async () => {
    mockRpc.mockResolvedValue({ data: PLAN, error: null });
    render(<PurchasingTab />);
    expect(await screen.findByText('Herbicide X')).toBeInTheDocument();
    expect(screen.queryByText(/Check data:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show details for Herbicide X/ }));
    expect(screen.queryByText('Covers')).not.toBeInTheDocument();
  });

  it('a failed read shows Try again, not an empty plan', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Access denied', code: '42501' } });
    render(<PurchasingTab />);
    expect(await screen.findByText('The purchasing plan could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to buy/)).not.toBeInTheDocument();
  });

  it('words a need as order-by, and an overdue need as order now', () => {
    expect(suggestionText({ need_date: '2027-03-02', order_by: '2027-02-16', order_now: false, quantity: 100 }, 'Gal'))
      .toBe('Order 100 Gal by Feb 16, 2027 (needed Mar 2, 2027)');
    expect(suggestionText({ need_date: '2027-02-05', order_by: '2027-02-01', order_now: true, quantity: 10 }, null))
      .toBe('Order 10 now (needed Feb 5, 2027)');
    expect(suggestionText({ need_date: '2027-02-05', order_by: '2027-02-01', order_now: true, quantity: '0.0004' }, 'Gal'))
      .toBe('Order 0.001 Gal now (needed Feb 5, 2027)');
    expect(suggestionText({ need_date: '2027-02-05', order_by: '2027-02-01', order_now: true, quantity: '1.2344' }, 'Gal'))
      .toBe('Order 1.235 Gal now (needed Feb 5, 2027)');
    expect(suggestionText({ need_date: '2027-02-05', order_by: '2027-02-01', order_now: true, quantity: '0.0000000000005' }, 'Gal'))
      .toBe('Order 0.001 Gal now (needed Feb 5, 2027)');
  });
});
