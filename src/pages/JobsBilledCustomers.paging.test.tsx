/**
 * JobsBilledCustomers.paging.test.tsx — KI-32 follow-ups (Sol deferrals on PR #1507).
 *
 * 1. The paged get_jobs_billed_customers read sorts on a unique column set, so pages past the
 *    server's 1,000-row cap can neither skip nor repeat a row, and keeps primary-first order.
 * 2. A reply with no list is a failed read (reported, primary-customer fallback), not "no
 *    billed customers".
 * 3. A failed staff or crew name lookup is reported; the list still shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply } from '../test-utils/inMemoryQuery';
import { PAGE_RETURNED_NO_LIST } from '../lib/pagedRead';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  rpcReply: { data: [], error: null } as unknown,
  rpcChains: [] as Array<{ order: { mock: { calls: unknown[][] } } }>,
  toast: vi.fn(),
}));

// A query whose every method chains and whose answer is a read error.
function failingQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'connection reset' }, count: null });
      }
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (H.failing.has(table) ? failingQuery() : buildInMemoryQuery(H.tables[table] ?? [])),
      rpc: (name: string) => {
        const chain = pagedRpcReply(name === 'get_jobs_billed_customers' ? H.rpcReply : { data: [], error: null });
        if (name === 'get_jobs_billed_customers') H.rpcChains.push(chain as unknown as (typeof H.rpcChains)[number]);
        return chain;
      },
    },
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin', profile: { id: 'user-1', role: 'admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import Jobs from './Jobs';
import { Sentry } from '../lib/sentry';

const job = {
  id: 'job-1', job_number: 'JOB-1', status: 'scheduled', job_date: '2026-07-11', total_acres: 40, remaining_acres: 40,
  customer: { farm_name: 'Primary Farm', account_number: '1001', phone: null }, vehicle: null, job_fields: [],
  job_chemicals: [], job_tag_assignments: [], batch: null,
  job_location_dispatches: [{ applicator_id: 'app-1', crew_id: 'crew-1', dispatch_status: 'dispatched' }],
  applicator_id: 'app-1', created_by: null, updated_by: null, last_printed_by: null, deleted_at: null,
};

const sentryActions = () => vi.mocked(Sentry.captureException).mock.calls
  .map((call) => (call[1] as { tags?: { action?: string } } | undefined)?.tags?.action);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  H.failing = new Set();
  H.rpcChains = [];
  H.rpcReply = {
    data: [
      { job_id: 'job-1', customer_id: 'c-1', farm_name: 'Primary Farm', account_number: '1001', is_primary: true },
      { job_id: 'job-1', customer_id: 'c-2', farm_name: 'Split Owner Farm', account_number: '1002', is_primary: false },
    ],
    error: null,
  };
  H.tables = {
    jobs: [job],
    profile_public_view: [{ id: 'app-1', full_name: 'Pat Applicator' }],
    ground_crews: [{ id: 'crew-1', name: 'North Crew' }],
  };
});
afterEach(cleanup);

const renderJobs = () => render(<MemoryRouter initialEntries={['/jobs']}><Jobs /></MemoryRouter>);

describe('Jobs billed-customer read (KI-32 follow-ups)', () => {
  it('pages on a unique order that keeps the primary customer first', async () => {
    renderJobs();
    expect((await screen.findAllByText(/Split Owner Farm/)).length).toBeGreaterThan(0);
    expect(H.rpcChains).toHaveLength(1);
    expect(H.rpcChains[0].order.mock.calls).toEqual([
      ['job_id'],
      ['is_primary', { ascending: false }],
      ['farm_name', { nullsFirst: false }],
      ['customer_id'],
    ]);
    expect(sentryActions()).toEqual([]);
  });

  it('reads billed customers past the 1,000-row server cap', async () => {
    const pad = (i: number) => String(i).padStart(4, '0');
    H.rpcReply = {
      data: Array.from({ length: 1005 }, (_, i) => ({
        job_id: 'job-1', customer_id: `c-${pad(i)}`, farm_name: `Owner ${pad(i)}`, account_number: null, is_primary: i === 0,
      })),
      error: null,
    };
    renderJobs();
    expect((await screen.findAllByText(/Owner 1004/)).length).toBeGreaterThan(0);
    // One request per page: the second starts where the first stopped.
    expect(H.rpcChains.length).toBeGreaterThanOrEqual(2);
    expect((H.rpcChains[1] as unknown as { range: { mock: { calls: unknown[][] } } }).range.mock.calls[0][0]).toBe(1000);
    expect(sentryActions()).toEqual([]);
  });

  it('a reply with no list is reported and the job keeps its primary customer', async () => {
    H.rpcReply = { data: null, error: null };
    renderJobs();
    expect((await screen.findAllByText('JOB-1')).length).toBeGreaterThan(0);
    await waitFor(() => expect(sentryActions()).toContain('load_jobs_billed_customers'));
    const reported = vi.mocked(Sentry.captureException).mock.calls
      .find((call) => (call[1] as { tags: { action: string } }).tags.action === 'load_jobs_billed_customers');
    expect(reported?.[0]).toMatchObject({ message: PAGE_RETURNED_NO_LIST });
    expect(screen.getAllByText(/Primary Farm/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Split Owner Farm/)).not.toBeInTheDocument();
    expect(H.toast).not.toHaveBeenCalledWith('error', 'Failed to load jobs');
  });

  it('failed staff and crew name lookups are reported and the list still shows', async () => {
    H.failing.add('profile_public_view');
    H.failing.add('ground_crews');
    renderJobs();
    expect((await screen.findAllByText('JOB-1')).length).toBeGreaterThan(0);
    await waitFor(() => expect(sentryActions()).toEqual(expect.arrayContaining(['load_jobs_profile_names', 'load_jobs_crew_names'])));
    expect(screen.queryByText(/Pat Applicator/)).not.toBeInTheDocument();
    expect(H.toast).not.toHaveBeenCalledWith('error', 'Failed to load jobs');
  });
});
