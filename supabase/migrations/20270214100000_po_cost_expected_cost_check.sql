-- KI-197 (contract docs/plans/2026-11-22-ki197-po-cost-stale-screen-CONTRACT.md): a purchase-order cost correction made
-- from a stale screen must not silently replace a newer one. set_purchase_order_item_costs accepts an optional per-line
-- expected_unit_cost_cents (the cost the admin saw); when present and the stored cost differs, the whole call is refused
-- with PO_COST_CHANGED_SINCE_LOADED and nothing is saved. Absent = an older screen, unchanged until a follow-up requires it.
-- Same signature, same grants; the body is the 20261021140000 body (md5-pinned below) plus one validation block and one
-- compare block. No data changes.
--
-- Rollback: re-run the CREATE FUNCTION body of set_purchase_order_item_costs from
-- 20261021140000_po_cost_admin_only_and_corrections.sql as CREATE OR REPLACE (after reverting the screen that sends the field).

SET LOCAL lock_timeout = '10s';

DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  IF to_regclass('pg_temp.ki197_set_costs_tx') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: leftover temp marker';
  END IF;
  CREATE TEMP TABLE ki197_set_costs_tx (x int) ON COMMIT DROP;
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)');
  IF v_md5 IS DISTINCT FROM '467738c637149aea8733ea68b96282d1' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: set_purchase_order_item_costs changed since 2026-11-22 (md5 %); re-read it before applying', v_md5;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'set_purchase_order_item_costs') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected exactly one set_purchase_order_item_costs';
  END IF;
END
$preflight$;

DO $tx$
BEGIN
  IF to_regclass('pg_temp.ki197_set_costs_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 / the apply script)';
  END IF;
END
$tx$;

CREATE OR REPLACE FUNCTION public.set_purchase_order_item_costs(
  p_po_id uuid,
  p_items jsonb,
  p_reason text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := NULLIF(btrim(p_reason), '');
  v_fingerprint text;
  v_replay jsonb;
  v_status text;
  v_po_number text;
  v_item jsonb;
  v_item_id uuid;
  v_cents bigint;
  v_line record;
  v_changed integer := 0;
  v_confirmed integer := 0;
  v_result jsonb;
  v_old_total bigint;
  v_new_total bigint;
  v_billed bigint;
  v_expected bigint;
  v_expected_num numeric;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: set_purchase_order_item_costs requires p_idempotency_key'
      USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- Purchase cost is admin-only (Mason, 2026-10-15 and 2026-10-20).
  PERFORM public.require_admin();

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'PO_ITEMS_REQUIRED';
  END IF;
  IF jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION 'PO_ITEMS_TOO_MANY: at most 500 lines at a time';
  END IF;
  -- Compared as uuids: the same line spelled in upper and lower case is one line.
  IF (SELECT count(*) <> count(DISTINCT public._cost_step2_try_uuid(e.value->>'id'))
             OR bool_or(public._cost_step2_try_uuid(e.value->>'id') IS NULL)
        FROM jsonb_array_elements(p_items) AS e(value)) THEN
    RAISE EXCEPTION 'PO_ITEM_ID_DUPLICATE: each line must appear once, by a valid id';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'PO_COST_REASON_TOO_LONG: keep the reason to 500 characters';
  END IF;

  -- save_purchase_order's advisory lock, taken first as it takes it.
  PERFORM pg_advisory_xact_lock(73492009);

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'po_id', p_po_id,
    'items', p_items,
    'reason', v_reason
  ));
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'set_purchase_order_item_costs', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Item first, then parent PO: the receiving/reversal and cost-basis apply lock order, so a
  -- correction never deadlocks with them.
  PERFORM 1 FROM public.purchase_order_items poi
   WHERE poi.purchase_order_id = p_po_id ORDER BY poi.id FOR UPDATE;
  SELECT status, po_number, total_cost_cents INTO v_status, v_po_number, v_old_total
    FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found: %', p_po_id;
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'PO_CANCELLED: cannot change cost on a cancelled purchase order';
  END IF;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) AS e(value)
  LOOP
    -- A JSON number: null or "" would otherwise read as no cost, which the parser treats as $0.
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_item->'unit_cost_cents') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'PO_UNIT_COST_REQUIRED';
    END IF;
    -- An integer: 10.5 cents is refused by name, never cast or rounded.
    IF (v_item->>'unit_cost_cents')::numeric IS DISTINCT FROM trunc((v_item->>'unit_cost_cents')::numeric) THEN
      RAISE EXCEPTION 'PO_UNIT_COST_FRACTIONAL_CENT: unit cost must resolve to whole cents'
        USING ERRCODE = '22003';
    END IF;
    v_item_id := public._cost_step2_try_uuid(v_item->>'id');
    -- Whole cents, not negative (the PO writer's own parser); cents only, never dollars.
    v_cents := public._purchase_order_item_unit_cost_cents(v_item - 'unit_cost');
    IF v_cents > 9007199254740991 THEN
      RAISE EXCEPTION 'PO_UNIT_COST_TOO_LARGE' USING ERRCODE = '22003';
    END IF;

    -- KI-197: the cost the admin saw when the editor opened. Absent = an older screen: no check until a
    -- follow-up makes it required. Present must be a JSON whole number of cents (null refused too).
    -- Nested IFs: SQL does not promise OR evaluation order, so the cast never sees a non-number.
    v_expected := NULL;
    IF v_item ? 'expected_unit_cost_cents' THEN
      IF jsonb_typeof(v_item->'expected_unit_cost_cents') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'PO_EXPECTED_COST_INVALID: expected_unit_cost_cents must be a whole number of cents'
          USING ERRCODE = '22023';
      END IF;
      v_expected_num := (v_item->>'expected_unit_cost_cents')::numeric;
      IF v_expected_num <> trunc(v_expected_num) OR v_expected_num < 0 OR v_expected_num > 9007199254740991 THEN
        RAISE EXCEPTION 'PO_EXPECTED_COST_INVALID: expected_unit_cost_cents must be a whole number of cents'
          USING ERRCODE = '22023';
      END IF;
      v_expected := v_expected_num::bigint;
    END IF;

    SELECT poi.id, poi.unit_cost_cents, poi.quantity_received, poi.cost_needs_review INTO v_line
      FROM public.purchase_order_items poi
     WHERE poi.id = v_item_id AND poi.purchase_order_id = p_po_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_ITEM_ID_NOT_IN_PURCHASE_ORDER';
    END IF;

    -- KI-197: compared on the locked row, after replay and before either branch, so a stale screen can neither
    -- replace a newer cost nor confirm one it never saw. A line with no cost reads as 0, as the screen shows it.
    IF v_expected IS NOT NULL AND COALESCE(v_line.unit_cost_cents, 0) IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'PO_COST_CHANGED_SINCE_LOADED: someone changed a line''s cost after this screen loaded it; nothing was saved. Reload and check the new cost.'
        USING ERRCODE = 'P0001';
    END IF;

    PERFORM set_config('crx.po_cost_set_item', v_item_id::text, true);
    PERFORM set_config('crx.po_cost_set_reason', COALESCE(v_reason, ''), true);

    IF v_line.unit_cost_cents IS NOT DISTINCT FROM v_cents THEN
      -- Same cost: on a rep's line this is the admin confirming the catalog cost.
      IF v_line.cost_needs_review THEN
        UPDATE public.purchase_order_items SET cost_needs_review = false WHERE id = v_item_id;
        INSERT INTO public.purchase_order_item_cost_changes (
          purchase_order_id, purchase_order_item_id, product_id,
          old_unit_cost_cents, new_unit_cost_cents, quantity_received_at_change,
          source, reason, changed_by
        )
        SELECT poi.purchase_order_id, poi.id, poi.product_id, v_cents, v_cents,
               COALESCE(poi.quantity_received, 0), 'confirmed', v_reason, v_actor
          FROM public.purchase_order_items poi WHERE poi.id = v_item_id;
        v_confirmed := v_confirmed + 1;
      END IF;
    ELSE
      -- A received line is purchase evidence: changing it needs a reason (Mason, 2026-10-20).
      IF v_reason IS NULL AND (
           COALESCE(v_line.quantity_received, 0) > 0
           OR EXISTS (SELECT 1 FROM public.receiving_records rr WHERE rr.po_item_id = v_item_id)) THEN
        RAISE EXCEPTION 'PO_COST_REASON_REQUIRED: say why the cost of a received line is changing'
          USING ERRCODE = 'P0001';
      END IF;
      -- A supplier cost-basis row (or a pending change row) that cites this line as its actual
      -- purchase was checked against the line's cost; changing it would leave that evidence
      -- silently wrong. Refuse; the basis must be replaced first (live read 2026-10-20: none exist).
      IF EXISTS (SELECT 1 FROM public.product_cost_basis b WHERE b.purchase_order_item_id = v_item_id)
         OR EXISTS (SELECT 1 FROM public.product_cost_basis_change_rows c WHERE c.purchase_order_item_id = v_item_id) THEN
        RAISE EXCEPTION 'PO_COST_BASIS_EVIDENCE_IN_USE: supplier cost-basis evidence cites this line; replace that basis before changing its cost'
          USING ERRCODE = 'P0001';
      END IF;
      UPDATE public.purchase_order_items
         SET unit_cost = v_cents::numeric / 100.0
       WHERE id = v_item_id;
      v_changed := v_changed + 1;
    END IF;

    PERFORM set_config('crx.po_cost_set_item', '', true);
    PERFORM set_config('crx.po_cost_set_reason', '', true);
  END LOOP;

  IF v_changed > 0 THEN
    UPDATE public.purchase_orders po
       SET total_cost = COALESCE((
             SELECT SUM(round(poi.quantity_ordered * poi.unit_cost_cents)::bigint)
               FROM public.purchase_order_items poi
              WHERE poi.purchase_order_id = po.id), 0)::numeric / 100.0,
           updated_at = now()
     WHERE po.id = p_po_id
    RETURNING total_cost_cents INTO v_new_total;

    -- The vendor-bill control (bills over 105% of the PO total need a confirmed reason) runs when a
    -- bill is created; a correction that LOWERS the total must not create that overage silently.
    -- The PO row lock above serializes this with bill creation, which locks the PO too (Sol, 2026-10-21).
    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint INTO v_billed
      FROM public.vendor_bills vb
     WHERE vb.purchase_order_id = p_po_id AND vb.deleted_at IS NULL AND vb.status <> 'voided';
    IF v_new_total < v_old_total AND v_billed > 0 AND v_billed * 100 > v_new_total * 105 THEN
      RAISE EXCEPTION 'PO_COST_BELOW_BILLED: this correction would leave the active vendor bills more than 5%% over the purchase order total; void or adjust the bill first'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object('po_total_cents', v_new_total, 'active_billed_cents', v_billed)::text;
    END IF;
  END IF;

  IF v_changed > 0 OR v_confirmed > 0 THEN
    -- No amounts here: the activity feed is not admin-only.
    INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
    VALUES ('po_updated',
            'PO ' || COALESCE(v_po_number, '') || CASE WHEN v_changed > 0 THEN ' unit cost changed' ELSE ' unit cost confirmed' END,
            v_actor, 'purchase_order', p_po_id);
  END IF;

  v_result := jsonb_build_object(
    'status', 'saved', 'po_id', p_po_id,
    'lines_changed', v_changed, 'lines_confirmed', v_confirmed);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_purchase_order_item_costs', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_purchase_order_item_costs', v_fingerprint);
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text) IS
  'Admin-only: set, correct or confirm purchase-order line unit cost (cents), received lines included (reason required). Optional per-line expected_unit_cost_cents refuses a stale screen (PO_COST_CHANGED_SINCE_LOADED). Changes only cost and the PO total; never inventory or catalog cost. Key required, bound to caller + request.';

DO $postflight$
DECLARE
  v_oid oid := to_regprocedure('public.set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)');
BEGIN
  IF v_oid IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'set_purchase_order_item_costs') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly one set_purchase_order_item_costs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND p.prosecdef
                   AND pg_get_userbyid(p.proowner) = 'postgres'
                   AND p.proconfig = ARRAY['search_path=public, pg_temp']
                   AND p.prosrc LIKE '%PO_COST_CHANGED_SINCE_LOADED%') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: security definer, owner, search_path or body is wrong';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: grants are wrong';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
