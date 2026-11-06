-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261112120000_delivery_receipt_queue.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-25): a customer receipt owed after a delivery completion is recorded in the database, in the same
--   transaction as the completion, so a phone that loses signal can no longer lose it. A server worker
--   (Edge Function send-delivery-receipts, shipped separately) sends each owed receipt and reports the result.
--   1. New table delivery_receipt_queue: one row per delivery (unique delivery_id), holding the receipt's content
--      as it was at completion (delivery number, Central business date, signer, partial, delivered lines, contact
--      name), a status and a retry count. RLS on; active admins and sales reps may read it; no API role may write it.
--   2. complete_delivery gains a trailing p_email_receipt boolean DEFAULT NULL. TRUE (with any proof other than
--      no_proof) records the receipt after the evidence is recorded, in the same transaction: pending, or needs_check
--      when the customer has no email on file by then or the sender is not switched on (its two Vault secrets
--      missing). A delivery completed again after its receipt was cancelled gets its receipt back (pending).
--      NULL and FALSE are today's behaviour exactly: the request fingerprint carries the new value only when it
--      is TRUE, so a completion committed before this file still replays with its saved fingerprint. A replay
--      never records a receipt (the first commit did); a NULL-evidence (pre-20261022075000) replay ignores
--      p_email_receipt. start_and_complete_delivery and process_offline_action call complete_delivery without it
--      (NULL) and are not changed.
--   3. The worker's three calls (service_role only), in order for each receipt:
--      claim_delivery_receipts: claims due rows with a fresh claim token (FOR UPDATE SKIP LOCKED, 10-minute lease).
--        Before claiming, a row is settled without sending when the delivery is no longer completed (cancelled if
--        no send was ever authorized, else needs_check), it now belongs to another customer, the customer has no
--        email now, five attempts are used, more than 23 hours have passed since the first authorized send (the
--        provider's duplicate guard lasts 24), or a retry after an authorized send would go to a changed address
--        (all needs_check). A retry after an authorized send keeps that send's exact address string.
--      confirm_delivery_receipt_send: called immediately before each external send; the worker sends only on
--        'send'. It re-checks, under locks that wait for an in-flight edit of the delivery or customer: the claim
--        is still held and inside its lease ('stale' otherwise, nothing changes); the delivery is still completed
--        and this customer's; the customer's email is still the claimed address; the 23 hours have not passed.
--        On 'send' it records the authorization and renews the lease.
--      finish_delivery_receipt: reports sent / retry / check against the token. Backoff 2, 4, 8, 16 minutes;
--        after five attempts needs_check. A sent finish whose delivery, customer or email changed while sending
--        is kept as needs_check with the send recorded.
--      claim and finish take p_idempotency_key (a retried claim returns the claims it still holds, a retried
--      finish its first answer); a confirm key is bound to its receipt and claim and always re-checks.
--      The sender must give every attempt for one receipt the same provider idempotency key
--      ('delivery-receipt/<queue id>') and the same request body, so a send whose finish was lost, or an
--      overlapping stale worker, is answered by the provider instead of emailing the customer twice.
--   3c. _delivery_receipt_keep_owed (trigger on delivery_receipt_queue): an owed receipt, or one on the office list
--      (needs_check), cannot be deleted, so a hard delete of its delivery is refused instead of erasing it.
--   4. pg_net is enabled and a pg_cron job (every 2 minutes) runs _wake_delivery_receipt_worker(), which posts to
--      the worker only when a row is due AND both Vault secrets delivery_receipt_worker_url and
--      delivery_receipt_worker_secret exist. Neither is created here: until they are stored (a separate approved
--      step) the job does nothing.
--      pg_net boundary: Supabase's issue_pg_net_access trigger grants PUBLIC on net.http_request_queue /
--      net._http_response and EXECUTE on net.http_* to anon/authenticated; postgres cannot revoke those (owned by
--      supabase_admin). They are unreachable from the app because PostgREST exposes only public and graphql_public
--      (live, 2026-11-05: PGRST106 for net and extensions). Never add net or extensions to the exposed schemas.
--      The wake secret is a dedicated wake-only value (never the service_role key): a wake is only a hint, the
--      worker's calls stay service_role-only, and its reply carries no customer data.
--
-- ACCEPTED LIMITS (Mason, 2026-11-05: a duplicate receipt is preferred to a lost one): nothing stops the office's
--   own Email Confirmation and the worker both sending a receipt for one delivery; an edit committed between a
--   'send' and the provider call is caught only by finish (needs_check, send recorded); a finish from a worker
--   whose lease was taken over returns 'stale' and its send evidence is not kept (the receipt is resent under the
--   same provider key, or is already on the office list).
-- BEFORE THE APP ASKS FOR RECEIPTS (PR 2): the worker, the office list (needs_check rows, plus pending or sending
--   rows created over an hour ago) with an action to close a row, and provider bounce handling must be live.
--
-- NOT CHANGED: what completion does to deliveries, stock, invoices or evidence; start_and_complete_delivery;
--   process_offline_action; send-email; email_log; every grant on existing objects except complete_delivery's
--   (re-created with the same grants). No existing row changes.
--
-- idempotency-body-check: exempt -- claim_delivery_receipts, confirm_delivery_receipt_send and
--   finish_delivery_receipt take p_idempotency_key (check_idempotency / save_idempotency: a retried claim returns
--   the same claims, a retried finish its first answer, a retried confirm re-checks; a confirm or finish key reused
--   for another receipt is refused) and are also bound to a per-claim token, so a stale call matches no row and
--   changes nothing. _enqueue_delivery_receipt is internal (no API role may run it) and writes one row per
--   delivery (ON CONFLICT (delivery_id)). complete_delivery keeps its required-key replay binding unchanged.
--
-- actor-binding-check: exempt -- _enqueue_delivery_receipt(p_delivery_id, p_actor) is internal (EXECUTE revoked
--   from PUBLIC, anon, authenticated and service_role); its only caller is complete_delivery, which passes its own
--   v_actor := auth.uid() after the unchanged ACTOR_MISMATCH check on p_performed_by. complete_delivery itself
--   keeps that binding (postflight and the real-schema proof check it).
--
-- caller-analysis: complete_delivery :: re-created with an extra trailing DEFAULT NULL argument and the same grants (EXECUTE for authenticated and service_role; REVOKE only from PUBLIC and anon, as in 20261022075000). Deliveries.tsx (via start_and_complete_delivery, positional 10 args), DeliveryDetail.tsx, FieldStop.tsx and process_offline_action (named args) all still resolve to it unchanged.
--
-- ROLLBACK (its own reviewed migration): unschedule the cron job; re-emit the 10-argument complete_delivery from
--   20261022075000 (md5 pinned below) with its grants; drop the five new functions but KEEP the table and its rows
--   (owed and office-list receipts are the recovery record; drop it only once none is pending, sending or
--   needs_check).
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE delivery_receipt_queue_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF (SELECT transaction_id FROM pg_temp.delivery_receipt_queue_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_RECEIPT_QUEUE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_delivery') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_RECEIPT_QUEUE_DRIFT: complete_delivery must have exactly one overload';
  END IF;
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure('public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text)');
  IF p.oid IS NULL
     OR md5(replace(p.prosrc, chr(13), '')) <> 'c07f8ea8323f512549064a2ee6360dba'  -- md5 ignores carriage returns
     OR NOT p.prosecdef
     OR p.proowner <> 'postgres'::regrole
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR has_function_privilege('anon', p.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_RECEIPT_QUEUE_DRIFT: complete_delivery differs from its pinned 20261022075000 body, owner, mode, search_path or grants';
  END IF;
  IF to_regclass('public.delivery_receipt_queue') IS NOT NULL
     OR to_regproc('public.claim_delivery_receipts') IS NOT NULL
     OR to_regproc('public.confirm_delivery_receipt_send') IS NOT NULL
     OR to_regproc('public.finish_delivery_receipt') IS NOT NULL
     OR to_regproc('public._enqueue_delivery_receipt') IS NOT NULL
     OR to_regproc('public._wake_delivery_receipt_worker') IS NOT NULL
     OR to_regproc('public._delivery_receipt_keep_owed') IS NOT NULL
     OR EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deliver-receipt-queue') THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_RECEIPT_QUEUE_DRIFT: an object this file creates already exists';
  END IF;
END;
$preflight$;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------------------------
-- 1. The queue.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.delivery_receipt_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL UNIQUE REFERENCES public.deliveries(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  requested_by uuid REFERENCES public.profiles(id),
  -- What the receipt says, fixed at completion so every attempt sends the same body: delivery_number,
  -- delivered_on (YYYY-MM-DD, Central), signed_by, is_partial, contact_name, lines [{name, qty}].
  -- No photos and no links (Mason, 2026-10-14).
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'
                                AND COALESCE(jsonb_typeof(receipt -> 'lines'), '') = 'array'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'needs_check', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  attempt_to text, -- the address the latest claim fixed; after an authorized send, never changed
  send_authorized_at timestamptz, -- the first time confirm said 'send': an email may have gone out since
  last_error text,
  sent_to text,
  resend_message_id text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'sending') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)  -- a needs_check row may keep the send it recorded
);

CREATE INDEX delivery_receipt_queue_due_idx ON public.delivery_receipt_queue (next_attempt_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX delivery_receipt_queue_needs_check_idx ON public.delivery_receipt_queue (created_at)
  WHERE status = 'needs_check';

ALTER TABLE public.delivery_receipt_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_receipt_queue_select ON public.delivery_receipt_queue
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep()));
REVOKE ALL ON TABLE public.delivery_receipt_queue FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.delivery_receipt_queue TO authenticated;

CREATE TRIGGER set_delivery_receipt_queue_updated_at BEFORE UPDATE ON public.delivery_receipt_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.delivery_receipt_queue IS
  'KI-25: customer delivery receipts owed after completion (one per delivery), sent by the send-delivery-receipts worker. Read: active admin or sales rep. Written only by complete_delivery and the service_role worker RPCs.';

-- ---------------------------------------------------------------------------------------------
-- 2. Record an owed receipt (internal; called by complete_delivery after the evidence is recorded).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public._enqueue_delivery_receipt(p_delivery_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delivery record;
  v_worker_on boolean;
BEGIN
  SELECT d.id, d.delivery_number, d.customer_id, d.signed_by, d.completed_at, c.contact_name,
         NULLIF(btrim(COALESCE(c.email, '')), '') AS email
    INTO v_delivery
    FROM public.deliveries d JOIN public.customers c ON c.id = d.customer_id
   WHERE d.id = p_delivery_id AND d.status = 'completed' AND d.deleted_at IS NULL;
  IF v_delivery.id IS NULL THEN
    RETURN;
  END IF;
  -- No customer email on file now (removed after the screen checked), or the sender is not switched on yet (its two
  -- Vault secrets, as the timer reads them): the office follows up instead of a row waiting with nobody to send it.
  v_worker_on := EXISTS (SELECT 1 FROM vault.decrypted_secrets s WHERE s.name = 'delivery_receipt_worker_url')
             AND EXISTS (SELECT 1 FROM vault.decrypted_secrets s WHERE s.name = 'delivery_receipt_worker_secret');
  INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, requested_by, status, last_error, receipt)
  VALUES (
    p_delivery_id,
    v_delivery.customer_id,
    p_actor,
    CASE WHEN v_delivery.email IS NULL OR NOT v_worker_on THEN 'needs_check' ELSE 'pending' END,
    CASE WHEN v_delivery.email IS NULL THEN 'The customer has no email on file; the receipt was not sent.'
         WHEN NOT v_worker_on THEN 'The receipt sender is not switched on; the receipt was not sent.' END,
    jsonb_build_object(
      'delivery_number', COALESCE(v_delivery.delivery_number, ''),
      'delivered_on', to_char((v_delivery.completed_at AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD'),
      'signed_by', v_delivery.signed_by,
      'contact_name', v_delivery.contact_name,
      'is_partial', EXISTS (SELECT 1 FROM public.delivery_items di
                             WHERE di.delivery_id = p_delivery_id
                               AND COALESCE(di.quantity_delivered, di.quantity) < di.quantity)
                    OR EXISTS (SELECT 1 FROM public.delivery_remainders r WHERE r.original_delivery_id = p_delivery_id),
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', COALESCE(p.product_name, 'Product'),
                                            'qty', COALESCE(di.quantity_delivered, di.quantity))
                         ORDER BY p.product_name, di.id)
          FROM public.delivery_items di LEFT JOIN public.products p ON p.id = di.product_id
         WHERE di.delivery_id = p_delivery_id AND COALESCE(di.quantity_delivered, di.quantity) > 0
      ), '[]'::jsonb)
    )
  )
  -- A delivery completed again after its receipt was cancelled (nothing was ever sent) owes a fresh one; any
  -- other existing row (owed, sent or on the office list) stands.
  ON CONFLICT (delivery_id) DO UPDATE
     SET customer_id = EXCLUDED.customer_id, requested_by = EXCLUDED.requested_by, status = EXCLUDED.status,
         last_error = EXCLUDED.last_error, receipt = EXCLUDED.receipt, attempts = 0, next_attempt_at = now(),
         attempt_to = NULL, send_authorized_at = NULL, created_at = now()
   WHERE delivery_receipt_queue.status = 'cancelled' AND delivery_receipt_queue.send_authorized_at IS NULL;
END;
$function$;
ALTER FUNCTION public._enqueue_delivery_receipt(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._enqueue_delivery_receipt(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. complete_delivery: the 20261022075000 body plus p_email_receipt (three marked changes).
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text);

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
  p_email_receipt boolean DEFAULT NULL::boolean  -- 20261108100000 (KI-25)
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
ALTER FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean) IS
  'Completes a delivery with server-checked evidence (p_evidence + p_evidence_ref; 20261022075000): signature, paper_ticket, left_at_site, or (active admin only, written reason as p_evidence_ref) no_proof. Key required and bound to caller + request; a NULL p_evidence only replays a completion committed before 20261022075000. p_email_receipt TRUE records the customer receipt in delivery_receipt_queue in the same transaction (not for no_proof; 20261108100000, KI-25); NULL or FALSE leaves the fingerprint as before.';

-- ---------------------------------------------------------------------------------------------
-- 4. The worker's calls (service_role only): claim, confirm right before each send, finish.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.claim_delivery_receipts(p_limit integer DEFAULT 10, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_row public.delivery_receipt_queue%ROWTYPE;
  v_out jsonb := '[]'::jsonb;
  v_email text;
  v_to text;
  v_token uuid;
  v_saved jsonb;
  v_replay boolean;
  v_customer uuid;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'CLAIM_LIMIT_INVALID: p_limit must be 1 to 50' USING ERRCODE = '22023';
  END IF;
  -- A retry with the same key (its answer was lost) returns the receipts that call claimed and still holds, with
  -- the same tokens and addresses, and claims nothing new; confirm re-checks each one before it is sent.
  -- Only ids and tokens are saved in idempotency_keys, never the customer email.
  v_saved := public.check_idempotency(p_idempotency_key, 'claim_delivery_receipts');
  v_replay := v_saved IS NOT NULL;
  FOR v_row IN
    SELECT * FROM public.delivery_receipt_queue q
     WHERE CASE WHEN v_replay
                THEN q.status = 'sending' AND q.claimed_at >= now() - interval '10 minutes'
                     AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_saved) AS s(id uuid, claim_token uuid)
                                  WHERE s.id = q.id AND s.claim_token = q.claim_token)
                ELSE (q.status = 'pending' AND q.next_attempt_at <= now())
                     OR (q.status = 'sending' AND q.claimed_at < now() - interval '10 minutes') END
     ORDER BY q.next_attempt_at, q.id
     LIMIT CASE WHEN v_replay THEN 50 ELSE p_limit END
     FOR UPDATE SKIP LOCKED
  LOOP
    IF v_replay THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'id', v_row.id, 'claim_token', v_row.claim_token, 'delivery_id', v_row.delivery_id,
        'customer_id', v_row.customer_id, 'requested_by', v_row.requested_by, 'attempt', v_row.attempts,
        'to', v_row.attempt_to, 'receipt', v_row.receipt));
      CONTINUE;
    END IF;

    SELECT d.customer_id INTO v_customer FROM public.deliveries d
     WHERE d.id = v_row.delivery_id AND d.status = 'completed' AND d.deleted_at IS NULL;
    IF NOT FOUND THEN
      -- Cancelled only when no send was ever authorized; otherwise one may have gone out: the office checks.
      UPDATE public.delivery_receipt_queue
         SET status = CASE WHEN send_authorized_at IS NULL THEN 'cancelled' ELSE 'needs_check' END,
             claim_token = NULL, claimed_at = NULL,
             last_error = CASE WHEN send_authorized_at IS NULL
                               THEN 'The delivery is no longer completed; no receipt was sent.'
                               ELSE 'The delivery is no longer completed, but an earlier send of its receipt may have gone out; check with the customer.' END
       WHERE id = v_row.id;
      CONTINUE;
    END IF;
    IF v_customer IS DISTINCT FROM v_row.customer_id THEN
      UPDATE public.delivery_receipt_queue
         SET status = 'needs_check', claim_token = NULL, claimed_at = NULL,
             last_error = 'The delivery now belongs to another customer; check who should get the receipt.'
       WHERE id = v_row.id;
      CONTINUE;
    END IF;

    -- Five attempts at most; and a retry after a send that may have gone out is safe only inside the provider's
    -- 24-hour duplicate guard.
    IF v_row.attempts >= 5 OR v_row.send_authorized_at < now() - interval '23 hours' THEN
      UPDATE public.delivery_receipt_queue
         SET status = 'needs_check', claim_token = NULL, claimed_at = NULL,
             last_error = left(COALESCE(v_row.last_error || ' ', '')
               || 'Stopped retrying; check whether the customer got it before sending again.', 500)
       WHERE id = v_row.id;
      CONTINUE;
    END IF;

    SELECT NULLIF(btrim(COALESCE(c.email, '')), '') INTO v_email FROM public.customers c WHERE c.id = v_row.customer_id;
    IF v_email IS NULL THEN
      UPDATE public.delivery_receipt_queue
         SET status = 'needs_check', claim_token = NULL, claimed_at = NULL,
             last_error = 'The customer has no email on file now.'
       WHERE id = v_row.id;
      CONTINUE;
    END IF;
    -- After a send that may have gone out, a retry must be the identical request (same provider key, address and
    -- body), so it keeps that address exactly; a changed address goes to the office instead.
    IF v_row.send_authorized_at IS NOT NULL THEN
      IF lower(v_email) IS DISTINCT FROM lower(btrim(v_row.attempt_to)) THEN
        UPDATE public.delivery_receipt_queue
           SET status = 'needs_check', claim_token = NULL, claimed_at = NULL,
               last_error = 'The customer''s email changed after a send that may have gone out; check whether the customer got it.'
         WHERE id = v_row.id;
        CONTINUE;
      END IF;
      v_to := v_row.attempt_to;
    ELSE
      v_to := v_email;
    END IF;

    v_token := gen_random_uuid();
    UPDATE public.delivery_receipt_queue
       SET status = 'sending', claim_token = v_token, claimed_at = now(), attempts = attempts + 1, attempt_to = v_to
     WHERE id = v_row.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id,
      'claim_token', v_token,
      'delivery_id', v_row.delivery_id,
      'customer_id', v_row.customer_id,
      'requested_by', v_row.requested_by,
      'attempt', v_row.attempts + 1,
      'to', v_to,
      'receipt', v_row.receipt
    ));
  END LOOP;
  IF p_idempotency_key IS NOT NULL AND NOT v_replay THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'claim_delivery_receipts', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('id', e -> 'id', 'claim_token', e -> 'claim_token')) FROM jsonb_array_elements(v_out) e),
      '[]'::jsonb));
  END IF;
  RETURN v_out;
END;
$function$;
ALTER FUNCTION public.claim_delivery_receipts(integer, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_delivery_receipts(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_delivery_receipts(integer, text) TO service_role;
COMMENT ON FUNCTION public.claim_delivery_receipts(integer, text) IS
  'KI-25 worker (service_role only): settles rows that must not be sent, then claims up to p_limit due receipts with a fresh claim token (10-minute lease) and returns them with the address to send to; a retried key returns the same claims.';

CREATE FUNCTION public.confirm_delivery_receipt_send(
  p_id uuid,
  p_claim_token uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_row public.delivery_receipt_queue%ROWTYPE;
  v_saved jsonb;
  v_now timestamptz;
  v_customer uuid;
  v_completed boolean;
  v_email text;
  v_result text;
BEGIN
  IF p_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'RECEIPT_CLAIM_REQUIRED: p_id and p_claim_token are required' USING ERRCODE = '22023';
  END IF;
  -- A key is bound to one receipt and claim. A retry with it re-checks: a cached 'send' could be out of date.
  v_saved := public.check_idempotency(p_idempotency_key, 'confirm_delivery_receipt_send');
  IF v_saved IS NOT NULL AND (v_saved ->> 'id' IS DISTINCT FROM p_id::text
                              OR v_saved ->> 'claim_token' IS DISTINCT FROM p_claim_token::text) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: this key confirmed a different receipt or claim' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.delivery_receipt_queue q
   WHERE q.id = p_id AND q.claim_token = p_claim_token AND q.status = 'sending'
   FOR UPDATE;
  IF v_row.id IS NULL THEN
    v_result := 'stale';
  ELSE
    -- FOR SHARE waits for an in-flight edit of the delivery or customer and then reads what it committed.
    SELECT d.customer_id, (d.status = 'completed' AND d.deleted_at IS NULL), NULLIF(btrim(COALESCE(c.email, '')), '')
      INTO v_customer, v_completed, v_email
      FROM public.deliveries d, public.customers c
     WHERE d.id = v_row.delivery_id AND c.id = v_row.customer_id
       FOR SHARE OF d, c;
    v_now := clock_timestamp();  -- after every lock wait, not the transaction's start
    IF v_row.claimed_at < v_now - interval '10 minutes' THEN
      v_result := 'stale';  -- the lease ran out: a fresh claim may own this receipt
    ELSIF v_completed IS NOT TRUE THEN
      v_result := CASE WHEN v_row.send_authorized_at IS NULL THEN 'cancelled' ELSE 'needs_check' END;
      UPDATE public.delivery_receipt_queue
         SET status = v_result, claim_token = NULL, claimed_at = NULL,
             last_error = CASE WHEN v_row.send_authorized_at IS NULL
                               THEN 'The delivery is no longer completed; no receipt was sent.'
                               ELSE 'The delivery is no longer completed, but an earlier send of its receipt may have gone out; check with the customer.' END
       WHERE id = p_id;
    ELSIF v_customer IS DISTINCT FROM v_row.customer_id THEN
      v_result := 'needs_check';
      UPDATE public.delivery_receipt_queue
         SET status = 'needs_check', claim_token = NULL, claimed_at = NULL,
             last_error = 'The delivery now belongs to another customer; check who should get the receipt.'
       WHERE id = p_id;
    ELSIF v_email IS NULL OR lower(v_email) IS DISTINCT FROM lower(btrim(v_row.attempt_to)) THEN
      v_result := 'needs_check';
      UPDATE public.delivery_receipt_queue
         SET status = 'needs_check', claim_token = NULL, claimed_at = NULL,
             last_error = 'The customer''s email changed before the receipt was sent; check where it should go.'
       WHERE id = p_id;
    ELSIF v_row.send_authorized_at < v_now - interval '23 hours' THEN
      v_result := 'needs_check';
      UPDATE public.delivery_receipt_queue
         SET status = 'needs_check', claim_token = NULL, claimed_at = NULL,
             last_error = 'Stopped retrying; check whether the customer got it before sending again.'
       WHERE id = p_id;
    ELSE
      v_result := 'send';
      UPDATE public.delivery_receipt_queue
         SET claimed_at = v_now, send_authorized_at = COALESCE(send_authorized_at, v_now)
       WHERE id = p_id;
    END IF;
  END IF;
  IF p_idempotency_key IS NOT NULL AND v_saved IS NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'confirm_delivery_receipt_send',
      jsonb_build_object('id', p_id, 'claim_token', p_claim_token));
  END IF;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.confirm_delivery_receipt_send(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.confirm_delivery_receipt_send(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_delivery_receipt_send(uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION public.confirm_delivery_receipt_send(uuid, uuid, text) IS
  'KI-25 worker (service_role only): called immediately before each external send. Returns send (claim held, delivery still completed and this customer''s, email unchanged; renews the lease), stale (claim lost; nothing changes), or the status it settled the receipt to (cancelled / needs_check).';

CREATE FUNCTION public.finish_delivery_receipt(
  p_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_detail text DEFAULT NULL,
  p_resend_message_id text DEFAULT NULL,
  p_sent_to text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_status text;
  v_saved jsonb;
  v_still_right boolean;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'retry', 'check') THEN
    RAISE EXCEPTION 'RECEIPT_OUTCOME_INVALID: %', p_outcome USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'sent' AND (NULLIF(btrim(COALESCE(p_resend_message_id, '')), '') IS NULL
                             OR NULLIF(btrim(COALESCE(p_sent_to, '')), '') IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_SENT_PROOF_REQUIRED: a sent receipt needs the provider message id and address'
      USING ERRCODE = '22023';
  END IF;
  -- A retry with the same key gets the answer the first call recorded; the key is bound to that receipt,
  -- claim and outcome, so reusing it for anything else is refused rather than answered from the cache.
  v_saved := public.check_idempotency(p_idempotency_key, 'finish_delivery_receipt');
  IF v_saved IS NOT NULL THEN
    IF v_saved ->> 'id' IS DISTINCT FROM p_id::text
       OR v_saved ->> 'claim_token' IS DISTINCT FROM p_claim_token::text
       OR v_saved ->> 'outcome' IS DISTINCT FROM p_outcome
       OR v_saved ->> 'resend_message_id' IS DISTINCT FROM p_resend_message_id
       OR v_saved ->> 'sent_to' IS DISTINCT FROM p_sent_to
       OR v_saved ->> 'detail' IS DISTINCT FROM p_detail THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: this key finished a different receipt or outcome' USING ERRCODE = '22023';
    END IF;
    RETURN v_saved ->> 'status';
  END IF;
  -- A sent receipt must have gone to the address this claim fixed.
  IF p_outcome = 'sent' AND EXISTS (SELECT 1 FROM public.delivery_receipt_queue q
                                     WHERE q.id = p_id AND q.claim_token = p_claim_token AND q.status = 'sending'
                                       AND lower(q.attempt_to) IS DISTINCT FROM lower(btrim(p_sent_to))) THEN
    RAISE EXCEPTION 'RECEIPT_SENT_TO_MISMATCH: the receipt was claimed for a different address' USING ERRCODE = '22023';
  END IF;
  UPDATE public.delivery_receipt_queue q
     SET status = CASE
                    WHEN p_outcome = 'sent' THEN 'sent'
                    WHEN p_outcome = 'retry' AND q.attempts < 5 THEN 'pending'
                    ELSE 'needs_check'
                  END,
         next_attempt_at = CASE WHEN p_outcome = 'retry'
                                THEN now() + make_interval(mins => power(2, q.attempts)::integer)
                                ELSE q.next_attempt_at END,
         claim_token = NULL,
         claimed_at = NULL,
         sent_at = CASE WHEN p_outcome = 'sent' THEN now() END,
         sent_to = CASE WHEN p_outcome = 'sent' THEN left(p_sent_to, 320) END,
         resend_message_id = CASE WHEN p_outcome = 'sent' THEN left(p_resend_message_id, 200) END,
         last_error = CASE
                        WHEN p_outcome = 'sent' THEN NULL
                        WHEN p_outcome = 'retry' AND q.attempts >= 5
                          THEN left('Tried 5 times. Last error: ' || COALESCE(p_detail, 'unknown'), 500)
                        ELSE left(COALESCE(p_detail, 'unknown error'), 500)
                      END
   WHERE q.id = p_id AND q.claim_token = p_claim_token AND q.status = 'sending'
  RETURNING q.status INTO v_status;
  -- No row: the lease expired and another run owns (or finished) this receipt. Nothing changes.
  v_status := COALESCE(v_status, 'stale');
  -- The email went out, but if the delivery was voided, moved to another customer, or the customer's email
  -- changed while it was sending, the office follows up; the send stays recorded. FOR SHARE waits for an
  -- in-flight edit and reads what it committed.
  IF v_status = 'sent' THEN
    SELECT (d.status = 'completed' AND d.deleted_at IS NULL AND d.customer_id = q.customer_id
            AND lower(btrim(COALESCE(c.email, ''))) = lower(btrim(p_sent_to)))
      INTO v_still_right
      FROM public.delivery_receipt_queue q
      JOIN public.deliveries d ON d.id = q.delivery_id
      JOIN public.customers c ON c.id = q.customer_id
     WHERE q.id = p_id
       FOR SHARE OF d, c;
    IF v_still_right IS NOT TRUE THEN
      UPDATE public.delivery_receipt_queue
         SET status = 'needs_check',
             last_error = 'The receipt was emailed, but the delivery, its customer or the customer''s email changed while it was sending; check with the customer.'
       WHERE id = p_id;
      v_status := 'needs_check';
    END IF;
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'finish_delivery_receipt', jsonb_build_object('id', p_id, 'claim_token', p_claim_token, 'outcome', p_outcome,
      'resend_message_id', p_resend_message_id, 'sent_to', p_sent_to, 'detail', p_detail, 'status', v_status));
  END IF;
  RETURN v_status;
END;
$function$;
ALTER FUNCTION public.finish_delivery_receipt(uuid, uuid, text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_delivery_receipt(uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_delivery_receipt(uuid, uuid, text, text, text, text, text) TO service_role;
COMMENT ON FUNCTION public.finish_delivery_receipt(uuid, uuid, text, text, text, text, text) IS
  'KI-25 worker (service_role only): records one claimed receipt''s outcome (sent / retry / check) against its claim token; returns the new status, or stale when the claim was lost.';

-- ---------------------------------------------------------------------------------------------
-- 4b. An owed or office-list receipt cannot be deleted.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public._delivery_receipt_keep_owed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF OLD.status IN ('pending', 'sending', 'needs_check') THEN
    RAISE EXCEPTION 'DELIVERY_RECEIPT_OWED: this delivery''s receipt is still being emailed or is waiting for the office to check it; void the delivery instead of deleting it, or settle the receipt first';
  END IF;
  RETURN OLD;
END;
$function$;
ALTER FUNCTION public._delivery_receipt_keep_owed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._delivery_receipt_keep_owed() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER delivery_receipt_keep_owed BEFORE DELETE ON public.delivery_receipt_queue
  FOR EACH ROW EXECUTE FUNCTION public._delivery_receipt_keep_owed();
COMMENT ON FUNCTION public._delivery_receipt_keep_owed() IS
  'KI-25 (trigger on delivery_receipt_queue): an owed receipt (pending or sending) or one waiting for the office (needs_check) cannot be deleted, so a hard delete of its delivery is refused instead of erasing it.';

-- ---------------------------------------------------------------------------------------------
-- 5. The timer: wake the worker every 2 minutes, only when a receipt is due and the worker is configured.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public._wake_delivery_receipt_worker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.delivery_receipt_queue q
                  WHERE (q.status = 'pending' AND q.next_attempt_at <= now())
                     OR (q.status = 'sending' AND q.claimed_at < now() - interval '10 minutes')) THEN
    RETURN;
  END IF;
  SELECT s.decrypted_secret INTO v_url FROM vault.decrypted_secrets s WHERE s.name = 'delivery_receipt_worker_url';
  SELECT s.decrypted_secret INTO v_secret FROM vault.decrypted_secrets s WHERE s.name = 'delivery_receipt_worker_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RETURN; -- not switched on yet
  END IF;
  PERFORM net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-receipt-worker-secret', v_secret),
    timeout_milliseconds := 60000
  );
END;
$function$;
ALTER FUNCTION public._wake_delivery_receipt_worker() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._wake_delivery_receipt_worker() FROM PUBLIC, anon, authenticated, service_role;

SELECT cron.schedule('deliver-receipt-queue', '*/2 * * * *', $$SELECT public._wake_delivery_receipt_worker()$$);

-- ---------------------------------------------------------------------------------------------
-- Postflight.
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
  v_name text;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_delivery') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT: complete_delivery must have exactly one overload';
  END IF;
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure('public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean)');
  IF p.oid IS NULL OR NOT p.prosecdef OR p.proowner <> 'postgres'::regrole
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR has_function_privilege('anon', p.oid, 'EXECUTE')
     OR position('_enqueue_delivery_receipt' IN p.prosrc) = 0
     OR position('ACTOR_MISMATCH' IN p.prosrc) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT: complete_delivery lost its receipt step, actor binding, owner, mode, search_path or grants';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['claim_delivery_receipts(integer, text)', 'confirm_delivery_receipt_send(uuid, uuid, text)',
                                'finish_delivery_receipt(uuid, uuid, text, text, text, text, text)'] LOOP
    IF has_function_privilege('authenticated', ('public.' || v_name)::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.' || v_name)::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('service_role', ('public.' || v_name)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT: % must be service_role only', v_name;
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['_enqueue_delivery_receipt(uuid, uuid)', '_wake_delivery_receipt_worker()',
                                '_delivery_receipt_keep_owed()'] LOOP
    IF has_function_privilege('authenticated', ('public.' || v_name)::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.' || v_name)::regprocedure, 'EXECUTE')
       OR has_function_privilege('service_role', ('public.' || v_name)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT: % must be internal', v_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.delivery_receipt_queue'::regclass AND tgname = 'delivery_receipt_keep_owed' AND tgenabled = 'O'
         AND tgfoid = 'public._delivery_receipt_keep_owed()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT: the keep-owed trigger is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.delivery_receipt_queue'::regclass)
     OR has_table_privilege('authenticated', 'public.delivery_receipt_queue', 'INSERT')
     OR has_table_privilege('authenticated', 'public.delivery_receipt_queue', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.delivery_receipt_queue', 'DELETE')
     OR has_table_privilege('anon', 'public.delivery_receipt_queue', 'SELECT')
     OR has_table_privilege('service_role', 'public.delivery_receipt_queue', 'INSERT') THEN
    RAISE EXCEPTION 'POSTFLIGHT: delivery_receipt_queue access is wider than read-only for staff';
  END IF;
  IF (SELECT count(*) FROM cron.job
       WHERE jobname = 'deliver-receipt-queue' AND username = 'postgres' AND database = 'postgres' AND active
         AND schedule = '*/2 * * * *' AND command = 'SELECT public._wake_delivery_receipt_worker()') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT: the deliver-receipt-queue job is missing or not the expected postgres job';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['_enqueue_delivery_receipt(uuid, uuid)', '_wake_delivery_receipt_worker()',
                                'claim_delivery_receipts(integer, text)', 'confirm_delivery_receipt_send(uuid, uuid, text)',
                                'finish_delivery_receipt(uuid, uuid, text, text, text, text, text)'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid = ('public.' || v_name)::regprocedure;
    IF NOT p.prosecdef OR p.proowner <> 'postgres'::regrole
       OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'POSTFLIGHT: % lost its owner, mode or search_path', v_name;
    END IF;
  END LOOP;
END;
$postflight$;
