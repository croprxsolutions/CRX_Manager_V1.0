-- Written 2026-10-21. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: Goal 5 follow-up (docs/plans/2026-10-13-direction-and-goals.md, Goal 5 "Still open" (2); Sol's
--   final review on PR #955). A completed delivery must carry server-checked proof of how the customer
--   confirmed it, and record exactly which proof was accepted:
--     signature     the customer signed on screen. The phone uploads the image BEFORE completing, to a
--                   per-attempt path the server recomputes from the call's own retry key:
--                   signatures/<delivery id>/<first 32 hex of sha256(p_idempotency_key)>.png, uploaded
--                   by the caller (storage.objects.owner_id = auth.uid()). No storage policy lets that
--                   path be overwritten or deleted, so the accepted image cannot change afterwards.
--     paper_ticket  the customer signed a paper ticket (no signal at the site, Mason 2026-10-15): the
--                   delivery_photos row the screen shows as saved, captioned 'Signed paper delivery
--                   ticket', for this delivery, its file in delivery-photos/<delivery id>/;
--     left_at_site  no one was present (the field stop's "No one present — left at site"): a photo
--                   captioned 'Left at site — drop location', the same way, and that signer text.
--   Until now complete_delivery and start_and_complete_delivery required none of this: the signature
--   image was uploaded by the phone AFTER the completion (skipped if that failed), and nothing
--   recorded that a paper ticket was used.
--
--   1. deliveries.completion_evidence (NULL on every existing row; CHECK signature | paper_ticket |
--      left_at_site) and deliveries.completion_evidence_ref (the signature path or the photo row id).
--   2. Trigger require_delivery_completion_evidence (BEFORE INSERT OR UPDATE ON deliveries): a row may
--      become 'completed', be inserted as 'completed', have either evidence column written, or (once
--      completed) have signed_by or signature_url changed, ONLY while the transaction-local marker
--      crx.delivery_completion_evidence names that row. Only complete_delivery sets it, after checking
--      the evidence, and clears it right after the completion. There is no app.admin_override
--      exemption: the completion body sets that override with SET LOCAL and never clears it, so it
--      would otherwise excuse every later statement in the same transaction. This also closes the
--      direct-table route (an admin or sales rep could INSERT a delivery as 'completed', or UPDATE
--      in_progress -> completed, without complete_delivery). Read live 2026-10-21: the completion body
--      is the only writer of status 'completed', signed_by and signature_url. Clients reach the
--      database only through PostgREST, which cannot set a configuration parameter, so they cannot
--      forge the marker (crx.order_invoice_autosplit relies on the same boundary).
--   3. complete_delivery: the bound wrapper from 20261019200000 is DROPPED and re-created with two
--      trailing arguments, p_evidence text DEFAULT NULL and p_evidence_ref text DEFAULT NULL. Order:
--      key required; AUTH_REQUIRED; ACTOR_MISMATCH; lock the delivery and run the body's authorization
--      test (same message; now BEFORE the receipt lookup, as start_and_complete_delivery already does,
--      so a reassigned or deactivated actor gets no replay);
--        * p_evidence NULL = LEGACY REPLAY ONLY: the 20261019200000 fingerprint, unchanged, through
--          check_idempotency_intent; a committed receipt replays through the body as before (an app
--          from before this change, retrying a completion whose reply was lost); anything else is
--          refused with COMPLETION_EVIDENCE_REQUIRED (22023). A NULL-evidence call never completes;
--        * otherwise the value and reference are validated, both join the fingerprint, an exact
--          retry replays, and a fresh call requires status in_progress (the body's message) BEFORE the
--          evidence checks (SIGNATURE_IMAGE_MISSING, PAPER_TICKET_PHOTO_MISSING,
--          LEFT_AT_SITE_PHOTO_MISSING, LEFT_AT_SITE_SIGNER_MISMATCH, 23514); then the marker is set, the
--          unchanged renamed body runs, completion_evidence/_ref (and signature_url) are recorded, the
--          marker is cleared and the receipt bound. A refusal anywhere rolls the whole call back.
--   4. start_and_complete_delivery (Deliveries list): DROPPED and re-created with the same two
--      trailing arguments; the same legacy-replay rule for NULL evidence (its 20261019220000
--      fingerprint, after its own authorization); the new fields join the fingerprint and pass to
--      complete_delivery under '<key>:complete' (so the list's signature path hashes that string).
--   5. delivery-signatures storage: two NEW policies for the per-attempt pattern only — INSERT while
--      the delivery is scheduled or in_progress, SELECT for display — for the same people as the
--      existing policies (active admin, active sales rep, or the delivery's active assigned driver).
--      The four existing fixed-path policies (signatures/<id>.png) are UNCHANGED, and none of them
--      can match the new pattern, so nothing can update or delete an accepted image through the API.
--   6. get_delivery_receipt_recipient(p_delivery_id) (read-only, STABLE): the customer's name and
--      receipt email, for an active admin or sales rep, or for the delivery's active assigned driver
--      while it is scheduled or in progress (the screens read it before completing). One refusal
--      message for "no such delivery" and "not yours". Fixes KNOWN_ISSUES "a driver's completion
--      receipt can be skipped when the customer row is hidden from them".
--
-- WHAT DOES NOT CHANGE: no money, stock or invoice logic (the renamed body and the private chain
--   under it are untouched and stay postgres-only, pinned below); no existing row or storage policy is
--   rewritten; process_offline_action is unchanged. A completion queued offline before Goal 5
--   (2026-10-19) carries no evidence, so it is refused and goes to Offline Work Review (needs_review,
--   nothing committed) unless it is the exact retry of one that already committed.
--
-- ACCESS: adds a storage INSERT and SELECT policy (same people, new path pattern) and one read RPC for
--   authenticated. Applies only on Mason's owner approval (scripts/owner-approve-migration.mjs).
--
-- ROLLOUT: an app from before this change cannot complete a delivery once this is applied (it sends no
--   evidence). Apply and deploy together, outside delivery hours; drivers reload the app.
--
-- ROLLBACK (its own reviewed migration): DROP the two new storage policies, the trigger and its
--   function, get_delivery_receipt_recipient, and the two new wrappers; re-create the wrappers from
--   20261019200000 and 20261019220000 with their grants. The columns may stay. Roll the app back first.
--
-- ORDERING: live effective high-water when written 2026-10-21: 20261021070000 (row 961). Numbered
--   above every open candidate (20261021120000 #1006, 20261021140000/141000 #980, 20261021150000
--   #1010), none of which touches these functions, the deliveries table or these policies. Re-read the
--   live ledger before applying.
--
-- idempotency-body-check: exempt. Both wrappers read idempotency_keys through check_idempotency_intent
--   with their own operation literal and write through save_idempotency (body) /
--   _bind_replay_receipt_20261015; get_delivery_receipt_recipient reads only and takes no key.
--
-- caller-analysis: complete_delivery :: src/pages/DeliveryDetail.tsx and src/pages/FieldStop.tsx call it with a key, p_evidence and p_evidence_ref; start_and_complete_delivery calls it by position; process_offline_action calls it by name without p_evidence and gets only a legacy replay or a refusal (needs_review); the new wrapper keeps EXECUTE for authenticated and service_role, as live
-- caller-analysis: start_and_complete_delivery :: src/pages/Deliveries.tsx calls it with a key, p_evidence and p_evidence_ref; no SQL caller; the new function keeps EXECUTE for authenticated only, as live

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE delivery_completion_evidence_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- The four existing delivery-signatures policies as found, compared again by the postflight.
CREATE TEMP TABLE delivery_completion_evidence_policies ON COMMIT DROP AS
SELECT policyname, md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')) AS def_md5
  FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
   AND policyname IN ('delivery_signatures_scoped_select', 'delivery_signatures_scoped_insert',
                      'delivery_signatures_scoped_update', 'delivery_signatures_scoped_delete');

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  IF to_regclass('pg_temp.delivery_completion_evidence_tx') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_COMPLETION_EVIDENCE_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.delivery_completion_evidence_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_COMPLETION_EVIDENCE_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The two wrappers this file replaces and the body they call, exactly as read live on 2026-10-21
  -- (md5 ignores carriage returns; both wrappers equal their checked-in sources), one overload each.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM (VALUES
      ('complete_delivery', 'p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone', 'e3a9e955805ba0c0a2a765864219482c'),
      ('start_and_complete_delivery', 'p_delivery_id uuid, p_signed_by text, p_delivered_on date, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', '515437a46ff8abfbcb3a3134b9460fb4'),
      ('_complete_delivery_replay_impl_20261015', 'p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone', 'a1e9a043f27d3566f8ecf6d5e3a809ab')
    ) AS pin(name, args, body_md5)
   WHERE (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = pin.name
           AND p.proowner = 'postgres'::regrole AND p.prosecdef
           AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
           AND pg_get_function_arguments(p.oid) = pin.args
           AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_COMPLETION_EVIDENCE_DRIFT: expected the exact reviewed live definition for: %', v_drift;
  END IF;

  SELECT string_agg(sig, ', ') INTO v_drift
    FROM unnest(ARRAY[
      'public.confirm_delivery(uuid,uuid,text)',
      'public.check_idempotency_intent(text,text,uuid,text)',
      'public.save_idempotency(text,text,jsonb)',
      'public._bind_replay_receipt_20261015(text,text,text)',
      'public._replay_fingerprint_20261015(jsonb)'
    ]) AS sig
   WHERE to_regprocedure(sig) IS NULL;
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_COMPLETION_EVIDENCE_DEPENDENCY_MISSING: %', v_drift;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'deliveries'
                AND column_name IN ('completion_evidence', 'completion_evidence_ref'))
     OR to_regprocedure('public.get_delivery_receipt_recipient(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.deliveries'::regclass
                 AND tgname = 'require_delivery_completion_evidence') THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_COMPLETION_EVIDENCE_ALREADY_APPLIED';
  END IF;

  -- Exactly the four known policies touch the delivery-signatures bucket, and they still allow writes
  -- only to the fixed path of a COMPLETED delivery (so none can match the new per-attempt pattern).
  IF (SELECT count(*) FROM pg_temp.delivery_completion_evidence_policies) <> 4
     OR (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects'
            AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%delivery-signatures%') <> 4
     OR EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'storage' AND tablename = 'objects'
                   AND policyname IN ('delivery_signatures_scoped_select', 'delivery_signatures_scoped_insert',
                                      'delivery_signatures_scoped_update', 'delivery_signatures_scoped_delete')
                   AND position('''signatures/''::text || (d.id)::text) || ''.png''::text' IN coalesce(qual, '') || coalesce(with_check, '')) = 0) THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_SIGNATURE_POLICY_DRIFT';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. The recorded path and the exact artifact accepted.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.deliveries
  ADD COLUMN completion_evidence text
  CONSTRAINT deliveries_completion_evidence_check
  CHECK (completion_evidence IN ('signature', 'paper_ticket', 'left_at_site'));
ALTER TABLE public.deliveries ADD COLUMN completion_evidence_ref text;

COMMENT ON COLUMN public.deliveries.completion_evidence IS
  'How the customer confirmed the completion, checked by complete_delivery before it ran: signature, paper_ticket or left_at_site. NULL on deliveries completed before 20261022010000.';
COMMENT ON COLUMN public.deliveries.completion_evidence_ref IS
  'The artifact complete_delivery accepted: the signature object path (signatures/<id>/<hash>.png), or the delivery_photos id of the ticket or drop-location photo.';

-- ---------------------------------------------------------------------------------------------
-- 2. Only an evidence-checked completion may complete a delivery or write its proof.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public._require_delivery_completion_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF COALESCE(current_setting('crx.delivery_completion_evidence', true), '') = NEW.id::text THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'completed'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_REQUIRED: a delivery is completed only through complete_delivery with its evidence'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.completion_evidence IS NOT NULL OR NEW.completion_evidence_ref IS NOT NULL THEN
      RAISE EXCEPTION 'COMPLETION_EVIDENCE_LOCKED: completion evidence is recorded only by complete_delivery'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.completion_evidence IS DISTINCT FROM OLD.completion_evidence
     OR NEW.completion_evidence_ref IS DISTINCT FROM OLD.completion_evidence_ref
     OR (OLD.status = 'completed'
         AND (NEW.signed_by IS DISTINCT FROM OLD.signed_by OR NEW.signature_url IS DISTINCT FROM OLD.signature_url)) THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_LOCKED: completion evidence is recorded only by complete_delivery'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._require_delivery_completion_evidence() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._require_delivery_completion_evidence() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER require_delivery_completion_evidence
  BEFORE INSERT OR UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public._require_delivery_completion_evidence();

-- ---------------------------------------------------------------------------------------------
-- 3. complete_delivery (also called by name from process_offline_action, with the offline key).
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz);

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
  p_evidence_ref text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_assigned_driver)
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

  IF p_evidence NOT IN ('signature', 'paper_ticket', 'left_at_site') THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_INVALID: %', p_evidence USING ERRCODE = '22023';
  END IF;
  IF p_evidence_ref IS NULL OR btrim(p_evidence_ref) = '' THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_INVALID: % needs its evidence reference', p_evidence USING ERRCODE = '22023';
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
  ));
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
                         AND o.owner_id = v_actor::text) THEN
      RAISE EXCEPTION 'SIGNATURE_IMAGE_MISSING: no signature image saved for this attempt' USING ERRCODE = '23514';
    END IF;
  ELSE
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
    -- The exact photo the screen showed: this delivery's, with the caption, its file in this
    -- delivery's own folder and stored.
    IF v_photo_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.delivery_photos dp
           JOIN storage.objects o ON o.bucket_id = 'delivery-photos' AND o.name = dp.storage_path
          WHERE dp.id = v_photo_id
            AND dp.delivery_id = p_delivery_id
            AND dp.caption = v_caption
            AND split_part(dp.storage_path, '/', 1) = 'delivery-photos'
            AND split_part(dp.storage_path, '/', 2) = p_delivery_id::text) THEN
      IF p_evidence = 'paper_ticket' THEN
        RAISE EXCEPTION 'PAPER_TICKET_PHOTO_MISSING: no saved photo of the signed paper ticket for this delivery' USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION 'LEFT_AT_SITE_PHOTO_MISSING: no saved photo of where the delivery was left' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Lets require_delivery_completion_evidence accept this delivery's completion, and only until the
  -- evidence is recorded (a refusal rolls the setting back with everything else).
  PERFORM set_config('crx.delivery_completion_evidence', p_delivery_id::text, true);
  v_result := public._complete_delivery_replay_impl_20261015(p_delivery_id, p_signed_by, p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at);
  UPDATE public.deliveries
     SET completion_evidence = p_evidence,
         completion_evidence_ref = p_evidence_ref,
         signature_url = CASE WHEN p_evidence = 'signature' THEN p_evidence_ref ELSE signature_url END
   WHERE id = p_delivery_id AND status = 'completed';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('crx.delivery_completion_evidence', '', true);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'COMPLETION_EVIDENCE_NOT_RECORDED: the delivery did not end completed';
  END IF;
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'complete_delivery', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text) IS
  'Completes a delivery with server-checked evidence (p_evidence + p_evidence_ref; 20261022010000). Key required and bound to caller + request; a NULL p_evidence only replays a completion committed before 20261022010000.';

-- ---------------------------------------------------------------------------------------------
-- 4. start_and_complete_delivery (Deliveries list): the 20261019220000 body plus the evidence.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text);

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
  p_evidence_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  IF p_evidence IS NOT NULL AND p_evidence NOT IN ('signature', 'paper_ticket', 'left_at_site') THEN
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
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
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
    PERFORM public.confirm_delivery(p_delivery_id, v_actor, NULL);
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
ALTER FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text) IS
  'Deliveries list Mark Delivered: starts a scheduled delivery (confirm_delivery) and completes it (complete_delivery, with its evidence under <key>:complete) in one transaction, on the chosen America/Chicago business date. Key required and bound to caller + request; a NULL p_evidence only replays a completion committed before 20261022010000.';

-- ---------------------------------------------------------------------------------------------
-- 5. Per-attempt signature images: written while the delivery is open, never updated or deleted.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY "delivery_signatures_attempt_insert"
ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'delivery-signatures'
  AND name ~ '^signatures/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}\.png$'
  AND EXISTS (
    SELECT 1
    FROM public.deliveries d
    WHERE d.id::text = split_part(name, '/', 2)
      AND d.status IN ('scheduled', 'in_progress')
      AND (
        public.is_admin()
        OR public.is_sales_rep()
        OR (
          EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid())
              AND p.role = 'driver'
              AND p.is_active = true
          )
          AND d.assigned_driver = (SELECT auth.uid())
        )
      )
  )
);

CREATE POLICY "delivery_signatures_attempt_select"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'delivery-signatures'
  AND name ~ '^signatures/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}\.png$'
  AND EXISTS (
    SELECT 1
    FROM public.deliveries d
    WHERE d.id::text = split_part(name, '/', 2)
      AND (
        public.is_admin()
        OR public.is_sales_rep()
        OR (
          EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid())
              AND p.role = 'driver'
              AND p.is_active = true
          )
          AND d.assigned_driver = (SELECT auth.uid())
        )
      )
  )
);

-- ---------------------------------------------------------------------------------------------
-- 6. The receipt recipient, for whoever may complete the delivery while it is open.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.get_delivery_receipt_recipient(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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
    FROM public.deliveries WHERE id = p_delivery_id;
  -- One message whether the delivery is missing or not the caller's.
  IF v_customer_id IS NULL OR v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_assigned_driver AND v_status IN ('scheduled', 'in_progress'))
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
ALTER FUNCTION public.get_delivery_receipt_recipient(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_delivery_receipt_recipient(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_delivery_receipt_recipient(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_delivery_receipt_recipient(uuid) IS
  'Read-only: the customer name and receipt email of one delivery, for an active admin or sales rep, or its active assigned driver while it is scheduled or in progress (the driver may not see the customer row itself).';

-- ---------------------------------------------------------------------------------------------
-- POSTFLIGHT
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_drift text;
BEGIN
  SELECT string_agg(pin.sig, ', ' ORDER BY pin.sig) INTO v_drift
    FROM (VALUES
      ('complete_delivery', 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text)', ARRAY['authenticated', 'postgres', 'service_role']::text[], true),
      ('start_and_complete_delivery', 'public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text)', ARRAY['authenticated', 'postgres']::text[], true),
      ('get_delivery_receipt_recipient', 'public.get_delivery_receipt_recipient(uuid)', ARRAY['authenticated', 'postgres']::text[], true),
      ('_require_delivery_completion_evidence', 'public._require_delivery_completion_evidence()', ARRAY['postgres']::text[], false),
      -- The private completion chain stays callable by postgres alone: the wrapper is the only way in.
      ('_complete_delivery_replay_impl_20261015', 'public._complete_delivery_replay_impl_20261015(uuid,text,uuid,jsonb,text,text,text,timestamptz)', ARRAY['postgres']::text[], true),
      ('_complete_delivery_period_preflight_impl', 'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)', ARRAY['postgres']::text[], true),
      ('_complete_delivery_aggregate_impl', NULL, ARRAY['postgres']::text[], true),
      ('_complete_delivery_authorized_impl', 'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)', ARRAY['postgres']::text[], true)
    ) AS pin(name, sig, acl, secdef)
   WHERE (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
      OR (pin.sig IS NOT NULL AND to_regprocedure(pin.sig) IS NULL)
      OR EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = pin.name
           AND (ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                        FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
                  IS DISTINCT FROM pin.acl
                OR p.proowner <> 'postgres'::regrole
                OR p.prosecdef IS DISTINCT FROM pin.secdef
                OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]));
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_COMPLETION_EVIDENCE_FUNCTION: %', v_drift;
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._complete_delivery_replay_impl_20261015(uuid,text,uuid,jsonb,text,text,text,timestamptz)'::regprocedure), chr(13), ''))
       IS DISTINCT FROM 'a1e9a043f27d3566f8ecf6d5e3a809ab' THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_COMPLETION_EVIDENCE_BODY_CHANGED';
  END IF;
  -- BEFORE (2) + ROW (1) + INSERT (4) + UPDATE (16) = 23, enabled, calling the guard function.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.deliveries'::regclass AND tgname = 'require_delivery_completion_evidence'
                    AND tgenabled = 'O' AND tgtype = 23
                    AND tgfoid = 'public._require_delivery_completion_evidence()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_COMPLETION_EVIDENCE_TRIGGER';
  END IF;
  -- The four existing policies are byte-for-byte as found; exactly six policies touch the bucket.
  IF EXISTS (SELECT 1 FROM pg_temp.delivery_completion_evidence_policies f
              WHERE f.def_md5 IS DISTINCT FROM (
                SELECT md5(p.cmd || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))
                  FROM pg_policies p
                 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = f.policyname))
     OR (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects'
            AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%delivery-signatures%') <> 6
     OR (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects'
            AND policyname IN ('delivery_signatures_attempt_insert', 'delivery_signatures_attempt_select'))
        IS DISTINCT FROM 'delivery_signatures_attempt_insert:INSERT,delivery_signatures_attempt_select:SELECT' THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_SIGNATURE_POLICY';
  END IF;
END;
$postflight$;
