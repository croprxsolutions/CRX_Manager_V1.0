import { describe, expect, it } from 'vitest';
import { bulkInvoiceEmailKey, isBulkEmailable, summarizeBulkEmail, type BulkEmailResult } from './invoiceBulkEmail';

const r = (outcome: BulkEmailResult['outcome']): BulkEmailResult => ({ invoiceId: outcome, invoiceNumber: 'X', customerName: 'C', outcome });

describe('invoiceBulkEmail', () => {
  it('emails only live posted or overdue invoices that are not suppressed', () => {
    expect(isBulkEmailable({ status: 'posted' })).toBe(true);
    expect(isBulkEmailable({ status: 'overdue', send_disposition: 'normal' })).toBe(true);
    for (const status of ['draft', 'unposted', 'paid', 'voided', 'cancelled']) expect(isBulkEmailable({ status })).toBe(false);
    expect(isBulkEmailable({ status: 'posted', send_disposition: 'suppressed_zero_total' })).toBe(false);
    expect(isBulkEmailable({ status: 'posted', deleted_at: '2026-11-01' })).toBe(false);
  });

  it('keys a send on the invoice and its last change, never the clock', () => {
    const inv = { id: 'abc', updated_at: '2026-11-05T10:00:00Z' };
    expect(bulkInvoiceEmailKey(inv)).toBe(bulkInvoiceEmailKey({ ...inv }));
    expect(bulkInvoiceEmailKey(inv)).toContain('abc');
    expect(bulkInvoiceEmailKey({ ...inv, updated_at: '2026-11-06T10:00:00Z' })).not.toBe(bulkInvoiceEmailKey(inv));
  });

  it('makes a partial failure visible', () => {
    expect(summarizeBulkEmail([r('sent'), r('sent')])).toEqual({ type: 'success', message: '2 emailed' });
    expect(summarizeBulkEmail([r('sent'), r('already_sent'), r('failed'), r('skipped')]))
      .toEqual({ type: 'warning', message: '1 emailed, 1 already emailed (not sent again), 2 not sent' });
    expect(summarizeBulkEmail([r('failed')]).type).toBe('error');
  });
});
