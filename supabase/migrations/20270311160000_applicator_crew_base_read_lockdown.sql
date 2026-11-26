-- Migration: applicator crew base-table read lockdown
-- STATUS: NOT APPLIED
-- Record: docs/reference/migrations.d/20270311160000_applicator_crew_base_read_lockdown.md
-- Contract: docs/plans/2026-11-25-applicator-crew-read-path-CONTRACT.md (PR 3, step 5).
--
-- WHAT: Limit SELECT on the four price-bearing job base tables to admins and sales reps.
-- BEHAVIOR: Applicators, location dispatchees and crew members no longer receive rows from these base tables.
--   Their existing read-only crew views keep serving the app. Admin and sales rep reads stay the same.
-- NOT CHANGED: Any write policy, grant, view, function or data.
-- ROLLBACK: A reviewed corrective migration can restore the six old policies with
--   scripts/smoke/applicator-crew-lockdown-reverse.sql. That re-opens crew price reads and needs Mason's yes
--   under the contract's Undo / recovery rule.
-- PRECONDITION: the frontend that reads the crew views (PR #2574) is live first, so no current screen reads these
--   base tables as crew. A tab still open from before that deploy shows empty crew lists until it reloads.

-- Fail fast: while the four ACCESS EXCLUSIVE locks are being taken, readers of an already-locked table wait behind
-- this transaction. lock_timeout caps only each lock wait (1s; on timeout nothing has changed and the apply is re-run).
-- Once all locks are held, readers wait for the rest of this short transaction: catalog checks and six policy
-- statements, no data scans. Apply it in a quiet window.
SET LOCAL lock_timeout = '1s';

CREATE TEMP TABLE applicator_crew_base_read_lockdown_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_sp text := current_setting('search_path');
  v_hash text;
  v_count integer;
BEGIN
  -- The ON COMMIT DROP marker is gone under autocommit: refuse before changing any policy.
  IF to_regclass('pg_temp.applicator_crew_base_read_lockdown_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.applicator_crew_base_read_lockdown_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;

  IF to_regclass('public.jobs_crew') IS NULL
     OR to_regclass('public.job_chemicals_crew') IS NULL
     OR to_regclass('public.job_field_shares_crew') IS NULL
     OR to_regclass('public.field_billing_defaults_crew') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: all four crew views must exist before base-table access is removed';
  END IF;

  -- Hold every checked table and view until commit, so no RLS setting, view definition, owner or option checked
  -- below can change before the new policies commit (a grant change takes no lock; the postflight re-checks it).
  -- LOCK TABLE on a view would also lock what it reads (catalogs included), so each view is held instead by a
  -- zero-row read, whose ACCESS SHARE lock blocks CREATE OR REPLACE / ALTER VIEW until commit.
  LOCK TABLE public.jobs, public.job_chemicals, public.job_field_shares, public.field_billing_defaults IN ACCESS EXCLUSIVE MODE;
  PERFORM 1 FROM public.jobs_crew LIMIT 0;
  PERFORM 1 FROM public.job_chemicals_crew LIMIT 0;
  PERFORM 1 FROM public.job_field_shares_crew LIMIT 0;
  PERFORM 1 FROM public.field_billing_defaults_crew LIMIT 0;

  -- The crew views read the base tables as their owner; that only works while the owner bypasses RLS,
  -- no view runs as the caller, and the base tables have RLS on (so the policies apply) without forcing it on their owner.
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
        WHERE c.oid IN ('public.jobs_crew'::regclass, 'public.job_chemicals_crew'::regclass,
                        'public.job_field_shares_crew'::regclass, 'public.field_billing_defaults_crew'::regclass)
          AND (NOT r.rolbypassrls
               OR EXISTS (SELECT 1 FROM pg_catalog.unnest(c.reloptions) o
                           WHERE o ~* '^security_invoker=(true|on|yes|1)$')))
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid IN ('public.jobs'::regclass, 'public.job_chemicals'::regclass,
                        'public.job_field_shares'::regclass, 'public.field_billing_defaults'::regclass)
          AND (c.relforcerowsecurity OR NOT c.relrowsecurity)) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: crew views must be owned by an RLS-bypassing role without security_invoker, and the base tables must have RLS on but not forced';
  END IF;

  -- Crew keep reading only through these views, so none may carry a protected column (same list as step 1).
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid IN ('public.jobs_crew'::regclass, 'public.job_chemicals_crew'::regclass,
                          'public.job_field_shares_crew'::regclass, 'public.field_billing_defaults_crew'::regclass)
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname IN ('total_price_cents','total_cost_cents','internal_memo','commission_split','price_per_unit_cents',
                         'cost_per_unit_cents','split_pct','price_override_cents','pricing_note')) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: a crew view exposes a protected column';
  END IF;

  -- After the lockdown the views are the only crew read path, so signed-in users must still be able to read them.
  IF NOT (has_table_privilege('authenticated', 'public.jobs_crew', 'SELECT')
          AND has_table_privilege('authenticated', 'public.job_chemicals_crew', 'SELECT')
          AND has_table_privilege('authenticated', 'public.job_field_shares_crew', 'SELECT')
          AND has_table_privilege('authenticated', 'public.field_billing_defaults_crew', 'SELECT')) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: authenticated must keep SELECT on all four crew views';
  END IF;

  PERFORM set_config('search_path', 'pg_catalog', true);

  -- Exact fingerprint of the four crew views (kind, owner, options, definition), taken under this
  -- search_path: any change to them since this file was written refuses the lockdown (Mason, 2026-11-26).
  SELECT md5(string_agg(c.relname||'|'||c.relkind::text||'|'||r.rolname||'|'||coalesce(c.reloptions::text,'')||'|'||pg_get_viewdef(c.oid), E'\n'
                        ORDER BY c.relname COLLATE "C"))||'|'||count(*)
    INTO v_hash
    FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('jobs_crew','job_chemicals_crew','job_field_shares_crew','field_billing_defaults_crew');
  IF v_hash IS DISTINCT FROM 'e86b95ce92e6ac220d93bd7ccfd0c645|4' THEN
    PERFORM set_config('search_path', v_sp, true);
    RAISE EXCEPTION 'PREFLIGHT_FAIL: the four crew views changed since this file was written; regenerate against the current schema';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
     AND cmd IN ('SELECT','ALL');
  IF v_count = 4
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND (tablename, policyname) IN (('jobs','jobs_select_location_dispatchee'),
                                          ('job_chemicals','job_chemicals_select_location_dispatchee'))
     ) THEN
    PERFORM set_config('search_path', v_sp, true);
    RAISE EXCEPTION 'PREFLIGHT_FAIL: already locked down (already applied?)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
       AND permissive <> 'PERMISSIVE'
  ) THEN
    PERFORM set_config('search_path', v_sp, true);
    RAISE EXCEPTION 'PREFLIGHT_FAIL: a restrictive policy exists on a protected base table';
  END IF;

  SELECT md5(string_agg(tablename||'.'||policyname||'|'||permissive||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\n'
                        ORDER BY tablename COLLATE "C", policyname COLLATE "C")), count(*)
    INTO v_hash, v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
     AND cmd IN ('SELECT','ALL');

  PERFORM set_config('search_path', v_sp, true);
  IF v_count <> 6 OR v_hash IS DISTINCT FROM '82812af55c7565208df9dfaf907f8869' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: the six crew SELECT policies changed or an extra SELECT policy exists; regenerate against the current schema';
  END IF;
END
$preflight$;

DROP POLICY jobs_select ON public.jobs;
CREATE POLICY jobs_select ON public.jobs AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY jobs_select_location_dispatchee ON public.jobs;

DROP POLICY job_chemicals_select ON public.job_chemicals;
CREATE POLICY job_chemicals_select ON public.job_chemicals AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY job_chemicals_select_location_dispatchee ON public.job_chemicals;

DROP POLICY job_field_shares_select ON public.job_field_shares;
CREATE POLICY job_field_shares_select ON public.job_field_shares AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY fbd_select ON public.field_billing_defaults;
CREATE POLICY fbd_select ON public.field_billing_defaults AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DO $postflight$
DECLARE
  v_sp text := current_setting('search_path');
  v_count integer;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);

  SELECT count(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
     AND cmd IN ('SELECT','ALL');
  IF v_count <> 4 OR EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
       AND cmd IN ('SELECT','ALL')
       AND (permissive <> 'PERMISSIVE'
         OR cmd <> 'SELECT'
         OR roles <> '{authenticated}'::name[]
         OR (tablename, policyname) NOT IN (('jobs','jobs_select'),
                                            ('job_chemicals','job_chemicals_select'),
                                            ('job_field_shares','job_field_shares_select'),
                                            ('field_billing_defaults','fbd_select'))
         OR qual IS DISTINCT FROM '(public.is_admin() OR public.is_sales_rep())')
  ) THEN
    PERFORM set_config('search_path', v_sp, true);
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly four office-only SELECT policies on the protected base tables';
  END IF;

  -- Re-checked under the preflight's locks: the new policies only protect prices while RLS stays on (and unforced) for all four tables.
  IF (SELECT count(*) FROM pg_class c
       WHERE c.oid IN ('public.jobs'::regclass, 'public.job_chemicals'::regclass,
                       'public.job_field_shares'::regclass, 'public.field_billing_defaults'::regclass)
         AND c.relrowsecurity AND NOT c.relforcerowsecurity) <> 4 THEN
    PERFORM set_config('search_path', v_sp, true);
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: row level security must stay on (and not forced) for all four protected base tables';
  END IF;

  IF NOT (has_table_privilege('authenticated', 'public.jobs_crew', 'SELECT')
          AND has_table_privilege('authenticated', 'public.job_chemicals_crew', 'SELECT')
          AND has_table_privilege('authenticated', 'public.job_field_shares_crew', 'SELECT')
          AND has_table_privilege('authenticated', 'public.field_billing_defaults_crew', 'SELECT')) THEN
    PERFORM set_config('search_path', v_sp, true);
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: authenticated must keep SELECT on all four crew views';
  END IF;

  PERFORM set_config('search_path', v_sp, true);
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
