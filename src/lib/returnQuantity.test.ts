import { describe, expect, it } from 'vitest';
import { returnableHundredths } from './returnQuantity';

describe('returnableHundredths (a return holds 2 decimal places)', () => {
  it("offers a payer's 4-place share rounded down, never up", () => {
    expect(returnableHundredths(0.7083)).toBe(0.7);
    expect(returnableHundredths(1.2042)).toBe(1.2);
    expect(returnableHundredths(2.125)).toBe(2.12);
  });
  it('keeps whole hundredths exact despite float noise', () => {
    expect(returnableHundredths(0.29)).toBe(0.29);
    expect(returnableHundredths(4)).toBe(4);
  });
  it('a sliver under 0.01 has nothing returnable', () => {
    expect(returnableHundredths(0.0083)).toBe(0);
  });
});
