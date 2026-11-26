-- Taha's LOW 1 on #2672: the Board told an applicator "Job ... is no longer assigned to you" when it moved or
-- removed ONE location while they still held another dispatched location on the same job. The removal notice now
-- goes only when the outgoing applicator holds no dispatched location left on that job. Nothing else changes:
-- same arguments, grants, search_path, replay fingerprints and receipts. Rollback: re-run the function body from
-- 20270310180000_dispatch_location_notices.sql in a reviewed migration.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('public.dispatch_location_with_notices(text,jsonb,uuid[],boolean,text)')
      AND md5(replace(prosrc, chr(13), '')) = 'df6a58e596e7d21556b6f671aac4abf1'
  ) THEN RAISE EXCEPTION 'DISPATCH_LOCATION_NOTICES_CHANGED'; END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.dispatch_location_with_notices(
  p_mode text,
  p_assignments jsonb DEFAULT NULL,
  p_job_field_ids uuid[] DEFAULT NULL,
  p_license_override boolean DEFAULT false,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_operation text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  v_fields uuid[];
  v_jobs uuid[];
  v_recipients uuid[];
  v_crews uuid[];
  v_active_count integer;
  v_before jsonb;
  v_notice record;
BEGIN
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_license_override IS NULL THEN
    RAISE EXCEPTION 'INVALID_LICENSE_OVERRIDE' USING ERRCODE = '22023';
  END IF;
  IF p_license_override AND NOT public.is_admin() THEN RAISE EXCEPTION 'OVERRIDE_REQUIRES_ADMIN'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('wizard', 'reassign', 'remove') THEN
    RAISE EXCEPTION 'INVALID_DISPATCH_MODE' USING ERRCODE = '22023';
  END IF;

  IF p_mode = 'remove' THEN
    IF p_assignments IS NOT NULL OR cardinality(p_job_field_ids) IS DISTINCT FROM 1
      OR p_job_field_ids[1] IS NULL OR p_license_override THEN
      RAISE EXCEPTION 'INVALID_DISPATCH_REMOVAL' USING ERRCODE = '22023';
    END IF;
    v_operation := 'undispatch_job_locations';
    v_fingerprint := public._replay_fingerprint_20261015(
      jsonb_build_object('actor_id', v_actor, 'p_job_field_ids', p_job_field_ids));
  ELSE
    IF jsonb_typeof(p_assignments) IS DISTINCT FROM 'array' OR p_job_field_ids IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_ASSIGNMENTS' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_assignments) = 0 OR (p_mode = 'reassign' AND jsonb_array_length(p_assignments) <> 1) THEN
      RAISE EXCEPTION 'INVALID_ASSIGNMENT_COUNT' USING ERRCODE = '22023';
    END IF;
    v_operation := 'dispatch_job_locations';
    v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
      'actor_id', v_actor, 'p_assignments', p_assignments, 'p_license_override', p_license_override));
  END IF;

  -- A key identifies the assignment change across both screens and the old API.
  -- The first committed call determines the notices; changing modes on retry must not send new ones.
  v_replay := public.check_idempotency_intent(p_idempotency_key, v_operation, v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN RETURN v_replay -> 'result'; END IF;

  IF p_mode = 'remove' THEN
    v_fields := p_job_field_ids;
  ELSE
    SELECT array_agg(NULLIF(a->>'job_field_id', '')::uuid),
      array_agg(DISTINCT NULLIF(a->>'applicator_id', '')::uuid)
        FILTER (WHERE NULLIF(a->>'applicator_id', '') IS NOT NULL),
      array_agg(DISTINCT NULLIF(a->>'crew_id', '')::uuid)
        FILTER (WHERE NULLIF(a->>'crew_id', '') IS NOT NULL)
    INTO v_fields, v_recipients, v_crews FROM jsonb_array_elements(p_assignments) AS a;
  END IF;
  SELECT array_agg(DISTINCT jf.job_id) INTO v_jobs
  FROM public.job_fields jf WHERE jf.id = ANY(v_fields);
  PERFORM id FROM public.jobs WHERE id = ANY(v_jobs) ORDER BY id FOR UPDATE;
  PERFORM id FROM public.job_fields WHERE id = ANY(v_fields) ORDER BY id FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM public.job_fields WHERE id = ANY(v_fields)
      AND NOT COALESCE(job_id = ANY(v_jobs), false)
  ) THEN RAISE EXCEPTION 'DISPATCH_LOCATION_MOVED' USING ERRCODE = '40001'; END IF;
  PERFORM id FROM public.profiles
  WHERE id = ANY(v_recipients) AND role = 'applicator' AND is_active
  ORDER BY id FOR SHARE;
  GET DIAGNOSTICS v_active_count = ROW_COUNT;
  IF v_active_count <> COALESCE(cardinality(v_recipients), 0) THEN
    RAISE EXCEPTION 'INVALID_APPLICATOR: selected applicator is no longer active';
  END IF;
  PERFORM id FROM public.ground_crews WHERE id = ANY(v_crews) AND is_active ORDER BY id FOR SHARE;
  GET DIAGNOSTICS v_active_count = ROW_COUNT;
  IF v_active_count <> COALESCE(cardinality(v_crews), 0) THEN
    RAISE EXCEPTION 'INVALID_CREW: selected crew is no longer active';
  END IF;

  -- Prevent recipient deletion before locking the assignment rows it can cascade through.
  PERFORM p.id FROM public.profiles p
  WHERE p.id IN (
    SELECT d.applicator_id FROM public.job_location_dispatches d
    WHERE d.job_field_id = ANY(v_fields) AND d.dispatch_status = 'dispatched'
  ) ORDER BY p.id FOR KEY SHARE;
  PERFORM job_field_id FROM public.job_location_dispatches
  WHERE job_field_id = ANY(v_fields) ORDER BY job_field_id FOR UPDATE;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('field_id', job_field_id, 'recipient', applicator_id)), '[]'::jsonb)
    INTO v_before
  FROM public.job_location_dispatches
  WHERE job_field_id = ANY(v_fields) AND dispatch_status = 'dispatched' AND applicator_id IS NOT NULL;

  -- The existing operations validate the write, keep the activity history and bind the receipt.
  IF p_mode = 'remove' THEN
    v_result := public.undispatch_job_locations(p_job_field_ids, NULL, p_idempotency_key);
  ELSE
    v_result := public.dispatch_job_locations(p_assignments, NULL, p_idempotency_key, p_license_override);
  END IF;

  FOR v_notice IN
    WITH previous AS (
      SELECT * FROM jsonb_to_recordset(v_before) AS r(field_id uuid, recipient uuid)
    )
    SELECT DISTINCT d.job_id, d.applicator_id AS recipient, false AS removed
    FROM public.job_location_dispatches d
    LEFT JOIN previous p ON p.field_id = d.job_field_id
    WHERE p_mode <> 'remove' AND d.job_field_id = ANY(v_fields)
      AND d.dispatch_status = 'dispatched' AND d.applicator_id IS NOT NULL
      AND (p_mode = 'wizard' OR d.applicator_id IS DISTINCT FROM p.recipient)
    UNION
    SELECT d.job_id, p.recipient, true
    FROM previous p JOIN public.job_location_dispatches d ON d.job_field_id = p.field_id
    WHERE ((p_mode = 'remove' AND d.dispatch_status = 'cancelled')
       OR (p_mode = 'reassign' AND d.dispatch_status = 'dispatched' AND d.applicator_id IS DISTINCT FROM p.recipient))
      -- No removal notice while the applicator still holds another location on this job (Taha's LOW 1 on #2672).
      AND NOT EXISTS (
        SELECT 1 FROM public.job_location_dispatches d2
        WHERE d2.job_id = d.job_id AND d2.applicator_id = p.recipient AND d2.dispatch_status = 'dispatched'
      )
  LOOP
    PERFORM public._send_dispatch_location_notice(v_notice.job_id, v_notice.recipient, v_actor, v_notice.removed);
  END LOOP;
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.dispatch_location_with_notices(text,jsonb,uuid[],boolean,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dispatch_location_with_notices(text,jsonb,uuid[],boolean,text)
  TO authenticated;

DO $postflight$
BEGIN
  IF has_function_privilege('anon', 'public.dispatch_location_with_notices(text,jsonb,uuid[],boolean,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.dispatch_location_with_notices(text,jsonb,uuid[],boolean,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.dispatch_location_with_notices(text,jsonb,uuid[],boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._send_dispatch_location_notice(uuid,uuid,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._send_dispatch_location_notice(uuid,uuid,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._send_dispatch_location_notice(uuid,uuid,uuid,boolean)', 'EXECUTE')
  THEN RAISE EXCEPTION 'DISPATCH_LOCATION_NOTICES_GRANT_MISMATCH'; END IF;
END
$postflight$;
