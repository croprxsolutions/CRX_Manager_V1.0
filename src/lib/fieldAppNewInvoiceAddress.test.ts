import { describe, expect, it } from 'vitest';
import { draftTokenFromAddress, draftTokenStartedAt, mintDraftToken } from './fieldAppNewInvoiceAddress';

describe('draft tokens carry the time they started', () => {
  it('reads back the time a token was minted', () => {
    const now = Date.UTC(2026, 9, 12, 18, 30, 15, 123);
    const token = mintDraftToken(now);
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(draftTokenStartedAt(token)).toBe(now);
  });

  it('is a valid draft address token', () => {
    const token = mintDraftToken();
    expect(draftTokenFromAddress(new URLSearchParams({ draft: token }))).toBe(token);
  });

  it('two tokens minted at the same moment differ', () => {
    expect(mintDraftToken(1000)).not.toBe(mintDraftToken(1000));
  });

  it('a token without its time (another UUID version) or a malformed one has no start time', () => {
    expect(draftTokenStartedAt('5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f')).toBeNull();
    expect(draftTokenStartedAt('not-a-token')).toBeNull();
  });
});
