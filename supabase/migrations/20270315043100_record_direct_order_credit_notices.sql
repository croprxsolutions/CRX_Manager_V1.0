-- Add an opt-in workflow for the existing New Order credit notice.
-- idempotency-body-check: exempt. The save delegates to create_direct_order.
-- The notice locks that same actor-bound receipt and records delivery on it.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF current_setting('lock_timeout') <> '5s' THEN
    RAISE EXCEPTION 'DIRECT_ORDER_CREDIT_NOTICE_TRANSACTION_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.create_direct_order(uuid,date,text,text,jsonb,uuid,text,text)', '334f793153b61480da0da992daad37e1'),
      ('public.check_idempotency_intent(text,text,uuid,text)', 'edc73be809069669e8441eba7acf443d'),
      ('public.check_customer_credit_limit(uuid)', 'fb3f50390b8354225714fe169aa579e2'),
      ('public.require_admin_or_sales_rep()', '958c994aeabcb9f53b6cef316019a219')
    ) AS expected(signature, body_hash)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = to_regprocedure(expected.signature)
    WHERE md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM expected.body_hash
      OR p.proowner IS DISTINCT FROM 'postgres'::regrole
  ) OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.idempotency_keys'::regclass)
  THEN RAISE EXCEPTION 'DIRECT_ORDER_CREDIT_NOTICE_SOURCE_DRIFT'; END IF;
END;
$preflight$;

CREATE FUNCTION public.create_direct_order_with_credit_notice(
  p_customer_id uuid,
  p_order_date date,
  p_order_name text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_customer_po_number text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_has_receipt boolean;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_direct_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;

  -- Share the canonical save lock so a legacy save cannot race into this workflow.
  PERFORM pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_idempotency_key, 0));
  SELECT EXISTS (
    SELECT 1 FROM public.idempotency_keys
    WHERE idempotency_key = p_idempotency_key AND operation = 'create_direct_order'
      AND expires_at >= now()
  ) INTO v_has_receipt;

  v_result := public.create_direct_order(
    p_customer_id, p_order_date, p_order_name, p_notes, p_items,
    p_performed_by, p_idempotency_key, p_customer_po_number
  );
  IF NOT v_has_receipt AND v_result->>'order_id' IS NOT NULL THEN
    BEGIN
      UPDATE public.idempotency_keys
      SET result = result || jsonb_build_object(
        '_direct_order_credit_notice', jsonb_build_object('customer_id', p_customer_id)
      )
      WHERE idempotency_key = p_idempotency_key AND operation = 'create_direct_order'
        AND request_actor_id = auth.uid() AND request_fingerprint IS NOT NULL
        AND result->>'order_id' = v_result->>'order_id';

      IF NOT FOUND THEN RAISE EXCEPTION 'DIRECT_ORDER_CREDIT_NOTICE_RECEIPT_MISSING'; END IF;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      RAISE LOG 'Could not authorize a direct order credit notice (SQLSTATE %)', SQLSTATE;
      RETURN v_result || jsonb_build_object('notice_marker_failed', true);
    END;
  END IF;

  RETURN v_result - '_direct_order_credit_notice';
END;
$function$;

CREATE FUNCTION public.send_direct_order_credit_notice(p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_marker jsonb;
  v_customer_id uuid;
  v_credit jsonb;
  v_message text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: send_direct_order_credit_notice' USING ERRCODE = '22023';
  END IF;
  PERFORM public.require_admin_or_sales_rep();

  SELECT result->'_direct_order_credit_notice' INTO v_marker
  FROM public.idempotency_keys
  WHERE idempotency_key = p_idempotency_key AND operation = 'create_direct_order'
    AND request_actor_id = v_actor AND request_fingerprint IS NOT NULL AND expires_at >= now()
    AND jsonb_typeof(result->'_direct_order_credit_notice') = 'object'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_customer_id := (v_marker->>'customer_id')::uuid;
  v_credit := public.check_customer_credit_limit(v_customer_id);
  IF v_marker->'handled' = 'true'::jsonb THEN RETURN v_credit; END IF;

  BEGIN
    IF v_credit->'exceeded' = 'true'::jsonb THEN
      v_message := format(
        '%s outstanding AR $%s exceeds credit limit $%s',
        COALESCE(v_credit->>'farm_name', 'Unknown'),
        rtrim(rtrim(to_char((v_credit->>'outstanding_ar')::numeric, 'FM9,999,999,999,999,999,990.00'), '0'), '.'),
        rtrim(rtrim(to_char((v_credit->>'credit_limit')::numeric, 'FM9,999,999,999,999,999,990.00'), '0'), '.')
      );
      INSERT INTO public.notifications
        (user_id, title, message, notification_type, related_entity_type, related_entity_id, created_by)
      SELECT p.id, 'Credit Limit Exceeded', v_message, 'credit_limit_exceeded', 'customer', v_customer_id, v_actor
      FROM public.profiles AS p
      WHERE p.role = 'admin' AND p.is_active;
    END IF;

    UPDATE public.idempotency_keys
    SET result = jsonb_set(result, '{_direct_order_credit_notice,handled}', 'true'::jsonb)
    WHERE idempotency_key = p_idempotency_key AND operation = 'create_direct_order'
      AND request_actor_id = v_actor;
    IF NOT FOUND THEN RAISE EXCEPTION 'DIRECT_ORDER_CREDIT_NOTICE_RECEIPT_MISSING'; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'Could not record a direct order credit notice (SQLSTATE %)', SQLSTATE;
    RETURN v_credit || jsonb_build_object('notice_failed', true);
  END;

  RETURN v_credit;
END;
$function$;

ALTER FUNCTION public.create_direct_order_with_credit_notice(uuid,date,text,text,jsonb,uuid,text,text) OWNER TO postgres;
ALTER FUNCTION public.send_direct_order_credit_notice(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_direct_order_with_credit_notice(uuid,date,text,text,jsonb,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.send_direct_order_credit_notice(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_direct_order_with_credit_notice(uuid,date,text,text,jsonb,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_direct_order_credit_notice(text) TO authenticated;

COMMENT ON FUNCTION public.create_direct_order_with_credit_notice(uuid,date,text,text,jsonb,uuid,text,text) IS
  'Ordinary order save with caller-bound authority for the existing post-save credit notice.';
COMMENT ON FUNCTION public.send_direct_order_credit_notice(text) IS
  'Check the original customer of a checked order and send the existing active-admin credit notice once.';

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('create_direct_order_with_credit_notice','public.create_direct_order_with_credit_notice(uuid,date,text,text,jsonb,uuid,text,text)'),
      ('send_direct_order_credit_notice','public.send_direct_order_credit_notice(text)')
    ) AS expected(name, signature)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR NOT p.prosecdef OR p.proowner <> 'postgres'::regrole
      OR (p.proconfig @> ARRAY['search_path=public, pg_temp']) IS DISTINCT FROM true
      OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('service_role', p.oid, 'EXECUTE')
      OR (SELECT count(*) FROM pg_catalog.pg_proc AS candidate
          WHERE candidate.pronamespace = 'public'::regnamespace AND candidate.proname = expected.name) <> 1
  ) THEN RAISE EXCEPTION 'DIRECT_ORDER_CREDIT_NOTICE_GRANT_MISMATCH'; END IF;
END;
$postflight$;
