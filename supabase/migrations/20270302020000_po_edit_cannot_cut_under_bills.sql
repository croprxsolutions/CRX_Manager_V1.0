-- KI-151 follow-up (Taha's #2266 review: Edit PO could lower a PO's ordered total under its vendor bills with no check:
-- lower an unreceived quantity, drop a line, or an admin's lower cost on an unreceived line).
--
-- Mason, 2026-11-24: one rule for everyone, and the extra cost-cut rules dropped. Once a PO has an active (not deleted,
-- not voided) vendor bill, an Edit PO save that changes its lines at all (adds or removes a line, or changes a line's
-- quantity, product, unit, line notes or cost) is refused (PO_BILLED_LINES_LOCKED) before anything is saved; header
-- edits (notes, dates) still save. To change lines, void the bill, edit, then enter the bill again (create_vendor_bill
-- applies its limits); an admin's cost correction stays on set_purchase_order_item_costs, unchanged. The refusal
-- depends only on the caller's own edit and whether a bill exists, never on a role, cost or bill amount, and names no
-- amount. A billed PO's unchanged lines are saved as stored, without costs.
--
-- Same signature, owner and grants; the body is the 20261021140000 wrapper (md5-pinned below) plus the check before
-- the unchanged inner save. Lock order: the advisory lock first (as before), then the PO row (create_vendor_bill locks
-- it too, so no bill appears or is voided mid-save), then the inner save. App calls run READ COMMITTED (PostgREST), so
-- the bill read after the lock sees every committed bill. No data changes (live 2026-11-22: no vendor bill is linked to
-- a PO).
--
-- idempotency-body-check: exempt -- the key, fingerprint and receipt stay in the unchanged inner save; a refused save
--   rolls back before the inner save runs, and a replay of a saved key skips the check and gets its receipt.
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
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  IF NOT public.is_admin() AND jsonb_typeof(p_items) = 'array' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(t.e) = 'object' THEN t.e - 'unit_cost' - 'unit_cost_cents' ELSE t.e END
                              ORDER BY t.o), '[]'::jsonb)
      INTO v_items
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, o);
  END IF;
  -- Mason, 2026-11-24: once a PO has an active vendor bill, Edit PO cannot change its lines, for anyone. Checked
  -- BEFORE the inner save, so a refused edit never runs its arithmetic or side effects. Only for a caller the inner
  -- save would accept (signed in, acting as themself, admin or rep; anyone else is refused there, unchanged), and not
  -- for a replay of a saved key (the inner save returns its receipt and changes nothing).
  IF p_po_id IS NOT NULL AND auth.uid() IS NOT NULL AND p_performed_by = auth.uid()
     AND (public.is_admin() OR public.is_sales_rep())
     AND (p_idempotency_key IS NULL OR public.check_idempotency(p_idempotency_key, 'save_purchase_order') IS NULL) THEN
    -- The PO row lock create_vendor_bill also takes: no bill can be added until this save commits (a bill voided
    -- meanwhile only means this save is refused and can be retried). The bill read below must see bills committed
    -- while this save waited for the lock, which only READ COMMITTED guarantees (app calls through the API use it).
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'PO_SAVE_READ_COMMITTED_REQUIRED: save purchase orders in a READ COMMITTED transaction'
        USING ERRCODE = '25001';
    END IF;
    PERFORM 1 FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.vendor_bills vb
                WHERE vb.purchase_order_id = p_po_id AND vb.deleted_at IS NULL AND vb.status <> 'voided') THEN
      -- The edit must send exactly the stored lines (each once, by id) with the same quantity, product, unit (blank and
      -- null alike, as the screen sends), line notes and, when sent, cost. No arithmetic touches a cost. A rep's costs were
      -- removed above, so a rep's refusal never depends on a cost.
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_items)
              <> (SELECT count(*) FROM public.purchase_order_items poi WHERE poi.purchase_order_id = p_po_id)
         OR jsonb_array_length(v_items)
              <> (SELECT count(DISTINCT poi.id) FROM jsonb_array_elements(v_items) AS t(e)
                    JOIN public.purchase_order_items poi
                      ON jsonb_typeof(t.e) = 'object' AND poi.purchase_order_id = p_po_id
                     AND poi.id = public._cost_step2_try_uuid(t.e->>'id'))
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_items) AS t(e)
                JOIN public.purchase_order_items poi
                  ON jsonb_typeof(t.e) = 'object' AND poi.purchase_order_id = p_po_id
                 AND poi.id = public._cost_step2_try_uuid(t.e->>'id')
               -- shortcut: a quantity within 0.000000001 of the stored one is not a change (the browser resends a
               -- stored quantity as a double); the stored quantity is what gets saved, so nothing drifts.
               WHERE abs((t.e->>'quantity_ordered')::numeric - poi.quantity_ordered) > 0.000000001
                  OR (t.e->>'product_id') IS DISTINCT FROM poi.product_id::text
                  OR NULLIF(t.e->>'unit_size', '') IS DISTINCT FROM NULLIF(poi.unit_size, '')
                  OR (t.e ? 'notes' AND NULLIF(t.e->>'notes', '') IS DISTINCT FROM NULLIF(to_jsonb(poi)->>'notes', ''))
                  OR (t.e ? 'unit_cost' AND (t.e->'unit_cost') IS DISTINCT FROM COALESCE(to_jsonb(poi.unit_cost), 'null'::jsonb))
                  OR (t.e ? 'unit_cost_cents'
                      AND (t.e->'unit_cost_cents') IS DISTINCT FROM COALESCE(to_jsonb(poi.unit_cost_cents), 'null'::jsonb))) THEN
        RAISE EXCEPTION 'PO_BILLED_LINES_LOCKED: this purchase order has a vendor bill, so its lines cannot be changed here; void the bill first, or have an admin use Correct Unit Cost'
          USING ERRCODE = '22023';
      END IF;
      -- Unchanged lines: save the STORED line (its own id spelling, quantity, product, name, unit and notes), not the
      -- caller's copy, and without costs (an omitted cost is kept, so no cost confirmation or cost log).
      SELECT jsonb_agg((t.e - 'unit_cost' - 'unit_cost_cents')
                         || jsonb_build_object('id', poi.id, 'product_id', poi.product_id, 'product_name', poi.product_name,
                                               'unit_size', poi.unit_size, 'quantity_ordered', poi.quantity_ordered,
                                               'quantity_received', poi.quantity_received, 'notes', to_jsonb(poi)->'notes')
                       ORDER BY t.o)
        INTO v_items
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(e, o)
        JOIN public.purchase_order_items poi
          ON poi.purchase_order_id = p_po_id AND poi.id = public._cost_step2_try_uuid(t.e->>'id');
    END IF;
  END IF;
  v_result := public._section9_save_purchase_order_serialized(
    p_po_id, p_po_payload, v_items, p_performed_by, p_idempotency_key
  );
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
