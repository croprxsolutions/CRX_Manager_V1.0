/**
 * JobDetail: deleted jobs (#2188) and refused job actions (#2174). Harness copied from
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

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = () => resolve(); });
  return { promise, release };
}

// jobsCalls counts page loads. `later` is served from the second load on; `laterGate` holds that load.
let jobsCalls = 0;
function serveJob(job: Record<string, unknown>, later: Record<string, unknown> = job, laterGate?: Promise<void>) {
  jobsCalls = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') {
      const chain = chainShell();
      chain.select = () => {
        jobsCalls += 1;
        if (jobsCalls === 1 || !laterGate) return buildChain({ data: jobsCalls === 1 ? job : later, error: null });
        const held = chainShell();
        const p = laterGate.then(() => ({ data: later, error: null }));
        held.then = p.then.bind(p);
        return held;
      };
      return chain;
    }
    if (table === 'ground_crews') return buildChain({ data: [{ id: 'crew-1', name: 'Crew One' }], error: null });
    return buildChain({ data: [], error: null });
  });
}

const notSavedBox = () => screen.queryByText((_, el) => el?.tagName === 'PRE');
const notificationLoads = () => mockFrom.mock.calls.filter((c) => c[0] === 'job_notifications').length;

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
  it('reloads the job as saved and keeps what was typed in a copyable Not-saved box (Mason)', async () => {
    serveJob(makeJob({}), makeJob({ status: 'cancelled' }));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'edit_jobs'
      ? editJobsReply([{ id: 'job-x', reason: 'status', status: 'cancelled' }])
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    const noticeLoadsBefore = notificationLoads();
    fireEvent.change(screen.getByDisplayValue('saved notes'), { target: { value: 'typed meanwhile' } });
    await confirmCancel();
    await waitFor(() => expect(jobsCalls).toBe(2));
    await waitFor(() => expect(notSavedBox()?.textContent).toBe('Job Notes:\ntyped meanwhile'));
    expect(screen.getByText(/was/).textContent).toMatch(/not saved/);
    // The form now shows the job as saved; the notice log is re-read too (Sol r2 MED).
    expect(screen.getByDisplayValue('saved notes')).toBeTruthy();
    expect(notificationLoads()).toBeGreaterThan(noticeLoadsBefore);
    expect(screen.getByText('cancelled')).toBeTruthy();
    expect(dirty.value).toBe(false);
    expect(logActivity).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(notSavedBox()).toBeNull();
  });

  it('keeps typing done while the reload is in flight (Sol r2 HIGH)', async () => {
    const reloadGate = deferred();
    serveJob(makeJob({}), makeJob({ status: 'completed' }), reloadGate.promise);
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'edit_jobs'
      ? editJobsReply([{ id: 'job-x', reason: 'status', status: 'completed' }])
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    await confirmCancel();
    await waitFor(() => expect(jobsCalls).toBe(2));
    fireEvent.change(screen.getByDisplayValue('saved notes'), { target: { value: 'typed during reload' } });
    await act(async () => { reloadGate.release(); await reloadGate.promise; });
    await waitFor(() => expect(notSavedBox()?.textContent).toBe('Job Notes:\ntyped during reload'));
    expect(screen.getByDisplayValue('saved notes')).toBeTruthy();
  });

  it('shows no Not-saved box when nothing was typed', async () => {
    serveJob(makeJob({}), makeJob({ status: 'completed' }));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'edit_jobs'
      ? editJobsReply([{ id: 'job-x', reason: 'status', status: 'completed' }])
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    await confirmCancel();
    await waitFor(() => expect(jobsCalls).toBe(2));
    await waitFor(() => expect(screen.getByText('completed')).toBeTruthy());
    expect(notSavedBox()).toBeNull();
  });

  it('locks a job refused as deleted at once, before the reload lands (Luna r5 HIGH)', async () => {
    const reloadGate = deferred();
    serveJob(makeJob({}), makeJob({ deleted_at: '2026-11-02T15:00:00Z' }), reloadGate.promise);
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'edit_jobs'
      ? editJobsReply([{ id: 'job-x', reason: 'deleted' }])
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    await confirmCancel();
    // The reload is still pending, yet the page is already locked.
    expect(await screen.findByText(/This job was deleted\. It is kept/)).toBeTruthy();
    for (const name of [/Save Changes/, /Cancel Job/, /Start Job/, /Complete Job/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    await act(async () => { reloadGate.release(); await reloadGate.promise; });
    expect(await screen.findByText(/deleted on 11\/2\/2026/)).toBeTruthy();
  });

  it('shows a job deleted meanwhile as deleted, on the day it was deleted', async () => {
    serveJob(makeJob({}), makeJob({ deleted_at: '2026-11-02T03:00:00Z' }));
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'edit_jobs'
      ? editJobsReply([{ id: 'job-x', reason: 'deleted' }])
      : { data: null, error: null }));
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    await confirmCancel();
    // 03:00Z on Nov 2 is still Nov 1 in Crop RX's business time zone (Sol LOW).
    expect(await screen.findByText(/deleted on 11\/1\/2026/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save Changes/ })).toBeNull();
  });

  it('a lost reply reloads the job, and the retry does not guess who cancelled (Mason, Sol r2 MED)', async () => {
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
    await waitFor(() => expect(jobsCalls).toBe(2));
    await confirmCancel();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('info', expect.stringMatching(/already cancelled/)));
    expect(logActivity).not.toHaveBeenCalled();
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
  it('a job deleted meanwhile reloads as deleted, keeping text typed during the save', async () => {
    serveJob(makeJob({}), makeJob({ deleted_at: '2026-11-02T15:00:00Z' }));
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
    expect(await screen.findByText(/deleted on 11\/2\/2026/)).toBeTruthy();
    await waitFor(() => expect(notSavedBox()?.textContent).toBe('Job Notes:\ntyped during save'));
    expect(jobsCalls).toBe(2);
  });

  it('a partial save while typing reloads at once and keeps the typed text (Mason)', async () => {
    serveJob(makeJob({}));
    const saveGate = deferred();
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'save_job') return saveGate.promise.then(() => ({ data: { job_id: 'job-x' }, error: null }));
      if (fn === 'edit_jobs') return Promise.reject(new Error('Failed to fetch'));
      return Promise.resolve({ data: null, error: null });
    });
    mountAt('/jobs/job-x');
    await screen.findByRole('heading', { name: 'J-0001' });
    fireEvent.change(screen.getByLabelText('Ground crew'), { target: { value: 'crew-1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_job', expect.anything()));
    fireEvent.change(screen.getByDisplayValue('saved notes'), { target: { value: 'typed during save' } });
    await act(async () => { saveGate.release(); await saveGate.promise; });
    await waitFor(() => expect(jobsCalls).toBe(2));
    await waitFor(() => expect(notSavedBox()?.textContent).toBe('Job Notes:\ntyped during save'));
    expect(screen.getByDisplayValue('saved notes')).toBeTruthy();
    expect((screen.getByDisplayValue('saved notes') as HTMLTextAreaElement).disabled).toBe(false);
    await waitFor(() => expect(dirty.value).toBe(false));
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
    expect(notSavedBox()).toBeNull();
  });
});
