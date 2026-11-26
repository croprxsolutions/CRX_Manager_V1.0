import { describe, expect, it } from 'vitest';
import { draftQueueState, readDraftQueue } from './invoiceDraftQueue';

const rows = [
  { id: 'a', status: 'draft' },
  { id: 'b', status: 'posted' },
  { id: 'c', status: 'unposted' },
  { id: 'd', status: 'paid' },
  { id: 'e', status: 'draft' },
];

describe('invoice draft queue', () => {
  it('queues the unposted invoices after the one opened, in list order', () => {
    expect(draftQueueState(rows, 'a')).toEqual({ nextDrafts: ['c', 'e'] });
    expect(draftQueueState(rows, 'b')).toEqual({ nextDrafts: ['c', 'e'] });
    expect(draftQueueState(rows, 'e')).toEqual({ nextDrafts: [] });
  });

  it('queues nothing for an invoice that is not in the list', () => {
    expect(draftQueueState(rows, 'zzz')).toEqual({ nextDrafts: [] });
  });

  it('reads the queue back, without the open invoice, and nothing from other state', () => {
    expect(readDraftQueue({ nextDrafts: ['c', 'e'] }, 'a')).toEqual(['c', 'e']);
    expect(readDraftQueue({ nextDrafts: ['c', 'e'] }, 'c')).toEqual(['e']);
    expect(readDraftQueue(null, 'a')).toEqual([]);
    expect(readDraftQueue({ nextDrafts: 'c' }, 'a')).toEqual([]);
    expect(readDraftQueue({ nextDrafts: ['c', 7] }, 'a')).toEqual(['c']);
  });
});
