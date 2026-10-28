import { describe, expect, it } from 'vitest';
import { checkOrderCsvGroups } from './orderImportCsvGroups';

describe('repeated CSV order headers', () => {
  const headers = ['order_number', 'customer_name', 'order_date', 'notes', 'product_name'];
  const fields = { order_number: 0, customer_name: 1, order_date: 2, notes: 3 };
  const first = ['O-1', 'Wells, "Family" Farms', '2026-10-28', 'Header notes', 'SKU-A'];
  it('accepts consistent headers with distinct items and noncontiguous rows', () => {
    const result = checkOrderCsvGroups(headers, [first, ['O-2', 'Other Farm', '', '', 'SKU-B'], [...first.slice(0, 4), 'SKU-C']], [2, 3, 4], fields);
    expect(result.blocked.size).toBe(0);
    expect(result.invalid).toEqual([]);
  });
  it.each(['customer_name', 'order_date', 'notes'])('reports physical line and blocks populated %s conflicts', (field) => {
    const conflicting = [...first];
    conflicting[fields[field as keyof typeof fields]] = 'Different';
    const result = checkOrderCsvGroups(headers, [first, conflicting], [2, 5], fields);
    expect([...result.blocked]).toEqual(['O-1']);
    expect(result.invalid).toEqual([expect.objectContaining({ row: 5, error: expect.stringContaining(field) })]);
  });
  it.each([false, true])('inherits blank optional cells regardless of row order: %s', (reverse) => {
    const blank = [...first];
    blank[2] = ''; blank[3] = '';
    const result = checkOrderCsvGroups(headers, reverse ? [blank, first] : [first, blank], [2, 3], fields);
    expect(result.invalid).toEqual([]);
    expect(result.headersByOrder.get('O-1')?.slice(1, 4)).toEqual(first.slice(1, 4));
  });
  it('leaves a blank required customer to the required-field validator', () => {
    const blank = [...first]; blank[1] = '';
    expect(checkOrderCsvGroups(headers, [first, blank], [2, 3], fields).invalid).toEqual([]);
  });
});
