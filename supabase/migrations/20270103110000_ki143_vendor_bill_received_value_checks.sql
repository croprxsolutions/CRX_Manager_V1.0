-- KI-143: a PO-linked vendor bill is checked against what ARRIVED on the PO, not what was ordered.
-- Contract: docs/plans/2026-11-10-ki143-vendor-bill-received-value-CONTRACT.md
--
-- WHY: create_vendor_bill and update_vendor_bill compared a PO-linked bill's running total with the PO's ORDERED
--   total (+5%) and never read quantity_received, so a short shipment could be billed, and paid, in full with no
--   reason asked. (The sweep's other two claims are already enforced one layer down: the private
--   _section9_create_vendor_bill_intent_impl_20260826 refuses a PO not submitted / partially_received /
--   fully_received (PO_NOT_BILLABLE) and a bill vendor whose name differs from the PO's vendor text ignoring case
--   and outer spaces (VENDOR_PO_MISMATCH). This migration leaves that function alone.)
--
-- WHAT (signatures, grants, idempotency fingerprints and lock order unchanged; the two public wrappers only):
--   * received value = sum over the PO's lines of round(quantity_received * unit_cost * 100), the same per-line
--     rounding as purchase_orders.total_cost_cents. It is read after the PO row lock, which receiving
--     (_section9_receive_po_items_serialized: FOR UPDATE OF poi, po) also takes. Reversing a receipt changes the
--     line before it locks the PO, so a reversal racing a bill can still leave the bill above the new received
--     value (existing ordering, follow-up named in the contract).
--   * The existing confirmation + reason (PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED / _REASON_REQUIRED) is
--     required when the running total of active bills on the PO is > 0 and limit <= 0 or running total * 100 >
--     limit * 105, where limit = the smaller of received value and the ordered total once any quantity has arrived,
--     else the ordered total (Mason 2026-11-10: a bill entered before any goods arrive passes as before; billing
--     above the ordered total always needs a reason). Previously the limit was always the ordered total.
--   * The refusal DETAIL (returned only to the admin caller) keeps po_total_cents and adds received_value_cents and
--     limit_cents. The activity row text is unchanged: activity_feed is readable by every active user and PO costs
--     are admin-only, so no amounts go there. update_vendor_bill's ordered-total drift notification is unchanged.
--
-- LIVE EVIDENCE (read-only, 2026-11-10): md5(prosrc) create_vendor_bill 9f17ea87da9f2323336938e68e7ce72c and
--   update_vendor_bill 431294809e18f0c300e9f39484f2b8e8 (= repo bodies in 20261204100000 and 20260831233000);
--   0 of 6 vendor_bills have a purchase_order_id, so no existing bill changes meaning. total_cost_cents =
--   sum(round(quantity_ordered * unit_cost * 100)) on all 34 POs. purchase_order_items: quantity_received >= 0 and
--   unit_cost whole cents >= 0 (CHECKs); no line lifecycle column. vendor_bills has no INSERT/UPDATE/DELETE grant to
--   authenticated or anon; the private implementations are executable by postgres only.
--
-- idempotency-body-check: exempt -- both functions keep their p_idempotency_key handling, fingerprints and
--   receipts byte-for-byte; a refused call stores nothing and its retry is judged against current receipts.
-- caller-analysis: create_vendor_bill :: src/pages/NewVendorBill.tsx (admin, same arguments, same error codes);
--   grants unchanged (restated).
-- caller-analysis: update_vendor_bill :: src/pages/VendorBillDetail.tsx (admin, same arguments, same error codes);
--   grants unchanged (restated).
--
-- ROLLBACK (its own reviewed migration): re-create the two bodies from 20261204100000 (create_vendor_bill) and
--   20260831233000 (update_vendor_bill, as CREATE OR REPLACE). No data changes; bills saved meanwhile stay as saved.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)'))
     IS DISTINCT FROM '9f17ea87da9f2323336938e68e7ce72c' THEN
    RAISE EXCEPTION 'KI143_PREFLIGHT: create_vendor_bill is not the reviewed body (drifted or already applied)';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)'))
     IS DISTINCT FROM '431294809e18f0c300e9f39484f2b8e8' THEN
    RAISE EXCEPTION 'KI143_PREFLIGHT: update_vendor_bill is not the reviewed body (drifted or already applied)';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('create_vendor_bill', 'update_vendor_bill')) <> 2 THEN
    RAISE EXCEPTION 'KI143_PREFLIGHT: an extra create_vendor_bill / update_vendor_bill overload exists';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.create_vendor_bill(p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''::text, p_bill_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_confirm_po_overage boolean DEFAULT false, p_po_overage_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_fingerprint text;
  v_replay jsonb;
  v_bill_id uuid;
  v_candidate_total bigint;
  v_po_total bigint;
  v_active_billed_total bigint;
  v_cumulative_total bigint;
  v_overage_confirmed boolean := false;
  v_reason text := btrim(COALESCE(p_po_overage_reason, ''));
  v_received_cents bigint;
  v_limit_cents bigint;
  v_any_received boolean;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_vendor_bill requires p_idempotency_key';
  END IF;
  IF p_due_date IS NOT NULL AND p_due_date < p_bill_date THEN
    RAISE EXCEPTION 'INVALID_DUE_DATE: due date cannot precede bill date';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'vendor_id', p_vendor_id,
        'purchase_order_id', p_purchase_order_id,
        -- These nullable text inputs are passed to the mature implementation
        -- unchanged. Keep their exact SQL values in the fingerprint too:
        -- notably, NULL payment terms invoke vendor defaults while '' means an
        -- explicit empty term with the implementation's fallback due interval.
        'bill_number', p_bill_number,
        'bill_date', p_bill_date,
        'due_date', p_due_date,
        'payment_terms', p_payment_terms,
        'subtotal_cents', p_subtotal_cents,
        'adjustment_cents', COALESCE(p_adjustment_cents, 0),
        'notes', p_notes,
        'confirm_po_overage', COALESCE(p_confirm_po_overage, false),
        'po_overage_reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null'
       OR NULLIF(v_replay #>> '{result,bill_id}', '') IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay #>> '{result,bill_id}')::uuid;
  END IF;

  v_candidate_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  -- Preserve the established financial lock order used by the delegated bill
  -- implementation and supplier-cost application: vendor before optional PO.
  -- Taking the PO first here would deadlock with vendor -> PO writers.
  PERFORM 1
  FROM public.vendors v
  WHERE v.id = p_vendor_id
    AND v.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;

  IF p_purchase_order_id IS NOT NULL THEN
    SELECT po.total_cost_cents
    INTO v_po_total
    FROM public.purchase_orders po
    WHERE po.id = p_purchase_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id;
    END IF;
    -- KI-143: compare billing with what arrived (received x unit cost, rounded per line as the PO total is),
    -- read under the PO lock that receiving also takes.
    SELECT COALESCE(SUM(round(poi.quantity_received * poi.unit_cost * 100)), 0)::bigint,
           COALESCE(bool_or(poi.quantity_received > 0), false)
    INTO v_received_cents, v_any_received
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = p_purchase_order_id;
    -- Mason 2026-11-10: once any quantity has arrived (even a $0-cost line) the limit is what arrived, never above
    -- the ordered total; before that, the ordered total.
    v_limit_cents := CASE WHEN v_any_received THEN LEAST(v_received_cents, v_po_total) ELSE v_po_total END;

    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint
    INTO v_active_billed_total
    FROM public.vendor_bills vb
    WHERE vb.purchase_order_id = p_purchase_order_id
      AND vb.deleted_at IS NULL
      AND vb.status <> 'voided';

    v_cumulative_total := v_active_billed_total + v_candidate_total;
    IF v_cumulative_total > 0
       AND (v_limit_cents <= 0 OR v_cumulative_total * 100 > v_limit_cents * 105) THEN
      IF COALESCE(p_confirm_po_overage, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED'
          USING ERRCODE = '22023',
                DETAIL = jsonb_build_object(
                  'po_total_cents', v_po_total,
                  'received_value_cents', v_received_cents,
                  'limit_cents', v_limit_cents,
                  'active_billed_cents', v_active_billed_total,
                  'candidate_bill_cents', v_candidate_total,
                  'cumulative_bill_cents', v_cumulative_total
                )::text;
      END IF;
      IF v_reason = '' THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_REASON_REQUIRED';
      END IF;
      v_overage_confirmed := true;
    END IF;
  END IF;

  v_bill_id := public._section9_create_vendor_bill_cumulative_impl(
    p_vendor_id,
    p_purchase_order_id,
    p_bill_number,
    p_bill_date,
    p_due_date,
    p_payment_terms,
    p_subtotal_cents,
    p_adjustment_cents,
    p_notes,
    p_idempotency_key
  );

  UPDATE public.idempotency_keys
  SET request_fingerprint = v_fingerprint,
      request_actor_id = v_actor
  WHERE idempotency_key = p_idempotency_key
    AND operation = 'create_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;

  IF v_overage_confirmed THEN
    INSERT INTO public.activity_feed (
      event_type, description, performed_by, related_entity_type, related_entity_id
    ) VALUES (
      'po_cumulative_billing_overage_confirmed',
      'Vendor bill ' || v_bill_id::text || ' exceeded the cumulative PO billing threshold: ' || v_reason,
      v_actor,
      'purchase_order',
      p_purchase_order_id
    );
  END IF;

  RETURN v_bill_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_vendor_bill(
  p_bill_id uuid, p_subtotal_cents bigint, p_adjustment_cents bigint,
  p_bill_date date, p_due_date date, p_notes text,
  p_idempotency_key text DEFAULT NULL,
  p_confirm_po_overage boolean DEFAULT false,
  p_po_overage_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_bill public.vendor_bills%ROWTYPE;
  v_po_total_cents bigint;
  v_vendor_name text;
  v_new_total_cents bigint;
  v_other_active_billed_cents bigint;
  v_cumulative_total_cents bigint;
  v_overage_confirmed boolean := false;
  v_overage_reason text := btrim(COALESCE(p_po_overage_reason, ''));
  v_received_cents bigint;
  v_limit_cents bigint;
  v_any_received boolean;
  v_amount_drift_pct numeric;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can edit vendor bills';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_vendor_bill requires p_idempotency_key';
  END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'bill_id', p_bill_id,
    'subtotal_cents', p_subtotal_cents, 'adjustment_cents', p_adjustment_cents,
    'bill_date', p_bill_date, 'due_date', p_due_date, 'notes', p_notes,
    'confirm_po_overage', COALESCE(p_confirm_po_overage, false),
    'po_overage_reason', v_overage_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'update_vendor_bill', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;
  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;
  IF p_due_date < p_bill_date THEN
    RAISE EXCEPTION 'INVALID_DATE_RANGE: due_date cannot precede bill_date';
  END IF;
  SELECT * INTO v_bill FROM public.vendor_bills
   WHERE id = p_bill_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND'; END IF;
  -- The public wrapper must preserve the mature implementation's accounting
  -- period boundary before evaluating PO overage. Otherwise an edit to a
  -- closed-period bill can surface an overage-confirmation path even though
  -- that edit is categorically forbidden. The bill lock above serializes both
  -- checks with concurrent edits and period-close activity.
  PERFORM public.check_period_open(v_bill.bill_date);
  PERFORM public.check_period_open(p_bill_date);
  v_new_total_cents := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);
  IF v_new_total_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_new_total_cents;
  END IF;
  -- Serialize with PO lifecycle changes, then enforce the same cumulative
  -- active-billing threshold as create_vendor_bill. Exclude this bill's old
  -- total so the candidate replacement is counted exactly once.
  IF v_bill.purchase_order_id IS NOT NULL THEN
    SELECT total_cost_cents INTO v_po_total_cents
      FROM public.purchase_orders WHERE id = v_bill.purchase_order_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', v_bill.purchase_order_id;
    END IF;
    -- KI-143: the threshold is what arrived (received x unit cost), read under the PO lock receiving also takes.
    SELECT COALESCE(SUM(round(poi.quantity_received * poi.unit_cost * 100)), 0)::bigint,
           COALESCE(bool_or(poi.quantity_received > 0), false)
    INTO v_received_cents, v_any_received
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = v_bill.purchase_order_id;
    -- Mason 2026-11-10: once any quantity has arrived (even a $0-cost line) the limit is what arrived, never above
    -- the ordered total; before that, the ordered total.
    v_limit_cents := CASE WHEN v_any_received THEN LEAST(v_received_cents, v_po_total_cents) ELSE v_po_total_cents END;

    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint
    INTO v_other_active_billed_cents
    FROM public.vendor_bills vb
    WHERE vb.purchase_order_id = v_bill.purchase_order_id
      AND vb.id <> p_bill_id
      AND vb.deleted_at IS NULL
      AND vb.status <> 'voided';

    v_cumulative_total_cents := v_other_active_billed_cents + v_new_total_cents;
    IF v_cumulative_total_cents > 0
       AND (
         v_limit_cents <= 0
         OR v_cumulative_total_cents * 100 > v_limit_cents * 105
       ) THEN
      IF COALESCE(p_confirm_po_overage, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED'
          USING ERRCODE = '22023',
                DETAIL = jsonb_build_object(
                  'po_total_cents', v_po_total_cents,
                  'received_value_cents', v_received_cents,
                  'limit_cents', v_limit_cents,
                  'other_active_billed_cents', v_other_active_billed_cents,
                  'candidate_bill_cents', v_new_total_cents,
                  'cumulative_bill_cents', v_cumulative_total_cents
                )::text;
      END IF;
      IF v_overage_reason = '' THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_REASON_REQUIRED';
      END IF;
      v_overage_confirmed := true;
    END IF;

    IF v_po_total_cents > 0 THEN
      SELECT name INTO v_vendor_name FROM public.vendors WHERE id = v_bill.vendor_id;
      v_amount_drift_pct := ABS(v_new_total_cents - v_po_total_cents)::numeric / v_po_total_cents::numeric;
      IF v_amount_drift_pct > 0.05 THEN
        INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Vendor bill amount differs from PO',
          'Bill ' || COALESCE(NULLIF(v_bill.bill_number, ''), p_bill_id::text) || ' for ' || COALESCE(v_vendor_name, 'Unknown vendor') ||
          ' is $' || (v_new_total_cents / 100.0)::numeric(12,2) || ' but PO total is $' ||
          (v_po_total_cents / 100.0)::numeric(12,2) || ' (' || ROUND(v_amount_drift_pct * 100, 1) || '% drift). Verify the bill matches the PO.',
          'vendor_bill_drift', 'purchase_order', v_bill.purchase_order_id
        FROM public.profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
    END IF;
  END IF;
  v_result := public._section9_update_vendor_bill_intent_impl_20260831(
    p_bill_id, p_subtotal_cents, p_adjustment_cents, p_bill_date, p_due_date, p_notes, p_idempotency_key
  );
  UPDATE public.idempotency_keys SET request_fingerprint = v_fingerprint, request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key AND operation = 'update_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  IF v_overage_confirmed THEN
    INSERT INTO public.activity_feed (
      event_type, description, performed_by, related_entity_type, related_entity_id
    ) VALUES (
      'po_cumulative_billing_overage_confirmed',
      'Vendor bill ' || p_bill_id::text || ' edit exceeded the cumulative PO billing threshold: ' || v_overage_reason,
      v_actor,
      'purchase_order',
      v_bill.purchase_order_id
    );
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text, boolean, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text, boolean, text) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_create text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)'::regprocedure);
  v_update text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)'::regprocedure);
BEGIN
  IF position('LEAST(v_received_cents, v_po_total' IN v_create) = 0 OR position('LEAST(v_received_cents, v_po_total' IN v_update) = 0 THEN
    RAISE EXCEPTION 'KI143_POSTFLIGHT: a body is not the KI-143 body';
  END IF;
  IF has_function_privilege('anon', 'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'KI143_POSTFLIGHT: grants are not as reviewed';
  END IF;
END;
$postflight$;
