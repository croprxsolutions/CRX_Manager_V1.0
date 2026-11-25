-- idempotency-body-check: exempt -- _complete_delivery_authorized_impl only reads check_idempotency to skip a replay
-- (#2324's body, unchanged); the key is saved by _complete_delivery_authorized_impl_20270122 and the evidence step.
-- Written 2026-11-23, extended 2026-11-24 (delivered amounts). STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270305110000_proof_bound_to_load.md.
--
-- WHY: a customer's proof (an on-screen signature, or a photo of the signed paper ticket) must complete a delivery only
--   for the products the screen showed when the proof was taken (Sol round 7 on #2324, findings 1 and 2),
--   and for the delivered amounts the screen showed then (Sol round 11 on #2324: 0.005 signed, 0.05 sent).
--   Contract: docs/plans/2026-11-23-proof-bound-to-load-CONTRACT.md. Needs #2324 (20270304160000) applied first.
--
-- WHAT:
--   * delivery_photos.lines_seen: the lines the screen showed when the photo was taken ([{order_item_id, product_id,
--     quantity, delivered}]), written by the app with the photo row; an update never changes it (trigger).
--   * complete_delivery and start_and_complete_delivery gain a last optional p_lines_seen (same shape: the lines the
--     screen showed when the customer signed). Today's functions are renamed unchanged behind thin wrappers that keep
--     the names, earlier parameters, defaults and grants (the 20270104120000 pattern) and pass the proof down in the
--     transaction setting crx.proof_binding.
--   * _complete_delivery_authorized_impl (the shared completion step, #2324's body) gains one block, after the delivery
--     and line locks and every earlier rule: a fresh completion is refused
--       DELIVERY_LOAD_CHANGED      for a signature sent with p_lines_seen that is not the same load;
--       PAPER_TICKET_LOAD_CHANGED  for a ticket photo whose lines_seen is not the same load.
--     "The same load": the same (order line, product, scheduled quantity, delivered amount) entries, counted as a
--     multiset, amounts compared as numbers; the delivered amount is this call's figure for the line (kept between 0 and
--     the scheduled quantity) or the scheduled quantity when none is sent. Line ids are not compared, so re-saving an
--     identical list keeps the proof good.
--
-- NOT CHANGED: every other body; a call with no binding (today's app, offline sync), left-at-site photos and no-proof
--   records; existing photos (lines_seen NULL, accepted as today); completed deliveries and saved receipts (a replay
--   never reaches the check). Making the binding required is a later migration (contract step 4).
--
-- caller-analysis: complete_delivery :: renamed to _complete_delivery_brands_impl_20270305 (no client EXECUTE); a new public.complete_delivery with the same earlier parameters plus optional p_lines_seen keeps today's grants (authenticated, service_role), so Deliveries.tsx, DeliveryDetail.tsx, FieldStop.tsx, offline sync and _start_and_complete_delivery_impl_20270104 keep calling it unchanged
-- caller-analysis: start_and_complete_delivery :: renamed to _start_and_complete_delivery_brands_impl_20270305 (no client EXECUTE); a new public.start_and_complete_delivery with the same earlier parameters plus optional p_lines_seen keeps today's grant (authenticated only), so Deliveries.tsx keeps calling it unchanged
-- actor-binding-check: exempt -- the wrappers take no actor of their own and write nothing; the renamed bodies bind
-- p_performed_by to auth.uid() exactly as before.

-- Adding a nullable column with no default rewrites nothing (its CHECK scans the small table once), but briefly takes an exclusive lock on delivery_photos: it
-- waits for open photo saves and ticket completions, and gives up rather than queue photo reads behind it for long.
SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM '09c2a3efd16258c66bea74b7b7b86151' THEN
    RAISE EXCEPTION 'PROOF_LOAD_PREFLIGHT: _complete_delivery_authorized_impl is not the reviewed 20270304160000 (#2324) body';
  END IF;
  IF to_regprocedure('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone,text,text,boolean,bigint)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_delivery') <> 1
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
          WHERE oid = to_regprocedure('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone,text,text,boolean,bigint)'))
        IS DISTINCT FROM '4d45156ce423bd09c6ef4444ec948886' THEN
    RAISE EXCEPTION 'PROOF_LOAD_PREFLIGHT: complete_delivery is not the reviewed 20270104120000 wrapper';
  END IF;
  IF to_regprocedure('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'start_and_complete_delivery') <> 1
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
          WHERE oid = to_regprocedure('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint)'))
        IS DISTINCT FROM '95c49c7e55be4e6f39146f524af8cf53' THEN
    RAISE EXCEPTION 'PROOF_LOAD_PREFLIGHT: start_and_complete_delivery is not the reviewed 20270104120000 wrapper';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'delivery_photos' AND column_name = 'lines_seen')
     OR to_regprocedure('public._delivery_lines_match(uuid,jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF_LOAD_PREFLIGHT: already applied';
  END IF;
END
$preflight$;

-- 1. The ticket photo carries the lines the screen showed when it was taken.
-- A list or nothing: a save that is not a list fails when the photo is saved, not at completion.
ALTER TABLE public.delivery_photos ADD COLUMN lines_seen jsonb
  CONSTRAINT delivery_photos_lines_seen_is_list CHECK (lines_seen IS NULL OR jsonb_typeof(lines_seen) = 'array');
COMMENT ON COLUMN public.delivery_photos.lines_seen IS
  'The lines the app showed when this photo was taken ([{order_item_id, product_id, quantity, delivered}]), written by the app with the row; never changed after (trigger trigger_delivery_photo_lines_seen_kept). A paper-ticket completion is refused PAPER_TICKET_LOAD_CHANGED unless it is the same load (20270305110000). NULL: not checked.';

CREATE FUNCTION public._delivery_photo_lines_seen_kept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- What the screen showed at the shutter; nobody rewrites it later. A photo's delivery and file never change
  -- (delivery_photos_uploader_guard), so a new capture is always a new row.
  NEW.lines_seen := OLD.lines_seen;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._delivery_photo_lines_seen_kept() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._delivery_photo_lines_seen_kept() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trigger_delivery_photo_lines_seen_kept
  BEFORE UPDATE ON public.delivery_photos
  FOR EACH ROW EXECUTE FUNCTION public._delivery_photo_lines_seen_kept();

-- 2. True only when p_lines is the delivery's current load with this call's delivered amounts: an array of objects,
--    each with a string order_item_id and product_id and JSON-number quantity and delivered, holding exactly the
--    current (order line, product, scheduled quantity, delivered amount) entries, each as many times as on the delivery.
--    The delivered amount is the one the body delivers: the figure sent for the line (p_quantities), kept between 0 and
--    the scheduled quantity, or the scheduled quantity when no figures were sent; the screen's figure is kept the same
--    way. Ids are compared as the database writes them (hyphenated, any case). Anything malformed is "not the same".
--    Sol round 11 on #2324: a signature taken with 0.005 must not complete a delivery of 0.05.
CREATE FUNCTION public._delivery_lines_match(p_delivery_id uuid, p_lines jsonb, p_quantities jsonb)
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
  RETURN NOT EXISTS (
    (SELECT lower(e ->> 'order_item_id'), lower(e ->> 'product_id'), (e ->> 'quantity')::numeric,
            GREATEST(0, LEAST((e ->> 'delivered')::numeric, (e ->> 'quantity')::numeric))
       FROM jsonb_array_elements(p_lines) e
     EXCEPT ALL
     SELECT di.order_item_id::text, di.product_id::text, di.quantity,
            CASE WHEN p_quantities IS NOT NULL AND p_quantities ? di.id::text
                 THEN GREATEST(0, LEAST((p_quantities ->> di.id::text)::numeric, di.quantity))
                 ELSE di.quantity END
       FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id)
    UNION ALL
    (SELECT di.order_item_id::text, di.product_id::text, di.quantity,
            CASE WHEN p_quantities IS NOT NULL AND p_quantities ? di.id::text
                 THEN GREATEST(0, LEAST((p_quantities ->> di.id::text)::numeric, di.quantity))
                 ELSE di.quantity END
       FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id
     EXCEPT ALL
     SELECT lower(e ->> 'order_item_id'), lower(e ->> 'product_id'), (e ->> 'quantity')::numeric,
            GREATEST(0, LEAST((e ->> 'delivered')::numeric, (e ->> 'quantity')::numeric))
       FROM jsonb_array_elements(p_lines) e));
END;
$function$;
ALTER FUNCTION public._delivery_lines_match(uuid, jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._delivery_lines_match(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- 3. The shared completion step: #2324's body with one added block (marked 20270305110000).
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
  v_binding jsonb;  -- 20270305110000
  v_ticket_lines jsonb;  -- 20270305110000
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
  -- 20270305110000: the customer's proof covers the load the screen showed when it was taken. Here, after the delivery
  -- and line locks and every earlier rule (who may complete it, the replay decision, the evidence checks, nothing delivered), so
  -- the lines cannot change under it and every existing message comes first. Only the public wrappers set the binding,
  -- for this delivery; a call with none (today's app, offline sync, left at site, no proof) is not checked.
  IF v_status = 'in_progress' THEN
    v_binding := NULLIF(current_setting('crx.proof_binding', true), '')::jsonb;
    IF v_binding ->> 'delivery_id' IS DISTINCT FROM p_delivery_id::text THEN
      v_binding := NULL;
    END IF;
    IF v_binding ->> 'evidence' = 'signature' AND v_binding ? 'lines_seen'
       AND NOT public._delivery_lines_match(p_delivery_id, v_binding -> 'lines_seen', p_quantities) THEN
      RAISE EXCEPTION 'DELIVERY_LOAD_CHANGED: the products or delivered amounts on this delivery changed after the customer signed. Reload the delivery, check the products and amounts with the customer and get a new signature. If the customer already has the goods, call the office.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_binding ->> 'evidence' = 'paper_ticket'
       AND v_binding ->> 'evidence_ref' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      -- The photo row the evidence step has already checked and locked.
      SELECT ph.lines_seen INTO v_ticket_lines
        FROM public.delivery_photos ph
       WHERE ph.id = (v_binding ->> 'evidence_ref')::uuid AND ph.delivery_id = p_delivery_id;
      IF v_ticket_lines IS NOT NULL AND NOT public._delivery_lines_match(p_delivery_id, v_ticket_lines, p_quantities) THEN
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

-- 4. The thin wrappers. Each sets crx.proof_binding for its delivery and puts back what was there on return, so the
--    nested complete_delivery call inside start_and_complete_delivery (which passes no p_lines_seen) keeps the outer
--    binding, and nothing is left after the outer call. A refusal rolls the setting back with everything else.
ALTER FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint)
  RENAME TO _complete_delivery_brands_impl_20270305;
REVOKE ALL ON FUNCTION public._complete_delivery_brands_impl_20270305(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_evidence text DEFAULT NULL::text,
  p_evidence_ref text DEFAULT NULL::text,
  p_email_receipt boolean DEFAULT NULL::boolean,
  p_brand_base_seq bigint DEFAULT NULL::bigint,
  p_lines_seen jsonb DEFAULT NULL::jsonb  -- 20270305110000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prior text := current_setting('crx.proof_binding', true);
  v_binding jsonb;
  v_result jsonb;
BEGIN
  -- Not part of the request fingerprint (like p_brand_base_seq): the same key is the same completion, and a saved
  -- receipt is returned before the check. The binding always names this call's delivery, evidence and reference; a
  -- call with no list carries the outer call's list only for the same three (start_and_complete's nested call).
  v_binding := jsonb_build_object('delivery_id', p_delivery_id, 'evidence', p_evidence, 'evidence_ref', p_evidence_ref);
  IF p_lines_seen IS NOT NULL THEN
    v_binding := v_binding || jsonb_build_object('lines_seen', p_lines_seen);  -- a JSON null is sent, and malformed
  ELSIF NULLIF(v_prior, '')::jsonb - 'lines_seen' = v_binding AND NULLIF(v_prior, '')::jsonb ? 'lines_seen' THEN
    v_binding := v_binding || jsonb_build_object('lines_seen', NULLIF(v_prior, '')::jsonb -> 'lines_seen');
  END IF;
  PERFORM set_config('crx.proof_binding', v_binding::text, true);
  v_result := public._complete_delivery_brands_impl_20270305(p_delivery_id, p_signed_by, p_performed_by, p_quantities,
    p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at, p_evidence, p_evidence_ref, p_email_receipt,
    p_brand_base_seq);
  PERFORM set_config('crx.proof_binding', COALESCE(v_prior, ''), true);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint, jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint, jsonb) IS
  'Completes a delivery (body: _complete_delivery_brands_impl_20270305). p_brand_base_seq as before (20270104120000). p_lines_seen (20270305110000): the lines the screen showed when the customer signed ([{order_item_id, product_id, quantity, delivered}]); a fresh signature completion is refused DELIVERY_LOAD_CHANGED unless it is the same load. A paper-ticket photo whose lines_seen is not the same load is refused PAPER_TICKET_LOAD_CHANGED.';

ALTER FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint)
  RENAME TO _start_and_complete_delivery_brands_impl_20270305;
REVOKE ALL ON FUNCTION public._start_and_complete_delivery_brands_impl_20270305(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.start_and_complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_delivered_on date,
  p_performed_by uuid DEFAULT NULL,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_evidence text DEFAULT NULL,
  p_evidence_ref text DEFAULT NULL,
  p_brand_base_seq bigint DEFAULT NULL,
  p_lines_seen jsonb DEFAULT NULL  -- 20270305110000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prior text := current_setting('crx.proof_binding', true);
  v_result jsonb;
BEGIN
  PERFORM set_config('crx.proof_binding', (jsonb_build_object('delivery_id', p_delivery_id, 'evidence', p_evidence,
    'evidence_ref', p_evidence_ref) || CASE WHEN p_lines_seen IS NULL THEN '{}'::jsonb
                                       ELSE jsonb_build_object('lines_seen', p_lines_seen) END)::text, true);
  v_result := public._start_and_complete_delivery_brands_impl_20270305(p_delivery_id, p_signed_by, p_delivered_on,
    p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_evidence, p_evidence_ref,
    p_brand_base_seq);
  PERFORM set_config('crx.proof_binding', COALESCE(v_prior, ''), true);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint, jsonb) TO authenticated;
COMMENT ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint, jsonb) IS
  'Starts and completes a delivery in one call (body: _start_and_complete_delivery_brands_impl_20270305). p_brand_base_seq and p_lines_seen as on complete_delivery.';

DO $postflight$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._delivery_lines_match(uuid,jsonb,jsonb)', 'public._delivery_photo_lines_seen_kept()',
    'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)',
    'public._complete_delivery_brands_impl_20270305(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone,text,text,boolean,bigint)',
    'public._start_and_complete_delivery_brands_impl_20270305(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint)'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)
                    AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'PROOF_LOAD_POSTFLIGHT: % security, search_path or grants are not as reviewed', v_fn;
    END IF;
  END LOOP;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM 'a5946da8ff04dde50f8ee0925ec0049d'
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_delivery') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'start_and_complete_delivery') <> 1
     OR has_function_privilege('anon', 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone,text,text,boolean,bigint,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone,text,text,boolean,bigint,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone,text,text,boolean,bigint,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb)', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_photos'::regclass
                     AND tgname = 'trigger_delivery_photo_lines_seen_kept' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PROOF_LOAD_POSTFLIGHT: shared step, wrappers, grants or the photo trigger are not as reviewed';
  END IF;
END
$postflight$;
