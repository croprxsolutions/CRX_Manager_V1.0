-- Inventory clean-up, To-Do 0.17 part 5 (contract: docs/plans/2026-11-17-inventory-cleanup-ki161-163-150-CONTRACT.md).
--
-- KI-161: the database now checks every delivery line against its order line.
--   * Trigger a2_delivery_line_matches_order_line (BEFORE INSERT, and UPDATE OF order_item_id, delivery_id,
--     product_id, unit_size) on delivery_items: the order line must be on the delivery's order; a missing or
--     different product is refused (not filled: a1 has already skipped a line with no product); a blank unit is
--     taken from the order line, a different unit refused; an order line is used once per delivery (also a unique
--     index). It sorts after #1896's a1_line_unit_is_stock_unit. Rows are only checked when
--     written that way, so completion (quantity_delivered) and history are untouched. Live 2026-11-17: 406 lines,
--     0 on another order, 0 product or unit differences, 0 duplicates.
--   * Trigger a2_delivery_order_keeps_lines (BEFORE UPDATE OF order_id) on deliveries: a delivery with lines cannot
--     move to another order. No writer does; authenticated may update deliveries.order_id live.
--   * authenticated loses INSERT, UPDATE and DELETE on delivery_items (table and columns). The screens never write
--     the table; the six functions that do are SECURITY DEFINER. SELECT is unchanged.
-- KI-150: stock rows are locked in id order before a completion moves them.
--   * _complete_delivery_authorized_impl is renamed _complete_delivery_authorized_impl_20270122 (body untouched); a
--     wrapper of the old name and signature locks the delivery, then the Main Warehouse stock rows of its lines in id
--     order, then calls it. The body takes only the delivery lock (and activity/notification inserts) before its own
--     per-line stock locks, so only the order among stock rows changes.
--   * Jobs: AFTER UPDATE OF status trigger trg_zz_lock_job_stock_rows (sorts after the hold sync) locks the stock rows
--     of the completing job's chemicals in id order, right before _complete_job_replay_impl_20261015's deduction loop
--     (only inserts run in between). The job body and the hold sync are not changed.
--   * Receipt reversal vs vendor bill (the KI's first pair): no change. The vendor-bill paths read PO lines without a
--     lock and never update the PO or take advisory lock 73492009, so no cycle exists; see the contract.
-- KI-163:
--   1. _cancel_delivery_replay_impl_20261015: a quick-delivery cancel logs the amount really released (never more
--      than the prebooked it found), and no row when nothing was released. Otherwise the same body.
--   2. cycle_count_items.expected_qty / counted_qty / variance widen to numeric(14,4); update_cycle_count_item rounds
--      to 4 places, so a count of a 4-decimal stock row completes exactly on the counted figure.
--
-- idempotency-body-check: exempt -- no public RPC changes. _cancel_delivery_replay_impl_20261015 and
--   update_cycle_count_item keep their idempotency handling byte for byte; the new delivery wrapper passes
--   p_idempotency_key through to the unchanged body.
-- caller-analysis: _complete_delivery_authorized_impl :: same name, signature, defaults, result and grants (none to
--   API roles); its only caller _complete_delivery_aggregate_impl is unchanged. _cancel_delivery_replay_impl_20261015
--   :: same signature and result shape. update_cycle_count_item :: same signature and grants; the result's numbers
--   may carry 4 decimals (the screen formats them). delivery_items :: the screens only read it.
--
-- ROLLBACK: scripts/smoke/inventory-cleanup-ki161-163-150-reverse.sql (proven by the prover).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  FOR v_fn IN
    SELECT x.sig, x.body_md5, p.oid, p.prosrc
      FROM (VALUES
        ('public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)', '217e5a57fae88af4ba8c84e20739ae3a'),
        ('public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'de13689d6e97dbfb679d27cac45f1bf7'),
        ('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', '70170ea464444edcf495329ff2b158d7')
      ) AS x(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig)
  LOOP
    IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM v_fn.body_md5 THEN
      RAISE EXCEPTION 'INV_CLEANUP_PREFLIGHT: % is not the reviewed body', v_fn.sig;
    END IF;
  END LOOP;
  IF to_regprocedure('public._unit_matches_stock_unit(text,text)') IS NULL THEN
    RAISE EXCEPTION 'INV_CLEANUP_PREFLIGHT: #1896 (_unit_matches_stock_unit) must land first';
  END IF;
  IF to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public._delivery_line_matches_order_line()') IS NOT NULL
     OR to_regprocedure('public._lock_job_stock_rows_in_order()') IS NOT NULL
     OR to_regprocedure('public._delivery_order_keeps_lines()') IS NOT NULL THEN
    RAISE EXCEPTION 'INV_CLEANUP_PREFLIGHT: already applied';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('_cancel_delivery_replay_impl_20261015', 'update_cycle_count_item', '_complete_delivery_authorized_impl')) <> 3 THEN
    RAISE EXCEPTION 'INV_CLEANUP_PREFLIGHT: an unexpected overload exists';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------- KI-161
LOCK TABLE public.delivery_items IN SHARE ROW EXCLUSIVE MODE;

DO $lineage_now$
BEGIN
  IF EXISTS (SELECT 1 FROM public.delivery_items di
               JOIN public.deliveries d ON d.id = di.delivery_id
               LEFT JOIN public.order_items oi ON oi.id = di.order_item_id
              WHERE oi.id IS NULL OR oi.order_id IS DISTINCT FROM d.order_id OR oi.product_id IS DISTINCT FROM di.product_id) THEN
    RAISE EXCEPTION 'INV_CLEANUP_PREFLIGHT: a delivery line does not match its order line; correct it first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_items GROUP BY delivery_id, order_item_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'INV_CLEANUP_PREFLIGHT: an order line is used twice on one delivery; correct it first';
  END IF;
END;
$lineage_now$;

CREATE FUNCTION public._delivery_line_matches_order_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id uuid;
  v_oi record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
     AND NEW.delivery_id IS NOT DISTINCT FROM OLD.delivery_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.unit_size IS NOT DISTINCT FROM OLD.unit_size THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE: the delivery cannot move to another order (a2_delivery_order_keeps_lines) until this line commits.
  SELECT d.order_id INTO v_order_id FROM public.deliveries d WHERE d.id = NEW.delivery_id FOR SHARE;
  -- FOR SHARE: the order line's product cannot change (guard_order_item_delivery_lineage) until this line commits.
  -- Every writer already holds this row FOR UPDATE or created it, so this never upgrades a shared lock.
  SELECT oi.order_id, oi.product_id, oi.unit_size INTO v_oi
    FROM public.order_items oi WHERE oi.id = NEW.order_item_id
     FOR SHARE;
  IF NOT FOUND OR v_order_id IS NULL OR v_oi.order_id IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'DELIVERY_LINE_NOT_ON_ORDER: this delivery line is not a line of the delivery''s order.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A missing product is refused, not filled: a1_line_unit_is_stock_unit already ran and skipped a line with no product.
  IF NEW.product_id IS DISTINCT FROM v_oi.product_id THEN
    RAISE EXCEPTION 'DELIVERY_LINE_PRODUCT_MISMATCH: this delivery line is for a different product than its order line.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(btrim(NEW.unit_size, E' \t\r\n' || chr(160)), '') = '' THEN
    NEW.unit_size := v_oi.unit_size;
  ELSIF NOT public._unit_matches_stock_unit(NEW.unit_size, v_oi.unit_size) THEN
    RAISE EXCEPTION 'DELIVERY_LINE_UNIT_MISMATCH: this delivery line is in "%" but its order line is in "%".',
      NEW.unit_size, v_oi.unit_size USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM public.delivery_items x
              WHERE x.delivery_id = NEW.delivery_id AND x.order_item_id = NEW.order_item_id
                AND x.id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'DELIVERY_LINE_DUPLICATE: this order line is already on the delivery.'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._delivery_line_matches_order_line() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER a2_delivery_line_matches_order_line
  BEFORE INSERT OR UPDATE OF order_item_id, delivery_id, product_id, unit_size ON public.delivery_items
  FOR EACH ROW EXECUTE FUNCTION public._delivery_line_matches_order_line();

-- The parent side: a delivery that has lines cannot be moved to another order (no writer does; signed-in users
-- could, through the deliveries update grant), or every line would point at another order's lines.
CREATE FUNCTION public._delivery_order_keeps_lines()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     AND EXISTS (SELECT 1 FROM public.delivery_items di WHERE di.delivery_id = OLD.id) THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_LOCKED: a delivery with lines cannot be moved to another order.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._delivery_order_keeps_lines() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER a2_delivery_order_keeps_lines
  BEFORE UPDATE OF order_id ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public._delivery_order_keeps_lines();

-- Two writers at once: the trigger's check cannot see the other's uncommitted line; the index can.
CREATE UNIQUE INDEX delivery_items_one_line_per_order_line ON public.delivery_items (delivery_id, order_item_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.delivery_items FROM authenticated, anon, PUBLIC;
DO $column_grants$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.delivery_items'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%s), UPDATE (%s) ON public.delivery_items FROM authenticated, anon, PUBLIC', v_cols, v_cols);
END;
$column_grants$;

-- ---------------------------------------------------------------- KI-150
ALTER FUNCTION public._complete_delivery_authorized_impl(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone)
  RENAME TO _complete_delivery_authorized_impl_20270122;
REVOKE ALL ON FUNCTION public._complete_delivery_authorized_impl_20270122(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._complete_delivery_authorized_impl(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  -- KI-150: the delivery first (as the body does), then every stock row its lines can move, in id order, so two
  -- completions sharing products wait for each other instead of deadlocking. The body re-takes these locks.
  PERFORM 1 FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  PERFORM 1 FROM public.inventory i
   WHERE i.location = 'Main Warehouse'
     AND i.product_id IN (SELECT di.product_id FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id)
   ORDER BY i.id
     FOR UPDATE;
  RETURN public._complete_delivery_authorized_impl_20270122(
    p_delivery_id, p_signed_by, p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at);
END;
$function$;

REVOKE ALL ON FUNCTION public._complete_delivery_authorized_impl(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._lock_job_stock_rows_in_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  -- KI-150: _complete_job_replay_impl_20261015 deducts each chemical's stock row in line order after this status
  -- update; lock them all here in id order first so two job completions sharing products cannot deadlock.
  PERFORM 1 FROM public.inventory i
   WHERE i.location = 'Main Warehouse'
     AND i.product_id IN (SELECT jc.product_id FROM public.job_chemicals jc
                           WHERE jc.job_id = NEW.id AND jc.quantity > 0 AND jc.customer_supplied = false)
   ORDER BY i.id
     FOR UPDATE;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._lock_job_stock_rows_in_order() FROM PUBLIC, anon, authenticated, service_role;

-- AFTER triggers fire by name: trg_zz_ runs after trg_release_job_holds_on_lifecycle (the hold sync).
CREATE TRIGGER trg_zz_lock_job_stock_rows
  AFTER UPDATE OF status ON public.jobs
  FOR EACH ROW
  WHEN (OLD.status IN ('scheduled', 'in_progress') AND NEW.status = 'completed' AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public._lock_job_stock_rows_in_order();

-- ---------------------------------------------------------------- KI-163 (1)
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

-- ---------------------------------------------------------------- KI-163 (2)
ALTER TABLE public.cycle_count_items
  ALTER COLUMN expected_qty TYPE numeric(14,4),
  ALTER COLUMN counted_qty TYPE numeric(14,4),
  ALTER COLUMN variance TYPE numeric(14,4);

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
        -- Four places, like the stored columns (KI-163), so the saved row, the result and Complete agree.
        v_expected := round(COALESCE(v_on_hand, 0), 4);
      END IF;
    END IF;
    v_variance := round(p_counted_qty, 4) - v_expected;
    IF v_expected <> 0 THEN
      -- abs(): a negative on hand must not flip the percentage's sign (Taha, PR #1775).
      v_variance_pct := round((v_variance / abs(v_expected)) * 100, 2);
      -- variance_pct is numeric(8,2): a tiny on-hand must not make the count unsavable.
      IF abs(v_variance_pct) >= 1000000 THEN v_variance_pct := NULL; END IF;
    END IF;
  END IF;

  UPDATE public.cycle_count_items
     SET expected_qty = v_expected,
         counted_qty = round(p_counted_qty, 4),
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
    'counted_qty', round(p_counted_qty, 4),
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

DO $postflight$
BEGIN
  IF has_table_privilege('authenticated', 'public.delivery_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.delivery_items', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.delivery_items', 'DELETE')
     OR has_table_privilege('authenticated', 'public.delivery_items', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.delivery_items', 'TRUNCATE')
     OR has_any_column_privilege('authenticated', 'public.delivery_items', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.delivery_items', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.delivery_items', 'SELECT') THEN
    RAISE EXCEPTION 'INV_CLEANUP_POSTFLIGHT: delivery_items grants are not as reviewed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.delivery_items'::regclass
        AND tgname = 'a2_delivery_line_matches_order_line' AND tgenabled = 'O') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass
        AND tgname = 'trg_zz_lock_job_stock_rows' AND tgenabled = 'O') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.deliveries'::regclass
        AND tgname = 'a2_delivery_order_keeps_lines' AND tgenabled = 'O') <> 1
     OR to_regclass('public.delivery_items_one_line_per_order_line') IS NULL THEN
    RAISE EXCEPTION 'INV_CLEANUP_POSTFLIGHT: triggers or index missing';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM '70170ea464444edcf495329ff2b158d7' THEN
    RAISE EXCEPTION 'INV_CLEANUP_POSTFLIGHT: the renamed completion body changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN (to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'),
                              to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'),
                              to_regprocedure('public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)'),
                              to_regprocedure('public._delivery_line_matches_order_line()'),
                              to_regprocedure('public._delivery_order_keeps_lines()'),
                              to_regprocedure('public._lock_job_stock_rows_in_order()'))
                AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
                     OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     OR has_function_privilege('anon', p.oid, 'EXECUTE')))
     OR (SELECT count(*) FROM pg_proc WHERE oid IN (
           to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'),
           to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'),
           to_regprocedure('public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)'),
           to_regprocedure('public._delivery_line_matches_order_line()'),
           to_regprocedure('public._delivery_order_keeps_lines()'),
           to_regprocedure('public._lock_job_stock_rows_in_order()'))) <> 6 THEN
    RAISE EXCEPTION 'INV_CLEANUP_POSTFLIGHT: a function''s security, search_path or grants are not as reviewed';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)'::regprocedure
                      AND prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']
                      AND prosrc LIKE '%v_expected := round(COALESCE(v_on_hand, 0), 4);%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)'::regprocedure
                      AND prosrc LIKE '%v_release_qty := LEAST(v_release_qty, GREATEST(COALESCE(v_prebooked_before, 0), 0));%') THEN
    RAISE EXCEPTION 'INV_CLEANUP_POSTFLIGHT: a re-emitted body did not land';
  END IF;
  IF (SELECT string_agg(column_name || ':' || numeric_precision || ',' || numeric_scale, ' ' ORDER BY column_name)
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cycle_count_items'
         AND column_name IN ('expected_qty', 'counted_qty', 'variance'))
     IS DISTINCT FROM 'counted_qty:14,4 expected_qty:14,4 variance:14,4' THEN
    RAISE EXCEPTION 'INV_CLEANUP_POSTFLIGHT: count columns did not widen';
  END IF;
END;
$postflight$;
