-- Keep the deployed damage notice call, but use the signed-in receiver's saved receipt for the notice.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF current_setting('lock_timeout') <> '5s' THEN RAISE EXCEPTION 'RECEIVING_DAMAGE_TRANSACTION_REQUIRED'; END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
      WHERE oid = to_regprocedure('public.notify_damaged_receiving(text,text,uuid,text)'))
      IS DISTINCT FROM '3443ad277f0487210170fdb47436f10c'
  THEN RAISE EXCEPTION 'RECEIVING_DAMAGE_SOURCE_DRIFT'; END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.notify_damaged_receiving(
  p_po_number text,
  p_items_summary text,
  p_po_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_service boolean := auth.uid() IS NULL AND (current_setting('role', true) = 'service_role' OR session_user = 'service_role');
  v_fingerprint text;
  v_replay jsonb;
  v_digest text;
  v_receipt record;
  v_order_id uuid := p_po_id;
  v_order_number text := p_po_number;
  v_summary text := p_items_summary;
BEGIN
  IF v_service THEN
    v_actor := '00000000-0000-0000-0000-000000000000'::uuid;
  ELSIF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  ELSIF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: notify_damaged_receiving requires p_idempotency_key';
  END IF;

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'po_number', p_po_number, 'items_summary', p_items_summary, 'po_id', p_po_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'notify_damaged_receiving', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN;
  END IF;

  IF NOT v_service THEN
    v_digest := split_part(p_idempotency_key, ':', 3);
    IF v_digest !~ '^[0-9a-f]{64}$'
      OR p_idempotency_key IS DISTINCT FROM 'damaged-receiving:' || p_po_id::text || ':' || v_digest
    THEN RAISE EXCEPTION 'RECEIVING_DAMAGE_RECEIPT_REQUIRED'; END IF;

    BEGIN
      SELECT k.id, k.result -> 'receiving_record_ids' AS ids, d.ids_hash, d.key_hash
      INTO STRICT v_receipt
      FROM public.idempotency_keys k
      CROSS JOIN LATERAL (
        SELECT encode(extensions.digest(convert_to(array_to_json(array_agg(id ORDER BY id COLLATE "C"))::text, 'UTF8'), 'sha256'), 'hex') AS ids_hash,
          encode(extensions.digest(convert_to(array_to_json(ARRAY[k.idempotency_key])::text, 'UTF8'), 'sha256'), 'hex') AS key_hash
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(k.result -> 'receiving_record_ids') = 'array'
          THEN k.result -> 'receiving_record_ids' ELSE '[]'::jsonb END) AS rows(id)
      ) d
      WHERE k.operation = 'receive_po_items' AND k.request_actor_id = v_actor
        AND k.expires_at >= now() AND k.result ->> 'status' = 'received' AND d.ids_hash IS NOT NULL
        AND v_digest IN (d.ids_hash, d.key_hash);
    EXCEPTION WHEN no_data_found OR too_many_rows THEN
      RAISE EXCEPTION 'RECEIVING_DAMAGE_RECEIPT_REQUIRED';
    END;

    -- A Quick Receive batch can use either legacy reference and can span multiple orders.
    PERFORM pg_advisory_xact_lock(hashtextextended('crx:receiving-damage:' || v_receipt.id::text, 0));
    IF EXISTS (
      SELECT FROM public.idempotency_keys k
      WHERE k.operation = 'notify_damaged_receiving' AND k.request_actor_id = v_actor
        AND k.expires_at >= now() AND split_part(k.idempotency_key, ':', 1) = 'damaged-receiving'
        AND split_part(k.idempotency_key, ':', 3) IN (v_receipt.ids_hash, v_receipt.key_hash)
    ) THEN RETURN; END IF;

    SELECT (array_agg(po.id ORDER BY saved.position))[1],
      (array_agg(po.po_number ORDER BY saved.position))[1],
      string_agg(format('%s — %s (%s — %s)', po.po_number, COALESCE(p.product_name, 'Unknown'),
        trim_scale(r.quantity_received), r.condition), ', ' ORDER BY saved.position)
    INTO v_order_id, v_order_number, v_summary
    FROM jsonb_array_elements_text(v_receipt.ids) WITH ORDINALITY AS saved(id, position)
    JOIN public.receiving_records r ON r.id = saved.id::uuid
    JOIN public.purchase_orders po ON po.id = r.purchase_order_id
    LEFT JOIN public.products p ON p.id = r.product_id
    WHERE r.received_by = v_actor AND r.condition <> 'good';
    IF v_order_id IS NULL THEN RETURN; END IF;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
  SELECT id, 'Damaged Items Received on ' || v_order_number,
    'Items received in non-good condition on ' || v_order_number || ': ' || v_summary,
    'po_damaged_received', 'purchase_order', v_order_id
  FROM public.profiles WHERE role = 'admin' AND is_active;

  PERFORM public.save_idempotency(p_idempotency_key, 'notify_damaged_receiving', '{}'::jsonb);
  UPDATE public.idempotency_keys SET request_fingerprint = v_fingerprint, request_actor_id = v_actor
  WHERE idempotency_key = p_idempotency_key AND operation = 'notify_damaged_receiving';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
END
$function$;

CREATE POLICY notifications_damage_workflow_only ON public.notifications AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK (notification_type IS DISTINCT FROM 'po_damaged_received');

REVOKE UPDATE ON TABLE public.notifications FROM authenticated;
GRANT UPDATE (is_read) ON TABLE public.notifications TO authenticated;

DO $postflight$
BEGIN
  IF has_function_privilege('anon', 'public.notify_damaged_receiving(text,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.notify_damaged_receiving(text,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.notify_damaged_receiving(text,text,uuid,text)', 'EXECUTE')
     OR NOT has_column_privilege('authenticated', 'public.notifications', 'is_read', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.notifications', 'notification_type', 'UPDATE')
  THEN RAISE EXCEPTION 'RECEIVING_DAMAGE_GRANT_DRIFT'; END IF;
END
$postflight$;
