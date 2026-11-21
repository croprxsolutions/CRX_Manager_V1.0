import { describe, expect, it } from 'vitest';
import { topFarmGroupName } from './farmGroupTop';

describe('topFarmGroupName (#1995)', () => {
  const rows = {
    a: { farm_name: 'A', parent_customer_id: null },
    b: { farm_name: 'B', parent_customer_id: 'a' },
    x: { farm_name: 'X', parent_customer_id: 'y' },
    y: { farm_name: 'Y', parent_customer_id: 'x' },
    h: { farm_name: 'H', parent_customer_id: 'hidden' },
  };
  it('shows the top parent of a multi-level group (A > B > C: C shows A)', () => {
    expect(topFarmGroupName('b', rows)).toBe('A');
    expect(topFarmGroupName('a', rows)).toBe('A');
  });
  it('stops at the highest ancestor the caller can see', () => {
    expect(topFarmGroupName('h', rows)).toBe('H');
    expect(topFarmGroupName('hidden', rows)).toBeNull();
  });
  it('shows the direct parent when the chain loops', () => {
    expect(topFarmGroupName('x', rows)).toBe('X');
  });
});
