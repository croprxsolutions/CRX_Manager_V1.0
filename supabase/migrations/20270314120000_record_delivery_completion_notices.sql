-- STATUS: local candidate. See its record in docs/reference/migrations.d/.
-- Register an interactive completion for its checked follow-up notice. Cached screens and
-- offline recovery retain their original save and notice paths.
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.delivery_completion_notice_events (
  completion_seq bigint PRIMARY KEY REFERENCES public.delivery_brand_events(seq),
  receipt_id uuid NOT NULL UNIQUE,
  receipt_operation text NOT NULL CHECK (receipt_operation IN ('complete_delivery', 'start_and_complete_delivery')),
  sender_role text NOT NULL,
  show_partial boolean NOT NULL,
  tiny_figures jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz
);

CREATE TABLE public.delivery_completion_notice_claims (
  completion_seq bigint NOT NULL REFERENCES public.delivery_completion_notice_events(completion_seq),
  user_id uuid NOT NULL,
  notice_kind text NOT NULL CHECK (notice_kind IN ('completion', 'remainder', 'commission')),
  PRIMARY KEY (completion_seq, user_id, notice_kind)
);

ALTER TABLE public.delivery_completion_notice_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_completion_notice_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_completion_notice_events_internal_only
  ON public.delivery_completion_notice_events AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
CREATE POLICY delivery_completion_notice_claims_internal_only
  ON public.delivery_completion_notice_claims AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
REVOKE ALL ON public.delivery_completion_notice_events, public.delivery_completion_notice_claims
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Called by an opted-in save after a fresh completion while its delivery row is still locked.
CREATE FUNCTION public._register_delivery_completion_notice(
  p_delivery_id uuid, p_completion_key text, p_operation text, p_quantities jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $register$
BEGIN
  INSERT INTO public.delivery_completion_notice_events
    (completion_seq, receipt_id, receipt_operation, sender_role, show_partial, tiny_figures)
  SELECT e.seq, r.id, r.operation, actor.role, lines.show_partial, lines.tiny_figures
  FROM public.idempotency_keys AS r
  JOIN public.profiles AS actor ON actor.id = r.request_actor_id AND actor.is_active
  CROSS JOIN LATERAL (
    SELECT b.seq, b.actor FROM public.delivery_brand_events AS b
    WHERE b.delivery_id = p_delivery_id AND b.event_type = 'completed' ORDER BY b.seq DESC LIMIT 1
  ) AS e
  CROSS JOIN LATERAL (
    SELECT COALESCE(bool_or(q.figure < di.quantity), false) AS show_partial,
      COALESCE(jsonb_object_agg(di.id::text, q.figure)
        FILTER (WHERE di.quantity_delivered = 0 AND q.figure > 0 AND q.figure < 0.01 AND q.figure <= di.quantity),
        '{}'::jsonb) AS tiny_figures
    FROM public.delivery_items AS di
    CROSS JOIN LATERAL (SELECT (p_quantities ->> di.id::text)::numeric AS figure) AS q
    WHERE di.delivery_id = p_delivery_id
  ) AS lines
  WHERE r.idempotency_key = p_completion_key AND r.operation = p_operation
    AND r.request_actor_id = auth.uid() AND e.actor = auth.uid() AND r.expires_at >= now()
    AND r.result ->> 'delivery_id' = p_delivery_id::text
    AND r.result ->> 'status' IN ('partial', 'completed');
  IF NOT FOUND THEN RAISE WARNING 'Could not register saved delivery completion notice'; END IF;
EXCEPTION WHEN OTHERS OR query_canceled THEN
  RAISE WARNING 'Could not register saved delivery completion notice (SQLSTATE %)', SQLSTATE;
END;
$register$;

REVOKE ALL ON FUNCTION public._register_delivery_completion_notice(uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.notify_saved_delivery_completion(
  p_delivery_id uuid,
  p_completion_key text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $notice$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_denied_pages text[];
  v_delivery public.deliveries%ROWTYPE;
  v_event record;
  v_partial boolean;
  v_customer text;
  v_completed_title text;
  v_completed_message text;
  v_remainder_message text;
  v_commission_message text;
  v_fingerprint text;
  v_replay jsonb;
  v_recipient record;
  v_failed integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NULLIF(btrim(p_idempotency_key), '') IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;

  -- Use the same delivery-then-profile lock order as completion. A concurrent void, reassignment
  -- or role change cannot occur between validating the completion and addressing the notices.
  SELECT * INTO v_delivery FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  SELECT role, denied_pages INTO v_role, v_denied_pages
    FROM public.profiles WHERE id = v_actor AND is_active FOR SHARE;
  IF v_delivery.status IS DISTINCT FROM 'completed' OR v_delivery.deleted_at IS NOT NULL OR v_role IS NULL
    OR NOT (v_role IN ('admin', 'sales_rep') OR
      (v_role = 'driver' AND v_delivery.assigned_driver IS NOT DISTINCT FROM v_actor)) THEN
    RAISE EXCEPTION 'DELIVERY_COMPLETION_NOTICE_NOT_ALLOWED';
  END IF;

  SELECT n.* INTO v_event
  FROM public.delivery_completion_notice_events AS n
  JOIN public.idempotency_keys AS r ON r.id = n.receipt_id AND r.operation = n.receipt_operation
  JOIN public.delivery_brand_events AS b ON b.seq = n.completion_seq AND b.actor = v_actor
  WHERE r.idempotency_key = p_completion_key AND r.request_actor_id = v_actor AND r.expires_at >= now()
    AND n.sender_role = v_role
    AND b.delivery_id = p_delivery_id AND b.event_type = 'completed'
    AND b.seq = (SELECT max(latest.seq) FROM public.delivery_brand_events AS latest
      WHERE latest.delivery_id = p_delivery_id AND latest.event_type = 'completed');
  IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_COMPLETION_NOTICE_RECEIPT_REQUIRED'; END IF;

  v_fingerprint := public._replay_fingerprint_20261015(
    jsonb_build_object('actor_id', v_actor, 'delivery_id', p_delivery_id, 'completion_seq', v_event.completion_seq));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'notify_saved_delivery_completion', v_actor, v_fingerprint);
  IF v_replay -> 'result' ->> 'status' = 'sent' THEN RETURN v_replay -> 'result'; END IF;
  IF v_replay IS NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'notify_saved_delivery_completion', '{"status":"pending"}'::jsonb);
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'notify_saved_delivery_completion', v_fingerprint);
  END IF;

  IF v_event.sent_at IS NOT NULL THEN
    UPDATE public.idempotency_keys SET result = '{"status":"sent"}'::jsonb
      WHERE idempotency_key = p_idempotency_key AND operation = 'notify_saved_delivery_completion';
    RETURN '{"status":"sent"}'::jsonb;
  END IF;

  v_partial := v_event.receipt_operation = 'complete_delivery' AND v_event.show_partial;
  SELECT COALESCE(NULLIF(c.farm_name, ''), 'Unknown') INTO v_customer
    FROM public.customers AS c WHERE c.id = v_delivery.customer_id;
  v_customer := COALESCE(v_customer, 'Unknown');
  v_completed_title := 'Delivery Completed' || CASE WHEN v_partial THEN ' (partial)' ELSE '' END;
  v_completed_message := format('Delivery %s for %s has been completed%s.',
    v_delivery.delivery_number, v_customer, CASE WHEN v_partial THEN ' with partial quantities' ELSE '' END);
  v_commission_message := format('Your customer %s received delivery %s%s.',
    v_customer, v_delivery.delivery_number, CASE WHEN v_partial THEN ' (partial)' ELSE '' END);
  IF v_partial THEN
    SELECT format('Delivery %s (Order %s) had partial quantities: %s',
      v_delivery.delivery_number, v_delivery.order_id, string_agg(
        format('%s: %s/%s', COALESCE(NULLIF(p.product_name, ''), 'Unknown'),
          trim_scale(COALESCE((v_event.tiny_figures ->> di.id::text)::numeric, di.quantity_delivered)),
          trim_scale(di.quantity)), ', ' ORDER BY di.id))
    INTO v_remainder_message
    FROM public.delivery_items AS di LEFT JOIN public.products AS p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
      AND COALESCE((v_event.tiny_figures ->> di.id::text)::numeric, di.quantity_delivered) < di.quantity
    HAVING count(*) > 0;
  END IF;

  FOR v_recipient IN
    WITH admins AS (
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active AND v_role IN ('admin', 'sales_rep')
    ), commission_addresses AS (
      SELECT CASE WHEN c.recipient ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        THEN c.recipient::uuid END AS id
      FROM public.commissions AS c
      WHERE c.order_id = v_delivery.order_id AND c.status <> 'cancelled'
        AND c.recipient IS DISTINCT FROM v_delivery.assigned_driver::text
        AND (v_role = 'admin' OR (v_role = 'sales_rep' AND c.recipient_user_id = v_actor
          AND NOT COALESCE('reports' = ANY(v_denied_pages), false)))
    ), recipients AS (
      SELECT id, 'completion' AS kind FROM admins
      UNION SELECT v_delivery.assigned_driver, 'completion'
        WHERE v_delivery.assigned_driver IS NOT NULL
          AND (v_role IN ('admin', 'sales_rep') OR v_delivery.assigned_driver = v_actor)
      UNION SELECT id, 'remainder' FROM admins WHERE v_remainder_message IS NOT NULL
      UNION SELECT p.id, 'remainder' FROM public.profile_public_view AS p
        WHERE v_remainder_message IS NOT NULL AND p.id = v_delivery.created_by AND p.role <> 'admin'
          AND (v_role IN ('admin', 'sales_rep') OR p.id = v_actor)
      UNION SELECT c.id, 'commission' FROM commission_addresses AS c
        JOIN auth.users AS u ON u.id = c.id
        LEFT JOIN public.profile_public_view AS p ON p.id = c.id
        WHERE p.role IS DISTINCT FROM 'admin'
    )
    SELECT id, kind FROM recipients ORDER BY id, kind
  LOOP
    BEGIN
      INSERT INTO public.delivery_completion_notice_claims (completion_seq, user_id, notice_kind)
      VALUES (v_event.completion_seq, v_recipient.id, v_recipient.kind)
      ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN CONTINUE; END IF;

      INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id, created_by)
      VALUES (v_recipient.id,
        CASE WHEN v_recipient.kind = 'remainder' THEN 'Delivery Completed with Remainders' ELSE v_completed_title END,
        CASE v_recipient.kind WHEN 'remainder' THEN v_remainder_message
          WHEN 'commission' THEN v_commission_message ELSE v_completed_message END,
        CASE WHEN v_recipient.kind = 'remainder' THEN 'delivery_remainder' ELSE 'delivery_completed' END,
        'delivery', p_delivery_id, v_actor);
    EXCEPTION WHEN OTHERS OR query_canceled THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'Could not send a saved delivery completion notice (SQLSTATE %)', SQLSTATE;
    END;
  END LOOP;

  IF v_failed > 0 THEN RETURN jsonb_build_object('status', 'pending', 'failed', v_failed); END IF;
  UPDATE public.delivery_completion_notice_events SET sent_at = clock_timestamp()
    WHERE completion_seq = v_event.completion_seq;
  UPDATE public.idempotency_keys SET result = '{"status":"sent"}'::jsonb
    WHERE idempotency_key = p_idempotency_key AND operation = 'notify_saved_delivery_completion';
  RETURN '{"status":"sent"}'::jsonb;
END;
$notice$;

ALTER FUNCTION public.notify_saved_delivery_completion(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_saved_delivery_completion(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.notify_saved_delivery_completion(uuid, text, text) TO authenticated;


-- The existing proof-of-load arguments and permissions must survive the signature change.
DO $preflight$
BEGIN
  IF current_setting('lock_timeout') <> '5s' THEN RAISE EXCEPTION 'COMPLETION_NOTICE_REQUIRES_TRANSACTION'; END IF;
  IF EXISTS (
    SELECT FROM (VALUES
      ('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint,jsonb)', 'eea893949ab7e39169ea458f7d53e60f'),
      ('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb)', '11bc5cf5f73e4a774ae256aef61ea16e')
    ) AS expected(signature, body_hash)
    LEFT JOIN pg_proc AS p ON p.oid = to_regprocedure(expected.signature)
    WHERE md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM expected.body_hash
      OR p.proowner IS DISTINCT FROM 'postgres'::regrole OR p.prosecdef IS DISTINCT FROM true
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE') IS DISTINCT FROM true
      OR has_function_privilege('anon', p.oid, 'EXECUTE') IS DISTINCT FROM false
  ) OR (SELECT count(*) FROM pg_proc WHERE pronamespace =
    'public'::regnamespace AND proname IN ('complete_delivery','start_and_complete_delivery')) <> 2
  THEN RAISE EXCEPTION 'COMPLETION_NOTICE_WRAPPER_DRIFT'; END IF;
END;
$preflight$;

ALTER FUNCTION public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint,jsonb) RENAME TO _complete_delivery_before_notice_20270314;
REVOKE ALL ON FUNCTION public._complete_delivery_before_notice_20270314(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint,jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_evidence text DEFAULT NULL::text,
  p_evidence_ref text DEFAULT NULL::text,
  p_email_receipt boolean DEFAULT NULL::boolean,
  p_brand_base_seq bigint DEFAULT NULL::bigint,
  p_lines_seen jsonb DEFAULT NULL,
  p_record_completion_notice boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prior text := current_setting('crx.proof_binding', true);
  v_binding jsonb;
  v_result jsonb;
  v_before_status text;
BEGIN
  IF p_record_completion_notice IS TRUE AND auth.uid() IS NOT NULL
     AND (p_performed_by IS NULL OR p_performed_by = auth.uid()) THEN
    SELECT status INTO v_before_status FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  END IF;

  -- Not part of the request fingerprint (like p_brand_base_seq): the same key is the same completion, and a saved
  -- receipt is returned before the check. The binding always names this call's delivery, evidence and reference; a
  -- call with no list carries the outer call's list only for the same three (start_and_complete's nested call).
  v_binding := jsonb_build_object('delivery_id', p_delivery_id, 'evidence', p_evidence, 'evidence_ref', p_evidence_ref);
  IF p_lines_seen IS NOT NULL THEN
    v_binding := v_binding || jsonb_build_object('lines_seen', p_lines_seen);  -- a JSON null is sent, and malformed
  ELSIF NULLIF(v_prior, '')::jsonb - 'lines_seen' = v_binding AND NULLIF(v_prior, '')::jsonb ? 'lines_seen' THEN
    v_binding := v_binding || jsonb_build_object('lines_seen', NULLIF(v_prior, '')::jsonb -> 'lines_seen');
  END IF;
  PERFORM set_config('crx.proof_binding', v_binding::text, true);
  v_result := public._complete_delivery_brands_impl_20270305(p_delivery_id, p_signed_by, p_performed_by, p_quantities,
    p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at, p_evidence, p_evidence_ref, p_email_receipt,
    p_brand_base_seq);
  PERFORM set_config('crx.proof_binding', COALESCE(v_prior, ''), true);
  IF v_before_status = 'in_progress' AND EXISTS (
    SELECT FROM public.deliveries WHERE id = p_delivery_id AND status = 'completed'
  ) THEN
    PERFORM public._register_delivery_completion_notice(p_delivery_id, p_idempotency_key,
      'complete_delivery', p_quantities);
  END IF;
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint,jsonb,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint,jsonb,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint,jsonb,boolean) TO authenticated, service_role;
COMMENT ON FUNCTION public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint,jsonb,boolean) IS
  'Completes a delivery with its saved evidence and proof-of-load figures. p_record_completion_notice optionally registers a fresh interactive save for a checked follow-up alert.';

ALTER FUNCTION public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb) RENAME TO _start_and_complete_delivery_before_notice_20270314;
REVOKE ALL ON FUNCTION public._start_and_complete_delivery_before_notice_20270314(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.start_and_complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_delivered_on date,
  p_performed_by uuid DEFAULT NULL,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_evidence text DEFAULT NULL,
  p_evidence_ref text DEFAULT NULL,
  p_brand_base_seq bigint DEFAULT NULL,
  p_lines_seen jsonb DEFAULT NULL,
  p_record_completion_notice boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prior text := current_setting('crx.proof_binding', true);
  v_result jsonb;
  v_before_status text;
BEGIN
  IF p_record_completion_notice IS TRUE AND auth.uid() IS NOT NULL
     AND (p_performed_by IS NULL OR p_performed_by = auth.uid()) THEN
    SELECT status INTO v_before_status FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  END IF;

  PERFORM set_config('crx.proof_binding', (jsonb_build_object('delivery_id', p_delivery_id, 'evidence', p_evidence,
    'evidence_ref', p_evidence_ref) || CASE WHEN p_lines_seen IS NULL THEN '{}'::jsonb
                                       ELSE jsonb_build_object('lines_seen', p_lines_seen) END)::text, true);
  v_result := public._start_and_complete_delivery_brands_impl_20270305(p_delivery_id, p_signed_by, p_delivered_on,
    p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_evidence, p_evidence_ref,
    p_brand_base_seq);
  PERFORM set_config('crx.proof_binding', COALESCE(v_prior, ''), true);
  IF v_before_status IN ('scheduled', 'in_progress') AND EXISTS (
    SELECT FROM public.deliveries WHERE id = p_delivery_id AND status = 'completed'
  ) THEN
    PERFORM public._register_delivery_completion_notice(p_delivery_id, p_idempotency_key,
      'start_and_complete_delivery', p_quantities);
  END IF;
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb,boolean) TO authenticated;
COMMENT ON FUNCTION public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint,jsonb,boolean) IS
  'Starts and completes a delivery with its saved evidence and proof-of-load figures. p_record_completion_notice optionally registers the fresh list save for a checked follow-up alert.';

DO $postflight$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.delivery_completion_notice_events', 'public.delivery_completion_notice_claims'] LOOP
    IF NOT EXISTS (SELECT FROM pg_class WHERE oid = to_regclass(v_table) AND relrowsecurity)
      OR has_table_privilege('authenticated', v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      OR has_table_privilege('anon', v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      OR has_table_privilege('service_role', v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    THEN RAISE EXCEPTION 'COMPLETION_NOTICE_STORAGE_GRANT_DRIFT'; END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.notify_saved_delivery_completion(uuid,text,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.notify_saved_delivery_completion(uuid,text,text)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.notify_saved_delivery_completion(uuid,text,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._register_delivery_completion_notice(uuid,text,text,jsonb)', 'EXECUTE')
    OR has_function_privilege('anon', 'public._register_delivery_completion_notice(uuid,text,text,jsonb)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public._register_delivery_completion_notice(uuid,text,text,jsonb)', 'EXECUTE')
  THEN RAISE EXCEPTION 'COMPLETION_NOTICE_FUNCTION_GRANT_DRIFT'; END IF;
END;
$postflight$;
