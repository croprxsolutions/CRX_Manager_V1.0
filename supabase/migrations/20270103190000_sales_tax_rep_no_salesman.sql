-- Written 2026-11-12. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270103190000_sales_tax_rep_no_salesman.md.
-- Re-read the live ledger before applying.
--
-- WHAT: set_order_sales_tax let any sales rep change the sales tax box on a sale with no salesman (found on staging
--   2026-11-12 by a rep calling it directly; the screen already locks the box). Its who-check was
--   `NOT (is_admin() IS TRUE OR (is_sales_rep() IS TRUE AND salesman_id = actor))`: with no salesman the rep test is
--   NULL, the whole test is NULL, and plpgsql skips an IF whose test is NULL, so nothing was refused. The function is
--   re-emitted with that one line changed to `(...) IS NOT TRUE`; every other line is 20261231120000's text.
--
-- NOT CHANGED: who may change the box (an admin, or the rep named as the sale's salesman), the drafts it moves, its
--   replay, audit entry, grants and settings.
--
-- ROLLBACK (its own reviewed migration): re-emit set_order_sales_tax with 20261231120000's text.
--
-- ORDERING: after 20261231120000_sales_tax_checkbox.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  -- set_order_sales_tax exactly as 20261231120000 left it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.set_order_sales_tax(uuid, boolean, text)')
       AND md5(replace(p.prosrc, chr(13), '')) = '813249eef28a1e4e1f422042a8c527d5'
       AND p.proowner = 'postgres'::regrole
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl = ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]) THEN
    RAISE EXCEPTION 'SALES_TAX_REP_PREFLIGHT: set_order_sales_tax drifted from 20261231120000';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.set_order_sales_tax(p_order_id uuid, p_sales_tax boolean, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_order orders%ROWTYPE;
  v_fingerprint text;
  v_replay jsonb;
  v_rate numeric;
  v_inv invoices%ROWTYPE;
  v_header jsonb;
  v_items jsonb;
  v_drafts int := 0;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_ALLOWED: sign in to change a sale''s sales tax' USING ERRCODE = '42501';
  END IF;
  IF p_sales_tax IS NULL THEN
    RAISE EXCEPTION 'SALES_TAX_INVALID: the sales tax box is on or off' USING ERRCODE = '22023';
  END IF;

  -- Replay-safe: the same key, caller and request returns the first answer; a different request is refused.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('order_id', p_order_id, 'sales_tax', p_sales_tax));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_order_sales_tax', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND deleted_at IS NULL FOR UPDATE;
  -- An admin, or the sale's own rep. IS NOT TRUE over the whole test: a sale with no salesman makes the rep test
  -- NULL, and a NULL must refuse (20270103190000).
  IF NOT FOUND OR (public.is_admin() IS TRUE OR (public.is_sales_rep() IS TRUE AND v_order.salesman_id = v_actor)) IS NOT TRUE THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_ALLOWED: only an admin or the sale''s own rep can change its sales tax' USING ERRCODE = '42501';
  END IF;
  IF v_order.status IN ('cancelled', 'voided') THEN
    RAISE EXCEPTION 'SALES_TAX_ORDER_CLOSED: a cancelled or voided sale can''t change' USING ERRCODE = '22023';
  END IF;

  UPDATE orders SET sales_tax = p_sales_tax WHERE id = p_order_id;
  IF p_sales_tax THEN
    v_rate := public._sales_tax_setting_rate_20261231();
  END IF;

  -- Its chemical-sale drafts follow the box (posted and unposted invoices keep what they were posted with). A draft
  -- already taxed keeps its rate.
  FOR v_inv IN
    SELECT * FROM invoices
     WHERE order_id = p_order_id AND invoice_type = 'chemical_sale' AND status = 'draft' AND deleted_at IS NULL
     ORDER BY id
     FOR UPDATE
  LOOP
    IF p_sales_tax THEN
      INSERT INTO invoice_sales_tax_rates (invoice_id, rate_pct) VALUES (v_inv.id, v_rate) ON CONFLICT (invoice_id) DO NOTHING;
    ELSE
      DELETE FROM invoice_sales_tax_rates WHERE invoice_id = v_inv.id;
    END IF;
    -- Re-saved as the invoice screen would (as set_invoice_standing_discount does), so a split payer's draft keeps its
    -- fingerprint: save_invoice's split guard refreshes it, and the recompute goes in just before. A fresh key of its
    -- own per draft: keys are unique across operations.
    v_header := jsonb_build_object('id', v_inv.id, 'customer_id', v_inv.customer_id, 'invoice_type', v_inv.invoice_type,
      'status', v_inv.status, 'season', v_inv.season, 'salesman_id', v_inv.salesman_id, 'invoice_date', v_inv.invoice_date,
      'due_date', v_inv.due_date, 'payment_terms', v_inv.payment_terms, 'purchase_order_ref', v_inv.purchase_order_ref,
      'header_notes', v_inv.header_notes, 'footer_notes', v_inv.footer_notes);
    SELECT COALESCE(jsonb_agg(to_jsonb(it) ORDER BY it.sort_order, it.id), '[]'::jsonb)
      INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv.id;
    PERFORM public.save_invoice(v_header, v_items, 'set_order_sales_tax:' || gen_random_uuid()::text);
    PERFORM public._recompute_standing_discount_20261231(v_inv.id);
    v_drafts := v_drafts + 1;
  END LOOP;

  v_result := jsonb_build_object('order_id', p_order_id, 'sales_tax', p_sales_tax, 'drafts_updated', v_drafts);
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values,
                                   total_impact_cents, description)
  VALUES ('order_updated', 'order', p_order_id, v_actor, (SELECT role FROM profiles WHERE id = v_actor),
          jsonb_build_object('sales_tax', v_order.sales_tax), v_result, 0,
          CASE WHEN p_sales_tax THEN 'Sales tax on' ELSE 'Sales tax off' END);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_order_sales_tax', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_order_sales_tax', v_fingerprint);
  RETURN v_result;
END
$function$;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.set_order_sales_tax(uuid, boolean, text)')
       AND p.prosrc LIKE '%) IS NOT TRUE THEN%'
       AND p.prosecdef
       AND p.proacl = ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]) THEN
    RAISE EXCEPTION 'SALES_TAX_REP_POSTFLIGHT: set_order_sales_tax was not replaced as expected';
  END IF;
END
$postflight$;
