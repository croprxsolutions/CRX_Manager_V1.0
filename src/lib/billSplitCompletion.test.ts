import { describe, expect, it } from 'vitest';
import { billSplitFailedMessage, createdInvoicesMessage } from './billSplitCompletion';
import { BILL_SPLIT_FAILED_MESSAGE } from './deliverySplitBilling';

describe('createdInvoicesMessage (Create Invoice on a delivery)', () => {
  it('names every payer invoice of a Bill Split', () => {
    expect(createdInvoicesMessage({ invoice_number: 'CS-7-1', invoice_numbers: ['CS-7-1', 'CS-7-2'] }))
      .toBe('Draft invoices CS-7-1, CS-7-2 created');
  });
  it('keeps the one-invoice wording', () => {
    expect(createdInvoicesMessage({ invoice_number: 'CS-8', invoice_numbers: ['CS-8'] })).toBe('Invoice CS-8 created');
    expect(createdInvoicesMessage({ invoice_number: 'CS-9' })).toBe('Invoice CS-9 created');
  });
});

describe('billSplitFailedMessage (one warning, worded for who can fix it)', () => {
  it('gives an admin the fix steps', () => {
    expect(billSplitFailedMessage('admin')).toBe(BILL_SPLIT_FAILED_MESSAGE);
  });
  it('tells anyone else the admins have it', () => {
    for (const role of ['sales_rep', 'driver', undefined]) {
      expect(billSplitFailedMessage(role)).toBe(
        "Delivery completed, but its Bill Split invoices couldn't be drafted. Admins have been told and will draft them.");
    }
  });
});
