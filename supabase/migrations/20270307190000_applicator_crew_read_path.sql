-- 20270307190000_applicator_crew_read_path.sql
-- Record: docs/reference/migrations.d/20270307190000_applicator_crew_read_path.md
-- Contract: docs/plans/2026-11-25-applicator-crew-read-path-CONTRACT.md (step 1 of 3; Sol finding 1 on #2574, Mason: "fix").
--
-- WHAT: four read-only "crew" views give applicators, dispatchees and crew members the job rows they read today WITHOUT
--   the job selling price, cost, internal memo, commission split, chemical prices, or billing split percentages:
--     jobs_crew                    = jobs minus total_price_cents, total_cost_cents, internal_memo, commission_split
--     job_chemicals_crew           = job_chemicals minus price_per_unit_cents, cost_per_unit_cents
--     job_field_shares_crew        = job_field_shares minus split_pct
--     field_billing_defaults_crew  = field_billing_defaults minus split_pct, price_override_cents, pricing_note
--   Each view's row filter is today's SELECT policy text, verbatim, OR'd with "the current role bypasses RLS", so
--   SECURITY DEFINER functions (running as postgres) and service_role keep reading every row, exactly as they do today.
--   Policies and invoker functions that read jobs / job_chemicals inline now read the crew views (text swap only), and
--   the dispatch board sends non-office callers the jobs_crew projection of each row.
--
-- BEHAVIOR TODAY: neutral. The base tables' crew SELECT branches stay on, so every swapped read returns the same rows
--   (local before/after probe: exact row ids and payloads per actor). The one visible change: dispatch board rows for
--   non-office callers no longer contain total_price_cents, internal_memo, commission_split (the board screen reads none).
--   Step 2 (app, #2574) moves crew screens to the views; step 3 (its own migration) removes the crew branches from the
--   base tables' SELECT policies.
--
-- NOT CHANGED: every write policy's meaning, office (admin, sales rep) reads, column grants, data.
--
-- ROLLBACK (its own reviewed migration, only while step 2 is not deployed, because step 2 reads the views):
--   scripts/smoke/applicator-crew-read-path-reverse.sql restores the 24 policies and 5 functions to their previous text,
--   then removes the four views; the proof shows every result returns to the before state.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE crew_read_path_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_sp text := current_setting('search_path');
  v_hash text;
  v_count integer;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.crew_read_path_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.crew_read_path_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regclass('public.jobs_crew') IS NOT NULL OR to_regclass('public.job_chemicals_crew') IS NOT NULL
     OR to_regclass('public.job_field_shares_crew') IS NOT NULL OR to_regclass('public.field_billing_defaults_crew') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: a crew view already exists (already applied?)';
  END IF;
  -- The functions below are replaced with their current text plus a swap; refuse if any changed since this was generated.
  IF (SELECT string_agg(md5(prosrc), ',' ORDER BY proname COLLATE "C") FROM pg_proc WHERE oid IN (
        'public._enforce_billed_job_applied_record_immutability()'::regprocedure,
        'public.get_notes_for_entity(text,uuid)'::regprocedure,
        'public.worksheet_weight_is_valid(public.job_loader_worksheet_weights)'::regprocedure,
        'public.get_loader_worksheet_weights(uuid[],uuid[])'::regprocedure,
        'public.get_dispatch_board_jobs(uuid,text,date,date)'::regprocedure))
     IS DISTINCT FROM 'ac99ddf04062a918a84d47a344f61b3e,cc849915c479a72bc391f359ccd1fa8f,f900287b2f8c335c96db4c454c01a3d6,3aff5d6775914808e15bccac72e92ec1,4f160c4234e594417c89883b410ef5a4' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: a swapped function changed since this migration was generated; regenerate it';
  END IF;
  -- Policies are compared as deparsed with fully qualified names.
  PERFORM set_config('search_path', 'pg_catalog', true);
  SELECT md5(string_agg(schemaname||'.'||tablename||'.'||policyname||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\n' ORDER BY schemaname COLLATE "C", tablename COLLATE "C", policyname COLLATE "C")), count(*)
    INTO v_hash, v_count
    FROM pg_policies WHERE (coalesce(qual,'')||coalesce(with_check,'')) ~ '(FROM|JOIN) (public\.)?jobs\M';
  IF v_count <> 24 OR v_hash IS DISTINCT FROM '736f967dc9975625287dbc5a1f9e03e6' THEN
    PERFORM set_config('search_path', v_sp, true);
    RAISE EXCEPTION 'PREFLIGHT_FAIL: the % policies that read jobs inline differ from the generated set; regenerate', v_count;
  END IF;
  SELECT md5(string_agg(tablename||'.'||policyname||'|'||coalesce(qual,''), E'\n' ORDER BY tablename COLLATE "C", policyname COLLATE "C")), count(*)
    INTO v_hash, v_count
    FROM pg_policies WHERE schemaname = 'public' AND (tablename, policyname) IN (('jobs','jobs_select'),('jobs','jobs_select_location_dispatchee'),
      ('job_chemicals','job_chemicals_select'),('job_chemicals','job_chemicals_select_location_dispatchee'),
      ('job_field_shares','job_field_shares_select'),('field_billing_defaults','fbd_select'));
  PERFORM set_config('search_path', v_sp, true);
  IF v_count <> 6 OR v_hash IS DISTINCT FROM 'f8bd0f3e46e4d869449a5c23f145b9fa' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: a SELECT policy copied into a crew view changed; regenerate';
  END IF;
END
$preflight$;

-- ---------- 1. Crew views: base table minus protected columns, today's row rule verbatim ----------
CREATE VIEW public.jobs_crew WITH (security_barrier = true) AS
SELECT jobs.id, jobs.job_number, jobs.customer_id, jobs.status, jobs.job_date, jobs.scheduled_time, jobs.applicator_id, jobs.vehicle_id, jobs.recipe_id, jobs.notes, jobs.tags, jobs.batch_id, jobs.season, jobs.total_acres, jobs.invoice_id, jobs.created_by, jobs.deleted_at, jobs.created_at, jobs.updated_at, jobs.priority, jobs.estimated_hours, jobs.quote_id, jobs.quote_section_id, jobs.application_service_id, jobs.call_date, jobs.date_proposed, jobs.time_proposed, jobs.schedule_date, jobs.date_expires, jobs.consultant_id, jobs.loader_comment, jobs.additional_info, jobs.applied_acres, jobs.updated_by, jobs.printed_at, jobs.remaining_acres, jobs.ground_crew_id, jobs.batch_ref, jobs.last_printed_by, jobs.carrier_rate_gpa, jobs.loader_tank_capacity, jobs.completed_at
  FROM public.jobs jobs
 WHERE (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)  -- roles that bypass the base table's row rules today (owner postgres inside definer functions, service_role) still read every row
    OR ((public.is_admin() OR public.is_sales_rep() OR public._is_job_applicator(id))) OR (public._is_dispatched_to_me(id));
ALTER VIEW public.jobs_crew OWNER TO postgres;
REVOKE ALL ON public.jobs_crew FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.jobs_crew TO authenticated, service_role;
COMMENT ON VIEW public.jobs_crew IS 'Crew read path (2026-11-25): jobs without total_price_cents, total_cost_cents, internal_memo, commission_split; rows = today''s jobs SELECT policy.';

CREATE VIEW public.job_chemicals_crew WITH (security_barrier = true) AS
SELECT job_chemicals.id, job_chemicals.job_id, job_chemicals.product_id, job_chemicals.quantity, job_chemicals.unit, job_chemicals.rate_per_acre, job_chemicals.rate_unit, job_chemicals.sort_order, job_chemicals.diluent_rate, job_chemicals.rei_hours, job_chemicals.phi_days, job_chemicals.warehouse, job_chemicals.vendor, job_chemicals.customer_supplied, job_chemicals.driver
  FROM public.job_chemicals job_chemicals
 WHERE (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)  -- roles that bypass the base table's row rules today (owner postgres inside definer functions, service_role) still read every row
    OR ((EXISTS ( SELECT 1
   FROM public.jobs_crew jobs
  WHERE ((jobs.id = job_chemicals.job_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (jobs.applicator_id = ( SELECT auth.uid() AS uid)))))))) OR (public._is_dispatched_to_me(job_id));
ALTER VIEW public.job_chemicals_crew OWNER TO postgres;
REVOKE ALL ON public.job_chemicals_crew FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.job_chemicals_crew TO authenticated, service_role;
COMMENT ON VIEW public.job_chemicals_crew IS 'Crew read path (2026-11-25): job_chemicals without price_per_unit_cents, cost_per_unit_cents; rows = today''s job_chemicals SELECT policy.';

CREATE VIEW public.job_field_shares_crew WITH (security_barrier = true) AS
SELECT job_field_shares.id, job_field_shares.job_id, job_field_shares.field_id, job_field_shares.customer_id, job_field_shares.is_primary, job_field_shares.created_at
  FROM public.job_field_shares job_field_shares
 WHERE (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)  -- roles that bypass the base table's row rules today (owner postgres inside definer functions, service_role) still read every row
    OR ((public.is_admin() OR public.is_sales_rep() OR public._is_job_applicator(job_id) OR (public.is_applicator() AND public._is_dispatched_to_me(job_id))));
ALTER VIEW public.job_field_shares_crew OWNER TO postgres;
REVOKE ALL ON public.job_field_shares_crew FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.job_field_shares_crew TO authenticated, service_role;
COMMENT ON VIEW public.job_field_shares_crew IS 'Crew read path (2026-11-25): job_field_shares without split_pct; rows = today''s job_field_shares SELECT policy.';

CREATE VIEW public.field_billing_defaults_crew WITH (security_barrier = true) AS
SELECT field_billing_defaults.id, field_billing_defaults.field_id, field_billing_defaults.customer_id, field_billing_defaults.is_primary, field_billing_defaults.notes, field_billing_defaults.created_at, field_billing_defaults.updated_at, field_billing_defaults.source_split_version_id
  FROM public.field_billing_defaults field_billing_defaults
 WHERE (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)  -- roles that bypass the base table's row rules today (owner postgres inside definer functions, service_role) still read every row
    OR ((public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND public._can_see_field(field_id))));
ALTER VIEW public.field_billing_defaults_crew OWNER TO postgres;
REVOKE ALL ON public.field_billing_defaults_crew FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.field_billing_defaults_crew TO authenticated, service_role;
COMMENT ON VIEW public.field_billing_defaults_crew IS 'Crew read path (2026-11-25): field_billing_defaults without split_pct, price_override_cents, pricing_note; rows = today''s field_billing_defaults SELECT policy.';

-- ---------- 2. Ripple: policies that read jobs inline now read jobs_crew (text swap only) ----------
DROP POLICY customers_select ON public.customers;
CREATE POLICY customers_select ON public.customers AS PERMISSIVE FOR SELECT TO public
  USING ((public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.customer_id = customers.id) AND (j.applicator_id = ( SELECT auth.uid() AS uid)) AND (j.job_date >= (CURRENT_DATE - '7 days'::interval))))))));

DROP POLICY customers_select_location_dispatchee ON public.customers;
CREATE POLICY customers_select_location_dispatchee ON public.customers AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.customer_id = customers.id) AND public._is_dispatched_to_me(j.id)))));

DROP POLICY job_applied_info_insert ON public.job_applied_info;
CREATE POLICY job_applied_info_insert ON public.job_applied_info AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_applied_info.job_id) AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_applied_info_update ON public.job_applied_info;
CREATE POLICY job_applied_info_update ON public.job_applied_info AS PERMISSIVE FOR UPDATE TO public
  USING ((public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_applied_info.job_id) AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))))
  WITH CHECK ((public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_applied_info.job_id) AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_applied_record_crew_delete ON public.job_applied_record_crew;
CREATE POLICY job_applied_record_crew_delete ON public.job_applied_record_crew AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM (public.job_applied_records r
     JOIN public.jobs_crew j ON ((j.id = r.job_id)))
  WHERE ((r.id = job_applied_record_crew.application_record_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_applied_record_crew_insert ON public.job_applied_record_crew;
CREATE POLICY job_applied_record_crew_insert ON public.job_applied_record_crew AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.job_applied_records r
     JOIN public.jobs_crew j ON ((j.id = r.job_id)))
  WHERE ((r.id = job_applied_record_crew.application_record_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_applied_record_crew_update ON public.job_applied_record_crew;
CREATE POLICY job_applied_record_crew_update ON public.job_applied_record_crew AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM (public.job_applied_records r
     JOIN public.jobs_crew j ON ((j.id = r.job_id)))
  WHERE ((r.id = job_applied_record_crew.application_record_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.job_applied_records r
     JOIN public.jobs_crew j ON ((j.id = r.job_id)))
  WHERE ((r.id = job_applied_record_crew.application_record_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_applied_record_fields_delete ON public.job_applied_record_fields;
CREATE POLICY job_applied_record_fields_delete ON public.job_applied_record_fields AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM (public.job_applied_records r
     JOIN public.jobs_crew j ON ((j.id = r.job_id)))
  WHERE ((r.id = job_applied_record_fields.application_record_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_applied_record_fields_insert ON public.job_applied_record_fields;
CREATE POLICY job_applied_record_fields_insert ON public.job_applied_record_fields AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((EXISTS ( SELECT 1
   FROM (public.job_applied_records r
     JOIN public.jobs_crew j ON ((j.id = r.job_id)))
  WHERE ((r.id = job_applied_record_fields.application_record_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))) AND (EXISTS ( SELECT 1
   FROM (public.job_fields jf
     JOIN public.job_applied_records r2 ON ((r2.job_id = jf.job_id)))
  WHERE ((r2.id = job_applied_record_fields.application_record_id) AND (jf.field_id = job_applied_record_fields.field_id))))));

DROP POLICY job_applied_record_fields_update ON public.job_applied_record_fields;
CREATE POLICY job_applied_record_fields_update ON public.job_applied_record_fields AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM (public.job_applied_records r
     JOIN public.jobs_crew j ON ((j.id = r.job_id)))
  WHERE ((r.id = job_applied_record_fields.application_record_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))) AND (EXISTS ( SELECT 1
   FROM (public.job_fields jf
     JOIN public.job_applied_records r2 ON ((r2.job_id = jf.job_id)))
  WHERE ((r2.id = job_applied_record_fields.application_record_id) AND (jf.field_id = job_applied_record_fields.field_id))))))
  WITH CHECK (((EXISTS ( SELECT 1
   FROM (public.job_applied_records r
     JOIN public.jobs_crew j ON ((j.id = r.job_id)))
  WHERE ((r.id = job_applied_record_fields.application_record_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))) AND (EXISTS ( SELECT 1
   FROM (public.job_fields jf
     JOIN public.job_applied_records r2 ON ((r2.job_id = jf.job_id)))
  WHERE ((r2.id = job_applied_record_fields.application_record_id) AND (jf.field_id = job_applied_record_fields.field_id))))));

DROP POLICY job_applied_records_delete ON public.job_applied_records;
CREATE POLICY job_applied_records_delete ON public.job_applied_records AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_applied_records.job_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_applied_records_insert ON public.job_applied_records;
CREATE POLICY job_applied_records_insert ON public.job_applied_records AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_applied_records.job_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_applied_records_update ON public.job_applied_records;
CREATE POLICY job_applied_records_update ON public.job_applied_records AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_applied_records.job_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_applied_records.job_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_attachments_delete ON public.job_attachments;
CREATE POLICY job_attachments_delete ON public.job_attachments AS PERMISSIVE FOR DELETE TO authenticated
  USING (((public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_attachments.job_id) AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))) AND (public.is_admin() OR public.is_sales_rep() OR (uploaded_by = ( SELECT auth.uid() AS uid)))));

DROP POLICY job_attachments_insert ON public.job_attachments;
CREATE POLICY job_attachments_insert ON public.job_attachments AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((uploaded_by = ( SELECT auth.uid() AS uid)) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_attachments.job_id) AND (j.applicator_id = ( SELECT auth.uid() AS uid)))))))));

DROP POLICY job_chemicals_select ON public.job_chemicals;
CREATE POLICY job_chemicals_select ON public.job_chemicals AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM public.jobs_crew jobs
  WHERE ((jobs.id = job_chemicals.job_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (jobs.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_fields_select ON public.job_fields;
CREATE POLICY job_fields_select ON public.job_fields AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM public.jobs_crew jobs
  WHERE ((jobs.id = job_fields.job_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (jobs.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_loader_worksheets_select ON public.job_loader_worksheets;
CREATE POLICY job_loader_worksheets_select ON public.job_loader_worksheets AS PERMISSIVE FOR SELECT TO authenticated
  USING ((public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_loader_worksheets.job_id) AND (j.applicator_id = ( SELECT auth.uid() AS uid)))))) OR public._is_dispatched_to_me(job_id)));

DROP POLICY job_location_dispatches_select ON public.job_location_dispatches;
CREATE POLICY job_location_dispatches_select ON public.job_location_dispatches AS PERMISSIVE FOR SELECT TO authenticated
  USING ((public.is_admin() OR public.is_sales_rep() OR (public._is_dispatched_to_me(job_id) AND (((dispatch_status = 'dispatched'::text) AND (applicator_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND p.is_active)))) OR ((dispatch_status = 'dispatched'::text) AND (crew_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND p.is_active))) AND (EXISTS ( SELECT 1
   FROM (public.ground_crew_members gcm
     JOIN public.ground_crews gc ON ((gc.id = gcm.crew_id)))
  WHERE ((gcm.crew_id = job_location_dispatches.crew_id) AND (gcm.profile_id = ( SELECT auth.uid() AS uid)) AND gcm.is_active AND gc.is_active)))))) OR (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE ((j.id = job_location_dispatches.job_id) AND public.is_applicator() AND (j.applicator_id = ( SELECT auth.uid() AS uid)))))));

DROP POLICY job_product_epa_select ON public.job_product_epa;
CREATE POLICY job_product_epa_select ON public.job_product_epa AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE (j.id = job_product_epa.job_id))));

DROP POLICY job_tag_assignments_select ON public.job_tag_assignments;
CREATE POLICY job_tag_assignments_select ON public.job_tag_assignments AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM public.jobs_crew jobs
  WHERE ((jobs.id = job_tag_assignments.job_id) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (jobs.applicator_id = ( SELECT auth.uid() AS uid))))))));

DROP POLICY job_attachments_objects_delete ON storage.objects;
CREATE POLICY job_attachments_objects_delete ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated
  USING (((bucket_id = 'job-attachments'::text) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE (((j.id)::text = (storage.foldername(objects.name))[1]) AND (j.applicator_id = ( SELECT auth.uid() AS uid))))))) AND (public.is_admin() OR public.is_sales_rep() OR (owner_id = (( SELECT auth.uid() AS uid))::text))));

DROP POLICY job_attachments_objects_insert ON storage.objects;
CREATE POLICY job_attachments_objects_insert ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((bucket_id = 'job-attachments'::text) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE (((j.id)::text = (storage.foldername(objects.name))[1]) AND (j.applicator_id = ( SELECT auth.uid() AS uid)))))))));

DROP POLICY job_attachments_objects_select ON storage.objects;
CREATE POLICY job_attachments_objects_select ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated
  USING (((bucket_id = 'job-attachments'::text) AND (public.is_admin() OR public.is_sales_rep() OR (public.is_applicator() AND (EXISTS ( SELECT 1
   FROM public.jobs_crew j
  WHERE (((j.id)::text = (storage.foldername(objects.name))[1]) AND (public._is_job_applicator(j.id) OR public._is_dispatched_to_me(j.id)))))))));

-- ripple policies rewritten: 24
-- ---------- 3. Invoker functions read the crew views (text swap only) ----------
CREATE OR REPLACE FUNCTION public._enforce_billed_job_applied_record_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent_record_id uuid;
  v_job_status text;
  v_job_number text;
  v_parent_xmin xid;
BEGIN
  -- Resolve the parent job's status + (for child tables) parent record's xmin.
  -- For the parent table (job_applied_records), OLD.job_id (UPDATE/DELETE) or
  -- NEW.job_id (INSERT — not gated here) points to the job. For child tables
  -- (_fields, _crew), walk via application_record_id → job_applied_records → jobs.
  IF TG_TABLE_NAME = 'job_applied_records' THEN
    SELECT status, job_number INTO v_job_status, v_job_number
      FROM public.jobs_crew WHERE id = OLD.job_id;
  ELSE
    -- For child tables we also need the parent's xmin (PARKED-005 r3) so the
    -- INSERT path can distinguish "child of a record being created in this
    -- transaction" from "child added to old billed history".
    v_parent_record_id := COALESCE(
      CASE TG_OP WHEN 'DELETE' THEN OLD.application_record_id
                 ELSE NEW.application_record_id END,
      OLD.application_record_id
    );
    SELECT j.status, j.job_number, r.xmin INTO v_job_status, v_job_number, v_parent_xmin
      FROM public.job_applied_records r
      JOIN public.jobs_crew j ON j.id = r.job_id
      WHERE r.id = v_parent_record_id;
  END IF;

  -- Parent missing (cascade race) — let the row through; the underlying FK / RLS will
  -- settle it. We're only the billed-status guard.
  IF v_job_status IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- Only billed/terminal jobs are immutable.
  IF v_job_status NOT IN ('invoiced', 'cancelled') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- PARKED-005 r3: child INSERT is allowed IFF the parent applied_record was
  -- created in THIS transaction (age(xmin)=0 — same Postgres xid). Distinguishes
  -- "the standard save_job_applied_record NEW-record path" (parent + children
  -- INSERTed in one txn, parent xmin matches current) from "raw-REST tampering
  -- adding fields to old billed history" (parent xmin is an older txn).
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN ('job_applied_record_fields', 'job_applied_record_crew') THEN
    IF age(v_parent_xmin) = 0 THEN
      RETURN NEW;  -- parent created in this txn — legitimate post-billing record
    END IF;
    -- fall through to admin / override check, then REJECT below
  END IF;

  -- Admins may correct billed history; the SECURITY DEFINER override hatch is honored
  -- so sanctioned server-side flows (e.g. a future transfer_invoice_to_job reversal
  -- that needs to clean up applied detail) still work.
  IF is_admin() OR _is_admin_override() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- PARKED-005 (Codex r1): EXEMPT the recompute-only UPDATE on job_applied_records.
  -- settle_applied_record_acres (AFTER INSERT trg_jarf_recompute) UPDATEs only
  -- applied_acres on this table to SUM(child.applied_acres); that path is the
  -- "record after billing" intent. To exempt the recompute WITHOUT opening a
  -- tampering window:
  --   (a) NEW.applied_acres must equal the current child-sum exactly (so a user
  --       arbitrary value like 9999 is still rejected — only the recompute's
  --       computed sum slips through), AND
  --   (b) every OTHER non-generated column is unchanged (mirrors the jobs
  --       immutability exempt list pattern: created_at/id/created_by frozen,
  --       updated_at handled by the set_updated_at BEFORE trigger which fires
  --       AFTER ours, so OLD.updated_at = NEW.updated_at at this point).
  -- Children (_fields, _crew) have no analogous rollup → this exempt is parent-only.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'job_applied_records' THEN
    DECLARE v_child_sum numeric;
    BEGIN
      SELECT COALESCE(SUM(applied_acres), 0) INTO v_child_sum
        FROM public.job_applied_record_fields
        WHERE application_record_id = NEW.id;

      IF NEW.applied_acres IS DISTINCT FROM OLD.applied_acres
         AND NEW.applied_acres IS NOT DISTINCT FROM v_child_sum
         AND NEW.job_id              IS NOT DISTINCT FROM OLD.job_id
         AND NEW.applicator_id       IS NOT DISTINCT FROM OLD.applicator_id
         AND NEW.vehicle_id          IS NOT DISTINCT FROM OLD.vehicle_id
         AND NEW.application_date    IS NOT DISTINCT FROM OLD.application_date
         AND NEW.notes               IS NOT DISTINCT FROM OLD.notes
         AND NEW.start_weather_time  IS NOT DISTINCT FROM OLD.start_weather_time
         AND NEW.start_temp_f        IS NOT DISTINCT FROM OLD.start_temp_f
         AND NEW.start_wind_direction IS NOT DISTINCT FROM OLD.start_wind_direction
         AND NEW.start_wind_mph      IS NOT DISTINCT FROM OLD.start_wind_mph
         AND NEW.start_humidity_pct  IS NOT DISTINCT FROM OLD.start_humidity_pct
         AND NEW.start_weather_source IS NOT DISTINCT FROM OLD.start_weather_source
         AND NEW.end_weather_time    IS NOT DISTINCT FROM OLD.end_weather_time
         AND NEW.end_temp_f          IS NOT DISTINCT FROM OLD.end_temp_f
         AND NEW.end_wind_direction  IS NOT DISTINCT FROM OLD.end_wind_direction
         AND NEW.end_wind_mph        IS NOT DISTINCT FROM OLD.end_wind_mph
         AND NEW.end_humidity_pct    IS NOT DISTINCT FROM OLD.end_humidity_pct
         AND NEW.end_weather_source  IS NOT DISTINCT FROM OLD.end_weather_source
         AND NEW.beginning_tach      IS NOT DISTINCT FROM OLD.beginning_tach
         AND NEW.end_tach            IS NOT DISTINCT FROM OLD.end_tach
         AND NEW.created_by          IS NOT DISTINCT FROM OLD.created_by
         AND NEW.id                  IS NOT DISTINCT FROM OLD.id
         AND NEW.created_at          IS NOT DISTINCT FROM OLD.created_at
      THEN
        RETURN NEW;  -- recompute-only update matching child-sum — preserve "record after billing"
      END IF;
    END;
  END IF;

  -- Non-admin, billed job, no override → REJECT.
  RAISE EXCEPTION
    'A % job''s applied-record (or its child rows) is billed history and cannot be % by a non-admin (job %).',
    v_job_status, lower(TG_OP), v_job_number
    USING ERRCODE = 'check_violation';
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_notes_for_entity(p_entity_type text, p_entity_id uuid)
 RETURNS SETOF public.team_notes
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_can_read_record boolean;
BEGIN
  -- Runs as the caller (SECURITY INVOKER), so the row security of team_notes and of the linked
  -- record's own table both apply: notes come back only for a record the caller can already read
  -- (office staff any; an applicator a job they may see; a driver a delivery assigned to them),
  -- and never to an inactive account (row 11.4). An unknown type is office-only.
  v_can_read_record := CASE p_entity_type
    WHEN 'customer'       THEN EXISTS (SELECT 1 FROM public.customers       x WHERE x.id = p_entity_id)
    WHEN 'order'          THEN EXISTS (SELECT 1 FROM public.orders          x WHERE x.id = p_entity_id)
    WHEN 'delivery'       THEN EXISTS (SELECT 1 FROM public.deliveries      x WHERE x.id = p_entity_id)
    WHEN 'job'            THEN EXISTS (SELECT 1 FROM public.jobs_crew       x WHERE x.id = p_entity_id)
    WHEN 'purchase_order' THEN EXISTS (SELECT 1 FROM public.purchase_orders x WHERE x.id = p_entity_id)
    WHEN 'quote'          THEN EXISTS (SELECT 1 FROM public.quotes          x WHERE x.id = p_entity_id)
    WHEN 'invoice'        THEN EXISTS (SELECT 1 FROM public.invoices        x WHERE x.id = p_entity_id)
    WHEN 'product'        THEN EXISTS (SELECT 1 FROM public.products        x WHERE x.id = p_entity_id)
    ELSE (public.is_admin() OR public.is_sales_rep())
  END;
  IF v_can_read_record IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT tn.*
    FROM team_notes tn
    WHERE tn.linked_entity_type = p_entity_type
      AND tn.linked_entity_id = p_entity_id
      AND tn.deleted_at IS NULL
    ORDER BY tn.is_pinned DESC, tn.created_at DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.worksheet_weight_is_valid(r public.job_loader_worksheet_weights)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.job_loader_worksheets w WHERE w.id = r.worksheet_id AND w.job_id = r.job_id)
     AND EXISTS (SELECT 1 FROM public.job_chemicals_crew c WHERE c.job_id = r.job_id AND c.product_id = r.product_id)
     AND CASE r.weight_kind
           WHEN 'net_weight' THEN r.pack_generation = COALESCE(
             (SELECT s.pack_generation FROM public.product_size_net_weight_state s WHERE s.product_id = r.product_id), 0)
           WHEN 'density' THEN r.member_generation = COALESCE(
               (SELECT s.member_generation FROM public.product_size_net_weight_state s WHERE s.product_id = r.product_id), 0)
             AND r.identity_generation = COALESCE(
               (SELECT ds.identity_generation FROM public.product_parent_density_values d
                  JOIN public.product_parent_density_state ds ON ds.parent_id = d.parent_id
                 WHERE d.id = r.value_id), -1)
           ELSE true
         END;
$function$;

CREATE OR REPLACE FUNCTION public.get_loader_worksheet_weights(p_worksheet_ids uuid[] DEFAULT NULL::uuid[], p_job_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_jobs uuid[];
  v_pids uuid[];
  v_units jsonb;
  v_current jsonb := '{}'::jsonb;
  v_r jsonb;
  v_i int := 1;
BEGIN
  IF (p_worksheet_ids IS NULL) = (p_job_ids IS NULL) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: send worksheet IDs or job IDs, exactly one';
  END IF;
  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_worksheet_ids, p_job_ids)) x WHERE x IS NOT NULL);
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_TOO_MANY: at most 200 worksheets or jobs at once';
  END IF;
  IF p_worksheet_ids IS NOT NULL THEN
    v_jobs := ARRAY(SELECT DISTINCT w.job_id FROM public.job_loader_worksheets w WHERE w.id = ANY (v_ids));
  ELSE
    v_jobs := v_ids;
  END IF;
  v_pids := ARRAY(SELECT DISTINCT c.product_id FROM public.job_chemicals_crew c
                   WHERE c.job_id = ANY (v_jobs) AND c.product_id IS NOT NULL ORDER BY 1);
  LOOP
    v_r := public.get_product_weights(COALESCE(v_pids[v_i:v_i + 499], '{}'::uuid[]));
    v_units := COALESCE(v_units, v_r->'units');
    v_current := v_current || COALESCE(v_r->'products', '{}'::jsonb);
    v_i := v_i + 500;
    EXIT WHEN v_i > COALESCE(cardinality(v_pids), 0);
  END LOOP;

  RETURN jsonb_build_object(
    'read_at', statement_timestamp(),
    'unit_factors', v_units,
    'worksheets', CASE WHEN p_worksheet_ids IS NULL THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'worksheet_id', w.id, 'job_id', w.job_id, 'worksheet', to_jsonb(w),
          'vehicle_name', CASE WHEN w.vehicle_id IS NULL THEN 'Manual'
                               ELSE COALESCE((SELECT v.vehicle_name FROM public.vehicles v WHERE v.id = w.vehicle_id), 'Manual') END,
          'acres', (SELECT COALESCE(sum(f.acres_to_treat), 0) FROM public.job_fields f WHERE f.job_id = w.job_id),
          'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'product_id', c.product_id,
                        'quantity', c.quantity, 'unit', c.unit,
                        'product_name', COALESCE(NULLIF(p.product_name, ''), 'Product'), 'product_form', p.product_form)
                      ORDER BY c.sort_order NULLS LAST, c.id), '[]'::jsonb)
                      FROM public.job_chemicals_crew c LEFT JOIN public.products p ON p.id = c.product_id
                     WHERE c.job_id = w.job_id),
          'weights', (SELECT COALESCE(jsonb_object_agg(pc.product_id::text, jsonb_build_object(
                          'saved', (SELECT to_jsonb(s) FROM public.job_loader_worksheet_weights s
                                     WHERE s.worksheet_id = w.id AND s.product_id = pc.product_id
                                       AND public.worksheet_weight_is_valid(s)),
                          'current', v_current->(pc.product_id::text)->'weight')), '{}'::jsonb)
                        FROM (SELECT DISTINCT c.product_id FROM public.job_chemicals_crew c
                               WHERE c.job_id = w.job_id AND c.product_id IS NOT NULL) pc))
          ORDER BY w.id)
        FROM public.job_loader_worksheets w WHERE w.id = ANY (v_ids)), '[]'::jsonb) END,
    'jobs', CASE WHEN p_job_ids IS NULL THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(CASE WHEN j.id IS NULL THEN jsonb_build_object('job_id', i.id, 'found', false)
        ELSE jsonb_build_object(
          'job_id', j.id, 'found', true,
          'job', jsonb_build_object('job_number', j.job_number, 'job_date', j.job_date, 'scheduled_time', j.scheduled_time,
            'applicator_id', j.applicator_id, 'carrier_rate_gpa', j.carrier_rate_gpa,
            'loader_tank_capacity', j.loader_tank_capacity, 'loader_comment', j.loader_comment,
            'vehicle', (SELECT jsonb_build_object('vehicle_name', v.vehicle_name, 'capacity_gallons', v.capacity_gallons,
                          'capacity_unit', v.capacity_unit) FROM public.vehicles v WHERE v.id = j.vehicle_id)),
          'acres', (SELECT COALESCE(sum(f.acres_to_treat), 0) FROM public.job_fields f WHERE f.job_id = j.id),
          'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'product_id', c.product_id,
                        'quantity', c.quantity, 'unit', c.unit,
                        'product_name', COALESCE(NULLIF(p.product_name, ''), 'Product'), 'product_form', p.product_form)
                      ORDER BY c.sort_order NULLS LAST, c.id), '[]'::jsonb)
                      FROM public.job_chemicals_crew c LEFT JOIN public.products p ON p.id = c.product_id
                     WHERE c.job_id = j.id),
          'current', (SELECT COALESCE(jsonb_object_agg(pc.product_id::text, v_current->(pc.product_id::text)->'weight'), '{}'::jsonb)
                        FROM (SELECT DISTINCT c.product_id FROM public.job_chemicals_crew c
                               WHERE c.job_id = j.id AND c.product_id IS NOT NULL) pc),
          'worksheet', (SELECT jsonb_build_object(
              'id', w.id, 'worksheet', to_jsonb(w),
              'vehicle_name', CASE WHEN w.vehicle_id IS NULL THEN 'Manual'
                                   ELSE COALESCE((SELECT v.vehicle_name FROM public.vehicles v WHERE v.id = w.vehicle_id), 'Manual') END,
              'saved', (SELECT COALESCE(jsonb_object_agg(s.product_id::text, to_jsonb(s)), '{}'::jsonb)
                          FROM public.job_loader_worksheet_weights s
                         WHERE s.worksheet_id = w.id AND public.worksheet_weight_is_valid(s)))
            FROM public.job_loader_worksheets w WHERE w.job_id = j.id AND w.is_selected))
        END ORDER BY i.ord)
        FROM unnest(v_ids) WITH ORDINALITY i(id, ord)
        LEFT JOIN public.jobs_crew j ON j.id = i.id), '[]'::jsonb) END);
END;
$function$;

-- ---------- 4. Dispatch board: non-office callers get the jobs_crew projection ----------
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
    (CASE WHEN is_admin() OR is_sales_rep()
       THEN to_jsonb(m) - 'total_cost_cents'
       -- Crew: a fixed column list (jobs_crew), so price, memo, commission split and any future private column never ship.
       ELSE (SELECT to_jsonb(c) FROM public.jobs_crew c WHERE c.id = m.id) || jsonb_build_object('_total_count', m._total_count)
     END)
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

DO $postflight$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['jobs_crew','job_chemicals_crew','job_field_shares_crew','field_billing_defaults_crew'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = v
        AND column_name IN ('total_price_cents','total_cost_cents','internal_memo','commission_split','price_per_unit_cents',
                            'cost_per_unit_cents','split_pct','price_override_cents','pricing_note')) THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % exposes a protected column', v;
    END IF;
    IF has_table_privilege('anon', 'public.'||v, 'SELECT')
       OR has_table_privilege('authenticated', 'public.'||v, 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('service_role', 'public.'||v, 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR NOT has_table_privilege('authenticated', 'public.'||v, 'SELECT') THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % has the wrong grants', v;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE (coalesce(qual,'')||coalesce(with_check,'')) ~ '(FROM|JOIN) (public\.)?jobs\M') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a policy still reads jobs inline';
  END IF;
  IF position('public.jobs_crew c WHERE c.id = m.id' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_dispatch_board_jobs(uuid,text,date,date)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: dispatch board does not use jobs_crew for crew callers';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: crew views installed; 24 policies and 5 functions read them';
END
$postflight$;
