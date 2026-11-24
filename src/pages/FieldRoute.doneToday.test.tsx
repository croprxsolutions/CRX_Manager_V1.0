/**
 * FieldRoute.doneToday.test.tsx: My Route's "Done today" list (so a driver can check a finished stop saved),
 * its honest no-signal message, and notes a driver can read in sunlight.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FieldRoute from './FieldRoute';

const { env, mockNavigate, results, fromCalls } = vi.hoisted(() => ({
  env: { online: true },
  mockNavigate: vi.fn(),
  results: { open: [] as unknown[], done: [] as unknown[], doneError: null as unknown },
  fromCalls: [] as string[][],
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...(actual as object), useNavigate: () => mockNavigate };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'u1', role: 'admin' } }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => env.online }));
vi.mock('../lib/offlineQueue', () => ({
  getQueueSummary: () => Promise.resolve({
    ownedTotal: 0, ownedAutoSyncable: 0, ownedNeedsAttention: 0, ownedOfficeResolved: 0,
    otherUserTotal: 0, ownerUnknownTotal: 0, nextAutoSyncAt: null,
  }),
}));
// One chain per query; a query that asks for completed stops is the Done today read.
vi.mock('../lib/db', () => ({
  supabase: {
    from: () => {
      const calls: string[] = [];
      fromCalls.push(calls);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'is', 'in', 'eq', 'gte', 'order']) {
        chain[m] = (...args: unknown[]) => { calls.push(`${m}:${JSON.stringify(args)}`); return chain; };
      }
      chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const isDone = calls.some((c) => c.startsWith('eq:["status","completed"]'));
        const result = isDone
          ? { data: results.doneError ? null : results.done, error: results.doneError }
          : { data: results.open, error: null };
        return Promise.resolve(result).then(ok, bad);
      };
      return chain;
    },
  },
}));

beforeEach(() => {
  env.online = true;
  mockNavigate.mockReset();
  fromCalls.length = 0;
  results.open = [{
    id: 'd1', delivery_number: 'DEL-001', status: 'scheduled', scheduled_date: '2026-11-24', scheduled_time: null,
    priority: 'normal', assigned_driver: 'u1', customer_id: 'c1', customer: { farm_name: 'Wells Farm' },
    delivery_notes: 'Gate code 4471 — use the east gate past the grain bins, not the house drive',
  }];
  results.done = [{
    id: 'd9', delivery_number: 'DEL-009', customer_id: 'c2', completed_at: '2026-11-24T15:30:00Z', signed_by: 'Pat Lane',
    customer: { farm_name: 'Done Farm' },
  }];
  results.doneError = null;
});

describe('FieldRoute: Done today', () => {
  it('lists stops completed today when opened, and does not read them until then', async () => {
    render(<MemoryRouter><FieldRoute /></MemoryRouter>);
    expect(await screen.findByText('Wells Farm')).toBeInTheDocument();
    expect(fromCalls.some((calls) => calls.includes('eq:["status","completed"]'))).toBe(false);
    expect(screen.queryByText('Done Farm')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /Done today/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(await screen.findByText('Done Farm')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('DEL-009')).toBeInTheDocument();
    expect(screen.getByText('Signed by Pat Lane')).toBeInTheDocument();
    // The finished stop is still not on the open list.
    expect(screen.getAllByText('Wells Farm')).toHaveLength(1);
  });

  it('opens a finished stop read-only in its delivery detail', async () => {
    render(<MemoryRouter><FieldRoute /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Done today/ }));
    fireEvent.click(await screen.findByText('Done Farm'));
    expect(mockNavigate).toHaveBeenCalledWith('/deliveries/d9');
  });

  it('says so when nothing is finished yet, and offers a retry when the read fails', async () => {
    results.done = [];
    const { unmount } = render(<MemoryRouter><FieldRoute /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Done today/ }));
    expect(await screen.findByText('No stops completed yet today.')).toBeInTheDocument();
    unmount();

    results.doneError = new Error('boom');
    render(<MemoryRouter><FieldRoute /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Done today/ }));
    expect(await screen.findByText("Couldn't load today's finished stops.")).toBeInTheDocument();
    results.doneError = null;
    results.done = [{ id: 'd9', delivery_number: 'DEL-009', customer_id: 'c2', completed_at: null, signed_by: null, customer: { farm_name: 'Done Farm' } }];
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' }).at(-1)!);
    expect(await screen.findByText('Done Farm')).toBeInTheDocument();
  });
});

describe('FieldRoute: readable and honest', () => {
  it('shows delivery notes full size, dark and wrapped instead of cut to one line', async () => {
    render(<MemoryRouter><FieldRoute /></MemoryRouter>);
    const notes = await screen.findByText(/Gate code 4471/);
    expect(notes).toHaveClass('text-base', 'text-gray-900', 'whitespace-pre-wrap');
    expect(notes).not.toHaveClass('truncate');
    expect(notes).not.toHaveClass('text-gray-400');
  });

  it('gives the Refresh button a 44px touch target', async () => {
    render(<MemoryRouter><FieldRoute /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Refresh stops' })).toHaveClass('min-h-[44px]', 'min-w-[44px]');
  });

  it('never claims changes save on the phone when there is no signal', async () => {
    env.online = false;
    render(<MemoryRouter><FieldRoute /></MemoryRouter>);
    expect(await screen.findByText(/nothing on your route is saved offline/)).toBeInTheDocument();
    expect(screen.queryByText(/save locally/)).not.toBeInTheDocument();
  });
});
