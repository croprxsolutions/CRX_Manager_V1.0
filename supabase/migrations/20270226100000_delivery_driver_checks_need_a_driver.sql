-- Written 2026-11-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270226100000_delivery_driver_checks_need_a_driver.md.
--
-- WHY: the delivery permission checks below let a driver act on a delivery only when they are its assigned driver.
--   Each compares the caller with deliveries.assigned_driver inside an IF. A delivery may have no driver, and the
--   check must then treat the driver branch as "not this driver". Mason approved this fix 2026-11-23.
--
-- WHAT: in each function the driver branch gains "<assigned driver> IS NOT NULL AND", so it is a plain true or false.
--   One line per function; nothing else in any body changes:
--     _complete_delivery_evidence_impl_20270104, _start_and_complete_delivery_impl_20270104,
--     _complete_delivery_aggregate_impl, _complete_delivery_period_preflight_impl,
--     _complete_delivery_replay_impl_20261015, _complete_delivery_authorized_impl_20270122 (completion),
--     get_delivery_receipt_recipient (the farm's receipt contact) and stage_offline_action (the delivery branch).
--   Admins and sales reps keep their access. The assigned driver keeps theirs. A delivery with no driver is handled
--   by the office, or by a driver after they take it (reassign_delivery, #2018).
--
-- NOT CHANGED: signatures, owners, SECURITY DEFINER, search_path, grants and comments (CREATE OR REPLACE keeps them;
--   the postflight checks them), every other function, table, row and policy. The confirm_delivery start checks
--   already use EXISTS (a delivery with no driver matches no driver row), so they are unchanged.
--
-- BASE BODIES (md5, CR stripped; pinned in the preflight):
--   _complete_delivery_evidence_impl_20270104: eed8da07fedbec14a198ca4f6e26c213
--   _start_and_complete_delivery_impl_20270104: 640603e6dce34abc1fe18d4dad6adc56
--   _complete_delivery_aggregate_impl: 766ecfc4c72be62df8d4f7ed770d267c
--   _complete_delivery_period_preflight_impl: f13018d7449506ff80c69facfb51b000
--   _complete_delivery_replay_impl_20261015: a1e9a043f27d3566f8ecf6d5e3a809ab
--   _complete_delivery_authorized_impl_20270122: 70e318a7f05d51d2cf6c3c6ea6226379
--   get_delivery_receipt_recipient: 18c18cd03485e4850361ac212ab5755d
--   stage_offline_action: e3f9a5aaa1d9ac54bf9cee0546b057f9
--   Each is the body of the latest migration that defines it on staging; for every one but
--   _complete_delivery_authorized_impl_20270122 (20270203120000) and _complete_delivery_period_preflight_impl
--   (20270213100000), that is also live production's body (read-only, 2026-11-23).
--
-- ROLLBACK: a reviewed forward migration that KEEPS the driver check; never restore the base bodies above in
--   production. scripts/smoke/delivery-driver-checks-need-a-driver-reverse.sql is proof-only (disposable container).
--
-- idempotency-body-check: exempt -- no new mutating entry point; each body keeps its idempotency handling unchanged.
--
-- ORDERING: after 20270213100000 (the preflight requires its body and 20270203120000's). Not re-runnable (preflight
--   refuses a changed body). Postflight pins the new body md5s.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._complete_delivery_evidence_impl_20270104(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone,text,text,boolean)'))
     IS DISTINCT FROM 'eed8da07fedbec14a198ca4f6e26c213' THEN
    RAISE EXCEPTION 'DRIVER_CHECK_PREFLIGHT: _complete_delivery_evidence_impl_20270104 is missing, drifted or already changed';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._start_and_complete_delivery_impl_20270104(uuid,text,date,uuid,jsonb,text,text,text,text,text)'))
     IS DISTINCT FROM '640603e6dce34abc1fe18d4dad6adc56' THEN
    RAISE EXCEPTION 'DRIVER_CHECK_PREFLIGHT: _start_and_complete_delivery_impl_20270104 is missing, drifted or already changed';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM '766ecfc4c72be62df8d4f7ed770d267c' THEN
    RAISE EXCEPTION 'DRIVER_CHECK_PREFLIGHT: _complete_delivery_aggregate_impl is missing, drifted or already changed';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM 'f13018d7449506ff80c69facfb51b000' THEN
    RAISE EXCEPTION 'DRIVER_CHECK_PREFLIGHT: _complete_delivery_period_preflight_impl is missing, drifted or already changed';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._complete_delivery_replay_impl_20261015(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM 'a1e9a043f27d3566f8ecf6d5e3a809ab' THEN
    RAISE EXCEPTION 'DRIVER_CHECK_PREFLIGHT: _complete_delivery_replay_impl_20261015 is missing, drifted or already changed';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM '70e318a7f05d51d2cf6c3c6ea6226379' THEN
    RAISE EXCEPTION 'DRIVER_CHECK_PREFLIGHT: _complete_delivery_authorized_impl_20270122 is missing, drifted or already changed';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_delivery_receipt_recipient(uuid)'))
     IS DISTINCT FROM '18c18cd03485e4850361ac212ab5755d' THEN
    RAISE EXCEPTION 'DRIVER_CHECK_PREFLIGHT: get_delivery_receipt_recipient is missing, drifted or already changed';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.stage_offline_action(uuid,text,uuid,integer,timestamp with time zone,jsonb,text,timestamp with time zone)'))
     IS DISTINCT FROM 'e3f9a5aaa1d9ac54bf9cee0546b057f9' THEN
    RAISE EXCEPTION 'DRIVER_CHECK_PREFLIGHT: stage_offline_action is missing, drifted or already changed';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._complete_delivery_evidence_impl_20270104(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_evidence text DEFAULT NULL::text, p_evidence_ref text DEFAULT NULL::text, p_email_receipt boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  v_status text;
  v_assigned_driver uuid;
  v_actor_role text;
  v_signature_path text;
  v_photo_id uuid;
  v_caption text;
  v_rows integer;
  v_reason text;
  v_recorder_name text;
  v_photo public.delivery_photos%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: complete_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same tests and messages as the renamed body.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- The body's own authorization test (same message), before the receipt lookup and every evidence
  -- check, as start_and_complete_delivery does: a reassigned or deactivated actor gets no replay.
  SELECT status, assigned_driver INTO v_status, v_assigned_driver
    FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;
  -- FOR SHARE: a concurrent demotion or deactivation waits until this completion ends.
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true FOR SHARE;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_assigned_driver IS NOT NULL AND v_actor = v_assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  IF p_evidence IS NULL THEN
    -- Legacy replay only: exactly the 20261019200000 fingerprint, so an app from before this change can
    -- recover a completion that committed but whose reply was lost. It never completes anything new.
    v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
      'actor_id', v_actor,
      'delivery_id', p_delivery_id,
      'signed_by', p_signed_by,
      'quantities', p_quantities,
      'issue_type', p_issue_type,
      'issue_notes', p_issue_notes,
      'completed_at_epoch', extract(epoch FROM p_completed_at)
    ));
    v_replay := public.check_idempotency_intent(p_idempotency_key, 'complete_delivery', v_actor, v_fingerprint);
    IF v_replay IS NULL THEN
      RAISE EXCEPTION 'COMPLETION_EVIDENCE_REQUIRED: say how the customer confirmed the delivery (signature, paper_ticket or left_at_site)'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN public._complete_delivery_replay_impl_20261015(p_delivery_id, p_signed_by, p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at);
  END IF;

  IF p_evidence NOT IN ('signature', 'paper_ticket', 'left_at_site', 'no_proof') THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_INVALID: %', p_evidence USING ERRCODE = '22023';
  END IF;
  IF p_evidence_ref IS NULL OR btrim(p_evidence_ref) = '' THEN
    IF p_evidence = 'no_proof' THEN
      RAISE EXCEPTION 'NO_PROOF_REASON_REQUIRED: write why this delivery is recorded without proof (10 to 500 characters)' USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_INVALID: % needs its evidence reference', p_evidence USING ERRCODE = '22023';
  END IF;
  -- Recording without proof: an active admin only (before the receipt lookup, so a demoted admin cannot
  -- replay either), a real written reason, and a signer text that never names a customer.
  IF p_evidence = 'no_proof' THEN
    IF v_actor_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'NO_PROOF_ADMIN_ONLY: only an admin can record a delivery without proof' USING ERRCODE = '42501';
    END IF;
    v_reason := btrim(regexp_replace(p_evidence_ref, '[[:space:]]+', ' ', 'g'));
    IF char_length(v_reason) NOT BETWEEN 10 AND 500 THEN
      RAISE EXCEPTION 'NO_PROOF_REASON_REQUIRED: write why this delivery is recorded without proof (10 to 500 characters)' USING ERRCODE = '22023';
    END IF;
    IF p_signed_by IS DISTINCT FROM 'No proof — recorded by office' THEN
      RAISE EXCEPTION 'NO_PROOF_SIGNER_MISMATCH: a completion without proof is signed "No proof — recorded by office"' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- p_quantities is fingerprinted as sent (jsonb normalizes key order); p_completed_at as its epoch,
  -- so the session TimeZone cannot change the fingerprint of the same instant.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'signed_by', p_signed_by,
    'quantities', p_quantities,
    'issue_type', p_issue_type,
    'issue_notes', p_issue_notes,
    'completed_at_epoch', extract(epoch FROM p_completed_at),
    'evidence', p_evidence,
    'evidence_ref', p_evidence_ref
  ) || CASE WHEN p_email_receipt IS TRUE THEN jsonb_build_object('email_receipt', true)
            ELSE '{}'::jsonb END);  -- 20261108100000 (KI-25): FALSE asks for no receipt, like NULL
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'complete_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    -- An exact retry: the body replays its own saved answer; the evidence was checked the first time.
    RETURN public._complete_delivery_replay_impl_20261015(p_delivery_id, p_signed_by, p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at);
  END IF;

  -- A fresh completion: the body's status rule first, so an already completed or cancelled delivery is
  -- reported as such rather than as missing evidence.
  IF v_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be in_progress to complete (current status: %)', v_status;
  END IF;

  IF p_evidence = 'signature' THEN
    -- The only accepted image is the one uploaded for THIS key by THIS caller.
    v_signature_path := 'signatures/' || p_delivery_id::text || '/'
      || left(encode(sha256(convert_to(p_idempotency_key, 'UTF8')), 'hex'), 32) || '.png';
    IF p_evidence_ref IS DISTINCT FROM v_signature_path
       OR NOT EXISTS (SELECT 1 FROM storage.objects o
                       WHERE o.bucket_id = 'delivery-signatures' AND o.name = v_signature_path
                         AND o.owner_id = v_actor::text
                         AND o.metadata ->> 'mimetype' = 'image/png'
                         AND COALESCE(o.metadata ->> 'size', '') ~ '^[0-9]+$'
                         -- A drawn signature is never this small (live 2026-10-22: smallest 2,356 bytes);
                         -- the bytes themselves cannot be read here, so size and type are the check.
                         AND (o.metadata ->> 'size')::bigint >= 500) THEN
      RAISE EXCEPTION 'SIGNATURE_IMAGE_MISSING: no signature image saved for this attempt' USING ERRCODE = '23514';
    END IF;
  ELSIF p_evidence IN ('paper_ticket', 'left_at_site') THEN
    IF p_evidence = 'left_at_site' AND p_signed_by IS DISTINCT FROM 'No one present — left at site' THEN
      RAISE EXCEPTION 'LEFT_AT_SITE_SIGNER_MISMATCH: a left-at-site completion is signed "No one present — left at site"'
        USING ERRCODE = '23514';
    END IF;
    v_caption := CASE p_evidence
      WHEN 'paper_ticket' THEN 'Signed paper delivery ticket'
      ELSE 'Left at site — drop location'
    END;
    IF p_evidence_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_photo_id := p_evidence_ref::uuid;
    END IF;
    -- The exact photo the screen showed, locked so a concurrent edit waits for this completion (and is
    -- then refused by protect_accepted_delivery_photo): this delivery's, with the caption, its file in
    -- this delivery's own folder, stored and non-empty.
    IF v_photo_id IS NOT NULL THEN
      SELECT * INTO v_photo FROM public.delivery_photos WHERE id = v_photo_id FOR UPDATE;
    END IF;
    IF v_photo.id IS NULL
       OR v_photo.delivery_id IS DISTINCT FROM p_delivery_id
       OR v_photo.caption IS DISTINCT FROM v_caption
       OR split_part(v_photo.storage_path, '/', 1) <> 'delivery-photos'
       OR split_part(v_photo.storage_path, '/', 2) <> p_delivery_id::text
       OR NOT EXISTS (SELECT 1 FROM storage.objects o
                       WHERE o.bucket_id = 'delivery-photos' AND o.name = v_photo.storage_path
                         AND COALESCE(o.metadata ->> 'mimetype', '') LIKE 'image/%'
                         AND COALESCE(o.metadata ->> 'size', '') ~ '^[0-9]+$'
                         AND (o.metadata ->> 'size')::bigint >= 1000) THEN
      IF p_evidence = 'paper_ticket' THEN
        RAISE EXCEPTION 'PAPER_TICKET_PHOTO_MISSING: no saved photo of the signed paper ticket for this delivery' USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION 'LEFT_AT_SITE_PHOTO_MISSING: no saved photo of where the delivery was left' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Lets require_delivery_completion_evidence accept this delivery's completion, and only until the
  -- evidence is recorded (a refusal rolls the setting back with everything else).
  IF p_evidence = 'no_proof' THEN
    SELECT COALESCE(NULLIF(btrim(full_name), ''), 'Admin ' || left(v_actor::text, 8)) INTO v_recorder_name
      FROM public.profiles WHERE id = v_actor;
  END IF;
  PERFORM set_config('crx.delivery_completion_evidence', p_delivery_id::text, true);
  v_result := public._complete_delivery_replay_impl_20261015(p_delivery_id, p_signed_by, p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at);
  UPDATE public.deliveries
     SET completion_evidence = p_evidence,
         completion_evidence_ref = CASE WHEN p_evidence = 'no_proof' THEN v_reason ELSE p_evidence_ref END,
         -- The checked path for a signature; never a leftover path for any other evidence.
         signature_url = CASE WHEN p_evidence = 'signature' THEN p_evidence_ref END,
         completion_no_proof_by = CASE WHEN p_evidence = 'no_proof' THEN v_actor END,
         completion_no_proof_by_name = CASE WHEN p_evidence = 'no_proof' THEN v_recorder_name END,
         completion_no_proof_at = CASE WHEN p_evidence = 'no_proof' THEN clock_timestamp() END
   WHERE id = p_delivery_id AND status = 'completed';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('crx.delivery_completion_evidence', '', true);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_NOT_RECORDED: the delivery did not end completed';
  END IF;
  -- 20261108100000 (KI-25): the customer receipt is owed from this commit; the worker sends it.
  IF p_email_receipt IS TRUE AND p_evidence <> 'no_proof' THEN
    PERFORM public._enqueue_delivery_receipt(p_delivery_id, v_actor);
  END IF;
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'complete_delivery', v_fingerprint);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._start_and_complete_delivery_impl_20270104(p_delivery_id uuid, p_signed_by text, p_delivered_on date, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_evidence text DEFAULT NULL::text, p_evidence_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_completed_at timestamptz;
  v_fingerprint text;
  v_replay jsonb;
  v_status text;
  v_assigned_driver uuid;
  v_actor_role text;
  v_started boolean := false;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: start_and_complete_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF p_delivered_on IS NULL THEN
    RAISE EXCEPTION 'DELIVERED_ON_REQUIRED: choose the delivery date' USING ERRCODE = '22023';
  END IF;
  -- A real date no more than a year back: refuses +/-infinity and typo years, which would otherwise
  -- date the delivery and its invoice outside any accounting period.
  IF NOT isfinite(p_delivered_on) THEN
    RAISE EXCEPTION 'DELIVERED_ON_INVALID: % is not a real date', p_delivered_on USING ERRCODE = '22023';
  END IF;
  IF p_delivered_on > v_today THEN
    RAISE EXCEPTION 'DELIVERED_ON_IN_FUTURE: the delivery date % is after today (%)', p_delivered_on, v_today
      USING ERRCODE = '22023';
  END IF;
  IF p_evidence IS NOT NULL AND p_evidence NOT IN ('signature', 'paper_ticket', 'left_at_site', 'no_proof') THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_INVALID: %', p_evidence USING ERRCODE = '22023';
  END IF;
  IF p_evidence IS NOT NULL AND (p_evidence_ref IS NULL OR btrim(p_evidence_ref) = '') THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_INVALID: % needs its evidence reference', p_evidence USING ERRCODE = '22023';
  END IF;
  -- The one-year bound moves with the clock, so it runs after the receipt lookup below: an exact
  -- retry of a completion saved on the oldest allowed date, landing after Chicago midnight, still
  -- replays instead of being refused. A date valid when sent never becomes a future date.

  -- complete_delivery's own test, run BEFORE the receipt lookup, so a driver taken off the
  -- delivery or a deactivated account gets neither a replayed completion nor a refusal that
  -- carries the saved result (check_idempotency_intent's intent-mismatch DETAIL).
  SELECT status, assigned_driver INTO v_status, v_assigned_driver
    FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;
  -- FOR SHARE: a concurrent demotion or deactivation waits until this completion ends.
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true FOR SHARE;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_assigned_driver IS NOT NULL AND v_actor = v_assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;
  -- complete_delivery's no-proof rules, early, so nothing is started for a refused request.
  IF p_evidence = 'no_proof' THEN
    IF v_actor_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'NO_PROOF_ADMIN_ONLY: only an admin can record a delivery without proof' USING ERRCODE = '42501';
    END IF;
    IF char_length(btrim(regexp_replace(p_evidence_ref, '[[:space:]]+', ' ', 'g'))) NOT BETWEEN 10 AND 500 THEN
      RAISE EXCEPTION 'NO_PROOF_REASON_REQUIRED: write why this delivery is recorded without proof (10 to 500 characters)' USING ERRCODE = '22023';
    END IF;
    IF p_signed_by IS DISTINCT FROM 'No proof — recorded by office' THEN
      RAISE EXCEPTION 'NO_PROOF_SIGNER_MISMATCH: a completion without proof is signed "No proof — recorded by office"' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_evidence IS NULL THEN
    -- Legacy replay only: exactly the 20261019220000 fingerprint. Never completes anything new.
    v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
      'actor_id', v_actor,
      'delivery_id', p_delivery_id,
      'signed_by', p_signed_by,
      'delivered_on', p_delivered_on,
      'quantities', p_quantities,
      'issue_type', p_issue_type,
      'issue_notes', p_issue_notes
    ));
    v_replay := public.check_idempotency_intent(p_idempotency_key, 'start_and_complete_delivery', v_actor, v_fingerprint);
    IF v_replay IS NULL THEN
      RAISE EXCEPTION 'COMPLETION_EVIDENCE_REQUIRED: say how the customer confirmed the delivery (signature, paper_ticket or left_at_site)'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- p_quantities is fingerprinted as sent (jsonb normalizes key order); the chosen date, not a
  -- derived instant, so an exact retry keeps its fingerprint across Chicago midnight.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'signed_by', p_signed_by,
    'delivered_on', p_delivered_on,
    'quantities', p_quantities,
    'issue_type', p_issue_type,
    'issue_notes', p_issue_notes,
    'evidence', p_evidence,
    'evidence_ref', p_evidence_ref
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'start_and_complete_delivery', v_actor, v_fingerprint);

  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  IF p_delivered_on < (v_today - interval '1 year')::date THEN
    RAISE EXCEPTION 'DELIVERED_ON_TOO_OLD: the delivery date % is more than a year before today (%)', p_delivered_on, v_today
      USING ERRCODE = '22023';
  END IF;

  IF v_status = 'scheduled' THEN
    PERFORM public._confirm_delivery_replay_impl_20261015(p_delivery_id, v_actor, NULL);
    v_started := true;
  END IF;

  IF p_delivered_on < v_today THEN
    -- 17:00 UTC of the chosen date (noon CDT, 11 AM CST): the same instant the app already sends
    -- for a past date (completedAtForDeliveredOn), and always the chosen date in Chicago.
    v_completed_at := (p_delivered_on + time '17:00') AT TIME ZONE 'UTC';
  END IF;

  v_result := public.complete_delivery(
    p_delivery_id,
    p_signed_by,
    v_actor,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key || ':complete',
    v_completed_at,
    p_evidence,
    p_evidence_ref
  );
  IF v_result IS NULL OR jsonb_typeof(v_result) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'COMPLETE_DELIVERY_RESULT_INVALID';
  END IF;
  v_result := v_result || jsonb_build_object('started', v_started);

  PERFORM public.save_idempotency(p_idempotency_key, 'start_and_complete_delivery', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'start_and_complete_delivery', v_fingerprint);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._complete_delivery_aggregate_impl(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_delivery record;
  v_base_seq text := NULLIF(current_setting('crx.brand_base_seq', true), '');  -- 20270104120000
  v_picks_confirmed boolean;  -- 20270104120000
  v_result jsonb;  -- 20270104120000
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, assigned_driver, status
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_delivery.assigned_driver IS NOT NULL AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- 20270104120000 (Brand PR B): brands never refuse a completion (Mason 2026-11-09). A screen that sent the
  -- brand seq it loaded confirms the picks only if they have not changed since; otherwise the completion still
  -- goes through and the 'completed' event records picks_confirmed false, which puts its picked lines on the
  -- office list. A caller that sent no seq (the app before B-2) records NULL: not stated, not flagged.
  PERFORM set_config('crx.brand_base_seq', '', true);
  -- Only the wrappers set the value; anything that is not a plain number reads as not confirmed, never an error.
  v_picks_confirmed := CASE WHEN v_base_seq IS NULL THEN NULL
    WHEN v_base_seq ~ '^[0-9]{1,18}$' THEN v_base_seq::bigint = public._delivery_brand_max_seq(p_delivery_id)
    ELSE false END;

  -- 20270106110000 (B-1b): invoice lines the body writes while completing this delivery (Bill Split and landlord
  -- split drafts, which the re-copy never touches) read its brands as the completion rule below will leave them.
  IF v_delivery.status = 'in_progress' THEN
    PERFORM set_config('crx.brand_completing_delivery', p_delivery_id::text, true);
  END IF;
  v_result := public._complete_delivery_authorized_impl(
    p_delivery_id,
    p_signed_by,
    p_performed_by,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key,
    p_completed_at
  );
  PERFORM set_config('crx.brand_completing_delivery', '', true);  -- 20270106110000

  -- 20270104120000: the brand completion rule, once, for a delivery this call completed. Outside the body's Bill
  -- Split fallback, so an error here fails the completion instead of changing the billing.
  IF v_delivery.status = 'in_progress'
     AND (SELECT d.status FROM public.deliveries d WHERE d.id = p_delivery_id) = 'completed' THEN
    PERFORM public._delivery_brands_on_complete(p_delivery_id, v_picks_confirmed);
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._complete_delivery_period_preflight_impl(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_delivery record;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, delivery_number, customer_id, assigned_driver
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_delivery.assigned_driver IS NOT NULL AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- Authorization deliberately precedes replay lookup.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'complete_delivery'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Lock every existing warehouse row involved before taking the aggregate
  -- snapshot. Missing rows are already handled by the proven inner function.
  PERFORM 1
    FROM public.inventory inv
   WHERE inv.location = 'Main Warehouse'
     AND inv.product_id IN (
       SELECT di.product_id
         FROM public.delivery_items di
        WHERE di.delivery_id = p_delivery_id
     )
   ORDER BY inv.product_id
   FOR UPDATE;

  -- #2135: the repeated-line short-stock check that stood here duplicated the completion body's own check
  -- (#1942 counts each product once against the delivery's total), so its warnings were written twice. Removed;
  -- the row lock pass above is kept as it was.
  v_result := public._complete_delivery_aggregate_impl(
    p_delivery_id,
    p_signed_by,
    p_performed_by,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key,
    p_completed_at
  );

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._complete_delivery_replay_impl_20261015(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_delivery record;
  v_existing jsonb;
  v_effective_completion_date date;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, assigned_driver
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_delivery.assigned_driver IS NOT NULL AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- Preserve committed replay even if the historical business date has since
  -- moved into a closed period. No mutation occurs on this branch.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'complete_delivery'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  PERFORM public.check_period_open(v_effective_completion_date);

  RETURN public._complete_delivery_period_preflight_impl(
    p_delivery_id,
    p_signed_by,
    p_performed_by,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key,
    p_completed_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl_20270122(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_all_delivered boolean;
  v_linked_invoice record;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
  v_auto_invoice_id uuid;
  v_auto_invoice_number text;
  v_bill_split_ids uuid[];
  v_bill_split_failed boolean := false;
  v_auto_total_cents bigint := 0;
  v_auto_cost_cents bigint := 0;
  -- CRX-MONEY-LIFECYCLE-001: cents allocated to THIS delivery from the order
  -- line's stored total, rather than re-extended from price x quantity.
  v_line_alloc_cents bigint := 0;
  v_existing_active_invoice_count int;
  v_closed_period record;
  v_admin record;
  -- U9 stock-policy WARN-NOT-BLOCK
  v_short_count int := 0;
  v_stock_warnings text[] := '{}';
  v_short_product_ids uuid[] := '{}';
  v_effective_completion_date date;
  -- #1942 (Astra 36): what this delivery takes of each product across all its lines (lines can share one stock row).
  v_need jsonb;
  v_need_total numeric;
  v_inv_found boolean;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  -- U15: optional backdate. Reject future timestamps (small clock-skew allowance);
  -- NULL = legacy behavior (now()/CURRENT_DATE).
  IF p_completed_at IS NOT NULL AND p_completed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'COMPLETED_AT_IN_FUTURE: completion time cannot be in the future';
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_delivery.assigned_driver IS NOT NULL AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be in_progress to complete (current status: %). Call confirm_delivery() first.', v_delivery.status;
  END IF;

  -- PR-01 fix: column is `scheduled_date`, not `delivery_date`.
  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' completed for ' || v_effective_completion_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Completion',
        'Delivery ' || v_delivery.delivery_number ||
          ' was completed for ' || v_effective_completion_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory and lifecycle ' ||
          'changes proceeded. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  SELECT COALESCE(jsonb_object_agg(s.product_id::text, s.total), '{}'::jsonb) INTO v_need
    FROM (SELECT di.product_id, sum(CASE WHEN p_quantities IS NOT NULL AND p_quantities ? di.id::text
                   THEN GREATEST(0, LEAST((p_quantities ->> di.id::text)::numeric, di.quantity))
                   ELSE di.quantity END) AS total
            FROM delivery_items di
           WHERE di.delivery_id = p_delivery_id
           GROUP BY di.product_id) s;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    v_inv_found := FOUND;
    v_need_total := (v_need ->> v_item.product_id::text)::numeric;
    -- U9: WARN-NOT-BLOCK (was: RAISE EXCEPTION 'Insufficient inventory ...').
    -- Same on-hand math; completion proceeds and stock is allowed to go negative.
    -- #1942: against the delivery's total for the product, once per product (its other lines are flagged below too).
    IF (NOT v_inv_found OR COALESCE(v_inv.quantity_available, 0) < v_need_total)
       AND NOT (v_item.product_id = ANY(v_short_product_ids)) THEN
      v_short_count := v_short_count + 1;
      v_short_product_ids := array_append(v_short_product_ids, v_item.product_id);
      v_stock_warnings := array_append(v_stock_warnings,
        v_item.product_name || ': need ' || v_need_total || ', only ' ||
        COALESCE(v_inv.quantity_available, 0) || ' on-hand');
      -- U9 (Codex R2 P2): seed a zero row when missing so the deduction UPDATE
      -- below lands and the on-hand aggregate goes visibly negative.
      IF NOT v_inv_found THEN
        INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, manufactured_at_delivery)
        VALUES (v_item.product_id, 'Main Warehouse', 0, 0, true)  -- surfaces on /integrity-cleanup (P4-7 phantom-row flag)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  -- P2-D: authorize the post-completion delivery_items + lifecycle writes below.
  -- The enforce_delivery_items_parent_lock trigger blocks writes to a
  -- non-scheduled delivery's items; complete_delivery legitimately records
  -- quantity_delivered after flipping status to 'completed', so it sets the
  -- canonical admin_override escape hatch (transaction-local).
  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'completed', completed_at = COALESCE(p_completed_at, now()), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver, quantity_prebooked_released = 0 WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    -- U9: flag the delivered ledger row for review when the product was short.
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes, requires_review
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END ||
        CASE WHEN v_item.product_id = ANY(v_short_product_ids)
          THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        '. Signed by: ' || p_signed_by,
      v_item.product_id = ANY(v_short_product_ids)
    );

    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));
    -- KI-94 (20261106230000): record what this line takes from the reservation; void_delivery puts back exactly this.
    UPDATE delivery_items SET quantity_prebooked_released = v_deduct_from_prebooked WHERE id = v_item.id;

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- U2 (Codex P2): with per-delivery invoices now possible on one order, the
  -- tote copy must NOT stamp a SIBLING delivery's invoice — scope it to this
  -- delivery's own invoice or an order-level one (delivery_id IS NULL), the
  -- same shape as the auto-invoice guard below. Return-credit lines are
  -- immutable accounting provenance, not delivery-sale lines to relabel.
  UPDATE invoice_items ii
  SET tote_number = di.tote_number
  FROM delivery_items di
  JOIN invoices inv ON inv.order_id = v_delivery.order_id AND inv.deleted_at IS NULL
    AND inv.invoice_type <> 'credit_memo'
    AND (inv.delivery_id = p_delivery_id OR inv.delivery_id IS NULL)
  WHERE di.delivery_id = p_delivery_id
    AND ii.invoice_id = inv.id
    AND di.order_item_id = ii.order_item_id
    AND di.tote_number IS NOT NULL;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  -- U2 #39: close out the remainder rows THIS follow-up delivery was created to satisfy.
  -- create_followup_delivery flips the parent's remainders 'pending'->'scheduled' and stamps
  -- followup_delivery_id = this delivery. Now that this delivery has completed, mark them
  -- 'fulfilled'. Any lines this follow-up ITSELF shorted are already captured as fresh
  -- 'pending' remainder rows by the v_any_partial INSERT above (original_delivery_id = this
  -- delivery), so this flip never loses outstanding quantity — it prevents the same shortfall
  -- being double-counted as both a stale 'scheduled' row and a new 'pending' row. Idempotent
  -- (guarded by status = 'scheduled'); targets rows disjoint from the ones just inserted.
  UPDATE delivery_remainders
     SET status = 'fulfilled', updated_at = now()
   WHERE followup_delivery_id = p_delivery_id
     AND status = 'scheduled';

  -- P2 fix (Codex 2026-07-10): serialize concurrent same-day FINAL deliveries on the SAME
  -- order. Two deliveries completing at once each read v_all_delivered under READ COMMITTED
  -- without seeing the other's uncommitted order_items decrement, so both could compute
  -- false and skip the Feature A auto-split (order falls back to manual split-billing — safe,
  -- but the auto-split silently doesn't fire). Take the orders row lock BEFORE the read: the
  -- second completion blocks here until the first commits, then sees the committed decrement.
  -- Lock ORDER is unchanged (deliveries -> inventory -> orders): the UPDATE orders just below
  -- already acquired this same row lock — this only moves the acquisition ahead of the read,
  -- adding no new lock pair (no new deadlock surface).
  IF v_delivery.order_id IS NOT NULL THEN
    PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = public._allocated_delivery_cents(
                           ii.order_item_id, di.quantity_delivered, ii.invoice_id)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id AND ii.invoice_id = v_linked_invoice.id AND ii.order_item_id = di.order_item_id;
      -- Overnight bug-hunt LOW (20260620): also recompute the stored header cost so
      -- a partial completion doesn't leave total_cost_cents sized to the full qty.
      -- cost_cents is PER-UNIT cents; line cost = cost_cents * quantity (no *100).
      UPDATE invoices SET
        total_amount_cents = (SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 #34: per-DELIVERY-aware guard (was per-ORDER). Block only if THIS delivery already
    -- has an active invoice, or an ORDER-LEVEL invoice (delivery_id IS NULL) already covers
    -- the whole order. An active invoice tied to a DIFFERENT delivery must NOT block this
    -- delivery — otherwise a follow-up delivery of shorted product is never billed.
    SELECT COUNT(*) INTO v_existing_active_invoice_count
    FROM invoices
    WHERE order_id = v_delivery.order_id
      AND status NOT IN ('voided', 'cancelled')
      AND invoice_type <> 'credit_memo'
      AND deleted_at IS NULL
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

    IF v_existing_active_invoice_count = 0 THEN
      -- U7 SAFE-SCOPE (#43): a field/acre-allocated order must NOT be mono-billed
      -- 100% to the primary customer (that dead-ends the landlord's payment). Skip the
      -- auto-draft, flag the order for a manual per-owner split-billing pass, and notify
      -- the office. Non-allocated orders keep the EXACT auto-draft in the ELSE below.
      IF EXISTS (
        SELECT 1 FROM order_item_field_allocations oifa
        JOIN order_items oi ON oi.id = oifa.order_item_id
        WHERE oi.order_id = v_delivery.order_id
      ) THEN
        -- Codex pre-ship HIGH fix: only auto-split when the delivery's EFFECTIVE date is TODAY.
        -- create_split_invoices_from_order stamps invoice_date = CURRENT_DATE and takes no date arg, so
        -- auto-splitting a BACKDATED completion (p_completed_at in a prior/closed period) would silently
        -- date the drafts today and shift AR aging/terms — while the mono-bill path (below) respects the
        -- backdate. A backdated allocated order falls through to flag+notify (the office creates the split
        -- manually, exactly as before Feature A); same-day completions (the common case) auto-split.
        IF v_all_delivered
           AND v_effective_completion_date = (now() AT TIME ZONE 'America/Chicago')::date THEN
          -- the whole order is now delivered TODAY -> auto-create the per-owner split DRAFTS via the proven engine.
          BEGIN
            -- Marks this automatic split so the split wrapper keeps the order's salesperson for a
            -- rep who completes another rep's delivery (20261014210000). Transaction-local; a failed
            -- split rolls it back with this block, and it is cleared right after a successful one.
            PERFORM set_config('crx.order_invoice_autosplit', v_delivery.order_id::text, true);
            PERFORM create_split_invoices_from_order(
              v_delivery.order_id, NULL, 'chemical_sale',
              COALESCE(p_idempotency_key, p_delivery_id::text) || ':autosplit'
            );
            PERFORM set_config('crx.order_invoice_autosplit', '', true);
            -- create_split_invoices_from_order creates draft invoices per owner, clears
            -- needs_split_billing, and writes its own activity_feed + financial_audit_log rows.
            -- Add ONE activity_feed row noting the auto-creation on this delivery completion.
            INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
            VALUES (
              'split_invoices_auto_created',
              'Delivery ' || v_delivery.delivery_number || ' completed the order — per-owner split DRAFT invoices were auto-created (review + post them).',
              v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
            );
          EXCEPTION WHEN OTHERS THEN
            -- Any reason the split cannot run yet (order not priced -> PRICING_INCOMPLETE, an
            -- edge race, a still-open sibling delivery, etc.): fall back to today's flag+notify.
            -- The subtransaction rolls back any partial split work; the delivery completion is UNAFFECTED.
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
        END;
      ELSE
        -- Partial delivery of an allocated order (product still remains): keep today's
        -- skip-and-queue exactly. (Per-delivery split billing for partial orders is a separate redesign.)
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
      END IF;
      ELSIF public._order_has_bill_split(v_delivery.order_id) THEN
        -- Billing plan M2: a Bill Split sale drafts one invoice per payer for this delivery. A failure here
        -- must not stop the driver completing the delivery: it rolls back only this block, and the office
        -- is told; Create Invoice on the delivery runs the same split again.
        BEGIN
          v_bill_split_ids := public._create_bill_split_delivery_invoices(p_delivery_id, v_effective_completion_date, v_actor);
          -- As Create Invoice does: the flag stays while another completed delivery is still unbilled.
          UPDATE orders SET needs_split_billing = false, updated_at = now()
           WHERE id = v_delivery.order_id AND needs_split_billing
             AND NOT EXISTS (
               SELECT 1 FROM deliveries d
                WHERE d.order_id = v_delivery.order_id AND d.id <> p_delivery_id
                  AND d.status = 'completed' AND d.deleted_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM invoices i
                     WHERE i.delivery_id = d.id AND i.status NOT IN ('voided', 'cancelled')
                       AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL));
        EXCEPTION WHEN OTHERS THEN
          v_bill_split_failed := true;
          INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
          VALUES ('bill_split_invoices_failed',
            'Delivery ' || v_delivery.delivery_number || ' completed, but its Bill Split invoices could not be drafted: ' || SQLERRM,
            v_actor, 'order', v_delivery.order_id, v_delivery.customer_id);
          FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
          LOOP
            INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
            VALUES (v_admin.id, 'Order needs split billing',
              'Delivery ' || v_delivery.delivery_number || ' completed, but its Bill Split invoices could not be drafted (' || SQLERRM || '). Use Create Invoice on the delivery.',
              'split_billing', 'order', v_delivery.order_id);
          END LOOP;
        END;
      ELSE
      v_auto_invoice_number := next_invoice_number('chemical_sale');
      INSERT INTO invoices (
        invoice_number, invoice_type, order_id, customer_id, delivery_id,
        status, invoice_date, total_amount_cents, total_cost_cents, created_by
      ) VALUES (
        v_auto_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
        'draft', v_effective_completion_date, 0, 0, v_actor
      ) RETURNING id INTO v_auto_invoice_id;

      v_auto_total_cents := 0;
      v_auto_cost_cents := 0;
      FOR v_item IN
        SELECT di.id AS di_id, di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id, di.tote_number,
               oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name,
               p.product_name AS p_name
          FROM delivery_items di
          JOIN order_items oi ON oi.id = di.order_item_id
          JOIN products p ON p.id = di.product_id
         WHERE di.delivery_id = p_delivery_id
           AND COALESCE(di.quantity_delivered, 0) > 0
      LOOP
        v_line_alloc_cents := public._allocated_delivery_cents(
                                v_item.order_item_id, v_item.quantity_delivered, NULL);
        v_auto_total_cents := v_auto_total_cents + v_line_alloc_cents;
        v_auto_cost_cents  := v_auto_cost_cents  + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
        INSERT INTO invoice_items (
          invoice_id, order_item_id, product_id, description,
          quantity, unit_price_cents, extended_cents, cost_cents,
          unit_size, tote_number
        ) VALUES (
          v_auto_invoice_id, v_item.order_item_id, v_item.product_id,
          COALESCE(v_item.oi_product_name, v_item.p_name),
          v_item.quantity_delivered,
          ROUND(v_item.price_per_unit * 100)::bigint,
          v_line_alloc_cents,
          ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint,
          v_item.unit_size,
          v_item.tote_number
        );
      END LOOP;

      UPDATE invoices
         SET total_amount_cents = v_auto_total_cents,
             total_cost_cents   = v_auto_cost_cents
       WHERE id = v_auto_invoice_id;

      -- Overnight bug-hunt MED (20260620): provenance breadcrumb. Write the same
      -- financial_audit_log 'invoice_created' row create_invoice_from_order /
      -- create_invoice_for_unbilled_delivery write, so the append-only ledger
      -- records this auto-creator too (it previously logged only activity_feed).
      -- Draft-stage provenance; post_invoice still writes 'invoice_posted' later.
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_auto_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', v_auto_invoice_number,
          'delivery_id', p_delivery_id,
          'order_id', v_delivery.order_id,
          'customer_id', v_delivery.customer_id,
          'total_cents', v_auto_total_cents
        ),
        v_auto_total_cents,
        'Invoice ' || v_auto_invoice_number || ' auto-created on completion of delivery ' || v_delivery.delivery_number
      );
      END IF;
    END IF;
  END IF;

  -- U9: short-stock WARN emit (mirrors the backdated-period warn+notify pattern above).
  IF v_short_count > 0 THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_short_stock',
      'WARNING: Delivery ' || v_delivery.delivery_number || ' completed with ' || v_short_count ||
        ' product(s) short on stock: ' || array_to_string(v_stock_warnings, ' | ') ||
        '. Completion proceeded; on-hand inventory went negative — review with the warehouse.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Short Stock — Delivery ' || v_delivery.delivery_number,
        'Delivery ' || v_delivery.delivery_number || ' was completed but ' || v_short_count ||
          ' product(s) did not have enough on-hand stock: ' || array_to_string(v_stock_warnings, ' | ') ||
          '. The completion proceeded and inventory went negative; please review.',
        'stock_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END ||
      CASE WHEN v_auto_invoice_id IS NOT NULL THEN ' [draft invoice ' || v_auto_invoice_number || ' auto-created]' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- U9: additive result fields — warnings[] + short_stock_count.
  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered,
    'auto_invoice', CASE
      WHEN v_auto_invoice_id IS NOT NULL THEN
        jsonb_build_object('invoice_id', v_auto_invoice_id, 'invoice_number', v_auto_invoice_number, 'total_cents', v_auto_total_cents)
      ELSE NULL
    END,
    'bill_split_failed', v_bill_split_failed,
    'bill_split_invoices', (SELECT jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'total_cents', i.total_amount_cents) ORDER BY i.invoice_number)
                              FROM invoices i WHERE i.id = ANY (v_bill_split_ids)),
    'stock_warning', (v_short_count > 0),
    'short_stock_count', v_short_count,
    'warnings', to_jsonb(v_stock_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_delivery_receipt_recipient(p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_assigned_driver uuid;
  v_customer_id uuid;
  v_status text;
  v_customer record;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  SELECT assigned_driver, customer_id, status INTO v_assigned_driver, v_customer_id, v_status
    FROM public.deliveries WHERE id = p_delivery_id AND deleted_at IS NULL;
  -- One message whether the delivery is missing or not the caller's. An active admin or sales rep
  -- gets any delivery's recipient: customers_select already lets both read every customer row
  -- (live 2026-10-22; reps work any customer, PRs #907/#913), so this adds nothing for them.
  IF v_customer_id IS NULL OR v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_assigned_driver IS NOT NULL AND v_actor = v_assigned_driver AND v_status IN ('scheduled', 'in_progress'))
  ) THEN
    RAISE EXCEPTION 'Not authorized to view this delivery';
  END IF;
  SELECT c.farm_name, c.contact_name, c.email INTO v_customer
    FROM public.customers c WHERE c.id = v_customer_id;
  RETURN jsonb_build_object(
    'farm_name', v_customer.farm_name,
    'contact_name', v_customer.contact_name,
    'email', NULLIF(btrim(COALESCE(v_customer.email, '')), '')
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.stage_offline_action(p_client_action_id uuid, p_operation text, p_entity_id uuid, p_schema_version integer, p_client_created_at timestamp with time zone, p_payload jsonb, p_idempotency_key text DEFAULT NULL::text, p_entity_snapshot_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_existing public.offline_action_receipts%ROWTYPE;
  v_canonical jsonb := '{}'::jsonb;
  v_quantities jsonb;
  v_canonical_quantities jsonb := '{}'::jsonb;
  v_field_acres jsonb := '[]'::jsonb;
  v_canonical_field_acres jsonb := '[]'::jsonb;
  v_seen_fields jsonb := '{}'::jsonb;
  v_key text;
  v_text text;
  v_value jsonb;
  v_uuid uuid;
  v_number numeric;
  v_timestamp timestamptz;
  v_assigned_driver uuid;
  v_job_applicator uuid;
  v_target_updated_at timestamptz;
  v_target_exists boolean := false;
  v_authorized boolean := false;
  v_initial_status text := 'received';
  v_failure_code text;
  v_failure_summary text;
  v_payload_requires_review boolean := false;
  v_payload_review_summary text;
  v_now timestamptz := now();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT p.role
    INTO v_actor_role
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: active profile required';
  END IF;

  IF p_client_action_id IS NULL OR p_entity_id IS NULL OR p_client_created_at IS NULL THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: action, entity, and client timestamp are required';
  END IF;
  IF p_client_created_at > v_now + interval '24 hours' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: client timestamp is too far in the future';
  END IF;
  IF p_schema_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'UNSUPPORTED_SCHEMA_VERSION';
  END IF;
  IF p_operation IS NULL
     OR p_operation NOT IN ('complete_delivery', 'complete_job') THEN
    RAISE EXCEPTION 'UNSUPPORTED_OPERATION';
  END IF;
  IF p_idempotency_key IS NULL
     OR btrim(p_idempotency_key) = ''
     OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: a bounded idempotency key is required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: payload must be a JSON object';
  END IF;
  IF pg_column_size(p_payload) > 65536 THEN
    RAISE EXCEPTION 'PAYLOAD_TOO_LARGE';
  END IF;

  IF p_operation = 'complete_delivery' THEN
    IF (p_payload - ARRAY['signed_by', 'quantities', 'issue_type', 'issue_notes', 'completed_at']) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: unsupported complete_delivery field';
    END IF;

    v_text := btrim(COALESCE(p_payload->>'signed_by', ''));
    IF v_text = '' OR length(v_text) > 200 THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: signed_by is required and limited to 200 characters';
    END IF;
    v_canonical := jsonb_build_object('signed_by', v_text);

    IF p_payload ? 'quantities' AND p_payload->'quantities' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'quantities') <> 'object' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: quantities must be an object';
      END IF;
      v_quantities := p_payload->'quantities';
      IF (SELECT count(*) FROM jsonb_object_keys(v_quantities)) > 500 THEN
        RAISE EXCEPTION 'PAYLOAD_TOO_LARGE: quantities exceeds 500 entries';
      END IF;

      FOR v_key, v_value IN SELECT key, value FROM jsonb_each(v_quantities)
      LOOP
        IF v_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity key must be a UUID';
        END IF;
        IF jsonb_typeof(v_value) NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity must be numeric';
        END IF;
        v_text := v_value #>> '{}';
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity must be a finite decimal';
        END IF;
        v_number := v_text::numeric;
        IF v_number < 0 THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity cannot be negative';
        END IF;
        v_uuid := v_key::uuid;
        v_canonical_quantities := v_canonical_quantities || jsonb_build_object(v_uuid::text, to_jsonb(v_number));
      END LOOP;
      v_canonical := v_canonical || jsonb_build_object('quantities', v_canonical_quantities);
    END IF;

    IF p_payload ? 'issue_type' AND p_payload->'issue_type' <> 'null'::jsonb THEN
      v_text := p_payload->>'issue_type';
      IF v_text NOT IN ('none', 'customer_not_home', 'gate_locked', 'road_blocked', 'wrong_address', 'refused', 'weather', 'other') THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: issue_type is not supported';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('issue_type', v_text);
    END IF;

    IF p_payload ? 'issue_notes' AND p_payload->'issue_notes' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'issue_notes') <> 'string' OR length(p_payload->>'issue_notes') > 2000 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: issue_notes must be text up to 2000 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('issue_notes', p_payload->>'issue_notes');
    END IF;

    IF p_payload ? 'completed_at' AND p_payload->'completed_at' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'completed_at') <> 'string' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: completed_at must be an ISO timestamp';
      END IF;
      BEGIN
        v_timestamp := (p_payload->>'completed_at')::timestamptz;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: completed_at must be an ISO timestamp';
      END;
      IF v_timestamp > v_now + interval '5 minutes' THEN
        v_payload_requires_review := true;
        v_payload_review_summary := 'The saved completion time is ahead of the server clock. Office review is required.';
      ELSIF v_timestamp < v_now - interval '14 days' THEN
        v_payload_requires_review := true;
        v_payload_review_summary := 'The saved completion time is more than 14 days old. Office review is required before posting into a prior period.';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('completed_at', to_jsonb(v_timestamp));
    END IF;

    SELECT d.assigned_driver, d.updated_at
      INTO v_assigned_driver, v_target_updated_at
      FROM public.deliveries d
     WHERE d.id = p_entity_id;
    v_target_exists := FOUND;
    v_authorized := v_target_exists AND (
      v_actor_role IN ('admin', 'sales_rep')
      OR (v_actor_role = 'driver' AND v_assigned_driver IS NOT NULL AND v_assigned_driver = v_actor)
    );

    IF v_target_exists AND v_quantities IS NOT NULL AND EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_quantities) q(item_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.delivery_items di
        WHERE di.id = q.item_id::uuid
          AND di.delivery_id = p_entity_id
      )
    ) THEN
      v_payload_requires_review := true;
      v_payload_review_summary := 'A saved delivery item no longer belongs to this delivery. Office review is required.';
    END IF;

  ELSE
    IF (p_payload - ARRAY[
      'actual_start_time', 'actual_end_time', 'wind_speed', 'wind_direction',
      'temperature', 'humidity', 'actual_gallons_applied', 'notes', 'field_acres'
    ]) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: unsupported complete_job field';
    END IF;

    FOREACH v_key IN ARRAY ARRAY['wind_speed', 'temperature', 'humidity', 'actual_gallons_applied']::text[]
    LOOP
      IF p_payload ? v_key AND p_payload->v_key <> 'null'::jsonb THEN
        IF jsonb_typeof(p_payload->v_key) NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be numeric', v_key;
        END IF;
        v_text := p_payload->>v_key;
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be a finite decimal', v_key;
        END IF;
        v_number := v_text::numeric;
        v_canonical := v_canonical || jsonb_build_object(v_key, to_jsonb(v_number));
      END IF;
    END LOOP;

    IF p_payload ? 'wind_direction' AND p_payload->'wind_direction' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'wind_direction') <> 'string' OR length(p_payload->>'wind_direction') > 64 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: wind_direction must be text up to 64 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('wind_direction', p_payload->>'wind_direction');
    END IF;

    IF p_payload ? 'notes' AND p_payload->'notes' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'notes') <> 'string' OR length(p_payload->>'notes') > 4000 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: notes must be text up to 4000 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('notes', p_payload->>'notes');
    END IF;

    FOREACH v_key IN ARRAY ARRAY['actual_start_time', 'actual_end_time']::text[]
    LOOP
      IF p_payload ? v_key AND p_payload->v_key <> 'null'::jsonb THEN
        IF jsonb_typeof(p_payload->v_key) <> 'string' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be an ISO timestamp', v_key;
        END IF;
        BEGIN
          v_timestamp := (p_payload->>v_key)::timestamptz;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be an ISO timestamp', v_key;
        END;
        v_canonical := v_canonical || jsonb_build_object(v_key, to_jsonb(v_timestamp));
      END IF;
    END LOOP;

    IF p_payload ? 'field_acres' AND p_payload->'field_acres' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'field_acres') <> 'array' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: field_acres must be an array';
      END IF;
      v_field_acres := p_payload->'field_acres';
      IF jsonb_array_length(v_field_acres) > 500 THEN
        RAISE EXCEPTION 'PAYLOAD_TOO_LARGE: field_acres exceeds 500 entries';
      END IF;

      FOR v_value IN SELECT value FROM jsonb_array_elements(v_field_acres)
      LOOP
        IF jsonb_typeof(v_value) <> 'object'
           OR (v_value - ARRAY['field_id', 'acres_applied']) <> '{}'::jsonb
           OR NOT (v_value ? 'field_id')
           OR NOT (v_value ? 'acres_applied') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: field_acres entry shape is invalid';
        END IF;
        v_text := v_value->>'field_id';
        IF v_text IS NULL OR v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: field_id must be a UUID';
        END IF;
        v_uuid := v_text::uuid;
        IF v_seen_fields ? v_uuid::text THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: duplicate field_id';
        END IF;
        v_seen_fields := v_seen_fields || jsonb_build_object(v_uuid::text, true);

        IF jsonb_typeof(v_value->'acres_applied') NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied must be numeric';
        END IF;
        v_text := v_value->>'acres_applied';
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied must be a finite decimal';
        END IF;
        v_number := v_text::numeric;
        IF v_number < 0 THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied cannot be negative';
        END IF;
        v_canonical_field_acres := v_canonical_field_acres || jsonb_build_array(
          jsonb_build_object('field_id', v_uuid, 'acres_applied', v_number)
        );
      END LOOP;

      SELECT COALESCE(jsonb_agg(e.value ORDER BY e.value->>'field_id'), '[]'::jsonb)
        INTO v_canonical_field_acres
        FROM jsonb_array_elements(v_canonical_field_acres) e(value);
      v_canonical := v_canonical || jsonb_build_object('field_acres', v_canonical_field_acres);
    END IF;

    SELECT j.applicator_id, j.updated_at
      INTO v_job_applicator, v_target_updated_at
      FROM public.jobs j
     WHERE j.id = p_entity_id;
    v_target_exists := FOUND;

    v_authorized := v_target_exists AND (
      public.is_admin()
      OR public.is_sales_rep()
      OR public._is_job_applicator(p_entity_id)  -- KI-73 part C: access ends when the job ends
      OR (
        public.is_applicator()
        AND public._is_dispatched_to_me(p_entity_id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.job_fields jf2
          WHERE jf2.job_id = p_entity_id
            AND NOT EXISTS (
              SELECT 1
              FROM public.job_location_dispatches d2
              WHERE d2.job_field_id = jf2.id
                AND d2.dispatch_status = 'dispatched'
                AND (
                  d2.applicator_id = v_actor
                  OR (
                    d2.crew_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                      WHERE gcm.crew_id = d2.crew_id
                        AND gcm.profile_id = v_actor
                        AND gcm.is_active
                        AND gc.is_active
                    )
                  )
                )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.job_location_dispatches d
          WHERE d.job_id = p_entity_id
            AND d.dispatch_status = 'dispatched'
            AND NOT (
              (d.applicator_id IS NOT NULL AND d.applicator_id = v_actor)
              OR (
                d.crew_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM public.ground_crew_members gcm
                  JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                  WHERE gcm.crew_id = d.crew_id
                    AND gcm.profile_id = v_actor
                    AND gcm.is_active
                    AND gc.is_active
                )
              )
            )
        )
      )
    );

    IF v_target_exists AND p_payload ? 'field_acres' AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_canonical_field_acres) e(value)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.job_fields jf
        WHERE jf.job_id = p_entity_id
          AND jf.field_id = (e.value->>'field_id')::uuid
      )
    ) THEN
      v_payload_requires_review := true;
      v_payload_review_summary := 'A saved field no longer belongs to this job. Office review is required.';
    END IF;
  END IF;

  IF NOT v_target_exists THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'TARGET_NOT_FOUND';
    v_failure_summary := 'The referenced delivery or job no longer exists.';
  ELSIF NOT v_authorized THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'NOT_AUTHORIZED';
    v_failure_summary := 'The current user is no longer authorized to complete this delivery or job.';
  ELSIF p_entity_snapshot_at IS NULL THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'LEGACY_OUTCOME_UNKNOWN';
    v_failure_summary := 'This saved action does not include a target snapshot. Office review is required before it can run.';
  ELSIF p_entity_snapshot_at IS NOT NULL
        AND v_target_updated_at IS DISTINCT FROM p_entity_snapshot_at THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'TARGET_STATE_CONFLICT';
    v_failure_summary := 'The delivery or job changed after this action was saved offline. Office review is required.';
  ELSIF v_payload_requires_review THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'PAYLOAD_INVALID';
    v_failure_summary := v_payload_review_summary;
  END IF;

  INSERT INTO public.offline_action_receipts (
    client_action_id, actor_id, operation, entity_id, schema_version,
    client_created_at, entity_snapshot_at, request_payload, idempotency_key,
    status, failure_code, failure_summary, needs_review_at
  ) VALUES (
    p_client_action_id, v_actor, p_operation, p_entity_id, p_schema_version,
    p_client_created_at, p_entity_snapshot_at, v_canonical, p_idempotency_key,
    v_initial_status, v_failure_code, v_failure_summary,
    CASE WHEN v_initial_status = 'needs_review' THEN v_now ELSE NULL END
  )
  ON CONFLICT DO NOTHING;

  SELECT *
    INTO v_existing
    FROM public.offline_action_receipts r
   WHERE r.client_action_id = p_client_action_id;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.offline_action_receipts r
      WHERE r.idempotency_key = p_idempotency_key
    ) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
    END IF;
    RAISE EXCEPTION 'OFFLINE_STAGE_CONFLICT';
  END IF;

  IF v_existing.actor_id IS DISTINCT FROM v_actor
     OR v_existing.operation IS DISTINCT FROM p_operation
     OR v_existing.entity_id IS DISTINCT FROM p_entity_id
     OR v_existing.schema_version IS DISTINCT FROM p_schema_version
     OR v_existing.client_created_at IS DISTINCT FROM p_client_created_at
     OR v_existing.entity_snapshot_at IS DISTINCT FROM p_entity_snapshot_at
     OR v_existing.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR v_existing.request_payload IS DISTINCT FROM v_canonical THEN
    RAISE EXCEPTION 'OFFLINE_ACTION_ID_REUSE';
  END IF;

  RETURN jsonb_build_object(
    'client_action_id', v_existing.client_action_id,
    'operation', v_existing.operation,
    'entity_id', v_existing.entity_id,
    'status', v_existing.status,
    'result', v_existing.result,
    'failure_code', v_existing.failure_code,
    'failure_summary', v_existing.failure_summary,
    'attempt_count', v_existing.attempt_count,
    'client_created_at', v_existing.client_created_at,
    'received_at', v_existing.received_at,
    'updated_at', v_existing.updated_at
  );
END;
$function$;

DO $postflight$
DECLARE
  v_oid oid;
  v_want text[];
BEGIN
  v_oid := to_regprocedure('public._complete_delivery_evidence_impl_20270104(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone,text,text,boolean)');
  v_want := ARRAY['owner']::text[];
  IF v_oid IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'f9b6768cd4da053c5263408cc8594f7d'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT array_agg(g.who ORDER BY g.who) FROM (
           SELECT DISTINCT CASE WHEN a.grantee = p.proowner THEN 'owner' WHEN a.grantee = 0 THEN 'PUBLIC'
                                ELSE a.grantee::regrole::text END AS who
             FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE') g) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'DRIVER_CHECK_POSTFLIGHT: _complete_delivery_evidence_impl_20270104 body, security, search_path or grants are not as reviewed';
  END IF;
  v_oid := to_regprocedure('public._start_and_complete_delivery_impl_20270104(uuid,text,date,uuid,jsonb,text,text,text,text,text)');
  v_want := ARRAY['owner']::text[];
  IF v_oid IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'a677c3ee4557187d364f09dd94230527'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT array_agg(g.who ORDER BY g.who) FROM (
           SELECT DISTINCT CASE WHEN a.grantee = p.proowner THEN 'owner' WHEN a.grantee = 0 THEN 'PUBLIC'
                                ELSE a.grantee::regrole::text END AS who
             FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE') g) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'DRIVER_CHECK_POSTFLIGHT: _start_and_complete_delivery_impl_20270104 body, security, search_path or grants are not as reviewed';
  END IF;
  v_oid := to_regprocedure('public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)');
  v_want := ARRAY['owner']::text[];
  IF v_oid IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'f5e91dc9fe2a7341c926d1fada2f5f99'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT array_agg(g.who ORDER BY g.who) FROM (
           SELECT DISTINCT CASE WHEN a.grantee = p.proowner THEN 'owner' WHEN a.grantee = 0 THEN 'PUBLIC'
                                ELSE a.grantee::regrole::text END AS who
             FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE') g) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'DRIVER_CHECK_POSTFLIGHT: _complete_delivery_aggregate_impl body, security, search_path or grants are not as reviewed';
  END IF;
  v_oid := to_regprocedure('public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)');
  v_want := ARRAY['owner']::text[];
  IF v_oid IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'f7eb9e84cf9959a0299e8c80a1088917'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT array_agg(g.who ORDER BY g.who) FROM (
           SELECT DISTINCT CASE WHEN a.grantee = p.proowner THEN 'owner' WHEN a.grantee = 0 THEN 'PUBLIC'
                                ELSE a.grantee::regrole::text END AS who
             FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE') g) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'DRIVER_CHECK_POSTFLIGHT: _complete_delivery_period_preflight_impl body, security, search_path or grants are not as reviewed';
  END IF;
  v_oid := to_regprocedure('public._complete_delivery_replay_impl_20261015(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)');
  v_want := ARRAY['owner']::text[];
  IF v_oid IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'bca719c366f0e870d29d273439115e0f'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT array_agg(g.who ORDER BY g.who) FROM (
           SELECT DISTINCT CASE WHEN a.grantee = p.proowner THEN 'owner' WHEN a.grantee = 0 THEN 'PUBLIC'
                                ELSE a.grantee::regrole::text END AS who
             FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE') g) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'DRIVER_CHECK_POSTFLIGHT: _complete_delivery_replay_impl_20261015 body, security, search_path or grants are not as reviewed';
  END IF;
  v_oid := to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)');
  v_want := ARRAY['owner']::text[];
  IF v_oid IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'bbe9c44f7ade7d12f86bfe1c039d16ac'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT array_agg(g.who ORDER BY g.who) FROM (
           SELECT DISTINCT CASE WHEN a.grantee = p.proowner THEN 'owner' WHEN a.grantee = 0 THEN 'PUBLIC'
                                ELSE a.grantee::regrole::text END AS who
             FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE') g) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'DRIVER_CHECK_POSTFLIGHT: _complete_delivery_authorized_impl_20270122 body, security, search_path or grants are not as reviewed';
  END IF;
  v_oid := to_regprocedure('public.get_delivery_receipt_recipient(uuid)');
  v_want := ARRAY['authenticated', 'owner']::text[];
  IF v_oid IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM '28992ce9ae749d9f27a092c73aa52315'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT array_agg(g.who ORDER BY g.who) FROM (
           SELECT DISTINCT CASE WHEN a.grantee = p.proowner THEN 'owner' WHEN a.grantee = 0 THEN 'PUBLIC'
                                ELSE a.grantee::regrole::text END AS who
             FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE') g) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'DRIVER_CHECK_POSTFLIGHT: get_delivery_receipt_recipient body, security, search_path or grants are not as reviewed';
  END IF;
  v_oid := to_regprocedure('public.stage_offline_action(uuid,text,uuid,integer,timestamp with time zone,jsonb,text,timestamp with time zone)');
  v_want := ARRAY['authenticated', 'owner', 'service_role']::text[];
  IF v_oid IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'c7fa56e9569fb03b41f7610160ea8815'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT array_agg(g.who ORDER BY g.who) FROM (
           SELECT DISTINCT CASE WHEN a.grantee = p.proowner THEN 'owner' WHEN a.grantee = 0 THEN 'PUBLIC'
                                ELSE a.grantee::regrole::text END AS who
             FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE') g) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'DRIVER_CHECK_POSTFLIGHT: stage_offline_action body, security, search_path or grants are not as reviewed';
  END IF;
END;
$postflight$;
