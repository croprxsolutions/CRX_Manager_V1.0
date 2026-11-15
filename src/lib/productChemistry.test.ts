import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./db', () => ({
  supabaseUntyped: { rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: <T,>(data: unknown, name: string) => { if (data == null) throw new Error(`${name} returned no data`); return data as T; },
}));

import {
  casValid, centsText, plainRefusal, ChemistrySaveUncertain, costReasonText, finishChemistrySave, pendingSaves, refusalCode, startChemistrySave,
  isChemistryAuthorizationRefusal,
} from './productChemistry';

describe('chemistry helpers', () => {
  it('checks CAS format and check digit the way the database does', () => {
    expect(casValid('1071-83-6')).toBe(true); // glyphosate
    expect(casValid('1071-83-5')).toBe(false); // wrong check digit
    expect(casValid('01071-83-6')).toBe(false); // leading zero
    expect(casValid('7732-18-5')).toBe(true); // water
    expect(casValid('1071836')).toBe(false);
  });

  it('formats exact cents without floating point', () => {
    expect(centsText('0')).toBe('$0.00');
    expect(centsText('7')).toBe('$0.07');
    expect(centsText('1234567')).toBe('$12,345.67');
    expect(centsText('100000000000000000001')).toBe('$1,000,000,000,000,000,000.01');
  });

  it('names refusals in plain words, with the priced unit', () => {
    expect(costReasonText('DENSITY_NOT_APPROVED')).toBe('no approved weight per gallon yet');
    expect(costReasonText('UNIT_IS_COUNT', 'Ea')).toBe('priced per Ea');
    expect(costReasonText('COST_MISSING')).toBe('no cost');
  });

  it('reads the refusal token an error starts with', () => {
    expect(refusalCode({ message: 'CHEMISTRY_STALE: reload' })).toBe('CHEMISTRY_STALE');
    expect(refusalCode({ message: 'INGREDIENT_NOT_FOUND' })).toBe('INGREDIENT_NOT_FOUND');
    expect(refusalCode({ message: 'Failed to fetch' })).toBeNull();
    expect(refusalCode(null)).toBeNull();
  });

  it('shows a database message without its code', () => {
    expect(plainRefusal('CHEMISTRY_FROM_EPA_ONLY: this product has EPA number(s) 524-445; its chemistry comes from the EPA auto-fill'))
      .toBe('This product has EPA number(s) 524-445; its chemistry comes from the EPA auto-fill.');
    expect(plainRefusal('Already a sentence.')).toBe('Already a sentence.');
  });
});

describe('unfinished chemistry saves (retry key kept until the outcome is known)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    rpc.mockReset();
  });

  it('keeps the record when the outcome is unknown, refuses a new save, and finishes with the same key', async () => {
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(startChemistrySave('user-a', 'parent-1', 'set_parent_chemistry', { p_parent_id: 'parent-1' }, 'Entry'))
      .rejects.toBeInstanceOf(ChemistrySaveUncertain);
    const [record] = pendingSaves('user-a', 'parent-1');
    expect(record.rpc).toBe('set_parent_chemistry');
    const key = rpc.mock.calls[0][1].p_idempotency_key;
    expect(record.key).toBe(key);

    // Another user never sees it; this user cannot start a new save on the parent.
    expect(pendingSaves('user-b', 'parent-1')).toEqual([]);
    await expect(startChemistrySave('user-a', 'parent-1', 'set_parent_chemistry', {}, 'Second')).rejects.toThrow(/Finish the save/);
    expect(rpc).toHaveBeenCalledTimes(1);

    rpc.mockResolvedValueOnce({ data: { changed: true }, error: null });
    await finishChemistrySave(record);
    expect(rpc.mock.calls[1][1]).toEqual({ p_parent_id: 'parent-1', p_idempotency_key: key });
    expect(pendingSaves('user-a', 'parent-1')).toEqual([]);
  });

  it('keeps the record on a gateway error and drops it on a named database refusal', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Gateway Timeout', code: '' } });
    await expect(startChemistrySave('user-a', 'p', 'set_parent_cost_reference', {}, 'Ref')).rejects.toBeInstanceOf(ChemistrySaveUncertain);
    const [record] = pendingSaves('user-a', 'p');
    expect(record).toBeDefined();

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'COST_REFERENCE_STALE: reload', code: 'P0001' } });
    await expect(finishChemistrySave(record)).rejects.toMatchObject({ message: 'COST_REFERENCE_STALE: reload' });
    expect(pendingSaves('user-a', 'p')).toEqual([]);
  });

  it.each([
    [{ code: '42501', message: 'permission denied' }],
    [{ code: 'PGRST301', message: 'JWT expired' }],
    [{ code: 'PGRST302', message: 'missing bearer token' }],
    [{ code: 'PGRST303', message: 'JWT claims validation failed' }],
    [{ code: 'P0001', message: 'AUTH_REQUIRED: sign in again' }],
    [{ code: 'P0001', message: 'ADMIN_REQUIRED: administrator access is required' }],
  ])('treats a first authorization refusal as final and clears its fresh key: %o', async (error) => {
    rpc.mockResolvedValueOnce({ data: null, error });
    await expect(startChemistrySave('user-a', 'setup-workbook-chemistry', 'commit_ingredients_tab',
      { p_rows: [{ parent_id: 'parent-a', name: 'Active A', cas: null }] }, 'Save Ingredients tab'))
      .rejects.toMatchObject(error);
    expect(pendingSaves('user-a', 'setup-workbook-chemistry')).toEqual([]);
    expect(window.localStorage.length).toBe(0);
  });

  it.each([
    [{ code: '42501', message: 'permission denied' }],
    [{ code: 'PGRST301', message: 'JWT expired' }],
    [{ code: 'PGRST302', message: 'missing bearer token' }],
    [{ code: 'PGRST303', message: 'JWT claims validation failed' }],
    [{ code: 'P0001', message: 'AUTH_REQUIRED: sign in again' }],
    [{ code: 'P0001', message: 'ADMIN_REQUIRED: administrator access is required' }],
  ])('retains and then finishes a known-prior intent after authorization refusal: %o', async (error) => {
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const args = { p_rows: [{ parent_id: 'parent-a', name: 'Active A', cas: null }] };
    await expect(startChemistrySave('user-a', 'setup-workbook-chemistry', 'commit_ingredients_tab', args, 'Save Ingredients tab'))
      .rejects.toBeInstanceOf(ChemistrySaveUncertain);
    const [record] = pendingSaves('user-a', 'setup-workbook-chemistry');
    const storedBytes = window.localStorage.getItem(`crx:chemistry-pending:v1:${record.key}`);
    rpc.mockResolvedValueOnce({ data: null, error });
    const refusal = await finishChemistrySave(record).catch((caught: unknown) => caught);
    expect(refusal).toMatchObject({ authorizationRefusal: true, cause: error });
    expect(isChemistryAuthorizationRefusal(refusal)).toBe(true);
    expect(window.localStorage.getItem(`crx:chemistry-pending:v1:${record.key}`)).toBe(storedBytes);
    rpc.mockResolvedValueOnce({ data: { saved: true }, error: null });
    await expect(finishChemistrySave(record)).resolves.toEqual({ saved: true });
    expect(rpc).toHaveBeenLastCalledWith('commit_ingredients_tab', { ...args, p_idempotency_key: record.key });
    expect(pendingSaves('user-a', 'setup-workbook-chemistry')).toEqual([]);
  });

  it('reuses the exact intent after a lost committed proposal reply and an authorization refusal', async () => {
    let committedProposals = 0;
    const committedReceipt = { data: { status: 'proposed', proposal_id: 'proposal-once' }, error: null };
    rpc.mockImplementationOnce(async () => {
      committedProposals += 1;
      throw new TypeError('Failed to fetch');
    });
    const args = { p_rows: [{ parent_id: 'parent-a', expected_chemistry_version: 2, row_id: null, name: 'Active A', cas: null }] };
    await expect(startChemistrySave('user-a', 'setup-workbook-chemistry', 'commit_ingredients_tab', args, 'Save Ingredients tab'))
      .rejects.toBeInstanceOf(ChemistrySaveUncertain);
    const [record] = pendingSaves('user-a', 'setup-workbook-chemistry');
    const storedBytes = window.localStorage.getItem(`crx:chemistry-pending:v1:${record.key}`);
    const callArgs = { ...args, p_idempotency_key: record.key };
    expect(rpc).toHaveBeenNthCalledWith(1, 'commit_ingredients_tab', callArgs);

    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST303', message: 'JWT claims validation failed' } });
    await expect(finishChemistrySave(record)).rejects.toMatchObject({ authorizationRefusal: true, cause: { code: 'PGRST303' } });
    expect(window.localStorage.getItem(`crx:chemistry-pending:v1:${record.key}`)).toBe(storedBytes);

    rpc.mockResolvedValueOnce(committedReceipt);
    await expect(finishChemistrySave(record)).resolves.toEqual(committedReceipt.data);
    expect(rpc).toHaveBeenNthCalledWith(2, 'commit_ingredients_tab', callArgs);
    expect(rpc).toHaveBeenNthCalledWith(3, 'commit_ingredients_tab', callArgs);
    expect(committedProposals).toBe(1);
    expect(pendingSaves('user-a', 'setup-workbook-chemistry')).toEqual([]);
  });

  it('keeps a prior request through a non-auth PostgREST refusal before retrying its receipt', async () => {
    const args = { p_rows: [{ parent_id: 'parent-a', name: 'Active A', cas: null }] };
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(startChemistrySave('user-a', 'setup-workbook-chemistry', 'commit_ingredients_tab', args, 'Save Ingredients tab'))
      .rejects.toBeInstanceOf(ChemistrySaveUncertain);
    const [record] = pendingSaves('user-a', 'setup-workbook-chemistry');
    const storedBytes = window.localStorage.getItem(`crx:chemistry-pending:v1:${record.key}`);

    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' } });
    await expect(finishChemistrySave(record)).rejects.toMatchObject({ authorizationRefusal: false });
    expect(isChemistryAuthorizationRefusal({ code: 'PGRST202', message: 'Could not find the function in the schema cache' })).toBe(false);
    expect(window.localStorage.getItem(`crx:chemistry-pending:v1:${record.key}`)).toBe(storedBytes);

    rpc.mockResolvedValueOnce({ data: { saved: true }, error: null });
    await expect(finishChemistrySave(record)).resolves.toEqual({ saved: true });
    expect(rpc).toHaveBeenLastCalledWith('commit_ingredients_tab', { ...args, p_idempotency_key: record.key });
    expect(pendingSaves('user-a', 'setup-workbook-chemistry')).toEqual([]);
  });

  it('keeps the record when the database answers with no data (it may have committed)', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(startChemistrySave('user-a', 'p', 'set_parent_chemistry', {}, 'Entry')).rejects.toBeInstanceOf(ChemistrySaveUncertain);
    expect(pendingSaves('user-a', 'p')).toHaveLength(1);
  });

  it('sends nothing when the browser cannot keep the record', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      await expect(startChemistrySave('user-a', 'p', 'set_parent_chemistry', {}, 'Entry')).rejects.toThrow(/Nothing was sent/);
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it('ignores a stored record that names any other function', () => {
    window.localStorage.setItem('crx:chemistry-pending:v1:k1', JSON.stringify({
      key: 'k1', userId: 'user-a', scope: 'p', rpc: 'post_invoice', args: {}, label: 'x', createdAt: 1,
    }));
    expect(pendingSaves('user-a', 'p')).toEqual([]);
  });

  it.each([
    ['commit_weights_tab', { p_rows: [{ kind: 'density', subject_id: 'p1', expected_version: 0, value: 8.75, unit: 'lb_per_gal', source: 'label', source_note: null }] }],
    ['commit_ingredients_tab', { p_rows: [{ parent_id: 'p1', expected_chemistry_version: 0, row_id: null, name: 'Test', cas: null }] }],
    ['promote_chemistry_proposal', { p_proposal_id: 'proposal-1', p_expected_proposal_version: 1, p_decision: 'reject' }],
  ] as const)('keeps the exact retry request and calls %s', async (rpcName, args) => {
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(startChemistrySave('user-a', 'setup-workbook-chemistry', rpcName, args, 'Workbook')).rejects.toBeInstanceOf(ChemistrySaveUncertain);
    const [record] = pendingSaves('user-a', 'setup-workbook-chemistry');
    const key = record.key;
    expect(rpc).toHaveBeenCalledWith(rpcName, { ...args, p_idempotency_key: key });
    rpc.mockResolvedValueOnce({ data: { status: 'saved' }, error: null });
    await finishChemistrySave(record);
    expect(rpc).toHaveBeenLastCalledWith(rpcName, { ...args, p_idempotency_key: key });
    expect(pendingSaves('user-a', 'setup-workbook-chemistry')).toEqual([]);
  });
});
