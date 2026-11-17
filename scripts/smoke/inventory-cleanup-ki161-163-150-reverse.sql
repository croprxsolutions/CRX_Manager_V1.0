-- Rollback for 20270122100000_inventory_cleanup_ki161_163_150.sql (run as one transaction; proven by
-- scripts/smoke/prove-inventory-cleanup-real-schema.mjs). The cycle-count columns stay numeric(14,4): the old
-- update_cycle_count_item rounds to 2 places, which fits, and narrowing could round stored counts.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER a2_delivery_line_matches_order_line ON public.delivery_items;
DROP FUNCTION public._delivery_line_matches_order_line();
DROP INDEX public.delivery_items_one_line_per_order_line;
DROP TRIGGER a2_delivery_order_keeps_lines ON public.deliveries;
DROP FUNCTION public._delivery_order_keeps_lines();
GRANT INSERT, UPDATE, DELETE ON public.delivery_items TO authenticated;

DROP FUNCTION public._complete_delivery_authorized_impl(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone);
ALTER FUNCTION public._complete_delivery_authorized_impl_20270122(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone)
  RENAME TO _complete_delivery_authorized_impl;
REVOKE ALL ON FUNCTION public._complete_delivery_authorized_impl(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone)
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER trg_zz_lock_job_stock_rows ON public.jobs;
DROP FUNCTION public._lock_job_stock_rows_in_order();

CREATE OR REPLACE FUNCTION public._cancel_delivery_replay_impl_20261015(p_delivery_id uuid, p_cancel_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delivery record; v_actor uuid; v_item record; v_items_restored integer := 0;
  v_prebooked_reincremented integer := 0; v_invoice record; v_draft_cancelled integer := 0;
  v_posted_notified integer := 0; v_admin record; v_order_has_remaining boolean; v_order_status text;
  v_result jsonb;
  v_quick_scheduled_exclusive boolean := false; v_prebooked_released integer := 0;
  v_qd_item record; v_release_qty numeric; v_actor_role text; v_paid_commissions integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND auth.uid() IS DISTINCT FROM p_performed_by THEN RAISE EXCEPTION 'ACTOR_MISMATCH: actor mismatch'; END IF;
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_cached jsonb;
    BEGIN v_cached := check_idempotency(p_idempotency_key, 'cancel_delivery'); IF v_cached IS NOT NULL THEN RETURN v_cached; END IF; END;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'Not authorized to cancel deliveries'; END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  -- A completed delivery is undone only by the admin-only void_delivery (closed-month warning, audit trail).
  IF v_delivery.status = 'completed' THEN RAISE EXCEPTION 'DELIVERY_COMPLETED_USE_VOID: a completed delivery cannot be cancelled; an admin must void it instead'; END IF;
  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN RAISE EXCEPTION 'Cannot cancel a % delivery', v_delivery.status; END IF;

  -- Match void_delivery's fail-fast delivery -> order serialization. Never
  -- wait for create_return/receive_return's order lock while this delivery is
  -- locked, because receive_return later locks the source delivery.
  IF v_delivery.order_id IS NOT NULL THEN
    BEGIN
      PERFORM 1
      FROM orders
      WHERE id = v_delivery.order_id
      FOR UPDATE NOWAIT;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
      END IF;
    EXCEPTION
      WHEN lock_not_available THEN
        RAISE EXCEPTION 'DELIVERY_ORDER_BUSY_RETRY';
    END;
  END IF;

  -- Match void_delivery's fail-closed active-return lineage boundary. This
  -- also prevents the quick-delivery branch from directly cancelling an order
  -- whose merchandise is reserved by, or already restored through, a return.
  IF v_delivery.order_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM returns r
    JOIN return_items ri ON ri.return_id = r.id
    WHERE r.order_id = v_delivery.order_id
      AND r.deleted_at IS NULL
      AND r.status IN ('requested', 'approved', 'received', 'credited')
      AND (
        ri.order_item_id IS NULL
        OR EXISTS (
          SELECT 1 FROM delivery_items linked_di
          WHERE linked_di.delivery_id = p_delivery_id
            AND linked_di.order_item_id = ri.order_item_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'DELIVERY_HAS_RECEIVED_RETURN';
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  IF v_delivery.status IN ('completed', 'in_progress') THEN
    FOR v_item IN SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
        UPDATE inventory SET quantity_available = quantity_available + v_item.quantity_delivered, quantity_prebooked = quantity_prebooked + v_item.quantity_delivered, updated_at = now() WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
        INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
        VALUES (v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name);
        UPDATE order_items SET quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0), quantity_remaining = quantity_remaining + v_item.quantity_delivered WHERE id = v_item.order_item_id;
        v_items_restored := v_items_restored + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- Codex P2 (20260616171449): lock the order row so a concurrent update_order_items
    -- (which holds orders FOR UPDATE) cannot add/increase prebook in the window between
    -- the release loop and the order cancel. cancel_order locks the order the same way.
    SELECT status INTO v_order_status FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

    IF COALESCE(v_delivery.is_quick_delivery, false) AND v_delivery.status IN ('scheduled', 'in_progress') THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM deliveries
        WHERE order_id = v_delivery.order_id AND id <> p_delivery_id
          AND status NOT IN ('cancelled', 'voided')
      ) INTO v_quick_scheduled_exclusive;
    END IF;

    IF v_order_status IS NOT NULL AND v_order_status NOT IN ('cancelled', 'voided') THEN
      IF v_quick_scheduled_exclusive THEN
        -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): this branch
        -- auto-cancels the order and zeroes its pending commissions. A pending commission
        -- already committed to a non-voided commission_payments batch must not be silently
        -- cancelled — post_commission_payment would later resurrect it to 'paid'. Force the
        -- admin to void the payout first.
        IF EXISTS (
          SELECT 1
          FROM commissions cm
          JOIN commission_payment_items cpi ON cpi.commission_id = cm.id
          JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
          WHERE cm.order_id = v_delivery.order_id
            AND cm.status = 'pending'
            AND cp.status <> 'voided'
        ) THEN
          RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS: the order auto-cancelled by this quick delivery has pending commission(s) committed to an active commission payment batch. Void that payment first.';
        END IF;
        -- P2-1: release by ORDER_ITEMS (the booking source of truth) so edited/added quantities prebooked via
        -- update_order_items (which never touches delivery_items) are released too. Mirrors cancel_order.
        FOR v_qd_item IN SELECT product_id, total_units_needed, COALESCE(quantity_delivered, 0) AS quantity_delivered FROM order_items WHERE order_id = v_delivery.order_id
        LOOP
          v_release_qty := GREATEST(v_qd_item.total_units_needed - v_qd_item.quantity_delivered, 0);
          IF v_release_qty <= 0 THEN CONTINUE; END IF;
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_release_qty, 0), updated_at = now() WHERE product_id = v_qd_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
          VALUES (v_qd_item.product_id, 'released', v_release_qty, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Released ' || v_release_qty || ' units — quick delivery ' || v_delivery.delivery_number || ' cancelled');
          v_prebooked_released := v_prebooked_released + 1;
        END LOOP;

        UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = v_delivery.order_id;
        UPDATE commissions SET status = 'cancelled', commission_amount = 0 WHERE order_id = v_delivery.order_id AND status = 'pending';

        -- P2-2: a quick order may have already-paid commissions — flag for admin review (mirror cancel_order).
        SELECT COUNT(*) INTO v_paid_commissions FROM commissions WHERE order_id = v_delivery.order_id AND status = 'paid';
        IF v_paid_commissions > 0 THEN
          FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
            INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
            VALUES (v_admin.id, 'Cancelled Order Has Paid Commissions',
              'Quick-delivery order auto-cancelled with delivery ' || v_delivery.delivery_number || ' has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
              'cancellation_review', 'order', v_delivery.order_id);
          END LOOP;
        END IF;

        SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
        INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
        VALUES ('order_cancelled', 'order', v_delivery.order_id, COALESCE(v_actor_role, 'sales_rep'),
          jsonb_build_object('status', v_order_status),
          jsonb_build_object('status', 'cancelled', 'reason', 'Quick delivery ' || v_delivery.delivery_number || ' cancelled', 'prebook_lines_released', v_prebooked_released, 'paid_commissions_flagged', v_paid_commissions),
          0,
          'Auto-cancelled quick-delivery order on cancellation of delivery ' || v_delivery.delivery_number);
      ELSE
        SELECT EXISTS (SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0) INTO v_order_has_remaining;
        IF v_order_has_remaining THEN
          IF EXISTS (SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_delivered > 0) THEN
            UPDATE orders SET status = 'partially_fulfilled', updated_at = now() WHERE id = v_delivery.order_id;
          ELSE
            UPDATE orders SET status = 'confirmed', updated_at = now() WHERE id = v_delivery.order_id;
          END IF;
        END IF;
      END IF;
    END IF;
    UPDATE delivery_remainders SET status = 'cancelled', updated_at = now() WHERE original_delivery_id = p_delivery_id AND status = 'pending' AND followup_delivery_id IS NULL;
    UPDATE delivery_remainders SET status = 'fulfilled', updated_at = now() WHERE original_delivery_id = p_delivery_id AND status IN ('pending', 'scheduled') AND followup_delivery_id IS NOT NULL;
  END IF;

  UPDATE deliveries SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, cancel_reason = p_cancel_reason, updated_at = now() WHERE id = p_delivery_id;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 (Codex P1): scope the invoice reversal to THIS delivery's own invoice or an
    -- order-level one (delivery_id IS NULL) — NEVER a sibling delivery's invoice. Was
    -- an unscoped per-order loop, which with per-delivery invoices would auto-cancel a
    -- sibling's draft/unposted invoice and raise a false posted-invoice review alert.
    FOR v_invoice IN SELECT * FROM invoices WHERE order_id = v_delivery.order_id AND status IN ('draft', 'posted', 'unposted') AND invoice_type <> 'credit_memo' AND deleted_at IS NULL AND (delivery_id = p_delivery_id OR delivery_id IS NULL)
    LOOP
      IF v_invoice.status IN ('draft', 'unposted') THEN
        UPDATE invoices SET status = 'cancelled', voided_by = v_actor, void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' cancelled', updated_at = now() WHERE id = v_invoice.id;
        v_draft_cancelled := v_draft_cancelled + 1;
      ELSIF v_invoice.status = 'posted' THEN
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id) VALUES (v_admin.id, 'Posted Invoice Needs Review', 'Delivery ' || v_delivery.delivery_number || ' cancelled but invoice ' || v_invoice.invoice_number || ' is posted.', 'invoice_review', 'invoice', v_invoice.id);
        END LOOP;
        v_posted_notified := v_posted_notified + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id) VALUES (v_delivery.assigned_driver, 'Delivery Cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason, 'delivery_update', 'delivery', p_delivery_id);
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason || CASE WHEN v_items_restored > 0 THEN '. Restored ' || v_items_restored || ' items.' ELSE '' END, v_actor, 'delivery', p_delivery_id, v_delivery.customer_id);

  PERFORM set_config('app.admin_override', 'false', true);

  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id, 'items_restored', v_items_restored, 'prebooked_reincremented', v_prebooked_reincremented, 'prebooked_released', v_prebooked_released, 'paid_commissions_flagged', v_paid_commissions, 'draft_invoices_cancelled', v_draft_cancelled, 'posted_invoices_flagged', v_posted_notified);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_cycle_count_item(
  p_item_id uuid,
  p_counted_qty numeric DEFAULT NULL::numeric,
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
  v_actor         uuid := auth.uid();
  v_replay        jsonb;
  v_fingerprint   text;
  v_item          public.cycle_count_items%ROWTYPE;
  v_count         public.cycle_counts%ROWTYPE;
  v_expected      numeric;
  v_on_hand       numeric;
  v_variance      numeric;
  v_variance_pct  numeric;
  v_item_revision bigint;
  v_result        jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_cycle_count_item requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'item_id', p_item_id,
    'counted_qty', p_counted_qty,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'update_cycle_count_item', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_item
    FROM public.cycle_count_items
   WHERE id = p_item_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_ITEM_NOT_FOUND'; END IF;

  SELECT * INTO v_count
    FROM public.cycle_counts
   WHERE id = v_item.cycle_count_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  IF v_count.status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'CYCLE_COUNT_NOT_IN_PROGRESS';
  END IF;

  v_expected := v_item.expected_qty;
  IF p_counted_qty IS NOT NULL THEN
    -- KI-134: compare the count with what the app holds NOW, not at count creation, so stock that moved in between
    -- is not applied twice when Complete adds the variance to current on-hand.
    IF v_item.inventory_id IS NOT NULL THEN
      SELECT i.quantity_available INTO v_on_hand
        FROM public.inventory i
       WHERE i.id = v_item.inventory_id
         FOR SHARE;
      IF FOUND THEN
        -- Two places, like the stored columns, so the saved row, the result and Complete agree.
        v_expected := round(COALESCE(v_on_hand, 0), 2);
      END IF;
    END IF;
    v_variance := round(p_counted_qty, 2) - v_expected;
    IF v_expected <> 0 THEN
      -- abs(): a negative on hand must not flip the percentage's sign (Taha, PR #1775).
      v_variance_pct := round((v_variance / abs(v_expected)) * 100, 2);
      -- variance_pct is numeric(8,2): a tiny on-hand must not make the count unsavable.
      IF abs(v_variance_pct) >= 1000000 THEN v_variance_pct := NULL; END IF;
    END IF;
  END IF;

  UPDATE public.cycle_count_items
     SET expected_qty = v_expected,
         counted_qty = p_counted_qty,
         variance = v_variance,
         variance_pct = v_variance_pct,
         is_counted = (p_counted_qty IS NOT NULL),
         counted_by = CASE WHEN p_counted_qty IS NOT NULL THEN v_actor ELSE NULL END,
         counted_at = CASE WHEN p_counted_qty IS NOT NULL THEN now() ELSE NULL END,
         notes = COALESCE(p_notes, notes)
   WHERE id = p_item_id;

  SELECT item_revision INTO v_item_revision
    FROM public.cycle_counts
   WHERE id = v_item.cycle_count_id;

  v_result := jsonb_build_object(
    'item_id', p_item_id,
    'counted_qty', round(p_counted_qty, 2),
    'expected_qty', v_expected,
    'variance', v_variance,
    'variance_pct', v_variance_pct,
    'is_counted', (p_counted_qty IS NOT NULL),
    'item_revision', v_item_revision
  );
  PERFORM public.save_idempotency(p_idempotency_key, 'update_cycle_count_item', v_result);
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor,
         request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'update_cycle_count_item';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_cycle_count_item(uuid, numeric, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_cycle_count_item(uuid, numeric, text, uuid, text) TO authenticated, service_role;

DO $reverse_check$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)'::regprocedure) <> '217e5a57fae88af4ba8c84e20739ae3a'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)'::regprocedure) <> 'de13689d6e97dbfb679d27cac45f1bf7'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'::regprocedure) <> '70170ea464444edcf495329ff2b158d7' THEN
    RAISE EXCEPTION 'INV_CLEANUP_REVERSE: a body did not return to its reviewed version';
  END IF;
END;
$reverse_check$;
