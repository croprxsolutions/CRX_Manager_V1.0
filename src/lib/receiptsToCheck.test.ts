import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./db', () => ({
  supabaseUntyped: { rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: (data: unknown) => data,
}));

import {
  closeDeliveryReceipt, isReceiptChanged, isReceiptSendingNow, receiptCloseScope, receiptMayAlreadyBeSent, receiptsToCheckFilter,
  queuedMeanwhileWarning,
} from './receiptsToCheck';

const result = (over = {}) => ({
  delivery_id: 'd1', outcome: 'paused' as const, previous_status: 'pending', sent_at: null, send_authorized_at: null, queued_at: null, ...over,
});

describe('receiptsToCheckFilter', () => {
  it('lists every needs_check row and owed rows still waiting after an hour, with no age cut-off', () => {
    expect(receiptsToCheckFilter(new Date('2026-11-08T12:00:00.000Z'))).toBe(
      'status.eq.needs_check,and(status.in.(pending,sending),created_at.lt."2026-11-08T11:00:00.000Z")',
    );
  });
});

describe('closeDeliveryReceipt', () => {
  beforeEach(() => rpc.mockReset());

  it('sends the delivery, the reason and the given retry key', async () => {
    rpc.mockResolvedValue({ data: result(), error: null });
    await closeDeliveryReceipt('d1', 'manual_send', 'k1');
    expect(rpc).toHaveBeenCalledWith('close_delivery_receipt', { p_delivery_id: 'd1', p_reason: 'manual_send', p_idempotency_key: 'k1' });
    expect(receiptCloseScope('d1', 'handled')).not.toBe(receiptCloseScope('d1', 'manual_send'));
  });

  it('names the receipt it means when given, and gives each receipt its own retry key (#2251)', async () => {
    rpc.mockResolvedValue({ data: result(), error: null });
    await closeDeliveryReceipt('d1', 'handled', 'k1', '2026-11-08T12:00:00.123456+00:00');
    expect(rpc).toHaveBeenCalledWith('close_delivery_receipt', {
      p_delivery_id: 'd1', p_reason: 'handled', p_idempotency_key: 'k1', p_expected_queued_at: '2026-11-08T12:00:00.123456+00:00',
    });
    expect(receiptCloseScope('d1', 'handled', 'a')).not.toBe(receiptCloseScope('d1', 'handled', 'b'));
    expect(receiptCloseScope('d1', 'handled', 'a')).toBe(receiptCloseScope('d1', 'handled', 'a'));
  });

  it('recognises the changed-receipt refusal', () => {
    expect(isReceiptChanged({ message: 'DELIVERY_RECEIPT_CHANGED: queued again' })).toBe(true);
    expect(isReceiptChanged({ message: 'DELIVERY_RECEIPT_SENDING' })).toBe(false);
  });

  it('throws the database refusal so the screen can say why', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'DELIVERY_RECEIPT_SENDING: try again in a minute' } });
    await expect(closeDeliveryReceipt('d1', 'handled', 'k1')).rejects.toSatisfy(isReceiptSendingNow);
  });
});

describe('receiptMayAlreadyBeSent', () => {
  it('is true when the server sent it, or recorded or authorized a send', () => {
    expect(receiptMayAlreadyBeSent(result({ outcome: 'sent' }))).toBe(true);
    expect(receiptMayAlreadyBeSent(result({ sent_at: '2026-11-08T12:00:00Z' }))).toBe(true);
    expect(receiptMayAlreadyBeSent(result({ send_authorized_at: '2026-11-08T12:00:00Z' }))).toBe(true);
    expect(receiptMayAlreadyBeSent(result())).toBe(false);
    expect(receiptMayAlreadyBeSent(result({ outcome: 'none' }))).toBe(false);
  });
});

describe('queuedMeanwhileWarning (#2291)', () => {
  const row = (status: string, sent_at: string | null = null, send_authorized_at: string | null = null) => ({ status, sent_at, send_authorized_at });
  it('is quiet only for no receipt, or one handled with no send recorded or authorized', () => {
    expect(queuedMeanwhileWarning(null)).toBeNull();
    expect(queuedMeanwhileWarning(row('cancelled'))).toBeNull();
  });
  it('says a handled receipt the server emailed may be a second copy (Sol r2 MED)', () => {
    expect(queuedMeanwhileWarning(row('cancelled', '2026-11-23T06:00:00Z'))).toMatch(/may have two receipts/);
    expect(queuedMeanwhileWarning(row('cancelled', null, '2026-11-23T06:00:00Z'))).toMatch(/may have two receipts/);
    expect(queuedMeanwhileWarning(row('needs_check', '2026-11-23T06:00:00Z'))).toMatch(/may have two receipts/);
  });
  it('points to the list for one to check, and warns for one still waiting', () => {
    expect(queuedMeanwhileWarning(row('needs_check'))).toMatch(/Customer receipts to check/);
    expect(queuedMeanwhileWarning(row('pending'))).toMatch(/server may email it too/);
    expect(queuedMeanwhileWarning(row('sending'))).toMatch(/server may email it too/);
  });
});
