-- KI-188 (#2179), Lane C of the 2026-11-22 bug sprint. Contract: docs/plans/2026-11-22-followup-remainders-CONTRACT.md.
--
-- Cancelling a follow-up delivery left the remainder rows scheduled on it 'scheduled', and voiding one left the rows
-- it fulfilled 'fulfilled', so product the order still owes dropped off the Delivery Remainders queue. Now:
--   * cancel puts the rows scheduled on the delivery back to 'pending' with the link cleared and the same quantity,
--     the exact inverse of create_followup_delivery ('cancelled', link kept, when the order or original is closed);
--   * void does the same for the rows the delivery fulfilled (its delivered quantity was just given back);
--   * both refuse with FOLLOWUP_STILL_OPEN while any later delivery in this one's follow-up chain is still live
--     (Mason 2026-11-22: undo newest first; voiding first used to delete the rows that delivery carried and lose them).
-- Both bodies are otherwise byte for byte unchanged (plus one declared variable). No table, column, status value, function or grant changes.
-- Rows already stuck are not rewritten; the postflight prints LEGACY_STUCK_REMAINDERS: n for the apply record.
--
-- idempotency-body-check: exempt -- no public RPC changes; cancel_delivery and void_delivery keep their signatures and
--   idempotency handling (byte for byte in the re-emitted bodies).
-- caller-analysis: _cancel_delivery_replay_impl_20261015 / _void_delivery_replay_impl_20261015 :: same name, signature,
--   result and grants; callers cancel_delivery / void_delivery (and fix_delivery through void) unchanged.
-- F05 (quote-to-cash remediation, separate PR) adds triggers on delivery_items/order_items: this file adds none, but
--   both bodies already update order_items when called, so F05's triggers fire inside cancel and void as before.
--
-- ROLLBACK: scripts/smoke/followup-remainders-reopen-reverse.sql (proven by
--   scripts/smoke/prove-followup-remainders-real-schema.mjs).

CREATE TEMP TABLE followup_remainders_2179_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.followup_remainders_2179_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.followup_remainders_2179_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)'))
     IS DISTINCT FROM 'da607864b6989e67b16c369a9983c6fe' THEN
    RAISE EXCEPTION 'FOLLOWUP_REMAINDERS_BASELINE_DRIFT: cancel body is not the one this file replaces (already applied?)';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)'))
     IS DISTINCT FROM '54809f64a1f7361a495e368585cd501a' THEN
    RAISE EXCEPTION 'FOLLOWUP_REMAINDERS_BASELINE_DRIFT: void body is not the one this file replaces (already applied?)';
  END IF;
  IF has_function_privilege('anon', 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FOLLOWUP_REMAINDERS_BASELINE_DRIFT: an API role can run cancel or void now; this file would revoke that';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------- cancel: rows scheduled on it reopen
CREATE OR REPLACE FUNCTION public._cancel_delivery_replay_impl_20261015(p_delivery_id uuid, p_cancel_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_newer_followups text;
  v_delivery record; v_actor uuid; v_item record; v_items_restored integer := 0;
  v_prebooked_reincremented integer := 0; v_invoice record; v_draft_cancelled integer := 0;
  v_posted_notified integer := 0; v_admin record; v_order_has_remaining boolean; v_order_status text;
  v_result jsonb;
  v_quick_scheduled_exclusive boolean := false; v_prebooked_released integer := 0;
  v_qd_item record; v_release_qty numeric; v_actor_role text; v_paid_commissions integer := 0;
  v_prebooked_before numeric;
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

  -- KI-188 (Mason 2026-11-22: newest first): a later delivery in this one's follow-up chain is still live. Undoing
  -- this one first would lose the short items that delivery carries, so staff cancel or void it first.
  v_newer_followups := (WITH RECURSIVE chain(id) AS (
          SELECT dr.followup_delivery_id FROM delivery_remainders dr
           WHERE dr.original_delivery_id = p_delivery_id AND dr.followup_delivery_id IS NOT NULL
          UNION
          SELECT dr.followup_delivery_id FROM chain c JOIN delivery_remainders dr ON dr.original_delivery_id = c.id
           WHERE dr.followup_delivery_id IS NOT NULL)
        SELECT string_agg(DISTINCT coalesce(nullif(btrim(g.delivery_number), ''), g.id::text), ', ')
          FROM chain c JOIN deliveries g ON g.id = c.id
         WHERE g.id <> p_delivery_id AND g.status NOT IN ('cancelled', 'voided'));
  IF v_newer_followups IS NOT NULL THEN
    RAISE EXCEPTION 'FOLLOWUP_STILL_OPEN: cancel or void the newer follow-up delivery % first', v_newer_followups;
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
          -- KI-163: log only what is really released; the update below never takes prebooked under 0.
          SELECT quantity_prebooked INTO v_prebooked_before FROM inventory
           WHERE product_id = v_qd_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
          v_release_qty := LEAST(v_release_qty, GREATEST(COALESCE(v_prebooked_before, 0), 0));
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
    -- KI-188: the rows scheduled on this delivery go back on the remainders queue as they were before
    -- create_followup_delivery took them (same quantity); closed instead if the order or original is closed.
    UPDATE delivery_remainders dr
       SET status = CASE WHEN o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL
                       OR od.status IN ('cancelled', 'voided') OR od.deleted_at IS NOT NULL
                    THEN 'cancelled' ELSE 'pending' END,
           followup_delivery_id = CASE WHEN o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL
                       OR od.status IN ('cancelled', 'voided') OR od.deleted_at IS NOT NULL
                    THEN dr.followup_delivery_id END,
           updated_at = now()
      FROM orders o, deliveries od
     WHERE dr.followup_delivery_id = p_delivery_id AND dr.status = 'scheduled'
       AND o.id = dr.order_id AND od.id = dr.original_delivery_id;
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

REVOKE ALL ON FUNCTION public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------- void: refuse while a follow-up is open; rows it fulfilled reopen
CREATE OR REPLACE FUNCTION public._void_delivery_replay_impl_20261015(p_delivery_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_newer_followups text;
  v_actor         uuid;
  v_delivery      record;
  v_item          record;
  v_posted_invoices_exist boolean := false;
  v_order_confirmed boolean;
  v_order_fulfilled boolean;
  v_new_order_status text;
  v_order_status  text;
  v_closed_period record;
  v_effective_completion_date date;
  v_admin record;
  -- DELTA-IDEM BEGIN (#11 nightly-debug: canonical idempotency — cache/replay the rich result)
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-IDEM END
BEGIN
  -- Strict actor pattern (codex audit F1)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to void a completed delivery';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to void a delivery';
  END IF;

  -- DELTA-IDEM BEGIN (#11: canonical check — replay the cached rich payload, not a bare marker)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  -- DELTA-IDEM END

  SELECT * INTO v_delivery
  FROM deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;
  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Only completed deliveries can be voided (current status: %)', v_delivery.status;
  END IF;

  -- create_return and receive_return lock the parent order before they create
  -- or receive a return. Keep the established delivery -> order hierarchy used
  -- by completion, but never WAIT for the order while holding the delivery:
  -- waiting would oppose receive_return's return -> order -> delivery chain.
  -- Fail fast instead; the caller can retry after the concurrent lifecycle
  -- operation commits, at which point the active-return predicate below sees
  -- the fresh reservation and rejects the reversal.
  IF v_delivery.order_id IS NOT NULL THEN
    BEGIN
      SELECT status INTO v_order_status
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

  -- KI-102 (20261107120000): void_order already put this delivery's stock back; voiding it again would restore
  -- the same stock twice and reopen the voided order.
  IF v_order_status = 'voided' THEN
    RAISE EXCEPTION 'ORDER_VOIDED_DELIVERY_LOCKED: delivery % belongs to a voided order; its stock was already restored by the order void',
      v_delivery.delivery_number;
  END IF;

  -- Any active return reserves this delivery lineage until the return is
  -- rejected or cancelled. Reversing the delivery under a requested/approved
  -- return would let a later receipt add stock after the delivery already put
  -- the same stock back. Received/credited returns have already added it.
  -- Source-free legacy lines are conservatively order-wide; order-linked lines
  -- block only deliveries sharing that order line.
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

  -- KI-188 (Mason 2026-11-22: newest first): a later delivery in this one's follow-up chain is still live. Undoing
  -- this one first would lose the short items that delivery carries, so staff cancel or void it first.
  v_newer_followups := (WITH RECURSIVE chain(id) AS (
          SELECT dr.followup_delivery_id FROM delivery_remainders dr
           WHERE dr.original_delivery_id = p_delivery_id AND dr.followup_delivery_id IS NOT NULL
          UNION
          SELECT dr.followup_delivery_id FROM chain c JOIN delivery_remainders dr ON dr.original_delivery_id = c.id
           WHERE dr.followup_delivery_id IS NOT NULL)
        SELECT string_agg(DISTINCT coalesce(nullif(btrim(g.delivery_number), ''), g.id::text), ', ')
          FROM chain c JOIN deliveries g ON g.id = c.id
         WHERE g.id <> p_delivery_id AND g.status NOT IN ('cancelled', 'voided'));
  IF v_newer_followups IS NOT NULL THEN
    RAISE EXCEPTION 'FOLLOWUP_STILL_OPEN: cancel or void the newer follow-up delivery % first', v_newer_followups;
  END IF;

  -- A void reverses the completed delivery's accounting event, so period
  -- detection must use the actual Chicago completion business date rather
  -- than the schedule date. Keep the schedule date only as a legacy fallback.
  v_effective_completion_date := COALESCE(
    (v_delivery.completed_at AT TIME ZONE 'America/Chicago')::date,
    v_delivery.scheduled_date
  );

  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' voided for completion date ' || v_effective_completion_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Reason: ' || p_reason ||
        '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Void',
        'Delivery ' || v_delivery.delivery_number ||
          ' was voided for completion date ' || v_effective_completion_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory was restored and ' ||
          'draft invoices were auto-cancelled. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
      AND di.quantity_delivered > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available + v_item.quantity_delivered,
      -- KI-94 (20261106230000): put back what completion took from the reservation, not the whole delivered
      -- quantity. A line completed before 20261106230000 has no record (NULL) and keeps the old restore.
      -- KI-101 (20261107120000): a cancelled order already released its reservation and nobody will deliver it,
      -- so the goods go back on the shelf but the reservation is not put back.
      quantity_prebooked = quantity_prebooked + CASE WHEN v_order_status = 'cancelled' THEN 0
        ELSE COALESCE(v_item.quantity_prebooked_released, v_item.quantity_delivered) END,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes, requires_review
    ) VALUES (
      v_item.product_id, 'void_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason
        || CASE WHEN v_order_status = 'cancelled'
             THEN ' (available restored; reservation not restored: the order is cancelled)'
             ELSE ' (available restored; reservation restored: '
               || COALESCE(v_item.quantity_prebooked_released, v_item.quantity_delivered) || ')'
               -- KI-94 follow-up (20261106233000): a line completed before 20261106230000 has no record of what completion
               -- took from the reservation, so the restore above may be too high; flag the row for the office to check.
               || CASE WHEN v_item.quantity_prebooked_released IS NULL
                    THEN ' [completed before the KI-94 fix: reserved stock may now be too high, check it]' ELSE '' END
           END,
      v_item.quantity_prebooked_released IS NULL AND v_order_status IS DISTINCT FROM 'cancelled'
    );

    -- KI-101: a cancelled order's lines keep nothing left to deliver (a full cancel zeroes quantity_remaining; a void never raises it).
    UPDATE order_items SET
      quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
      quantity_remaining = quantity_remaining
        + CASE WHEN v_order_status = 'cancelled' THEN 0 ELSE v_item.quantity_delivered END
    WHERE id = v_item.order_item_id;
  END LOOP;

  DELETE FROM delivery_remainders WHERE original_delivery_id = p_delivery_id;
  -- KI-188: the rows this delivery fulfilled go back on the remainders queue (same quantity); closed instead if
  -- the order or original is closed (a cancelled order's lines were not raised above).
  UPDATE delivery_remainders dr
     SET status = CASE WHEN o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL
                     OR od.status IN ('cancelled', 'voided') OR od.deleted_at IS NOT NULL
                  THEN 'cancelled' ELSE 'pending' END,
         followup_delivery_id = CASE WHEN o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL
                     OR od.status IN ('cancelled', 'voided') OR od.deleted_at IS NOT NULL
                  THEN dr.followup_delivery_id END,
         updated_at = now()
    FROM orders o, deliveries od
   WHERE dr.followup_delivery_id = p_delivery_id AND dr.status = 'fulfilled'
     AND o.id = dr.order_id AND od.id = dr.original_delivery_id;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_order_fulfilled;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining < total_units_needed
  ) INTO v_order_confirmed;

  v_new_order_status :=
    CASE
      -- KI-101 (20261107120000): voiding a delivery never reopens a cancelled order.
      WHEN v_order_status = 'cancelled' THEN 'cancelled'
      WHEN v_order_fulfilled  THEN 'fulfilled'
      WHEN v_order_confirmed  THEN 'confirmed'
      ELSE 'partially_fulfilled'
    END;

  UPDATE orders SET
    status = v_new_order_status,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- U2 (Codex P1): scope the auto-cancel to THIS delivery's own draft invoice or an
  -- order-level one (delivery_id IS NULL) — was per-order, which would cancel a
  -- SIBLING delivery's draft invoice on void of this delivery.
  UPDATE invoices SET
    status      = 'cancelled',
    void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' was voided by admin',
    updated_at  = now()
  WHERE order_id = v_delivery.order_id AND status = 'draft'
    AND invoice_type <> 'credit_memo'
    AND deleted_at IS NULL
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

  -- U2 (Codex P1): read-only "posted invoice needs review" flag — scope it the same
  -- way so a SIBLING delivery's posted invoice (untouched by this void) no longer
  -- raises a false manual-review warning. No guard/blocking behaviour hangs off this
  -- flag, so scoping cannot loosen a safety check.
  SELECT EXISTS (
    SELECT 1 FROM invoices
    WHERE order_id = v_delivery.order_id AND status = 'posted'
      AND invoice_type <> 'credit_memo'
      AND deleted_at IS NULL
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL)
  ) INTO v_posted_invoices_exist;

  UPDATE deliveries SET
    status     = 'voided',
    updated_at = now()
  WHERE id = p_delivery_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'delivery_voided', 'delivery', p_delivery_id, v_actor,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'completed'),
    jsonb_build_object('status', 'voided', 'order_status', v_new_order_status),
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_voided',
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- DELTA-IDEM BEGIN (#11: build the rich result first, then cache it via the canonical helper + replay it)
  v_result := jsonb_build_object(
    'success',                true,
    'delivery_id',            p_delivery_id,
    'delivery_number',        v_delivery.delivery_number,
    'new_order_status',       v_new_order_status,
    'posted_invoices_exist',  v_posted_invoices_exist
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_delivery', v_result);
  END IF;

  PERFORM set_config('app.admin_override', 'false', true);

  RETURN v_result;
  -- DELTA-IDEM END
END;
$function$;

REVOKE ALL ON FUNCTION public._void_delivery_replay_impl_20261015(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)'))
     IS DISTINCT FROM '9c5ae254add59f0b0d228cd773929805' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: cancel is not this file''s body';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)'))
     IS DISTINCT FROM '5ad0fdf2cda0d0edbf045fe1f7200ad8' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: void is not this file''s body';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid IN (to_regprocedure('public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)'), to_regprocedure('public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)'))
          AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
               OR proowner IS DISTINCT FROM 'postgres'::regrole)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: owner postgres, definer and fixed search_path';
  END IF;
  IF has_function_privilege('anon', 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: an API role can run cancel or void';
  END IF;
  RAISE NOTICE 'LEGACY_STUCK_REMAINDERS: %', (SELECT count(*) FROM public.delivery_remainders dr JOIN public.deliveries f ON f.id = dr.followup_delivery_id
            WHERE (dr.status = 'scheduled' AND f.status IN ('cancelled', 'voided'))
               OR (dr.status = 'fulfilled' AND f.status = 'voided'));
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
