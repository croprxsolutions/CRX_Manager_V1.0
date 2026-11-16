-- Repair step 5, part 1 (KI-139, KI-141, KI-162, C-13): four stock and receiving checks.
--
-- KI-139: "Reconcile negative inventory" could set ANY row to any number of 0 or more with no count behind it.
--         It now refuses a row whose on-hand is not below zero.
-- KI-141: retiring an inventory row ignored open purchase orders; the on-order recompute then put back a zero
--         row and the PO pointed at retired stock. Retire now refuses while the row still has stock on order,
--         and takes the on-order recompute's lock so a PO saved at the same moment cannot slip past it. It
--         never waits on a lock (row NOWAIT, advisory try-lock): if either is held it asks to try again.
-- KI-162: the Receiving Log's From/To filter compared the UTC date (the database runs in UTC), so a receipt
--         after about 6-7 PM Central filed under the next day. It now compares the America/Chicago date.
-- C-13:   a manual adjustment could not partly fix stock below zero (+5 on -10 was refused). An increase is
--         now never refused; a decrease still may not end below zero (Mason, 2026-11-16).
--
-- CREATE OR REPLACE keeps each function's OID, owner, grants, SECURITY DEFINER, search_path, arguments and
-- return type. The public retire/reconcile wrappers (20261016140000) are unchanged: they still bind the
-- replay receipt, and a same-key retry still returns the first result from the impl's check_idempotency,
-- which runs before the new checks. No table, row, grant or owner changes.
-- Plan: docs/plans/2026-11-16-stock-checks-CONTRACT.md.
--
-- Safety: the preflight refuses unless each live body is exactly the one read from live on 2026-11-16 (md5,
-- carriage returns removed), so a second apply is refused; the postflight checks each new body and that
-- owner, grants, security mode, settings, return type, volatility and arguments did not move.

CREATE TEMP TABLE stock_checks_step5_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
       pg_get_function_arguments(p.oid) AS args,
       pg_current_xact_id()::text AS transaction_id
  FROM pg_proc p
 WHERE p.oid IN (
   to_regprocedure('public._reconcile_negative_inventory_replay_impl_20261015(uuid,numeric,text,uuid,text)'),
   to_regprocedure('public._retire_inventory_item_replay_impl_20261015(uuid,uuid,text)'),
   to_regprocedure('public.get_receiving_log(integer,integer,text,text,uuid,date,date)'),
   to_regprocedure('public.adjust_inventory(uuid,numeric,text,uuid,text)')
 );

DO $preflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    '_reconcile_negative_inventory_replay_impl_20261015(uuid,numeric,text,uuid,text)', 'f74d57e251dba616fa18376f6c65955a',
    '_retire_inventory_item_replay_impl_20261015(uuid,uuid,text)', 'e3a007fd59454bcc53c879c391ae6c3c',
    'get_receiving_log(integer,integer,text,text,uuid,date,date)', 'e9ca68d79929a513433eb6359a44268c',
    'adjust_inventory(uuid,numeric,text,uuid,text)', '22f1f7d0bd190ce74efb5ad3a8379677');
  v_row record;
BEGIN
  IF (SELECT count(*) FROM pg_temp.stock_checks_step5_attrs) <> 4 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: one of the four functions is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_temp.stock_checks_step5_attrs WHERE transaction_id IS DISTINCT FROM pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  FOR v_row IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5
      FROM pg_temp.stock_checks_step5_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    IF v_row.body_md5 IS DISTINCT FROM v_expected ->> v_row.sig THEN
      -- Already applied, or live drifted from the body read on 2026-11-16.
      RAISE EXCEPTION 'STOCK_CHECKS_STEP5_BASELINE_DRIFT: % body md5 %', v_row.sig, v_row.body_md5;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._reconcile_negative_inventory_replay_impl_20261015(p_inventory_id uuid, p_new_quantity numeric, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_existing jsonb;
  v_inv      record;
  v_delta    numeric;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to reconcile inventory';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required for reconciliation';
  END IF;

  IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
    RAISE EXCEPTION 'New quantity must be >= 0';
  END IF;
  -- numeric NaN sorts above every number and Infinity passes >= 0; neither is a count.
  IF p_new_quantity IN ('NaN'::numeric, 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'New quantity must be a number';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reconcile_negative_inventory');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory row not found: %', p_inventory_id;
  END IF;

  -- KI-139: this tool only fixes stock that went below zero; a count or an adjustment changes anything else.
  IF COALESCE(v_inv.quantity_available, 0) >= 0 THEN
    RAISE EXCEPTION 'Only stock below zero can be reconciled here; this item has % on hand. Use a count or an adjustment instead.',
      COALESCE(v_inv.quantity_available, 0);
  END IF;

  v_delta := p_new_quantity - COALESCE(v_inv.quantity_available, 0);

  UPDATE inventory
  SET quantity_available = p_new_quantity,
      updated_at = now()
  WHERE id = p_inventory_id;

  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', v_delta,
    v_inv.location, v_actor,
    'RECONCILIATION (was ' || COALESCE(v_inv.quantity_available, 0)::text ||
    ', now ' || p_new_quantity::text || '): ' || p_reason
  );

  v_result := jsonb_build_object(
    'success',           true,
    'inventory_id',      p_inventory_id,
    'product_id',        v_inv.product_id,
    'old_quantity',      COALESCE(v_inv.quantity_available, 0),
    'new_quantity',      p_new_quantity,
    'delta',             v_delta
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reconcile_negative_inventory', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._retire_inventory_item_replay_impl_20261015(p_inventory_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor             uuid;
  v_inv               record;
  v_existing          jsonb;
  v_active_holds      int;
  v_pending_deliv     int;
  v_old_quantity      numeric;
  v_result            jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to retire an inventory item';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'retire_inventory_item');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  BEGIN
    SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'Cannot delete right now: this stock is being changed by someone else. Try again in a moment.';
  END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory row not found: %', p_inventory_id;
  END IF;

  -- KI-141: on order is set by _recompute_po_on_order_for_products under advisory lock 73492009 (receiving
  -- also lowers it, under this row's lock). A recompute part-way through could lose its update to this delete,
  -- so take that lock too; only TRY it, because waiting while holding the row lock can deadlock with a
  -- recompute that waits for the row. Holding both, v_inv's on order is current and no recompute can start.
  IF NOT pg_try_advisory_xact_lock(73492009) THEN
    RAISE EXCEPTION 'Cannot delete right now: a purchase order is being saved. Try again in a moment.';
  END IF;
  IF COALESCE(v_inv.quantity_on_order, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot delete: % unit(s) are still on order on an open purchase order. Receive or cancel them first.',
      v_inv.quantity_on_order;
  END IF;

  v_old_quantity := COALESCE(v_inv.quantity_available, 0);

  SELECT COUNT(*) INTO v_active_holds
  FROM inventory_holds
  WHERE product_id = v_inv.product_id AND is_active = true;
  IF v_active_holds > 0 THEN
    RAISE EXCEPTION 'Cannot delete: % active inventory hold(s) on this product. Release holds first.', v_active_holds;
  END IF;

  IF COALESCE(v_inv.quantity_prebooked, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot delete: % unit(s) committed (prebooked) on this product. Cancel/complete the linked orders first.',
      v_inv.quantity_prebooked;
  END IF;

  SELECT COUNT(*) INTO v_pending_deliv
  FROM delivery_items di
  JOIN deliveries d ON d.id = di.delivery_id
  WHERE di.product_id = v_inv.product_id
    AND d.status IN ('scheduled', 'in_progress');
  IF v_pending_deliv > 0 THEN
    RAISE EXCEPTION 'Cannot delete: % delivery(ies) still scheduled/in_progress for this product.', v_pending_deliv;
  END IF;

  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', -v_old_quantity,
    COALESCE(v_inv.location, 'Main Warehouse'),
    v_actor,
    'Inventory record retired (had ' || v_old_quantity || ' available)'
  );

  DELETE FROM inventory WHERE id = p_inventory_id;

  v_result := jsonb_build_object(
    'success', true,
    'inventory_id', p_inventory_id,
    'product_id', v_inv.product_id,
    'retired_quantity', v_old_quantity
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'retire_inventory_item', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_receiving_log(p_limit integer DEFAULT 200, p_offset integer DEFAULT 0, p_vendor text DEFAULT NULL::text, p_condition text DEFAULT NULL::text, p_received_by uuid DEFAULT NULL::uuid, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (select auth.uid()) AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      rr.id,
      rr.purchase_order_id,
      rr.po_item_id,
      rr.product_id,
      rr.quantity_received,
      rr.received_at,
      rr.notes,
      rr.condition,
      rr.lot_number,
      rr.storage_location,
      rr.unit_size,
      po.po_number,
      po.vendor,
      p.product_name,
      prof.full_name AS received_by_name,
      (SELECT count(*) FROM receiving_photos rp
       WHERE rp.receiving_record_id = rr.id) AS photo_count
    FROM receiving_records rr
    JOIN purchase_orders po ON po.id = rr.purchase_order_id
    JOIN products p ON p.id = rr.product_id
    JOIN profiles prof ON prof.id = rr.received_by
    WHERE (p_vendor IS NULL OR po.vendor ILIKE '%' || p_vendor || '%')
      AND (p_condition IS NULL OR rr.condition = p_condition)
      AND (p_received_by IS NULL OR rr.received_by = p_received_by)
      AND (p_date_from IS NULL OR rr.received_at >= (p_date_from::timestamp AT TIME ZONE 'America/Chicago'))
      AND (p_date_to IS NULL OR rr.received_at < ((p_date_to + 1)::timestamp AT TIME ZONE 'America/Chicago'))
    ORDER BY rr.received_at DESC, rr.id DESC
    LIMIT p_limit OFFSET p_offset
  ) r;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_inventory(
  p_inventory_id uuid,
  p_delta numeric,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $adjust$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_inv record;
  v_new_qty numeric;
  v_result jsonb;
BEGIN
  -- Who is calling. All of this runs BEFORE any receipt is looked at, so
  -- holding someone else's key is not enough to read their result.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required';
  END IF;
  -- The caller may name itself or nothing.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must be the signed-in user';
  END IF;
  -- NULL-safe and active-only: a missing or deactivated profile is refused.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND role = 'admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins can adjust inventory';
  END IF;

  -- Every adjustment gets a receipt a retry can find. Blank, whitespace-only
  -- or non-printable keys are refused before any work.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: adjust_inventory requires p_idempotency_key';
  END IF;

  -- numeric accepts NaN and +/-Infinity. NaN sorts above every number, so it
  -- would pass the negative-stock check below and be written into
  -- quantity_available, which has no CHECK constraint.
  IF p_delta IS NULL
     OR p_delta IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) THEN
    RAISE EXCEPTION 'INVALID_ADJUSTMENT_QUANTITY: the adjustment must be a finite number';
  END IF;
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity cannot be zero';
  END IF;

  -- Everything that shapes the adjustment. p_performed_by is left out: the
  -- guard above constrains it to {NULL, actor} and the ledger row is stamped
  -- from auth.uid(), so it cannot change the outcome. That omission DEPENDS on
  -- the ACTOR_MISMATCH guard; if it is ever relaxed, p_performed_by must join
  -- the fingerprint. trim_scale makes 5 and 5.0 the same request.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'inventory_id', p_inventory_id,
    'delta', trim_scale(p_delta),
    'reason', p_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction:
  -- a racing same-key call waits here, then replays. Replays only a receipt
  -- bound to THIS actor and THIS request.
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'adjust_inventory', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- The adjustment itself, unchanged from the live body.
  SELECT * INTO v_inv FROM public.inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory record not found';
  END IF;

  v_new_qty := v_inv.quantity_available + p_delta;

  -- C-13: an increase is never refused, so stock below zero can be partly corrected (+5 on -10 gives -5).
  -- A decrease still may not end below zero.
  IF v_new_qty < 0 AND p_delta < 0 THEN
    RAISE EXCEPTION 'Adjustment would result in negative inventory (current: %, delta: %, result: %)',
      v_inv.quantity_available, p_delta, v_new_qty;
  END IF;

  UPDATE public.inventory SET
    quantity_available = v_new_qty,
    updated_at = now()
  WHERE id = p_inventory_id;

  INSERT INTO public.inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', p_delta,
    v_inv.location, v_actor,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Manual adjustment of ' || p_delta || ' units')
  );

  v_result := jsonb_build_object(
    'status', 'adjusted',
    'new_quantity', v_new_qty,
    'product_id', v_inv.product_id
  );

  -- The receipt, bound to the actor and the request. No row can exist for this
  -- key here: check_idempotency_intent returned NULL under the advisory lock.
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, request_actor_id, request_fingerprint
  ) VALUES (
    p_idempotency_key, 'adjust_inventory', v_result, v_actor, v_fingerprint
  );

  RETURN v_result;
END;
$adjust$;

DO $postflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    '_reconcile_negative_inventory_replay_impl_20261015(uuid,numeric,text,uuid,text)', 'fb4c3b85be436807323414ca682efd2f',
    '_retire_inventory_item_replay_impl_20261015(uuid,uuid,text)', 'fc41034894f87724c8060e4d92eb4a6a',
    'get_receiving_log(integer,integer,text,text,uuid,date,date)', '2bed0e8df93e81ddbee37a3afe56e9b2',
    'adjust_inventory(uuid,numeric,text,uuid,text)', 'f004ee94ab89552797fb34d3f581248d');
  v_fn record;
  v_seen integer := 0;
BEGIN
  FOR v_fn IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
           p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
           pg_get_function_arguments(p.oid) AS args, a.args AS was_args,
           a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
           a.provolatile AS was_volatile, a.prosecdef AS was_secdef, a.transaction_id
      FROM pg_temp.stock_checks_step5_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    v_seen := v_seen + 1;
    IF v_fn.transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
    END IF;
    IF v_fn.body_md5 IS DISTINCT FROM v_expected ->> v_fn.sig
       OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
       OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
       OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
       OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
       OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
       OR v_fn.prosecdef IS DISTINCT FROM v_fn.was_secdef
       OR v_fn.args IS DISTINCT FROM v_fn.was_args
       OR NOT v_fn.prosecdef THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.sig, v_fn.body_md5;
    END IF;
  END LOOP;
  IF v_seen <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected 4 functions, saw %', v_seen;
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: reconcile refuses rows not below zero, retire refuses open on-order, Receiving Log uses the Chicago date, an increase can partly fix stock below zero';
END;
$postflight$;
