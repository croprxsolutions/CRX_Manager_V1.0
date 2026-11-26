import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadApplicatorPhoneJobs,
  loadApplicatorWorkEntries,
  saveApplicatorWorkEntry,
} from './applicatorPhoneApi';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  assertRpcResult: vi.fn((data: unknown) => data),
}));

vi.mock('../../lib/db', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  supabaseUntyped: { from: mocks.from },
  assertRpcResult: mocks.assertRpcResult,
}));

interface QueryResult {
  data: unknown;
  error: Error | null;
}

class MockQueryBuilder implements PromiseLike<QueryResult> {
  readonly select = vi.fn((_columns: string) => this);
  readonly in = vi.fn((_column: string, _values: string[]) => this);
  readonly is = vi.fn((_column: string, _value: null) => this);
  readonly eq = vi.fn((_column: string, _value: string) => this);
  readonly order = vi.fn((_column: string, _options: { ascending: boolean; nullsFirst?: boolean }) => this);

  constructor(private readonly result: QueryResult) {}

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

describe('applicatorPhoneApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const builders = {
      jobs_crew: new MockQueryBuilder({
        data: [{
          id: 'job-1', job_number: 'J-101', status: 'in_progress', job_date: '2026-11-25',
          scheduled_time: null, total_acres: 40, applied_acres: 0, remaining_acres: 40,
        }],
        error: null,
      }),
    };
    mocks.from.mockImplementation((table: keyof typeof builders) => builders[table]);
    mocks.rpc.mockResolvedValue({ data: [{ customer_id: 'cust-1', farm_name: 'Acme Farm', account_number: 'A-1', is_primary: true }], error: null });
  });

  it('reads jobs through the crew view and gets grower names through the safe billed-customer RPC', async () => {
    const jobs = await loadApplicatorPhoneJobs();

    expect(mocks.from).toHaveBeenCalledWith('jobs_crew');
    expect(mocks.from).not.toHaveBeenCalledWith('jobs');
    expect(mocks.from).not.toHaveBeenCalledWith('job_chemicals');
    expect(mocks.from).not.toHaveBeenCalledWith('job_fields');
    expect(mocks.from).not.toHaveBeenCalledWith('fields');
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('get_job_billed_customers', { p_job_id: 'job-1' });
    expect(mocks.assertRpcResult).toHaveBeenCalledWith(
      [{ customer_id: 'cust-1', farm_name: 'Acme Farm', account_number: 'A-1', is_primary: true }],
      'get_job_billed_customers',
    );
    expect(jobs[0]).toMatchObject({
      jobNumber: 'J-101',
      billedCustomerNames: ['Acme Farm'],
      fields: null,
    });
    expect(JSON.stringify(jobs[0])).not.toMatch(/price|cost|memo|commission|split_pct/i);
  });

  it('fails closed for work-entry reads and writes while their RPC contract is unnamed', async () => {
    await expect(loadApplicatorWorkEntries('job-1', 'field-1')).rejects.toMatchObject({
      todo: expect.stringContaining('TODO_WORK_ENTRY_READ_RPC'),
    });
    await expect(saveApplicatorWorkEntry({} as never, 'retry-key')).rejects.toMatchObject({
      todo: expect.stringContaining('TODO_WORK_ENTRY_WRITE_RPC'),
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
