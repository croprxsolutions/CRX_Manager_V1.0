/**
 * useGuardrails.creditLimit.test.ts — the credit-limit check adds up the customer's whole open
 * balance and never passes on a read it could not make.
 *
 * - Goal 4 L17: the balance read stopped at the server's 1,000-row cap; a failed read came back
 *   as "no invoices" and passed.
 * - To-Do 10.5 follow-up: a failed customer read came back as "no credit limit set" and passed,
 *   and a sales rep's own invoices read only sees the invoices they created or sell, so a customer
 *   billed by another rep looked under the limit. The balance now comes from the server's
 *   check_customer_credit_limit, which reads every invoice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type FailMode = 'error' | 'nodata' | 'notlist' | 'throws';

const H = vi.hoisted(() => ({
  customer: null as Record<string, unknown> | null,
  customerFail: null as FailMode | null,
  // The server's answer: outstanding_ar in dollars, as check_customer_credit_limit returns it.
  rpcAnswer: null as unknown,
  rpcFail: null as FailMode | null,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  // Draft invoices, which the server total leaves out (Sol on #1132).
  drafts: [] as Array<{ id: string; balance_cents: number | null }>,
  draftFail: null as FailMode | null,
  invoiceFilters: [] as unknown[][],
}));

function answer(mode: FailMode | null, ok: unknown): Promise<{ data: unknown; error: unknown }> {
  if (mode === 'throws') return Promise.reject(new Error('Failed to fetch'));
  if (mode === 'error') return Promise.resolve({ data: null, error: { message: 'connection reset' } });
  if (mode === 'nodata') return Promise.resolve({ data: null, error: null });
  if (mode === 'notlist') return Promise.resolve({ data: 'not an object', error: null });
  return Promise.resolve({ data: ok, error: null });
}

vi.mock('../lib/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.single = () => answer(H.customerFail, H.customer);
  const invoices: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order']) invoices[m] = (...args: unknown[]) => { H.invoiceFilters.push([m, ...args]); return invoices; };
  invoices.range = (from: number, to: number) => answer(H.draftFail, H.drafts.slice(from, to + 1))
    .then((r) => ({ ...r, count: H.draftFail ? null : H.drafts.length }));
  return {
    supabase: {
      from: (table: string) => (table === 'invoices' ? invoices : chain),
      rpc: (name: string, args: unknown) => { H.rpcCalls.push({ name, args }); return answer(H.rpcFail, H.rpcAnswer); },
    },
    assertRpcResult: (data: unknown, name: string) => {
      if (data === null || data === undefined) throw new Error(`${name} returned no data`);
      return data;
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { useCreditLimitCheck } from './useGuardrails';
import { evaluateCreditLimit } from '../lib/creditLimitGuard';

beforeEach(() => {
  H.customer = { farm_name: 'Big Farm', credit_limit_cents: 100_200 };
  H.customerFail = null;
  // $1,005.00 open on the server: every invoice, including ones another rep sells.
  H.rpcAnswer = { exceeded: true, credit_limit: 1002, outstanding_ar: 1005, farm_name: 'Big Farm' };
  H.rpcFail = null;
  H.rpcCalls = [];
  H.drafts = [];
  H.draftFail = null;
  H.invoiceFilters = [];
});

async function runHook(newAmountCents: number) {
  const { result } = renderHook(() => useCreditLimitCheck());
  let passed: boolean | undefined;
  await act(async () => { passed = await result.current.check({ customerId: 'c1', newAmountCents }); });
  return { passed, warning: result.current.warning };
}

describe('credit-limit check on the server balance', () => {
  it('warns when the whole open balance plus the new amount is over the limit', async () => {
    // $1,005.00 open + $1.00 new = $1,006.00 against $1,002.00: over by $4.00.
    const { passed, warning } = await runHook(100);
    expect(passed).toBe(false);
    expect(warning?.id).toBe('credit-limit');
    expect(warning?.message).toContain('$4.00 over');
    expect(H.rpcCalls).toEqual([{ name: 'check_customer_credit_limit', args: { p_customer_id: 'c1' } }]);
  });

  it('counts cents exactly from the server\'s dollar answer', async () => {
    H.customer = { farm_name: 'Big Farm', credit_limit_cents: 100_001 };
    H.rpcAnswer = { outstanding_ar: 999.99 };
    // 99,999 + 2 = 100,001: exactly at the limit is not over.
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 2 })).toEqual({ status: 'ok' });
    expect((await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 3 })).status).toBe('over');
  });

  it('a customer under the limit passes', async () => {
    H.customer = { farm_name: 'Big Farm', credit_limit_cents: 200_000 };
    const { passed, warning } = await runHook(100);
    expect(passed).toBe(true);
    expect(warning).toBeNull();
  });

  it('counts draft invoices, which the server total leaves out', async () => {
    // $9,000 draft + $2,000 new against $10,000 with nothing else open: over by $1,000.
    H.customer = { farm_name: 'Big Farm', credit_limit_cents: 1_000_000 };
    H.rpcAnswer = { outstanding_ar: 0 };
    H.drafts = [{ id: 'd1', balance_cents: 900_000 }];
    const result = await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 200_000 });
    expect(result).toEqual({ status: 'over', message: expect.stringContaining('$1,000.00 over') });
    expect(H.invoiceFilters).toEqual(expect.arrayContaining([['eq', 'customer_id', 'c1'], ['eq', 'status', 'draft'], ['is', 'deleted_at', null]]));
  });

  it('a negative draft balance counts as 0, as on the server', async () => {
    H.customer = { farm_name: 'Big Farm', credit_limit_cents: 1_000_000 };
    H.rpcAnswer = { outstanding_ar: 9_000 };
    H.drafts = [{ id: 'd1', balance_cents: -50_000 }, { id: 'd2', balance_cents: null }];
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100_000 })).toEqual({ status: 'ok' });
  });

  for (const mode of ['error', 'nodata', 'notlist', 'throws'] as const) {
    it(`a draft read that ${mode === 'nodata' ? 'returns no list' : mode} is unverified, never "no drafts"`, async () => {
      H.draftFail = mode;
      expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
    });
  }

  it('a draft balance that is not whole cents is unverified', async () => {
    H.drafts = [{ id: 'd1', balance_cents: 10.5 }];
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
  });

  it('a customer with no limit set passes without asking for the balance', async () => {
    H.customer = { farm_name: 'Big Farm', credit_limit_cents: null };
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'ok' });
    expect(H.rpcCalls).toEqual([]);
  });
});

describe('"Continue Anyway" overrides an over-limit warning, never a check that could not run', () => {
  async function checkWith(result: { current: ReturnType<typeof useCreditLimitCheck> }) {
    let passed: boolean | undefined;
    await act(async () => { passed = await result.current.check({ customerId: 'c1', newAmountCents: 100 }); });
    return passed;
  }

  it('over the limit, Continue Anyway lets the next check through once', async () => {
    const { result } = renderHook(() => useCreditLimitCheck());
    expect(await checkWith(result)).toBe(false);
    act(() => result.current.dismiss());
    expect(await checkWith(result)).toBe(true);
    expect(await checkWith(result)).toBe(false);
  });

  it('a check that could not run offers no override and stays stopped', async () => {
    H.customerFail = 'error';
    const { result } = renderHook(() => useCreditLimitCheck());
    expect(await checkWith(result)).toBe(false);
    expect(result.current.warning).toMatchObject({ id: 'credit-limit-error', dismissible: false });
    act(() => result.current.dismiss());
    expect(result.current.warning?.dismissed).toBe(false);
    expect(await checkWith(result)).toBe(false);
  });

  it('an earlier override does not carry over to a check that could not run', async () => {
    const { result } = renderHook(() => useCreditLimitCheck());
    expect(await checkWith(result)).toBe(false);
    act(() => result.current.dismiss());
    H.rpcFail = 'error';
    expect(await checkWith(result)).toBe(false);
    H.rpcFail = null;
    // The override was spent by the failed check, so over the limit stops again.
    expect(await checkWith(result)).toBe(false);
  });
});

describe('credit-limit check fails closed on every failed read', () => {
  const MODES: FailMode[] = ['error', 'nodata', 'notlist', 'throws'];

  for (const mode of MODES) {
    // The customer read is a single row, so it has no list to check.
    if (mode !== 'notlist') {
      it(`a customers read that ${mode === 'nodata' ? 'returns no row' : mode} is unverified, never a pass`, async () => {
        H.customerFail = mode;
        expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
        const { passed, warning } = await runHook(100);
        expect(passed).toBe(false);
        expect(warning?.id).toBe('credit-limit-error');
      });
    }

    it(`a balance read that ${mode === 'notlist' ? 'answers no object' : mode} is unverified, never a zero balance`, async () => {
      H.rpcFail = mode;
      expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
    });
  }

  for (const [label, outstanding] of [['missing', undefined], ['text', '1005'], ['negative', -5], ['fractional cents', 1.005]] as const) {
    it(`a balance that is ${label} is unverified`, async () => {
      H.rpcAnswer = { outstanding_ar: outstanding };
      expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
    });
  }

  it('an amount that is not whole cents is unverified, never a pass', async () => {
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: Number.NaN })).toEqual({ status: 'unverified' });
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100.25 })).toEqual({ status: 'unverified' });
  });

  for (const limit of ['bad', Number.NaN, 1000.5]) {
    it(`a credit limit of ${String(limit)} is unverified, never "no limit"`, async () => {
      H.customer = { farm_name: 'Big Farm', credit_limit_cents: limit };
      expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
    });
  }

  it('a credit limit of 0 still means no limit', async () => {
    H.customer = { farm_name: 'Big Farm', credit_limit_cents: 0 };
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'ok' });
  });
});
