/**
 * JobDetail — a save over someone else's newer change is refused (Mason, 2026-11-23).
 *
 * Before this, two people editing one job meant the last Save silently won: the second person's stale
 * applicator, date or crew replaced the first person's. Save now re-reads the job and refuses, saving
 * nothing, when a checked value moved since the page loaded.
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
import { JOB_CHANGED_SINCE_LOADED_MESSAGE } from '../lib/jobStaleEdit';

const JOB = {
  id: 'job-a', job_number: 'J-AAAA-1001', job_date: '2026-03-01', customer_id: 'cust-1',
  applicator_id: null, ground_crew_id: null, status: 'scheduled', notes: 'A notes',
  customer: { farm_name: 'Farm Alpha' }, vehicle: null, quote: null, quote_section: null,
  job_fields: [], job_chemicals: [], job_field_shares: [], applied_info: null,
};

/** First jobs read = the page load; read n (n >= 2) = the n-1th pre-save re-read, answered with `current[n-2]` (or the last). */
function serveJob(...current: Record<string, unknown>[]) {
  let jobsCalls = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') {
      jobsCalls += 1;
      return buildChain({ data: jobsCalls === 1 ? JOB : current[Math.min(jobsCalls - 2, current.length - 1)], error: null });
    }
    return buildChain({ data: [], error: null });
  });
}

async function clickSave() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
}

async function openAndSave() {
  const router = createMemoryRouter([{ path: '/jobs/:id', element: <JobDetail /> }], { initialEntries: ['/jobs/job-a'] });
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'J-AAAA-1001' });
  await clickSave();
}

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
  selectCalls.length = 0;
  mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'save_job'
    ? { data: { job_id: 'job-a' }, error: null }
    : { data: null, error: null }));
});

describe('JobDetail stale-edit refusal', () => {
  it.each([
    ['applicator', { applicator_id: 'other-applicator' }],
    ['date', { job_date: '2026-03-09' }],
    ['crew', { ground_crew_id: 'crew-2' }],
    // A billing split change leaves every job total as it was.
    ['billing split', { job_field_shares: [{ field_id: 'f1', customer_id: 'cust-2', split_pct: 50, is_primary: false }] }],
    // Reassigning one field's applicator leaves the job row as it was.
    ['tags', { tags: ['urgent'] }],
    ['field dispatch', { job_location_dispatches: [{ job_field_id: 'jf1', applicator_id: 'a2', crew_id: null, dispatch_status: 'dispatched' }] }],
  ])('refuses the save when someone else changed the %s after the page loaded', async (_label, change) => {
    serveJob({ ...JOB, ...change });
    await openAndSave();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE));
    expect(mockRpc).not.toHaveBeenCalledWith('save_job', expect.anything());
    expect(eqCalls).toContainEqual(['id', 'job-a']);
    // The re-read itself asks for every compared line table (the mock would supply them regardless).
    const reRead = String(selectCalls.filter((c) => typeof c === 'string' && c.includes('job_fields(') && !c.includes('job_number')).at(-1));
    for (const t of ['job_fields(', 'job_field_shares(', 'job_chemicals(', 'job_location_dispatches(', 'tags']) expect(reRead).toContain(t);
  });

  it('refuses the retry of a save whose reply was lost once that save committed', async () => {
    // Accepted trade-off (Mason, 2026-11-23): the re-read cannot tell an own lost save from someone else's, so it
    // refuses and asks for a reload rather than risk writing over another person's change.
    serveJob(JOB, { ...JOB, notes: 'committed by the lost save' });
    let saves = 0;
    mockRpc.mockImplementation((fn: string) => {
      if (fn !== 'save_job') return Promise.resolve({ data: null, error: null });
      saves += 1;
      return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
    });
    await openAndSave();
    await waitFor(() => expect(saves).toBe(1));
    await clickSave();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE));
    expect(saves).toBe(1);
  });

  it("refuses an admin's save when someone else changed a product's cost after the page loaded", async () => {
    const chem = { id: 'jc1', product_id: 'p1', quantity: 10, unit: 'oz', rate_per_acre: 2, rate_unit: 'oz', sort_order: 0 };
    const withChem = { ...JOB, job_chemicals: [chem] };
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') { jobsCalls += 1; return buildChain({ data: withChem, error: null }); }
      return buildChain({ data: [], error: null });
    });
    let costReads = 0;
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'get_admin_cost_fields') {
        costReads += 1;
        return Promise.resolve({ data: { jc1: { cost_per_unit_cents: costReads === 1 ? 1000 : 1250 } }, error: null });
      }
      return Promise.resolve(fn === 'save_job' ? { data: { job_id: 'job-a' }, error: null } : { data: [], error: null });
    });
    await openAndSave();
    // A mix with products saves only once the label-rate policy has loaded; retry the click until it does.
    await waitFor(async () => {
      if (jobsCalls < 2) await clickSave();
      expect(jobsCalls).toBe(2);
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE));
    expect(mockRpc).not.toHaveBeenCalledWith('save_job', expect.anything());
  });

  it('saves normally when nothing changed underneath', async () => {
    serveJob(JOB);
    await openAndSave();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_job', expect.anything()));
    expect(mockToast).not.toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE);
  });

  it('does not mistake an earlier save by the same user for a change by someone else', async () => {
    // Reads: load, re-read before save 1, the refetch after save 1 (now holding the saved notes), re-read before save 2.
    const saved = { ...JOB, notes: 'B notes' };
    serveJob(JOB, saved, saved);
    await openAndSave();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_job', expect.anything()));
    await clickSave();
    await waitFor(() => expect(mockRpc.mock.calls.filter(([fn]) => fn === 'save_job')).toHaveLength(2));
    expect(mockToast).not.toHaveBeenCalledWith('error', JOB_CHANGED_SINCE_LOADED_MESSAGE);
  });
});
