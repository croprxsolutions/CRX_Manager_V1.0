import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./db', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
  assertRpcResult: (d: unknown) => {
    if (d == null) throw new Error('no data');
    return d;
  },
}));

import { renderHook } from '@testing-library/react';
import { editJobs, summarizeEditJobs, editJobsErrorMessage, editJobsLimitMessage, useEditJobsKey } from './editJobs';

const empty = { updated: [], cancelled: [], deleted: [], skipped: [] };

describe('editJobs', () => {
  beforeEach(() => rpc.mockReset());

  it('sends one call with ids, changes, action, actor and key', async () => {
    rpc.mockResolvedValue({ data: { ...empty, updated: ['a'], cancelled: ['a'] }, error: null });
    const r = await editJobs({ jobIds: ['a'], changes: { job_date: '2027-03-01' }, action: 'cancel', performedBy: 'u', idempotencyKey: 'k' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('edit_jobs', {
      p_job_ids: ['a'], p_changes: { job_date: '2027-03-01' }, p_action: 'cancel', p_performed_by: 'u', p_idempotency_key: 'k',
    });
    expect(r.cancelled).toEqual(['a']);
  });

  it('omits changes and action when not given', async () => {
    rpc.mockResolvedValue({ data: empty, error: null });
    await editJobs({ jobIds: ['a'], action: 'delete', performedBy: 'u', idempotencyKey: 'k' });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_changes: undefined, p_action: 'delete' });
  });

  it('refuses more than 500 jobs before calling the server', async () => {
    await expect(editJobs({ jobIds: Array.from({ length: 501 }, (_, i) => String(i)), action: 'delete', performedBy: 'u', idempotencyKey: 'k' }))
      .rejects.toThrow(/at most 500/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws the server error and a malformed result', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'INSUFFICIENT_ROLE: x' } });
    await expect(editJobs({ jobIds: ['a'], action: 'cancel', performedBy: 'u', idempotencyKey: 'k' })).rejects.toMatchObject({ message: 'INSUFFICIENT_ROLE: x' });
    rpc.mockResolvedValue({ data: { updated: [] }, error: null });
    await expect(editJobs({ jobIds: ['a'], action: 'cancel', performedBy: 'u', idempotencyKey: 'k' })).rejects.toThrow(/unexpected/);
  });
});

describe('summarizeEditJobs', () => {
  it('words each count by operation and groups skips by reason', () => {
    expect(summarizeEditJobs({
      updated: ['a', 'b'], cancelled: ['a'], deleted: [],
      skipped: [{ id: 'b', reason: 'status', status: 'completed' }, { id: 'c', reason: 'status', status: 'invoiced' }, { id: 'd', reason: 'not_found' }],
    })).toBe('2 jobs edited. 1 job cancelled. 1 job not cancelled (completed). 1 job skipped (invoiced). 1 job skipped (no longer exists).');
    expect(summarizeEditJobs(empty)).toBe('Nothing changed.');
  });
});

describe('editJobsErrorMessage', () => {
  it('turns server refusals into plain English', () => {
    expect(editJobsErrorMessage({ message: 'INSUFFICIENT_ROLE: edit_jobs requires an active admin' })).toMatch(/^Nothing was saved\. Only an admin/);
    expect(editJobsErrorMessage({ message: 'BAD_VALUE: carrier_rate_gpa cannot be negative' })).toBe('Nothing was saved. Carrier rate cannot be negative.');
    expect(editJobsErrorMessage(new Error('Nothing was saved. Choose at most 500 jobs at a time.'))).toBe('Nothing was saved. Choose at most 500 jobs at a time.');
  });
});

describe('useEditJobsKey', () => {
  it('reuses the key only for a retry of the latest edit (A, B, then A gets a fresh key)', () => {
    const { result } = renderHook(() => useEditJobsKey('user-1'));
    const a1 = result.current.keyFor('A');
    expect(result.current.keyFor('A')).toBe(a1); // exact retry after a lost reply
    const b = result.current.keyFor('B');
    expect(b).not.toBe(a1);
    expect(result.current.keyFor('A')).not.toBe(a1); // back to A: sent again, not replayed
  });

  it('mints a new key after a confirmed reply', () => {
    const { result } = renderHook(() => useEditJobsKey('user-1'));
    const k = result.current.keyFor('A');
    result.current.done('A');
    expect(result.current.keyFor('A')).not.toBe(k);
  });
});

describe('editJobsLimitMessage', () => {
  it('flags more than 500 jobs before anything is confirmed', () => {
    expect(editJobsLimitMessage(500)).toBeNull();
    expect(editJobsLimitMessage(501)).toBe('Choose at most 500 jobs at a time (501 selected).');
  });
});

describe('summarizeEditJobs with field changes and a refused cancel', () => {
  it('calls a job whose fields saved but whose cancel was refused "not cancelled", not "skipped"', () => {
    expect(summarizeEditJobs({
      updated: ['a', 'b'], cancelled: ['a'], deleted: [],
      skipped: [{ id: 'b', reason: 'status', status: 'completed' }, { id: 'c', reason: 'status', status: 'invoiced' }],
    })).toBe('2 jobs edited. 1 job cancelled. 1 job not cancelled (completed). 1 job skipped (invoiced).');
  });
});
