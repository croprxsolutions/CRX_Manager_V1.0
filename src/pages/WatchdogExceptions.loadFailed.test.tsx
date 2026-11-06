import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({ reply: vi.fn(), calls: 0 }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabaseUntyped: {
      // The read is paged (rpc → order → range): resolve the mocked reply with a count.
      rpc: (name: string) => {
        if (name === 'get_watchdog_flags') H.calls += 1;
        const q: Record<string, unknown> = {
          order: () => q,
          range: () => q,
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(H.reply()).then((x: { data: unknown }) => resolve({ ...x, count: Array.isArray(x.data) ? x.data.length : null }), reject),
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
});
