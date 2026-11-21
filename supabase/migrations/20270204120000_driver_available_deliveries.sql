-- #2018: drivers see open deliveries and take one for themself.
--
-- Mason decided 2026-11-21 that every active driver may see all open (unassigned, scheduled) deliveries and take
-- one. The driver Deliveries screen already has that card and its "Take This Delivery" button, but it read the
-- deliveries table directly, and the del_select read rule shows a driver only deliveries assigned to them, so
-- the card was always empty. Contract: docs/plans/2026-11-21-driver-available-deliveries-CONTRACT.md.
--
-- 1. New get_available_deliveries_for_driver(): an active driver only, and not one an admin has denied the
--    Deliveries page (profiles.denied_pages contains 'deliveries'). Returns {rows: [...]} with every open
--    delivery (assigned_driver null, status scheduled, not deleted), soonest first, and for each only its id,
--    number, date, customer name and farm group (TOP parent, as the lists show since #1995). No address, notes,
--    items or prices. SECURITY DEFINER because the read rule hides these rows; the read rule itself is unchanged.
-- 2. reassign_delivery: the driver branch (not admin or sales rep) refuses a driver denied the Deliveries page,
--    lets a driver assign a delivery only to themself, checks the idempotency key first (the same lock order as
--    admin and sales rep: key, then row), then locks the delivery row before checking it and refuses a taken,
--    deleted or no-longer-scheduled delivery with "already taken or changed" (one already the caller's with a
--    fresh key gets "already assigned to you"), not a permission error. After the lock it re-checks the driver's
--    access and holds their profile row, so an access change made while the take waited is honored. A driver's
--    same-key replay is returned only while the delivery is still theirs. Before, the open check ran
--    unlocked, so two drivers taking one delivery at once could both pass and the second silently took it; and a
--    driver could assign an open delivery to someone else. A bound retry (same key, same caller, same request) now
--    returns its stored result before the body runs (the body re-checks
--    "unassigned" for a driver, which refused a driver's retry after a lost reply). For admin and sales rep the
--    stored result is the same one the body's own replay returned. Admin and sales rep authority, the replay
--    binding, the body it calls, the signature and grants are unchanged.
--
-- No table, row, policy or other function changes. Rollback: ship the screen rollback first, then a new reviewed
-- migration dropping get_available_deliveries_for_driver(). The reassign_delivery hardening is corrected forward,
-- never reverted (reverting would reopen the double-take race).

CREATE TEMP TABLE driver_available_2018_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.driver_available_2018_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.driver_available_2018_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  -- The wrapper body this file replaces (20261110160000); anything else means someone changed it since.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.reassign_delivery(uuid,uuid,uuid,text)'))
     IS DISTINCT FROM '350f587913b20f2908a7a2a44445b0f6' THEN
    RAISE EXCEPTION 'DRIVER_AVAILABLE_BASELINE_DRIFT: reassign_delivery is not the 20261110160000 body (already applied?)';
  END IF;
  -- Only the one signature this file hardens may exist; an older overload would bypass it.
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'reassign_delivery' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'DRIVER_AVAILABLE_BASELINE_DRIFT: reassign_delivery has more than one overload';
  END IF;
  IF to_regprocedure('public.get_available_deliveries_for_driver()') IS NOT NULL THEN
    RAISE EXCEPTION 'DRIVER_AVAILABLE_BASELINE_DRIFT: get_available_deliveries_for_driver already exists';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.get_available_deliveries_for_driver()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'driver'
      AND NOT COALESCE('deliveries' = ANY (denied_pages), false)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view available deliveries' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object('rows', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', o.id,
             'delivery_number', o.delivery_number,
             'scheduled_date', o.scheduled_date,
             'customer_name', o.customer_name,
             'farm_group_name', o.farm_group_name)
           ORDER BY o.scheduled_date, o.delivery_number, o.id)
    FROM (
      SELECT d.id, d.delivery_number, d.scheduled_date,
             COALESCE(NULLIF(c.farm_name, ''), 'Unknown') AS customer_name,
             NULLIF(pc.farm_name, '') AS farm_group_name
      FROM public.deliveries d
      LEFT JOIN public.customers c ON c.id = d.customer_id
      LEFT JOIN LATERAL (
        -- The farm group is the TOP parent, as in get_deliveries_keyset_page (#1995). The walk recurses on customer
        -- ids with UNION, so it always ends, even on a loop; a loop has no top, so the direct parent stands in.
        WITH RECURSIVE up(id, parent_customer_id) AS (
          SELECT p.id, p.parent_customer_id FROM public.customers p WHERE p.id = c.parent_customer_id
          UNION
          SELECT p.id, p.parent_customer_id FROM public.customers p JOIN up u ON p.id = u.parent_customer_id
        )
        SELECT COALESCE((SELECT u.id FROM up u WHERE u.parent_customer_id IS NULL LIMIT 1), c.parent_customer_id) AS id
      ) fg ON c.parent_customer_id IS NOT NULL
      LEFT JOIN public.customers pc ON pc.id = fg.id
      WHERE d.assigned_driver IS NULL
        AND d.status = 'scheduled'
        AND d.deleted_at IS NULL
    ) o), '[]'::jsonb));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_available_deliveries_for_driver() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_available_deliveries_for_driver() TO authenticated, service_role;
COMMENT ON FUNCTION public.get_available_deliveries_for_driver() IS
  '#2018: an active driver''s list of every open delivery (unassigned, scheduled, not deleted), soonest first: id, number, date, customer and top farm group only.';

CREATE OR REPLACE FUNCTION public.reassign_delivery(
  p_delivery_id uuid,
  p_new_driver uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_office boolean;
  v_owner uuid;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reassign_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_is_office := EXISTS (
    SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  );
  -- #2018: a driver (active, not denied the Deliveries page) may assign a delivery only to themself.
  IF NOT v_is_office AND (NOT EXISTS (
       SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'driver'
         AND NOT COALESCE('deliveries' = ANY (denied_pages), false)
     ) OR p_new_driver IS DISTINCT FROM v_actor) THEN
    RAISE EXCEPTION 'Not authorized to reassign deliveries';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'delivery_id', p_delivery_id, 'new_driver', p_new_driver));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reassign_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- #2018: the key lock above may have waited. An office caller must still be an active admin or sales rep now, and
  -- their profile row is held until commit, so a role change or deactivation made meanwhile is honored.
  IF v_is_office THEN
    PERFORM 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not authorized to reassign deliveries';
    END IF;
  END IF;
  -- #2018: a bound retry (same key, caller and request) returns its stored result here. The body re-checks
  -- "unassigned" for a driver, so a driver's retry after a lost reply would otherwise be refused, not replayed.
  -- A driver's replay is returned only while the delivery is still theirs, so the screen never says "assigned to
  -- you" for one dispatch has since moved; otherwise the current state wins.
  IF v_replay IS NOT NULL THEN
    -- The key lock above may have waited: re-check the driver's access, as the fresh path does after its row lock.
    IF NOT v_is_office THEN
      PERFORM 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'driver'
        AND NOT COALESCE('deliveries' = ANY (denied_pages), false)
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Not authorized to reassign deliveries';
      END IF;
    END IF;
    IF NOT v_is_office THEN
      -- FOR SHARE waits for an open dispatch change to this delivery, then re-reads it.
      PERFORM 1 FROM public.deliveries WHERE id = p_delivery_id AND deleted_at IS NULL AND assigned_driver = v_actor
        AND status IN ('scheduled', 'in_progress')
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'This delivery was already taken or changed. Refresh the list.';
      END IF;
    END IF;
    RETURN v_replay -> 'result';
  END IF;
  IF NOT v_is_office THEN
    -- #2018: lock the row before checking it (after the key lock, as the body does for admin and sales rep), so of
    -- two drivers taking one delivery at once the second waits, re-reads it as taken, and is refused.
    SELECT assigned_driver INTO v_owner FROM public.deliveries
     WHERE id = p_delivery_id AND deleted_at IS NULL AND status = 'scheduled'
       AND (assigned_driver IS NULL OR assigned_driver = v_actor)
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'This delivery was already taken or changed. Refresh the list.';
    END IF;
    -- The lock above may have waited: re-check the driver's access now, and hold their profile row until commit so
    -- an admin's deactivation or Deliveries denial cannot slip in before this take commits.
    PERFORM 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'driver'
      AND NOT COALESCE('deliveries' = ANY (denied_pages), false)
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not authorized to reassign deliveries';
    END IF;
    IF v_owner = v_actor THEN
      RAISE EXCEPTION 'This delivery is already assigned to you. Refresh the list.';
    END IF;
  END IF;
  v_result := public._reassign_delivery_replay_impl_20261015(p_delivery_id, p_new_driver, p_performed_by, p_idempotency_key);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'reassign_delivery', v_fingerprint);
  RETURN v_result;
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=public, pg_temp']
        FROM pg_proc WHERE oid = to_regprocedure('public.get_available_deliveries_for_driver()')) IS NOT TRUE
     OR has_function_privilege('anon', 'public.get_available_deliveries_for_driver()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_available_deliveries_for_driver()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_available_deliveries_for_driver must be definer, stable, fixed search_path, authenticated only';
  END IF;
  IF (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']
        FROM pg_proc WHERE oid = to_regprocedure('public.reassign_delivery(uuid,uuid,uuid,text)')) IS NOT TRUE
     OR has_function_privilege('anon', 'public.reassign_delivery(uuid,uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.reassign_delivery(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: reassign_delivery must keep its security and grants';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'reassign_delivery' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: reassign_delivery must have exactly one overload';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
