import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261029160000_cap_order_invoices_at_delivered.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const sanitizer = readFileSync('src/lib/errorSanitizer.ts', 'utf8').replace(/\r\n/g, '\n');

describe('20261029160000 order invoice delivered cap', () => {
  it('preflights every active order-backed non-credit invoice', () => {
    const preflight = sql.slice(sql.indexOf('DO $preflight$'), sql.indexOf('$preflight$;'));
    expect(preflight).toContain("invoice_type <> 'credit_memo'");
    expect(preflight).not.toContain('delivery_id IS NULL');
  });

  it('checks every invoice line increase against order-wide quantities without a timing exception', () => {
    expect(sql).not.toContain('transaction_timestamp() - interval');
    expect(sql).toContain('Every increase, including changes made during delivery completion');
    expect(sql).toContain('v_reason := public._order_invoice_overbilling(v_invoice.order_id)');
    expect(sql).toContain('round(ii.quantity, 4) AS quantity');
    // field splits round shares to 4 places, so 0.6667 x 3 may exceed 2 by 0.0001
    expect(sql).toContain('billed_qty > allowed_qty + 0.001');
  });

  it('requires the posted invoice to be voided before its delivery is voided or cancelled', () => {
    const trigger = sql.slice(sql.indexOf('CREATE TRIGGER zz_delivery_void_needs_invoice_void'));
    // BEFORE the status change; drafts never block, so cancel/void cancelling their own drafts is unaffected
    expect(trigger).toMatch(/BEFORE UPDATE OF status ON public\.deliveries/);
    expect(trigger).toContain("NEW.status IN ('voided', 'cancelled')");
    expect(sql).toContain("i.status IN ('posted', 'paid', 'overdue')");
    expect(sql).toContain("(NEW.status = 'voided' AND i.status = 'unposted')");
    expect(sql).toContain('FOR UPDATE NOWAIT');
    expect(sql).toContain('DELIVERY_HAS_POSTED_INVOICE');
    expect(sql).not.toMatch(/CREATE TRIGGER \S+\s+AFTER[^;]*ON public\.(deliveries|delivery_items)/);
  });

  it('reports malformed invoice lines separately from over-delivery', () => {
    expect(sql).toContain('ORDER_INVOICE_LINE_INVALID: a non-product line requires a charge type');
    expect(sql).toContain("RAISE EXCEPTION 'ORDER_INVOICE_EXCEEDS_DELIVERED: %', v_reason");
    expect(sanitizer).toContain('/^ORDER_INVOICE_LINE_INVALID\\b/');
    expect(sanitizer).toContain('/^ORDER_INVOICE_EXCEEDS_DELIVERED\\b/');
  });
});
