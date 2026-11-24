-- KI-151 follow-up (Mason, 2026-11-23, answering Taha's #2266 review in Slack: "The 5% rule also applies when Edit PO
-- lowers a quantity, and the exception covers bills that went over because a receipt was reversed").
--
-- 1. Edit PO (save_purchase_order) could lower a PO's ordered total under its vendor bills with no check (lower an
--    unreceived quantity, drop a line, or an admin's lower cost on an unreceived line). Mason, 2026-11-24, after three
--    Sol rounds found leaks in a rep/admin split: one rule for everyone. Once a PO has an active (not deleted, not
--    voided) vendor bill, an Edit PO save that changes its lines at all (adds or removes a line, or changes a line's
--    quantity, product, unit, cost or received quantity) is refused (PO_BILLED_LINES_LOCKED); header edits (notes, dates, status) still
--    save. To change lines, void the bill, edit, then enter the bill again (create_vendor_bill applies its limits);
--    a cost correction goes through set_purchase_order_item_costs, which keeps the 5% rule. The refusal depends only
--    on the caller's own edit and whether a bill exists, never on a role, cost or bill amount, and names no amount.
-- 2. Reversed receipts: no change. set_purchase_order_item_costs (20270223100000) refuses a cut on the received-value
--    limit only when the bills were within it before the cut, whatever put them over: a prepaid bill or a reversed
--    receipt (a receipt can be reversed only while no active bill is on the PO, so that bill is entered again after
--    the reversal, with create_vendor_bill's confirmed reason). Proved, with real receipts and reversals, by
--    scripts/smoke/prove-po-edit-cannot-cut-under-bills-real-schema.mjs.
--
-- Same signature, owner and grants; the body is the 20261021140000 wrapper (md5-pinned below) plus the check around
-- the unchanged inner save. Lock order: the advisory lock first (as before); the inner save locks the lines and the PO;
-- only when a billed PO's lines changed is the PO row locked again (already held then) before bills are re-read, which
-- serializes with create_vendor_bill (it locks the PO). A replay changes no line, so it takes no extra lock. Any change
-- to a line's quantity ordered or received, product, unit or cost counts, however small. No data changes (live 2026-11-22: no vendor bill is linked to a PO).
--
-- idempotency-body-check: exempt -- the key, fingerprint and receipt stay in the unchanged inner save; a refused save
--   rolls back with its receipt, and a replay changes no line so it is never refused.
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
  v_old_lines jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  IF NOT public.is_admin() AND jsonb_typeof(p_items) = 'array' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(t.e) = 'object' THEN t.e - 'unit_cost' - 'unit_cost_cents' ELSE t.e END
                              ORDER BY t.o), '[]'::jsonb)
      INTO v_items
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, o);
  END IF;
  -- Mason, 2026-11-24: once a PO has an active vendor bill, Edit PO cannot change its lines, for anyone. Snapshot an
  -- existing PO's lines every time (not only when a bill exists now): a bill created while this save waits for the PO
  -- lock is still caught by the check after the save. Every other writer of a PO's lines takes the advisory lock above;
  -- the snapshot is never returned, and the inner save checks the caller before anything is compared or refused.
  IF p_po_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_object_agg(poi.id::text, jsonb_build_object(
             'q', poi.quantity_ordered, 'r', poi.quantity_received, 'p', poi.product_id, 'u', poi.unit_size,
             'c', poi.unit_cost)), '{}'::jsonb)
      INTO v_old_lines
      FROM public.purchase_order_items poi WHERE poi.purchase_order_id = p_po_id;
  END IF;
  v_result := public._section9_save_purchase_order_serialized(
    p_po_id, p_po_payload, v_items, p_performed_by, p_idempotency_key
  );
  IF v_old_lines IS NOT NULL AND (
       (SELECT count(*) FROM public.purchase_order_items poi WHERE poi.purchase_order_id = p_po_id)
         <> (SELECT count(*) FROM jsonb_object_keys(v_old_lines))
       OR EXISTS (
         SELECT 1 FROM jsonb_each(v_old_lines) o
           LEFT JOIN public.purchase_order_items poi ON poi.id = o.key::uuid AND poi.purchase_order_id = p_po_id
          WHERE poi.id IS NULL
             OR poi.quantity_ordered IS DISTINCT FROM (o.value->>'q')::numeric
             OR poi.quantity_received IS DISTINCT FROM (o.value->>'r')::numeric
             OR poi.product_id IS DISTINCT FROM (o.value->>'p')::uuid
             OR poi.unit_size IS DISTINCT FROM (o.value->>'u')
             OR poi.unit_cost IS DISTINCT FROM (o.value->>'c')::numeric)) THEN
    -- Read the bills under the PO row lock create_vendor_bill takes: one created or voided while the save waited counts.
    PERFORM 1 FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.vendor_bills vb
                WHERE vb.purchase_order_id = p_po_id AND vb.deleted_at IS NULL AND vb.status <> 'voided') THEN
      RAISE EXCEPTION 'PO_BILLED_LINES_LOCKED: this purchase order has a vendor bill, so its lines cannot be changed here; void the bill first, or have an admin use Correct Unit Cost'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text) IS
  'Create or edit a purchase order and its lines (a non-admin''s line costs are stripped). Once a PO has an active vendor bill its lines cannot be changed here, for anyone (PO_BILLED_LINES_LOCKED); header edits still save.';

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
                   AND p.prosrc LIKE '%unit_cost_cents%' AND p.prosrc LIKE '%PO_BILLED_LINES_LOCKED%'
                   AND p.prosrc LIKE '%_section9_save_purchase_order_serialized%') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: security definer, owner, search_path or body is wrong';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: grants are wrong';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
