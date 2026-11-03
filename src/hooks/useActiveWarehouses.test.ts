import { describe, expect, it } from 'vitest';
import { warehouseOptions } from './useActiveWarehouses';

describe('warehouseOptions', () => {
  it('offers only the active warehouses when they hold the current choice', () => {
    expect(warehouseOptions(['Main Warehouse', 'North'], 'North')).toEqual(['Main Warehouse', 'North']);
  });
  it('keeps the current choice visible before the list loads or after it is retired', () => {
    expect(warehouseOptions([], 'Main Warehouse')).toEqual(['Main Warehouse']);
    expect(warehouseOptions(['Main Warehouse'], 'Cold Storage')).toEqual(['Cold Storage', 'Main Warehouse']);
  });
});
