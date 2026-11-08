import { describe, expect, it } from 'vitest';
import { receiptsToCheckFilter } from './receiptsToCheck';

describe('receiptsToCheckFilter', () => {
  it('lists every needs_check row and owed rows still waiting after an hour, with no age cut-off', () => {
    expect(receiptsToCheckFilter(new Date('2026-11-08T12:00:00.000Z'))).toBe(
      'status.eq.needs_check,and(status.in.(pending,sending),created_at.lt."2026-11-08T11:00:00.000Z")',
    );
  });
});
