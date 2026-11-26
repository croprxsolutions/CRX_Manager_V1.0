-- Add an opt-in receipt operation for PO Detail. Build excess notices from saved rows.
-- Existing receipt callers, damage notices and the browser notification policy are unchanged.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF current_setting('lock_timeout') <> '5s' THEN RAISE EXCEPTION 'RECEIVING_NOTICE_TRANSACTION_REQUIRED'; END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
      WHERE oid = to_regprocedure('public.receive_po_items(jsonb,uuid,text,boolean)'))
      IS DISTINCT FROM 'c2870442e8477ddfd41b2a0cef51752e'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
      WHERE oid = to_regprocedure('public._section9_receive_po_items_serialized(jsonb,uuid,text,boolean)'))
      IS DISTINCT FROM 'b9ac64cb9facffd8e3661e51081b9a18'
  THEN RAISE EXCEPTION 'RECEIVING_NOTICE_SOURCE_DRIFT'; END IF;
END
$preflight$;

CREATE FUNCTION public.receive_po_items_with_excess_notice(
  p_items jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  v_notice record;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by does not match authenticated user';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023'; END IF;

  -- Share the persisted receive intent across old and new apps.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'items', p_items, 'allow_over_receive', COALESCE(p_allow_over_receive, false)));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'receive_po_items', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public.receive_po_items(p_items, p_performed_by, p_idempotency_key, p_allow_over_receive);
  IF p_allow_over_receive IS DISTINCT FROM true THEN RETURN v_result; END IF;

  -- The receive operation still holds the PO locks. Subtract only the later rows
  -- for this purchase-order line so repeated lines use their own running totals.
  FOR v_notice IN
    WITH saved_rows AS (
      SELECT r.purchase_order_id, po.po_number, q.position, r.quantity_received,
        line.quantity_ordered, COALESCE(p.product_name, 'Unknown') AS product_name,
        line.quantity_received - COALESCE(sum(r.quantity_received) OVER (
          PARTITION BY line.id ORDER BY q.position ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING), 0) AS total_after_row
      FROM jsonb_array_elements_text(v_result -> 'receiving_record_ids') WITH ORDINALITY AS q(id, position)
      JOIN public.receiving_records r ON r.id = q.id::uuid
      JOIN public.purchase_order_items line ON line.id = r.po_item_id
      JOIN public.purchase_orders po ON po.id = r.purchase_order_id
      LEFT JOIN public.products p ON p.id = r.product_id
    )
    SELECT purchase_order_id, po_number,
      string_agg(format('%s (previously received %s, received %s, ordered %s)',
        product_name, total_after_row - quantity_received, quantity_received, quantity_ordered), ', ' ORDER BY position) AS summary
    FROM saved_rows WHERE total_after_row > quantity_ordered
    GROUP BY purchase_order_id, po_number
  LOOP
    BEGIN
      INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id, created_by)
      SELECT id, 'Over-Receive Alert', format('PO %s has items received beyond ordered quantity: %s', v_notice.po_number, v_notice.summary),
        'over_receive', 'purchase_order', v_notice.purchase_order_id, v_actor
      FROM public.profiles WHERE role = 'admin' AND is_active;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.failed_notifications (notification_type, entity_type, entity_id, payload, error_message)
        VALUES ('over_receive', 'purchase_order', v_notice.purchase_order_id,
          jsonb_build_object('po_number', v_notice.po_number, 'sender', v_actor, 'summary', v_notice.summary), SQLERRM);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Could not record a failed excess receipt notice for %: %', v_notice.purchase_order_id, SQLERRM;
      END;
    END;
  END LOOP;
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.receive_po_items_with_excess_notice(jsonb,uuid,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_po_items_with_excess_notice(jsonb,uuid,text,boolean)
  TO authenticated;
