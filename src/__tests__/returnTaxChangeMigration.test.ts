/**
 * Contract for 20270307100000_return_tax_change_credit (#2066, #2091). The behaviour is proven on the real schema by
 * scripts/smoke/prove-return-tax-change-real-schema.mjs; this pins the shape the proof relies on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync('supabase/migrations/20270307100000_return_tax_change_credit.sql', 'utf8');

function body(name: string): string {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(0);
  const open = MIGRATION.indexOf('AS $function$', start);
  return MIGRATION.slice(open, MIGRATION.indexOf('$function$;', open + 13));
}

describe('20270307100000 return credit after a tax change, and the tax ledger timing', () => {
  it('runs as one transaction and pins the three bodies it re-emits', () => {
    expect(MIGRATION).toContain('RETURN_TAX_CHANGE_NOT_IN_TRANSACTION');
    expect(MIGRATION).toContain("'67566a09967e74b1ee813354038955b0'");
    expect(MIGRATION).toContain("'0d5209ab7179f36d71f548b55a6cf77d'");
    expect(MIGRATION).toContain("'6b175becb29ac202c5b1983ddc6686a5'");
    expect(MIGRATION).toContain("'dd95a7decaea1130352bc03e31f23ccf'");
    expect(MIGRATION.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(4);
  });

  for (const fn of ['_receive_return_intent_impl_20260812', '_issue_return_credit_intent_impl_20260812']) {
    it(`${fn}: re-prices order-price lines under the line locks, audits it, and still refuses any other stale price`, () => {
      const b = body(fn);
      const lock = b.indexOf('pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361))');
      const reprice = b.indexOf('UPDATE public.return_items ri');
      const refusal = b.indexOf("RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'");
      expect(lock).toBeGreaterThan(0);
      expect(reprice).toBeGreaterThan(lock);
      expect(refusal).toBeGreaterThan(reprice);
      expect(b).toContain("AND ri.priced_from = 'order_price'");
      expect(b).toContain('RETURN_REPRICE_OTHER_RETURN_PENDING');
      // only this return's lines are written
      expect(b).toContain('WHERE ri.id = f.id AND f.extended_cents >= 0');
      expect(b).not.toContain('jsonb_to_recordset');
      expect(b).toContain('INSERT INTO public.financial_audit_log');
    });
  }

  it('receive_return re-prices only for a caller who can read every posted invoice it prices from', () => {
    const b = body('_receive_return_intent_impl_20260812');
    const refusal = b.indexOf("RAISE EXCEPTION 'RETURN_SPLIT_INVOICE_NOT_VISIBLE'");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(b.indexOf('UPDATE public.return_items ri'));
  });

  it('create_return records how it priced each line', () => {
    expect(body('_create_return_intent_impl_20260812')).toContain("CASE WHEN v_share.share_mode THEN 'billed_share' ELSE 'order_price' END");
    expect(MIGRATION).toContain("CHECK (priced_from IN ('order_price', 'billed_share'))");
  });

  it('issue_return_credit re-prices before its billed-share cap', () => {
    const b = body('_issue_return_credit_intent_impl_20260812');
    expect(b.indexOf('UPDATE public.return_items ri')).toBeLessThan(b.indexOf("RAISE EXCEPTION 'RETURN_CREDIT_EXCEEDS_BILLED_SHARE'"));
  });

  it('the tax ledger no longer cuts the pool at the credit posting time', () => {
    const b = body('_freeze_credit_sales_tax_20270109');
    expect(b).not.toContain('<= v_inv.booked_at');
    expect(b).toContain("i.status IN ('posted', 'overdue', 'paid')");
  });
});
