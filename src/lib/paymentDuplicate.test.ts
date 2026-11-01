import { describe, it, expect, vi, beforeEach } from 'vitest';

const { eqCalls, signals, result } = vi.hoisted(() => ({
  eqCalls: [] as Array<[string, unknown]>,
  signals: [] as AbortSignal[],
  result: { value: { data: [] as unknown, error: null as unknown } },
}));

vi.mock('./db', () => ({
  supabase: {
    from: (table: string) => {
      expect(table).toBe('allocation_sets');
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => { eqCalls.push([column, value]); return chain; },
        order: () => chain,
        abortSignal: (signal: AbortSignal) => { signals.push(signal); return chain; },
        then: (done: (r: unknown) => unknown) => Promise.resolve(result.value).then(done),
      };
      return chain;
    },
  },
}));

import { duplicatePaymentMessage, findDuplicatePayment } from './paymentDuplicate';

const row = (over: object) => ({ id: 'p1', reference_number: null, check_number: null, payment_date: '2026-10-05', ...over });

describe('findDuplicatePayment', () => {
  beforeEach(() => {
    eqCalls.length = 0;
    result.value = { data: [], error: null };
  });

  it('looks only at active payments for this customer and exact amount', async () => {
    await findDuplicatePayment('cust-1', 50000, '1234');
    expect(eqCalls).toEqual([['customer_id', 'cust-1'], ['total_payment_cents', 50000], ['is_active', true]]);
  });

  it('gives the read a time limit, so a stalled check cannot leave the form locked', async () => {
    signals.length = 0;
    await findDuplicatePayment('cust-1', 50000, '1234');
    expect(signals).toHaveLength(1);
  });

  it('a stall that ignores the abort still ends as a failed check', async () => {
    const limit = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(limit.signal);
    result.value = new Promise(() => undefined) as never;
    const pending = findDuplicatePayment('cust-1', 50000, '1234');
    limit.abort(new Error('timed out'));
    await expect(pending).rejects.toThrow('timed out');
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });

  it('compares references written in other alphabets', async () => {
    result.value = { data: [row({ reference_number: 'Ñ-12' })], error: null };
    expect(await findDuplicatePayment('cust-1', 50000, 'ñ12')).toMatchObject({ id: 'p1' });
    expect(await findDuplicatePayment('cust-1', 50000, 'n\u030312')).toMatchObject({ id: 'p1' });
    expect(await findDuplicatePayment('cust-1', 50000, 'N12')).toBeNull();
  });

  it.each(['1234', ' 1234 ', '#1234', '12-34'])('treats "%s" as check 1234', async (typed) => {
    result.value = { data: [row({ reference_number: '#1234' })], error: null };
    expect(await findDuplicatePayment('cust-1', 50000, typed)).toMatchObject({ id: 'p1' });
  });

  it('matches letters in any case and the older check_number column', async () => {
    result.value = { data: [row({ reference_number: 'ach-77a' })], error: null };
    expect(await findDuplicatePayment('cust-1', 50000, 'ACH 77A')).toMatchObject({ id: 'p1' });
    result.value = { data: [row({ check_number: '555' })], error: null };
    expect(await findDuplicatePayment('cust-1', 50000, '555')).toMatchObject({ id: 'p1' });
  });

  it('a different reference is not a match', async () => {
    result.value = { data: [row({ reference_number: '1235' })], error: null };
    expect(await findDuplicatePayment('cust-1', 50000, '1234')).toBeNull();
  });

  it.each(['', '   ', '#'])('a blank reference (%j) matches nothing and reads nothing', async (typed) => {
    result.value = { data: [row({})], error: null };
    expect(await findDuplicatePayment('cust-1', 50000, typed)).toBeNull();
    expect(eqCalls).toEqual([]);
  });

  it('a failed read throws, so the caller cannot mistake it for no duplicate', async () => {
    result.value = { data: null, error: new Error('read failed') };
    await expect(findDuplicatePayment('cust-1', 50000, '1234')).rejects.toThrow('read failed');
    result.value = { data: null, error: null };
    await expect(findDuplicatePayment('cust-1', 50000, '1234')).rejects.toThrow('no list');
  });
});

describe('duplicatePaymentMessage', () => {
  it('names the amount in dollars and the reference', () => {
    const message = duplicatePaymentMessage(row({ reference_number: '1234' }), 50000);
    expect(message).toContain('$500.00');
    expect(message).toContain('reference 1234');
    expect(message).toContain('Payment History');
  });

  it('falls back to check_number and survives a missing date', () => {
    const message = duplicatePaymentMessage(row({ check_number: '555', payment_date: null }), 100);
    expect(message).toContain('reference 555.');
  });
});
