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
vi.mock('../../lib/db', () => ({ supabase: { from: () => query } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import ReceiptsToCheck from './ReceiptsToCheck';

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `r${i}`, delivery_id: `d${i}`, status: 'needs_check', last_error: 'Bounced', created_at: '2026-11-08T12:00:00Z',
  deliveries: { delivery_number: `D-${i}`, status: 'completed' }, customers: { farm_name: 'Farm', email: 'a@b.co' },
  ...over,
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));
const show = () => render(<MemoryRouter><ReceiptsToCheck /></MemoryRouter>);

describe('ReceiptsToCheck', () => {
  beforeEach(() => { answers.length = 0; ranges.length = 0; });

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
