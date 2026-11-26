-- Add an office dispatch operation that sends notices from saved assignments.
-- Older app builds keep using the existing dispatch operations during rollout.
-- Roll back the app first, then retire this operation and its private writer.
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE dispatch_location_notices_tx ON COMMIT DROP AS
  SELECT pg_current_xact_id() AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.dispatch_location_notices_tx') IS NULL
    OR (SELECT transaction_id FROM pg_temp.dispatch_location_notices_tx) IS DISTINCT FROM pg_current_xact_id()
  THEN RAISE EXCEPTION 'DISPATCH_LOCATION_NOTICES_REQUIRES_TRANSACTION'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('public.dispatch_job_locations(jsonb,uuid,text,boolean)')
      AND md5(replace(prosrc, chr(13), '')) = 'a3363e6c7ceb97c0613b88c18a455db6'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('public.undispatch_job_locations(uuid[],uuid,text)')
      AND md5(replace(prosrc, chr(13), '')) = '6c1414458f0c935458d0391816b4631f'
  ) THEN RAISE EXCEPTION 'DISPATCH_LOCATION_RECEIPT_WRAPPERS_CHANGED'; END IF;
END
$preflight$;

CREATE FUNCTION public._send_dispatch_location_notice(
  p_job_id uuid, p_recipient uuid, p_actor uuid, p_removed boolean
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $notice$
DECLARE
  v_type text := CASE WHEN p_removed THEN 'job_undispatched' ELSE 'job_dispatched' END;
BEGIN
  INSERT INTO public.notifications
    (user_id, title, message, notification_type, related_entity_type, related_entity_id, created_by)
  SELECT p_recipient,
    CASE WHEN p_removed THEN 'Job Removed From Your Schedule' ELSE 'New Job Assigned' END,
    CASE WHEN p_removed THEN format('Job %s for %s is no longer assigned to you',
      j.job_number, COALESCE(NULLIF(c.farm_name, ''), 'Unknown'))
    ELSE format('You''ve been assigned job %s for %s on an upcoming date',
      j.job_number, COALESCE(NULLIF(c.farm_name, ''), 'Unknown')) END,
    v_type, 'job', j.id, p_actor
  FROM public.jobs AS j
  LEFT JOIN public.customers AS c ON c.id = j.customer_id
  WHERE j.id = p_job_id;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    INSERT INTO public.failed_notifications (notification_type, entity_type, entity_id, error_message, payload)
    VALUES (v_type, 'job', p_job_id, 'Dispatch notice failed (SQLSTATE ' || SQLSTATE || ')',
      jsonb_build_object('applicatorId', p_recipient));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Could not record a dispatch notice failure (SQLSTATE %)', SQLSTATE;
  END;
END
$notice$;

REVOKE ALL ON FUNCTION public._send_dispatch_location_notice(uuid,uuid,uuid,boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.dispatch_location_with_notices(
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

  -- Use the old operations' receipt scope, including their exact fingerprint.
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
    WHERE (p_mode = 'remove' AND d.dispatch_status = 'cancelled')
       OR (p_mode = 'reassign' AND d.dispatch_status = 'dispatched' AND d.applicator_id IS DISTINCT FROM p.recipient)
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
