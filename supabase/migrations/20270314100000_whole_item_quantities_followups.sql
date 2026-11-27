-- Whole-item quantities on purchase orders, receiving, stock counts, adjustments and returns (follow-ups named on #2675).
-- Contract: docs/plans/2026-11-26-whole-item-followups-CONTRACT.md (Mason's decisions D1-D4, 2026-11-26).
--
-- WHAT: the same rule and sentence as 20270313003100: a product stocked in Ea or Unit (case and spaces ignored)
--   refuses a new or changed fractional figure (WHOLE_ITEMS_ONLY, check_violation). Nothing is rounded.
--   1. _assert_whole_item_quantity(product, qty, hint): the product lookup, finite-whole test and raise, in one place.
--   2. _enforce_whole_item_quantity() re-emitted to call it and to know four more tables:
--      purchase_order_items.quantity_ordered, receiving_records.quantity_received (each receipt, so a reversal,
--      which deletes the receipt, is never refused), cycle_count_items.counted_qty, return_items.quantity.
--      Quote, order and delivery behavior (and the quote hint) is unchanged.
--   3. a3_whole_item_quantity triggers on those four tables.
--   4. adjust_inventory and _manual_inventory_add_replay_impl_20261015 call the helper on the typed figure, after
--      the receipt replay and record lookup, before any write. Their bodies are otherwise copied unchanged from
--      20270201140000 and 20261102200000. The ledger row type 'adjusted' is not guarded: automatic reversals use it.
-- Not covered (named): reorder point and minimum stock, field application quantities, automatic movements.
-- Live and staging 2026-11-26 (read-only): 0 fractional rows on Ea/Unit products in every table above.
--
-- idempotency-body-check: exempt -- the two re-emitted RPCs keep their p_idempotency_key handling unchanged; the
--   helper and trigger write nothing.
-- caller-analysis: save_purchase_order, receive_po_items, receive_po_items_with_excess_notice, update_cycle_count_item,
--   create_return, adjust_inventory, manual_inventory_add now get WHOLE_ITEMS_ONLY for a fractional figure on an
--   Ea/Unit product; src/lib/errorSanitizer.ts shows the sentence. Earlier refusals keep precedence.
-- Safety: the preflight pins every replaced body (md5, carriage returns removed); the postflight checks the new
--   bodies, that owner, grants, security mode and settings did not move, the seven triggers, and no API-role EXECUTE.
-- ROLLBACK: scripts/smoke/whole-item-followups-reverse.sql.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE whole_item_followups_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, p.oid::regprocedure::text AS sig, md5(replace(p.prosrc, chr(13), '')) AS was_md5,
       pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proconfig, p.prosecdef,
       pg_current_xact_id()::text AS transaction_id
  FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public._enforce_whole_item_quantity()'),
                 to_regprocedure('public.adjust_inventory(uuid,numeric,text,uuid,text)'),
                 to_regprocedure('public._manual_inventory_add_replay_impl_20261015(uuid,text,numeric,text,uuid,text,numeric,text,numeric,numeric)'));

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regprocedure('public._assert_whole_item_quantity(uuid,numeric,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_PREFLIGHT: _assert_whole_item_quantity already exists';
  END IF;
  IF (SELECT count(*) FROM pg_temp.whole_item_followups_attrs) <> 3
     OR EXISTS (SELECT 1 FROM pg_temp.whole_item_followups_attrs WHERE transaction_id IS DISTINCT FROM pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_PREFLIGHT: a function to replace is missing, or this file is not one transaction';
  END IF;
  SELECT string_agg(sig || ' ' || was_md5, ', ') INTO v_bad
    FROM pg_temp.whole_item_followups_attrs
   WHERE was_md5 IS DISTINCT FROM CASE sig
           WHEN '_enforce_whole_item_quantity()' THEN '5bccd73de644cbe7d7fd1501ece8e43d'
           WHEN 'adjust_inventory(uuid,numeric,text,uuid,text)' THEN 'a65294fccbf7d49375b96ed6c46ab29e'
           ELSE 'd2a1025102720d59260f6f23e0416abc' END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_PREFLIGHT: unexpected body (%): 20270313003100, 20270201140000 and 20261102200000 must be the current bodies', v_bad;
  END IF;
END;
$preflight$;

CREATE FUNCTION public._assert_whole_item_quantity(p_product_id uuid, p_qty numeric, p_hint text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_name text;
  v_unit text;
BEGIN
  -- NaN and Infinity equal their own trunc(), so they are not counted as whole.
  IF p_product_id IS NULL OR p_qty IS NULL
     OR (p_qty = trunc(p_qty) AND p_qty > '-Infinity'::numeric AND p_qty < 'Infinity'::numeric) THEN
    RETURN;
  END IF;
  -- Same trim as _unit_matches_stock_unit; FOR SHARE holds the stock unit until this write commits.
  SELECT p.product_name,
         COALESCE(NULLIF(btrim(p.inventory_unit, E' \t\r\n' || chr(160)), ''),
                  NULLIF(btrim(p.unit_size, E' \t\r\n' || chr(160)), ''))
    INTO v_name, v_unit FROM public.products p WHERE p.id = p_product_id FOR SHARE;
  IF lower(COALESCE(v_unit, '')) NOT IN ('ea', 'unit') THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'WHOLE_ITEMS_ONLY: % is sold by the whole item (%), so % can''t be used. Enter a whole number.%',
    COALESCE(v_name, 'This product'), v_unit, trim_scale(p_qty), COALESCE(' ' || p_hint, '')
    USING ERRCODE = 'check_violation';
END;
$function$;
REVOKE ALL ON FUNCTION public._assert_whole_item_quantity(uuid, numeric, text) FROM PUBLIC, anon, authenticated, service_role;

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
                                       WHEN 'quote_items' THEN ARRAY['total_units_needed']
                                       WHEN 'purchase_order_items' THEN ARRAY['quantity_ordered']
                                       WHEN 'receiving_records' THEN ARRAY['quantity_received']
                                       WHEN 'cycle_count_items' THEN ARRAY['counted_qty']
                                       WHEN 'return_items' THEN ARRAY['quantity'] END;
  v_col   text;
BEGIN
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_TRIGGER_TABLE: % is not a whole-item table', TG_TABLE_NAME;
  END IF;
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  FOREACH v_col IN ARRAY v_cols LOOP
    -- A changed product re-checks every figure; otherwise only a new or changed figure.
    CONTINUE WHEN TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
              AND v_new->v_col IS NOT DISTINCT FROM v_old->v_col;
    PERFORM public._assert_whole_item_quantity(NEW.product_id, (v_new->>v_col)::numeric,
      CASE WHEN TG_TABLE_NAME = 'quote_items' THEN 'Change the rate or acres, or type the number of items.' END);
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER a3_whole_item_quantity
  BEFORE INSERT OR UPDATE OF product_id, quantity_ordered ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_whole_item_quantity();
CREATE TRIGGER a3_whole_item_quantity
  BEFORE INSERT OR UPDATE OF product_id, quantity_received ON public.receiving_records
  FOR EACH ROW EXECUTE FUNCTION public._enforce_whole_item_quantity();
CREATE TRIGGER a3_whole_item_quantity
  BEFORE INSERT OR UPDATE OF product_id, counted_qty ON public.cycle_count_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_whole_item_quantity();
CREATE TRIGGER a3_whole_item_quantity
  BEFORE INSERT OR UPDATE OF product_id, quantity ON public.return_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_whole_item_quantity();

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
  -- Whole-item products take whole adjustments (20270314100000; D4: refuse, never round).
  PERFORM public._assert_whole_item_quantity(v_inv.product_id, p_delta);

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
  -- Whole-item products take whole quantities (20270314100000; D4: refuse, never round).
  PERFORM public._assert_whole_item_quantity(p_product_id, p_quantity);

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

DO $postflight$
DECLARE
  v_docs text;
  v_bad  text;
BEGIN
  -- Scanned after CREATE TRIGGER, whose lock holds off writers until commit (as in 20270313003100).
  WITH whole_items AS (
    SELECT p.id FROM public.products p
     WHERE lower(COALESCE(NULLIF(btrim(p.inventory_unit, E' \t\r\n' || chr(160)), ''),
                          NULLIF(btrim(p.unit_size, E' \t\r\n' || chr(160)), ''), '')) IN ('ea', 'unit')
  ), bad AS (
    SELECT 'PO ' || po.po_number AS doc FROM public.purchase_order_items poi JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.product_id IN (SELECT id FROM whole_items)
       AND NOT (poi.quantity_ordered = trunc(poi.quantity_ordered) AND poi.quantity_ordered > '-Infinity'::numeric AND poi.quantity_ordered < 'Infinity'::numeric)
    UNION
    SELECT 'PO receipt ' || COALESCE(po.po_number, rr.id::text) FROM public.receiving_records rr LEFT JOIN public.purchase_orders po ON po.id = rr.purchase_order_id
     WHERE rr.product_id IN (SELECT id FROM whole_items)
       AND NOT (rr.quantity_received = trunc(rr.quantity_received) AND rr.quantity_received > '-Infinity'::numeric AND rr.quantity_received < 'Infinity'::numeric)
    UNION
    SELECT 'count ' || cc.count_number FROM public.cycle_count_items cci JOIN public.cycle_counts cc ON cc.id = cci.cycle_count_id
     WHERE cci.product_id IN (SELECT id FROM whole_items)
       AND NOT (cci.counted_qty = trunc(cci.counted_qty) AND cci.counted_qty > '-Infinity'::numeric AND cci.counted_qty < 'Infinity'::numeric)
    UNION
    SELECT 'return ' || r.return_number FROM public.return_items ri JOIN public.returns r ON r.id = ri.return_id
     WHERE ri.product_id IN (SELECT id FROM whole_items)
       AND NOT (ri.quantity = trunc(ri.quantity) AND ri.quantity > '-Infinity'::numeric AND ri.quantity < 'Infinity'::numeric)
  )
  SELECT string_agg(doc, ', ' ORDER BY doc) INTO v_docs FROM (SELECT doc FROM bad ORDER BY doc LIMIT 10) first_ten;
  IF v_docs IS NOT NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_POSTFLIGHT: fractional quantities already exist on Ea/Unit products (first ten: %). Closed documents count too. Make each figure whole before applying; a received or counted fraction needs a person to decide how to correct the record', v_docs;
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'a3_whole_item_quantity' AND NOT tgisinternal
        AND tgfoid = 'public._enforce_whole_item_quantity()'::regprocedure) <> 7 THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_POSTFLIGHT: expected seven a3_whole_item_quantity triggers';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
              WHERE has_function_privilege(r, 'public._assert_whole_item_quantity(uuid,numeric,text)', 'EXECUTE')
                 OR has_function_privilege(r, 'public._enforce_whole_item_quantity()', 'EXECUTE')) THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_POSTFLIGHT: an API role can call the helper or the trigger function';
  END IF;
  SELECT string_agg(a.sig, ', ') INTO v_bad
    FROM pg_temp.whole_item_followups_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
   WHERE md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM CASE a.sig
           WHEN '_enforce_whole_item_quantity()' THEN '5f23e2ec36ccee0a9eefa54f393f505e'
           WHEN 'adjust_inventory(uuid,numeric,text,uuid,text)' THEN '43c9a4f91308ac272747071a4af437e8'
           ELSE 'f741844f6907c41ebf3329fa15b1a21c' END
      OR pg_get_userbyid(p.proowner) IS DISTINCT FROM a.owner OR p.proacl::text IS DISTINCT FROM a.acl
      OR p.proconfig IS DISTINCT FROM a.proconfig OR p.prosecdef IS DISTINCT FROM a.prosecdef;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_POSTFLIGHT: body, owner, grants or settings moved on %', v_bad;
  END IF;
END;
$postflight$;
