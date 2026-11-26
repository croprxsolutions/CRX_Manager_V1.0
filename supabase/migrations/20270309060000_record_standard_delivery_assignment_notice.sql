-- The standard new-delivery operation records its existing driver notice.
-- Older browser sessions can keep their existing send path during the rollout.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.skip_repeated_delivery_assignment_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.notifications AS notice
    WHERE notice.notification_type = 'delivery_assigned'
      AND notice.related_entity_type = 'delivery'
      AND notice.related_entity_id = NEW.related_entity_id
      AND notice.user_id = NEW.user_id
      AND notice.created_by = auth.uid()
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.skip_repeated_delivery_assignment_notice() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER notifications_skip_repeated_delivery_assignment
BEFORE INSERT ON public.notifications
FOR EACH ROW
WHEN (
  current_user = 'authenticated'
  AND NEW.notification_type = 'delivery_assigned'
  AND NEW.related_entity_type = 'delivery'
)
EXECUTE FUNCTION public.skip_repeated_delivery_assignment_notice();

CREATE OR REPLACE FUNCTION public.create_delivery_with_items(
  p_order_id uuid,
  p_customer_id uuid,
  p_scheduled_date date,
  p_items jsonb,
  p_delivery_address_id uuid DEFAULT NULL::uuid,
  p_assigned_driver uuid DEFAULT NULL::uuid,
  p_scheduled_time text DEFAULT NULL::text,
  p_delivery_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
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
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_delivery_with_items requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'ORDER_ID_REQUIRED'; END IF;
  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED'; END IF;
  IF p_scheduled_date IS NULL THEN RAISE EXCEPTION 'SCHEDULED_DATE_REQUIRED'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUIRED';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'order_id', p_order_id, 'customer_id', p_customer_id,
    'scheduled_date', p_scheduled_date, 'items', p_items,
    'delivery_address_id', p_delivery_address_id, 'assigned_driver', p_assigned_driver,
    'scheduled_time', p_scheduled_time, 'delivery_notes', p_delivery_notes));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_delivery_with_items', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_delivery_with_items_replay_impl_20261015(
    p_order_id, p_customer_id, p_scheduled_date, p_items, p_delivery_address_id, p_assigned_driver,
    p_scheduled_time, p_delivery_notes, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_delivery_with_items', v_fingerprint);

    IF p_assigned_driver IS NOT NULL THEN
      -- A notice failure must not invalidate a saved delivery.
      BEGIN
        INSERT INTO public.notifications
          (user_id, title, message, notification_type, related_entity_type, related_entity_id, created_by)
        SELECT d.assigned_driver, 'New Delivery Assigned',
          format('You''ve been assigned delivery %s for %s on %s', d.delivery_number,
            COALESCE(NULLIF(c.farm_name, ''), 'customer'), to_char(d.scheduled_date, 'FMMM/FMDD/YYYY')),
          'delivery_assigned', 'delivery', d.id, v_actor
        FROM public.deliveries AS d
        LEFT JOIN public.customers AS c ON c.id = d.customer_id
        WHERE d.id = (v_result ->> 'delivery_id')::uuid AND d.assigned_driver IS NOT NULL;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to record delivery assignment notice (SQLSTATE %)', SQLSTATE;
      END;
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) TO authenticated, service_role;

DO $postflight$
BEGIN
  IF has_function_privilege('anon', 'public.skip_repeated_delivery_assignment_notice()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.skip_repeated_delivery_assignment_notice()', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.skip_repeated_delivery_assignment_notice()', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.create_delivery_with_items(uuid,uuid,date,jsonb,uuid,uuid,text,text,text)', 'EXECUTE')
  THEN RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_NOTICE_GRANT_MISMATCH'; END IF;
END
$postflight$;
