import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ supabase: {} }));

import { invoiceEmailKey, isBulkEmailable, isEmailRateLimit, sentSinceLastChange, summarizeBulkEmail, type BulkEmailResult } from './invoiceBulkEmail';

const r = (outcome: BulkEmailResult['outcome']): BulkEmailResult => ({ invoiceId: outcome, invoiceNumber: 'X', customerName: 'C', outcome });

describe('invoiceBulkEmail', () => {
  it('emails only live posted or overdue invoices that are not suppressed', () => {
    expect(isBulkEmailable({ status: 'posted' })).toBe(true);
    expect(isBulkEmailable({ status: 'overdue', send_disposition: 'normal' })).toBe(true);
    for (const status of ['draft', 'unposted', 'paid', 'voided', 'cancelled']) expect(isBulkEmailable({ status })).toBe(false);
    expect(isBulkEmailable({ status: 'posted', send_disposition: 'suppressed_zero_total' })).toBe(false);
    expect(isBulkEmailable({ status: 'posted', deleted_at: '2026-11-01' })).toBe(false);
  });

  it('keys a send on the invoice, its last change and the address, never the clock', async () => {
    const inv = { id: 'abc', updated_at: '2026-11-05T10:00:00Z' };
    const key = await invoiceEmailKey(inv, 'a@x.com');
    expect(await invoiceEmailKey({ ...inv }, ' A@X.com ')).toBe(key);
    expect(key).toContain('abc');
    expect(await invoiceEmailKey({ ...inv, updated_at: '2026-11-06T10:00:00Z' }, 'a@x.com')).not.toBe(key);
    expect(await invoiceEmailKey(inv, 'new@x.com')).not.toBe(key);
    // A very long address still fits the server's 256-character key limit.
    expect((await invoiceEmailKey({ id: '13864024-12b7-4fbe-8d94-b875f01154e7', updated_at: '2026-07-20T12:24:36.790378+00:00' }, `${'a'.repeat(240)}@x.com`)).length).toBeLessThanOrEqual(256);
  });

  it('recognises the server hourly limit', () => {
    expect(isEmailRateLimit('Rate limit: 50 emails/hour exceeded for this user. Try again later.')).toBe(true);
    expect(isEmailRateLimit('Failed to send email')).toBe(false);
  });

  it('finds an earlier send of this version to this address, from any screen', () => {
    const changed = '2026-11-05T10:00:00Z';
    const log = [{ recipient_email: 'A@x.com', created_at: '2026-11-05T11:00:00Z' }];
    expect(sentSinceLastChange(log, 'a@x.com', changed)).toBe(true);
    expect(sentSinceLastChange(log, 'new@x.com', changed)).toBe(false);
    expect(sentSinceLastChange(log, 'a@x.com', '2026-11-05T12:00:00Z')).toBe(false);
    expect(sentSinceLastChange([], 'a@x.com', changed)).toBe(false);
  });

  it('makes a partial failure visible', () => {
    expect(summarizeBulkEmail([r('sent'), r('sent')])).toEqual({ type: 'success', message: '2 emailed' });
    expect(summarizeBulkEmail([r('sent'), r('already_sent'), r('failed'), r('skipped')]))
      .toEqual({ type: 'warning', message: '1 emailed, 1 already emailed (not sent again), 2 not sent' });
    expect(summarizeBulkEmail([r('failed')]).type).toBe('error');
  });
});
