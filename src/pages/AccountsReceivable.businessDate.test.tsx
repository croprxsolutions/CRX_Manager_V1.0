/**
 * AccountsReceivable.businessDate.test.tsx — the summary strip and the AR Aging table ask for
 * the same day: Chicago's.
 *
 * The strip used to ask get_ar_aging for `new Date().toISOString().slice(0, 10)`, a UTC date.
 * From about 7pm Central UTC is already tomorrow, so the strip asked for tomorrow's aging
 * while the table under it asked for today's. The clock below is pinned to 8:30pm Central,
 * and the computer's own timezone to UTC, so a screen reading either clock asks for the
 * wrong day here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({ rpcCalls: [] as Array<[string, unknown]> }));

// Every query chain, table or function, answers with no rows.
const emptyReply = () => {
  const chain: object = new Proxy({}, {
    get: (_target, prop) => (prop === 'then'
      ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject)
      : () => chain),
  });
  return chain;
};

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: () => emptyReply(),
      rpc: (name: string, args: unknown) => {
        H.rpcCalls.push([name, args]);
        return emptyReply();
      },
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import AccountsReceivable from './AccountsReceivable';

const originalTz = process.env.TZ;

beforeEach(() => {
  H.rpcCalls = [];
  // A computer set to UTC (as CI is, or a viewer's laptop could be).
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  // 8:30pm Central (CDT, UTC-5) on Tuesday 2026-10-20 is 01:30 UTC on Wednesday 2026-10-21.
  vi.setSystemTime(new Date('2026-10-21T01:30:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

describe('Accounts Receivable in the evening, Central time', () => {
  it("the summary strip and the AR Aging tab both ask for Chicago's date, not tomorrow's", async () => {
    render(<MemoryRouter initialEntries={['/']}><AccountsReceivable /></MemoryRouter>);

    // One call from the strip, one from the AR Aging tab (the default tab).
    await waitFor(() => expect(H.rpcCalls.filter(([name]) => name === 'get_ar_aging').length).toBeGreaterThanOrEqual(2));
    const asOfDates = H.rpcCalls
      .filter(([name]) => name === 'get_ar_aging')
      .map(([, args]) => (args as { p_as_of_date: string }).p_as_of_date);
    expect(new Set(asOfDates)).toEqual(new Set(['2026-10-20']));
  });
});
