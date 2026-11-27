-- Add the checked sender before switching Order Detail. Older clients keep
-- their existing cancel_order call and notification behavior.
-- idempotency-body-check: exempt. The reviewed lifecycle receipt helpers bind
-- the caller and order and save the wrapper result before any notice is sent.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF current_setting('lock_timeout') <> '5s' THEN
    RAISE EXCEPTION 'CANCEL_ORDER_NOTICE_TRANSACTION_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.cancel_order(uuid,uuid,text)', '842908e8cdbfcfbb553964280e1fd592'),
      ('public._cancel_order_idem_impl_20260721(uuid,uuid,text)', 'f45063a92e0f5bedcca3d05ea74f7c01'),
      ('public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)', '0d6fe6c0c9ea71f11ce8cc233665eba2'),
      ('public._bind_completed_lifecycle_idempotency(text,text,text,text,jsonb,jsonb)', '5c72187a25c2a5b7c807edda36bac2cd')
    ) AS expected(signature, body_hash)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = to_regprocedure(expected.signature)
    WHERE md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM expected.body_hash
  ) THEN RAISE EXCEPTION 'CANCEL_ORDER_NOTICE_SOURCE_DRIFT'; END IF;
END;
$preflight$;

CREATE FUNCTION public.cancel_order_with_notice(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_operation CONSTANT text := 'cancel_order_with_notice';
  v_contract CONSTANT text := 'cancel_order_with_notice_v1';
  v_key text;
  v_request jsonb;
  v_fingerprint text;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: cancel_order_with_notice' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  -- This receipt belongs to the new operation. Cached screens use their original keys.
  v_key := v_operation || ':' || p_idempotency_key;
  v_request := jsonb_build_object(
    'contract_version', v_contract, 'actor_id', v_actor, 'order_id', p_order_id
  );
  v_fingerprint := md5(v_request::text);
  v_result := public._claim_bound_lifecycle_idempotency(
    v_key, v_operation, v_contract, v_fingerprint, v_request
  );
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;

  v_result := public.cancel_order(p_order_id, v_actor, v_operation || ':inner:' || gen_random_uuid());
  PERFORM public._bind_completed_lifecycle_idempotency(
    v_key, v_operation, v_contract, v_fingerprint, v_request, v_result
  );

  -- A second request can return full_cancel and cancelled without making a new save.
  IF v_result->'success' = 'true'::jsonb AND v_result->>'mode' = 'full_cancel' THEN
    BEGIN
      INSERT INTO public.notifications
        (user_id, title, message, notification_type, related_entity_type, related_entity_id, created_by)
      SELECT p.id, 'Order cancelled',
        format('Order %s for %s is now cancelled', o.order_number, COALESCE(NULLIF(c.farm_name, ''), 'customer')),
        'order_status', 'order', o.id, v_actor
      FROM public.orders AS o
      LEFT JOIN public.customers AS c ON c.id = o.customer_id
      CROSS JOIN public.profiles AS p
      WHERE o.id = p_order_id AND o.status = 'cancelled'
        AND p.role = 'admin' AND p.is_active = true;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      BEGIN
        INSERT INTO public.failed_notifications
          (notification_type, entity_type, entity_id, error_message, payload)
        VALUES ('order_status', 'order', p_order_id,
          'Database could not send the order cancellation notice (SQLSTATE ' || SQLSTATE || ')',
          jsonb_build_object('status', 'cancelled', 'sender', v_actor));
      EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Failed to record order cancellation notice failure (SQLSTATE %)', SQLSTATE;
      END;
    END;
  END IF;
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.cancel_order_with_notice(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cancel_order_with_notice(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_order_with_notice(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.cancel_order_with_notice(uuid, uuid, text) IS
  'Active-admin cancellation with one staff notice for a newly saved whole cancellation. Caller-bound retry.';

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = 'cancel_order_with_notice') <> 1
    OR NOT has_function_privilege('authenticated', 'public.cancel_order_with_notice(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.cancel_order_with_notice(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.cancel_order_with_notice(uuid,uuid,text)', 'EXECUTE')
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid = 'public.cancel_order_with_notice(uuid,uuid,text)'::regprocedure
        AND prosecdef AND proowner = 'postgres'::regrole
        AND proconfig @> ARRAY['search_path=public, pg_temp']
    )
  THEN RAISE EXCEPTION 'CANCEL_ORDER_NOTICE_GRANT_MISMATCH'; END IF;
END;
$postflight$;
