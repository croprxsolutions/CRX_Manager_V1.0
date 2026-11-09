-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261217100000_job_access_ends_with_the_job.md.
--
-- WHAT (KI-01 part C and KI-73 in docs/manual/KNOWN_ISSUES.md; To-Do row 11.4): field access
-- ends when the job ends, and an applicator sent to a job by dispatch reads the rest of that job.
-- Customer addresses are left as they are (Mason, 2026-11-08: drivers keep the delivery address on
-- FieldStop, and applicators keep theirs as is). Live before this file (read-only, 2026-11-08):
--   jobs_select and every job-table policy that looks the job up through `jobs`
--                     the whole-job applicator (jobs.applicator_id) reads the job, its fields,
--                     chemicals, shares, completion records, attachments and photos FOREVER:
--                     after it is completed, cancelled or soft-deleted, with no end date.
--   _is_dispatched_to_me
--                     a current dispatch keeps granting the job after the job is soft-deleted
--                     (jobs_select_location_dispatchee, job_fields/job_chemicals/customers dispatch
--                     policies, and every function that calls it).
--   start_job, complete_job, stage_offline_action (their whole-job leg), stamp_job_printed,
--   get_job_fields_with_geojson, get_job(s)_billed_customers, get_dispatch_board_jobs,
--   get_dispatched_list, _can_see_field
--                     SECURITY DEFINER, so they skip row security and carry their own copy of the
--                     unbounded whole-job test (the field functions refused a deleted job, nothing else).
--   job_field_shares, job_applied_info, job_applied_records (+ _fields, + _crew), job_attachments,
--   storage job-attachments objects
--                     a dispatch-only applicator, who reads the job, its fields and chemicals, cannot
--                     read these (KI-73 "opposite gap", LOW).
--
-- MASON'S DECISION (2026-10-25, DECISION_LOG.md): someone sent to a job sees the entire job while the
--   assignment is current; "a cancelled dispatch, one completed more than 7 days ago, a deleted job, an
--   inactive profile or crew ends it, and part C adds the window to the whole-job applicator".
--
-- HOW:
--   * NEW public._is_job_applicator(job id): the caller is an active applicator, is the job's whole-job
--     applicator, the job is not soft-deleted, and the job is scheduled or in progress, or completed or
--     invoiced within the last 7 days (jobs.completed_at). Cancelled: never.
--   * NEW column jobs.completed_at, owned by the NEW trigger trg_stamp_job_completed_at: the server clock
--     when the job first reaches completed or invoiced, kept while it stays there, cleared if it leaves.
--     Nothing a client sends can set or move it. Not updated_at (printing a job bumps it), not
--     actual_end_time (typed by the applicator), and not job_date: a job completed long before or long
--     after its scheduled date must close 7 days after the work, not when the date comes round. Existing
--     completed or invoiced jobs keep NULL, which grants nothing (live 2026-11-08: one invoiced job, its
--     date long past, so nobody loses access they have today). The usual whole-job applicator also holds
--     the per-field dispatch rows the assign trigger writes, whose "completed within 7 days" tail
--     (_is_dispatched_to_me) still applies on its own.
--   * jobs_select: the whole-job leg becomes _is_job_applicator(id). Every policy that reaches the job
--     through a subquery on `jobs` (job_fields, job_chemicals, job_tag_assignments,
--     job_loader_worksheets, job_location_dispatches, customers, the job_applied_* and job_attachments
--     writes, the storage job-attachments insert/delete) runs that subquery under jobs' row security,
--     so it inherits the window without being edited (the prover reads job_fields, customers, the
--     job_applied_* and attachment tables directly; job_chemicals, job_tag_assignments and
--     job_loader_worksheets use the same subquery and the preflight pins their exact policy text).
--   * _is_dispatched_to_me, _can_see_field's dispatch leg and get_dispatched_list: the job must also not be
--     soft-deleted or cancelled (a dispatch completed before an office cancel no longer keeps it open).
--   * job_location_dispatches_select: its two dispatchee legs (the assigned applicator, an active crew
--     member) also need _is_dispatched_to_me(job_id), so a soft-deleted job's open dispatch row is not
--     readable. Its whole-job leg already reaches the job through jobs' row security.
--   * The SECURITY DEFINER functions above: only their whole-job leg changes, to _is_job_applicator
--     (each line marked "KI-73 part C"). _can_see_field's whole-job leg likewise.
--   * Dispatch-only applicators gain reads (never writes) of the job's saved shares, completion info,
--     completion records and their field and crew rows, attachments and attachment photos:
--     is_applicator() AND _is_dispatched_to_me(job). A driver in a ground crew does not, as for the
--     field tables (DECISION_LOG 2026-10-25, "Which roles").
--
-- NOT CHANGED: what an active admin or sales rep reads or writes; application_records and its lots
--   (an applicator keeps their own spray records, Record Book); every billing, invoice, quote, sale and
--   commission function (_save_field_app_split_invoice_impl, _save_job_cost_step2_impl,
--   _transfer_job_to_invoice_intent_impl_20260908 are office-only and untouched); function signatures,
--   return types, owner, grants, search_path, volatility, SECURITY DEFINER (CREATE OR REPLACE keeps each
--   OID); policy names, roles and commands; no existing row changes (the new column starts NULL).
--
-- EXPECTED NARROWING (by design): a whole-job applicator loses a cancelled or deleted job at once, and a
--   completed one 7 days after it was completed; nobody reads a deleted job's dispatch rows. A dispatch-only
--   applicator gains the reads above.
--
-- ROLLBACK: re-run the pinned live bodies and policy texts (the preflight's pins; bodies in the git history
--   of this file's parents), then DROP FUNCTION public._is_job_applicator(uuid); DROP TRIGGER
--   trg_stamp_job_completed_at ON public.jobs; DROP FUNCTION public._stamp_job_completed_at();
--   ALTER TABLE public.jobs DROP COLUMN completed_at (it holds only the server's completion stamps).

SET LOCAL lock_timeout = '5s';
-- Policy expressions are printed relative to the search_path; fix it so the pinned texts compare.
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE job_access_ends_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

CREATE TEMP TABLE job_access_ends_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
       p.proconfig, p.prorettype, p.provolatile, p.prosecdef
  FROM pg_proc p
 WHERE false;

DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  -- Two statements: one OR would plan the marker lookup even when the marker is missing.
  IF to_regclass('pg_temp.job_access_ends_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.job_access_ends_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regprocedure('public._is_job_applicator(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_ACCESS_BASELINE_DRIFT: public._is_job_applicator(uuid) already exists (already applied?)';
  END IF;
  IF to_regprocedure('public._stamp_job_completed_at()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.jobs'::regclass AND attname = 'completed_at')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'trg_stamp_job_completed_at') THEN
    RAISE EXCEPTION 'JOB_ACCESS_BASELINE_DRIFT: jobs.completed_at or its trigger already exists';
  END IF;

  -- The eleven functions this file replaces, exactly as live has them (2026-11-08).
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public._is_dispatched_to_me(uuid)',                                                                                '7ea61d7104f9d26fa62cae5fcd3522a1'),
      ('public._can_see_field(uuid)',                                                                                      '32cf69a9a79a6d62a9ba255777de199a'),
      ('public._start_job_replay_impl_20261015(uuid,uuid,text)',                                                           '8e9b5356c6019cee2f82f37a30d018e1'),
      ('public._complete_job_replay_impl_20261015(uuid,jsonb,uuid,text)',                                                  '478db22f4cbdc65e1beda18f5ffc9e47'),
      ('public.stage_offline_action(uuid,text,uuid,integer,timestamp with time zone,jsonb,text,timestamp with time zone)', '7302576d5df36fa447b39b72d1e58556'),
      ('public.stamp_job_printed(uuid,text)',                                                                              'b4686bf6a55df4f60def76eb10d8731c'),
      ('public.get_job_fields_with_geojson(uuid)',                                                                         'c42bf2515ec81fd9727da08757f5d790'),
      ('public.get_jobs_billed_customers(uuid[])',                                                                         '258d9f5722a43de1b388931c99b22ee5'),
      ('public.get_job_billed_customers(uuid)',                                                                            'f5d065a4d29205511e38a099d9680a86'),
      ('public.get_dispatch_board_jobs(uuid,text,date,date)',                                                              '7795522b437d296121437ca237d9e588'),
      ('public.get_dispatched_list(uuid,uuid)',                                                                            '00a961e63d243e4d8d162a1e267b3624')
    ) AS t(sig, live_md5)
  LOOP
    IF (SELECT count(*) FROM pg_proc
         WHERE proname = split_part(replace(v_pin.sig, 'public.', ''), '(', 1)
           AND pronamespace = 'public'::regnamespace) <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % must have exactly one overload', v_pin.sig;
    END IF;
    SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(v_pin.sig);
    IF v_md5 IS DISTINCT FROM v_pin.live_md5 THEN
      RAISE EXCEPTION 'JOB_ACCESS_BASELINE_DRIFT: % is %', v_pin.sig, v_md5;
    END IF;
    INSERT INTO pg_temp.job_access_ends_attrs
    SELECT p.oid, pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig, p.prorettype, p.provolatile, p.prosecdef
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig);
  END LOOP;

  -- The SELECT policies this file rewrites, exactly as live has them (row security on, not forced),
  -- and how many permissive SELECT/ALL policies each table has, so none re-admits what is narrowed.
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public', 'jobs', 'jobs_select', '{authenticated}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND (applicator_id = ( SELECT auth.uid() AS uid))))', 2),
      ('public', 'job_location_dispatches', 'job_location_dispatches_select', '{authenticated}', E'(is_admin() OR is_sales_rep() OR ((dispatch_status = \'dispatched\'::text) AND (applicator_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1\n   FROM profiles p\n  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND p.is_active)))) OR ((dispatch_status = \'dispatched\'::text) AND (crew_id IS NOT NULL) AND (EXISTS ( SELECT 1\n   FROM profiles p\n  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND p.is_active))) AND (EXISTS ( SELECT 1\n   FROM (ground_crew_members gcm\n     JOIN ground_crews gc ON ((gc.id = gcm.crew_id)))\n  WHERE ((gcm.crew_id = job_location_dispatches.crew_id) AND (gcm.profile_id = ( SELECT auth.uid() AS uid)) AND gcm.is_active AND gc.is_active)))) OR (EXISTS ( SELECT 1\n   FROM jobs j\n  WHERE ((j.id = job_location_dispatches.job_id) AND is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))', 1),
      ('public', 'job_field_shares', 'job_field_shares_select', '{authenticated}', E'(EXISTS ( SELECT 1\n   FROM jobs\n  WHERE ((jobs.id = job_field_shares.job_id) AND (is_admin() OR is_sales_rep() OR (is_applicator() AND (jobs.applicator_id = ( SELECT auth.uid() AS uid)))))))', 1),
      ('public', 'job_applied_info', 'job_applied_info_select', '{authenticated}', E'(EXISTS ( SELECT 1\n   FROM jobs\n  WHERE ((jobs.id = job_applied_info.job_id) AND (is_admin() OR is_sales_rep() OR (is_applicator() AND (jobs.applicator_id = ( SELECT auth.uid() AS uid)))))))', 1),
      ('public', 'job_applied_records', 'job_applied_records_select', '{authenticated}', E'(EXISTS ( SELECT 1\n   FROM jobs\n  WHERE ((jobs.id = job_applied_records.job_id) AND (is_admin() OR is_sales_rep() OR (is_applicator() AND (jobs.applicator_id = ( SELECT auth.uid() AS uid)))))))', 1),
      ('public', 'job_applied_record_fields', 'job_applied_record_fields_select', '{authenticated}', E'(EXISTS ( SELECT 1\n   FROM (job_applied_records r\n     JOIN jobs j ON ((j.id = r.job_id)))\n  WHERE ((r.id = job_applied_record_fields.application_record_id) AND (is_admin() OR is_sales_rep() OR (is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid)))))))', 1),
      ('public', 'job_applied_record_crew', 'job_applied_record_crew_select', '{authenticated}', E'(EXISTS ( SELECT 1\n   FROM (job_applied_records r\n     JOIN jobs j ON ((j.id = r.job_id)))\n  WHERE ((r.id = job_applied_record_crew.application_record_id) AND (is_admin() OR is_sales_rep() OR (is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid)))))))', 1),
      ('public', 'job_attachments', 'job_attachments_select', '{authenticated}', E'(is_admin() OR is_sales_rep() OR (is_applicator() AND (EXISTS ( SELECT 1\n   FROM jobs j\n  WHERE ((j.id = job_attachments.job_id) AND (j.applicator_id = ( SELECT auth.uid() AS uid)))))))', 1),
      ('storage', 'objects', 'job_attachments_objects_select', '{authenticated}', E'((bucket_id = \'job-attachments\'::text) AND (is_admin() OR is_sales_rep() OR (is_applicator() AND (EXISTS ( SELECT 1\n   FROM jobs j\n  WHERE (((j.id)::text = (storage.foldername(objects.name))[1]) AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))))', NULL::int)
    ) AS t(sch, tbl, pol, roles, live_qual, n_select)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pp
        JOIN pg_class c ON c.relname = pp.tablename AND c.relnamespace = v_pin.sch::regnamespace
       WHERE pp.schemaname = v_pin.sch AND pp.tablename = v_pin.tbl AND pp.policyname = v_pin.pol
         AND pp.cmd = 'SELECT' AND pp.permissive = 'PERMISSIVE' AND pp.roles::text = v_pin.roles
         AND pp.qual = v_pin.live_qual AND pp.with_check IS NULL
         AND c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'JOB_ACCESS_BASELINE_DRIFT: policy % on %.% is not the live one', v_pin.pol, v_pin.sch, v_pin.tbl;
    END IF;
    IF v_pin.n_select IS NOT NULL AND (SELECT count(*) FROM pg_policies pp
         WHERE pp.schemaname = v_pin.sch AND pp.tablename = v_pin.tbl
           AND pp.cmd IN ('SELECT', 'ALL') AND pp.permissive = 'PERMISSIVE') <> v_pin.n_select THEN
      RAISE EXCEPTION 'JOB_ACCESS_BASELINE_DRIFT: %.% has an unexpected number of SELECT policies', v_pin.sch, v_pin.tbl;
    END IF;
  END LOOP;

  -- The policies that inherit the window must still reach the job through `jobs` (row security on).
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public', 'customers', 'customers_select', '7b5322d993fa4ad4714e66baf5bc8738'),
      ('public', 'job_fields', 'job_fields_select', 'ede838a778e0aa45b18a716e525c3d18'),
      ('public', 'job_chemicals', 'job_chemicals_select', '19756e2ab11defccc01ccf5a197b994a'),
      ('public', 'job_tag_assignments', 'job_tag_assignments_select', '82b9f4bc2284b2fa1e90110f6bea9611'),
      ('public', 'job_loader_worksheets', 'job_loader_worksheets_select', '11e167cb56795204be6deb2c68645af1'),
      ('public', 'job_applied_info', 'job_applied_info_insert', '4131e0e65b640b0e9c7471121f5f34ab'),
      ('public', 'job_applied_info', 'job_applied_info_update', '09e8bbf2cf5f96df3281bdf775be58db'),
      ('public', 'job_applied_records', 'job_applied_records_insert', 'a473ebbbdef7f9aecf84f7d2597d1328'),
      ('public', 'job_applied_records', 'job_applied_records_update', '21f66c34745e6fe53020e13f8df0784f'),
      ('public', 'job_applied_records', 'job_applied_records_delete', '3cfcf7cd614bd213b8c3dfd5a4963579'),
      ('public', 'job_applied_record_fields', 'job_applied_record_fields_insert', 'f0d81381d3942783abba6dbf0cdec417'),
      ('public', 'job_applied_record_fields', 'job_applied_record_fields_update', 'a0088b41b23e34596f421c1f698bb327'),
      ('public', 'job_applied_record_fields', 'job_applied_record_fields_delete', '09816de5fbd8f7c967c04c5d11726ce8'),
      ('public', 'job_applied_record_crew', 'job_applied_record_crew_insert', 'a9fb1428b71c67923d145edce8bb5ab8'),
      ('public', 'job_applied_record_crew', 'job_applied_record_crew_update', '101870072e29a8f5da313c8c730a0ae0'),
      ('public', 'job_applied_record_crew', 'job_applied_record_crew_delete', 'c1d1d6b4ad2253211eed17ba9707440a'),
      ('public', 'job_attachments', 'job_attachments_insert', '36586e85869d25fafff591b105456f1f'),
      ('public', 'job_attachments', 'job_attachments_delete', '504b570d9691d0c36b9c1038157b348f'),
      ('storage', 'objects', 'job_attachments_objects_insert', '0ac10622e467982e5d186059b4dfcec8'),
      ('storage', 'objects', 'job_attachments_objects_delete', 'ef8c692bef2a0e00433687887a1d19ab')
    ) AS t(sch, tbl, pol, live_md5)
  LOOP
    IF (SELECT md5(coalesce(pp.qual, '') || '|' || coalesce(pp.with_check, ''))
          FROM pg_policies pp
         WHERE pp.schemaname = v_pin.sch AND pp.tablename = v_pin.tbl AND pp.policyname = v_pin.pol)
       IS DISTINCT FROM v_pin.live_md5 THEN
      RAISE EXCEPTION 'JOB_ACCESS_BASELINE_DRIFT: policy % on %.% changed', v_pin.pol, v_pin.sch, v_pin.tbl;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.jobs'::regclass AND relrowsecurity AND NOT relforcerowsecurity) THEN
    RAISE EXCEPTION 'JOB_ACCESS_BASELINE_DRIFT: row security on public.jobs is not the live setting';
  END IF;
END;
$preflight$;

-- When the job was completed, by the server's clock. ----------------------------------------------------
ALTER TABLE public.jobs ADD COLUMN completed_at timestamptz;

COMMENT ON COLUMN public.jobs.completed_at IS
  'KI-73 part C: server time the job first reached completed or invoiced; NULL otherwise. Set only by trg_stamp_job_completed_at, never by a client.';
-- jobs is column-carved (cost columns hidden): read it like every other column; no INSERT/UPDATE, the trigger owns it.
GRANT SELECT (completed_at) ON public.jobs TO authenticated, anon;
GRANT REFERENCES (completed_at) ON public.jobs TO authenticated;

CREATE FUNCTION public._stamp_job_completed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- KI-73 part C: the whole-job applicator's 7-day window runs from here, so nothing a client sends counts.
  IF NEW.status IN ('completed', 'invoiced') THEN
    IF TG_OP = 'UPDATE' AND OLD.status IN ('completed', 'invoiced') THEN
      NEW.completed_at := OLD.completed_at;
    ELSE
      NEW.completed_at := now();
    END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._stamp_job_completed_at() FROM PUBLIC, anon, authenticated;

-- Named to run after every other BEFORE trigger on jobs (they fire in name order), so it sees the final status.
CREATE TRIGGER trg_stamp_job_completed_at
  BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public._stamp_job_completed_at();

-- The whole-job applicator, while the job is current. -------------------------------------------------
CREATE FUNCTION public._is_job_applicator(p_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  -- KI-73 part C: is the caller this job's whole-job applicator (jobs.applicator_id) while the job is
  -- current? is_applicator() requires an ACTIVE applicator profile. Never a soft-deleted or cancelled
  -- job; a completed or invoiced job only for 7 days after it was completed (DECISION_LOG 2026-10-25).
  -- completed_at is the server's stamp (trg_stamp_job_completed_at); NULL (completed before it existed)
  -- grants nothing.
  SELECT public.is_applicator() AND EXISTS (
    SELECT 1
      FROM public.jobs j
     WHERE j.id = p_job_id
       AND j.applicator_id = (SELECT auth.uid())
       AND j.deleted_at IS NULL
       AND (
         j.status IN ('scheduled', 'in_progress')
         OR (j.status IN ('completed', 'invoiced') AND j.completed_at >= now() - interval '7 days')
       )
  );
$function$;

REVOKE ALL ON FUNCTION public._is_job_applicator(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_job_applicator(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public._is_job_applicator(uuid) IS
  'KI-73 part C: the caller is the active whole-job applicator of a job that is not deleted or cancelled, and is scheduled, in progress, or completed/invoiced within the last 7 days (jobs.completed_at).';

-- The replaced functions (only the lines marked "KI-73 part C" differ from live). ----------------------
CREATE OR REPLACE FUNCTION public._is_dispatched_to_me(p_job_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The caller must be an ACTIVE profile — mirror is_applicator()/is_admin(), which
  -- re-check profiles.is_active, so a DEACTIVATED user with a still-valid token loses
  -- dispatch visibility immediately (Codex re-review-6 P2).
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
  -- KI-73 part C: a soft-deleted or cancelled job grants no dispatch access (not even a dispatch
  -- completed before the job was cancelled; the terminal trigger only closes open dispatches).
  AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.status <> 'cancelled')
  AND EXISTS (
    SELECT 1 FROM public.job_location_dispatches d
     WHERE d.job_id = p_job_id
       -- Only an ACTIVE ('dispatched') assignment — or, since A1b, the caller's own
       -- assignment COMPLETED within the last 7 days — grants visibility. The completed
       -- tail mirrors get_dispatched_list's A1 Done-section window exactly, so a split
       -- assignee's just-finished job keeps its customer name + expanded detail readable
       -- while it sits in Done. A 'cancelled' dispatch must still NOT keep granting the
       -- former assignee/crew read access to the parent job (Codex re-review P2).
       AND (
         d.dispatch_status = 'dispatched'
         OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
       )
       AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = d.job_id AND (j.status IN ('scheduled', 'in_progress') OR j.completed_at >= now() - interval '7 days'))  -- KI-73 part C: a finished job's dispatch ends 7 days after the job
       AND (
         d.applicator_id = (select auth.uid())
         OR (
           d.crew_id IS NOT NULL
           AND EXISTS (
             -- the CREW must still be active AND the caller an active member —
             -- deactivating the crew revokes visibility even if member rows linger
             -- (Codex re-review-9 P2).
             SELECT 1 FROM public.ground_crew_members gcm
              JOIN public.ground_crews gc ON gc.id = gcm.crew_id
              WHERE gcm.crew_id = d.crew_id
                AND gcm.profile_id = (select auth.uid())
                AND gcm.is_active
                AND gc.is_active
           )
         )
       )
  );
$function$;

CREATE OR REPLACE FUNCTION public._can_see_field(p_field_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Who may see one field (its row, boundary and map lookups). Every leg needs an ACTIVE profile.
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active)
  AND (
    -- Office staff see every field.
    public.is_admin() OR public.is_sales_rep()
    -- The whole-job applicator (jobs.applicator_id) sees the fields on that job while the job
    -- is current (_is_job_applicator: never deleted or cancelled; KI-73 part C).
    OR EXISTS (
          SELECT 1
            FROM public.job_fields jf
           WHERE jf.field_id = p_field_id
             AND public._is_job_applicator(jf.job_id))
    -- A per-field or crew assignee sees every field of a job they are dispatched on, as the
    -- whole-job applicator does (Mason, 2026-10-25: field staff see the entire job; row 11.4
    -- part B). Same checks as _is_dispatched_to_me: open, or completed within 7 days, never
    -- cancelled; a crew dispatch needs an active crew and an active membership. Plus: the job
    -- is not soft-deleted.
    OR EXISTS (
          SELECT 1
            FROM public.job_location_dispatches d
            JOIN public.job_fields jf ON jf.job_id = d.job_id
            JOIN public.jobs j ON j.id = d.job_id
           WHERE jf.field_id = p_field_id
             AND j.deleted_at IS NULL
             AND j.status <> 'cancelled'  -- KI-73 part C: a cancelled job ends dispatch access
             AND (j.status IN ('scheduled', 'in_progress') OR j.completed_at >= now() - interval '7 days')  -- KI-73 part C: a finished job's dispatch ends 7 days after the job
             AND (
               d.dispatch_status = 'dispatched'
               OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
             )
             AND (
               d.applicator_id = (SELECT auth.uid())
               OR (
                 d.crew_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM public.ground_crew_members gcm
                     JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                    WHERE gcm.crew_id = d.crew_id
                      AND gcm.profile_id = (SELECT auth.uid())
                      AND gcm.is_active
                      AND gc.is_active
                 )
               )
             ))
  );
$function$;

CREATE OR REPLACE FUNCTION public._start_job_replay_impl_20261015(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor     uuid := auth.uid();
  v_existing  jsonb;
  v_job       record;
  v_now       timestamptz := now();
  v_result    jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'start_job';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  -- U12: widened with an OR branch (superset — nothing previously authorized
  -- loses access). A per-location-only dispatchee (job_location_dispatches,
  -- #36/#37) is now ALSO authorized to start the job, mirroring the visibility
  -- grant _is_dispatched_to_me already gives them for reading it.
  IF NOT (
    is_admin() OR is_sales_rep()
    -- NULL-SAFE (U12 live-verify finding): when jobs.applicator_id IS NULL this
    -- comparison yielded NULL, and IF NOT (NULL) skips the RAISE — any active
    -- applicator could start/complete a NULL-applicator job. Wrap it so the
    -- branch is FALSE, not NULL, and authorization falls through to the
    -- dispatch-based branch (which is already null-safe).
    OR public._is_job_applicator(p_job_id)  -- KI-73 part C: access ends when the job ends
    OR (is_applicator() AND public._is_dispatched_to_me(p_job_id))
  ) THEN
    RAISE EXCEPTION 'Not authorized to start this job';
  END IF;

  IF v_job.status = 'in_progress' THEN
    v_result := jsonb_build_object(
      'job_id', p_job_id,
      'status', 'in_progress',
      'started_at', (SELECT actual_start_time FROM job_applied_info WHERE job_id = p_job_id),
      'already_started', true
    );
    IF p_idempotency_key IS NOT NULL THEN
      INSERT INTO idempotency_keys (idempotency_key, operation, result)
      VALUES (p_idempotency_key, 'start_job', v_result)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
    RETURN v_result;
  END IF;

  IF v_job.status != 'scheduled' THEN
    RAISE EXCEPTION 'Cannot start job — current status is %, expected scheduled', v_job.status;
  END IF;

  UPDATE jobs SET status = 'in_progress' WHERE id = p_job_id;

  INSERT INTO job_applied_info (job_id, actual_start_time)
  VALUES (p_job_id, v_now)
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time = COALESCE(job_applied_info.actual_start_time, EXCLUDED.actual_start_time);

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_started',
    'Job ' || v_job.job_number || ' started',
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'job_id', p_job_id,
    'status', 'in_progress',
    'started_at', v_now,
    'already_started', false
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'start_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._complete_job_replay_impl_20261015(p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_job            record;
  v_record_number  text;
  v_record_id      uuid;
  v_product_data   jsonb;
  v_weather        jsonb;
  v_chem           record;
  v_inv            record;
  v_inv_found      boolean;
  v_jf             record;
  v_first_field_id uuid;
  v_field_count    int := 0;
  v_short_count    int := 0;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_result         jsonb;
  v_deduct_qty     numeric;
  -- U11<<< raw-fallback bookkeeping for unconvertible units
  v_unconverted    boolean;
  v_unconv_count   int := 0;
  -- >>>U11
  -- U12 (Codex R2 P2): running sum of the per-field acres actually recorded, so
  -- the record header can be corrected when the caller sent 'field_acres' overrides.
  v_acres_sum      numeric := 0;
  v_auto_draft_on    boolean := false;
  v_existing_invoice uuid;
  v_auto_draft_key   text;
  -- N2-7 #106a/#106b<<< actual application date + applicator snapshot locals.
  v_application_date date;
  v_applicator_id      uuid;
  v_applicator_name    text;
  v_applicator_license text;
  -- >>>N2-7
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'complete_job';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.*, c.farm_name AS customer_name
    INTO v_job
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
   WHERE j.id = p_job_id
   FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  -- U12: widened with an OR branch — but NARROWER than start_job's (Codex R1 P1,
  -- tightened again R2 P1): complete_job stamps application records + acres for
  -- EVERY field and deducts inventory for EVERY chemical on the job, so a
  -- location-only dispatchee may complete it ONLY when BOTH hold:
  --   (1) EVERY job_fields row on the job is covered by an ACTIVE dispatch owned
  --       by the caller (directly, or via active membership in the dispatched
  --       crew) — an undispatched field means someone's work isn't even assigned
  --       yet, so the whole-job close stays with the office / whole-job assignee;
  --   (2) no OTHER party holds an ACTIVE dispatch anywhere on the job.
  -- On any split/partial-dispatch job this branch stays closed — admin/sales_rep
  -- or jobs.applicator_id complete those, exactly as before this migration.
  -- Still a strict superset of live behavior.
  IF NOT (
    is_admin() OR is_sales_rep()
    -- NULL-SAFE (U12 live-verify finding): when jobs.applicator_id IS NULL this
    -- comparison yielded NULL, and IF NOT (NULL) skips the RAISE — any active
    -- applicator could start/complete a NULL-applicator job. Wrap it so the
    -- branch is FALSE, not NULL, and authorization falls through to the
    -- dispatch-based branch (which is already null-safe).
    OR public._is_job_applicator(p_job_id)  -- KI-73 part C: access ends when the job ends
    OR (
      is_applicator()
      AND public._is_dispatched_to_me(p_job_id)
      -- (1) every field on the job is actively dispatched to the caller.
      -- Crew ownership requires BOTH the membership row AND the crew itself to
      -- be active (RLS R2 M2) — matching _is_dispatched_to_me and the
      -- job_location_dispatches_select policy, so the completion power is never
      -- looser than the read power.
      AND NOT EXISTS (
        SELECT 1
          FROM job_fields jf2
         WHERE jf2.job_id = p_job_id
           AND NOT EXISTS (
             SELECT 1
               FROM job_location_dispatches d2
              WHERE d2.job_field_id = jf2.id
                AND d2.dispatch_status = 'dispatched'
                AND (
                  d2.applicator_id = v_actor
                  OR (d2.crew_id IS NOT NULL AND EXISTS (
                        SELECT 1
                          FROM ground_crew_members gcm
                          JOIN ground_crews gc ON gc.id = gcm.crew_id
                         WHERE gcm.crew_id = d2.crew_id
                           AND gcm.profile_id = v_actor
                           AND gcm.is_active
                           AND gc.is_active))
                )
           )
      )
      -- (2) and nobody ELSE holds an active dispatch on the job. The applicator
      -- comparison is wrapped null-safe (RLS R2 M1): on a crew-held dispatch
      -- d.applicator_id IS NULL, and `NULL = v_actor` would poison the NOT()
      -- into NULL and silently drop the row from the EXISTS.
      AND NOT EXISTS (
        SELECT 1
          FROM job_location_dispatches d
         WHERE d.job_id = p_job_id
           AND d.dispatch_status = 'dispatched'
           AND NOT (
             (d.applicator_id IS NOT NULL AND d.applicator_id = v_actor)
             OR (d.crew_id IS NOT NULL AND EXISTS (
                   SELECT 1
                     FROM ground_crew_members gcm
                     JOIN ground_crews gc ON gc.id = gcm.crew_id
                    WHERE gcm.crew_id = d.crew_id
                      AND gcm.profile_id = v_actor
                      AND gcm.is_active
                      AND gc.is_active))
           )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this job';
  END IF;

  IF v_job.status != 'in_progress' THEN
    RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
  END IF;

  -- Fires A4's jobs lifecycle trigger → _sync_job_holds releases this job's hold
  -- and re-syncs the parent quote (keeping the draw). The quote hold / booking is
  -- owned by A4 from here; the loop below only deducts physical stock.
  UPDATE jobs SET status = 'completed' WHERE id = p_job_id;

  INSERT INTO job_applied_info (
    job_id, actual_start_time, actual_end_time,
    wind_speed, wind_direction, temperature, humidity,
    actual_gallons_applied, notes
  ) VALUES (
    p_job_id,
    CASE WHEN p_applied_info->>'actual_start_time' IS NOT NULL
      THEN (p_applied_info->>'actual_start_time')::timestamptz ELSE NULL END,
    CASE WHEN p_applied_info->>'actual_end_time' IS NOT NULL
      THEN (p_applied_info->>'actual_end_time')::timestamptz ELSE NULL END,
    (p_applied_info->>'wind_speed')::numeric,
    p_applied_info->>'wind_direction',
    (p_applied_info->>'temperature')::numeric,
    (p_applied_info->>'humidity')::numeric,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    p_applied_info->>'notes'
  )
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time      = COALESCE(EXCLUDED.actual_start_time,      job_applied_info.actual_start_time),
    actual_end_time        = EXCLUDED.actual_end_time,
    wind_speed             = EXCLUDED.wind_speed,
    wind_direction         = EXCLUDED.wind_direction,
    temperature            = EXCLUDED.temperature,
    humidity               = EXCLUDED.humidity,
    actual_gallons_applied = EXCLUDED.actual_gallons_applied,
    notes                  = EXCLUDED.notes;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id',       jc.product_id,
        'product_name',     p.product_name,
        'quantity',         jc.quantity,
        'unit',             jc.unit,
        'rate_per_acre',    jc.rate_per_acre,
        'rate_unit',        jc.rate_unit,
        'epa_registration', p.epa_registration,
        'is_rup',           COALESCE(p.is_rup, false),
        -- U4<<< legal record marks a grower-supplied product; the row STAYS in
        -- product_data (REI/PHI watchdog + as-applied proof still see it). (#53/#54)
        'customer_supplied', jc.customer_supplied
        -- >>>U4
      )
      ORDER BY jc.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM job_chemicals jc
  LEFT JOIN products p ON p.id = jc.product_id
  WHERE jc.job_id = p_job_id;

  v_weather := jsonb_build_object(
    'wind_speed',     (p_applied_info->>'wind_speed')::numeric,
    'wind_direction', p_applied_info->>'wind_direction',
    'temperature',    (p_applied_info->>'temperature')::numeric,
    'humidity',       (p_applied_info->>'humidity')::numeric
  );

  v_record_number := next_application_record_number();

  SELECT field_id INTO v_first_field_id
    FROM job_fields
   WHERE job_id = p_job_id
   ORDER BY sort_order, id
   LIMIT 1;

  -- N2-7 #106a<<< the ACTUAL application date. The job_applied_info upsert above already
  -- merged the completer-sent start with the start_job-stamped start
  -- (COALESCE(EXCLUDED.actual_start_time, existing)), so that row's actual_start_time is
  -- the single source of truth for "when it was actually applied". Prefer the just-sent
  -- value, then the stored start, then fall back to v_job.job_date EXACTLY as before this
  -- migration when no actual start exists anywhere (byte-identical to old behavior).
  -- Codex R1 P2: cast through the BUSINESS timezone, not the session default
  -- (UTC on Supabase) — a 7:30 PM Central start is still "today" on the legal
  -- record, not tomorrow. CRX operates in US Central only (single-region ag
  -- retailer); if that ever changes this becomes an app_settings value.
  v_application_date := COALESCE(
    (
      COALESCE(
        (p_applied_info->>'actual_start_time')::timestamptz,
        (SELECT jai.actual_start_time FROM job_applied_info jai WHERE jai.job_id = p_job_id)
      ) AT TIME ZONE 'America/Chicago'
    )::date,
    v_job.job_date
  );
  -- >>>N2-7 #106a

  -- N2-7 #106b<<< snapshot the applicator's identity as-of NOW onto the legal record.
  -- Same applicator the record is attributed to (below): the completer when they're an
  -- applicator, else the job-header applicator (which may be NULL for wizard-dispatched
  -- jobs → both snapshot columns stay NULL, additive-safe).
  v_applicator_id := CASE WHEN is_applicator() THEN v_actor ELSE v_job.applicator_id END;
  IF v_applicator_id IS NOT NULL THEN
    SELECT pr.full_name, pr.applicator_license_number
      INTO v_applicator_name, v_applicator_license
      FROM profiles pr WHERE pr.id = v_applicator_id;
    -- Codex R1 P2: applicator_licenses is the CANONICAL license store for staff
    -- (the assignment gate + UI read it); profiles.applicator_license_number is
    -- not maintained by the current frontend. Prefer the newest active canonical
    -- license; keep the profiles value only as a fallback for shops that typed
    -- it there.
    SELECT COALESCE(
             (SELECT al.license_number
                FROM applicator_licenses al
               WHERE al.profile_id = v_applicator_id
                 AND al.is_active = true
               ORDER BY al.expiry_date DESC NULLS LAST
               LIMIT 1),
             v_applicator_license
           )
      INTO v_applicator_license;
  END IF;
  -- >>>N2-7 #106b

  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, product_data,
    total_acres, total_volume, total_volume_unit,
    vehicle_id, weather_conditions,
    notes, season, created_by,
    -- N2-7 #106b: legal-record applicator snapshot columns.
    applicator_name, applicator_license_number
  ) VALUES (
    v_record_number, 'job', p_job_id,
    v_job.customer_id,
    -- U12 (Codex R2 P1): attribute the legal application record to the person who
    -- ACTUALLY completed it when that person is an applicator — the new location-
    -- dispatch path means the completer may not be jobs.applicator_id (which can
    -- even be NULL for wizard-dispatched jobs). For the whole-job assignee this is
    -- the same value as before (v_actor = v_job.applicator_id); for office closes
    -- (admin/sales_rep) keep the job-header applicator exactly as today.
    -- N2-7: this is exactly v_applicator_id (computed above from the same CASE), so
    -- applicator_id is byte-identical to live; reusing the local keeps it in lockstep
    -- with the name/license snapshot.
    v_applicator_id,
    v_first_field_id,
    -- N2-7 #106a: actual application date (was v_job.job_date).
    v_application_date, v_product_data,
    v_job.total_acres,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    'gallons',
    v_job.vehicle_id, v_weather, v_job.notes, v_job.season,
    p_performed_by,
    -- N2-7 #106b: applicator identity snapshot.
    v_applicator_name, v_applicator_license
  )
  RETURNING id INTO v_record_id;

  FOR v_jf IN
    SELECT jf.field_id,
           -- U12 addition: an optional per-field override from
           -- p_applied_info->'field_acres' = [{"field_id":uuid,"acres_applied":n}, ...].
           -- Falls through to the ORIGINAL chain when absent/no match — byte-identical
           -- to the pre-U12 behavior for every caller that doesn't pass it.
           COALESCE(
             (SELECT GREATEST(0, (elem->>'acres_applied')::numeric)
                FROM jsonb_array_elements(COALESCE(p_applied_info->'field_acres', '[]'::jsonb)) elem
               WHERE nullif(elem->>'field_id', '')::uuid = jf.field_id
               LIMIT 1),
             jf.acres_to_treat, f.total_acres, 0
           ) AS acres,
           COALESCE(jf.sort_order, 0)                    AS sort_order
      FROM job_fields jf
      JOIN fields f ON f.id = jf.field_id
     WHERE jf.job_id = p_job_id
     ORDER BY jf.sort_order, jf.id
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_jf.field_id, v_jf.acres, v_jf.sort_order);
    v_field_count := v_field_count + 1;
    v_acres_sum   := v_acres_sum + COALESCE(v_jf.acres, 0);
  END LOOP;

  -- U12 (Codex R2 P2): when the caller sent per-field applied-acres overrides,
  -- the record HEADER must reflect what was actually recorded, not the planned
  -- job total — reports read application_records.total_acres. Only corrected
  -- when 'field_acres' was provided: callers that omit it keep today's header
  -- value byte-for-byte (v_job.total_acres), preserving backward compatibility.
  IF p_applied_info ? 'field_acres' AND v_field_count > 0 THEN
    UPDATE application_records
       SET total_acres = v_acres_sum
     WHERE id = v_record_id;
  END IF;

  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit, p.inventory_unit AS inv_unit, p.product_form AS prod_form
      FROM job_chemicals jc
      JOIN products p ON p.id = jc.product_id
     -- U4<<< skip customer-supplied lines: they came from the grower, not our
     -- shed — no stock to deduct, no 'job_applied' inventory transaction. (#53/#54)
     WHERE jc.job_id = p_job_id AND jc.quantity > 0 AND jc.customer_supplied = false
     -- >>>U4
  LOOP
    -- U11<<< convert the rate-unit job-chem quantity to the product's inventory unit
    -- before deducting stock (a 16-pt line on a gallons-stocked product must remove 2
    -- gal, not 16). On an unconvertible / blank / unknown unit, DO NOT block the field
    -- job (a stuck applicator can't ship the day's work): fall back to the RAW quantity
    -- and flag the row for office review. This mirrors the hold engine EXACTLY —
    -- _sync_job_holds reserved COALESCE(field_app_priced_quantity(...), jc.quantity)
    -- inventory-units for this same line, so deducting the same fallback keeps the
    -- "reserved X → removed X" invariant intact (was: A6 hard RAISE JOB_INV_UNIT_UNCONVERTIBLE,
    -- which blocked completion of ANY job carrying an unconvertible unit).
    -- Codex P1: normalize FIRST — legacy rows may carry per-acre-suffixed units
    -- ('pt/ac'); the raw string NULLs out of the converter and would raw-deduct
    -- 16 "pt/ac" as 16 gal. normalize_rate_unit('pt/ac')='pt' → converts to 2 gal.
    -- (The hold engines share this normalization gap — queued as a follow-up;
    -- correcting the PHYSICAL deduction takes precedence over symmetry.)
    v_deduct_qty  := field_app_priced_quantity(v_chem.quantity, normalize_rate_unit(v_chem.unit), v_chem.inv_unit, v_chem.prod_form);
    v_unconverted := (v_deduct_qty IS NULL);
    IF v_unconverted THEN
      v_deduct_qty   := v_chem.quantity;      -- raw fallback, equals the reserved hold
      v_unconv_count := v_unconv_count + 1;
    END IF;
    -- >>>U11

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    -- LAYER2<<< §3.5 fix: deduct physical stock ONLY. The parent quote's holds
    -- and prebooked are owned by A4's jobs lifecycle trigger (which already fired
    -- on the status='completed' update above). The removed "Phase 7" drain
    -- (v_hold_qty / v_decrement_pb / prebooked decrement / crop_program FIFO
    -- drain) double-reduced free stock for order-drawn planned quotes.
    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_deduct_qty,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;
    -- >>>LAYER2

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, job_id, requires_review
    ) VALUES (
      v_chem.product_id, 'job_applied', v_deduct_qty, 'Main Warehouse',
      p_performed_by,
      -- U11<<< recorded qty ALWAYS = what stock moved (converted, or raw fallback). Name
      -- the original line qty/unit when a conversion (or a raw fallback) happened, so the
      -- audit row is self-explaining and reconcilable (mirrors A5's link/audit-row lesson).
      'Job ' || v_job.job_number || ' completed — ' || v_deduct_qty || ' units applied' ||
        CASE
          WHEN v_unconverted
            THEN ' [UNIT NOT CONVERTIBLE — line ' || v_chem.quantity || ' ' || COALESCE(NULLIF(v_chem.unit, ''), '?')
                 || ' recorded raw vs inventory unit ' || COALESCE(NULLIF(v_chem.inv_unit, ''), '?') || '; review required]'
          WHEN lower(btrim(COALESCE(v_chem.unit, ''))) IS DISTINCT FROM lower(btrim(COALESCE(v_chem.inv_unit, '')))
            THEN ' (converted from ' || v_chem.quantity || ' ' || COALESCE(NULLIF(v_chem.unit, ''), '?') || ')'
          ELSE ''
        END ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
      p_job_id,
      (v_short_flag OR v_unconverted)
      -- >>>U11
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_completed',
    'Job ' || v_job.job_number || ' completed across ' || v_field_count || ' field(s). Application record: ' || v_record_number ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END ||
      -- U11<<< surface raw-fallback lines to the office the same way short-stock is surfaced
      CASE WHEN v_unconv_count > 0
           THEN ' (⚠ ' || v_unconv_count || ' chemical(s) with non-convertible units — recorded raw, review required)'
           ELSE '' END,
      -- >>>U11
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'success',                true,
    'job_id',                 p_job_id,
    'application_record_id',  v_record_id,
    'record_number',          v_record_number,
    'field_count',            v_field_count,
    'short_stock_count',      v_short_count
  );

  BEGIN
    SELECT (setting_value = 'true')
      INTO v_auto_draft_on
      FROM app_settings
     WHERE setting_key = 'auto_draft_invoice_on_job_completion';
    v_auto_draft_on := COALESCE(v_auto_draft_on, false);

    -- #117<<< make every skip visible. Previously: the flag-ON + non-office case
    -- (the #107 applicator gap) and the already-invoiced case both did NOTHING —
    -- silence indistinguishable from success. Now each writes an
    -- 'auto_draft_skipped' activity row. The POLICY (should applicator
    -- completions auto-draft?) is unchanged and stays an owner decision (#107).
    IF v_auto_draft_on THEN
      IF (is_admin() OR is_sales_rep()) THEN
        SELECT i.id INTO v_existing_invoice
          FROM invoices i
         WHERE i.job_id = p_job_id
           AND i.deleted_at IS NULL
           AND i.status NOT IN ('voided', 'cancelled')
         LIMIT 1;

        IF v_existing_invoice IS NULL THEN
          v_auto_draft_key := 'auto_draft_job:' || p_job_id::text;
          PERFORM transfer_job_to_invoice(p_job_id, p_performed_by, v_auto_draft_key);
        ELSE
          INSERT INTO activity_feed (
            event_type, description, performed_by,
            related_entity_type, related_entity_id, customer_id
          ) VALUES (
            'auto_draft_skipped',
            'Job ' || v_job.job_number || ' completed — automatic draft invoice skipped: '
              || 'an active invoice already exists for this job.',
            p_performed_by, 'job', p_job_id, v_job.customer_id
          );
        END IF;
      ELSE
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'auto_draft_skipped',
          'Job ' || v_job.job_number || ' completed by an applicator — automatic draft '
            || 'invoice skipped (auto-draft only runs for office completions). '
            || 'Bill this job manually.',
          p_performed_by, 'job', p_job_id, v_job.customer_id
        );
      END IF;
    END IF;
    -- >>>#117
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'auto_draft_failed',
        'Job ' || v_job.job_number || ' completed, but the automatic draft invoice could '
          || 'not be created (needs attention — bill it manually). Reason: '
          -- every active profile reads activity_feed; a below-cost detail can carry the admin's cost
          || CASE WHEN SQLERRM LIKE 'BELOW\_COST\_%' THEN split_part(SQLERRM, ':', 1) ELSE SQLERRM END,
        p_performed_by, 'job', p_job_id, v_job.customer_id
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'complete_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stage_offline_action(p_client_action_id uuid, p_operation text, p_entity_id uuid, p_schema_version integer, p_client_created_at timestamp with time zone, p_payload jsonb, p_idempotency_key text DEFAULT NULL::text, p_entity_snapshot_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_existing public.offline_action_receipts%ROWTYPE;
  v_canonical jsonb := '{}'::jsonb;
  v_quantities jsonb;
  v_canonical_quantities jsonb := '{}'::jsonb;
  v_field_acres jsonb := '[]'::jsonb;
  v_canonical_field_acres jsonb := '[]'::jsonb;
  v_seen_fields jsonb := '{}'::jsonb;
  v_key text;
  v_text text;
  v_value jsonb;
  v_uuid uuid;
  v_number numeric;
  v_timestamp timestamptz;
  v_assigned_driver uuid;
  v_job_applicator uuid;
  v_target_updated_at timestamptz;
  v_target_exists boolean := false;
  v_authorized boolean := false;
  v_initial_status text := 'received';
  v_failure_code text;
  v_failure_summary text;
  v_payload_requires_review boolean := false;
  v_payload_review_summary text;
  v_now timestamptz := now();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT p.role
    INTO v_actor_role
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: active profile required';
  END IF;

  IF p_client_action_id IS NULL OR p_entity_id IS NULL OR p_client_created_at IS NULL THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: action, entity, and client timestamp are required';
  END IF;
  IF p_client_created_at > v_now + interval '24 hours' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: client timestamp is too far in the future';
  END IF;
  IF p_schema_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'UNSUPPORTED_SCHEMA_VERSION';
  END IF;
  IF p_operation IS NULL
     OR p_operation NOT IN ('complete_delivery', 'complete_job') THEN
    RAISE EXCEPTION 'UNSUPPORTED_OPERATION';
  END IF;
  IF p_idempotency_key IS NULL
     OR btrim(p_idempotency_key) = ''
     OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: a bounded idempotency key is required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: payload must be a JSON object';
  END IF;
  IF pg_column_size(p_payload) > 65536 THEN
    RAISE EXCEPTION 'PAYLOAD_TOO_LARGE';
  END IF;

  IF p_operation = 'complete_delivery' THEN
    IF (p_payload - ARRAY['signed_by', 'quantities', 'issue_type', 'issue_notes', 'completed_at']) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: unsupported complete_delivery field';
    END IF;

    v_text := btrim(COALESCE(p_payload->>'signed_by', ''));
    IF v_text = '' OR length(v_text) > 200 THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: signed_by is required and limited to 200 characters';
    END IF;
    v_canonical := jsonb_build_object('signed_by', v_text);

    IF p_payload ? 'quantities' AND p_payload->'quantities' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'quantities') <> 'object' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: quantities must be an object';
      END IF;
      v_quantities := p_payload->'quantities';
      IF (SELECT count(*) FROM jsonb_object_keys(v_quantities)) > 500 THEN
        RAISE EXCEPTION 'PAYLOAD_TOO_LARGE: quantities exceeds 500 entries';
      END IF;

      FOR v_key, v_value IN SELECT key, value FROM jsonb_each(v_quantities)
      LOOP
        IF v_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity key must be a UUID';
        END IF;
        IF jsonb_typeof(v_value) NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity must be numeric';
        END IF;
        v_text := v_value #>> '{}';
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity must be a finite decimal';
        END IF;
        v_number := v_text::numeric;
        IF v_number < 0 THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity cannot be negative';
        END IF;
        v_uuid := v_key::uuid;
        v_canonical_quantities := v_canonical_quantities || jsonb_build_object(v_uuid::text, to_jsonb(v_number));
      END LOOP;
      v_canonical := v_canonical || jsonb_build_object('quantities', v_canonical_quantities);
    END IF;

    IF p_payload ? 'issue_type' AND p_payload->'issue_type' <> 'null'::jsonb THEN
      v_text := p_payload->>'issue_type';
      IF v_text NOT IN ('none', 'customer_not_home', 'gate_locked', 'road_blocked', 'wrong_address', 'refused', 'weather', 'other') THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: issue_type is not supported';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('issue_type', v_text);
    END IF;

    IF p_payload ? 'issue_notes' AND p_payload->'issue_notes' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'issue_notes') <> 'string' OR length(p_payload->>'issue_notes') > 2000 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: issue_notes must be text up to 2000 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('issue_notes', p_payload->>'issue_notes');
    END IF;

    IF p_payload ? 'completed_at' AND p_payload->'completed_at' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'completed_at') <> 'string' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: completed_at must be an ISO timestamp';
      END IF;
      BEGIN
        v_timestamp := (p_payload->>'completed_at')::timestamptz;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: completed_at must be an ISO timestamp';
      END;
      IF v_timestamp > v_now + interval '5 minutes' THEN
        v_payload_requires_review := true;
        v_payload_review_summary := 'The saved completion time is ahead of the server clock. Office review is required.';
      ELSIF v_timestamp < v_now - interval '14 days' THEN
        v_payload_requires_review := true;
        v_payload_review_summary := 'The saved completion time is more than 14 days old. Office review is required before posting into a prior period.';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('completed_at', to_jsonb(v_timestamp));
    END IF;

    SELECT d.assigned_driver, d.updated_at
      INTO v_assigned_driver, v_target_updated_at
      FROM public.deliveries d
     WHERE d.id = p_entity_id;
    v_target_exists := FOUND;
    v_authorized := v_target_exists AND (
      v_actor_role IN ('admin', 'sales_rep')
      OR (v_actor_role = 'driver' AND v_assigned_driver = v_actor)
    );

    IF v_target_exists AND v_quantities IS NOT NULL AND EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_quantities) q(item_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.delivery_items di
        WHERE di.id = q.item_id::uuid
          AND di.delivery_id = p_entity_id
      )
    ) THEN
      v_payload_requires_review := true;
      v_payload_review_summary := 'A saved delivery item no longer belongs to this delivery. Office review is required.';
    END IF;

  ELSE
    IF (p_payload - ARRAY[
      'actual_start_time', 'actual_end_time', 'wind_speed', 'wind_direction',
      'temperature', 'humidity', 'actual_gallons_applied', 'notes', 'field_acres'
    ]) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: unsupported complete_job field';
    END IF;

    FOREACH v_key IN ARRAY ARRAY['wind_speed', 'temperature', 'humidity', 'actual_gallons_applied']::text[]
    LOOP
      IF p_payload ? v_key AND p_payload->v_key <> 'null'::jsonb THEN
        IF jsonb_typeof(p_payload->v_key) NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be numeric', v_key;
        END IF;
        v_text := p_payload->>v_key;
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be a finite decimal', v_key;
        END IF;
        v_number := v_text::numeric;
        v_canonical := v_canonical || jsonb_build_object(v_key, to_jsonb(v_number));
      END IF;
    END LOOP;

    IF p_payload ? 'wind_direction' AND p_payload->'wind_direction' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'wind_direction') <> 'string' OR length(p_payload->>'wind_direction') > 64 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: wind_direction must be text up to 64 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('wind_direction', p_payload->>'wind_direction');
    END IF;

    IF p_payload ? 'notes' AND p_payload->'notes' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'notes') <> 'string' OR length(p_payload->>'notes') > 4000 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: notes must be text up to 4000 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('notes', p_payload->>'notes');
    END IF;

    FOREACH v_key IN ARRAY ARRAY['actual_start_time', 'actual_end_time']::text[]
    LOOP
      IF p_payload ? v_key AND p_payload->v_key <> 'null'::jsonb THEN
        IF jsonb_typeof(p_payload->v_key) <> 'string' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be an ISO timestamp', v_key;
        END IF;
        BEGIN
          v_timestamp := (p_payload->>v_key)::timestamptz;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be an ISO timestamp', v_key;
        END;
        v_canonical := v_canonical || jsonb_build_object(v_key, to_jsonb(v_timestamp));
      END IF;
    END LOOP;

    IF p_payload ? 'field_acres' AND p_payload->'field_acres' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'field_acres') <> 'array' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: field_acres must be an array';
      END IF;
      v_field_acres := p_payload->'field_acres';
      IF jsonb_array_length(v_field_acres) > 500 THEN
        RAISE EXCEPTION 'PAYLOAD_TOO_LARGE: field_acres exceeds 500 entries';
      END IF;

      FOR v_value IN SELECT value FROM jsonb_array_elements(v_field_acres)
      LOOP
        IF jsonb_typeof(v_value) <> 'object'
           OR (v_value - ARRAY['field_id', 'acres_applied']) <> '{}'::jsonb
           OR NOT (v_value ? 'field_id')
           OR NOT (v_value ? 'acres_applied') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: field_acres entry shape is invalid';
        END IF;
        v_text := v_value->>'field_id';
        IF v_text IS NULL OR v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: field_id must be a UUID';
        END IF;
        v_uuid := v_text::uuid;
        IF v_seen_fields ? v_uuid::text THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: duplicate field_id';
        END IF;
        v_seen_fields := v_seen_fields || jsonb_build_object(v_uuid::text, true);

        IF jsonb_typeof(v_value->'acres_applied') NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied must be numeric';
        END IF;
        v_text := v_value->>'acres_applied';
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied must be a finite decimal';
        END IF;
        v_number := v_text::numeric;
        IF v_number < 0 THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied cannot be negative';
        END IF;
        v_canonical_field_acres := v_canonical_field_acres || jsonb_build_array(
          jsonb_build_object('field_id', v_uuid, 'acres_applied', v_number)
        );
      END LOOP;

      SELECT COALESCE(jsonb_agg(e.value ORDER BY e.value->>'field_id'), '[]'::jsonb)
        INTO v_canonical_field_acres
        FROM jsonb_array_elements(v_canonical_field_acres) e(value);
      v_canonical := v_canonical || jsonb_build_object('field_acres', v_canonical_field_acres);
    END IF;

    SELECT j.applicator_id, j.updated_at
      INTO v_job_applicator, v_target_updated_at
      FROM public.jobs j
     WHERE j.id = p_entity_id;
    v_target_exists := FOUND;

    v_authorized := v_target_exists AND (
      public.is_admin()
      OR public.is_sales_rep()
      OR public._is_job_applicator(p_entity_id)  -- KI-73 part C: access ends when the job ends
      OR (
        public.is_applicator()
        AND public._is_dispatched_to_me(p_entity_id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.job_fields jf2
          WHERE jf2.job_id = p_entity_id
            AND NOT EXISTS (
              SELECT 1
              FROM public.job_location_dispatches d2
              WHERE d2.job_field_id = jf2.id
                AND d2.dispatch_status = 'dispatched'
                AND (
                  d2.applicator_id = v_actor
                  OR (
                    d2.crew_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                      WHERE gcm.crew_id = d2.crew_id
                        AND gcm.profile_id = v_actor
                        AND gcm.is_active
                        AND gc.is_active
                    )
                  )
                )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.job_location_dispatches d
          WHERE d.job_id = p_entity_id
            AND d.dispatch_status = 'dispatched'
            AND NOT (
              (d.applicator_id IS NOT NULL AND d.applicator_id = v_actor)
              OR (
                d.crew_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM public.ground_crew_members gcm
                  JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                  WHERE gcm.crew_id = d.crew_id
                    AND gcm.profile_id = v_actor
                    AND gcm.is_active
                    AND gc.is_active
                )
              )
            )
        )
      )
    );

    IF v_target_exists AND p_payload ? 'field_acres' AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_canonical_field_acres) e(value)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.job_fields jf
        WHERE jf.job_id = p_entity_id
          AND jf.field_id = (e.value->>'field_id')::uuid
      )
    ) THEN
      v_payload_requires_review := true;
      v_payload_review_summary := 'A saved field no longer belongs to this job. Office review is required.';
    END IF;
  END IF;

  IF NOT v_target_exists THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'TARGET_NOT_FOUND';
    v_failure_summary := 'The referenced delivery or job no longer exists.';
  ELSIF NOT v_authorized THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'NOT_AUTHORIZED';
    v_failure_summary := 'The current user is no longer authorized to complete this delivery or job.';
  ELSIF p_entity_snapshot_at IS NULL THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'LEGACY_OUTCOME_UNKNOWN';
    v_failure_summary := 'This saved action does not include a target snapshot. Office review is required before it can run.';
  ELSIF p_entity_snapshot_at IS NOT NULL
        AND v_target_updated_at IS DISTINCT FROM p_entity_snapshot_at THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'TARGET_STATE_CONFLICT';
    v_failure_summary := 'The delivery or job changed after this action was saved offline. Office review is required.';
  ELSIF v_payload_requires_review THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'PAYLOAD_INVALID';
    v_failure_summary := v_payload_review_summary;
  END IF;

  INSERT INTO public.offline_action_receipts (
    client_action_id, actor_id, operation, entity_id, schema_version,
    client_created_at, entity_snapshot_at, request_payload, idempotency_key,
    status, failure_code, failure_summary, needs_review_at
  ) VALUES (
    p_client_action_id, v_actor, p_operation, p_entity_id, p_schema_version,
    p_client_created_at, p_entity_snapshot_at, v_canonical, p_idempotency_key,
    v_initial_status, v_failure_code, v_failure_summary,
    CASE WHEN v_initial_status = 'needs_review' THEN v_now ELSE NULL END
  )
  ON CONFLICT DO NOTHING;

  SELECT *
    INTO v_existing
    FROM public.offline_action_receipts r
   WHERE r.client_action_id = p_client_action_id;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.offline_action_receipts r
      WHERE r.idempotency_key = p_idempotency_key
    ) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
    END IF;
    RAISE EXCEPTION 'OFFLINE_STAGE_CONFLICT';
  END IF;

  IF v_existing.actor_id IS DISTINCT FROM v_actor
     OR v_existing.operation IS DISTINCT FROM p_operation
     OR v_existing.entity_id IS DISTINCT FROM p_entity_id
     OR v_existing.schema_version IS DISTINCT FROM p_schema_version
     OR v_existing.client_created_at IS DISTINCT FROM p_client_created_at
     OR v_existing.entity_snapshot_at IS DISTINCT FROM p_entity_snapshot_at
     OR v_existing.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR v_existing.request_payload IS DISTINCT FROM v_canonical THEN
    RAISE EXCEPTION 'OFFLINE_ACTION_ID_REUSE';
  END IF;

  RETURN jsonb_build_object(
    'client_action_id', v_existing.client_action_id,
    'operation', v_existing.operation,
    'entity_id', v_existing.entity_id,
    'status', v_existing.status,
    'result', v_existing.result,
    'failure_code', v_existing.failure_code,
    'failure_summary', v_existing.failure_summary,
    'attempt_count', v_existing.attempt_count,
    'client_created_at', v_existing.client_created_at,
    'received_at', v_existing.received_at,
    'updated_at', v_existing.updated_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.stamp_job_printed(p_job_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cached jsonb;
BEGIN
  -- Visibility gate FIRST (Codex P2 hardening: never serve a cached replay to a
  -- caller who can't see the job). Mirror jobs_select (admin / sales / assigned
  -- applicator) plus jobs_select_location_dispatchee (_is_dispatched_to_me).
  -- Anyone who can read the job can print it, so they must be able to record
  -- that they did.
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = p_job_id
      AND (
        is_admin()
        OR is_sales_rep()
        OR public._is_job_applicator(j.id)  -- KI-73 part C: access ends when the job ends
        OR _is_dispatched_to_me(j.id)
      )
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Job not found or not visible');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'stamp_job_printed');
    IF v_cached IS NOT NULL THEN
      -- Codex P2 hardening: check_idempotency keys on (key, operation) only, so a
      -- reused key with a DIFFERENT job must not replay the other job's result.
      IF v_cached->>'job_id' IS DISTINCT FROM p_job_id::text THEN
        RETURN json_build_object('success', false, 'error', 'IDEMPOTENCY_ARGUMENT_MISMATCH');
      END IF;
      RETURN v_cached::json;
    END IF;
  END IF;

  UPDATE public.jobs
     SET printed_at = now(),
         last_printed_by = (SELECT auth.uid())
   WHERE id = p_job_id;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'stamp_job_printed',
      jsonb_build_object('success', true, 'job_id', p_job_id));
  END IF;

  RETURN json_build_object('success', true, 'job_id', p_job_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_job_fields_with_geojson(p_job_id uuid)
 RETURNS TABLE(id uuid, customer_id uuid, field_name text, total_acres numeric, measured_acres numeric, override_acres numeric, centroid_geojson text, boundary_geojson text, sort_order integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT
    f.id, f.customer_id, f.field_name, f.total_acres,
    -- Two-acre model (migration 20260623120000): the map's billable-acre label uses
    -- override ?? measured ?? total. Carry both so the label isn't stale legacy acres.
    f.measured_acres, f.override_acres,
    ST_AsGeoJSON(f.centroid)::text  AS centroid_geojson,
    -- Codex post-fix P2: fields.boundary_geom is the CANONICAL full-field MultiPolygon
    -- (set by set_field_boundary; multi-part fields union all field_polygons parts into
    -- it). The legacy geography(POLYGON) `boundary` holds only the first/single part, so
    -- using it would silently drop the other parts of a multi-part field on the map.
    -- Prefer boundary_geom; fall back to the legacy boundary only when geom is absent.
    ST_AsGeoJSON(COALESCE(f.boundary_geom, f.boundary::geometry))::text AS boundary_geojson,
    jf.sort_order
  FROM public.job_fields jf
  JOIN public.fields f ON f.id = jf.field_id
  WHERE jf.job_id = p_job_id
    -- Same visibility gate as the jobs SELECT policies: admin / sales_rep / the
    -- assigned applicator (jobs_select) OR a location-dispatched crew member
    -- (jobs_select_location_dispatchee).
    AND EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id
        AND (
          is_admin()
          OR is_sales_rep()
          OR public._is_job_applicator(j.id)  -- KI-73 part C: access ends when the job ends
          OR _is_dispatched_to_me(j.id)
        )
    )
  ORDER BY jf.sort_order NULLS LAST, f.field_name;
$function$;

CREATE OR REPLACE FUNCTION public.get_jobs_billed_customers(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, customer_id uuid, farm_name text, account_number text, is_primary boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN;  -- empty input -> empty set
  END IF;

  RETURN QUERY
  WITH input_jobs AS (
    SELECT DISTINCT v.job_id FROM unnest(p_job_ids) AS v(job_id)
  ),
  -- VISIBLE jobs only: self-gate per job on the FULL live jobs visibility — BOTH
  -- SELECT policies OR'd together, so we never under-resolve a job the caller can
  -- actually see:
  --   jobs_select:                     is_admin OR is_sales_rep OR (is_applicator AND applicator_id = auth.uid())
  --   jobs_select_location_dispatchee: _is_dispatched_to_me(job_id)  (per-location / crew dispatch)
  -- Without the dispatch leg, a per-location-dispatched applicator's /jobs row would
  -- fall back to primary-only and HIDE co-billed split owners — the exact bug FIX 2
  -- closes (Codex). A job the caller can't view is SKIPPED (fail-soft), never raised on.
  visible_jobs AS (
    SELECT j.id AS job_id, j.customer_id AS primary_customer_id
    FROM jobs j
    JOIN input_jobs ij ON ij.job_id = j.id
    WHERE is_admin()
       OR is_sales_rep()
       OR public._is_job_applicator(j.id)  -- KI-73 part C: access ends when the job ends
       OR _is_dispatched_to_me(j.id)
  ),
  job_field_ids AS (
    -- Every field on each visible job (the unit of billing precedence).
    SELECT vj.job_id, jf.field_id
    FROM visible_jobs vj
    JOIN job_fields jf ON jf.job_id = vj.job_id AND jf.field_id IS NOT NULL
  ),
  fields_with_share AS (
    -- Shares whose field is ACTUALLY on the job (ignore an orphan share row).
    SELECT DISTINCT jfs.job_id, jfs.field_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.job_id = jfs.job_id AND jfi.field_id = jfs.field_id
  ),
  resolved AS (
    -- 1. Saved per-field shares (explicit split) — only for fields on the job.
    SELECT jfs.job_id, jfs.customer_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.job_id = jfs.job_id AND jfi.field_id = jfs.field_id
    WHERE jfs.customer_id IS NOT NULL

    UNION ALL

    -- 2. field_billing_defaults for fields WITHOUT a saved share.
    SELECT jfi.job_id, fbd.customer_id
    FROM job_field_ids jfi
    JOIN field_billing_defaults fbd ON fbd.field_id = jfi.field_id
    WHERE NOT EXISTS (
            SELECT 1 FROM fields_with_share fws
            WHERE fws.job_id = jfi.job_id AND fws.field_id = jfi.field_id
          )
      AND fbd.customer_id IS NOT NULL

    UNION ALL

    -- 3. The job's PRIMARY customer for fields with neither a share nor a default.
    SELECT jfi.job_id, vj.primary_customer_id
    FROM job_field_ids jfi
    JOIN visible_jobs vj ON vj.job_id = jfi.job_id
    WHERE NOT EXISTS (
            SELECT 1 FROM fields_with_share fws
            WHERE fws.job_id = jfi.job_id AND fws.field_id = jfi.field_id
          )
      AND NOT EXISTS (
            SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = jfi.field_id
          )
      AND vj.primary_customer_id IS NOT NULL

    UNION ALL

    -- 4. SAFETY FALLBACK: a visible job with NO fields still has a primary customer.
    SELECT vj.job_id, vj.primary_customer_id
    FROM visible_jobs vj
    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids jfi WHERE jfi.job_id = vj.job_id)
      AND vj.primary_customer_id IS NOT NULL
  ),
  distinct_pairs AS (
    SELECT DISTINCT r.job_id, r.customer_id FROM resolved r
  )
  -- LEFT JOIN so a since-removed customer_id still surfaces (NULL farm_name); the
  -- client treats a NULL name as INCOMPLETE for compliance docs, but for the LIST
  -- it just shows whatever resolves. is_primary = the job's primary customer.
  SELECT
    d.job_id,
    d.customer_id,
    c.farm_name,
    c.account_number,
    (d.customer_id = vj.primary_customer_id) AS is_primary
  FROM distinct_pairs d
  JOIN visible_jobs vj ON vj.job_id = d.job_id
  LEFT JOIN customers c ON c.id = d.customer_id
  ORDER BY d.job_id, (d.customer_id = vj.primary_customer_id) DESC, c.farm_name NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_job_billed_customers(p_job_id uuid)
 RETURNS TABLE(customer_id uuid, farm_name text, account_number text, is_primary boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_primary_customer_id uuid;
  v_applicator_id uuid;
BEGIN
  -- Load the job's gate columns (definer-privileged read).
  SELECT j.customer_id, j.applicator_id
    INTO v_primary_customer_id, v_applicator_id
  FROM jobs j
  WHERE j.id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- SELF-GATE: mirror the FULL live jobs visibility — BOTH SELECT policies OR'd:
  --   jobs_select:                     is_admin OR is_sales_rep OR (is_applicator AND applicator_id = auth.uid())
  --   jobs_select_location_dispatchee: _is_dispatched_to_me(job_id)  (per-location / crew dispatch)
  -- Without the dispatch leg a per-location-dispatched applicator (who CAN see the
  -- job) is refused here and their compliance PDF is blocked — the exact bug FIX 5
  -- closes. The dispatch helper is SECURITY DEFINER + re-checks active profile / active
  -- crew, so it never widens visibility beyond the live policy. Reject a caller who
  -- can't view the job (do NOT return a partial set — compliance is complete-or-refused).
  -- IS NOT TRUE, not NOT (...): on a job with no whole-job applicator the applicator leg is
  -- NULL, and NOT NULL never refused, so any active applicator got any such job's billed
  -- customers (row 11.4 part B).
  IF (
    is_admin()
    OR is_sales_rep()
    OR public._is_job_applicator(p_job_id)  -- KI-73 part C: access ends when the job ends
    OR _is_dispatched_to_me(p_job_id)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Not authorized to view this job''s billed customers'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH job_field_ids AS (
    -- Every field on the job (field_id is the unit of billing precedence).
    SELECT DISTINCT jf.field_id
    FROM job_fields jf
    WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL
  ),
  fields_with_share AS (
    -- Only shares whose field is ACTUALLY on the job (guard against an orphan
    -- job_field_shares row for a field no longer on the job).
    SELECT DISTINCT jfs.field_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
    WHERE jfs.job_id = p_job_id
  ),
  resolved AS (
    -- 1. Saved per-field shares (explicit split) — only for fields on the job, so an
    --    orphan share (field removed from the job) never adds a customer (Codex LOW).
    SELECT jfs.customer_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
    WHERE jfs.job_id = p_job_id AND jfs.customer_id IS NOT NULL

    UNION ALL

    -- 2. field_billing_defaults for fields WITHOUT a saved share.
    SELECT fbd.customer_id
    FROM job_field_ids jfi
    JOIN field_billing_defaults fbd ON fbd.field_id = jfi.field_id
    WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
      AND fbd.customer_id IS NOT NULL

    UNION ALL

    -- 3. The job's PRIMARY customer for fields that have neither a saved share
    --    nor a billing default.
    SELECT v_primary_customer_id
    FROM job_field_ids jfi
    WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
      AND NOT EXISTS (
        SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = jfi.field_id
      )
      AND v_primary_customer_id IS NOT NULL

    UNION ALL

    -- 4. SAFETY FALLBACK: a job with NO fields at all still has a primary customer
    --    — surface it so the resolver never returns an empty set for a real job
    --    (mirrors the frontend "if custMap empty → add primary" fallback).
    SELECT v_primary_customer_id
    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids)
      AND v_primary_customer_id IS NOT NULL
  )
  -- LEFT JOIN (not INNER) so a billed customer_id that does NOT resolve to a
  -- customers row (e.g. a since-removed customer) still surfaces — as a row with a
  -- NULL farm_name. The frontend resolver treats a NULL/blank name as an INCOMPLETE
  -- resolution and ABORTS the compliance PDF, rather than silently omitting that
  -- billed party.
  SELECT
    d.customer_id,
    c.farm_name,
    c.account_number,
    (d.customer_id = v_primary_customer_id) AS is_primary
  FROM (SELECT DISTINCT r.customer_id FROM resolved r) d
  LEFT JOIN customers c ON c.id = d.customer_id
  ORDER BY (d.customer_id = v_primary_customer_id) DESC, c.farm_name NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(p_applicator_id uuid, p_status text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A dispatch row is VISIBLE to the caller (mirrors job_location_dispatches_select):
  --   admin/sales see all; the job's whole-job applicator sees every row on their job;
  --   otherwise a field user sees a row where they are the assignee or an active member
  --   of the assigned active crew.
  WITH matched AS (
    -- _total_count: every matching job before the 500-row cut, so the board can say "500 of N".
    SELECT j.*, count(*) OVER () AS _total_count
      FROM public.jobs j
     WHERE j.deleted_at IS NULL
       AND p_applicator_id IS NOT NULL
       AND (p_status IS NULL OR j.status = p_status)
       AND (p_start_date IS NULL OR j.job_date >= p_start_date)
       AND (p_end_date IS NULL OR j.job_date <= p_end_date)
       AND (
         -- (a) a CURRENT per-location dispatch to this applicator the CALLER can see
         EXISTS (
           SELECT 1 FROM public.job_location_dispatches d
            WHERE d.job_id = j.id
              AND d.dispatch_status = 'dispatched'
              AND d.applicator_id = p_applicator_id
              AND (
                is_admin()
                OR is_sales_rep()
                OR public._is_job_applicator(j.id)  -- KI-73 part C: access ends when the job ends
                OR d.applicator_id = (select auth.uid())
              )
         )
         OR (
           -- (b) whole-job applicator = this one AND the job has NO per-location dispatch
           j.applicator_id = p_applicator_id
           AND NOT EXISTS (
             SELECT 1 FROM public.job_location_dispatches d2
              WHERE d2.job_id = j.id
                AND d2.dispatch_status = 'dispatched'
           )
         )
       )
       -- VISIBILITY GATE — the live jobs SELECT predicate. Never return a hidden job.
       AND (
         is_admin()
         OR is_sales_rep()
         OR public._is_job_applicator(j.id)  -- KI-73 part C: access ends when the job ends
         OR public._is_dispatched_to_me(j.id)
       )
     ORDER BY j.job_date DESC NULLS LAST, j.id DESC
     LIMIT 500
  )
  SELECT
    -- Job cost is admin-only and readable through get_admin_cost_fields; never send it here.
    (to_jsonb(m) - 'total_cost_cents')
    || jsonb_build_object(
         -- CUSTOMER NAME — RLS-equivalent (Codex re-review-3 P2): this function is
         -- SECURITY DEFINER, so a raw `customers` read would bypass customers_select and
         -- could leak a farm_name the caller can't otherwise see (a sales_rep is limited
         -- to assigned customers; an applicator/driver to a time-windowed set). Return the
         -- name ONLY when the caller would pass customers_select OR
         -- customers_select_location_dispatchee for THIS job's customer; else farm_name
         -- is null (the board renders 'Unknown', exactly as the unfiltered RLS embed would).
         'customer',
         (SELECT jsonb_build_object(
                   'farm_name',
                   CASE WHEN (
                     is_admin()
                     OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                     OR (is_driver() AND EXISTS (
                           SELECT 1 FROM public.deliveries d
                            WHERE d.customer_id = c.id
                              AND d.assigned_driver = (select auth.uid())
                              AND d.scheduled_date >= ((now() AT TIME ZONE 'America/Chicago')::date - interval '1 day')))
                     OR (is_applicator() AND EXISTS (
                           SELECT 1 FROM public.jobs j2
                            WHERE j2.customer_id = c.id
                              AND public._is_job_applicator(j2.id)  -- KI-73 part C: access ends when the job ends
                              AND j2.job_date >= ((now() AT TIME ZONE 'America/Chicago')::date - interval '7 days')))
                     OR EXISTS (
                           SELECT 1 FROM public.jobs j3
                            WHERE j3.customer_id = c.id
                              AND public._is_dispatched_to_me(j3.id))
                   ) THEN c.farm_name ELSE NULL END)
            FROM public.customers c WHERE c.id = m.customer_id),
         -- JOB_FIELDS — job_fields_select is satisfied for every job that passed this
         -- function's visibility gate (admin/sales_rep/whole-job applicator/_is_dispatched_to_me
         -- are exactly its conditions), so listing the rows leaks nothing. field_name is
         -- gated to the fields_select predicate (admin/sales_rep/applicator) so a dispatched
         -- crew member whose role is NOT applicator doesn't get a field name they couldn't
         -- read under RLS (null → the board falls back to 'Field'). (Codex re-review-3 P2.)
         'job_fields',
         coalesce((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', jf.id,
                      'field_id', jf.field_id,
                      'acres_to_treat', jf.acres_to_treat,
                      'sort_order', jf.sort_order,
                      'field', jsonb_build_object(
                        'id', f.id,
                        'field_name', CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                                           THEN f.field_name ELSE NULL END)
                    ) ORDER BY jf.sort_order
                  )
             FROM public.job_fields jf
             JOIN public.fields f ON f.id = jf.field_id
            WHERE jf.job_id = m.id
         ), '[]'::jsonb),
         -- per-location dispatch rows the CALLER can see, for client-side label aggregation
         '_dispatches',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('applicator_id', d.applicator_id, 'crew_id', d.crew_id))
             FROM public.job_location_dispatches d
            WHERE d.job_id = m.id
              AND d.dispatch_status = 'dispatched'
              AND (
                is_admin()
                OR is_sales_rep()
                OR public._is_job_applicator(m.id)  -- KI-73 part C: access ends when the job ends
                OR d.applicator_id = (select auth.uid())
                OR (
                  d.crew_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                     WHERE gcm.crew_id = d.crew_id
                       AND gcm.profile_id = (select auth.uid())
                       AND gcm.is_active
                       AND gc.is_active
                  )
                )
              )
         ), '[]'::jsonb)
       )
    FROM matched m
   ORDER BY m.job_date DESC NULLS LAST, m.id DESC;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatched_list(p_applicator_id uuid DEFAULT NULL::uuid, p_crew_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'dispatch_id',     d.id,
    'job_field_id',    d.job_field_id,
    'job_id',          d.job_id,
    'job_number',      j.job_number,
    'job_status',      j.status,
    -- U12 addition: the job's scheduled date, so the FieldView card shows it
    -- and can sort Today-first / group a Done section without an extra fetch.
    'job_date',        j.job_date,
    -- U12 addition (Codex R1 P1): the underlying fields.id, so the FieldView
    -- completion form can send per-field applied acres keyed by the REAL field id
    -- (job_field_id is the join-row id — application_record_fields.field_id
    -- references fields.id, so the client needs this to build 'field_acres').
    -- Gated to the same role set as field_name (RLS R2 M3): the only consumer
    -- (the completion form) requires is_applicator() anyway, and a dispatched
    -- non-applicator crew member shouldn't get a dereferenceable fields.id when
    -- field_name is deliberately withheld from them.
    'field_id',        CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN jf.field_id ELSE NULL END,
    'dispatch_status', d.dispatch_status,
    'dispatched_at',   d.dispatched_at,
    'assignee_kind',   CASE WHEN d.applicator_id IS NOT NULL THEN 'applicator' ELSE 'crew' END,
    'applicator_id',   d.applicator_id,
    'crew_id',         d.crew_id,
    -- assignee NAME resolved server-side. field_name gated to the fields_select roles
    -- (admin/sales_rep/applicator) so a dispatched crew member whose role is not
    -- applicator never receives a field name they couldn't read under RLS (null ->
    -- the client falls back to 'Field'). Customer name gated likewise.
    'assignee_name',   CASE WHEN d.applicator_id IS NOT NULL
                            THEN (SELECT p.full_name FROM profiles p WHERE p.id = d.applicator_id)
                            ELSE (SELECT g.name FROM ground_crews g WHERE g.id = d.crew_id) END,
    'field_name',      CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN (SELECT f.field_name FROM fields f WHERE f.id = jf.field_id)
                            ELSE NULL END,
    'customer_name',   CASE WHEN (
                              is_admin()
                              OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                              OR (is_applicator() AND EXISTS (
                                    SELECT 1 FROM public.jobs j2
                                     WHERE j2.customer_id = c.id
                                       AND public._is_job_applicator(j2.id)  -- KI-73 part C: access ends when the job ends
                                       AND j2.job_date >= ((now() AT TIME ZONE 'America/Chicago')::date - interval '7 days')))
                              OR EXISTS (
                                    SELECT 1 FROM public.jobs j3
                                     WHERE j3.customer_id = c.id
                                       AND public._is_dispatched_to_me(j3.id))
                            ) THEN c.farm_name ELSE NULL END,
    'location_acres',  jf.acres_to_treat,
    'job_applied_acres', j.applied_acres,
    'job_total_acres',   j.total_acres
  )
    FROM public.job_location_dispatches d
    JOIN public.jobs j        ON j.id = d.job_id AND j.deleted_at IS NULL AND j.status <> 'cancelled'  -- KI-73 part C
                             AND (is_admin() OR is_sales_rep() OR j.status IN ('scheduled', 'in_progress') OR j.completed_at >= now() - interval '7 days')  -- KI-73 part C: for field callers, a finished job's dispatch ends 7 days after the job (office staff still see a row left open)
    JOIN public.job_fields jf ON jf.id = d.job_field_id
    JOIN public.customers c   ON c.id = j.customer_id
   WHERE (
       d.dispatch_status = 'dispatched'
       -- A1: also return RECENTLY-completed dispatch rows (the job-terminal trigger
       -- flips rows to 'completed' when the job completes) so a just-finished job
       -- moves to the FieldView "Done" section instead of vanishing. 7-day window
       -- bounds the tail; 'cancelled' rows stay EXCLUDED — an undispatched
       -- applicator must not keep seeing the job (undispatch_job_locations also
       -- writes 'cancelled').
       OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
     )
     AND (p_applicator_id IS NULL OR d.applicator_id = p_applicator_id)
     AND (p_crew_id IS NULL OR d.crew_id = p_crew_id)
     -- VISIBILITY GATE — mirrors job_location_dispatches_select, with ONE deliberate
     -- A1 relaxation: the table policy's assignee/crew branches require
     -- dispatch_status='dispatched', but this gate intentionally does NOT — otherwise
     -- a per-location assignee's just-completed rows would never reach their Done
     -- section (the whole point of the 7-day completed tail). The rows are still
     -- bounded to the caller's OWN dispatches (or their active crew's) — data they
     -- could already read while the row was 'dispatched'. is_admin()/is_sales_rep()/
     -- is_applicator() each re-check profiles.is_active internally, BUT the bare
     -- `applicator_id = auth.uid()` and crew-member branches must ALSO re-check is_active
     -- — this is a SECURITY DEFINER read that bypasses RLS, so without the re-check a
     -- DEACTIVATED user with a still-valid token would keep seeing their dispatch rows
     -- (the #36 policy includes this active-profile guard for exactly this reason —
     -- Codex #37 P1).
     AND (
       is_admin()
       OR is_sales_rep()
       OR public._is_job_applicator(j.id)  -- KI-73 part C: access ends when the job ends
       OR (
         d.applicator_id = (select auth.uid())
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
       )
       OR (
         d.crew_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
         AND EXISTS (
           SELECT 1 FROM public.ground_crew_members gcm
             JOIN public.ground_crews gc ON gc.id = gcm.crew_id
            WHERE gcm.crew_id = d.crew_id
              AND gcm.profile_id = (select auth.uid())
              AND gcm.is_active
              AND gc.is_active
         )
       )
     )
   -- d.id is the UNIQUE tiebreaker that makes this a TOTAL order — without it two
   -- same-job/same-transaction rows (equal dispatched_at) can be skipped/duplicated
   -- across a .range() page boundary (Codex #37 follow-up LOW).
   ORDER BY j.job_number, d.dispatched_at DESC, d.id;
$function$;

-- The tables. ----------------------------------------------------------------------------------------
ALTER POLICY jobs_select ON public.jobs
  USING (is_admin() OR is_sales_rep() OR public._is_job_applicator(id));

-- A dispatchee reads a dispatch row only while its job is not deleted or cancelled (_is_dispatched_to_me).
ALTER POLICY job_location_dispatches_select ON public.job_location_dispatches
  USING (is_admin() OR is_sales_rep()
         OR (public._is_dispatched_to_me(job_id)
             AND ((dispatch_status = 'dispatched' AND applicator_id = (SELECT auth.uid())
                   AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active))
                  OR (dispatch_status = 'dispatched' AND crew_id IS NOT NULL
                      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active)
                      AND EXISTS (SELECT 1 FROM public.ground_crew_members gcm
                                    JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                                   WHERE gcm.crew_id = job_location_dispatches.crew_id
                                     AND gcm.profile_id = (SELECT auth.uid())
                                     AND gcm.is_active AND gc.is_active))))
         OR EXISTS (SELECT 1 FROM public.jobs j
                     WHERE j.id = job_location_dispatches.job_id AND is_applicator()
                       AND j.applicator_id = (SELECT auth.uid())));

-- Dispatch-only applicators read the rest of the job they are sent to (Mason, 2026-10-25).
ALTER POLICY job_field_shares_select ON public.job_field_shares
  USING (is_admin() OR is_sales_rep() OR public._is_job_applicator(job_id)
         OR (is_applicator() AND public._is_dispatched_to_me(job_id)));

ALTER POLICY job_applied_info_select ON public.job_applied_info
  USING (is_admin() OR is_sales_rep() OR public._is_job_applicator(job_id)
         OR (is_applicator() AND public._is_dispatched_to_me(job_id)));

ALTER POLICY job_applied_records_select ON public.job_applied_records
  USING (is_admin() OR is_sales_rep() OR public._is_job_applicator(job_id)
         OR (is_applicator() AND public._is_dispatched_to_me(job_id)));

ALTER POLICY job_applied_record_fields_select ON public.job_applied_record_fields
  USING (EXISTS (SELECT 1 FROM public.job_applied_records r
                  WHERE r.id = job_applied_record_fields.application_record_id
                    AND (is_admin() OR is_sales_rep() OR public._is_job_applicator(r.job_id)
                         OR (is_applicator() AND public._is_dispatched_to_me(r.job_id)))));

ALTER POLICY job_applied_record_crew_select ON public.job_applied_record_crew
  USING (EXISTS (SELECT 1 FROM public.job_applied_records r
                  WHERE r.id = job_applied_record_crew.application_record_id
                    AND (is_admin() OR is_sales_rep() OR public._is_job_applicator(r.job_id)
                         OR (is_applicator() AND public._is_dispatched_to_me(r.job_id)))));

ALTER POLICY job_attachments_select ON public.job_attachments
  USING (is_admin() OR is_sales_rep() OR public._is_job_applicator(job_id)
         OR (is_applicator() AND public._is_dispatched_to_me(job_id)));

-- Attachment photos: the folder is the job id. The subquery on jobs runs under jobs' row security.
ALTER POLICY job_attachments_objects_select ON storage.objects
  USING (bucket_id = 'job-attachments'
         AND (is_admin() OR is_sales_rep()
              OR (is_applicator() AND EXISTS (
                    SELECT 1 FROM public.jobs j
                     WHERE j.id::text = (storage.foldername(objects.name))[1]
                       AND (public._is_job_applicator(j.id) OR public._is_dispatched_to_me(j.id))))));

DO $postflight$
DECLARE
  v_fn record;
  v_pol record;
BEGIN
  IF to_regclass('pg_temp.job_access_ends_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.job_access_ends_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  FOR v_fn IN
    SELECT t.sig, t.new_md5, md5(replace(p.prosrc, chr(13), '')) AS body_md5,
           pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
           a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
           a.provolatile AS was_volatile, a.prosecdef AS was_secdef
      FROM (VALUES
      ('public._is_dispatched_to_me(uuid)',                                                                                'cfb7c305fc8967e612e3e0493e457b15'),
      ('public._can_see_field(uuid)',                                                                                      'be73b62d016aeda73d7fa59dd1e4bbfc'),
      ('public._start_job_replay_impl_20261015(uuid,uuid,text)',                                                           '31412ba33e4d6eebd145b7813878a655'),
      ('public._complete_job_replay_impl_20261015(uuid,jsonb,uuid,text)',                                                  '3bd9dfe0729d8175ffbb1cf16b258b5c'),
      ('public.stage_offline_action(uuid,text,uuid,integer,timestamp with time zone,jsonb,text,timestamp with time zone)', 'e3f9a5aaa1d9ac54bf9cee0546b057f9'),
      ('public.stamp_job_printed(uuid,text)',                                                                              '703fea70b896a1b1da1f159d041cb6f7'),
      ('public.get_job_fields_with_geojson(uuid)',                                                                         '7a74cd4b1df93b8a9afd0f99fd7beae0'),
      ('public.get_jobs_billed_customers(uuid[])',                                                                         '42bb182795a3a5cbbcf3106eaab97625'),
      ('public.get_job_billed_customers(uuid)',                                                                            '316d0eb63b76ef9a640a70db22b4f40c'),
      ('public.get_dispatch_board_jobs(uuid,text,date,date)',                                                              'cc849915c479a72bc391f359ccd1fa8f'),
      ('public.get_dispatched_list(uuid,uuid)',                                                                            '4aa483b79727c0cafd883ba8ec73fb4b')
      ) AS t(sig, new_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
      -- CREATE OR REPLACE keeps each OID, so the preflight snapshot is matched by OID.
      LEFT JOIN pg_temp.job_access_ends_attrs a ON a.fn_oid = p.oid
  LOOP
    IF v_fn.body_md5 IS DISTINCT FROM v_fn.new_md5
       OR v_fn.was_owner IS NULL
       OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
       OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
       OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
       OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
       OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
       OR v_fn.prosecdef IS DISTINCT FROM v_fn.was_secdef
       OR NOT v_fn.prosecdef THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.sig, v_fn.body_md5;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_temp.job_access_ends_attrs) <> 11 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not every pinned function was snapshotted';
  END IF;

  -- The new helper: definer, stable, fixed search_path, executable by signed-in users only.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._is_job_applicator(uuid)')
       AND p.prosecdef AND p.provolatile = 's' AND p.prorettype = 'boolean'::regtype
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']
       AND md5(replace(p.prosrc, chr(13), '')) = '68a07dc00ab865fc43890f9ed40aadc2')
     OR has_function_privilege('anon', 'public._is_job_applicator(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public._is_job_applicator(uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = to_regprocedure('public._is_job_applicator(uuid)') AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public._is_job_applicator(uuid) is not the expected function or grants';
  END IF;

  -- The completion clock: the column, its trigger (BEFORE INSERT OR UPDATE, row, enabled), and a function
  -- no signed-in user can call.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.jobs'::regclass AND attname = 'completed_at' AND NOT attisdropped
                    AND atttypid = 'timestamptz'::regtype AND NOT attnotnull AND NOT atthasdef AND attgenerated = '')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'trg_stamp_job_completed_at'
                       AND t.tgenabled = 'O' AND t.tgtype = 23
                       AND t.tgfoid = to_regprocedure('public._stamp_job_completed_at()'))
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public._stamp_job_completed_at()')
                       AND NOT p.prosecdef AND p.prorettype = 'trigger'::regtype
                       AND p.proconfig = ARRAY['search_path=public, pg_temp']
                       AND md5(replace(p.prosrc, chr(13), '')) = '50f49554b6ca17ca9dd822ef0ee285cf')
     OR has_function_privilege('authenticated', 'public._stamp_job_completed_at()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._stamp_job_completed_at()', 'EXECUTE')
     OR NOT has_column_privilege('authenticated', 'public.jobs', 'completed_at', 'SELECT')
     OR has_column_privilege('authenticated', 'public.jobs', 'completed_at', 'INSERT')
     OR has_column_privilege('authenticated', 'public.jobs', 'completed_at', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: jobs.completed_at or its trigger is not the expected one';
  END IF;

  FOR v_pol IN
    SELECT * FROM (VALUES
      ('public', 'jobs', 'jobs_select', '{authenticated}', '(is_admin() OR is_sales_rep() OR _is_job_applicator(id))'),
      ('public', 'job_location_dispatches', 'job_location_dispatches_select', '{authenticated}', E'(is_admin() OR is_sales_rep() OR (_is_dispatched_to_me(job_id) AND (((dispatch_status = \'dispatched\'::text) AND (applicator_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1\n   FROM profiles p\n  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND p.is_active)))) OR ((dispatch_status = \'dispatched\'::text) AND (crew_id IS NOT NULL) AND (EXISTS ( SELECT 1\n   FROM profiles p\n  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND p.is_active))) AND (EXISTS ( SELECT 1\n   FROM (ground_crew_members gcm\n     JOIN ground_crews gc ON ((gc.id = gcm.crew_id)))\n  WHERE ((gcm.crew_id = job_location_dispatches.crew_id) AND (gcm.profile_id = ( SELECT auth.uid() AS uid)) AND gcm.is_active AND gc.is_active)))))) OR (EXISTS ( SELECT 1\n   FROM jobs j\n  WHERE ((j.id = job_location_dispatches.job_id) AND is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))'),
      ('public', 'job_field_shares', 'job_field_shares_select', '{authenticated}', '(is_admin() OR is_sales_rep() OR _is_job_applicator(job_id) OR (is_applicator() AND _is_dispatched_to_me(job_id)))'),
      ('public', 'job_applied_info', 'job_applied_info_select', '{authenticated}', '(is_admin() OR is_sales_rep() OR _is_job_applicator(job_id) OR (is_applicator() AND _is_dispatched_to_me(job_id)))'),
      ('public', 'job_applied_records', 'job_applied_records_select', '{authenticated}', '(is_admin() OR is_sales_rep() OR _is_job_applicator(job_id) OR (is_applicator() AND _is_dispatched_to_me(job_id)))'),
      ('public', 'job_applied_record_fields', 'job_applied_record_fields_select', '{authenticated}', E'(EXISTS ( SELECT 1\n   FROM job_applied_records r\n  WHERE ((r.id = job_applied_record_fields.application_record_id) AND (is_admin() OR is_sales_rep() OR _is_job_applicator(r.job_id) OR (is_applicator() AND _is_dispatched_to_me(r.job_id))))))'),
      ('public', 'job_applied_record_crew', 'job_applied_record_crew_select', '{authenticated}', E'(EXISTS ( SELECT 1\n   FROM job_applied_records r\n  WHERE ((r.id = job_applied_record_crew.application_record_id) AND (is_admin() OR is_sales_rep() OR _is_job_applicator(r.job_id) OR (is_applicator() AND _is_dispatched_to_me(r.job_id))))))'),
      ('public', 'job_attachments', 'job_attachments_select', '{authenticated}', '(is_admin() OR is_sales_rep() OR _is_job_applicator(job_id) OR (is_applicator() AND _is_dispatched_to_me(job_id)))'),
      ('storage', 'objects', 'job_attachments_objects_select', '{authenticated}', E'((bucket_id = \'job-attachments\'::text) AND (is_admin() OR is_sales_rep() OR (is_applicator() AND (EXISTS ( SELECT 1\n   FROM jobs j\n  WHERE (((j.id)::text = (storage.foldername(objects.name))[1]) AND (_is_job_applicator(j.id) OR _is_dispatched_to_me(j.id))))))))')
    ) AS t(sch, tbl, pol, roles, new_qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pp
       WHERE pp.schemaname = v_pol.sch AND pp.tablename = v_pol.tbl AND pp.policyname = v_pol.pol
         AND pp.cmd = 'SELECT' AND pp.permissive = 'PERMISSIVE' AND pp.roles::text = v_pol.roles
         AND pp.qual = v_pol.new_qual AND pp.with_check IS NULL) THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: policy % on %.% is not the expected one: %', v_pol.pol, v_pol.sch, v_pol.tbl,
        (SELECT pp.qual FROM pg_policies pp WHERE pp.schemaname = v_pol.sch AND pp.tablename = v_pol.tbl AND pp.policyname = v_pol.pol);
    END IF;
  END LOOP;
  RAISE NOTICE 'POSTFLIGHT_OK: job access ends with the job (KI-73 part C)';
END;
$postflight$;
