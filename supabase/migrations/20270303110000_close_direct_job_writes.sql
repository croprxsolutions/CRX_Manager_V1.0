-- S-3 / PR C of docs/plans/2026-11-19-job-writes-through-rpcs-CONTRACT.md: signed-in users stop writing jobs
-- and job_fields directly; every change goes through the reviewed RPCs (edit_jobs, save_job, complete_job, ...).
-- Contract: docs/plans/2026-11-19-job-writes-through-rpcs-CONTRACT.md §3 (PR C).
--
-- Before (live, read 2026-11-22):
--   jobs: authenticated has table DELETE and column INSERT/UPDATE on 43 columns (20261022101000 L669-684).
--   job_fields: authenticated has table INSERT, UPDATE, DELETE (plus SELECT, REFERENCES).
--   anon: no write privilege on either.
--   Policies: jobs_insert  FOR INSERT WITH CHECK (is_admin() OR is_sales_rep())
--             jobs_update  FOR UPDATE USING (is_admin() OR is_sales_rep()) WITH CHECK (is_admin() OR is_sales_rep())
--             jobs_delete  FOR DELETE USING (is_admin())
--             job_fields_insert / job_fields_update / job_fields_delete: same as jobs_insert / jobs_update and
--             DELETE USING (is_admin() OR is_sales_rep()), all TO authenticated (20260215200000 L157-171).
-- After: no INSERT, UPDATE, DELETE or TRUNCATE for PUBLIC, anon or authenticated on either table; the six write
--   policies are dropped. SELECT, RLS read policies, service_role, the owner and every trigger are unchanged.
--   No rows change. Owner-rights RPCs keep writing because they run as the owner.
--
-- ROLLOUT: production's app (main) still updates jobs directly until the screens that call edit_jobs reach it.
--   Apply live only after that release is on production and old tabs have refreshed.
--
-- Rollback (its own reviewed migration):
--   GRANT DELETE ON public.jobs TO authenticated;
--   GRANT INSERT (<the 43 columns in 20261022101000 L669-684>), UPDATE (<same>) ON public.jobs TO authenticated;
--   GRANT INSERT, UPDATE, DELETE ON public.job_fields TO authenticated;
--   and re-create the six policies above.

-- Fail fast instead of queueing job reads behind the policy drops; pin how pg_policies renders the helpers.
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_temp;

DO $preflight$
DECLARE
  v_shape text;
  v_acl text;
  v_writers text;
BEGIN
  -- Every non-SELECT policy on either table (all of them, so an extra FOR ALL or write policy is caught too).
  SELECT string_agg(tablename || '.' || policyname || ':' || cmd || ':' || permissive || ':' || roles::text || ':'
                    || coalesce(qual, '-') || ':' || coalesce(with_check, '-'), ' | ' ORDER BY tablename, policyname)
    INTO v_shape
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('jobs', 'job_fields') AND cmd <> 'SELECT';
  -- The API roles' table grants, plus the column INSERT/UPDATE grants on jobs (live 2026-11-22: 43 each).
  SELECT string_agg(a, ',' ORDER BY a COLLATE "C") INTO v_acl
    FROM (SELECT c.relname || ':' || x.grantee::regrole::text || '=' || string_agg(x.privilege_type, '+' ORDER BY x.privilege_type) AS a
            FROM pg_class c, aclexplode(c.relacl) x
           WHERE c.oid IN ('public.jobs'::regclass, 'public.job_fields'::regclass)
             AND x.grantee IN ('authenticated'::regrole, 'anon'::regrole)
           GROUP BY c.relname, x.grantee
          UNION ALL
          SELECT 'jobs.columns:' || grantee || '=' || privilege_type || '*' || count(*)
            FROM information_schema.column_privileges
           WHERE table_schema = 'public' AND table_name = 'jobs' AND grantee IN ('authenticated', 'anon')
             AND privilege_type IN ('INSERT', 'UPDATE')
           GROUP BY grantee, privilege_type) s;
  IF v_shape IS NULL AND v_acl IS NOT DISTINCT FROM 'job_fields:authenticated=REFERENCES+SELECT' THEN
    RAISE EXCEPTION 'ALREADY_APPLIED_DIRECT_JOB_WRITES: direct writes to jobs and job_fields are already closed; reconcile the migration ledger';
  END IF;
  IF v_shape IS DISTINCT FROM
       'job_fields.job_fields_delete:DELETE:PERMISSIVE:{authenticated}:(is_admin() OR is_sales_rep()):-'
    || ' | job_fields.job_fields_insert:INSERT:PERMISSIVE:{authenticated}:-:(is_admin() OR is_sales_rep())'
    || ' | job_fields.job_fields_update:UPDATE:PERMISSIVE:{authenticated}:(is_admin() OR is_sales_rep()):(is_admin() OR is_sales_rep())'
    || ' | jobs.jobs_delete:DELETE:PERMISSIVE:{authenticated}:is_admin():-'
    || ' | jobs.jobs_insert:INSERT:PERMISSIVE:{authenticated}:-:(is_admin() OR is_sales_rep())'
    || ' | jobs.jobs_update:UPDATE:PERMISSIVE:{public}:(is_admin() OR is_sales_rep()):(is_admin() OR is_sales_rep())' THEN
    RAISE EXCEPTION 'PREFLIGHT_DIRECT_JOB_WRITES_DRIFT: the jobs / job_fields write policies are not the recorded shape: %', v_shape;
  END IF;
  IF v_acl IS DISTINCT FROM
       'job_fields:authenticated=DELETE+INSERT+REFERENCES+SELECT+UPDATE,jobs.columns:authenticated=INSERT*43,'
    || 'jobs.columns:authenticated=UPDATE*43,jobs:authenticated=DELETE' THEN
    RAISE EXCEPTION 'PREFLIGHT_DIRECT_JOB_WRITES_DRIFT: the API roles'' grants on jobs / job_fields are not the recorded shape: %', v_acl;
  END IF;

  -- The screens' replacement path must exist first: edit_jobs (20270203110000, PR A), callable by signed-in users.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'edit_jobs'
                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'PREFLIGHT_DIRECT_JOB_WRITES_DRIFT: public.edit_jobs is missing or not executable by authenticated; apply 20270203110000 first';
  END IF;

  -- A function that runs as the caller and writes either table would break once the grants go. Dynamic SQL cannot
  -- be read statically; the live reads on 2026-11-22 and 2026-11-24 found no caller-rights function that writes either
  -- table. pg_get_function_sqlbody adds SQL-standard (BEGIN ATOMIC) bodies, which prosrc leaves empty.
  SELECT string_agg(p.oid::regprocedure::text, ', ')
    INTO v_writers
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT p.prosecdef
     AND (p.prosrc || ' ' || coalesce(pg_get_function_sqlbody(p.oid), '')) ~* '(update|insert\s+into|delete\s+from|merge\s+into|truncate(\s+table)?)\s+(only\s+)?("?public"?\.)?"?(jobs|job_fields)\M';
  IF v_writers IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DIRECT_JOB_WRITES_DRIFT: these caller-rights functions write jobs or job_fields: %', v_writers;
  END IF;
END
$preflight$;

-- Both REVOKEs are needed: the table REVOKE closes table-level writes, and the column REVOKE below names every
-- jobs column so no column-level INSERT/UPDATE grant survives. The postcheck and the prover (86 before, 0 after)
-- prove it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.jobs, public.job_fields FROM PUBLIC, anon, authenticated;

DO $column_revoke$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.jobs'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s) ON public.jobs FROM PUBLIC, anon, authenticated', v_cols);
END
$column_revoke$;

DROP POLICY jobs_insert ON public.jobs;
DROP POLICY jobs_update ON public.jobs;
DROP POLICY jobs_delete ON public.jobs;
DROP POLICY job_fields_insert ON public.job_fields;
DROP POLICY job_fields_update ON public.job_fields;
DROP POLICY job_fields_delete ON public.job_fields;

DO $postcheck$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rl, tb, pv FROM unnest(ARRAY['anon', 'authenticated']) rl,
                                  unnest(ARRAY['public.jobs', 'public.job_fields']) tb,
                                  unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) pv LOOP
    IF has_table_privilege(r.rl, r.tb, r.pv)
       OR (r.pv IN ('INSERT', 'UPDATE') AND has_any_column_privilege(r.rl, r.tb, r.pv)) THEN
      RAISE EXCEPTION 'POSTCHECK_DIRECT_JOB_WRITES: % still has % on %', r.rl, r.pv, r.tb;
    END IF;
  END LOOP;
  IF NOT has_any_column_privilege('authenticated', 'public.jobs', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.job_fields', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.job_fields', 'REFERENCES') THEN
    RAISE EXCEPTION 'POSTCHECK_DIRECT_JOB_WRITES: authenticated lost read (or job_fields REFERENCES) access';
  END IF;
END
$postcheck$;
