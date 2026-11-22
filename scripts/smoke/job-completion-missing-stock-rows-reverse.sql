-- Rollback for supabase/migrations/20270220120000_job_completion_missing_stock_rows.sql
-- (proven by scripts/smoke/prove-job-completion-missing-stock-rows-real-schema.mjs).
-- Refuses, changing nothing, unless the lock function and complete_job are still the bodies that migration
-- installed. Then restores the KI-150 lock body (lock existing rows only) and the previous complete_job
-- (no number lock up front, no completion mark). Rows already created stay; the deduction loop goes back
-- to inserting a missing row itself.
-- To use it live, copy it into a new migration through the gates (without the BEGIN / COMMIT lines).
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $refuse$
DECLARE
  v_fn record;
  v_job record;
BEGIN
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO v_fn
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._lock_job_stock_rows_in_order()');
  IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM 'e3344479412462cc3bdecee378f4d495' THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: _lock_job_stock_rows_in_order is not the reviewed body';
  END IF;
  IF NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('public', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: security, search_path or grants changed after the migration';
  END IF;
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO v_job
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.complete_job(uuid, jsonb, uuid, text)');
  IF v_job.oid IS NULL OR md5(replace(v_job.prosrc, chr(13), '')) IS DISTINCT FROM 'cb32addd7999eae75282813e94962bba'
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'complete_job') <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: complete_job is not the reviewed single wrapper';
  END IF;
  IF NOT v_job.prosecdef OR v_job.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('public', v_job.oid, 'EXECUTE')
     OR has_function_privilege('anon', v_job.oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_job.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_job.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: complete_job''s security, search_path or grants changed after the migration';
  END IF;
END;
$refuse$;

CREATE OR REPLACE FUNCTION public._lock_job_stock_rows_in_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  -- KI-150: _complete_job_replay_impl_20261015 deducts each chemical's stock row in line order after this status
  -- update; lock them all here in product order first (as the hold sync before it), so two completions sharing products cannot deadlock.
  PERFORM 1 FROM public.inventory i
   WHERE i.location = 'Main Warehouse'
     AND i.product_id IN (SELECT jc.product_id FROM public.job_chemicals jc
                           WHERE jc.job_id = NEW.id AND jc.quantity > 0 AND jc.customer_supplied = false)
   ORDER BY i.product_id, i.id
     FOR UPDATE;
  RETURN NULL;
END;
$function$;

-- caller-analysis: _lock_job_stock_rows_in_order :: trigger only; EXECUTE stays revoked from PUBLIC, anon, authenticated and service_role
REVOKE ALL ON FUNCTION public._lock_job_stock_rows_in_order() FROM PUBLIC, anon, authenticated, service_role;

-- CREATE OR REPLACE keeps complete_job's grants (authenticated, service_role); the postcheck below confirms them.
CREATE OR REPLACE FUNCTION public.complete_job(p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
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
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: complete_job requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same tests and messages as the renamed body, which is strict: the caller must name itself.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  -- p_applied_info is fingerprinted as sent (jsonb normalizes key order; array order counts).
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'job_id', p_job_id,
    'applied_info', p_applied_info
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'complete_job', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._complete_job_replay_impl_20261015(p_job_id, p_applied_info, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'complete_job', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

DO $restored$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._lock_job_stock_rows_in_order()'))
     IS DISTINCT FROM '1db82a3124369cd6009643a3e6e4596f' THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: the restored body is not the KI-150 body';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.complete_job(uuid, jsonb, uuid, text)'))
     IS DISTINCT FROM '6ec962c198bf326b4ef773fa8d8d5edc'
     OR has_function_privilege('anon', 'public.complete_job(uuid, jsonb, uuid, text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.complete_job(uuid, jsonb, uuid, text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.complete_job(uuid, jsonb, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: the restored complete_job is not the previous wrapper';
  END IF;
END;
$restored$;

COMMIT;
