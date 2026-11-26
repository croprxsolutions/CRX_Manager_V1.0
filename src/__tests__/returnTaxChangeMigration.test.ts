/**
 * Contract for 20270313040000_return_tax_change_credit (#2066). The behaviour is proven on the real schema by
 * scripts/smoke/prove-return-tax-change-real-schema.mjs; this pins the shape the proof relies on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync('supabase/migrations/20270313040000_return_tax_change_credit.sql', 'utf8');

function body(name: string): string {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(0);
  const open = MIGRATION.indexOf('AS $function$', start);
  return MIGRATION.slice(open, MIGRATION.indexOf('$function$;', open + 13));
}

describe('20270313040000 return credit after a tax change', () => {
  it('runs as one transaction and pins the four bodies it re-emits', () => {
    expect(MIGRATION).toContain('RETURN_TAX_CHANGE_NOT_IN_TRANSACTION');
    expect(MIGRATION).toContain("'67566a09967e74b1ee813354038955b0'");
    expect(MIGRATION).toContain("'0d5209ab7179f36d71f548b55a6cf77d'");
    // the tax ledger freeze (#2591) is not re-emitted
    expect(MIGRATION).not.toContain('_freeze_credit_sales_tax_20270109');
    expect(MIGRATION).toContain("'dd95a7decaea1130352bc03e31f23ccf'");
    expect(MIGRATION).toContain("'8e799519fa332cb51465f51b5c3585e7'");
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
      expect(b).toContain('     WHERE ri.id = f.id\n');
      // priced from the customer's posted lots; units still on a draft wait (Mason, 26 Nov), units on no invoice are refused
      expect(b).toContain('public._return_order_price_lot_price(');
      expect(b).toContain("RAISE EXCEPTION 'RETURN_UNITS_ON_DRAFT");
      expect(b.indexOf('RETURN_UNITS_ON_DRAFT')).toBeLessThan(b.indexOf('RETURN_UNITS_NOT_INVOICED'));
      expect(b).toContain('RETURN_UNITS_NOT_INVOICED');
      expect(b).toContain('AND lp.applies AND lp.fits');
      expect(b).not.toContain('jsonb_to_recordset');
      expect(b).toContain('INSERT INTO public.financial_audit_log');
    });
  }

  it('receive_return re-prices only for a caller who can read every posted invoice it prices from', () => {
    const b = body('_receive_return_intent_impl_20260812');
    const refusal = b.indexOf("RAISE EXCEPTION 'RETURN_SPLIT_INVOICE_NOT_VISIBLE'");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(b.indexOf('UPDATE public.return_items ri'));
    const unit = b.indexOf("RAISE EXCEPTION 'RETURN_CREDIT_UNIT_MISMATCH'");
    expect(unit).toBeGreaterThan(0);
    expect(unit).toBeLessThan(b.indexOf('UPDATE public.return_items ri'));
  });

  it('only a POSTED tax or discount line switches a line to share pricing', () => {
    const b = body('_return_customer_line_share');
    expect(b).toContain("AND i.status IN ('posted', 'overdue', 'paid')  -- (#2066)");
    expect(b).not.toContain("AND i.status NOT IN ('voided', 'cancelled')");
  });

  it('a re-priced line keeps its order_price origin, and only a line whose price changes is re-priced', () => {
    for (const fn of ['_receive_return_intent_impl_20260812', '_issue_return_credit_intent_impl_20260812']) {
      expect(body(fn)).not.toContain("priced_from = 'billed_share'");
      expect(body(fn)).toContain('OR ri.unit_price_cents IS DISTINCT FROM lp.unit_price_cents)');
    }
    expect(body('_create_return_intent_impl_20260812')).toContain("ori.priced_from IN ('order_price', 'unrecorded')");
  });

  it('create_return records how it priced each line', () => {
    const c = body('_create_return_intent_impl_20260812');
    expect(c).toContain("CASE WHEN v_share.share_mode THEN 'billed_share' ELSE 'order_price' END");
    expect(c).toContain('RETURN_OLDER_RETURN_AT_ORDER_PRICE');
    expect(MIGRATION).toContain("priced_from text NOT NULL DEFAULT 'unrecorded'");
  });

  it('issue_return_credit re-prices before its billed-share cap', () => {
    const b = body('_issue_return_credit_intent_impl_20260812');
    expect(b.indexOf('UPDATE public.return_items ri')).toBeLessThan(b.indexOf("RAISE EXCEPTION 'RETURN_CREDIT_EXCEEDS_BILLED_SHARE'"));
  });

  it('the lot price helper: own customer, no field split, tax or a discount, posted lots only, the create_return formula', () => {
    const start = MIGRATION.indexOf('CREATE FUNCTION public._return_order_price_lot_price(');
    expect(start).toBeGreaterThan(0);
    const h = MIGRATION.slice(start, MIGRATION.indexOf('$function$;', start));
    expect(h).toContain("i.status IN ('posted', 'overdue', 'paid') AS posted");
    expect(h).toContain('FROM lots WHERE posted), 0)::bigint AS lot_cents');
    expect(h).toContain('p.other_qty + p_quantity <= p.lot_qty + p.draft_qty');
    expect(h).toContain("dl.charge_type IN ('standing_discount', 'sales_tax')");
    expect(h).toContain('split_evidence');
    expect(h).toContain('round(t.lot_cents * (t.other_qty + p_quantity) / t.lot_qty)::bigint - t.other_cents');
    expect(h).not.toContain('SECURITY DEFINER');
    // tax-on comes from the order's box too (Taha, 26 Nov)
    expect(h).toContain("COALESCE((SELECT sales_tax FROM ord), false) OR a.adjusted");
    expect(MIGRATION).toContain('FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('a line from before this change keeps staging\'s refusal while a live invoice carries a tax or discount line', () => {
    for (const fn of ['_receive_return_intent_impl_20260812', '_issue_return_credit_intent_impl_20260812']) {
      const b = body(fn);
      const guard = b.indexOf("AND ri.priced_from = 'unrecorded'\n");
      expect(guard).toBeGreaterThan(b.indexOf('pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361))'));
      expect(b.slice(guard, guard + 900)).toContain('NOT s.share_mode AND lp.adjusted');
    }
  });

  it('issue_return_credit keeps staging\'s no-source refusal for share returns', () => {
    const b = body('_issue_return_credit_intent_impl_20260812');
    expect(b).toContain("RAISE EXCEPTION 'RETURN_SPLIT_CREDIT_UNBACKED'");
    expect(b).not.toContain('llp.applies');
  });
});
