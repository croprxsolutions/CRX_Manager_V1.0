-- #2257: offline job completion no longer deadlocks against a sibling job's completion on the same booking.
-- Contract: docs/plans/2026-11-23-offline-job-lock-no-key-CONTRACT.md.
--
-- process_offline_action (body from 20260714203709, never redefined since) locked a complete_job receipt's job
-- FOR UPDATE before calling complete_job. A completion of a sibling job on the same open booking holds the booking
-- and rebuilds this job's job_product_draws row; that insert's foreign-key check takes FOR KEY SHARE on this job,
-- which FOR UPDATE blocks, while this call waits on the sibling (the booking today, the application-record number
-- lock once #2170 is in). PostgreSQL then cancels one of them (40P01).
--
-- The job is now locked FOR NO KEY UPDATE. That still conflicts with itself, FOR UPDATE, any UPDATE and DELETE of
-- the row, so two actions on one job and an office edit still cannot cross the updated_at check; it lets the
-- sibling's foreign-key check through. Nothing changes a job's id. The delivery branch keeps FOR UPDATE.
-- Everything else in the body is byte for byte the same; owner, SECURITY DEFINER, search_path and grants unchanged.
-- complete_job, the booking sync and every booking function are untouched.
--
-- idempotency-body-check: exempt -- offline_action_receipts is the durable idempotency ledger; key handling unchanged.
-- caller-analysis: process_offline_action :: src/lib/offlineReceipts.ts (field app offline sync) calls the same name and signature;
--   result shape, errors and grants (authenticated, service_role) are unchanged.
--
-- ROLLBACK: scripts/smoke/offline-job-lock-no-key-update-reverse.sql (proven by
--   scripts/smoke/prove-offline-job-lock-no-key-update-real-schema.mjs).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE offline_job_lock_2257_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.offline_job_lock_2257_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.offline_job_lock_2257_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig, p.proowner INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.process_offline_action(uuid,text)');
  IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM '0461eebf65f23ccc8fe3852375eb9c78' THEN
    RAISE EXCEPTION 'OFFLINE_JOB_LOCK_BASELINE_DRIFT: process_offline_action is not the 20260714203709 body (already applied?)';
  END IF;
  IF NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.proowner IS DISTINCT FROM 'postgres'::regrole
     OR has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'OFFLINE_JOB_LOCK_BASELINE_DRIFT: owner, security, search_path or grants are not the reviewed ones';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'process_offline_action' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'OFFLINE_JOB_LOCK_BASELINE_DRIFT: expected exactly one process_offline_action';
  END IF;
END;
$preflight$;

CREATE TEMP TABLE offline_job_lock_2257_acl ON COMMIT DROP AS
SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.process_offline_action(uuid,text)'::regprocedure;

CREATE OR REPLACE FUNCTION public.process_offline_action(
  p_client_action_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_receipt public.offline_action_receipts%ROWTYPE;
  v_result jsonb;
  v_sqlstate text;
  v_message text;
  v_failure_code text;
  v_failure_summary text;
  v_target_updated_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = v_actor AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: active profile required';
  END IF;
  IF p_client_action_id IS NULL OR p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: action ID and idempotency key are required';
  END IF;

  SELECT *
    INTO v_receipt
    FROM public.offline_action_receipts r
   WHERE r.client_action_id = p_client_action_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_NOT_FOUND: offline receipt not found';
  END IF;
  IF v_receipt.actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF v_receipt.idempotency_key IS DISTINCT FROM p_idempotency_key THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
  END IF;

  IF v_receipt.status = 'succeeded' THEN
    RETURN jsonb_build_object(
      'client_action_id', v_receipt.client_action_id,
      'operation', v_receipt.operation,
      'entity_id', v_receipt.entity_id,
      'status', v_receipt.status,
      'result', v_receipt.result,
      'attempt_count', v_receipt.attempt_count,
      'succeeded_at', v_receipt.succeeded_at,
      'updated_at', v_receipt.updated_at
    );
  END IF;
  IF v_receipt.status = 'needs_review' THEN
    RAISE EXCEPTION 'OFFLINE_ACTION_NEEDS_REVIEW';
  END IF;

  -- Re-check immediately before the canonical mutation. This closes the gap
  -- where staging committed as received, the target changed, and processing
  -- retried later after a weak-connection interruption.
  IF v_receipt.entity_snapshot_at IS NOT NULL THEN
    IF v_receipt.operation = 'complete_delivery' THEN
      SELECT d.updated_at INTO v_target_updated_at
      FROM public.deliveries d
      WHERE d.id = v_receipt.entity_id
      FOR UPDATE;
    ELSE
      SELECT j.updated_at INTO v_target_updated_at
      FROM public.jobs j
      WHERE j.id = v_receipt.entity_id
      FOR NO KEY UPDATE;
    END IF;
  END IF;

  IF v_receipt.entity_snapshot_at IS NULL
     OR v_target_updated_at IS DISTINCT FROM v_receipt.entity_snapshot_at THEN
    v_failure_code := CASE
      WHEN v_receipt.entity_snapshot_at IS NULL THEN 'LEGACY_OUTCOME_UNKNOWN'
      ELSE 'TARGET_STATE_CONFLICT'
    END;
    v_failure_summary := CASE
      WHEN v_receipt.entity_snapshot_at IS NULL
        THEN 'This saved action does not include a target snapshot. Office review is required before it can run.'
      ELSE 'The delivery or job changed after this action reached the server. Office review is required.'
    END;
    UPDATE public.offline_action_receipts
       SET status = 'needs_review',
           failure_code = v_failure_code,
           failure_summary = v_failure_summary,
           needs_review_at = now()
     WHERE client_action_id = p_client_action_id;
    RETURN jsonb_build_object(
      'client_action_id', v_receipt.client_action_id,
      'operation', v_receipt.operation,
      'entity_id', v_receipt.entity_id,
      'status', 'needs_review',
      'failure_code', v_failure_code,
      'failure_summary', v_failure_summary,
      'attempt_count', v_receipt.attempt_count
    );
  END IF;

  IF v_receipt.attempt_count >= 50 THEN
    UPDATE public.offline_action_receipts
       SET status = 'needs_review',
           failure_code = 'RETRY_LIMIT',
           failure_summary = 'The server retry limit was reached. Office review is required.',
           needs_review_at = now()
     WHERE client_action_id = p_client_action_id;
    RETURN jsonb_build_object(
      'client_action_id', v_receipt.client_action_id,
      'operation', v_receipt.operation,
      'entity_id', v_receipt.entity_id,
      'status', 'needs_review',
      'failure_code', 'RETRY_LIMIT',
      'failure_summary', 'The server retry limit was reached. Office review is required.'
    );
  END IF;

  UPDATE public.offline_action_receipts
     SET attempt_count = attempt_count + 1,
         last_attempt_at = now()
   WHERE client_action_id = p_client_action_id;

  BEGIN
    IF v_receipt.operation = 'complete_delivery' THEN
      SELECT public.complete_delivery(
        p_delivery_id => v_receipt.entity_id,
        p_signed_by => v_receipt.request_payload->>'signed_by',
        p_performed_by => v_actor,
        p_quantities => v_receipt.request_payload->'quantities',
        p_issue_type => v_receipt.request_payload->>'issue_type',
        p_issue_notes => v_receipt.request_payload->>'issue_notes',
        p_idempotency_key => v_receipt.idempotency_key,
        p_completed_at => (v_receipt.request_payload->>'completed_at')::timestamptz
      ) INTO v_result;

      IF jsonb_typeof(v_result) <> 'object'
         OR v_result->>'delivery_id' IS DISTINCT FROM v_receipt.entity_id::text
         OR v_result->>'status' NOT IN ('completed', 'partial') THEN
        RAISE EXCEPTION 'OFFLINE_RESULT_INVALID';
      END IF;

    ELSIF v_receipt.operation = 'complete_job' THEN
      SELECT public.complete_job(
        p_job_id => v_receipt.entity_id,
        p_applied_info => v_receipt.request_payload,
        p_performed_by => v_actor,
        p_idempotency_key => v_receipt.idempotency_key
      ) INTO v_result;

      IF jsonb_typeof(v_result) <> 'object'
         OR v_result->'success' IS DISTINCT FROM 'true'::jsonb
         OR v_result->>'job_id' IS DISTINCT FROM v_receipt.entity_id::text
         OR COALESCE(btrim(v_result->>'record_number'), '') = '' THEN
        RAISE EXCEPTION 'OFFLINE_RESULT_INVALID';
      END IF;

    ELSE
      RAISE EXCEPTION 'UNSUPPORTED_OPERATION';
    END IF;

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_message = MESSAGE_TEXT;

    -- These classes are retryable infrastructure/transaction failures. Re-raise
    -- so this entire call, including attempt_count, rolls back to received.
    IF left(v_sqlstate, 2) IN ('08', '40', '53', '57', '58') THEN
      RAISE;
    END IF;

    -- The canonical functions currently use stable English tokens rather than
    -- structured SQLSTATEs for business failures. Keep these phrases aligned
    -- with their live definitions; the rolled-back smoke deliberately catches
    -- drift in the lifecycle-conflict phrase.
    IF v_message = 'OFFLINE_RESULT_INVALID' THEN
      v_failure_code := 'RESULT_INVALID';
      v_failure_summary := 'The business action returned an unexpected result. Office review is required.';
    ELSIF v_message IN (
      'Not authorized to complete this delivery',
      'Not authorized to complete this job'
    ) THEN
      v_failure_code := 'NOT_AUTHORIZED';
      v_failure_summary := 'The current user is not authorized to complete this delivery or job.';
    ELSIF v_message LIKE 'Delivery not found:%'
       OR v_message LIKE 'Job not found:%' THEN
      v_failure_code := 'TARGET_NOT_FOUND';
      v_failure_summary := 'The referenced delivery or job no longer exists.';
    ELSIF v_message LIKE 'Delivery must be in_progress to complete%'
       OR v_message LIKE 'Job must be in_progress before completion.%' THEN
      v_failure_code := 'TARGET_STATE_CONFLICT';
      v_failure_summary := 'The delivery or job changed after this offline action was saved. Office comparison is required.';
    ELSIF v_message ILIKE '%IDEMPOTENCY%CROSS%OP%'
       OR v_message ILIKE '%idempotency%reuse%' THEN
      v_failure_code := 'IDEMPOTENCY_KEY_REUSE';
      v_failure_summary := 'The idempotency key is already tied to different work. Office review is required.';
    ELSIF v_sqlstate = '23505' THEN
      -- A canonical UNIQUE failure is not necessarily an idempotency collision
      -- (for example, a record-number collision). Do not mislabel it.
      v_failure_code := 'UNEXPECTED_SERVER_ERROR';
      v_failure_summary := 'The business action hit an unexpected uniqueness conflict. Office review is required.';
    ELSIF left(v_sqlstate, 2) IN ('22', '23') THEN
      v_failure_code := 'PAYLOAD_INVALID';
      v_failure_summary := 'The saved action no longer satisfies the database contract. Office review is required.';
    ELSE
      v_failure_code := 'UNEXPECTED_SERVER_ERROR';
      v_failure_summary := 'The server could not safely complete this action. Office review is required.';
    END IF;

    UPDATE public.offline_action_receipts
       SET status = 'needs_review',
           result = NULL,
           failure_code = v_failure_code,
           failure_summary = v_failure_summary,
           needs_review_at = now()
     WHERE client_action_id = p_client_action_id;

    RETURN jsonb_build_object(
      'client_action_id', v_receipt.client_action_id,
      'operation', v_receipt.operation,
      'entity_id', v_receipt.entity_id,
      'status', 'needs_review',
      'failure_code', v_failure_code,
      'failure_summary', v_failure_summary,
      'attempt_count', v_receipt.attempt_count + 1
    );
  END;

  UPDATE public.offline_action_receipts
     SET status = 'succeeded',
         result = v_result,
         failure_code = NULL,
         failure_summary = NULL,
         succeeded_at = now(),
         needs_review_at = NULL
   WHERE client_action_id = p_client_action_id
   RETURNING * INTO v_receipt;

  RETURN jsonb_build_object(
    'client_action_id', v_receipt.client_action_id,
    'operation', v_receipt.operation,
    'entity_id', v_receipt.entity_id,
    'status', v_receipt.status,
    'result', v_receipt.result,
    'attempt_count', v_receipt.attempt_count,
    'succeeded_at', v_receipt.succeeded_at,
    'updated_at', v_receipt.updated_at
  );
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.process_offline_action(uuid,text)'::regprocedure)
     IS DISTINCT FROM '6e3a3d8e5d3528c5c4b29ac132c1490d' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: process_offline_action is not the reviewed body';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.process_offline_action(uuid,text)'::regprocedure)
     IS DISTINCT FROM (SELECT acl FROM pg_temp.offline_job_lock_2257_acl) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: grants changed';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: offline job completion locks the job FOR NO KEY UPDATE';
END;
$postflight$;
