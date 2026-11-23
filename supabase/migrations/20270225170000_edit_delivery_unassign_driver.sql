-- Written 2026-11-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270225170000_edit_delivery_unassign_driver.md.
--
-- WHY: on the office Delivery edit form, picking "Unassigned" for the driver kept the old driver. The screen sends no
--   driver, and the edit body reads "no driver" as "keep the driver" (assigned_driver = COALESCE(p_assigned_driver,
--   assigned_driver)). Mason, 2026-11-23 (Taha's audit question 4): the office may unassign a driver.
--
-- WHAT: public.edit_delivery gains p_clear_driver boolean DEFAULT false (last argument). When true:
--   1. naming a driver too is refused (DRIVER_CONFLICT); otherwise
--   2. after the unchanged body runs (same role, status and lock rules: admin or sales rep, scheduled or in progress),
--      the driver is set to none and the driver who had it gets a "Delivery Unassigned" notification;
--   3. the replay fingerprint gains clear_driver only when true, so every other request keeps its fingerprint; an
--      exact replay returns the first answer and changes nothing.
--   Without p_clear_driver every call (the current screen, positional 12-argument calls) behaves exactly as before.
--   A new argument means a new signature, so the old wrapper is dropped and the new one created in the same
--   transaction, with the old grants (authenticated and service_role; not PUBLIC or anon).
--
-- NOT CHANGED: _edit_delivery_replay_impl_20261015 (pinned below), every other function, table, row, policy and grant.
--
-- ROLLBACK (its own reviewed migration): drop the 13-argument wrapper and re-create the 12-argument one from
--   20270104120000_delivery_brands.sql (body md5 3d033929e3b7cf8d7a609e18099818c8) with the same grants. A screen
--   already sending p_clear_driver would then fail its save, so roll back the screen first.
--
-- ORDERING: after 20270104120000. Not re-runnable (preflight refuses). Postflight pins the new body md5 aca6ef9d8fd3064823e0b575c3732dbe.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'edit_delivery') <> 1
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.edit_delivery(uuid,uuid,date,text,text,text,uuid,text,text,jsonb,uuid,text)'))
        IS DISTINCT FROM '3d033929e3b7cf8d7a609e18099818c8'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public._edit_delivery_replay_impl_20261015(uuid,uuid,date,text,text,text,uuid,text,text,jsonb,uuid,text)'))
        IS DISTINCT FROM '942011a2bf15b83269e74830fa057377' THEN
    RAISE EXCEPTION 'EDIT_DELIVERY_UNASSIGN_PREFLIGHT: edit_delivery or its body is not the reviewed one (missing, drifted or already replaced)';
  END IF;
END;
$preflight$;

DROP FUNCTION public.edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text);

CREATE FUNCTION public.edit_delivery(
  p_delivery_id uuid,
  p_assigned_driver uuid DEFAULT NULL::uuid,
  p_scheduled_date date DEFAULT NULL::date,
  p_scheduled_time text DEFAULT NULL::text,
  p_delivery_window_start text DEFAULT NULL::text,
  p_delivery_window_end text DEFAULT NULL::text,
  p_delivery_address_id uuid DEFAULT NULL::uuid,
  p_delivery_notes text DEFAULT NULL::text,
  p_priority text DEFAULT NULL::text,
  p_items jsonb DEFAULT NULL::jsonb,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_clear_driver boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  v_old_lines jsonb;   -- 20270104120000
  v_before jsonb;      -- 20270104120000
  v_old record;        -- 20270104120000
  v_new_id uuid;       -- 20270104120000
  v_kept jsonb := '[]'::jsonb;     -- 20270104120000
  v_dropped jsonb := '[]'::jsonb;  -- 20270104120000
  v_seq bigint;        -- 20270104120000
  v_cleared_from uuid; -- 20270225170000
  v_number text;       -- 20270225170000
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: edit_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  -- 20270225170000: Unassigned is its own choice; a request cannot name a driver and clear it at once.
  IF p_clear_driver IS TRUE AND p_assigned_driver IS NOT NULL THEN
    RAISE EXCEPTION 'DRIVER_CONFLICT: pick a driver or Unassigned, not both' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'delivery_id', p_delivery_id,
    'assigned_driver', p_assigned_driver, 'scheduled_date', p_scheduled_date,
    'scheduled_time', p_scheduled_time, 'delivery_window_start', p_delivery_window_start,
    'delivery_window_end', p_delivery_window_end, 'delivery_address_id', p_delivery_address_id,
    'delivery_notes', p_delivery_notes, 'priority', p_priority, 'items', p_items)
    -- 20270225170000: added only when set, so every request without it keeps its earlier fingerprint.
    || CASE WHEN p_clear_driver IS TRUE THEN jsonb_build_object('clear_driver', true) ELSE '{}'::jsonb END);
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'edit_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- 20270104120000 (Brand PR B): lock the delivery, then copy its lines and picks before the body may delete them
  -- (the pick key cascades), so no save can slip between the copy and the delete.
  IF v_replay IS NULL THEN
    PERFORM 1 FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
    v_before := public._delivery_brand_rows(p_delivery_id);
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', di.id, 'order_item_id', di.order_item_id,
             'product_id', di.product_id, 'quantity', di.quantity, 'unit_size', di.unit_size,
             'picks', public._delivery_brand_rows(p_delivery_id, ARRAY[di.id])) ORDER BY di.id), '[]'::jsonb)
      INTO v_old_lines
      FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id;
  END IF;
  PERFORM set_config('crx.delivery_brand_edit', 'on', true);  -- 20270104120000: this wrapper records the edit
  v_result := public._edit_delivery_replay_impl_20261015(
    p_delivery_id, p_assigned_driver, p_scheduled_date, p_scheduled_time, p_delivery_window_start,
    p_delivery_window_end, p_delivery_address_id, p_delivery_notes, p_priority, p_items,
    p_performed_by, p_idempotency_key);
  PERFORM set_config('crx.delivery_brand_edit', '', true);
  -- 20270225170000: the body keeps the driver when none is named; Unassigned clears it here, under the delivery lock
  -- taken above and after the body's status check, and tells the driver who had it. A replay changes nothing.
  IF v_replay IS NULL AND p_clear_driver IS TRUE THEN
    SELECT d.assigned_driver, d.delivery_number INTO v_cleared_from, v_number
      FROM public.deliveries d WHERE d.id = p_delivery_id;
    IF v_cleared_from IS NOT NULL THEN
      UPDATE public.deliveries SET assigned_driver = NULL WHERE id = p_delivery_id;
      INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (v_cleared_from, 'Delivery Unassigned', 'Delivery ' || v_number || ' is no longer assigned to you.',
              'delivery_update', 'delivery', p_delivery_id);
    END IF;
  END IF;
  -- 20270104120000: a line whose order item, product, quantity and unit size are unchanged keeps its picks (with
  -- their entry and review history) under its new id, when exactly one old line and one new line share those four
  -- values; otherwise its picks are dropped and listed, never guessed. One 'edited' event either way.
  IF v_replay IS NULL AND (v_result ->> 'items_changed')::boolean IS TRUE THEN
    FOR v_old IN
      SELECT (o ->> 'id')::uuid AS id, (o ->> 'order_item_id')::uuid AS order_item_id,
             (o ->> 'product_id')::uuid AS product_id, (o ->> 'quantity')::numeric AS quantity,
             o ->> 'unit_size' AS unit_size, o -> 'picks' AS picks
        FROM jsonb_array_elements(v_old_lines) o
       WHERE jsonb_array_length(o -> 'picks') > 0
       ORDER BY (o ->> 'id')
    LOOP
      v_new_id := NULL;
      IF (SELECT count(*) FROM jsonb_array_elements(v_old_lines) x
           WHERE (x ->> 'order_item_id') IS NOT DISTINCT FROM v_old.order_item_id::text
             AND (x ->> 'product_id')::uuid = v_old.product_id AND (x ->> 'quantity')::numeric = v_old.quantity
             AND (x ->> 'unit_size') IS NOT DISTINCT FROM v_old.unit_size) = 1
         AND (SELECT count(*) FROM public.delivery_items di
               WHERE di.delivery_id = p_delivery_id AND di.order_item_id IS NOT DISTINCT FROM v_old.order_item_id
                 AND di.product_id = v_old.product_id AND di.quantity = v_old.quantity
                 AND di.unit_size IS NOT DISTINCT FROM v_old.unit_size) = 1 THEN
        v_new_id := (SELECT di.id FROM public.delivery_items di
                      WHERE di.delivery_id = p_delivery_id AND di.order_item_id IS NOT DISTINCT FROM v_old.order_item_id
                        AND di.product_id = v_old.product_id AND di.quantity = v_old.quantity
                        AND di.unit_size IS NOT DISTINCT FROM v_old.unit_size);
      END IF;
      IF v_new_id IS NULL THEN
        v_dropped := v_dropped || jsonb_build_array(jsonb_build_object('old_delivery_item_id', v_old.id,
          'order_item_id', v_old.order_item_id, 'product_id', v_old.product_id));
      ELSE
        INSERT INTO public.delivery_item_brands
          (delivery_item_id, delivery_id, product_id, source, parent_id, parent_brand_id, legacy_brand_id, brand_name,
           epa_registration, manufacturer, signal_word, quantity, review_state, review_note, review_brand_ref,
           review_reason, reviewed_by, reviewed_at, entered_by, entered_at)
        SELECT v_new_id, p_delivery_id, v_old.product_id, r ->> 'source', (r ->> 'parent_id')::uuid,
               (r ->> 'parent_brand_id')::uuid, (r ->> 'legacy_brand_id')::uuid, r ->> 'brand_name',
               r ->> 'epa_registration', r ->> 'manufacturer', r ->> 'signal_word', (r ->> 'quantity')::numeric,
               r ->> 'review_state', r ->> 'review_note', (r ->> 'review_brand_ref')::uuid, r ->> 'review_reason',
               (r ->> 'reviewed_by')::uuid, (r ->> 'reviewed_at')::timestamptz,
               (r ->> 'entered_by')::uuid, (r ->> 'entered_at')::timestamptz
          FROM jsonb_array_elements(v_old.picks) r;
        v_kept := v_kept || jsonb_build_array(jsonb_build_object('old_delivery_item_id', v_old.id,
          'delivery_item_id', v_new_id));
      END IF;
    END LOOP;
    v_seq := public._delivery_brand_event(p_delivery_id, 'edited', NULL, NULL, v_before,
      public._delivery_brand_rows(p_delivery_id), jsonb_build_object('kept', v_kept, 'dropped', v_dropped));
    v_result := v_result || jsonb_build_object('brand_picks_kept', v_kept, 'brand_lines_dropped', v_dropped,
      'brand_event_seq', v_seq);
    -- A replay returns the same answer: the body's receipt (written above, bound below) carries the brand fields.
    UPDATE public.idempotency_keys SET result = v_result
     WHERE idempotency_key = p_idempotency_key AND operation = 'edit_delivery'
       AND request_actor_id IS NULL AND request_fingerprint IS NULL;
  END IF;
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'edit_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text, boolean) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_oid oid := to_regprocedure('public.edit_delivery(uuid,uuid,date,text,text,text,uuid,text,text,jsonb,uuid,text,boolean)');
BEGIN
  IF v_oid IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'edit_delivery') <> 1
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'aca6ef9d8fd3064823e0b575c3732dbe'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'EDIT_DELIVERY_UNASSIGN_POSTFLIGHT: edit_delivery is not one reviewed SECURITY DEFINER signature';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'EDIT_DELIVERY_UNASSIGN_POSTFLIGHT: edit_delivery grants are not authenticated and service_role only';
  END IF;
END;
$postflight$;
