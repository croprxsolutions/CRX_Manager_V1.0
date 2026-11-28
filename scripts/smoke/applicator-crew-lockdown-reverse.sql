-- Corrective-migration body for the applicator crew base-read lockdown. Run as ONE transaction (psql -1 or the apply script).
-- This restores the six policies that let crew read price-bearing base tables.
-- Running it re-opens those reads and requires Mason's yes under the contract's Undo / recovery rule.

SET LOCAL lock_timeout = '1s'; -- fail fast on each lock wait, as in the migration; then re-run

CREATE TEMP TABLE applicator_crew_lockdown_reverse_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $reverse_preflight$
DECLARE
  v_sp text := current_setting('search_path');
BEGIN
  -- The ON COMMIT DROP marker is gone under autocommit: refuse before restoring any policy.
  IF to_regclass('pg_temp.applicator_crew_lockdown_reverse_tx') IS NULL THEN
    RAISE EXCEPTION 'REVERSE_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.applicator_crew_lockdown_reverse_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'REVERSE_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;

  -- Replace only the exact four office-only policies the lockdown wrote; anything later (a tightened rep rule,
  -- an extra policy) must be reconciled by hand instead of being silently overwritten.
  PERFORM set_config('search_path', 'pg_catalog', true);
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
         AND cmd IN ('SELECT','ALL')) <> 4
     OR EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
          AND cmd IN ('SELECT','ALL')
          AND (permissive <> 'PERMISSIVE'
            OR cmd <> 'SELECT'
            OR roles <> '{authenticated}'::name[]
            OR with_check IS NOT NULL
            OR (tablename, policyname) NOT IN (('jobs','jobs_select'),
                                               ('job_chemicals','job_chemicals_select'),
                                               ('job_field_shares','job_field_shares_select'),
                                               ('field_billing_defaults','fbd_select'))
            OR qual IS DISTINCT FROM '(public.is_admin() OR public.is_sales_rep())')) THEN
    RAISE EXCEPTION 'REVERSE_FAIL: the current SELECT policies are not the four the lockdown wrote; reconcile by hand';
  END IF;
  PERFORM set_config('search_path', v_sp, true);
END
$reverse_preflight$;

DROP POLICY jobs_select ON public.jobs;
CREATE POLICY jobs_select ON public.jobs AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep() OR public._is_job_applicator(id));

CREATE POLICY jobs_select_location_dispatchee ON public.jobs AS PERMISSIVE FOR SELECT TO authenticated
  USING (public._is_dispatched_to_me(id));

DROP POLICY job_chemicals_select ON public.job_chemicals;
CREATE POLICY job_chemicals_select ON public.job_chemicals AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS (SELECT 1
    FROM public.jobs_crew jobs
    WHERE jobs.id = job_chemicals.job_id
      AND (public.is_admin() OR public.is_sales_rep()
        OR (public.is_applicator() AND jobs.applicator_id = (SELECT auth.uid()))))));

CREATE POLICY job_chemicals_select_location_dispatchee ON public.job_chemicals AS PERMISSIVE FOR SELECT TO authenticated
  USING (public._is_dispatched_to_me(job_id));

DROP POLICY job_field_shares_select ON public.job_field_shares;
CREATE POLICY job_field_shares_select ON public.job_field_shares AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep() OR public._is_job_applicator(job_id)
    OR (public.is_applicator() AND public._is_dispatched_to_me(job_id)));

DROP POLICY fbd_select ON public.field_billing_defaults;
CREATE POLICY fbd_select ON public.field_billing_defaults AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep()
    OR (public.is_applicator() AND public._can_see_field(field_id)));

DO $verify_restore$
DECLARE
  v_sp text := current_setting('search_path');
  v_hash text;
  v_count integer;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);
  SELECT md5(string_agg(tablename||'.'||policyname||'|'||permissive||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\n'
                        ORDER BY tablename COLLATE "C", policyname COLLATE "C")), count(*)
    INTO v_hash, v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
     AND cmd IN ('SELECT','ALL');
  PERFORM set_config('search_path', v_sp, true);
  IF v_count <> 6 OR v_hash IS DISTINCT FROM '82812af55c7565208df9dfaf907f8869' THEN
    RAISE EXCEPTION 'REVERSE_FAIL: restored policies differ from the six original crew policies';
  END IF;
END
$verify_restore$;
