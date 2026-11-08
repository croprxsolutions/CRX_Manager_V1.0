import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./db', () => ({
  supabaseUntyped: { rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: <T,>(data: unknown, name: string) => { if (data == null) throw new Error(`${name} returned no data`); return data as T; },
}));

import {
  casValid, centsText, plainRefusal, ChemistrySaveUncertain, costReasonText, finishChemistrySave, pendingSaves, refusalCode, startChemistrySave,
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
});
