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

  it('conserves split quantities and only permits an exact draft completion adjustment', () => {
    expect(sql).not.toContain('transaction_timestamp() - interval');
    expect(sql).toContain("NEW.order_item_id IS NOT NULL AND v_invoice.status = 'draft' AND NEW.quantity = (");
    expect(sql).toContain('d.order_id = v_invoice.order_id AND d.is_quick_delivery');
    expect(sql).toContain("d.status = 'completed' AND d.deleted_at IS NULL");
    expect(sql).toContain('v_reason := public._order_invoice_overbilling(v_invoice.order_id)');
    expect(sql).toContain('ii.quantity AS quantity');
    expect(sql).toContain('SELECT per_delivery FROM invoice_mode');
    expect(sql).toContain('THEN sum(round(coalesce(di.quantity_delivered, 0), 4))');
    expect(sql).toContain('ELSE round(sum(coalesce(di.quantity_delivered, 0)), 4) END AS qty');
    expect(sql).toContain('billed_qty > allowed_qty');
    expect(sql).not.toContain('allowed_qty + 0.001');
    expect(sql).toContain('SPLIT_QUANTITY_RECONCILIATION_FAILED');
    expect(sql).not.toContain('line_rounding AS');
  });

  it('requires the posted invoice to be voided before its delivery is voided or cancelled', () => {
    const trigger = sql.slice(sql.indexOf('CREATE TRIGGER zz_delivery_void_needs_invoice_void'));
    // BEFORE the status change; drafts never block, so cancel/void cancelling their own drafts is unaffected
    expect(trigger).toMatch(/BEFORE UPDATE OF status, deleted_at, order_id ON public\.deliveries/);
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
