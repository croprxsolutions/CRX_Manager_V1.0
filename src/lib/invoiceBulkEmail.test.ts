import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ supabase: {} }));

import { invoiceEmailKey, isBulkEmailable, isEmailRateLimit, sentSinceInvoiceChanged, summarizeBulkEmail, type BulkEmailResult } from './invoiceBulkEmail';

const r = (outcome: BulkEmailResult['outcome']): BulkEmailResult => ({ invoiceId: outcome, invoiceNumber: 'X', customerName: 'C', outcome });

describe('invoiceBulkEmail', () => {
  it('emails only live posted or overdue invoices that are not suppressed', () => {
    expect(isBulkEmailable({ status: 'posted' })).toBe(true);
    expect(isBulkEmailable({ status: 'overdue', send_disposition: 'normal' })).toBe(true);
    for (const status of ['draft', 'unposted', 'paid', 'voided', 'cancelled']) expect(isBulkEmailable({ status })).toBe(false);
    expect(isBulkEmailable({ status: 'posted', send_disposition: 'suppressed_zero_total' })).toBe(false);
    expect(isBulkEmailable({ status: 'posted', deleted_at: '2026-11-01' })).toBe(false);
  });

  it('keys a send on the invoice, its last change, the address and the printed bill-to, never the clock', async () => {
    const inv = { id: 'abc', updated_at: '2026-11-05T10:00:00Z' };
    const billTo = { farm_name: 'Test Farm', billing_address: '1 Old Rd', city: 'Town', state: 'IA', zip: '50000', account_number: null, payment_terms: 'net30' };
    const key = await invoiceEmailKey(inv, 'a@x.com', billTo);
    expect(await invoiceEmailKey({ ...inv }, ' A@X.com ', { ...billTo })).toBe(key);
    expect(key).toContain('abc');
    expect(await invoiceEmailKey({ ...inv, updated_at: '2026-11-06T10:00:00Z' }, 'a@x.com', billTo)).not.toBe(key);
    expect(await invoiceEmailKey(inv, 'new@x.com', billTo)).not.toBe(key);
    expect(await invoiceEmailKey(inv, 'a@x.com', { ...billTo, billing_address: '2 New Rd' })).not.toBe(key);
    // A very long address still fits the server's 256-character key limit.
    expect((await invoiceEmailKey({ id: '13864024-12b7-4fbe-8d94-b875f01154e7', updated_at: '2026-07-20T12:24:36.790378+00:00' }, `${'a'.repeat(240)}@x.com`, billTo)).length).toBeLessThanOrEqual(256);
  });

  it('recognises the server hourly limit', () => {
    expect(isEmailRateLimit('Rate limit: 50 emails/hour exceeded for this user. Try again later.')).toBe(true);
    expect(isEmailRateLimit('Failed to send email')).toBe(false);
  });

  it('makes a partial failure visible', () => {
    expect(summarizeBulkEmail([r('sent'), r('sent')])).toEqual({ type: 'success', message: '2 emailed' });
    expect(summarizeBulkEmail([r('sent'), r('already_sent'), r('failed'), r('skipped')]))
      .toEqual({ type: 'warning', message: '1 emailed, 1 already emailed (not sent again), 2 not sent' });
    expect(summarizeBulkEmail([r('failed')]).type).toBe('error');
  });

  it('counts a log row as already sent only for this invoice, address and version (KI-104 A2)', () => {
    const A = '11111111-1111-1111-1111-111111111111';
    const B = '22222222-2222-2222-2222-222222222222';
    const inv = { id: A, updated_at: '2026-11-05T10:00:00Z' };
    const row = { idempotency_key: `invoice:invoice:${A}:invoice-email-x`, recipient_email: 'a@x.com', status: 'sent', created_at: '2026-11-05T11:00:00Z' };
    expect(sentSinceInvoiceChanged([row], inv, ' A@X.com ')).toBe(true);
    // A send of invoice B whose own key mentions A's id does not count for A.
    expect(sentSinceInvoiceChanged([{ ...row, idempotency_key: `invoice:invoice:${B}:invoice-email-${A}` }], inv, 'a@x.com')).toBe(false);
    expect(sentSinceInvoiceChanged([{ ...row, idempotency_key: `invoice-email-${A}-v1` }], inv, 'a@x.com')).toBe(false);
    expect(sentSinceInvoiceChanged([row], inv, 'new@x.com')).toBe(false);
    expect(sentSinceInvoiceChanged([{ ...row, created_at: '2026-11-05T09:59:59Z' }], inv, 'a@x.com')).toBe(false);
    expect(sentSinceInvoiceChanged([{ ...row, status: 'failed' }], inv, 'a@x.com')).toBe(false);
  });
});
