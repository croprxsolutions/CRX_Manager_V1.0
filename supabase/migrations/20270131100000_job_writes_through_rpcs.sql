-- #1979 PR A: spray job planning edits, cancel and soft delete go through one server function.
-- Contract: docs/plans/2026-11-19-job-writes-through-rpcs-CONTRACT.md
--
-- Additive only: the deployed app still writes jobs directly until the screen PR lands; a later
-- migration removes those direct grants. Every existing jobs trigger (status transition, billed-job
-- lock, applicator license, booking live-job guard, hold release, dispatch close) still runs.
--
-- Rollback: DROP FUNCTION public.edit_jobs(uuid[], jsonb, text, uuid, text);

CREATE FUNCTION public.edit_jobs(
  p_job_ids uuid[],
  p_changes jsonb DEFAULT NULL::jsonb,
  p_action text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_ids         uuid[];
  -- Editable planning fields and the JSON type each value must have (null clears, except job_date).
  v_types       jsonb := jsonb_build_object(
                  'job_date', 'date', 'schedule_date', 'date',
                  'applicator_id', 'uuid', 'batch_ref', 'uuid', 'ground_crew_id', 'uuid',
                  'carrier_rate_gpa', 'numeric', 'loader_tank_capacity', 'numeric',
                  'loader_comment', 'text');
  v_key         text;
  v_val         jsonb;
  v_kind        text;
  v_id          uuid;
  v_status      text;
  v_deleted_at  timestamptz;
  v_rows        int;
  v_set         text := '';
  v_fingerprint text;
  v_replay      jsonb;
  v_updated     uuid[] := '{}';
  v_cancelled   uuid[] := '{}';
  v_deleted     uuid[] := '{}';
  v_skipped     jsonb := '[]'::jsonb;
  v_result      jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: edit_jobs requires an active admin or sales rep';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: edit_jobs requires p_idempotency_key';
  END IF;

  -- Ids: drop nulls, de-duplicate, bound.
  IF array_ndims(p_job_ids) > 1 THEN RAISE EXCEPTION 'BAD_JOB_LIST: send a flat list of job ids'; END IF;
  IF cardinality(p_job_ids) > 1000 THEN RAISE EXCEPTION 'TOO_MANY_ENTRIES: at most 1000 entries in the job list'; END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_job_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL THEN RAISE EXCEPTION 'NO_JOBS: choose at least one job'; END IF;
  IF cardinality(v_ids) > 500 THEN RAISE EXCEPTION 'TOO_MANY_JOBS: at most 500 jobs at a time'; END IF;

  -- Shape: changes only, cancel only, changes + cancel, or delete only.
  IF p_action IS NOT NULL AND p_action NOT IN ('cancel', 'delete') THEN
    RAISE EXCEPTION 'UNKNOWN_ACTION: %', p_action;
  END IF;
  IF p_changes IS NOT NULL AND (jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::jsonb) THEN
    RAISE EXCEPTION 'NO_CHANGES: changes must name at least one field';
  END IF;
  IF p_changes IS NULL AND p_action IS NULL THEN
    RAISE EXCEPTION 'NOTHING_TO_DO: send changes, an action, or both';
  END IF;
  IF p_changes IS NOT NULL AND p_action = 'delete' THEN
    RAISE EXCEPTION 'DELETE_WITH_CHANGES: a delete cannot also change fields';
  END IF;

  -- Changes: only listed keys, right JSON type, job_date never cleared, every value parsed and
  -- range-checked here, before any job is read, so a bad value is refused whatever the selection.
  -- The SET list is built from the sent keys only, so column-scoped triggers fire exactly as a
  -- direct UPDATE of those columns did.
  IF p_changes IS NOT NULL THEN
    FOR v_key, v_val IN SELECT k, v FROM jsonb_each(p_changes) AS e(k, v) ORDER BY k LOOP
      IF NOT v_types ? v_key THEN
        RAISE EXCEPTION 'FIELD_NOT_EDITABLE: % cannot be changed here', v_key;
      END IF;
      v_kind := v_types ->> v_key;
      IF jsonb_typeof(v_val) = 'null' THEN
        IF v_key = 'job_date' THEN RAISE EXCEPTION 'JOB_DATE_REQUIRED: a job date cannot be cleared'; END IF;
      ELSIF jsonb_typeof(v_val) <> (CASE WHEN v_kind = 'numeric' THEN 'number' ELSE 'string' END) THEN
        RAISE EXCEPTION 'BAD_VALUE: % has the wrong type', v_key;
      ELSIF v_kind = 'date' THEN
        -- A calendar day as YYYY-MM-DD only (no DateStyle, 'tomorrow' or 'infinity'); the cast rejects 2027-02-30.
        IF (v_val #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' THEN
          RAISE EXCEPTION 'BAD_VALUE: % must be a YYYY-MM-DD date', v_key;
        END IF;
        PERFORM (v_val #>> '{}')::date;
      ELSIF v_kind = 'uuid' THEN
        PERFORM (v_val #>> '{}')::uuid;
      ELSIF v_key = 'carrier_rate_gpa' AND (v_val #>> '{}')::numeric < 0 THEN
        RAISE EXCEPTION 'BAD_VALUE: carrier_rate_gpa cannot be negative';
      ELSIF v_key = 'loader_tank_capacity' AND (v_val #>> '{}')::numeric <= 0 THEN
        RAISE EXCEPTION 'BAD_VALUE: loader_tank_capacity must be above zero';
      END IF;
      v_set := v_set || format('%I = ($1 ->> %L)::%s, ', v_key, v_key, v_kind);
    END LOOP;
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'job_ids', to_jsonb(v_ids), 'changes', p_changes, 'action', p_action
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'edit_jobs', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- One job at a time in id order: lock it, then act on its current state. A write that changes
  -- no row (none expected: no BEFORE trigger on jobs returns NULL) aborts rather than being reported.
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT status, deleted_at INTO v_status, v_deleted_at FROM public.jobs WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'not_found');
      CONTINUE;
    END IF;
    IF v_deleted_at IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'deleted');
      CONTINUE;
    END IF;

    IF v_set <> '' THEN
      EXECUTE format('UPDATE public.jobs SET %s updated_by = $2 WHERE id = $3 RETURNING status', v_set)
        INTO v_status USING p_changes, v_actor, v_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN RAISE EXCEPTION 'EDIT_NOT_APPLIED: job %', v_id; END IF;
      v_updated := v_updated || v_id;
    END IF;

    IF p_action = 'cancel' THEN
      IF v_status IN ('scheduled', 'in_progress') THEN
        UPDATE public.jobs SET status = 'cancelled', updated_by = v_actor WHERE id = v_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN RAISE EXCEPTION 'EDIT_NOT_APPLIED: job %', v_id; END IF;
        v_cancelled := v_cancelled || v_id;
      ELSE
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'status', 'status', v_status);
      END IF;
    ELSIF p_action = 'delete' THEN
      IF v_status IN ('scheduled', 'in_progress', 'completed') THEN
        UPDATE public.jobs SET deleted_at = now(), updated_by = v_actor WHERE id = v_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN RAISE EXCEPTION 'EDIT_NOT_APPLIED: job %', v_id; END IF;
        v_deleted := v_deleted || v_id;
      ELSE
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'status', 'status', v_status);
      END IF;
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'updated', to_jsonb(v_updated), 'cancelled', to_jsonb(v_cancelled),
    'deleted', to_jsonb(v_deleted), 'skipped', v_skipped);
  PERFORM public.save_idempotency(p_idempotency_key, 'edit_jobs', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'edit_jobs', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.edit_jobs(uuid[], jsonb, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.edit_jobs(uuid[], jsonb, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_jobs(uuid[], jsonb, text, uuid, text) TO authenticated, service_role;
