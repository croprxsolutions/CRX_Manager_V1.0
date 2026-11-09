-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261220100000_applicator_keeps_own_record_fields.md.
--
-- WHY (Taha's review of #1650, MED): 20261217100000_job_access_ends_with_the_job ended a whole-job
--   applicator's field access 7 days after the job ends, through _can_see_field. fields_select and
--   arf_select use _can_see_field, so an applicator's own spray record (application_records, which they
--   still read: app_records_select) lost its field name and its application_record_fields rows once the
--   job was done, cancelled or deleted. Record Book (src/pages/ApplicationRecords.tsx) then showed "-"
--   for Field. That narrowing was never intended: the applicator keeps their own spray records.
--
-- HOW:
--   * NEW public._is_my_application_field(field id): the caller is an active applicator and is the
--     applicator on a spray record (application_records.applicator_id) for that field, either the
--     record's own field_id or one of its application_record_fields rows. No time limit.
--   * fields_select: the applicator leg becomes _can_see_field(id) OR _is_my_application_field(id).
--   * arf_select: the applicator leg becomes _can_see_field(field_id) OR the row belongs to a spray
--     record whose applicator is the caller.
--
-- NOT CHANGED: _can_see_field and every other policy that uses it (field_crop_history, field_obstacles,
--   field_billing_defaults keep the 7-day window); what an admin
--   or sales rep reads; every write; job access (#1650's whole-job window, which already runs from the
--   server's completion stamp, jobs.completed_at, with or without a dispatch row: Taha's LOW is proven by
--   the prover, not changed). No row changes.
--
-- WIDENING (by design): an active applicator reads, forever, the field row (name and boundary) and the
--   application_record_fields rows of spray records that name them as the applicator. field_polygons_select is
--   `field_id IN (SELECT id FROM fields)` under the caller's row security, so the field's boundary parts
--   follow (reads only; their writes are office-only). The rule is "the fields listed on spray records that
--   name you as the applicator", not "the fields you sprayed with your own hands": complete_job writes ONE
--   record per job, naming whoever completed it, with a row for EVERY field on the job. So on a split job
--   the completer also keeps the field another applicator was dispatched to. That record is the legal
--   spray record under their name and Record Book shows all of its fields.
--   Until 20261217100000 the whole-job applicator read
--   every field of every job they held, forever; this keeps only the fields on records naming them.
--   Records are written only by definer functions, so an applicator cannot add a field to one. A
--   deactivated applicator, a driver, or a crew member not named on the record gains nothing.
--
-- ROLLBACK: ALTER POLICY fields_select ON public.fields USING (is_admin() OR is_sales_rep() OR
--   (is_applicator() AND _can_see_field(id))); ALTER POLICY arf_select ON public.application_record_fields
--   USING (is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)));
--   DROP FUNCTION public._is_my_application_field(uuid).

SET LOCAL lock_timeout = '5s';
-- Policy expressions are printed relative to the search_path; fix it so the pinned texts compare.
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE own_record_fields_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_pol record;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.own_record_fields_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.own_record_fields_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regprocedure('public._is_my_application_field(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'OWN_RECORD_FIELDS_BASELINE_DRIFT: public._is_my_application_field(uuid) already exists (already applied?)';
  END IF;
  IF to_regprocedure('public._is_job_applicator(uuid)') IS NULL THEN
    RAISE EXCEPTION 'OWN_RECORD_FIELDS_BASELINE_DRIFT: 20261217100000_job_access_ends_with_the_job is not applied';
  END IF;
  -- The two policies exactly as live has them (2026-11-08), plus app_records_select, which arf_select's
  -- new leg runs under (it must not read application_record_fields, or the two policies would recurse).
  FOR v_pol IN
    SELECT * FROM (VALUES
      ('application_records', 'app_records_select', '{public}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND (applicator_id = ( SELECT auth.uid() AS uid))))'),
      ('fields', 'fields_select', '{authenticated}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(id)))'),
      ('application_record_fields', 'arf_select', '{public}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)))')
    ) AS t(tbl, pol, roles, qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pp
       WHERE pp.schemaname = 'public' AND pp.tablename = v_pol.tbl AND pp.policyname = v_pol.pol
         AND pp.cmd = 'SELECT' AND pp.permissive = 'PERMISSIVE' AND pp.roles::text = v_pol.roles
         AND pp.qual = v_pol.qual AND pp.with_check IS NULL) THEN
      RAISE EXCEPTION 'OWN_RECORD_FIELDS_BASELINE_DRIFT: policy % on public.% is not the pinned one', v_pol.pol, v_pol.tbl;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE FUNCTION public._is_my_application_field(p_field_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  -- Taha's review of #1650: an applicator always sees the fields listed on a spray record naming them as
  -- the applicator (Record Book), after the job's 7-day window ends. is_applicator() requires an ACTIVE applicator.
  -- Answers only for the caller.
  -- Driven from the field (idx_app_records_field, idx_arf_field): runs once per fields row scanned.
  SELECT public.is_applicator() AND (
    EXISTS (SELECT 1 FROM public.application_records ar
             WHERE ar.field_id = p_field_id AND ar.applicator_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM public.application_record_fields arf
                 JOIN public.application_records ar ON ar.id = arf.application_record_id
                WHERE arf.field_id = p_field_id AND ar.applicator_id = (SELECT auth.uid()))
  );
$function$;

REVOKE ALL ON FUNCTION public._is_my_application_field(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_my_application_field(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public._is_my_application_field(uuid) IS
  'The caller is an active applicator named as applicator (application_records.applicator_id) on a spray record listing this field, as its field_id or one of its application_record_fields rows. No time limit (Record Book).';

ALTER POLICY fields_select ON public.fields
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND (public._can_see_field(id) OR public._is_my_application_field(id))));

ALTER POLICY arf_select ON public.application_record_fields
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND (public._can_see_field(field_id)
    OR EXISTS (SELECT 1 FROM public.application_records ar
                WHERE ar.id = application_record_fields.application_record_id
                  AND ar.applicator_id = (SELECT auth.uid())))));

DO $postflight$
DECLARE
  v_pol record;
BEGIN
  IF to_regclass('pg_temp.own_record_fields_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.own_record_fields_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  -- The new helper: definer, stable, fixed search_path, executable by signed-in users only.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._is_my_application_field(uuid)')
       AND p.prosecdef AND p.provolatile = 's' AND p.prorettype = 'boolean'::regtype
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=public, pg_temp'])
     OR has_function_privilege('anon', 'public._is_my_application_field(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public._is_my_application_field(uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = to_regprocedure('public._is_my_application_field(uuid)') AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public._is_my_application_field(uuid) is not the expected function or grants';
  END IF;

  FOR v_pol IN
    SELECT * FROM (VALUES
      ('fields', 'fields_select', '{authenticated}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND (_can_see_field(id) OR _is_my_application_field(id))))'),
      ('application_record_fields', 'arf_select', '{public}', E'(is_admin() OR is_sales_rep() OR (is_applicator() AND (_can_see_field(field_id) OR (EXISTS ( SELECT 1\n   FROM application_records ar\n  WHERE ((ar.id = application_record_fields.application_record_id) AND (ar.applicator_id = ( SELECT auth.uid() AS uid))))))))')
    ) AS t(tbl, pol, roles, qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pp
       WHERE pp.schemaname = 'public' AND pp.tablename = v_pol.tbl AND pp.policyname = v_pol.pol
         AND pp.cmd = 'SELECT' AND pp.permissive = 'PERMISSIVE' AND pp.roles::text = v_pol.roles
         AND pp.qual = v_pol.qual AND pp.with_check IS NULL) THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: policy % on public.% is not the expected one: %', v_pol.pol, v_pol.tbl,
        (SELECT pp.qual FROM pg_policies pp WHERE pp.schemaname = 'public' AND pp.tablename = v_pol.tbl AND pp.policyname = v_pol.pol);
    END IF;
  END LOOP;
  RAISE NOTICE 'POSTFLIGHT_OK: an applicator keeps the fields of their own spray records';
END;
$postflight$;
