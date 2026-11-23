/**
 * JobDetail: deleted jobs (#2188) and refused job actions (#2174). Harness copied from
 * JobDetail.recordBinding.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, mockNavigate } = vi.hoisted(() => ({
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
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
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

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = () => resolve(); });
  return { promise, release };
}

let jobsCalls = 0;
function serveJob(job: Record<string, unknown>) {
  jobsCalls = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') { jobsCalls += 1; return buildChain({ data: job, error: null }); }
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
});

describe('JobDetail — refused cancel (#2174)', () => {
  it('locks editing when the job is already cancelled, keeping typed text and not reloading', async () => {
    serveJob(makeJob({}));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'edit_jobs'
      ? editJobsReply([{ id: 'job-x', reason: 'status', status: 'cancelled' }])
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    fireEvent.change(screen.getByDisplayValue('saved notes'), { target: { value: 'typed meanwhile' } });
    await confirmCancel();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Save Changes/ })).toBeNull());
    expect(screen.getByDisplayValue('typed meanwhile')).toBeTruthy();
    expect(jobsCalls).toBe(1);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('shows a job deleted meanwhile as deleted', async () => {
    serveJob(makeJob({}));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'edit_jobs'
      ? editJobsReply([{ id: 'job-x', reason: 'deleted' }])
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    await confirmCancel();
    expect(await screen.findByText(/This job was deleted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save Changes/ })).toBeNull();
  });

  it('logs job_cancelled when a retry finds the cancel a lost reply committed', async () => {
    serveJob(makeJob({}));
    let calls = 0;
    mockRpc.mockImplementation((fn: string) => {
      if (fn !== 'edit_jobs') return Promise.resolve({ data: null, error: null });
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('Failed to fetch'))
        : Promise.resolve(editJobsReply([{ id: 'job-x', reason: 'status', status: 'cancelled' }]));
    });
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    await confirmCancel();
    await waitFor(() => expect(calls).toBe(1));
    expect(logActivity).not.toHaveBeenCalled();
    await confirmCancel();
    await waitFor(() => expect(logActivity).toHaveBeenCalledTimes(1));
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ event: 'job_cancelled' }));
  });

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

describe('JobDetail — crew/loader refusal after save (#2174)', () => {
  it('keeps text typed during the save instead of reloading over it', async () => {
    serveJob(makeJob({}));
    const saveGate = deferred();
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'save_job') return saveGate.promise.then(() => ({ data: { job_id: 'job-x' }, error: null }));
      if (fn === 'edit_jobs') return Promise.resolve(editJobsReply([{ id: 'job-x', reason: 'deleted' }]));
      return Promise.resolve({ data: null, error: null });
    });
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    fireEvent.change(screen.getByLabelText('Ground crew'), { target: { value: 'crew-1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_job', expect.anything()));
    fireEvent.change(screen.getByDisplayValue('saved notes'), { target: { value: 'typed during save' } });
    await act(async () => { saveGate.release(); await saveGate.promise; });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/crew\/loader settings did not save/)));
    expect(screen.getByDisplayValue('typed during save')).toBeTruthy();
    expect(jobsCalls).toBe(1);
    expect(await screen.findByText(/This job was deleted/)).toBeTruthy();
  });

  it('reloads as before when nothing was typed during the save', async () => {
    serveJob(makeJob({}));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'save_job'
      ? { data: { job_id: 'job-x' }, error: null }
      : fn === 'edit_jobs' ? editJobsReply([{ id: 'job-x', reason: 'status', status: 'invoiced' }]) : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    fireEvent.change(screen.getByLabelText('Ground crew'), { target: { value: 'crew-1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
    await waitFor(() => expect(jobsCalls).toBe(2));
  });
});
