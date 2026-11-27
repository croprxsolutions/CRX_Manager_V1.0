import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => ({ reply: vi.fn(), calls: 0 }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabaseUntyped: {
      // The read is paged (rpc → order → range): resolve the mocked reply with a count.
      rpc: (name: string, params: { p_include_dismissed?: boolean }) => {
        if (name === 'get_watchdog_flags') H.calls += 1;
        const q: Record<string, unknown> = {
          order: () => q,
          range: () => q,
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(H.reply(name, params)).then((x: { data: unknown }) => resolve({ ...x, count: Array.isArray(x.data) ? x.data.length : null }), reject),
        };
        return q;
      },
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'user-1', role: 'admin' } }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn(), getKeyFor: () => 'idem', resetKeyFor: vi.fn() }),
}));

import WatchdogExceptions from './WatchdogExceptions';

beforeEach(() => {
  cleanup();
  H.calls = 0;
  H.reply.mockReset();
});

describe('WatchdogExceptions load failure', () => {
  it('a failed get_watchdog_flags read says so, not "No active watchdog flags.", and Try again re-reads', async () => {
    H.reply.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    render(<WatchdogExceptions />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The watchdog flags could not be loaded');
    expect(screen.queryByText('No active watchdog flags.')).not.toBeInTheDocument();

    const callsBefore = H.calls;
    H.reply.mockResolvedValue({ data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByText('No active watchdog flags.')).toBeInTheDocument();
    expect(H.calls).toBeGreaterThan(callsBefore);
    expect(screen.queryByText('The watchdog flags could not be loaded')).not.toBeInTheDocument();
  });

  it('keeps the current flag list when a superseded history read finishes last', async () => {
    let finishHistory!: (result: unknown) => void;
    const history = new Promise((resolve) => { finishHistory = resolve; });
    H.reply.mockImplementation((_name, params) => params.p_include_dismissed ? history : { data: [], error: null });
    render(<WatchdogExceptions />);
    await screen.findByText('No active watchdog flags.');

    const filter = screen.getByRole('checkbox', { name: /Show dismissed/ });
    fireEvent.click(filter);
    await waitFor(() => expect(H.reply).toHaveBeenCalledWith('get_watchdog_flags', expect.objectContaining({ p_include_dismissed: true })));
    fireEvent.click(filter);
    await screen.findByText('No active watchdog flags.');

    await act(async () => {
      finishHistory({ data: [{ id: 'old', flag_type: 'acre_divergence', message: 'Old dismissed flag', is_dismissed: true }], error: null });
      await history;
    });
    expect(screen.queryByText('Old dismissed flag')).not.toBeInTheDocument();
  });

  it('says when a manual sweep fails instead of silently leaving the old flags', async () => {
    H.reply.mockImplementation((name) => name === 'refresh_watchdog_flags'
      ? { data: null, error: { message: 'connection reset' } }
      : { data: [], error: null });
    render(<WatchdogExceptions />);
    await screen.findByText('No active watchdog flags.');
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The watchdog sweep could not be completed');
    expect(screen.getByRole('button', { name: 'Run sweep' })).toBeEnabled();
  });
});
