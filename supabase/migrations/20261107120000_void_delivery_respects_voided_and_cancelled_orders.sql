-- Written 2026-11-04. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261107120000_void_delivery_respects_voided_and_cancelled_orders.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-102 and KI-101, both in _void_delivery_replay_impl_20261015, the body behind void_delivery):
--   KI-102: void_order puts every delivered quantity back in stock but leaves the order's deliveries 'completed'.
--     void_delivery checked only the delivery's own status, so voiding one of those deliveries afterwards put the
--     same stock back a second time and rewrote the voided order to fulfilled/confirmed/partially_fulfilled.
--     Now a delivery whose order is voided is refused (ORDER_VOIDED_DELIVERY_LOCKED); nothing moves.
--   KI-101: voiding a delivery of a cancelled order recomputed the order's status and wrote it under the admin
--     override, so the cancelled order came back to life (confirmed/partially_fulfilled). Now a cancelled order
--     stays 'cancelled'. The voided goods still go back on the shelf (quantity_available) and the order line's
--     delivered quantity still drops, but the reservation is NOT put back and the line's remaining quantity is
--     not raised: a full cancel already released the order's reservation and (since 20260809170600) zeroed what remains, and nobody will
--     deliver a cancelled order, so a restored reservation would sit stranded and read as stock that is not
--     free. The stock-ledger note says the reservation was not restored because the order is cancelled. (An order
--     moved to 'cancelled' by the direct admin status grant released nothing; its existing reservation is left
--     exactly as it was, as before this change.)
--
-- NOT CHANGED: every other path through the function (other order statuses restore exactly as 20261106233000
--   does), the idempotency replay (a cached void still returns its receipt), the active-return refusal, the
--   period warning, invoices, the public wrapper void_delivery, owner, SECURITY DEFINER, search_path and grants
--   (postgres only). The direct admin UPDATE grant on orders.status is NOT touched here (follow-up for Mason).
--   No table, column or row changes.
--
-- ROLLBACK (its own reviewed migration): re-emit _void_delivery_replay_impl_20261015 from 20261106233000.
--
-- ORDERING: apply after 20261106233000.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE void_order_status_guard_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF to_regclass('pg_temp.void_order_status_guard_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.void_order_status_guard_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'VOID_ORDER_STATUS_GUARD_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- Pinned to the body 20261106233000 installed (live md5, read 2026-11-04), with its owner, mode, search_path
  -- and EXECUTE grants.
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_void_delivery_replay_impl_20261015') <> 1
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '5ed655f54d8bf169b8986dbe2184c0d0'
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres'] THEN
    RAISE EXCEPTION 'PREFLIGHT_VOID_ORDER_STATUS_GUARD_DRIFT: _void_delivery_replay_impl_20261015 differs from its pinned body, owner, mode, search_path or grants';
  END IF;
END
$preflight$;

-- _void_delivery_replay_impl_20261015: the live body (md5 5ed655f5...), plus the voided-order refusal (KI-102)
-- and the cancelled-order hold (KI-101).
CREATE OR REPLACE FUNCTION public._void_delivery_replay_impl_20261015(p_delivery_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
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

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)');
  IF NOT FOUND
     OR position('ORDER_VOIDED_DELIVERY_LOCKED' IN p.prosrc) = 0
     OR position('KI-101 (20261107120000)' IN p.prosrc) = 0
     OR position('KI-94 follow-up (20261106233000)' IN p.prosrc) = 0
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '54809f64a1f7361a495e368585cd501a'
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres'] THEN
    RAISE EXCEPTION 'POSTFLIGHT: _void_delivery_replay_impl_20261015 lost its change, owner, mode, search_path or grants';
  END IF;
END
$postflight$;
