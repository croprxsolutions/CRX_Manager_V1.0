import { beforeEach, describe, expect, it, vi } from 'vitest';

// runBatchParent end to end with the database mocked: the save goes through commit_epa_proposal_batch, and the
// database's refusal at save time (#1976) is shown as "needs a person", not as an error that stops the run.
const PROPOSAL = {
  id: 'prop-1', parent_id: 'parent-1', epa_registration: '100-1', lookup_id: 'look-1', proposal_version: 3, status: 'proposed',
  epa_summary: { productname: 'AATREX 4L HERBICIDE' },
  items: [{ item_id: 'ing:atrazine', kind: 'ingredient', class: 'add', epa: {}, current: null, accept_default: true,
    change: { kind: 'ingredient', name: 'Atrazine', cas: '1912-24-9', strength_value: 42.6 } }],
};
const ROWS: Record<string, unknown> = {
  product_parents: [{ name: 'Aatrex 4L' }], product_parent_members: [], product_parent_brands: [],
  epa_chemistry_proposals: PROPOSAL, product_parent_ingredients: null,
};

vi.mock('./db', () => {
  const chain = (table: string): unknown => {
    const result = { data: ROWS[table], error: null, count: 0 };
    const self: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad),
      maybeSingle: () => Promise.resolve(result),
    };
    for (const m of ['select', 'eq', 'in', 'order']) self[m] = () => self;
    return self;
  };
  return { supabaseUntyped: { from: chain } };
});
vi.mock('./epaLookupClient', () => ({
  runRecordedEpaLookup: vi.fn(async () => ({ outcome: 'proposal', proposal_id: 'prop-1' })),
}));
const commitBatch = vi.fn();
const commitPlain = vi.fn();
vi.mock('./epaProposals', async (original) => ({
  ...(await original<typeof import('./epaProposals')>()),
  fetchParentEpaState: vi.fn(async () => ({ numbers: ['100-1'], lookups: [], proposals: [], failures: [] })),
  startEpaLookup: vi.fn(async () => ({ lookup_id: 'look-1' })),
  commitEpaProposal: commitPlain,
  commitEpaProposalBatch: commitBatch,
}));

const { runBatchParent } = await import('./epaBatchFill');
const candidate = { parentId: 'parent-1', name: 'Aatrex 4L', epaNumber: '100-1', appNames: ['Aatrex 4L'], skip: null };

describe('runBatchParent save', () => {
  beforeEach(() => { commitBatch.mockReset(); commitPlain.mockReset(); });

  it('saves through the batch RPC, never the product page one', async () => {
    commitBatch.mockResolvedValue({ status: 'committed', commit_result: { 'ing:atrazine': 'written' } });
    const r = await runBatchParent('run-1', candidate);
    expect(r).toMatchObject({ outcome: 'saved', detail: '1 ingredient saved' });
    expect(commitBatch).toHaveBeenCalledWith('prop-1', 3, [{ item_id: 'ing:atrazine', accept: true }], 'batch:run-1:parent-1:commit');
    expect(commitPlain).not.toHaveBeenCalled();
  });

  it('shows the database refusal at save as needs a person, with its reason', async () => {
    commitBatch.mockRejectedValue({ code: 'P0001',
      message: 'EPA_BATCH_NOT_ELIGIBLE: another proposal is waiting or was rejected; nothing was saved' });
    const r = await runBatchParent('run-1', candidate);
    expect(r).toEqual({ parentId: 'parent-1', name: 'Aatrex 4L', epaNumber: '100-1', outcome: 'needs_person',
      detail: 'Refused at save: another proposal is waiting or was rejected; nothing was saved; the proposal waits for a person' });
  });

  it('still throws any other save error, so the run reports it', async () => {
    commitBatch.mockRejectedValue({ message: 'EPA_PROPOSAL_STALE: this proposal changed since you opened it' });
    await expect(runBatchParent('run-1', candidate)).rejects.toMatchObject({ message: expect.stringMatching(/STALE/) });
  });
});
