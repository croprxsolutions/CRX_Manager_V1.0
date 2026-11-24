-- KI-151 follow-up (Mason, 2026-11-23, answering Taha's #2266 review in Slack: "The 5% rule also applies when Edit PO
-- lowers a quantity, and the exception covers bills that went over because a receipt was reversed").
--
-- 1. Edit PO (save_purchase_order) could lower a PO's ordered total under its vendor bills with no check: lowering an
--    unreceived line's quantity, dropping a line, or an admin cutting an unreceived line's cost. A save that LOWERS the
--    ordered total and leaves the active (not deleted, not voided) vendor bills more than 5% over it is now refused
--    (PO_EDIT_BELOW_BILLED), the same ordered-total rule set_purchase_order_item_costs applies to a cost cut. A save
--    that keeps or raises the total is never refused, so a PO whose bill is already over can still be edited
--    otherwise. Edit PO cannot change a received line (RECEIVED_PO_LINE_IMMUTABLE), so it cannot lower what arrived;
--    once the total would fall below what arrived the limit IS the ordered total, so this one rule covers KI-143's
--    received-value limit too. No amounts in the error: sales reps can save a PO and PO costs are admin-only.
-- 2. Reversed receipts: no change. set_purchase_order_item_costs (20270223100000) refuses a cut on the received-value
--    limit only when the bills were within it before the cut, whatever put them over: a prepaid bill or a reversed
--    receipt (a receipt can be reversed only while no active bill is on the PO, so that bill is entered again after
--    the reversal, with create_vendor_bill's confirmed reason). Proved, with real receipts and reversals, by
--    scripts/smoke/prove-po-edit-cannot-cut-under-bills-real-schema.mjs.
--
-- Same signature, owner and grants; the body is the 20261021140000 wrapper (md5-pinned below) plus the check around
-- the unchanged inner save. Lock order: the advisory lock first (as before); the inner save locks the lines and the PO;
-- the PO row is locked again (already held when the save changed it) before bills are read, which serializes with
-- create_vendor_bill (it locks the PO). No data changes (live 2026-11-22: no vendor bill is linked to a PO).
--
-- idempotency-body-check: exempt -- the key, fingerprint and receipt stay in the unchanged inner save; a refused save
--   rolls back with its receipt, and a replay changes no total so it is never refused.
-- caller-analysis: save_purchase_order :: src/pages/PurchaseOrderDetail.tsx (Edit PO), NewPurchaseOrder.tsx and
--   BulkPOImport.tsx (new POs: no bills, never checked); same arguments; new error code mapped in errorSanitizer.ts.
--
-- Rollback: a NEW forward migration restoring the save_purchase_order wrapper from
-- 20261021140000_po_cost_admin_only_and_corrections.sql (never re-run or edit an applied file).

SET LOCAL lock_timeout = '10s';

DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  IF to_regclass('pg_temp.po_edit_bills_tx') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: leftover temp marker';
  END IF;
  CREATE TEMP TABLE po_edit_bills_tx (x int) ON COMMIT DROP;
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)');
  IF v_md5 IS DISTINCT FROM '39b121ad88a00c816a7b402f00fdd86d' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: save_purchase_order is not the 20261021140000 wrapper (md5 %); re-read it before applying', v_md5;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'save_purchase_order') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected exactly one save_purchase_order';
  END IF;
END
$preflight$;

DO $tx$
BEGIN
  IF to_regclass('pg_temp.po_edit_bills_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 / the apply script)';
  END IF;
END
$tx$;

CREATE OR REPLACE FUNCTION public.save_purchase_order(
  p_po_id uuid, p_po_payload jsonb, p_items jsonb, p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
DECLARE
  v_items jsonb := p_items;
  v_old_total bigint;
  v_new_total bigint;
  v_billed numeric;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  IF NOT public.is_admin() AND jsonb_typeof(p_items) = 'array' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(t.e) = 'object' THEN t.e - 'unit_cost' - 'unit_cost_cents' ELSE t.e END
                              ORDER BY t.o), '[]'::jsonb)
      INTO v_items
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, o);
  END IF;
  -- KI-151 follow-up: every other writer of the ordered total takes the advisory lock above, so this stays current.
  IF p_po_id IS NOT NULL THEN
    SELECT total_cost_cents INTO v_old_total FROM public.purchase_orders WHERE id = p_po_id;
  END IF;
  v_result := public._section9_save_purchase_order_serialized(
    p_po_id, p_po_payload, v_items, p_performed_by, p_idempotency_key
  );
  -- Mason, 2026-11-23: no edit that lowers the ordered total may leave the active vendor bills more than 5% over it
  -- (set_purchase_order_item_costs' rule). Exact numeric, no overflow.
  IF v_old_total IS NOT NULL THEN
    SELECT total_cost_cents INTO v_new_total FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF v_new_total < v_old_total THEN
      SELECT COALESCE(SUM(vb.total_cents), 0) INTO v_billed
        FROM public.vendor_bills vb
       WHERE vb.purchase_order_id = p_po_id AND vb.deleted_at IS NULL AND vb.status <> 'voided';
      IF v_billed > 0 AND v_billed * 100 > v_new_total::numeric * 105 THEN
        -- Amounts go in DETAIL for admins only; reps never see cost figures.
        IF public.is_admin() THEN
          RAISE EXCEPTION 'PO_EDIT_BELOW_BILLED: this edit would leave the active vendor bills more than 5%% over the purchase order''s ordered total; void or adjust the bill first'
            USING ERRCODE = '22023',
                  DETAIL = jsonb_build_object('po_total_cents', v_new_total, 'active_billed_cents', v_billed)::text;
        ELSE
          RAISE EXCEPTION 'PO_EDIT_BELOW_BILLED: this edit would leave the active vendor bills more than 5%% over the purchase order''s ordered total; void or adjust the bill first'
            USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text) IS
  'Create or edit a purchase order and its lines (a non-admin''s line costs are stripped). An edit that lowers the ordered total and leaves active vendor bills more than 5% over it is refused (PO_EDIT_BELOW_BILLED).';

DO $postflight$
DECLARE
  v_oid oid := to_regprocedure('public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)');
BEGIN
  IF v_oid IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'save_purchase_order') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly one save_purchase_order';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND p.prosecdef
                   AND pg_get_userbyid(p.proowner) = 'postgres'
                   AND p.proconfig = ARRAY['search_path=public, pg_temp']
                   AND p.prosrc LIKE '%unit_cost_cents%' AND p.prosrc LIKE '%PO_EDIT_BELOW_BILLED%'
                   AND p.prosrc LIKE '%_section9_save_purchase_order_serialized%') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: security definer, owner, search_path or body is wrong';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: grants are wrong';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
