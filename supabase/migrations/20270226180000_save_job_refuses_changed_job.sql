-- 20270226180000: a job Save is refused when the job changed after the page read it (follow-up to #2337).
--
-- Contract: docs/plans/2026-11-23-job-save-version-check-CONTRACT.md. #2337 checks this on the screen
-- (a re-read just before save_job), which leaves timing gaps; this moves the compare into save_job,
-- under the job row lock, after the replay lookup. Built on save_job as 20270226150000 (#2247) left it.
--
-- Changes:
--   1. _job_edit_version(uuid): internal. {core: md5 of the job's id, its edited columns and its field, share
--      and chemical lines (line ids included, cost left out: every cost change is a delete + insert,
--      so it changes the ids), dispatches: "job_field_id|applicator_id|crew_id|dispatch_status" per
--      location, sorted}. Left out on purpose (as #2337): updated_at, printed_at, applied/remaining
--      acres, which printing and applied records change.
--   2. job_edit_version(uuid): what JobDetail reads BEFORE its job select (a change in between then
--      refuses the save instead of slipping through). Active admins, and sales reps not denied the Job Schedule page (as edit_jobs).
--   3. save_job wrapper, same signature: 20270226150000's body plus one step. When an existing job's
--      payload carries expected_version, its shape is checked before any lock. Under the locks
--      20270226150000 already takes (the key's advisory lock, then the job row FOR UPDATE), a live
--      receipt for the key means the impl will replay or refuse (it writes nothing), so no compare;
--      otherwise the save is refused with JOB_CHANGED_SINCE_LOADED unless the version is unchanged
--      (dispatches as a set). No expected_version = today's behavior (the deployed app sends none).
--      Every 20270226150000 refusal (ACTOR_MISMATCH, INSUFFICIENT_ROLE, JOB_COMPLETED_CHEMICALS_LOCKED)
--      is kept in the same order. INSUFFICIENT_ROLE now also refuses a sales rep denied the Job Schedule
--      page, as edit_jobs (20270203110000) does (Sol round 2). With a version, the job's dispatch rows are
--      held FOR SHARE before the compare, so a crew deletion cannot change them mid-save (Sol round 2).
--
-- idempotency-body-check: exempt -- save_job's p_idempotency_key is unchanged and passed through to the
-- impl, whose replay is unchanged; the new compare is skipped exactly when that replay will answer.
-- caller-analysis: save_job :: REVOKE is from PUBLIC/anon only, restated unchanged; authenticated keeps EXECUTE, so JobDetail's call is unaffected
-- caller-analysis: job_edit_version :: new function; no caller until the screen PR (JobDetail), which runs as authenticated
-- caller-analysis: _job_edit_version :: new internal helper; called only by save_job and job_edit_version (SECURITY DEFINER, owner postgres)
--
-- Rollback: re-run 20270226150000's save_job CREATE OR REPLACE and its REVOKE/GRANT; then
--   DROP FUNCTION public.job_edit_version(uuid); DROP FUNCTION public._job_edit_version(uuid);
-- Roll back the screen first, then this: once job_edit_version is gone the screen can't load a version and
-- blocks Save, and the old save_job ignores expected_version.

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');
  IF NOT FOUND
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM 'f5444826af3b0420ec65f5708a382642'
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'JOB_VERSION_PREFLIGHT: save_job is not the reviewed 20270226150000 wrapper, or this migration already ran';
  END IF;
  IF to_regprocedure('public._job_edit_version(uuid)') IS NOT NULL OR to_regprocedure('public.job_edit_version(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_VERSION_PREFLIGHT: a job edit version function already exists';
  END IF;
END
$preflight$;

CREATE FUNCTION public._job_edit_version(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object(
    'core', md5(jsonb_build_array(
      jsonb_build_array(j.id, j.status, j.customer_id, j.job_date, j.scheduled_time, j.applicator_id, j.vehicle_id,
        j.recipe_id, j.application_service_id, j.notes, j.batch_id, j.total_acres, j.total_price_cents, j.call_date,
        j.date_proposed, j.time_proposed, j.schedule_date, j.date_expires, j.consultant_id, j.loader_comment,
        j.additional_info, j.internal_memo, j.ground_crew_id, j.carrier_rate_gpa, j.loader_tank_capacity,
        j.invoice_id, j.deleted_at AT TIME ZONE 'UTC', j.tags),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(f.id, f.field_id, f.acres_to_treat, f.planted_acres, f.crop,
                f.strip, f.pests, f.sort_order) ORDER BY f.id), '[]'::jsonb)
         FROM job_fields f WHERE f.job_id = j.id),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(s.id, s.field_id, s.customer_id, s.split_pct, s.is_primary)
                ORDER BY s.id), '[]'::jsonb)
         FROM job_field_shares s WHERE s.job_id = j.id),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.id, c.product_id, c.quantity, c.unit, c.rate_per_acre,
                c.rate_unit, c.price_per_unit_cents, c.sort_order, c.diluent_rate, c.rei_hours, c.phi_days,
                c.warehouse, c.vendor, c.customer_supplied, c.driver) ORDER BY c.id), '[]'::jsonb)
         FROM job_chemicals c WHERE c.job_id = j.id)
    )::text),
    'dispatches', (SELECT COALESCE(jsonb_agg(x.t ORDER BY x.t), '[]'::jsonb) FROM (
      SELECT d.job_field_id || '|' || COALESCE(d.applicator_id::text, '') || '|' || COALESCE(d.crew_id::text, '')
             || '|' || d.dispatch_status AS t
        FROM job_location_dispatches d WHERE d.job_id = j.id) x)
  ) END
  FROM (SELECT p_job_id AS id) k
  LEFT JOIN jobs j ON j.id = k.id
$fn$;

REVOKE ALL ON FUNCTION public._job_edit_version(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.job_edit_version(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Who may edit jobs, as edit_jobs decides it (20270203110000): a rep denied the Job Schedule page is refused.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active
                   AND (role = 'admin' OR (role = 'sales_rep' AND NOT coalesce('jobs' = ANY (denied_pages), false)))) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN public._job_edit_version(p_job_id);
END;
$fn$;

COMMENT ON FUNCTION public.job_edit_version(uuid) IS
  'Version of a job as the job page edits it (20270226180000). Read it BEFORE the job rows and send it to save_job as p_job_payload.expected_version; save_job refuses JOB_CHANGED_SINCE_LOADED if the job changed since. Admins and sales reps; carries no cost.';

REVOKE ALL ON FUNCTION public.job_edit_version(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_edit_version(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_job(p_job_id uuid, p_job_payload jsonb, p_fields jsonb, p_chemicals jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_chemicals jsonb := p_chemicals;
  v_completed boolean := false;
  v_result jsonb;
  v_before jsonb;
  v_expected jsonb := p_job_payload -> 'expected_version';
  v_replay boolean := false;
  v_current jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- A rep denied the Job Schedule page is refused, as edit_jobs (20270203110000) and job_edit_version refuse them.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true
                   AND (role = 'admin' OR (role = 'sales_rep' AND NOT coalesce('jobs' = ANY (denied_pages), false)))) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  -- The page's version (#2337 follow-up, 20270226180000): JSON null is the same as none.
  IF p_job_id IS NULL OR jsonb_typeof(v_expected) = 'null' THEN
    v_expected := NULL;
  END IF;
  IF v_expected IS NOT NULL AND (
       jsonb_typeof(v_expected) <> 'object' OR jsonb_typeof(v_expected -> 'core') IS DISTINCT FROM 'string'
       -- CASE fixes the order: the elements are read only once dispatches is known to be an array.
       OR CASE WHEN jsonb_typeof(v_expected -> 'dispatches') = 'array'
               THEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_expected -> 'dispatches') e WHERE jsonb_typeof(e) <> 'string')
               ELSE true END) THEN
    RAISE EXCEPTION 'EXPECTED_VERSION_INVALID: expected_version must be what job_edit_version returned' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_chemicals) = 'array' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(t.e -> 'rate_unit') = 'string'
                                   THEN jsonb_set(t.e, '{rate_unit}', to_jsonb(public.unit_fold_invisible(t.e ->> 'rate_unit')))
                                   ELSE t.e END ORDER BY t.o), '[]'::jsonb)
      INTO v_chemicals FROM jsonb_array_elements(p_chemicals) WITH ORDINALITY AS t(e, o);
  END IF;
  IF p_job_id IS NOT NULL THEN
    IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_idempotency_key, 0));
      -- A live receipt for the key means the impl replays it or refuses: it writes nothing, so a retry after a
      -- lost reply gets its stored result. FOR SHARE holds the receipt until commit: an expired-key sweep
      -- elsewhere cannot delete it in between and turn the impl's lookup into an unchecked first call.
      IF v_expected IS NOT NULL THEN
        PERFORM 1 FROM public.idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'save_job'
                       AND (expires_at IS NULL OR expires_at >= now()) FOR SHARE;
        v_replay := FOUND;
      END IF;
    END IF;
    SELECT j.status = 'completed' INTO v_completed FROM public.jobs j WHERE j.id = p_job_id FOR UPDATE;
    -- Under the job row lock: refuse a save over a change made after the page read the job.
    IF v_expected IS NOT NULL AND NOT v_replay THEN
      -- The job row lock does not stop a crew deletion's cascade on dispatches: hold them until commit.
      PERFORM 1 FROM public.job_location_dispatches d WHERE d.job_id = p_job_id FOR SHARE;
      v_current := public._job_edit_version(p_job_id);
      IF v_current IS NOT NULL AND (
           v_current ->> 'core' IS DISTINCT FROM v_expected ->> 'core'
           OR ARRAY(SELECT jsonb_array_elements_text(v_current -> 'dispatches') ORDER BY 1)
              IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(v_expected -> 'dispatches') ORDER BY 1)) THEN
        RAISE EXCEPTION 'JOB_CHANGED_SINCE_LOADED: This job changed after you opened it. Nothing was saved. Reload the page to see the job as it is now, then make your edits again.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF v_completed THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', jc.product_id, 'quantity', jc.quantity, 'unit', jc.unit,
                                              'customer_supplied', jc.customer_supplied)), '[]'::jsonb)
        INTO v_before FROM public.job_chemicals jc WHERE jc.job_id = p_job_id;
    END IF;
  END IF;
  IF public.is_admin() THEN
    v_result := public._save_job_cost_step2_impl(p_job_id, p_job_payload, p_fields, v_chemicals, p_performed_by, p_idempotency_key);
  ELSE
    v_result := public._save_job_cost_step2_impl(p_job_id, p_job_payload, p_fields,
      public._cost_step2_job_chemicals(p_job_id, v_chemicals), p_performed_by, p_idempotency_key);
  END IF;
  IF v_completed AND EXISTS (
       (SELECT product_id, quantity, unit, customer_supplied FROM jsonb_to_recordset(v_before) AS b(product_id uuid, quantity numeric, unit text, customer_supplied boolean)
        EXCEPT ALL
        SELECT jc.product_id, jc.quantity, jc.unit, jc.customer_supplied FROM public.job_chemicals jc WHERE jc.job_id = p_job_id)
       UNION ALL
       (SELECT jc.product_id, jc.quantity, jc.unit, jc.customer_supplied FROM public.job_chemicals jc WHERE jc.job_id = p_job_id
        EXCEPT ALL
        SELECT product_id, quantity, unit, customer_supplied FROM jsonb_to_recordset(v_before) AS b(product_id uuid, quantity numeric, unit text, customer_supplied boolean))) THEN
    RAISE EXCEPTION 'JOB_COMPLETED_CHEMICALS_LOCKED: This job is complete, so its chemicals can''t be changed: completion already took them from stock. Nothing was saved.' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_result;
END;
$function$;

-- Kept by CREATE OR REPLACE; restated so the file is self-describing.
REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

DO $postflight$
BEGIN
  IF has_function_privilege('anon', 'public.job_edit_version(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._job_edit_version(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._job_edit_version(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._job_edit_version(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.job_edit_version(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'JOB_VERSION_POSTFLIGHT: grants are not as reviewed';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid IN ('public._job_edit_version(uuid)'::regprocedure, 'public.job_edit_version(uuid)'::regprocedure)
         AND p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]) <> 2 THEN
    RAISE EXCEPTION 'JOB_VERSION_POSTFLIGHT: a job edit version function is not SECURITY DEFINER, owned by postgres, with search_path public, pg_temp';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure
                    AND md5(replace(p.prosrc, chr(13), '')) = '58fc0fedb205902364f8020bdd8312e8'
                    AND p.prosecdef AND p.proowner = 'postgres'::regrole
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'JOB_VERSION_POSTFLIGHT: save_job is not the body, owner or settings this file installs';
  END IF;
  -- The version runs against real rows (one job is enough: LANGUAGE sql bodies are checked at CREATE).
  IF EXISTS (SELECT 1 FROM jobs) AND (SELECT public._job_edit_version(j.id) FROM jobs j LIMIT 1) IS NULL THEN
    RAISE EXCEPTION 'JOB_VERSION_POSTFLIGHT: a job has no version';
  END IF;
END
$postflight$;
