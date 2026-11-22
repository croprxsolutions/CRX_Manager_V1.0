-- Rollback for supabase/migrations/20270220120000_job_completion_missing_stock_rows.sql
-- (proven by scripts/smoke/prove-job-completion-missing-stock-rows-real-schema.mjs).
-- Refuses, changing nothing, unless the lock function is still the body that migration installed.
-- Then restores the KI-150 body (lock existing rows only). Rows already created stay; the deduction
-- loop goes back to inserting a missing row itself.
-- To use it live, copy it into a new migration through the gates (without the BEGIN / COMMIT lines).
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $refuse$
DECLARE
  v_fn record;
BEGIN
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO v_fn
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._lock_job_stock_rows_in_order()');
  IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM 'cf1dbb690d8249733e9db0e60e0528a7' THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: _lock_job_stock_rows_in_order is not the reviewed body';
  END IF;
  IF NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('public', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: security, search_path or grants changed after the migration';
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

DO $restored$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._lock_job_stock_rows_in_order()'))
     IS DISTINCT FROM '1db82a3124369cd6009643a3e6e4596f' THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: the restored body is not the KI-150 body';
  END IF;
END;
$restored$;

COMMIT;
