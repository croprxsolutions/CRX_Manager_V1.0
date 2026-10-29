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
  });

  it('leaves void_delivery and cancel_delivery alone (to-do 3.5)', () => {
    expect(sql).not.toMatch(/CREATE TRIGGER \S+\s+AFTER[^;]*ON public\.(deliveries|delivery_items)/);
    expect(sql).not.toContain('delivery reduction');
  });

  it('reports malformed invoice lines separately from over-delivery', () => {
    expect(sql).toContain('ORDER_INVOICE_LINE_INVALID: a non-product line requires a charge type');
    expect(sql).toContain("RAISE EXCEPTION 'ORDER_INVOICE_EXCEEDS_DELIVERED: %', v_reason");
    expect(sanitizer).toContain('/^ORDER_INVOICE_LINE_INVALID\\b/');
    expect(sanitizer).toContain('/^ORDER_INVOICE_EXCEEDS_DELIVERED\\b/');
  });
});
