import { describe, expect, it, vi } from 'vitest';
import { classifyParentRatesSaveFailure, handleRatesSaveFailure, type DeferredRatesRebase, type RatesState } from './setupWorkbookRateRecovery';
import type { RateUploadRow } from '../../lib/productSetupWorkbook';

const row = { product_id: 'p1', rate_per_acre: '14', rate_unit: 'oz', suggested_rate: null } as unknown as RateUploadRow;
const rebasedRow = { ...row, rate_per_acre: '15' } as RateUploadRow;
const preview = { rates_locked: false, rows: [] } as unknown as Exclude<RatesState, null>['preview'];
const currentRates = { rows: [row], preview };

const unanswered = new TypeError('Failed to fetch');
const postgrest = { code: 'PGRST202', message: 'Could not find the function in the schema cache' };
const authRefusal = { code: '42501', message: 'ADMIN_REQUIRED' };
const namedRefusal = { code: 'P0001', message: 'PRODUCT_RATE_INVALID: invalid rate unit' };
const stale = { code: 'P0001', message: 'PRODUCT_RATES_STALE: preview changed' };
const locked = { code: 'P0001', message: 'PRODUCT_RATES_LOCKED: rates are locked' };

function run(error: unknown, hadRetryPending: boolean, deferred: DeferredRatesRebase = null, generation = 1) {
  const ratesRetryPending = { current: hadRetryPending };
  const deferredRatesRebase = { current: deferred };
  const setRates = vi.fn();
  const resetKey = vi.fn();
  const message = handleRatesSaveFailure({ error, hadRetryPending, currentRates, generation, ratesRetryPending, deferredRatesRebase, setRates, resetKey });
  const applied = setRates.mock.calls.map(([update]) => (typeof update === 'function' ? update(currentRates) : update));
  return { message, retryPending: ratesRetryPending.current, deferred: deferredRatesRebase.current, resetKey, applied };
}

describe('Rates save failure (same key until the outcome is known)', () => {
  it('keeps the key and the pending state when no reply arrived', () => {
    const result = run(unanswered, false);
    expect(result.retryPending).toBe(true);
    expect(result.resetKey).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
    expect(result.message).toMatch(/may have gone through.*retry the same request/);
  });

  it.each([['PostgREST refusal', postgrest], ['authorization refusal', authRefusal], ['unanswered', unanswered]])(
    'keeps the key on a retry after a %s (it cannot prove the first send did nothing)', (_label, error) => {
      const result = run(error, true);
      expect(result.retryPending).toBe(true);
      expect(result.resetKey).not.toHaveBeenCalled();
    });

  it('retires the key on a named refusal of a first send', () => {
    const result = run(namedRefusal, false);
    expect(result.retryPending).toBe(false);
    expect(result.resetKey).toHaveBeenCalledOnce();
    expect(result.message).toMatch(/invalid rate unit/i);
  });

  it('retires the key and drops the preview when the server says the preview is stale', () => {
    const result = run(stale, true);
    expect(result.retryPending).toBe(false);
    expect(result.resetKey).toHaveBeenCalledOnce();
    expect(result.applied).toEqual([{ rows: [row], preview: null }]);
  });

  it('marks the preview locked on a lock refusal and forgets any deferred rebase', () => {
    const result = run(locked, true, { source: JSON.stringify([currentRates.rows, currentRates.preview]), generation: 1, rows: [rebasedRow] });
    expect(result.resetKey).toHaveBeenCalledOnce();
    expect(result.applied).toEqual([{ rows: [row], preview: { ...preview, rates_locked: true } }]);
    expect(result.deferred).toBeNull();
  });

  it('applies a deferred Setup rebase only when it was made from this exact request and generation', () => {
    const source = JSON.stringify([currentRates.rows, currentRates.preview]);
    const matching = run(stale, true, { source, generation: 1, rows: [rebasedRow] });
    expect(matching.applied).toEqual([{ rows: [rebasedRow], preview: null }]);
    expect(matching.deferred).toBeNull();

    const otherGeneration = run(stale, true, { source, generation: 2, rows: [rebasedRow] });
    expect(otherGeneration.applied).toEqual([{ rows: [row], preview: null }]);
    const otherRequest = run(stale, true, { source: JSON.stringify([[rebasedRow], preview]), generation: 1, rows: [rebasedRow] });
    expect(otherRequest.applied).toEqual([{ rows: [row], preview: null }]);
  });

  it('keeps a deferred rebase while the save is still unanswered', () => {
    const deferred = { source: JSON.stringify([currentRates.rows, currentRates.preview]), generation: 1, rows: [rebasedRow] };
    expect(run(unanswered, true, deferred).deferred).toBe(deferred);
  });
});

describe('Parent Rates save failure', () => {
  it('keeps the request pending when no reply arrived', () => {
    expect(classifyParentRatesSaveFailure(unanswered, false, false)).toMatchObject({ retryPending: true, authorizationRefusal: false });
  });

  it.each([['PostgREST refusal', postgrest], ['authorization refusal', authRefusal], ['unanswered', unanswered]])(
    'keeps a retried request pending after a %s', (_label, error) => {
      expect(classifyParentRatesSaveFailure(error, true, false).retryPending).toBe(true);
    });

  it('names the authorization refusal and says whether an earlier save may have gone through', () => {
    expect(classifyParentRatesSaveFailure(authRefusal, true, false).message).toMatch(/previous parent-rate save may have gone through/);
    const first = classifyParentRatesSaveFailure(authRefusal, false, false);
    expect(first).toMatchObject({ retryPending: false, authorizationRefusal: true });
    expect(first.message).toMatch(/then try the save again/);
  });

  it('ends the pending state on a named refusal or a known stale/lock refusal', () => {
    expect(classifyParentRatesSaveFailure(namedRefusal, false, false)).toMatchObject({ retryPending: false, message: expect.stringMatching(/invalid rate unit/i) });
    expect(classifyParentRatesSaveFailure({ code: 'P0001', message: 'PRODUCT_PARENT_STALE: reload' }, true, true).retryPending).toBe(false);
  });

  it('uses Parent Rates wording, never the Rates wording', () => {
    expect(classifyParentRatesSaveFailure(unanswered, false, false).message).not.toMatch(/rate save may have gone through/);
    expect(run(unanswered, false).message).not.toMatch(/parent-rate/);
  });
});
