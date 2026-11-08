import { describe, expect, it } from 'vitest';
import { receiptsToCheckFilter } from './receiptsToCheck';

describe('receiptsToCheckFilter', () => {
  it('lists needs_check rows and owed rows still waiting after an hour, from the last 14 days', () => {
    const { or, since } = receiptsToCheckFilter(new Date('2026-11-08T12:00:00.000Z'));
    expect(or).toBe('status.eq.needs_check,and(status.in.(pending,sending),created_at.lt.2026-11-08T11:00:00.000Z)');
    expect(since).toBe('2026-10-25T12:00:00.000Z');
  });
});
