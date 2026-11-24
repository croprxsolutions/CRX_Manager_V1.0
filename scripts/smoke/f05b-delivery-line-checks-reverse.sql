-- Rollback for 20270228260000_f05b_delivery_line_checks.sql (F05b #2274), proven by
-- scripts/smoke/prove-f05b-delivery-line-checks-real-schema.mjs.
-- Restores the 20270203120000 completion wrapper, all or nothing. The forward
-- migration wrote no data. To use it live, copy it into a new migration through the gates (without BEGIN / COMMIT);
-- never run it by hand against a live database. While it is off, a direct call can again complete a delivery with
-- nothing delivered.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $installed$
BEGIN
  -- Restore only over the reviewed F05b body, so a later change to this function is never silently undone (Sol r1 MED).
  -- The security settings too, so a later change to only those is not silently undone (Sol r5 LOW).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)')
         AND md5(replace(p.prosrc, chr(13), '')) = '09c2a3efd16258c66bea74b7b7b86151'
         AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'F05B_REVERSE: _complete_delivery_authorized_impl is not the F05b body; re-plan the rollback';
  END IF;
END
$installed$;
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
COMMIT;
