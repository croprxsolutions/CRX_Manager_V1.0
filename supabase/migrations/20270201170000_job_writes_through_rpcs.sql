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
  v_is_admin    boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- An admin, or a sales rep whose Job Schedule page is not blocked (as the screens' hasPageAccess).
  SELECT role = 'admin' INTO v_is_admin FROM public.profiles
   WHERE id = v_actor AND is_active = true
     AND (role = 'admin' OR (role = 'sales_rep' AND NOT coalesce('jobs' = ANY (denied_pages), false)));
  IF v_is_admin IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: edit_jobs requires an active admin, or a sales rep with the Job Schedule page';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\S' THEN
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
      ELSIF v_kind = 'numeric' AND ((v_val #>> '{}')::numeric > 1000000
            OR ((v_val #>> '{}')::numeric > 0 AND (v_val #>> '{}')::numeric < 0.001)) THEN
        -- Real rates and tanks sit between these; outside them the browser reads Infinity or 0.
        RAISE EXCEPTION 'BAD_VALUE: % must be 0.001 to 1000000', v_key;
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

  -- A new applicator must be one the screens offer. Checked after the replay lookup, so a retry of a
  -- saved call still gets its saved result; FOR SHARE holds off a deactivation until this call commits,
  -- so a job is never handed to an inactive profile (whose dispatch trigger would leave the old one open).
  IF jsonb_typeof(p_changes -> 'applicator_id') = 'string' THEN
    PERFORM 1 FROM public.profiles WHERE id = (p_changes ->> 'applicator_id')::uuid AND is_active = true
       AND role IN ('applicator', 'admin', 'sales_rep') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BAD_VALUE: applicator_id must be an active applicator, admin or sales rep'; END IF;
  END IF;

  -- Lock every selected job first, in id order, then change them set-wise: one UPDATE per kind of
  -- change, as the screens' bulk update does today. Each statement's AFTER row triggers (booking
  -- reservation rebuild, hold release, dispatch close) then run once every row is already changed,
  -- so a booking's siblings are not rebuilt over and over. No BEFORE trigger on jobs returns NULL, so
  -- every UPDATE must change exactly the rows it targets; a shortfall aborts rather than being reported.
  -- One snapshot: every requested id is either locked and live, or skipped as deleted / not found /
  -- invoiced. Invoiced jobs are never changed here, even by an admin (Mason, 2026-11-21): Mass Edit
  -- already hides them, and a stale screen must not move billed work or its applicator access.
  -- FOR NO KEY UPDATE is the lock the UPDATEs below take anyway, so this adds no new lock conflict.
  WITH locked AS (SELECT id, deleted_at, status FROM public.jobs WHERE id = ANY (v_ids) ORDER BY id FOR NO KEY UPDATE)
  SELECT coalesce(array_agg(x ORDER BY x) FILTER (WHERE l.id IS NOT NULL AND l.deleted_at IS NULL AND l.status <> 'invoiced'), '{}'),
         coalesce(jsonb_agg(CASE WHEN l.id IS NULL THEN jsonb_build_object('id', x, 'reason', 'not_found')
                                 WHEN l.deleted_at IS NOT NULL THEN jsonb_build_object('id', x, 'reason', 'deleted')
                                 ELSE jsonb_build_object('id', x, 'reason', 'status', 'status', l.status) END ORDER BY x)
                    FILTER (WHERE l.id IS NULL OR l.deleted_at IS NOT NULL OR l.status = 'invoiced'), '[]'::jsonb)
    INTO v_live, v_skipped
    FROM unnest(v_ids) AS x LEFT JOIN locked l ON l.id = x;
  -- The caller may have been deactivated while this call waited for those locks.
  SELECT role = 'admin' INTO v_is_admin FROM public.profiles
   WHERE id = v_actor AND is_active = true
     AND (role = 'admin' OR (role = 'sales_rep' AND NOT coalesce('jobs' = ANY (denied_pages), false)));
  IF v_is_admin IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: edit_jobs requires an active admin, or a sales rep with the Job Schedule page';
  END IF;

  IF v_set <> '' AND cardinality(v_live) > 0 THEN
    EXECUTE format('UPDATE public.jobs SET %s updated_by = $2 WHERE id = ANY ($3)', v_set)
      USING p_changes, v_actor, v_live;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> cardinality(v_live) THEN RAISE EXCEPTION 'EDIT_NOT_APPLIED: % of % jobs changed', v_rows, cardinality(v_live); END IF;
    v_updated := v_live;
  END IF;

  IF p_action IS NOT NULL AND cardinality(v_live) > 0 THEN
    -- Eligibility reads each job's status after the changes above. Only an admin may delete a
    -- completed job (Mason, 2026-11-21), so billable work cannot quietly leave Unbilled Jobs.
    SELECT coalesce(array_agg(id ORDER BY id) FILTER (WHERE status = ANY (v_allowed)), '{}'),
           v_skipped || coalesce(jsonb_agg(jsonb_build_object('id', id, 'reason', 'status', 'status', status) ORDER BY id)
                                   FILTER (WHERE NOT status = ANY (v_allowed)), '[]'::jsonb)
      INTO v_target, v_skipped
      FROM (SELECT id, status, CASE p_action WHEN 'cancel' THEN ARRAY['scheduled', 'in_progress']
                                             WHEN 'delete' THEN CASE WHEN v_is_admin THEN ARRAY['scheduled', 'in_progress', 'completed']
                                                                     ELSE ARRAY['scheduled', 'in_progress'] END END AS v_allowed
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
