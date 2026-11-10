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

  it('keeps figures out of the stack even when the message holds a $& sequence, and keeps the cause', () => {
    const cause = new TypeError('network timeout');
    const err = Object.assign(new Error('Charge $& 125.75 failed'), { cause });
    const result = toSentryError(err);
    expect(result.message).toBe('Charge $& # failed');
    expect(result.stack).not.toContain('125.75');
    expect((result as { cause?: unknown }).cause).toBe(cause);
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
    ['a whole JWT', 'expired eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln42 at 10', 'expired [REDACTED] at #'],
    ['a Bearer header', 'sent Bearer abc123def456 twice', 'sent [REDACTED] twice'],
    ['link tokens', '/reset#access_token=ab12&refresh_token=r3fr35h&type=recovery ?token_hash=pk9&code=x1', '/reset#[REDACTED]&[REDACTED]&type=recovery ?[REDACTED]&[REDACTED]'],
    ['fullwidth digits', 'Invoice ２０２６-００４２', 'Invoice #-#'],
  ])('removes %s before blanking figures, leaving no piece of it', (_label, message, expected) => {
    expect(toSentryError({ message }).message).toBe(expected);
    expect(toSentryError(new Error(message)).message).toBe(expected);
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
