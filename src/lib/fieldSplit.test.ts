import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSplitSaveKey, evenMicroShares, microToPctText, pctTextToMicro, splitProblem, splitSaveErrorMessage, splitSaveKey,
} from './fieldSplit';

describe('field split shares (micro-percent)', () => {
  it('thirds total exactly 100% and show as 33.33', () => {
    expect(evenMicroShares(3)).toEqual([33_333_334, 33_333_333, 33_333_333]);
    expect(evenMicroShares(3).map(microToPctText)).toEqual(['33.33', '33.33', '33.33']);
    expect(evenMicroShares(7).reduce((a, b) => a + b, 0)).toBe(100_000_000);
  });

  it('reads typed percents exactly and refuses blank, negative or over 100', () => {
    expect(pctTextToMicro('33.333334')).toBe(33_333_334);
    expect(pctTextToMicro('0')).toBe(0);
    expect(pctTextToMicro('100')).toBe(100_000_000);
    expect(pctTextToMicro('.5')).toBe(500_000);
    for (const bad of ['', ' ', '-1', '100.01', 'abc', '1.1234567']) expect(pctTextToMicro(bad)).toBeNull();
  });

  it('refuses a 90% total, a duplicate payer and a blank share; allows a 0% payer', () => {
    const row = (id: string, p: number | null, a: number | null) => ({ customer_id: id, productMicro: p, appMicro: a });
    expect(splitProblem([row('a', 50_000_000, 50_000_000), row('b', 40_000_000, 40_000_000)])).toMatch(/Product shares must total exactly 100% \(now 90%\)/);
    expect(splitProblem([row('a', 50_000_000, 50_000_000), row('a', 50_000_000, 50_000_000)])).toMatch(/listed twice/);
    expect(splitProblem([row('a', null, 100_000_000)])).toMatch(/0 is allowed/);
    expect(splitProblem([])).toMatch(/at least one payer/);
    expect(splitProblem([row('a', 100_000_000, 100_000_000), row('b', 0, 0)])).toBeNull();
    // Until FP-4 each payer's two shares must match (the database refuses otherwise).
    expect(splitProblem([row('a', 60_000_000, 100_000_000), row('b', 40_000_000, 0)])).toMatch(/must be the same/);
  });

  it('turns database refusals into plain messages', () => {
    expect(splitSaveErrorMessage('FIELD_SPLIT_DUPLICATE_PAYER: a customer is listed twice')).toBe('A customer is listed twice in the split.');
    expect(splitSaveErrorMessage('something else')).toBe('something else');
  });
});

describe('split save retry key (contract rule 3)', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('keeps one key per request across retries and reloads, a new key for a different request', () => {
    const first = splitSaveKey('user-1', 'field-1', 'request-A');
    expect(splitSaveKey('user-1', 'field-1', 'request-A')).toBe(first);
    expect(window.sessionStorage.getItem('crx:field-split-save:v1:user-1:field-1')).toContain(first); // survives a reload
    const second = splitSaveKey('user-1', 'field-1', 'request-B');
    expect(second).not.toBe(first);
    expect(second).toMatch(/^set_field_billing_split:user-1:/);
    clearSplitSaveKey('user-1', 'field-1');
    expect(splitSaveKey('user-1', 'field-1', 'request-B')).not.toBe(second);
  });
});
