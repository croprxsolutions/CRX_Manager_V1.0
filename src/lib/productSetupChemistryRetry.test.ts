import { describe, expect, it } from 'vitest';
import { isSetupChemistryRetryExpired, SETUP_CHEMISTRY_SAFE_RETRY_WINDOW_MS } from './productSetupChemistry';

describe('setup chemistry retry window', () => {
  const now = 1_800_000_000_000;

  it('allows retry while the idempotency receipt is safely inside its server lifetime', () => {
    expect(isSetupChemistryRetryExpired(now - SETUP_CHEMISTRY_SAFE_RETRY_WINDOW_MS + 1, now)).toBe(false);
  });

  it('fails closed at the conservative cutoff and for invalid or future timestamps', () => {
    expect(isSetupChemistryRetryExpired(now - SETUP_CHEMISTRY_SAFE_RETRY_WINDOW_MS, now)).toBe(true);
    expect(isSetupChemistryRetryExpired(Number.NaN, now)).toBe(true);
    expect(isSetupChemistryRetryExpired(now + 1, now)).toBe(true);
  });
});
