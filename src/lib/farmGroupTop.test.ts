import { describe, expect, it } from 'vitest';
import { farmGroupTopName, type FarmGroupNode } from './farmGroupTop';

const nodes: Record<string, FarmGroupNode> = {
  a: { farm_name: 'Alpha', parent_customer_id: null },
  b: { farm_name: 'Bravo', parent_customer_id: 'a' },
  c: { farm_name: 'Charlie', parent_customer_id: 'b' },
  x: { farm_name: 'Xray', parent_customer_id: 'y' },
  y: { farm_name: 'Yankee', parent_customer_id: 'x' },
  h: { farm_name: 'Hotel', parent_customer_id: 'hidden' },
};

describe('farmGroupTopName', () => {
  it('names the top parent however deep the group is', () => {
    expect(farmGroupTopName('a', nodes)).toBe('Alpha');
    expect(farmGroupTopName('b', nodes)).toBe('Alpha');
    expect(farmGroupTopName('c', nodes)).toBe('Alpha');
  });
  it('shows nothing with no parent or an unknown parent', () => {
    expect(farmGroupTopName(null, nodes)).toBeNull();
    expect(farmGroupTopName('missing', nodes)).toBeNull();
  });
  it('stops at the highest known ancestor', () => {
    expect(farmGroupTopName('h', nodes)).toBe('Hotel');
  });
  it('ends on a loop and shows the direct parent', () => {
    expect(farmGroupTopName('x', nodes)).toBe('Xray');
    expect(farmGroupTopName('y', nodes)).toBe('Yankee');
  });
});
