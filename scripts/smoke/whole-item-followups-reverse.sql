-- Rollback for supabase/migrations/20270314100000_whole_item_quantities_followups.sql.
-- Run as one transaction (psql -1). Restores #2675's trigger body (20270313003100), adjust_inventory (20270201140000)
-- and _manual_inventory_add_replay_impl_20261015 (20261102200000), drops the four follow-up triggers and the helper.
-- Refuses unless the three bodies are exactly the follow-up's, so it cannot overwrite later work or run twice.
-- #2675's quote, order and delivery triggers stay in place.

SET LOCAL lock_timeout = '5s';

DO $reverse_preflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(s.sig || ' ' || COALESCE(md5(replace(p.prosrc, chr(13), '')), 'missing'), ', ') INTO v_bad
    FROM (VALUES ('public._enforce_whole_item_quantity()', '0ec25eb446a0cbd211538673b949593b'),
                 ('public.adjust_inventory(uuid,numeric,text,uuid,text)', '43c9a4f91308ac272747071a4af437e8'),
                 ('public._manual_inventory_add_replay_impl_20261015(uuid,text,numeric,text,uuid,text,numeric,text,numeric,numeric)', 'f741844f6907c41ebf3329fa15b1a21c')) s(sig, md5)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)
   WHERE md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM s.md5;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_REVERSE: not the follow-up bodies (%); already reversed or changed since', v_bad;
  END IF;
END;
$reverse_preflight$;

DROP TRIGGER a3_whole_item_quantity ON public.purchase_order_items;
DROP TRIGGER a3_whole_item_quantity ON public.receiving_records;
DROP TRIGGER a3_whole_item_quantity ON public.cycle_count_items;
DROP TRIGGER a3_whole_item_quantity ON public.return_items;

CREATE OR REPLACE FUNCTION public._enforce_whole_item_quantity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_new   jsonb := to_jsonb(NEW);
  v_old   jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  v_cols  text[] := CASE TG_TABLE_NAME WHEN 'delivery_items' THEN ARRAY['quantity', 'quantity_delivered']
                                       WHEN 'order_items' THEN ARRAY['total_units_needed', 'quantity_delivered']
                                       ELSE ARRAY['total_units_needed'] END;
  v_col   text;
  v_qty   numeric;
  v_name  text;
  v_unit  text;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  FOREACH v_col IN ARRAY v_cols LOOP
    v_qty := (v_new->>v_col)::numeric;
    -- A changed product re-checks every figure; otherwise only a new or changed figure.
    -- NaN and Infinity equal their own trunc(), so they are not counted as whole.
    CONTINUE WHEN v_qty IS NULL
               OR (v_qty = trunc(v_qty) AND v_qty > '-Infinity'::numeric AND v_qty < 'Infinity'::numeric)
               OR (TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
                   AND v_new->v_col IS NOT DISTINCT FROM v_old->v_col);
    IF v_unit IS NULL THEN
      -- Same trim as _unit_matches_stock_unit; FOR SHARE holds the stock unit until this line commits.
      SELECT p.product_name,
             COALESCE(NULLIF(btrim(p.inventory_unit, E' \t\r\n' || chr(160)), ''),
                      NULLIF(btrim(p.unit_size, E' \t\r\n' || chr(160)), ''))
        INTO v_name, v_unit FROM public.products p WHERE p.id = NEW.product_id FOR SHARE;
      IF lower(COALESCE(v_unit, '')) NOT IN ('ea', 'unit') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'WHOLE_ITEMS_ONLY: % is sold by the whole item (%), so % can''t be used. Enter a whole number%',
      COALESCE(v_name, 'This product'), v_unit, trim_scale(v_qty),
      CASE WHEN TG_TABLE_NAME = 'quote_items'
           THEN '. Change the rate or acres, or type the number of items.' ELSE '.' END
      USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN NEW;
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

  -- Every adjustment gets a receipt a retry can find. A blank key, or one with
  -- ANY character outside printable ASCII (space, tab, newline, control, non-ASCII),
  -- is refused before any work (#1912).
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
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

CREATE OR REPLACE FUNCTION public._manual_inventory_add_replay_impl_20261015(
  p_product_id      uuid,
  p_location        text,
  p_quantity        numeric,
  p_unit_size       text    DEFAULT NULL::text,
  p_performed_by    uuid    DEFAULT NULL::uuid,
  p_notes           text    DEFAULT NULL::text,
  p_unit_cost       numeric DEFAULT NULL::numeric,
  p_idempotency_key text    DEFAULT NULL::text,
  p_reorder_point   numeric DEFAULT NULL::numeric,
  p_min_stock_level numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_existing record;
  v_product  record;
  v_note     text;
  v_idemp_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_idemp_existing := check_idempotency(p_idempotency_key, 'manual_inventory_add');
    IF v_idemp_existing IS NOT NULL THEN RETURN v_idemp_existing; END IF;
  END IF;

  SELECT * INTO v_existing
  FROM inventory WHERE product_id = p_product_id AND location = COALESCE(p_location, 'Main Warehouse');

  IF FOUND THEN
    RAISE EXCEPTION 'Inventory record already exists for this product at this location. Use Receive or Adjust instead.';
  END IF;

  SELECT * INTO v_product FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  INSERT INTO inventory (product_id, location, quantity_available, unit_size, reorder_point, min_stock_level)
  VALUES (
    p_product_id,
    COALESCE(p_location, 'Main Warehouse'),
    GREATEST(p_quantity, 0),
    COALESCE(p_unit_size, v_product.unit_size),
    GREATEST(COALESCE(p_reorder_point, 0), 0),
    GREATEST(COALESCE(p_min_stock_level, 0), 0)
  );

  -- p_unit_cost is ignored: inventory notes are readable by sales reps, and cost is admin-only.
  v_note := COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units');

  IF p_quantity > 0 THEN
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      to_location, performed_by, notes
    ) VALUES (
      p_product_id, 'adjusted', p_quantity,
      COALESCE(p_location, 'Main Warehouse'), v_actor,
      v_note
    );
  END IF;

  v_result := jsonb_build_object('success', true);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'manual_inventory_add', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

DROP FUNCTION public._assert_whole_item_quantity(uuid, numeric, text);

DO $reverse_postflight$
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._enforce_whole_item_quantity()'::regprocedure), chr(13), '')) IS DISTINCT FROM '5bccd73de644cbe7d7fd1501ece8e43d'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.adjust_inventory(uuid,numeric,text,uuid,text)'::regprocedure), chr(13), '')) IS DISTINCT FROM 'a65294fccbf7d49375b96ed6c46ab29e'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._manual_inventory_add_replay_impl_20261015(uuid,text,numeric,text,uuid,text,numeric,text,numeric,numeric)'::regprocedure), chr(13), '')) IS DISTINCT FROM 'd2a1025102720d59260f6f23e0416abc'
     OR (SELECT count(*) FROM pg_trigger WHERE tgname = 'a3_whole_item_quantity' AND NOT tgisinternal) <> 3 THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_REVERSE: the earlier bodies or #2675''s three triggers are not back';
  END IF;
END;
$reverse_postflight$;
