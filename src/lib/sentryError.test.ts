import { describe, expect, it } from 'vitest';
import { toSentryError } from './sentryError';

describe('toSentryError', () => {
  it('keeps a real Error as the same object', () => {
    const err = new Error('boom');
    expect(toSentryError(err)).toBe(err);
  });

  it('titles a Supabase error object with its own message, not [object Object]', () => {
    const err = { code: '22P02', details: null, hint: null, message: 'invalid input syntax for type uuid: "group"' };
    expect(toSentryError(err).message).toBe('invalid input syntax for type uuid: "group"');
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
