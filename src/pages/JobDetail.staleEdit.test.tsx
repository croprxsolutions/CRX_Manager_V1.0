/**
 * JobDetail — a save over someone else's newer change is refused (Mason, 2026-11-23).
 *
 * Before this, two people editing one job meant the last Save silently won: the second person's stale
 * applicator, date or crew replaced the first person's. Save now re-reads the job and refuses, saving
 * nothing, when a checked value moved since the page loaded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

const CHAIN_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
  'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
  'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
  'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
  'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const m of CHAIN_METHODS) self[m] = () => self;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    supabase: { from: mockFrom, rpc: mockRpc, storage: { from: vi.fn() } },
    checkMutationResult: vi.fn(),
    assertRpcResult: vi.fn((d) => d),
    sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'k', resetKey: vi.fn(), getKeyFor: () => 'k', resetKeyFor: vi.fn() }),
}));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: () => {} }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import JobDetail from './JobDetail';
import { JOB_CHANGED_SINCE_LOADED_MESSAGE } from '../lib/jobStaleEdit';

const JOB = {
  id: 'job-a', job_number: 'J-AAAA-1001', job_date: '2026-03-01', customer_id: 'cust-1',
  applicator_id: null, ground_crew_id: null, status: 'scheduled', notes: 'A notes',
  customer: { farm_name: 'Farm Alpha' }, vehicle: null, quote: null, quote_section: null,
  job_fields: [], job_chemicals: [], job_field_shares: [], applied_info: null,
};

/** First jobs read = the page load; every later one = the pre-save re-read, answered with `current`. */
function serveJob(current: Record<string, unknown>) {
  let jobsCalls = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') {
      jobsCalls += 1;
      return buildChain({ data: jobsCalls === 1 ? JOB : current, error: null });
    }
    return buildChain({ data: [], error: null });
  });
}

async function openAndSave() {
  const router = createMemoryRouter([{ path: '/jobs/:id', element: <JobDetail /> }], { initialEntries: ['/jobs/job-a'] });
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'J-AAAA-1001' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'save_job'
    ? { data: { job_id: 'job-a' }, error: null }
    : { data: null, error: null }));
});

describe('JobDetail stale-edit refusal', () => {
  it.each([
    ['applicator', { applicator_id: 'other-applicator' }],
    ['date', { job_date: '2026-03-09' }],
    ['crew', { ground_crew_id: 'crew-2' }],
  ])('refuses the save when someone else changed the %s after the page loaded', async (_label, change) => {
    serveJob({ ...JOB, ...change });
    await openAndSave();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE));
    expect(mockRpc).not.toHaveBeenCalledWith('save_job', expect.anything());
  });

  it('saves normally when nothing changed underneath', async () => {
    serveJob(JOB);
    await openAndSave();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_job', expect.anything()));
    expect(mockToast).not.toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE);
  });
});
