/**
 * JobDetail: deleted jobs open read-only (#2188). Harness copied from
 * JobDetail.recordBinding.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, mockNavigate, dirty } = vi.hoisted(() => ({
  dirty: { value: false },
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
}));

const CHAIN_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
  'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
  'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
  'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
  'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];

function chainShell(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of CHAIN_METHODS) self[m] = method;
  return self;
}

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self = chainShell();
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
    supabaseUntyped: { from: mockFrom, rpc: mockRpc },
    checkMutationResult: vi.fn(),
    assertRpcResult: vi.fn((d) => d),
    sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn(), getKeyFor: () => 'test-idem-key', resetKeyFor: vi.fn() }),
}));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: () => {} }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: (isDirty: boolean) => { dirty.value = isDirty; return { state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }; },
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/criticalAction', () => ({
  runCriticalAction: async ({ action, setLoading }: {
    action: () => Promise<void>; setLoading?: (v: boolean) => void;
  }) => { setLoading?.(true); try { await action(); } finally { setLoading?.(false); } },
}));
vi.mock('../lib/dateUtils', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, todayInBusinessTz: () => '2026-08-19' };
});

import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import JobDetail from './JobDetail';

import { logActivity } from '../lib/activityLogger';

function makeJob(overrides: Record<string, unknown>) {
  return {
    id: 'job-x',
    job_number: 'J-0001',
    job_date: '2026-08-19',
    customer_id: 'cust-1',
    applicator_id: null,
    status: 'scheduled',
    deleted_at: null,
    notes: 'saved notes',
    loader_tank_capacity: 500,
    customer: { farm_name: 'Farm Alpha' },
    vehicle: null,
    quote: null,
    quote_section: null,
    job_fields: [],
    job_chemicals: [],
    job_field_shares: [],
    applied_info: null,
    ...overrides,
  };
}

function mountAt(path: string) {
  const router = createMemoryRouter([{ path: '/jobs/:id', element: <JobDetail /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

// jobsCalls counts page loads. The later job is served from the second load on.
let jobsCalls = 0;
function serveJob(job: Record<string, unknown>, later: Record<string, unknown> = job) {
  jobsCalls = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') {
      jobsCalls += 1;
      return buildChain({ data: jobsCalls === 1 ? job : later, error: null });
    }
    if (table === 'ground_crews') return buildChain({ data: [{ id: 'crew-1', name: 'Crew One' }], error: null });
    return buildChain({ data: [], error: null });
  });
}

const editJobsReply = (skipped: unknown[]) => ({
  data: { updated: [], cancelled: [], deleted: [], skipped }, error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

async function confirmCancel() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Cancel Job/ })); });
  const buttons = screen.getAllByRole('button', { name: /Cancel Job/ });
  await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
}

describe('JobDetail — deleted job (#2188)', () => {
  it('shows a deleted job as deleted and offers nothing that changes it', async () => {
    serveJob(makeJob({ deleted_at: '2026-11-21T15:00:00Z' }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    expect(await screen.findByText(/This job was deleted/)).toBeTruthy();
    expect(screen.getByText('deleted')).toBeTruthy();
    for (const name of [/Cancel Job/, /Start Job/, /Complete Job/, /Save Changes/, /Transfer to Invoice/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect((screen.getByDisplayValue('saved notes') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('a live job still offers its actions', async () => {
    serveJob(makeJob({}));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    expect(screen.queryByText(/This job was deleted/)).toBeNull();
    expect(screen.getByRole('button', { name: /Cancel Job/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Save Changes/ })).toBeTruthy();
  });

  it('shows the day it was deleted in Crop RX business time', async () => {
    // 03:00Z on Nov 2 is still Nov 1 in the business time zone (Sol LOW).
    serveJob(makeJob({ deleted_at: '2026-11-02T03:00:00Z' }));
    mountAt('/jobs/job-x');
    expect(await screen.findByText(/deleted on 11\/1\/2026/)).toBeTruthy();
  });

  it('a save that finds the job deleted meanwhile reloads it as deleted and locked', async () => {
    serveJob(makeJob({}), makeJob({ deleted_at: '2026-11-02T15:00:00Z' }));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'save_job'
      ? { data: { job_id: 'job-x' }, error: null }
      : fn === 'edit_jobs' ? editJobsReply([{ id: 'job-x', reason: 'deleted' }]) : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    fireEvent.change(screen.getByLabelText('Ground crew'), { target: { value: 'crew-1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
    expect(await screen.findByText(/deleted on 11\/2\/2026/)).toBeTruthy();
    expect(jobsCalls).toBe(2);
    for (const name of [/Save Changes/, /Cancel Job/, /Start Job/, /Complete Job/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('JobDetail — refused cancel', () => {
  it('does not log a cancel when the job was already cancelled by someone else', async () => {
    serveJob(makeJob({}));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'edit_jobs'
      ? editJobsReply([{ id: 'job-x', reason: 'status', status: 'cancelled' }])
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    await confirmCancel();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('info', expect.stringMatching(/already cancelled/)));
    expect(logActivity).not.toHaveBeenCalled();
  });
});

describe('JobDetail — expired-license Assign Anyway (#2174)', () => {
  it('refuses an out-of-range loader number typed while the prompt was open', async () => {
    serveJob(makeJob({}));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'save_job'
      ? { data: null, error: { code: 'P0001', message: 'LICENSE_EXPIRED: applicator license expired 2020-01-01', details: null, hint: null } }
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
    await screen.findByText('Applicator License Expired');
    const carrier = (await screen.findByText('Carrier Rate (gal/acre)')).parentElement!.querySelector('input')!;
    fireEvent.change(carrier, { target: { value: '-5' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Assign Anyway/ })); });
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/Loader Worksheet/));
    expect(mockRpc.mock.calls.filter((c) => c[0] === 'save_job')).toHaveLength(1);
  });
});
