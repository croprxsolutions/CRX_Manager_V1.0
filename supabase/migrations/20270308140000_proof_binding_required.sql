-- idempotency-body-check: exempt -- _complete_delivery_authorized_impl only reads check_idempotency to skip a replay
-- (#2324's body, unchanged); the key is saved by _complete_delivery_authorized_impl_20270122 and the evidence step.
-- Written 2026-11-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270308140000_proof_binding_required.md.
--
-- WHY: 20270308100000 checks the customer's proof against the load only when the proof carries a list of the lines
--   the screen showed. An old app copy (or a call queued before the screen fix) sends a signature with no list, and a
--   ticket photo saved before the screen fix has none: both are still accepted, so Sol round 11 findings 1 and 2 on
--   #2324 stay open for them. Mason (2026-11-24, contract Q2): make the binding required in the same release as the
--   screen fix. Contract: docs/plans/2026-11-23-proof-bound-to-load-CONTRACT.md (step 4).
--
-- WHAT: _complete_delivery_authorized_impl (20270308100000's body) changes three conditions, nothing else: a fresh
--   completion is refused
--     DELIVERY_LOAD_CHANGED      for a signature sent with no p_lines_seen (as for one that is not the same load);
--     PAPER_TICKET_LOAD_CHANGED  for a ticket photo saved with no lines_seen, or one it cannot read (as for one that
--                                is not the same load).
--     LEFT_AT_SITE_LOAD_CHANGED  for a drop-location photo (no one present) saved with no lines_seen, one it cannot
--                                read, or one taken for another load (Mason, 2026-11-25: bound like a ticket photo;
--                                Taha's review of #2557, #2527 HIGH 4).
--   The screens treat these refusals as "clear the proof, reload the lines, get new proof".
--   _delivery_lines_match counts a delivered amount above 0 and under 0.01 as 0 on both sides (Taha's review of #2562,
--   LOW 1), so a proof taken while the screen showed 0.005 is the same load as one showing 0, as #2562 records it.
--
-- NOT CHANGED: no-proof records (never checked); replays of a completed call (never reach the
--   check); completed deliveries and saved receipts; every other body, the wrappers, the column, the grants.
--   No rows change.
-- actor-binding-check: exempt -- the shared step takes p_performed_by from the renamed bodies, which bind it to
-- auth.uid() exactly as before; nothing here reads or writes an actor.

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM '92e373301409583f2f7fec1f0cb207ee' THEN
    RAISE EXCEPTION 'PROOF_REQUIRED_PREFLIGHT: _complete_delivery_authorized_impl is not the reviewed 20270308100000 body';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._delivery_lines_match(uuid,jsonb,jsonb)'))
     IS DISTINCT FROM 'd622480ec89eb193526533db0475a643' THEN
    RAISE EXCEPTION 'PROOF_REQUIRED_PREFLIGHT: _delivery_lines_match is not the reviewed 20270308100000 body';
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
  v_binding jsonb;  -- 20270307030000
  v_ticket_lines jsonb;  -- 20270307030000
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
  -- or the full scheduled quantity when no figures were sent. Under 0.01 counts as nothing delivered (Mason, Slack
  -- 2026-11-23: it must not make an invoice). A delivery with no lines is refused too. Raised here,
  -- after the delivery row lock and before this function's order-line and stock locks and any write (the caller may
  -- already hold its stock locks; the refusal rolls the whole call back). A replay (v_status 'replay') is never checked.
  -- The lines are locked too. Today a direct line write already locks the delivery row first (the parent-lock
  -- trigger), so the row lock above waits for one in flight; the line lock keeps that true if the trigger changes.
  IF v_status = 'in_progress' THEN
    PERFORM 1 FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id ORDER BY di.id FOR UPDATE;
  END IF;
  IF v_status = 'in_progress'
     AND NOT EXISTS (SELECT 1 FROM public.delivery_items di
                      WHERE di.delivery_id = p_delivery_id
                        AND CASE WHEN p_quantities IS NOT NULL AND p_quantities ? di.id::text
                                 THEN GREATEST(0, LEAST((p_quantities ->> di.id::text)::numeric, di.quantity))
                                 ELSE di.quantity END >= 0.01) THEN
    RAISE EXCEPTION 'DELIVERY_NOTHING_DELIVERED: every product on it has a delivered quantity of zero (anything under 0.01 counts as zero). If nothing was delivered, call the office.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 20270307030000: the customer's proof covers the load the screen showed when it was taken. Here, after the delivery
  -- and line locks and every earlier rule (who may complete it, the replay decision, the evidence checks, nothing delivered), so
  -- the lines cannot change under it and every existing message comes first. Only the public wrappers set the binding,
  -- for this delivery; left at site and no proof are not checked.
  IF v_status = 'in_progress' THEN
    v_binding := NULLIF(current_setting('crx.proof_binding', true), '')::jsonb;
    IF v_binding ->> 'delivery_id' IS DISTINCT FROM p_delivery_id::text THEN
      v_binding := NULL;
    END IF;
    -- 20270308140000: required. A signature sent with no list (an old app copy, a queued call) is not proof of
    -- this load either.
    IF v_binding ->> 'evidence' = 'signature'
       AND (NOT v_binding ? 'lines_seen'
            OR NOT public._delivery_lines_match(p_delivery_id, v_binding -> 'lines_seen', p_quantities)) THEN
      RAISE EXCEPTION 'DELIVERY_LOAD_CHANGED: the products or delivered amounts on this delivery changed after the customer signed. Reload the delivery, check the products and amounts with the customer and get a new signature. If the customer already has the goods, call the office.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_binding ->> 'evidence' IN ('paper_ticket', 'left_at_site') THEN
      -- The photo row the evidence step has already checked and locked (it reads only the lower-case id).
      IF v_binding ->> 'evidence_ref' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT ph.lines_seen INTO v_ticket_lines
          FROM public.delivery_photos ph
         WHERE ph.id = (v_binding ->> 'evidence_ref')::uuid AND ph.delivery_id = p_delivery_id;
      END IF;
      -- 20270308140000: required. A photo saved with no list (before the screen fix), or one this step cannot
      -- read, is not proof of this load (Luna). The drop-location photo of a no-one-present stop is bound the same way
      -- (Mason, 2026-11-25, Taha's review of #2557: #2527 HIGH 4).
      IF v_binding ->> 'evidence' = 'left_at_site'
         AND (v_ticket_lines IS NULL OR NOT public._delivery_lines_match(p_delivery_id, v_ticket_lines, p_quantities)) THEN
        RAISE EXCEPTION 'LEFT_AT_SITE_LOAD_CHANGED: the products or delivered amounts on this delivery changed after the drop-location photo was taken. Take a new photo of where the delivery was left, for the current products and amounts.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_ticket_lines IS NULL OR NOT public._delivery_lines_match(p_delivery_id, v_ticket_lines, p_quantities) THEN
        RAISE EXCEPTION 'PAPER_TICKET_LOAD_CHANGED: the products or delivered amounts on this delivery changed after the ticket photo was taken. Get the ticket signed for the current products and amounts and add a new photo of it. If the customer already has the goods, call the office.'
          USING ERRCODE = 'check_violation';
      END IF;
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

-- The same comparison, with amounts under 0.01 counted as 0 (Taha's review of #2562, LOW 1).
CREATE OR REPLACE FUNCTION public._delivery_lines_match(p_delivery_id uuid, p_lines jsonb, p_quantities jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RETURN false;  -- checked on its own: jsonb_array_elements errors on anything but an array
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) e
              WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
                 OR jsonb_typeof(e -> 'order_item_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e -> 'product_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e -> 'quantity') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(e -> 'delivered') IS DISTINCT FROM 'number') THEN
    RETURN false;
  END IF;
  -- Each side's delivered amount is kept between 0 and the scheduled quantity, then an amount above 0 and under 0.01
  -- counts as 0 (20270308140000; the rule #2562 records a delivery by, and #2324's under-0.01 "nothing delivered").
  RETURN NOT EXISTS (
    WITH seen AS (
      SELECT lower(e ->> 'order_item_id') AS oi, lower(e ->> 'product_id') AS pr, round((e ->> 'quantity')::numeric, 6) AS q,
             GREATEST(0, LEAST((e ->> 'delivered')::numeric, (e ->> 'quantity')::numeric)) AS d
        FROM jsonb_array_elements(p_lines) e),
    current_load AS (
      SELECT di.order_item_id::text AS oi, di.product_id::text AS pr, round(di.quantity, 6) AS q,
             CASE WHEN p_quantities IS NOT NULL AND p_quantities ? di.id::text
                  THEN GREATEST(0, LEAST((p_quantities ->> di.id::text)::numeric, di.quantity))
                  ELSE di.quantity END AS d
        FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id),
    a AS (SELECT oi, pr, q, round(CASE WHEN d > 0 AND d < 0.01 THEN 0 ELSE d END, 6) AS d FROM seen),
    b AS (SELECT oi, pr, q, round(CASE WHEN d > 0 AND d < 0.01 THEN 0 ELSE d END, 6) AS d FROM current_load)
    (SELECT oi, pr, q, d FROM a EXCEPT ALL SELECT oi, pr, q, d FROM b)
    UNION ALL
    (SELECT oi, pr, q, d FROM b EXCEPT ALL SELECT oi, pr, q, d FROM a));
END;
$function$;
ALTER FUNCTION public._delivery_lines_match(uuid, jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._delivery_lines_match(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)')
                    AND md5(replace(p.prosrc, chr(13), '')) = 'b542beff97b76eea519e6f067a5b7c8d'
                    AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'PROOF_REQUIRED_POSTFLIGHT: the shared step, its security or its grants are not as reviewed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public._delivery_lines_match(uuid,jsonb,jsonb)')
                    AND md5(replace(p.prosrc, chr(13), '')) = '196fa2f0edc9360123791c1799e9626a'
                    AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'PROOF_REQUIRED_POSTFLIGHT: _delivery_lines_match, its security or its grants are not as reviewed';
  END IF;
END
$postflight$;
