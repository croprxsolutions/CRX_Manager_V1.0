-- KI-160 (remainder): starting a stock count is one server step.
-- Contract: docs/plans/2026-11-22-ki160-atomic-count-create-CONTRACT.md
--
-- WHY: CycleCounts.tsx made three browser requests (number, count, lines). If the lines failed, the empty count stayed
-- open, and the one-open-count-per-warehouse index (20270119130000) then blocked that warehouse until it was cancelled.
--
-- WHAT: adds create_cycle_count(p_warehouse, p_notes, p_performed_by, p_idempotency_key). In one transaction it takes
-- the next number (next_cycle_count_number, same lock), saves the count and one line per stock row at that location
-- (expected = on-hand), as the screen did; notes are stored trimmed (blank -> none). Active admin only. Any refusal
-- rolls everything back.
-- Additive only: the deployed app keeps its direct inserts until the screen PR lands; nothing else changes. No rows change.
--
-- ROLLBACK: DROP FUNCTION public.create_cycle_count(text, text, uuid, text);

CREATE TEMP TABLE create_cycle_count_ki160_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.create_cycle_count_ki160_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.create_cycle_count_ki160_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'create_cycle_count') THEN
    RAISE EXCEPTION 'CREATE_CYCLE_COUNT_EXISTS: create_cycle_count already exists (already applied?)';
  END IF;
  IF to_regclass('public.cycle_counts_one_open_per_warehouse') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: 20270119130000 (one open count per warehouse) must be applied first';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.create_cycle_count(
  p_warehouse text,
  p_notes text DEFAULT NULL::text,
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
  -- Matched exactly as stored (the picker sends stored names), as the screen did; only blank is refused.
  v_warehouse   text := p_warehouse;
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_fingerprint text;
  v_replay      jsonb;
  v_number      text;
  v_count_id    uuid;
  v_open        text;
  v_lines       int;
  v_constraint  text;
  v_result      jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- Same rule as next_cycle_count_number and the cycle_counts insert policy: an active admin. FOR SHARE holds off a
  -- deactivation or demotion until this call commits.
  PERFORM 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE: only an active admin can start a stock count'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\S' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_cycle_count requires p_idempotency_key';
  END IF;
  IF v_warehouse IS NULL OR v_warehouse !~ '\S' THEN RAISE EXCEPTION 'WAREHOUSE_REQUIRED: choose a location'; END IF;
  IF length(v_warehouse) > 200 OR length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'BAD_VALUE: location at most 200 characters, notes at most 2000';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'warehouse', v_warehouse, 'notes', v_notes)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_cycle_count', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Name the open count rather than surfacing the unique index's raw error. The index still decides a race.
  SELECT count_number INTO v_open FROM public.cycle_counts WHERE warehouse = v_warehouse AND status = 'in_progress' LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'COUNT_ALREADY_OPEN: % already has open count %; finish or cancel it first', v_warehouse, v_open;
  END IF;

  v_number := public.next_cycle_count_number();
  BEGIN
    INSERT INTO public.cycle_counts (count_number, warehouse, status, notes, initiated_by)
    VALUES (v_number, v_warehouse, 'in_progress', v_notes, v_actor)
    RETURNING id INTO v_count_id;
  EXCEPTION WHEN unique_violation THEN
    -- Only the one-open-count index means "already open"; anything else is re-raised as it is.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'cycle_counts_one_open_per_warehouse' THEN
      RAISE EXCEPTION 'COUNT_ALREADY_OPEN: % already has an open count; refresh the list', v_warehouse;
    END IF;
    RAISE;
  END;

  -- One line per stock row at the location, as the screen did; the line trigger refuses a row already on another open
  -- count, which rolls the whole call back.
  INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
  SELECT v_count_id, i.product_id, i.id, COALESCE(i.quantity_available, 0)
    FROM public.inventory i
   WHERE i.location = v_warehouse
   ORDER BY i.product_id, i.id;
  GET DIAGNOSTICS v_lines = ROW_COUNT;
  IF v_lines = 0 THEN RAISE EXCEPTION 'NO_INVENTORY: no stock rows at %', v_warehouse; END IF;

  v_result := jsonb_build_object('cycle_count_id', v_count_id, 'count_number', v_number,
                                 'warehouse', v_warehouse, 'line_count', v_lines);
  PERFORM public.save_idempotency(p_idempotency_key, 'create_cycle_count', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_cycle_count', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.create_cycle_count(text, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_cycle_count(text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_cycle_count(text, text, uuid, text) TO authenticated, service_role;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_cycle_count') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly one create_cycle_count';
  END IF;
  IF has_function_privilege('anon', 'public.create_cycle_count(text, text, uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_cycle_count(text, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: create_cycle_count grants are wrong (anon must not run it; authenticated must)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.create_cycle_count(text, text, uuid, text)'::regprocedure
                    AND prosecdef AND proowner = 'postgres'::regrole
                    AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: create_cycle_count must be SECURITY DEFINER, owned by postgres, search_path public, pg_temp';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
