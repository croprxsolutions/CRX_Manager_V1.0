import { describe, expect, it } from 'vitest';
import { phoneDialHref } from './phoneDial';

describe('phoneDialHref', () => {
  it('dials a plain number with only its digits', () => {
    expect(phoneDialHref('(555) 123-4567')).toBe('tel:5551234567');
    expect(phoneDialHref('+1 (555) 123-4567')).toBe('tel:+15551234567');
  });

  it('dials an extension after a pause instead of adding it to the number', () => {
    expect(phoneDialHref('+1 (555) 123-4567 ext. 89')).toBe('tel:+15551234567,89');
    expect(phoneDialHref('555-123-4567 x89')).toBe('tel:5551234567,89');
    expect(phoneDialHref('555.123.4567 Extension 1234')).toBe('tel:5551234567,1234');
  });
});
