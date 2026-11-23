import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Answer = { data: unknown; error: unknown; count?: number | null };
const answers: Array<Answer | Promise<Answer>> = [];
const ranges: Array<[number, number]> = [];
const query = {
  select: () => query,
  or: () => query,
  order: () => query,
  range: (from: number, to: number) => {
    ranges.push([from, to]);
    return Promise.resolve(answers.shift() ?? { data: [], error: null, count: 0 });
  },
};
const rpc = vi.fn();
const toast = vi.fn();
vi.mock('../../lib/db', () => ({
  supabase: { from: () => query },
  supabaseUntyped: { rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: (data: unknown) => data,
  sanitizeError: (e: { message?: string }) => e?.message ?? 'error',
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'u1' } }) }));

import ReceiptsToCheck from './ReceiptsToCheck';

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `r${i}`, delivery_id: `d${i}`, status: 'needs_check', last_error: 'Bounced', created_at: '2026-11-08T12:00:00Z',
  deliveries: { delivery_number: `D-${i}`, status: 'completed' }, customers: { farm_name: 'Farm', email: 'a@b.co' },
  ...over,
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));
const show = () => render(<MemoryRouter><ReceiptsToCheck /></MemoryRouter>);

describe('ReceiptsToCheck', () => {
  beforeEach(() => { answers.length = 0; ranges.length = 0; rpc.mockReset(); toast.mockReset(); });

  it('marks a receipt handled after confirming, once even on a double click, and reloads the list', async () => {
    let finishClose: (a: { data: unknown; error: unknown }) => void = () => {};
    rpc.mockReturnValueOnce(new Promise((resolve) => { finishClose = resolve; }));
    answers.push({ data: [row(1)], error: null, count: 1 }, { data: [], error: null, count: 0 });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark receipt for D-1 handled' }));
    expect(rpc).not.toHaveBeenCalled(); // asks first
    const confirm = await screen.findByRole('button', { name: 'Mark handled' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('close_delivery_receipt');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_delivery_id: 'd1', p_reason: 'handled', p_expected_queued_at: '2026-11-08T12:00:00Z' });
    await act(async () => {
      finishClose({ data: { delivery_id: 'd1', outcome: 'closed', previous_status: 'needs_check', sent_at: null, send_authorized_at: null }, error: null });
    });
    await waitFor(() => expect(screen.queryByText('D-1')).not.toBeInTheDocument());
    expect(toast).toHaveBeenCalledWith('success', 'Receipt marked handled. The server will not email it.');
    expect(ranges).toHaveLength(2);
  });

  it('says to try again in a minute while the server is emailing it, and keeps the row', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'DELIVERY_RECEIPT_SENDING: this delivery receipt is being emailed right now' } });
    answers.push({ data: [row(1)], error: null, count: 1 });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark receipt for D-1 handled' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('warning', 'The server is emailing this receipt right now. Try again in a minute.'));
    expect(screen.getByText('D-1')).toBeInTheDocument();
    expect(ranges).toHaveLength(1);
  });

  it('when the receipt was queued again since the list loaded, closes nothing, says so and reloads (#2251)', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "DELIVERY_RECEIPT_CHANGED: this delivery's receipt was queued again since; reload the page" } });
    answers.push({ data: [row(1)], error: null, count: 1 }, { data: [], error: null, count: 0 });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark receipt for D-1 handled' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('warning', expect.stringMatching(/changed since the list loaded. Nothing was closed/)));
    await waitFor(() => expect(ranges).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Mark handled' })).not.toBeInTheDocument();
  });

  it('says so when the list fails to load instead of showing nothing', async () => {
    answers.push({ data: null, error: { message: 'denied' } });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
  });

  it('shows the full count and lets the office reach every receipt past the first 50', async () => {
    let finishMore: (a: Answer) => void = () => {};
    answers.push({ data: rows(50), error: null, count: 51 }, new Promise<Answer>((resolve) => { finishMore = resolve; }));
    show();
    expect(await screen.findByText(/receipts to check \(51\)/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(ranges[0]).toEqual([0, 49]);
    const more = screen.getByRole('button', { name: /Show more \(1 not shown\)/ });
    fireEvent.click(more);
    await waitFor(() => expect(more).toBeDisabled()); // a second click cannot start an overlapping read
    fireEvent.click(more);
    await act(async () => { finishMore({ data: rows(51), error: null, count: 51 }); });
    expect(await screen.findByText('D-50')).toBeInTheDocument();
    expect(ranges).toEqual([[0, 49], [0, 99]]);
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });

  it('says what to do when Email Confirmation will not be on the delivery page', async () => {
    answers.push({
      data: [
        row(1, { customers: { farm_name: 'Farm', email: null } }),
        row(2, { deliveries: { delivery_number: 'D-2', status: 'cancelled' } }),
        row(3),
      ],
      error: null, count: 3,
    });
    show();
    expect(await screen.findByText(/No customer email on file/)).toBeInTheDocument();
    expect(screen.getByText(/no longer completed/)).toBeInTheDocument();
    expect(screen.getAllByText(/Bounced/)).toHaveLength(3);
  });

  it('re-checks when the office returns to the tab, so a receipt sent since drops off', async () => {
    answers.push({ data: [row(1)], error: null, count: 1 }, { data: [], error: null, count: 0 });
    show();
    expect(await screen.findByText('D-1')).toBeInTheDocument();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(screen.queryByText('D-1')).not.toBeInTheDocument());
  });

  it('a slow older answer does not overwrite a newer one', async () => {
    let finishOld: (a: Answer) => void = () => {};
    answers.push(new Promise<Answer>((resolve) => { finishOld = resolve; }), { data: [row(2)], error: null, count: 1 });
    show();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('D-2')).toBeInTheDocument();
    await act(async () => { finishOld({ data: [row(1)], error: null, count: 1 }); });
    expect(screen.queryByText('D-1')).not.toBeInTheDocument();
    expect(screen.getByText('D-2')).toBeInTheDocument();
  });
});
