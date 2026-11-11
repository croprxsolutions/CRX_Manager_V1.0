import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockRpc: vi.fn(), mockToast: vi.fn() }));

vi.mock('../../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: unknown): T => data as T,
  sanitizeError: (err: unknown) => (err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err)),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1', role: 'admin' } }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import StandingDiscountControl from './StandingDiscountControl';

function rateRead(row: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) self[m] = () => self;
  self.maybeSingle = () => Promise.resolve({ data: row, error: null });
  return self;
}

describe('StandingDiscountControl (billing plan M4b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => rateRead({ rate_pct: 3, set_by: null }));
    mockRpc.mockResolvedValue({ data: { invoice_id: 'inv-1', rate_pct: 1.5, total_amount_cents: 98500 }, error: null });
  });

  it('shows the sale\'s rate and saves a new one for this sale only', async () => {
    const onChanged = vi.fn();
    render(<StandingDiscountControl invoiceId="inv-1" disabled={false} onChanged={onChanged} />);
    const input = await screen.findByLabelText('Standing discount for this sale (%)');
    expect(input).toHaveValue(3);
    expect(screen.getByText(/the customer's rate/i)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_invoice_standing_discount', expect.objectContaining({
      p_invoice_id: 'inv-1', p_pct: 1.5,
    })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('goes back to the customer\'s rate', async () => {
    mockFrom.mockImplementation(() => rateRead({ rate_pct: 1.5, set_by: 'admin-1' }));
    render(<StandingDiscountControl invoiceId="inv-1" disabled={false} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: "Use the customer's rate" }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_invoice_standing_discount', expect.objectContaining({
      p_invoice_id: 'inv-1', p_pct: null,
    })));
  });

  it('is locked while the invoice has unsaved changes', async () => {
    render(<StandingDiscountControl invoiceId="inv-1" disabled onChanged={vi.fn()} />);
    expect(await screen.findByLabelText('Standing discount for this sale (%)')).toBeDisabled();
    expect(screen.getByText(/save your changes first/i)).toBeInTheDocument();
  });
});

describe('StandingDiscountControl: a late reply for another invoice (review round 1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never shows invoice A\'s rate on invoice B', async () => {
    let releaseA: (v: unknown) => void = () => {};
    mockFrom.mockImplementation(() => {
      const self: Record<string, unknown> = {};
      let id = '';
      self.select = () => self;
      self.eq = (_c: string, v: string) => { id = v; return self; };
      self.maybeSingle = () => (id === 'inv-a'
        ? new Promise((resolve) => { releaseA = resolve; })
        : Promise.resolve({ data: { rate_pct: 5, set_by: null }, error: null }));
      return self;
    });
    const { rerender } = render(<StandingDiscountControl invoiceId="inv-a" disabled={false} onChanged={vi.fn()} />);
    rerender(<StandingDiscountControl invoiceId="inv-b" disabled={false} onChanged={vi.fn()} />);
    const input = await screen.findByLabelText('Standing discount for this sale (%)');
    expect(input).toHaveValue(5);
    releaseA({ data: { rate_pct: 3, set_by: null }, error: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByLabelText('Standing discount for this sale (%)')).toHaveValue(5);
  });

  it('takes hundredths of a percent (no 0.5 step)', async () => {
    mockFrom.mockImplementation(() => rateRead({ rate_pct: 2.25, set_by: 'admin-1' }));
    render(<StandingDiscountControl invoiceId="inv-1" disabled={false} onChanged={vi.fn()} />);
    expect(await screen.findByLabelText('Standing discount for this sale (%)')).toHaveAttribute('step', '0.01');
  });
});

describe('StandingDiscountControl: a save that finishes on another invoice (review round 2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves the next invoice\'s control usable', async () => {
    let releaseSave: (v: unknown) => void = () => {};
    mockFrom.mockImplementation(() => rateRead({ rate_pct: 3, set_by: null }));
    mockRpc.mockImplementation(() => new Promise((resolve) => { releaseSave = resolve; }));
    const { rerender } = render(<StandingDiscountControl invoiceId="inv-a" disabled={false} onChanged={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Standing discount for this sale (%)'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    rerender(<StandingDiscountControl invoiceId="inv-b" disabled={false} onChanged={vi.fn()} />);
    releaseSave({ data: { invoice_id: 'inv-a', rate_pct: 1.5 }, error: null });
    await waitFor(() => expect(screen.getByLabelText('Standing discount for this sale (%)')).toBeEnabled());
  });
});
