/**
 * JobDetail — a save over someone else's newer change is refused (Mason, 2026-11-23).
 *
 * The page reads the job's edit version (job_edit_version) before its job select and sends it with Save as
 * expected_version; save_job refuses JOB_CHANGED_SINCE_LOADED under the job row lock when the job moved
 * (database proof: scripts/smoke/prove-job-save-version-real-schema.mjs). These tests prove the page's half.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, eqCalls, selectCalls } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  eqCalls: [] as unknown[][],
  selectCalls: [] as unknown[],
}));

const CHAIN_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
  'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
  'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
  'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
  'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const m of CHAIN_METHODS) self[m] = () => self;
  self.eq = (...args: unknown[]) => { eqCalls.push(args); return self; };
  self.select = (cols: unknown) => { selectCalls.push(cols); return self; };
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
import { JOB_CHANGED_SINCE_LOADED_MESSAGE, withOwnDispatches } from '../lib/jobStaleEdit';

const JOB = {
  id: 'job-a', job_number: 'J-AAAA-1001', job_date: '2026-03-01', customer_id: 'cust-1',
  applicator_id: null, ground_crew_id: null, status: 'scheduled', notes: 'A notes',
  customer: { farm_name: 'Farm Alpha' }, vehicle: null, quote: null, quote_section: null,
  job_fields: [], job_chemicals: [], job_field_shares: [], applied_info: null,
};
const VERSION = { core: 'abc123', dispatches: ['jf1|app-1||dispatched'] };

let order: string[] = [];
let versionResult: { data: unknown; error: unknown } = { data: VERSION, error: null };
let saveResult: { data: unknown; error: unknown } = { data: { job_id: 'job-a' }, error: null };

function savePayloads() {
  return mockRpc.mock.calls.filter(([fn]) => fn === 'save_job').map(([, args]) => (args as { p_job_payload: Record<string, unknown> }).p_job_payload);
}

async function clickSave() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
}

async function openJob() {
  const router = createMemoryRouter([{ path: '/jobs/:id', element: <JobDetail /> }], { initialEntries: ['/jobs/job-a'] });
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'J-AAAA-1001' });
}

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
  selectCalls.length = 0;
  order = [];
  versionResult = { data: VERSION, error: null };
  saveResult = { data: { job_id: 'job-a' }, error: null };
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') order.push('jobs');
    return buildChain({ data: table === 'jobs' ? JOB : [], error: null });
  });
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'job_edit_version') { order.push('version'); return Promise.resolve(versionResult); }
    if (fn === 'save_job') return Promise.resolve(saveResult);
    return Promise.resolve({ data: null, error: null });
  });
});

describe('JobDetail edit-version check', () => {
  it('reads the version before the job and sends it with Save', async () => {
    await openJob();
    expect(order.slice(0, 2)).toEqual(['version', 'jobs']);
    expect(mockRpc).toHaveBeenCalledWith('job_edit_version', { p_job_id: 'job-a' });
    await clickSave();
    await waitFor(() => expect(savePayloads()).toHaveLength(1));
    expect(savePayloads()[0].expected_version).toEqual(VERSION);
  });

  it('shows the reload message when the database refuses the save', async () => {
    saveResult = { data: null, error: { message: 'JOB_CHANGED_SINCE_LOADED: This job changed after you opened it.' } };
    await openJob();
    await clickSave();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE));
  });

  it('blocks Save when the version could not be read (fail closed)', async () => {
    versionResult = { data: null, error: { message: 'Failed to fetch' } };
    await openJob();
    await clickSave();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/could not check whether the job is current/)));
    expect(savePayloads()).toHaveLength(0);
  });

  it('retries a save whose reply was lost with the same payload, version included, so the database replays it', async () => {
    saveResult = { data: null, error: { message: 'Failed to fetch' } };
    await openJob();
    await clickSave();
    await waitFor(() => expect(savePayloads()).toHaveLength(1));
    saveResult = { data: { job_id: 'job-a' }, error: null };
    await clickSave();
    await waitFor(() => expect(savePayloads()).toHaveLength(2));
    expect(savePayloads()[1]).toEqual(savePayloads()[0]);
    expect(mockToast).not.toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE);
  });
});

describe('withOwnDispatches', () => {
  it("replaces only the dispatched locations' strings, keeping everyone else's", () => {
    const v = { core: 'c', dispatches: ['jf1|app-1||dispatched', 'jf2|app-2||completed'] };
    expect(withOwnDispatches(v, [{ job_field_id: 'jf1', applicator_id: null, crew_id: 'crew-9' },
      { job_field_id: 'jf3', applicator_id: 'app-3', crew_id: null }])).toEqual({
      core: 'c', dispatches: ['jf1||crew-9|dispatched', 'jf2|app-2||completed', 'jf3|app-3||dispatched'],
    });
  });
});
