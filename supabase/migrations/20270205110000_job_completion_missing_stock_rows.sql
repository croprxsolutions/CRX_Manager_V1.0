-- Job completion creates a missing Main Warehouse stock row the same way a delivery completion does.
--
-- Two jobs finishing together, both using a product that has never had a stock row at Main Warehouse,
-- used to collide: each tried to insert that row, and one failed (unique violation, or a deadlock when
-- the products were created in opposite line order). Nothing was half-saved; the failed job had to be
-- retried. Delivery completion already waits instead (#1942, _complete_delivery_authorized_impl): it
-- locks existing rows in product order, then creates each missing row in that same order and locks it.
-- Job completion locked existing rows (trg_zz_lock_job_stock_rows, KI-150) but still inserted a missing
-- row inside _complete_job_replay_impl_20261015, in chemical order, with no conflict handling.
-- Two complete_job calls are also held apart by the application-record number lock, which is taken
-- before that insert, so they do not hit it today. A delivery (or any other writer) creating the same
-- missing row is not held by that lock. Moving creation into this trigger, in product order, is the
-- same wait the delivery completion already uses, and it stays safe if that number lock ever moves.
--
-- This replaces only _lock_job_stock_rows_in_order. The trigger still runs after the hold sync and
-- before the deduction loop. It still locks existing rows first. Then, for each product the job will
-- deduct (quantity > 0, not customer-supplied), in product order, a missing row is inserted at zero
-- (the same columns the deduction insert uses, not the delivery "manufactured at delivery" flag) with
-- ON CONFLICT DO NOTHING, and the row is locked whether this pass created it or another completion
-- committed it after the first lock. The deduction loop then finds the row and subtracts, so the
-- on-hand, the job_applied ledger row and the short-stock flag end where they do today for one job.
-- A saved completion receipt returns before the status update, so a retry does not create a row.
--
-- idempotency-body-check: not applicable — this trigger has no idempotency key. complete_job's key
--   check is unchanged and still runs before the status update that fires this trigger.
-- caller-analysis: _lock_job_stock_rows_in_order :: trigger only; EXECUTE stays revoked from PUBLIC,
--   anon, authenticated and service_role. No screen calls it. The completion body is not re-emitted.
--
-- ROLLBACK: scripts/smoke/job-completion-missing-stock-rows-reverse.sql
--   (proven by scripts/smoke/prove-job-completion-missing-stock-rows-real-schema.mjs).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO v_fn
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._lock_job_stock_rows_in_order()');
  IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM '1db82a3124369cd6009643a3e6e4596f' THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_PREFLIGHT: _lock_job_stock_rows_in_order is not the reviewed KI-150 body';
  END IF;
  IF NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('public', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_PREFLIGHT: the lock function''s security, search_path or grants changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE c.relname = 'jobs' AND t.tgname = 'trg_zz_lock_job_stock_rows' AND NOT t.tgisinternal
       AND p.oid = v_fn.oid
  ) THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_PREFLIGHT: trg_zz_lock_job_stock_rows is not bound to the reviewed function';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._lock_job_stock_rows_in_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product record;
BEGIN
  -- KI-150: existing Main Warehouse rows first, in product order, after the hold sync and before the
  -- deduction loop. Creating a row before this lock can deadlock with a writer that already holds an
  -- existing row (the delivery completion's Sol r2 case).
  PERFORM 1 FROM public.inventory i
   WHERE i.location = 'Main Warehouse'
     AND i.product_id IN (SELECT jc.product_id FROM public.job_chemicals jc
                           WHERE jc.job_id = NEW.id AND jc.quantity > 0 AND jc.customer_supplied = false)
   ORDER BY i.product_id, i.id
     FOR UPDATE;

  -- Then each product this completion deducts, in product order. A missing row is created at zero,
  -- exactly the columns the deduction insert fills (no manufactured-at-delivery flag). ON CONFLICT
  -- waits for the other completion instead of failing, then the row is locked so the deduction sees it.
  FOR v_product IN
    SELECT jc.product_id
      FROM public.job_chemicals jc
     WHERE jc.job_id = NEW.id
       AND jc.quantity > 0
       AND jc.customer_supplied = false
     GROUP BY jc.product_id
     ORDER BY jc.product_id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.inventory i
       WHERE i.product_id = v_product.product_id AND i.location = 'Main Warehouse'
    ) THEN
      INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_product.product_id, 'Main Warehouse', 0, 0, 0)
      ON CONFLICT DO NOTHING;
    END IF;
    PERFORM 1 FROM public.inventory i
     WHERE i.product_id = v_product.product_id AND i.location = 'Main Warehouse'
     ORDER BY i.id
       FOR UPDATE;
  END LOOP;
  RETURN NULL;
END;
$function$;

-- caller-analysis: _lock_job_stock_rows_in_order :: trigger only; EXECUTE stays revoked from PUBLIC, anon, authenticated and service_role
REVOKE ALL ON FUNCTION public._lock_job_stock_rows_in_order() FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO v_fn
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._lock_job_stock_rows_in_order()');
  IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM '3aa1bb8f25907ab7bf1c58a83fd0331d' THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_POSTFLIGHT: the lock function is not the reviewed body';
  END IF;
  IF NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('public', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_POSTFLIGHT: security, search_path or grants changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE c.relname = 'jobs' AND t.tgname = 'trg_zz_lock_job_stock_rows' AND NOT t.tgisinternal
       AND p.oid = v_fn.oid
  ) THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_POSTFLIGHT: trg_zz_lock_job_stock_rows no longer calls the lock function';
  END IF;
END;
$postflight$;
