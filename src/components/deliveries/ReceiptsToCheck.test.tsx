import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const answers: Array<{ data: unknown; error: unknown }> = [];
const query = {
  select: () => query,
  or: () => query,
  gte: () => query,
  order: () => query,
  limit: () => Promise.resolve(answers.shift() ?? { data: [], error: null }),
};
vi.mock('../../lib/db', () => ({ supabase: { from: () => query } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import ReceiptsToCheck from './ReceiptsToCheck';

const row = (i: number) => ({
  id: `r${i}`, delivery_id: `d${i}`, status: 'needs_check', last_error: 'Bounced', created_at: '2026-11-08T12:00:00Z',
  deliveries: { delivery_number: `D-${i}` }, customers: { farm_name: 'Farm' },
});
const show = () => render(<MemoryRouter><ReceiptsToCheck /></MemoryRouter>);

describe('ReceiptsToCheck', () => {
  beforeEach(() => { answers.length = 0; });

  it('says so when the list fails to load instead of showing nothing', async () => {
    answers.push({ data: null, error: { message: 'denied' } });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
  });

  it('flags that more receipts exist past the first 50', async () => {
    answers.push({ data: Array.from({ length: 51 }, (_, i) => row(i)), error: null });
    show();
    expect(await screen.findByText(/receipts to check \(50\+\)/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText(/Only the newest 50 are shown/)).toBeInTheDocument();
  });

  it('re-checks when the office returns to the tab, so a receipt sent since drops off', async () => {
    answers.push({ data: [row(1)], error: null }, { data: [], error: null });
    show();
    expect(await screen.findByText('D-1')).toBeInTheDocument();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(screen.queryByText('D-1')).not.toBeInTheDocument());
  });
});
