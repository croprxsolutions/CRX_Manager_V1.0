import { describe, expect, it } from 'vitest';
import { toSentryError } from './sentryError';

describe('toSentryError', () => {
  it('keeps a real Error with no figures as the same object', () => {
    const err = new Error('boom');
    expect(toSentryError(err)).toBe(err);
  });

  it('blanks figures in a real Error and keeps its name and stack location', () => {
    const err = new TypeError('Payment of $1,250.75 failed for invoice INV-2026-0042');
    const result = toSentryError(err);
    expect(result.message).toBe('Payment of $# failed for invoice INV-#-#');
    expect(result.name).toBe('TypeError');
    expect(result.stack).not.toContain('1,250.75');
    expect(result.stack).toContain('sentryError.test');
  });

  it('titles a Supabase error object with its own message, not [object Object]', () => {
    const err = { code: 'P0001', details: null, hint: null, message: 'PRODUCT_PARENT_GROUP_CHANGED: a size changed, build a new proposal' };
    expect(toSentryError(err).message).toBe('PRODUCT_PARENT_GROUP_CHANGED: a size changed, build a new proposal');
  });

  it('blanks amounts and invoice numbers in a database message', () => {
    const err = { code: 'P0001', details: null, hint: null, message: 'Allocation of 1,250.75 exceeds balance 980.10 on invoice INV-2026-0042' };
    expect(toSentryError(err).message).toBe('Allocation of # exceeds balance # on invoice INV-#-#');
  });

  it.each([
    ['a string', 'plain text', 'plain text'],
    ['an object without a message', { code: 'X' }, '[object Object]'],
    ['null', null, 'null'],
  ])('wraps %s', (_label, value, expected) => {
    expect(toSentryError(value)).toBeInstanceOf(Error);
    expect(toSentryError(value).message).toBe(expected);
  });
});
