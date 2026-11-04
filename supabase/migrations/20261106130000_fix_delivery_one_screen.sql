-- Written 2026-11-03. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261106130000_fix_delivery_one_screen.md.
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
--   * an active write-off (void_invoice leaves the write_offs row active);
--   * a delivery completed in a closed accounting period;
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

  -- void_delivery cancels the order's drafts outright, and void_invoice cancels the delivery's own
  -- draft or unposted invoice without reversing anything, so one holding money would strand it
  -- (same refusal as void_order's ORDER_VOID_DRAFT_HAS_APPLIED_MONEY).
  IF EXISTS (
    SELECT 1 FROM invoices i
     WHERE ((i.order_id = v_delivery.order_id AND i.delivery_id IS NULL AND i.status = 'draft')
            OR (i.delivery_id = p_delivery_id AND i.status IN ('draft', 'unposted')))
       AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
       AND (COALESCE(i.paid_amount_cents, 0) <> 0 OR COALESCE(i.prepay_applied_cents, 0) <> 0
            OR COALESCE(i.write_off_cents, 0) <> 0 OR COALESCE(i.credit_applied_cents, 0) <> 0
            OR EXISTS (SELECT 1 FROM write_offs w WHERE w.invoice_id = i.id AND w.reversed_at IS NULL)
            OR EXISTS (SELECT 1 FROM invoice_line_allocations ila
                         JOIN allocation_sets aset ON aset.id = ila.allocation_set_id
                        WHERE ila.invoice_id = i.id AND aset.entity_type = 'payment' AND aset.is_active))
  ) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'DRAFT_HAS_MONEY',
      'message', 'A draft or unposted invoice on this delivery or order has a payment, prepay, credit or write-off recorded. Reverse it from the invoice page first.');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'invoice_number', i.invoice_number,
           'status', i.status,
           'total_cents', i.total_amount_cents,
           'paid_cents', COALESCE(i.paid_amount_cents, 0),
           'prepay_applied_cents', COALESCE(i.prepay_applied_cents, 0),
           -- In the plan token too, so a write-off or credit added after the preview makes it stale.
           'write_off_cents', COALESCE(i.write_off_cents, 0),
           'credit_applied_cents', COALESCE(i.credit_applied_cents, 0),
           'action', CASE WHEN i.status IN ('draft', 'unposted') THEN 'cancel' ELSE 'void' END
         ) ORDER BY i.invoice_number, i.id), '[]'::jsonb)
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
                AND i.status NOT IN ('voided', 'cancelled')
                AND (COALESCE(i.paid_amount_cents, 0) > 0 OR EXISTS (
                      -- void_invoice's own payment check (20260718221505)
                      SELECT 1 FROM invoice_line_allocations ila
                        JOIN allocation_sets aset ON aset.id = ila.allocation_set_id
                       WHERE ila.invoice_id = i.id AND aset.entity_type = 'payment' AND aset.is_active))) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'PAYMENT_APPLIED',
      'message', 'A payment is applied to this invoice. Unapply it first (the money stays on the customer''s account as credit).');
  END IF;

  -- void_invoice zeros write_off_cents but leaves the write_offs row active, which would strand it.
  IF EXISTS (SELECT 1 FROM invoices i
              WHERE i.delivery_id = p_delivery_id AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
                AND i.status NOT IN ('voided', 'cancelled')
                AND (COALESCE(i.write_off_cents, 0) <> 0
                     OR EXISTS (SELECT 1 FROM write_offs w WHERE w.invoice_id = i.id AND w.reversed_at IS NULL))) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'WRITE_OFF_RECORDED',
      'message', 'A write-off is recorded on this invoice. Reverse it from the invoice page first.');
  END IF;

  -- Voiding the delivery returns stock and reopens order lines as of today, so a delivery completed
  -- in a closed month would change that month's inventory history.
  IF EXISTS (SELECT 1 FROM deliveries d
               JOIN accounting_periods ap ON ap.status = 'closed'
                AND COALESCE((d.completed_at AT TIME ZONE 'America/Chicago')::date, d.scheduled_date) BETWEEN ap.period_start AND ap.period_end
              WHERE d.id = p_delivery_id) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'DELIVERY_IN_CLOSED_PERIOD',
      'message', 'This delivery was completed in a closed month. Reopen that month or use a return instead.');
  END IF;

  IF EXISTS (SELECT 1 FROM invoices i
               JOIN accounting_periods ap ON ap.status = 'closed' AND i.invoice_date BETWEEN ap.period_start AND ap.period_end
              WHERE i.delivery_id = p_delivery_id AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
                AND i.status IN ('posted', 'paid', 'overdue'))
     -- void_invoice also reverses each credit-memo application in that application's own month. It
     -- checks the UTC date; the business month is the Chicago date, so either one closed refuses.
     OR EXISTS (SELECT 1 FROM invoices i
                  JOIN credit_memo_applications cma ON cma.reversed_at IS NULL
                   AND (cma.credit_memo_id = i.id OR cma.target_invoice_id = i.id)
                  JOIN accounting_periods ap ON ap.status = 'closed'
                   AND (cma.applied_at::date BETWEEN ap.period_start AND ap.period_end
                        OR (cma.applied_at AT TIME ZONE 'America/Chicago')::date BETWEEN ap.period_start AND ap.period_end)
                 WHERE i.delivery_id = p_delivery_id AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
                   AND i.status IN ('draft', 'unposted', 'posted', 'paid', 'overdue')) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'CLOSED_PERIOD',
      'message', 'The invoice, or a credit applied to it, is dated in a closed month. Reopen that month or issue a credit instead.');
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

  -- The restored copy must name a user (trg_commissions_recipient_resolved, 20260722134252).
  IF v_delivery.order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commissions c
     WHERE c.order_id = v_delivery.order_id AND c.status = 'pending' AND c.deleted_at IS NULL
       AND c.recipient_user_id IS NULL
  ) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'COMMISSION_RECIPIENT_MISSING',
      'message', 'This order''s commission has no sales rep user linked. Fix the commission recipient first.');
  END IF;

  -- void_delivery also cancels the order's draft invoices that have no delivery; show them so
  -- nothing is a surprise (same scope as its auto-cancel).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number, 'total_cents', i.total_amount_cents) ORDER BY i.invoice_number, i.id), '[]'::jsonb)
    INTO v_order_drafts
    FROM invoices i
   WHERE i.order_id = v_delivery.order_id AND i.status = 'draft' AND i.deleted_at IS NULL
     AND i.invoice_type <> 'credit_memo' AND i.delivery_id IS NULL;

  -- The ids keep the plan token tied to the exact lines void_delivery reopens.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', di.id,
           'order_item_id', di.order_item_id,
           'product_id', di.product_id,
           'product_name', p.product_name,
           'quantity', di.quantity_delivered,
           'unit', COALESCE(di.unit_size, p.unit_size)
         ) ORDER BY p.product_name, di.id), '[]'::jsonb)
    INTO v_items
    FROM delivery_items di
    LEFT JOIN products p ON p.id = di.product_id
   -- What void_delivery actually puts back (20260827041300): the delivered quantity, not the planned one.
   WHERE di.delivery_id = p_delivery_id AND COALESCE(di.quantity_delivered, 0) > 0;

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
    'items', v_items,
    -- What the preview showed (including the delivery's order and customer); fix_delivery refuses when it no longer matches.
    'plan_token', md5(jsonb_build_object('order_id', v_delivery.order_id, 'customer_id', v_delivery.customer_id,
                                         'invoices', v_invoices, 'other_draft_invoices', v_order_drafts, 'items', v_items)::text)
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
  p_plan_token text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''), E' 	
');
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

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'reason', v_reason,
    'plan_token', p_plan_token
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
    -- The order drafts void_delivery will cancel, so they cannot deadlock it later.
    PERFORM 1 FROM invoices WHERE order_id = v_order_id AND delivery_id IS NULL
                              AND status IN ('draft', 'unposted') AND deleted_at IS NULL FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_BUSY_RETRY';
  END;
  -- Lock the order's pending commissions so a payout batch created meanwhile is seen by the plan
  -- below (create_commission_payment locks these same rows).
  SELECT COALESCE(array_agg(id), '{}') INTO v_pending_commission_ids
    FROM (SELECT id FROM commissions
           WHERE order_id = v_order_id AND status = 'pending' AND deleted_at IS NULL
           FOR UPDATE) c;
  -- Hold the delivery month and each applied credit's months (UTC and Chicago dates) against
  -- close_accounting_period, as check_period_open does, so the plan's closed-month checks cannot
  -- pass just before one of those months closes.
  PERFORM public._lock_accounting_months(
    ARRAY[(SELECT COALESCE((d.completed_at AT TIME ZONE 'America/Chicago')::date, d.scheduled_date)
             FROM deliveries d WHERE d.id = p_delivery_id)]
    || ARRAY(SELECT x FROM invoices i
               JOIN credit_memo_applications cma ON cma.reversed_at IS NULL
                AND (cma.credit_memo_id = i.id OR cma.target_invoice_id = i.id),
               LATERAL (VALUES (cma.applied_at::date), ((cma.applied_at AT TIME ZONE 'America/Chicago')::date)) v(x)
              WHERE i.delivery_id = p_delivery_id),
    false);

  v_plan := public._fix_delivery_plan(p_delivery_id);
  IF NOT (v_plan ->> 'can_fix')::boolean THEN
    RAISE EXCEPTION 'FIX_DELIVERY_REFUSED: %', v_plan -> 'refusals' -> 0 ->> 'message'
      USING DETAIL = (v_plan -> 'refusals')::text;
  END IF;
  IF (v_plan ->> 'plan_token') IS DISTINCT FROM p_plan_token THEN
    RAISE EXCEPTION 'FIX_DELIVERY_PREVIEW_STALE: the delivery or its invoices changed since the preview; reopen Fix delivery to see the new plan';
  END IF;

  -- This key has no receipt yet, and the inner receipts commit only with it, so an inner key
  -- already used means another request took it; void_invoice's receipt would replay that one.
  -- Any operation counts: idempotency_key is unique on its own.
  IF EXISTS (SELECT 1 FROM idempotency_keys k
              WHERE k.idempotency_key = p_idempotency_key || ':void_delivery'
                 OR k.idempotency_key IN (SELECT p_idempotency_key || ':void_invoice:' || (e ->> 'id')
                                            FROM jsonb_array_elements(v_plan -> 'invoices') e)) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH';
  END IF;

  FOR v_invoice IN SELECT e FROM jsonb_array_elements(v_plan -> 'invoices') e LOOP
    PERFORM public.void_invoice(
      (v_invoice ->> 'id')::uuid,
      'Fix delivery ' || (v_plan ->> 'delivery_number') || ': ' || v_reason,
      p_idempotency_key || ':void_invoice:' || (v_invoice ->> 'id'));
  END LOOP;

  PERFORM public.void_delivery(p_delivery_id, v_reason, v_actor, p_idempotency_key || ':void_delivery');
  -- Never report success, or restore the commission, unless the delivery really is voided now.
  IF NOT EXISTS (SELECT 1 FROM deliveries WHERE id = p_delivery_id AND status = 'voided') THEN
    RAISE EXCEPTION 'FIX_DELIVERY_NOT_VOIDED';
  END IF;

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
REVOKE ALL ON FUNCTION public.fix_delivery(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fix_delivery(uuid, text, text, text) TO authenticated, service_role;

-- Postflight: the grants above are what landed.
DO $postflight$
BEGIN
  IF has_function_privilege('anon', 'public.fix_delivery(uuid, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_fix_delivery(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fix_delivery_plan(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._fix_delivery_plan(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fix_delivery(uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FIX_DELIVERY_GRANTS_DRIFT';
  END IF;
END
$postflight$;

-- ---------------------------------------------------------------------------------------------
-- 4. Reports skip cancelled commissions. A fix leaves the cancelled original next to its pending
--    copy (cancelled rows keep their amount and cannot reopen), so summing every status counted
--    it twice; this also stops any other voided invoice's cancelled commission from counting.
--    Each body below is the live one (pinned by hash) with only its commission line changed.
-- ---------------------------------------------------------------------------------------------
DO $reports_preflight$
BEGIN
  IF encode(sha256(convert_to(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.get_monthly_summary(date,date)'::regprocedure), chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
       <> '079f77c1628821088ea02830ac12a4ae918b297419aaf8d4e4dc3e804ca96c10'
     OR encode(sha256(convert_to(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._get_bottom_line_pnl_cost_impl_20261019(date,date)'::regprocedure), chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
       <> '307c94d4e8de83c91b0b7ca680d529c6834e56ef5bc5b10c5c6d054fc1a265d2' THEN
    RAISE EXCEPTION 'FIX_DELIVERY_REPORTS_PREFLIGHT_DRIFT';
  END IF;
END
$reports_preflight$;

CREATE OR REPLACE FUNCTION public.get_monthly_summary(p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_result jsonb;
BEGIN
  PERFORM require_admin();
  SELECT jsonb_build_object(
    'period_start', p_period_start,
    'period_end', p_period_end,
    'invoices', jsonb_build_object(
      'posted_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((SELECT sum(CASE
        WHEN inv.invoice_type = 'credit_memo'
         AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = inv.id)
          THEN inv.total_cost_cents
        ELSE (SELECT COALESCE(sum(ROUND(ii.cost_cents * ii.quantity)::bigint), 0)
              FROM public.invoice_items ii WHERE ii.invoice_id = inv.id)
      END) FROM public.invoices inv WHERE inv.invoice_date BETWEEN p_period_start AND p_period_end AND inv.status IN ('posted', 'overdue', 'paid') AND inv.deleted_at IS NULL), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft', 'unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    'payments', jsonb_build_object('count', (SELECT count(*) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 'total_cents', COALESCE((SELECT sum((amount * 100)::bigint) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 0)),
    'orders', jsonb_build_object('count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)),
    'deliveries', jsonb_build_object('count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status NOT IN ('cancelled', 'voided') AND deleted_at IS NULL), 'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)),
    'applications', jsonb_build_object('count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)),
    'commissions', jsonb_build_object('earned_cents', COALESCE((SELECT sum((commission_amount * 100)::bigint) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end AND status <> 'cancelled'), 0), 'paid_count', (SELECT count(*) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end AND status = 'paid')),
    'ar_balance_cents', COALESCE((SELECT sum(balance_cents) FROM public.invoices WHERE status IN ('posted', 'overdue') AND balance_cents > 0 AND deleted_at IS NULL), 0)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._get_bottom_line_pnl_cost_impl_20261019(p_start_date date, p_end_date date)
 RETURNS TABLE(line_item text, amount numeric, pct_of_revenue numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_revenue numeric := 0;
  v_cogs numeric := 0;
  v_gross_profit numeric := 0;
  v_commissions numeric := 0;
  v_net_profit numeric := 0;
BEGIN
  SELECT
    COALESCE(SUM(i.total_amount_cents), 0) / 100.0,
    COALESCE(SUM(CASE
      WHEN i.invoice_type = 'credit_memo'
       AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = i.id)
        THEN i.total_cost_cents
      ELSE (SELECT COALESCE(SUM(ROUND(ii.cost_cents * ii.quantity)::bigint), 0)
            FROM public.invoice_items ii WHERE ii.invoice_id = i.id)
    END), 0) / 100.0
  INTO v_revenue, v_cogs
  FROM public.invoices i
  WHERE i.status IN ('posted', 'overdue', 'paid')
    AND i.invoice_date >= p_start_date
    AND i.invoice_date <= p_end_date
    AND i.deleted_at IS NULL;

  v_gross_profit := v_revenue - v_cogs;
  SELECT COALESCE(SUM(commission_amount), 0) INTO v_commissions
  FROM public.commissions
  WHERE order_date >= p_start_date AND order_date <= p_end_date AND status <> 'cancelled';
  v_net_profit := v_gross_profit - v_commissions;

  RETURN QUERY VALUES
    ('Revenue'::text, v_revenue, 100.0::numeric),
    ('Cost of Goods Sold', v_cogs, CASE WHEN v_revenue > 0 THEN ROUND(v_cogs / v_revenue * 100, 1) ELSE 0 END),
    ('Gross Profit', v_gross_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_gross_profit / v_revenue * 100, 1) ELSE 0 END),
    ('Commissions', v_commissions, CASE WHEN v_revenue > 0 THEN ROUND(v_commissions / v_revenue * 100, 1) ELSE 0 END),
    ('Net Profit', v_net_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_net_profit / v_revenue * 100, 1) ELSE 0 END);
END;
$function$;

-- Postflight: CREATE OR REPLACE kept owner, attributes and grants; only the commission line moved.
DO $reports_postflight$
DECLARE
  v_monthly text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_monthly_summary(date,date)'::regprocedure);
  v_pnl text := (SELECT prosrc FROM pg_proc WHERE oid = 'public._get_bottom_line_pnl_cost_impl_20261019(date,date)'::regprocedure);
BEGIN
  IF position('AND status <> ''cancelled''), 0)' IN v_monthly) = 0
     OR position('PERFORM require_admin();' IN v_monthly) = 0
     OR position('AND status <> ''cancelled'';' IN v_pnl) = 0
     OR NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' FROM pg_proc WHERE oid = 'public.get_monthly_summary(date,date)'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public._get_bottom_line_pnl_cost_impl_20261019(date,date)'::regprocedure)
     OR has_function_privilege('anon', 'public.get_monthly_summary(date,date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_monthly_summary(date,date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._get_bottom_line_pnl_cost_impl_20261019(date,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._get_bottom_line_pnl_cost_impl_20261019(date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FIX_DELIVERY_REPORTS_POSTFLIGHT_DRIFT';
  END IF;
END
$reports_postflight$;
