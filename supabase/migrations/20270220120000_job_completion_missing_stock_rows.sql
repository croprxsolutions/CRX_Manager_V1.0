-- Job completion takes the application-record number lock first and creates a missing Main Warehouse
-- stock row the same way a delivery completion does.
--
-- Lock order is the application-record number lock, then stock rows: create_application_record_from_blend_ticket
-- takes that number lock first and the stock row after. complete_job used to take stock rows first (the hold
-- sync, trg_release_job_holds_on_lifecycle, and trg_zz_lock_job_stock_rows, both on the status update) and the
-- number lock only later (next_application_record_number), so a job and a blend ticket, or a quote-linked job
-- and another job, could deadlock. complete_job now takes
-- pg_advisory_xact_lock(hashtext('next_application_record_number')) right after its own idempotency-key check,
-- before the body's status update. Every later take of that lock in the same transaction returns at once.
--
-- Job completion locked existing stock rows (trg_zz_lock_job_stock_rows, KI-150) but still inserted a
-- missing row inside _complete_job_replay_impl_20261015, in chemical order, with no conflict handling.
-- Delivery completion already waits instead (#1942): existing rows in product order, then each missing
-- row created in that same order and locked. The trigger now does the same, but only when complete_job
-- itself is completing this job: complete_job marks the job in a transaction-local setting
-- (crx.complete_job_rpc). Any other status change to completed (a direct table update) keeps today's
-- behaviour exactly: existing rows locked in product order, nothing created.
--
-- A missing row is inserted at zero (the same columns the deduction insert uses) with ON CONFLICT DO
-- NOTHING, then locked. The deduction loop then finds the row and subtracts, so the on-hand, the
-- job_applied ledger row and the short-stock flag end where they do today for one job. A saved
-- completion receipt returns before the status update, so a retry creates nothing.
--
-- idempotency-body-check: complete_job's key check, fingerprint and receipt binding are unchanged; the
--   number lock and the completion mark come after check_idempotency_intent. The trigger has no key.
-- auth: before the shared number lock, a new caller (no saved receipt) must be admin, sales_rep or an
--   active applicator; every branch of the body's own check needs one of these, so nobody it allows is
--   refused, and other signed-in roles cannot queue on that lock. A replay takes no lock.
-- caller-analysis: complete_job :: public RPC, same signature, grants unchanged (authenticated,
--   service_role); callers: the field app and process_offline_action. _lock_job_stock_rows_in_order ::
--   trigger only; EXECUTE stays revoked from PUBLIC, anon, authenticated and service_role.
--
-- ROLLBACK: scripts/smoke/job-completion-missing-stock-rows-reverse.sql
--   (proven by scripts/smoke/prove-job-completion-missing-stock-rows-real-schema.mjs).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_fn record;
  v_job record;
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
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'trg_zz_lock_job_stock_rows' AND NOT t.tgisinternal
         AND t.tgfoid = v_fn.oid AND t.tgenabled IN ('O', 'A')
         AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_zz_lock_job_stock_rows AFTER UPDATE OF status ON public.jobs FOR EACH ROW WHEN (((old.status = ANY (ARRAY[''scheduled''::text, ''in_progress''::text])) AND (new.status = ''completed''::text) AND (new.deleted_at IS NULL))) EXECUTE FUNCTION _lock_job_stock_rows_in_order()') <> 1 THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_PREFLIGHT: trg_zz_lock_job_stock_rows is not the reviewed enabled trigger';
  END IF;

  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO v_job
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.complete_job(uuid, jsonb, uuid, text)');
  IF v_job.oid IS NULL OR md5(replace(v_job.prosrc, chr(13), '')) IS DISTINCT FROM '6ec962c198bf326b4ef773fa8d8d5edc'
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'complete_job') <> 1 THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_PREFLIGHT: complete_job is not the reviewed single wrapper';
  END IF;
  IF NOT v_job.prosecdef OR v_job.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('public', v_job.oid, 'EXECUTE')
     OR has_function_privilege('anon', v_job.oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_job.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_job.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_PREFLIGHT: complete_job''s security, search_path or grants changed';
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

  -- Only complete_job creates rows (it marked this job and already holds the number lock). A direct
  -- status update deducts nothing, so it must not leave a zero row behind.
  IF current_setting('crx.complete_job_rpc', true) IS DISTINCT FROM NEW.id::text THEN
    RETURN NULL;
  END IF;

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
  -- Number lock before any stock row (the hold sync and trg_zz_lock_job_stock_rows run on the body's status
  -- update), the same order as create_application_record_from_blend_ticket. Then mark this job so the trigger
  -- creates its missing stock rows; the mark ends with the transaction. A saved receipt returns before the
  -- body's status update, so a replay takes no lock. Only roles the body can authorize reach the shared lock
  -- (every branch of the body's check needs admin, sales_rep or an active applicator); same message.
  IF v_replay IS NULL THEN
    IF NOT (public.is_admin() OR public.is_sales_rep() OR public.is_applicator()) THEN
      RAISE EXCEPTION 'Not authorized to complete this job';
    END IF;
    -- The job row first, as the body and process_offline_action already take it, then the number lock.
    PERFORM 1 FROM public.jobs j WHERE j.id = p_job_id FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtext('next_application_record_number'));
  END IF;
  PERFORM set_config('crx.complete_job_rpc', p_job_id::text, true);
  v_result := public._complete_job_replay_impl_20261015(p_job_id, p_applied_info, p_performed_by, p_idempotency_key);
  PERFORM set_config('crx.complete_job_rpc', '', true);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'complete_job', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_fn record;
  v_job record;
BEGIN
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO v_fn
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._lock_job_stock_rows_in_order()');
  IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM 'e3344479412462cc3bdecee378f4d495' THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_POSTFLIGHT: the lock function is not the reviewed body';
  END IF;
  IF NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('public', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_POSTFLIGHT: security, search_path or grants changed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'trg_zz_lock_job_stock_rows' AND NOT t.tgisinternal
         AND t.tgfoid = v_fn.oid AND t.tgenabled IN ('O', 'A')
         AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_zz_lock_job_stock_rows AFTER UPDATE OF status ON public.jobs FOR EACH ROW WHEN (((old.status = ANY (ARRAY[''scheduled''::text, ''in_progress''::text])) AND (new.status = ''completed''::text) AND (new.deleted_at IS NULL))) EXECUTE FUNCTION _lock_job_stock_rows_in_order()') <> 1 THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_POSTFLIGHT: trg_zz_lock_job_stock_rows is not the reviewed enabled trigger';
  END IF;

  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO v_job
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.complete_job(uuid, jsonb, uuid, text)');
  IF v_job.oid IS NULL OR md5(replace(v_job.prosrc, chr(13), '')) IS DISTINCT FROM 'a24a546d75428042843d8a4e764e3b37'
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'complete_job') <> 1 THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_POSTFLIGHT: complete_job is not the reviewed single wrapper';
  END IF;
  IF NOT v_job.prosecdef OR v_job.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('public', v_job.oid, 'EXECUTE')
     OR has_function_privilege('anon', v_job.oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_job.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_job.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'JOB_STOCK_ROW_POSTFLIGHT: complete_job''s security, search_path or grants changed';
  END IF;
END;
$postflight$;
