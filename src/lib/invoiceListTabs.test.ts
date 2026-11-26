import { describe, expect, it } from 'vitest';
import { chemicalInvoiceTab, invoiceTabAlias } from './invoiceListTabs';

describe('invoice list tab from the address', () => {
  it('keeps old aliases and status links', () => {
    expect(chemicalInvoiceTab('unposted', '')).toBe('drafts');
    expect(chemicalInvoiceTab('summary', '')).toBe('customer');
    expect(chemicalInvoiceTab('', 'overdue')).toBe('posted');
    expect(chemicalInvoiceTab('', 'voided')).toBe('all');
  });

  it('ignores inherited object names such as ?tab=toString', () => {
    expect(invoiceTabAlias('toString')).toBeUndefined();
    expect(chemicalInvoiceTab('toString', '')).toBe('all');
    expect(chemicalInvoiceTab('constructor', 'draft')).toBe('drafts');
  });
});
