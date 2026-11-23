-- F05b (#2274, #2275): two delivery rules the screens already keep, now kept by the database.
-- Contract: docs/plans/2026-11-22-f05b-delivery-line-checks-CONTRACT.md.
--   * #2274: completing a delivery with nothing delivered is refused (DELIVERY_NOTHING_DELIVERED, SQLSTATE 23514),
--     inside the shared completion step every completion goes through (complete_delivery and start_and_complete_delivery
--     via _complete_delivery_aggregate_impl; offline sync calls complete_delivery; a delivery can enter 'completed' only
--     through complete_delivery, _require_delivery_completion_evidence). Only the new block below changes; the rest of
--     _complete_delivery_authorized_impl is the 20270203120000 body unchanged.
--   * #2275: delivery line quantities must be finite numbers (no NaN or +/-Infinity), as order lines are since F05.
-- Nothing is rewritten. Completed deliveries that already have nothing delivered (five line-less loads from March 2026
-- on production) stay as they are: the rule is checked only when a delivery is being completed.

SET LOCAL lock_timeout = '5s';
-- Completion's table order (header, then lines), so this cannot deadlock with a live completion.
LOCK TABLE public.deliveries, public.delivery_items IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_count integer;
  v_ids text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.delivery_items'::regclass
              AND conname = 'delivery_items_quantities_finite') THEN
    RAISE EXCEPTION 'F05B_PREFLIGHT: already applied';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM '7efd361c003d860361992711e3b15e92' THEN
    RAISE EXCEPTION 'F05B_PREFLIGHT: _complete_delivery_authorized_impl is not the reviewed 20270203120000 body';
  END IF;
  SELECT count(*), string_agg(di.id::text, ', ' ORDER BY di.id) INTO v_count, v_ids
    FROM public.delivery_items di
   WHERE NOT (di.quantity < 'Infinity'::numeric AND di.quantity > '-Infinity'::numeric AND (di.quantity_delivered IS NULL OR (di.quantity_delivered < 'Infinity'::numeric AND di.quantity_delivered > '-Infinity'::numeric)));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'F05B_PREFLIGHT: % delivery line(s) have a quantity that is not a finite number: %. Fix them by hand first.', v_count, v_ids;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_status text;
  v_bad_figures boolean;
  v_product record;
BEGIN
  -- KI-150: the delivery first (as the body does), then every stock row its lines can move, in product order, so two
  -- completions sharing products wait for each other instead of deadlocking. The body re-takes these locks.
  SELECT status INTO v_status FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  -- A key with a saved completion receipt is answered from it by the body, before any status check: treat it as not
  -- in progress here, so nothing below checks figures or creates a row for it (Luna r3). check_idempotency is the
  -- body's own read (it also refuses a key used by another operation).
  IF v_status = 'in_progress' AND public.check_idempotency(p_idempotency_key, 'complete_delivery') IS NOT NULL THEN
    v_status := 'replay';
  END IF;

  -- #1942 D (Astra 13): partial figures are keyed by delivery-line id, and the screens send one number for every line
  -- they loaded. Only a completion that can go ahead (in progress) is checked; anything else reaches the body as today
  -- (its refusal, or its saved receipt on a retry). A key that is not a line, or a line with no key, means the lines
  -- changed since the screen loaded them: the body would ignore the stale figure and deliver that line in full.
  IF v_status = 'in_progress' AND p_quantities IS NOT NULL THEN
    IF jsonb_typeof(p_quantities) IS DISTINCT FROM 'object' THEN
      v_bad_figures := true;  -- checked on its own: jsonb_each below errors on anything but an object (Luna r3)
    ELSE
      v_bad_figures := EXISTS (SELECT 1 FROM jsonb_each(p_quantities) e WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'number');
    END IF;
    IF v_bad_figures THEN
      RAISE EXCEPTION 'DELIVERY_QUANTITIES_INVALID: every delivered quantity must be a number; reload the delivery and enter the quantities again.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_quantities) k
                WHERE NOT EXISTS (SELECT 1 FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id AND di.id::text = k))
       OR EXISTS (SELECT 1 FROM public.delivery_items di
                   WHERE di.delivery_id = p_delivery_id AND NOT (p_quantities ? di.id::text)) THEN
      RAISE EXCEPTION 'DELIVERY_QUANTITIES_STALE: this delivery''s lines changed since the screen loaded them; reload it and enter the quantities again.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- F05b #2274: nothing delivered is not a completion. The screens already refuse it (DeliveryDetail hasAnyQty,
  -- FieldStop); this is the server rule. Same figure per line as the body: the clamped figure sent for that line,
  -- or the full scheduled quantity when no figures were sent. A delivery with no lines is refused too. Raised here,
  -- after the delivery row lock but before the line, order-line or stock locks and any write, inside the call, so
  -- offline sync records it for the office (23514 -> needs review); a replay (v_status 'replay') is never checked.
  IF v_status = 'in_progress'
     AND NOT EXISTS (SELECT 1 FROM public.delivery_items di
                      WHERE di.delivery_id = p_delivery_id
                        AND CASE WHEN p_quantities IS NOT NULL AND p_quantities ? di.id::text
                                 THEN GREATEST(0, LEAST((p_quantities ->> di.id::text)::numeric, di.quantity))
                                 ELSE di.quantity END > 0) THEN
    RAISE EXCEPTION 'DELIVERY_NOTHING_DELIVERED: every product on it has a delivered quantity of zero. If nothing was delivered, call the office.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Existing rows are locked first, in product order, exactly as before #1942 (creating rows in between could
  -- deadlock with a writer that holds an existing row and then creates a missing one: Sol r2).
  PERFORM 1 FROM public.inventory i
   WHERE i.location = 'Main Warehouse'
     AND i.product_id IN (SELECT di.product_id FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id)
   ORDER BY i.product_id, i.id
     FOR UPDATE;

  -- #1942 A: then, in product order and only while in progress, a product this completion moves that has no Main
  -- Warehouse row gets one, exactly as the body would create it (0 / 0, flagged manufactured at delivery), and is
  -- locked. Two completions creating rows for the same products then wait on each other in one order, not deadlock.
  FOR v_product IN
    SELECT di.product_id
      FROM public.delivery_items di
     WHERE di.delivery_id = p_delivery_id
       AND v_status = 'in_progress'
     GROUP BY di.product_id
    HAVING bool_or(CASE WHEN p_quantities IS NOT NULL AND p_quantities ? di.id::text
                   THEN GREATEST(0, LEAST((p_quantities ->> di.id::text)::numeric, di.quantity))
                   ELSE di.quantity END > 0)
     ORDER BY di.product_id
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.inventory i WHERE i.product_id = v_product.product_id AND i.location = 'Main Warehouse') THEN
      INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, manufactured_at_delivery)
      VALUES (v_product.product_id, 'Main Warehouse', 0, 0, true)
      ON CONFLICT DO NOTHING;
    END IF;
    -- Locked whether this pass created it or not: another completion may have committed it after the first pass (Sol r4).
    PERFORM 1 FROM public.inventory i
     WHERE i.product_id = v_product.product_id AND i.location = 'Main Warehouse'
     ORDER BY i.id
       FOR UPDATE;
  END LOOP;
  RETURN public._complete_delivery_authorized_impl_20270122(
    p_delivery_id, p_signed_by, p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at);
END;
$function$;
REVOKE ALL ON FUNCTION public._complete_delivery_authorized_impl(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.delivery_items
  ADD CONSTRAINT delivery_items_quantities_finite CHECK (quantity < 'Infinity'::numeric AND quantity > '-Infinity'::numeric AND (quantity_delivered IS NULL OR (quantity_delivered < 'Infinity'::numeric AND quantity_delivered > '-Infinity'::numeric)));

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)')
                    AND md5(replace(p.prosrc, chr(13), '')) = '8567f3bbbe66fa56b8289e6252cde877'
                    AND p.prosecdef
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'F05B_POSTFLIGHT: _complete_delivery_authorized_impl body, security, search_path or grants are not as reviewed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.delivery_items'::regclass
                    AND conname = 'delivery_items_quantities_finite' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'F05B_POSTFLIGHT: the finite-quantity constraint is missing or not validated';
  END IF;
END
$postflight$;
