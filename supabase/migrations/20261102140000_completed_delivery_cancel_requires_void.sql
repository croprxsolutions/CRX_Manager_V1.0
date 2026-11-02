-- Written 2026-11-02. Apply status is tracked only in docs/reference/migration-history.md.
--
-- WHAT: a delivery that is already completed can no longer be cancelled. Undoing a completed
--   delivery goes only through the admin-only void_delivery, which carries the closed-month warning
--   and the audit trail. Two private bodies change, nothing else:
--     - _cancel_delivery_replay_impl_20261015 (behind the public cancel_delivery wrapper and the
--       batch cancel): after the delivery row is locked, a completed delivery is refused with
--       DELIVERY_COMPLETED_USE_VOID. Before, it accepted 'completed' and put the stock back. Its
--       stock-restore branch still reads ('completed', 'in_progress'); only in_progress reaches it now.
--     - _batch_cancel_deliveries_replay_impl_20261015: each delivery's status is re-read under the
--       same row lock the cancel takes next, and anything not scheduled or in_progress is skipped and
--       not counted. A delivery that completed after the list screen selected it is skipped, so one
--       stale row never fails the whole batch. Rows already past cancelling when the batch reads its
--       list are still skipped without a lock, as before.
--   The cancel body's forged-actor refusal also gains the canonical ACTOR_MISMATCH token ahead of
--   its old words (the public wrapper already refuses a forged actor first; batch passes auth.uid()).
--   Scheduled and in-progress cancellation, the quick-delivery order cleanup, the idempotency checks
--   and the replay of stored successful results run exactly as before: a stored result is returned
--   before the delivery is read. Signatures, owners, security settings and grants are unchanged
--   (CREATE OR REPLACE keeps both functions postgres-only). No data changes. A live read-only check
--   on 2026-11-02 found no completed delivery was ever cancelled.
-- caller-analysis: _cancel_delivery_replay_impl_20261015 :: called only by the cancel_delivery wrapper and _batch_cancel_deliveries_replay_impl_20261015; same signature and result shape, a new refusal for completed
-- caller-analysis: _batch_cancel_deliveries_replay_impl_20261015 :: called only by the batch_cancel_deliveries wrapper; same signature, returns the count of deliveries actually cancelled
-- ROLLBACK: a new forward migration restoring the two pinned bodies from
--   20260827041300_align_return_credit_delivery_surfaces.sql (cancel) and
--   20261019235000_bind_delivery_order_void_replay_receipts_batch3b.sql (batch), with a preflight
--   pinning this migration's bodies. Grants carry over and no data changes.
-- ============================================================================

-- The postflight can only undo the two bodies when the whole file runs as one transaction.
CREATE TEMP TABLE completed_delivery_cancel_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- Both bodies must still be exactly the reviewed ones they are rebuilt from.
DO $preflight$
DECLARE
  v_fn record;
BEGIN
  IF (SELECT transaction_id FROM pg_temp.completed_delivery_cancel_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'COMPLETED_DELIVERY_CANCEL_NOT_IN_TRANSACTION';
  END IF;
  FOR v_fn IN
    SELECT x.sig, x.body_md5, p.*
      FROM (VALUES
        ('public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', '8528b344f86c7e1aa735e386ea39f2eb'),
        ('public._batch_cancel_deliveries_replay_impl_20261015(uuid[],text,uuid,text)', '4ff0fe326dce33d3e0950f3bec43a9ac')
      ) AS x(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig)
  LOOP
    IF v_fn.oid IS NULL
       OR md5(replace(v_fn.prosrc, chr(13), '')) <> v_fn.body_md5
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres'
       OR v_fn.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
       OR NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % drifted from its reviewed body or contract; re-review before applying', v_fn.sig;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('_cancel_delivery_replay_impl_20261015', '_batch_cancel_deliveries_replay_impl_20261015')) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: an unexpected overload of a cancel body exists';
  END IF;
END;
$preflight$;

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

CREATE OR REPLACE FUNCTION public._batch_cancel_deliveries_replay_impl_20261015(p_delivery_ids uuid[], p_cancel_reason text DEFAULT 'Batch cancelled'::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_del record;
  v_count integer := 0;
  v_actor uuid;
  v_result jsonb;
  v_existing jsonb;
  v_status text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  PERFORM check_rate_limit(v_actor, 'batch_cancel_deliveries', 3, 60);
  IF array_length(p_delivery_ids, 1) IS NULL THEN RAISE EXCEPTION 'No delivery IDs provided'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_cancel_deliveries');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'count')::integer; END IF;
  END IF;

  FOR v_del IN SELECT id, status FROM deliveries WHERE id = ANY(p_delivery_ids) ORDER BY id
  LOOP
    -- A completed delivery is never cancelled (void it instead). Rows already past cancelling are skipped
    -- unlocked, as before; the rest are re-read under the row lock the cancel takes next, so one completed
    -- or cancelled since the list was loaded is skipped too.
    IF v_del.status NOT IN ('scheduled', 'in_progress') THEN CONTINUE; END IF;
    SELECT status INTO v_status FROM deliveries WHERE id = v_del.id FOR UPDATE;
    IF v_status IS NULL OR v_status NOT IN ('scheduled', 'in_progress') THEN CONTINUE; END IF;
    v_result := _cancel_delivery_replay_impl_20261015(p_delivery_id := v_del.id, p_cancel_reason := p_cancel_reason, p_performed_by := v_actor);
    IF (v_result->>'success')::boolean THEN v_count := v_count + 1; END IF;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_cancel_deliveries', jsonb_build_object('count', v_count));
  END IF;

  RETURN v_count;
END;
$function$;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  FOR v_fn IN
    SELECT x.sig, x.body_md5, p.*
      FROM (VALUES
        ('public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', '217e5a57fae88af4ba8c84e20739ae3a'),
        ('public._batch_cancel_deliveries_replay_impl_20261015(uuid[],text,uuid,text)', 'b9882f660eb73d40a432f3aef1279e51')
      ) AS x(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig)
  LOOP
    IF v_fn.oid IS NULL
       OR md5(replace(v_fn.prosrc, chr(13), '')) <> v_fn.body_md5
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres'
       OR v_fn.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
       OR NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % did not land as reviewed', v_fn.sig;
    END IF;
  END LOOP;
END;
$postflight$;
