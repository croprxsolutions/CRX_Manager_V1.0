-- #1979 PR C: signed-in users can no longer add, change or delete spray jobs directly.
-- Contract: docs/plans/2026-11-19-job-writes-through-rpcs-CONTRACT.md (section 3, Open decision 1).
-- Decision (Mason, 2026-11-19, "close it"): remove direct job writes, including admins' unused direct
-- hard delete, as done for job lines on 2026-11-06.
--
-- WHY: an admin or sales rep can today UPDATE jobs directly through the database API, for example mark a
--   job completed without the completion step. Every app screen now writes jobs through a checked server
--   function (save_job, edit_jobs, start_job, complete_job, assign_job_applicator, quote-to-job, invoice
--   transfer, scheduler; all SECURITY DEFINER, owned by postgres), so the direct path is unused.
--
-- WHAT: revoke INSERT, UPDATE, DELETE and TRUNCATE on public.jobs (table and every column) from PUBLIC,
--   authenticated and anon; drop the policies jobs_insert, jobs_update and jobs_delete. Reading jobs
--   (jobs_select, jobs_select_location_dispatchee and the SELECT grants) is unchanged. service_role,
--   postgres and metabase_ro are unchanged. No row changes. Row Level Security stays enabled.
--
-- APPLY ORDER: only after 20270131100000 (edit_jobs) is live and the screen PR has been on production long
--   enough that no open tab still runs the old screens. An old tab's save is refused ("permission denied",
--   nothing saved); a refresh fixes it.
--
-- PRE-STATE (live, read-only, 2026-11-19):
--   authenticated: table DELETE; column INSERT and UPDATE on these 43 columns (all but completed_at,
--     remaining_acres and total_cost_cents): additional_info, application_service_id, applicator_id, applied_acres, batch_id,
--     batch_ref, call_date, carrier_rate_gpa, commission_split, consultant_id, created_at, created_by,
--     customer_id, date_expires, date_proposed, deleted_at, estimated_hours, ground_crew_id, id,
--     internal_memo, invoice_id, job_date, job_number, last_printed_by, loader_comment,
--     loader_tank_capacity, notes, printed_at, priority, quote_id, quote_section_id, recipe_id,
--     schedule_date, scheduled_time, season, status, tags, time_proposed, total_acres, total_price_cents,
--     updated_at, updated_by, vehicle_id. anon and PUBLIC: no write grant.
--   Policies (all PERMISSIVE): jobs_insert FOR INSERT TO authenticated WITH CHECK (is_admin() OR is_sales_rep());
--     jobs_update FOR UPDATE TO public USING (is_admin() OR is_sales_rep()) WITH CHECK (is_admin() OR is_sales_rep());
--     jobs_delete FOR DELETE TO authenticated USING (is_admin()).
--
-- ROLLBACK (restores the pre-state exactly; a permission change, so it needs Mason's approval):
--   CREATE POLICY jobs_insert ON public.jobs FOR INSERT TO authenticated WITH CHECK (is_admin() OR is_sales_rep());
--   CREATE POLICY jobs_update ON public.jobs FOR UPDATE TO public USING (is_admin() OR is_sales_rep()) WITH CHECK (is_admin() OR is_sales_rep());
--   CREATE POLICY jobs_delete ON public.jobs FOR DELETE TO authenticated USING (is_admin());
--   GRANT DELETE ON public.jobs TO authenticated;
--   DO $rb$ DECLARE c text := 'additional_info, application_service_id, applicator_id, applied_acres, batch_id,
--     batch_ref, call_date, carrier_rate_gpa, commission_split, consultant_id, created_at, created_by, customer_id,
--     date_expires, date_proposed, deleted_at, estimated_hours, ground_crew_id, id, internal_memo, invoice_id,
--     job_date, job_number, last_printed_by, loader_comment, loader_tank_capacity, notes, printed_at, priority,
--     quote_id, quote_section_id, recipe_id, schedule_date, scheduled_time, season, status, tags, time_proposed,
--     total_acres, total_price_cents, updated_at, updated_by, vehicle_id';
--   BEGIN EXECUTE format('GRANT INSERT (%1$s), UPDATE (%1$s) ON public.jobs TO authenticated', c); END $rb$;

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.edit_jobs(uuid[],jsonb,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'JOBS_DIRECT_WRITES_PREFLIGHT: edit_jobs (20270131100000) must be applied first';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'jobs'
        AND policyname IN ('jobs_insert', 'jobs_update', 'jobs_delete')) <> 3 THEN
    RAISE EXCEPTION 'JOBS_DIRECT_WRITES_PREFLIGHT: the three write policies are not all present (already applied?)';
  END IF;
END
$preflight$;

-- Both REVOKEs are needed: the table-level one, and the column-level one naming every column
-- (the INSERT and UPDATE grants are column lists). The postflight checks no column is left writable.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.jobs FROM PUBLIC, authenticated, anon;
DO $revoke_cols$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.jobs'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s) ON public.jobs FROM PUBLIC, authenticated, anon', v_cols);
END
$revoke_cols$;

DROP POLICY jobs_insert ON public.jobs;
DROP POLICY jobs_update ON public.jobs;
DROP POLICY jobs_delete ON public.jobs;

DO $postflight$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['authenticated', 'anon', 'public']) r(role), unnest(ARRAY['INSERT', 'UPDATE']) v(priv)
              WHERE has_any_column_privilege(r.role, 'public.jobs', v.priv))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['authenticated', 'anon', 'public']) r(role), unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) v(priv)
                 WHERE has_table_privilege(r.role, 'public.jobs', v.priv))
     OR has_table_privilege('authenticated', 'public.jobs', 'TRUNCATE') OR has_table_privilege('anon', 'public.jobs', 'TRUNCATE')
     OR has_table_privilege('public', 'public.jobs', 'TRUNCATE') THEN
    RAISE EXCEPTION 'JOBS_DIRECT_WRITES_POSTFLIGHT: an app role can still write jobs directly';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.jobs', 'status', 'SELECT')
     OR NOT has_function_privilege('authenticated', 'public.edit_jobs(uuid[],jsonb,text,uuid,text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'jobs' AND cmd <> 'SELECT')
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'jobs'
          AND policyname IN ('jobs_select', 'jobs_select_location_dispatchee')) <> 2
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.jobs'::regclass) THEN
    RAISE EXCEPTION 'JOBS_DIRECT_WRITES_POSTFLIGHT: reads, edit_jobs or Row Level Security changed, or a write policy is left';
  END IF;
END
$postflight$;
