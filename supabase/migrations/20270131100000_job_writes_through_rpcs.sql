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
  v_live        uuid[];
  v_target      uuid[];
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
      ELSIF v_kind = 'numeric' AND (v_val #>> '{}')::numeric > 1000000 THEN
        -- Far above any real rate or tank, and well inside what the browser reads as a finite number.
        RAISE EXCEPTION 'BAD_VALUE: % is too large', v_key;
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

  -- Lock every selected job first, in id order, then change them set-wise: one UPDATE per kind of
  -- change, as the screens' bulk update does today. Each statement's AFTER row triggers (booking
  -- reservation rebuild, hold release, dispatch close) then run once every row is already changed,
  -- so a booking's siblings are not rebuilt over and over. No BEFORE trigger on jobs returns NULL, so
  -- every UPDATE must change exactly the rows it targets; a shortfall aborts rather than being reported.
  SELECT coalesce(array_agg(id ORDER BY id) FILTER (WHERE deleted_at IS NULL), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'reason', 'deleted') ORDER BY id)
                    FILTER (WHERE deleted_at IS NOT NULL), '[]'::jsonb)
    INTO v_live, v_skipped
    FROM (SELECT id, deleted_at FROM public.jobs WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE) AS locked;
  SELECT v_skipped || coalesce(jsonb_agg(jsonb_build_object('id', x, 'reason', 'not_found') ORDER BY x), '[]'::jsonb)
    INTO v_skipped
    FROM unnest(v_ids) AS x
   WHERE NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = x);

  IF v_set <> '' AND cardinality(v_live) > 0 THEN
    EXECUTE format('UPDATE public.jobs SET %s updated_by = $2 WHERE id = ANY ($3)', v_set)
      USING p_changes, v_actor, v_live;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> cardinality(v_live) THEN RAISE EXCEPTION 'EDIT_NOT_APPLIED: % of % jobs changed', v_rows, cardinality(v_live); END IF;
    v_updated := v_live;
  END IF;

  IF p_action IS NOT NULL AND cardinality(v_live) > 0 THEN
    -- Eligibility reads each job's status after the changes above.
    SELECT coalesce(array_agg(id ORDER BY id) FILTER (WHERE status = ANY (v_allowed)), '{}'),
           v_skipped || coalesce(jsonb_agg(jsonb_build_object('id', id, 'reason', 'status', 'status', status) ORDER BY id)
                                   FILTER (WHERE NOT status = ANY (v_allowed)), '[]'::jsonb)
      INTO v_target, v_skipped
      FROM (SELECT id, status, CASE p_action WHEN 'cancel' THEN ARRAY['scheduled', 'in_progress']
                                             ELSE ARRAY['scheduled', 'in_progress', 'completed'] END AS v_allowed
              FROM public.jobs WHERE id = ANY (v_live)) AS cur;
    IF cardinality(v_target) > 0 THEN
      IF p_action = 'cancel' THEN
        UPDATE public.jobs SET status = 'cancelled', updated_by = v_actor WHERE id = ANY (v_target);
      ELSE
        UPDATE public.jobs SET deleted_at = now(), updated_by = v_actor WHERE id = ANY (v_target);
      END IF;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> cardinality(v_target) THEN RAISE EXCEPTION 'EDIT_NOT_APPLIED: % of % jobs changed', v_rows, cardinality(v_target); END IF;
      IF p_action = 'cancel' THEN v_cancelled := v_target; ELSE v_deleted := v_target; END IF;
    END IF;
  END IF;

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
