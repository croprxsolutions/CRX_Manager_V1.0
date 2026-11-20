import { describe, it, expect } from 'vitest';
import { describeEditJobsResult, editJobsScope, editJobsChangedNothing, type EditJobsResult } from './editJobs';

const r = (p: Partial<EditJobsResult>): EditJobsResult => ({ updated: [], cancelled: [], deleted: [], skipped: [], ...p });

describe('describeEditJobsResult', () => {
  it('words each server count by operation, never the selection size', () => {
    expect(describeEditJobsResult(r({
      updated: ['a', 'b'], cancelled: ['a'], skipped: [{ id: 'b', reason: 'status', status: 'completed' }],
    }), 'cancel')).toBe('2 jobs edited. 1 cancelled. 1 already completed and could not be cancelled.');
  });

  it('reports deletes, skipped statuses and vanished jobs', () => {
    expect(describeEditJobsResult(r({
      deleted: ['a'],
      skipped: [{ id: 'b', reason: 'status', status: 'invoiced' }, { id: 'c', reason: 'deleted' }, { id: 'd', reason: 'not_found' }],
    }), 'delete')).toBe('1 job deleted. 1 already invoiced and could not be deleted. 2 no longer exist and were skipped.');
  });

  it('says nothing changed when every job was skipped', () => {
    const all = r({ skipped: [{ id: 'a', reason: 'status', status: 'in_progress' }] });
    expect(editJobsChangedNothing(all)).toBe(true);
    expect(describeEditJobsResult(all, 'cancel')).toBe('1 already in progress and could not be cancelled.');
    expect(describeEditJobsResult(r({}), null)).toBe('Nothing changed.');
    expect(describeEditJobsResult(all, null)).toBe('1 already in progress and could not be changed.');
  });
});

describe('editJobsScope', () => {
  it('is the same for the same payload in any order, so a retry reuses its key', () => {
    expect(editJobsScope(['b', 'a', 'a'], { job_date: '2027-01-02', batch_ref: null }, 'cancel'))
      .toBe(editJobsScope(['a', 'b'], { batch_ref: null, job_date: '2027-01-02' }, 'cancel'));
  });

  it('differs when anything in the payload differs', () => {
    const base = editJobsScope(['a'], { batch_ref: 'x' }, null);
    expect(editJobsScope(['a'], { batch_ref: 'y' }, null)).not.toBe(base);
    expect(editJobsScope(['a', 'b'], { batch_ref: 'x' }, null)).not.toBe(base);
    expect(editJobsScope(['a'], { batch_ref: 'x' }, 'cancel')).not.toBe(base);
  });
});
