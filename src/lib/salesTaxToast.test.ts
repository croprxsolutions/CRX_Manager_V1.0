import { describe, expect, it } from 'vitest';
import { salesTaxToast } from './salesTaxToast';

describe('salesTaxToast', () => {
  it('names the drafts updated', () => {
    expect(salesTaxToast(true, 2, 0, false)).toEqual(['success', 'Sales tax on (2 draft invoices updated)']);
  });
  it('says split drafts that could not be edited keep their tax', () => {
    expect(salesTaxToast(true, 1, 1, false)).toEqual(['info',
      "Sales tax on (1 draft invoice updated). 1 split draft can't be edited and keeps its tax until the group is voided and redrafted."]);
    expect(salesTaxToast(false, 0, 2, false)).toEqual(['info',
      "Sales tax off. 2 split drafts can't be edited and keep their tax until the group is voided and redrafted."]);
  });
  it('explains new invoices when no draft changed', () => {
    expect(salesTaxToast(false, 0, 0, true)).toEqual(['info',
      'Sales tax off. New invoices for this sale will not be taxed; posted invoices keep their tax.']);
  });
});
