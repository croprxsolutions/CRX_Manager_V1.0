-- Written 2026-11-03. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: "Fix delivery" — one admin action that undoes a completed delivery AND its invoice together,
--   so the delivery can be re-entered with the right amount or product (Mason, 2026-11-03: "I want
--   easy, not going to multiple screens"). Business Central's "Correct" on an unpaid invoice is the
--   model. Product that really came back still goes through Returns, not this.
--
--   preview_fix_delivery(delivery)  read-only plan: the invoices that will be voided or cancelled,
--                                   the stock that goes back, and every reason it is refused.
--   fix_delivery(delivery, reason, expected invoice ids, key)
--                                   re-checks the same plan under locks, then in ONE transaction:
--                                   void_invoice for each invoice on this delivery, void_delivery,
--                                   and re-creates the order's pending commissions (see 3 below).
--
-- WHY NOT JUST CALL THE TWO EXISTING ACTIONS FROM THE BROWSER: the first could commit and the second
--   fail, leaving a voided bill on a live delivery. Here every step reuses the existing public
--   functions (void_invoice, void_delivery) with all their checks, and any refusal rolls back all.
--   The invoice-first trigger (enforce_delivery_void_needs_invoice_void, 20261029160000) still runs
--   underneath as the final guard.
--
-- REFUSED (first release, kept narrow on purpose):
--   * delivery not completed, or not from an order;
--   * the delivery was recorded as billed outside CRX (delivery_external_billings);
--   * an active return touches this delivery's lines (void_delivery refuses these too);
--   * an active non-draft invoice on the ORDER with no delivery (it bills other deliveries too);
--   * an invoice in a split group (invoice_group_id), which needs the group void;
--   * cash already applied (paid_amount_cents > 0): unapply the payment first;
--   * a posted/paid/overdue invoice dated in a closed accounting period;
--   * a pending order commission already in an active payout batch.
--
-- 3. COMMISSIONS: void_invoice cancels the order's PENDING commissions when no other active invoice
--   remains on the order (20260718221505), and a cancelled commission can never be reopened
--   (stamp_commission_cancellation_history). A fixed delivery does not undo the order, so the rep must
--   keep the commission: every pending order commission this call cancelled is re-inserted as a new
--   pending row with the same recipient, split and amount. The cancelled row stays as history.
--
-- IDEMPOTENCY: p_idempotency_key is required. The intent fingerprint binds actor, delivery, reason
--   and the confirmed invoice set. Inner calls use keys derived from it, so a retry after a lost
--   response replays the stored result before any inner call runs.
--
-- idempotency-body-check: exempt. fix_delivery reads idempotency_keys through
--   check_idempotency_intent with its own operation literal ('fix_delivery') and writes it through
--   save_idempotency + _bind_replay_receipt_20261015 (the batch 1 bound-receipt pattern, 20261016060000).

-- ---------------------------------------------------------------------------------------------
-- 1. The plan, shared by preview and execute so they can never disagree.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._fix_delivery_plan(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delivery record;
  v_refusals jsonb := '[]'::jsonb;
  v_invoices jsonb;
  v_order_drafts jsonb;
  v_items jsonb;
BEGIN
  SELECT d.id, d.delivery_number, d.status, d.order_id, d.customer_id, d.deleted_at, o.order_number
    INTO v_delivery
    FROM deliveries d
    LEFT JOIN orders o ON o.id = d.order_id
   WHERE d.id = p_delivery_id;
  IF NOT FOUND OR v_delivery.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  IF v_delivery.status <> 'completed' THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'NOT_COMPLETED',
      'message', 'Only a completed delivery can be fixed (this one is ' || v_delivery.status || ').');
  END IF;
  IF v_delivery.order_id IS NULL THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'NO_ORDER',
      'message', 'This delivery has no order, so it cannot be re-entered from one.');
  END IF;

  IF EXISTS (SELECT 1 FROM delivery_external_billings b WHERE b.delivery_id = p_delivery_id) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'BILLED_OUTSIDE_CRX',
      'message', 'This delivery was billed outside CRX. Fix that bill where it was made.');
  END IF;

  -- Same predicate as void_delivery's DELIVERY_HAS_RECEIVED_RETURN check.
  IF v_delivery.order_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM returns r
      JOIN return_items ri ON ri.return_id = r.id
     WHERE r.order_id = v_delivery.order_id
       AND r.deleted_at IS NULL
       AND r.status IN ('requested', 'approved', 'received', 'credited')
       AND (ri.order_item_id IS NULL OR EXISTS (
             SELECT 1 FROM delivery_items di
              WHERE di.delivery_id = p_delivery_id AND di.order_item_id = ri.order_item_id))
  ) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'HAS_RETURN',
      'message', 'A return is open or done on this delivery. Settle it on the Returns page instead.');
  END IF;

  IF v_delivery.order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM invoices i
     WHERE i.order_id = v_delivery.order_id AND i.delivery_id IS NULL
       AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
       AND i.status IN ('unposted', 'posted', 'paid', 'overdue')
  ) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'ORDER_LEVEL_INVOICE',
      'message', 'This order is billed on one invoice that covers more than this delivery. Void that invoice from the invoice page first.');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'invoice_number', i.invoice_number,
           'status', i.status,
           'total_cents', i.total_amount_cents,
           'paid_cents', COALESCE(i.paid_amount_cents, 0),
           'prepay_applied_cents', COALESCE(i.prepay_applied_cents, 0),
           'action', CASE WHEN i.status IN ('draft', 'unposted') THEN 'cancel' ELSE 'void' END
         ) ORDER BY i.invoice_number), '[]'::jsonb)
    INTO v_invoices
    FROM invoices i
   WHERE i.delivery_id = p_delivery_id
     AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
     AND i.status IN ('draft', 'unposted', 'posted', 'paid', 'overdue');

  IF EXISTS (SELECT 1 FROM invoices i
              WHERE i.delivery_id = p_delivery_id AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
                AND i.status NOT IN ('voided', 'cancelled') AND i.invoice_group_id IS NOT NULL) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'SPLIT_INVOICE',
      'message', 'This delivery is billed on a split invoice. Void the split group from the invoice page first.');
  END IF;

  IF EXISTS (SELECT 1 FROM invoices i
              WHERE i.delivery_id = p_delivery_id AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
                AND i.status NOT IN ('voided', 'cancelled') AND COALESCE(i.paid_amount_cents, 0) > 0) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'PAYMENT_APPLIED',
      'message', 'A payment is applied to this invoice. Unapply it first (the money stays on the customer''s account as credit).');
  END IF;

  IF EXISTS (SELECT 1 FROM invoices i
               JOIN accounting_periods ap ON ap.status = 'closed' AND i.invoice_date BETWEEN ap.period_start AND ap.period_end
              WHERE i.delivery_id = p_delivery_id AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
                AND i.status IN ('posted', 'paid', 'overdue')) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'CLOSED_PERIOD',
      'message', 'The invoice is dated in a closed month. Reopen that month or issue a credit instead.');
  END IF;

  IF v_delivery.order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
     WHERE c.order_id = v_delivery.order_id AND c.status = 'pending' AND c.deleted_at IS NULL
       AND cp.status <> 'voided'
  ) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'COMMISSION_IN_PAYOUT',
      'message', 'This order''s commission is in a payout batch. Void that commission payment first.');
  END IF;

  -- void_delivery also cancels the order's draft invoices that have no delivery; show them so
  -- nothing is a surprise (same scope as its auto-cancel).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number) ORDER BY i.invoice_number), '[]'::jsonb)
    INTO v_order_drafts
    FROM invoices i
   WHERE i.order_id = v_delivery.order_id AND i.status = 'draft' AND i.deleted_at IS NULL
     AND i.invoice_type <> 'credit_memo' AND i.delivery_id IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_name', p.product_name,
           'quantity', di.quantity,
           'unit', COALESCE(di.unit_size, p.unit_size)
         ) ORDER BY p.product_name), '[]'::jsonb)
    INTO v_items
    FROM delivery_items di
    LEFT JOIN products p ON p.id = di.product_id
   WHERE di.delivery_id = p_delivery_id;

  RETURN jsonb_build_object(
    'delivery_id', v_delivery.id,
    'delivery_number', v_delivery.delivery_number,
    'order_id', v_delivery.order_id,
    'order_number', v_delivery.order_number,
    'customer_id', v_delivery.customer_id,
    'can_fix', jsonb_array_length(v_refusals) = 0,
    'refusals', v_refusals,
    'invoices', v_invoices,
    'other_draft_invoices', v_order_drafts,
    'items', v_items
  );
END;
$function$;
REVOKE ALL ON FUNCTION public._fix_delivery_plan(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Preview (read-only).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_fix_delivery(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required to fix a delivery'; END IF;
  RETURN public._fix_delivery_plan(p_delivery_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.preview_fix_delivery(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_fix_delivery(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Execute.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fix_delivery(
  p_delivery_id uuid,
  p_reason text,
  p_expected_invoice_ids uuid[],
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_expected uuid[];
  v_actual uuid[];
  v_fingerprint text;
  v_replay jsonb;
  v_plan jsonb;
  v_order_id uuid;
  v_invoice jsonb;
  v_pending_commission_ids uuid[];
  v_commissions_restored integer := 0;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: fix_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required to fix a delivery'; END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'Reason is required to fix a delivery'; END IF;

  SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_expected FROM unnest(p_expected_invoice_ids) x;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'reason', v_reason,
    'invoice_ids', to_jsonb(v_expected)
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'fix_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Lock in the order void_delivery and the invoice-first trigger use: delivery, then order
  -- (fail fast), then the delivery's invoices (fail fast).
  SELECT order_id INTO v_order_id FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;
  BEGIN
    IF v_order_id IS NOT NULL THEN
      PERFORM 1 FROM orders WHERE id = v_order_id FOR UPDATE NOWAIT;
    END IF;
    PERFORM 1 FROM invoices WHERE delivery_id = p_delivery_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_BUSY_RETRY';
  END;

  v_plan := public._fix_delivery_plan(p_delivery_id);
  IF NOT (v_plan ->> 'can_fix')::boolean THEN
    RAISE EXCEPTION 'FIX_DELIVERY_REFUSED: %', v_plan -> 'refusals' -> 0 ->> 'message'
      USING DETAIL = (v_plan -> 'refusals')::text;
  END IF;
  SELECT COALESCE(array_agg((e ->> 'id')::uuid ORDER BY (e ->> 'id')::uuid), '{}')
    INTO v_actual FROM jsonb_array_elements(v_plan -> 'invoices') e;
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'FIX_DELIVERY_PREVIEW_STALE: the invoices on this delivery changed; reopen Fix delivery to see the new plan';
  END IF;

  SELECT COALESCE(array_agg(id), '{}') INTO v_pending_commission_ids
    FROM commissions
   WHERE order_id = v_order_id AND status = 'pending' AND deleted_at IS NULL;

  FOR v_invoice IN SELECT e FROM jsonb_array_elements(v_plan -> 'invoices') e LOOP
    PERFORM public.void_invoice(
      (v_invoice ->> 'id')::uuid,
      'Fix delivery ' || (v_plan ->> 'delivery_number') || ': ' || v_reason,
      p_idempotency_key || ':void_invoice:' || (v_invoice ->> 'id'));
  END LOOP;

  PERFORM public.void_delivery(p_delivery_id, v_reason, v_actor, p_idempotency_key || ':void_delivery');

  -- The order stands, so the rep keeps the commission void_invoice just cancelled.
  INSERT INTO commissions (order_id, customer_id, recipient, recipient_user_id, split_percentage,
                           commission_amount, order_profit, order_date, season, order_number, customer_name,
                           status)
  SELECT c.order_id, c.customer_id, c.recipient, c.recipient_user_id, c.split_percentage,
         c.commission_amount, c.order_profit, c.order_date, c.season, c.order_number, c.customer_name,
         'pending'
    FROM commissions c
   WHERE c.id = ANY (v_pending_commission_ids) AND c.status = 'cancelled';
  GET DIAGNOSTICS v_commissions_restored = ROW_COUNT;

  v_result := jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'delivery_number', v_plan ->> 'delivery_number',
    'order_id', v_order_id,
    'customer_id', v_plan -> 'customer_id',
    'invoices', v_plan -> 'invoices',
    'commissions_restored', v_commissions_restored
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_fixed',
          'Fixed delivery ' || (v_plan ->> 'delivery_number') || ': undid it and ' ||
            jsonb_array_length(v_plan -> 'invoices') || ' invoice(s) for re-entry. Reason: ' || v_reason,
          v_actor, 'delivery', p_delivery_id, (v_plan ->> 'customer_id')::uuid);

  PERFORM public.save_idempotency(p_idempotency_key, 'fix_delivery', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'fix_delivery', v_fingerprint);
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fix_delivery(uuid, text, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fix_delivery(uuid, text, uuid[], text) TO authenticated, service_role;
