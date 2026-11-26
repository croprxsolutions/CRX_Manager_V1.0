-- Reverse of 20270310200000_unbilled_rest_and_delivery_price_carry_over.sql. Run as one transaction (psql -1).
-- Refuses unless that file's bodies are installed; then drops the view, puts back the three-argument Create Invoice chain and the
-- earlier _allocated_delivery_cents and get_dashboard_action_items bodies byte for byte, with their grants. Invoices
-- drafted meanwhile keep their cents. Proven by scripts/smoke/prove-unbilled-rest-and-carry-over-real-schema.mjs.

CREATE TEMP TABLE unbilled_rest_reverse_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $reverse_preflight$
DECLARE
  v_pin record;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.unbilled_rest_reverse_tx') IS NULL THEN
    RAISE EXCEPTION 'UNBILLED_REST_REVERSE_DRIFT: run this file as one transaction (psql -1)';
  END IF;
  IF to_regclass('public.delivery_billing_remainders') IS NULL THEN
    RAISE EXCEPTION 'UNBILLED_REST_REVERSE_DRIFT: 20270310200000 is not what is installed';
  END IF;
  FOR v_pin IN SELECT * FROM (VALUES
      ('public._allocated_delivery_cents(uuid,numeric,uuid)', '2865a1d5ed3655c847b2073d500a24a6'),
      ('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text,text)', '7acbb5d862696f7b65ccbaa2d4d4f5e6'),
      ('public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid,uuid,text,text)', '4f18fe996393549ebf7d4ee76570188d'),
      ('public.create_invoice_for_unbilled_delivery(uuid,uuid,text,text)', 'ee18d8501f94a4c34bb71831c767f0a2'),
      ('public.get_dashboard_action_items(integer)', 'eb96aacf4dfc840a22df32d6bb549aeb')) t(sig, md5)
  LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.md5 THEN
      RAISE EXCEPTION 'UNBILLED_REST_REVERSE_DRIFT: % is not the 20270310200000 body', v_pin.sig;
    END IF;
  END LOOP;
END;
$reverse_preflight$;

DROP VIEW public.delivery_billing_remainders;
DROP FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text, text);
DROP FUNCTION public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid, uuid, text, text);
DROP FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public._allocated_delivery_cents(p_order_item_id uuid, p_quantity numeric, p_exclude_invoice_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prior_qty numeric := 0;
  v_prior_cents bigint := 0;
BEGIN
  IF p_order_item_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(ii.quantity), 0), COALESCE(SUM(ii.extended_cents), 0)
    INTO v_prior_qty, v_prior_cents
    FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE ii.order_item_id = p_order_item_id
     AND inv.invoice_type <> 'credit_memo'
     AND inv.deleted_at IS NULL
     AND inv.status NOT IN ('voided', 'cancelled')
     AND (p_exclude_invoice_id IS NULL OR inv.id <> p_exclude_invoice_id);

  RETURN GREATEST(
    public._allocated_cumulative_cents(
      p_order_item_id,
      v_prior_qty + GREATEST(COALESCE(p_quantity, 0), 0)
    ) - v_prior_cents,
    0);
END;
$function$;

CREATE FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_existing jsonb; v_delivery record; v_existing_count integer;
  v_invoice_id uuid; v_invoice_number text; v_total_cents bigint := 0;
  v_cost_cents bigint := 0; v_item record; v_result jsonb;
  -- CRX-MONEY-LIFECYCLE-001: see public._allocated_delivery_cents.
  v_line_alloc_cents bigint := 0;
  v_invoice_ids uuid[];
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required to create an invoice for a delivery'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;
  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Delivery is not completed (current status: %). Only completed deliveries can be invoiced retroactively.', v_delivery.status;
  END IF;
  IF v_delivery.order_id IS NULL THEN RAISE EXCEPTION 'Delivery has no order_id — cannot auto-invoice an orphan delivery'; END IF;
  PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

  -- CODE-RABBIT FIX: child allocation inserts take a KEY SHARE lock on their
  -- parent item. Lock every item in stable id order before checking OIFA rows.
  PERFORM 1
    FROM order_items
   WHERE order_id = v_delivery.order_id
   ORDER BY id
   FOR UPDATE;

  -- The flag alone doesn't refuse a Bill Split sale: a field allocation removed after a part delivery
  -- leaves it set with no field split to bill through.
  IF ((SELECT COALESCE(needs_split_billing, false) FROM orders WHERE id = v_delivery.order_id)
      AND NOT public._order_has_bill_split(v_delivery.order_id))
     OR EXISTS (
       SELECT 1 FROM order_item_field_allocations oifa
       JOIN order_items oi ON oi.id = oifa.order_item_id
       WHERE oi.order_id = v_delivery.order_id
     ) THEN
    RAISE EXCEPTION 'ORDER_NEEDS_SPLIT_BILLING: delivery %''s order uses split billing — a single backfilled invoice would mono-bill it and mis-attribute AR. Create the split invoices through the split-billing flow instead.', v_delivery.delivery_number;
  END IF;

  SELECT COUNT(*) INTO v_existing_count FROM invoices
  WHERE order_id = v_delivery.order_id AND status NOT IN ('voided', 'cancelled')
    AND invoice_type <> 'credit_memo'
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL) AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'This delivery already has an active invoice (or an order-level invoice covers the whole order) — nothing to backfill. Find and review the existing invoice instead.';
  END IF;
  -- Billing plan M2: a Bill Split sale is drafted per payer, as completing the delivery does.
  IF public._order_has_bill_split(v_delivery.order_id) THEN
    v_invoice_ids := public._create_bill_split_delivery_invoices(
      p_delivery_id,
      -- Dated the day it runs, as a plain Create Invoice is (Mason, 2026-11-09): a rush sale billed after pricing
      -- lands in the month it was billed.
      (now() AT TIME ZONE 'America/Chicago')::date,
      v_actor);
    IF cardinality(v_invoice_ids) = 0 THEN
      RAISE EXCEPTION 'BILL_SPLIT_NOTHING_TO_BILL: delivery % delivered no quantity, so there is nothing to bill', v_delivery.delivery_number
        USING ERRCODE = 'check_violation';
    END IF;
    -- The flag stays while another completed delivery on the order is still unbilled.
    UPDATE orders SET needs_split_billing = false, updated_at = now()
     WHERE id = v_delivery.order_id AND needs_split_billing
       AND NOT EXISTS (
         SELECT 1 FROM deliveries d
          WHERE d.order_id = v_delivery.order_id AND d.id <> p_delivery_id
            AND d.status = 'completed' AND d.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM invoices i
               WHERE i.delivery_id = d.id AND i.status NOT IN ('voided', 'cancelled')
                 AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL));
    SELECT id, invoice_number INTO v_invoice_id, v_invoice_number FROM invoices WHERE id = v_invoice_ids[1];
    v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id,
      'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number, 'invoice_ids', to_jsonb(v_invoice_ids),
      'invoice_numbers', (SELECT jsonb_agg(invoice_number ORDER BY invoice_number) FROM invoices WHERE id = ANY (v_invoice_ids)),
      'total_cents', (SELECT sum(total_amount_cents) FROM invoices WHERE id = ANY (v_invoice_ids)));
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
    END IF;
    RETURN v_result;
  END IF;
  v_invoice_number := next_invoice_number('chemical_sale');
  INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, delivery_id,
    status, invoice_date, total_amount_cents, total_cost_cents, created_by)
  VALUES (v_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id,
    p_delivery_id, 'draft', (now() AT TIME ZONE 'America/Chicago')::date, 0, 0, v_actor) RETURNING id INTO v_invoice_id;
  FOR v_item IN
    SELECT di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id,
      oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name, p.product_name AS p_name
    FROM delivery_items di JOIN order_items oi ON oi.id = di.order_item_id
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id AND COALESCE(di.quantity_delivered, 0) > 0
  LOOP
    v_line_alloc_cents := public._allocated_delivery_cents(
                            v_item.order_item_id, v_item.quantity_delivered, NULL);
    v_total_cents := v_total_cents + v_line_alloc_cents;
    v_cost_cents := v_cost_cents + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
    INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents, unit_size)
    VALUES (v_invoice_id, v_item.order_item_id, v_item.product_id,
      COALESCE(v_item.oi_product_name, v_item.p_name), v_item.quantity_delivered,
      ROUND(v_item.price_per_unit * 100)::bigint,
      v_line_alloc_cents,
      ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint, v_item.unit_size);
  END LOOP;
  UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_cost_cents WHERE id = v_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description)
  VALUES ('invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('invoice_number', v_invoice_number, 'delivery_id', p_delivery_id,
      'order_id', v_delivery.order_id, 'customer_id', v_delivery.customer_id, 'total_cents', v_total_cents),
    v_total_cents, 'Invoice ' || v_invoice_number || ' backfilled for completed delivery ' || v_delivery.delivery_number);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_backfilled_for_delivery', 'Backfilled draft invoice ' || v_invoice_number ||
    ' for completed delivery ' || v_delivery.delivery_number, v_actor, 'invoice', v_invoice_id, v_delivery.customer_id);
  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id,
    'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number, 'total_cents', v_total_cents);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._create_invoice_for_unbilled_delivery_idem_impl_20260721(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request jsonb;
  v_result jsonb;
  v_is_deleted_fulfilled_recovery boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin access required to create an invoice for a delivery';
  END IF;

  v_request := jsonb_build_object(
    'version', 1,
    'delivery_id', p_delivery_id,
    'actor_id', v_actor
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key, 'create_invoice_for_unbilled_delivery'
    );
    IF v_existing IS NOT NULL THEN
      IF NOT (v_existing ? 'request' AND v_existing ? 'response') THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_FORMAT_INVALID: create_invoice_for_unbilled_delivery';
      END IF;
      IF v_existing->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: create_invoice_for_unbilled_delivery key was already used for a different delivery or actor';
      END IF;
      RETURN v_existing->'response';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.deliveries d
      JOIN public.orders o ON o.id = d.order_id
     WHERE d.id = p_delivery_id
       AND d.status = 'completed'
       AND d.deleted_at IS NULL
       AND d.customer_id = o.customer_id
       AND o.deleted_at IS NOT NULL
       AND o.status IN ('fulfilled', 'partially_fulfilled')
  ) INTO v_is_deleted_fulfilled_recovery;

  IF v_is_deleted_fulfilled_recovery THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.delivery_items di
       WHERE di.delivery_id = p_delivery_id
    ) OR EXISTS (
      SELECT 1
        FROM public.delivery_items di
        LEFT JOIN public.order_items oi ON oi.id = di.order_item_id
        JOIN public.deliveries d ON d.id = di.delivery_id
       WHERE di.delivery_id = p_delivery_id
         AND (
           oi.id IS NULL
           OR oi.order_id IS DISTINCT FROM d.order_id
           OR oi.product_id IS DISTINCT FROM di.product_id
           OR COALESCE(di.quantity_delivered, 0) <= 0
           OR di.quantity_delivered > COALESCE(di.quantity, 0)
         )
    ) THEN
      RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_ITEMS_INVALID: every historical recovery line must have matching order/product lineage and delivered quantity within its planned quantity';
    END IF;

    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'writer';
    INSERT INTO public.invoice_delivery_recovery_capabilities (
      transaction_id, purpose, delivery_id, actor_id
    ) VALUES (txid_current(), 'writer', p_delivery_id, v_actor);
  END IF;

  BEGIN
    v_result := public._create_invoice_for_unbilled_delivery_impl_20260718(
      p_delivery_id, v_actor, NULL
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'writer';
    RAISE;
  END;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'writer';

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'create_invoice_for_unbilled_delivery',
      jsonb_build_object('request', v_request, 'response', v_result)
    );
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_invoice_for_unbilled_delivery(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_for_unbilled_delivery'
      USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  RETURN public._create_invoice_for_unbilled_delivery_idem_impl_20260721(
    p_delivery_id, p_performed_by, p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_dashboard_action_items(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_items jsonb;
  v_count bigint;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  -- Each group: one filter (CTE m) feeds both the first p_limit rows and the exact count (H36).

  -- 1. Overdue Invoices
  WITH m AS (
    SELECT
      'overdue_invoice' AS category,
      i.id,
      i.invoice_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - i.due_date) AS days_overdue,
      i.balance_cents AS amount_cents
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'overdue'
      AND i.balance_cents > 0
      AND i.invoice_type <> 'credit_memo'
      AND i.deleted_at IS NULL
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT category, id, primary_text, secondary_text, days_overdue, amount_cents
      FROM m ORDER BY days_overdue DESC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('overdue_invoices', v_items);
  v_counts := v_counts || jsonb_build_object('overdue_invoices', v_count);

  -- 2. Cancelled Orders with Posted Invoices (one row per order and posted invoice, as listed)
  WITH m AS (
    SELECT
      o.id,
      o.order_number AS primary_text,
      c.farm_name AS secondary_text,
      i.invoice_number,
      o.created_at AS sort_created_at
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN invoices i ON i.order_id = o.id
      AND i.status = 'posted'
      AND i.invoice_type <> 'credit_memo'
      AND i.deleted_at IS NULL
    WHERE o.status = 'cancelled'
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, invoice_number
      FROM m ORDER BY sort_created_at DESC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('cancelled_posted', v_items);
  v_counts := v_counts || jsonb_build_object('cancelled_posted', v_count);

  -- 3. Overdue Deliveries
  WITH m AS (
    SELECT
      d.id,
      d.delivery_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - d.scheduled_date) AS days_overdue,
      d.scheduled_date AS sort_date
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.status IN ('scheduled', 'in_progress')
      AND d.scheduled_date < v_today
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, days_overdue
      FROM m ORDER BY sort_date ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('overdue_deliveries', v_items);
  v_counts := v_counts || jsonb_build_object('overdue_deliveries', v_count);

  -- 4. Low Stock Items
  WITH m AS (
    SELECT
      p.id,
      p.product_name AS primary_text,
      p.category AS secondary_text,
      COALESCE(inv.quantity_available, 0) AS current_qty,
      COALESCE(inv.reorder_point, 0) AS reorder_point,
      (COALESCE(inv.quantity_available, 0)::float / NULLIF(inv.reorder_point, 0)) AS sort_ratio
    FROM products p
    JOIN inventory inv ON inv.product_id = p.id
    WHERE p.is_active = true
      AND (
        (inv.reorder_point IS NOT NULL
          AND inv.reorder_point > 0
          AND COALESCE(inv.quantity_available, 0) < inv.reorder_point)
        OR COALESCE(inv.quantity_available, 0) < 0
      )
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, current_qty, reorder_point
      FROM m ORDER BY sort_ratio ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('low_stock', v_items);
  v_counts := v_counts || jsonb_build_object('low_stock', v_count);

  -- 5. Expiring Quotes (within 7 days)
  WITH m AS (
    SELECT
      q.id,
      q.quote_number AS primary_text,
      c.farm_name AS secondary_text,
      (q.expires_at::date - v_today) AS days_until_expiry,
      q.expires_at AS sort_expires_at
    FROM quotes q
    JOIN customers c ON c.id = q.customer_id
    WHERE q.status IN ('sent', 'revised')
      AND q.is_planned = false
      AND q.expires_at IS NOT NULL
      AND q.expires_at::date BETWEEN v_today AND (v_today + interval '7 days')
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, days_until_expiry
      FROM m ORDER BY sort_expires_at ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('expiring_quotes', v_items);
  v_counts := v_counts || jsonb_build_object('expiring_quotes', v_count);

  -- 6. Unassigned Deliveries
  WITH m AS (
    SELECT
      d.id,
      d.delivery_number AS primary_text,
      c.farm_name AS secondary_text,
      d.scheduled_date
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.status = 'scheduled'
      AND d.assigned_driver IS NULL
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, scheduled_date
      FROM m ORDER BY scheduled_date ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('unassigned_deliveries', v_items);
  v_counts := v_counts || jsonb_build_object('unassigned_deliveries', v_count);

  -- 7. Unassigned Jobs (findings #15-21/#111): a SCHEDULED job with no currently-active
  -- per-location dispatch and no legacy whole-job applicator (unchanged from 20261023090000).
  WITH m AS (
    SELECT
      j.id,
      j.job_number AS primary_text,
      c.farm_name AS secondary_text,
      j.job_date AS scheduled_date
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
    WHERE j.status = 'scheduled'
      AND j.deleted_at IS NULL
      AND j.applicator_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM job_location_dispatches d
        WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched'
      )
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, scheduled_date
      FROM m ORDER BY scheduled_date ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('unassigned_jobs', v_items);
  v_counts := v_counts || jsonb_build_object('unassigned_jobs', v_count);

  -- 8. Due-today deliveries that have not been started.
  WITH m AS (
    SELECT
      d.id,
      d.delivery_number AS primary_text,
      c.farm_name AS secondary_text,
      d.scheduled_date
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.scheduled_date = v_today
      AND d.status = 'scheduled'
      AND d.deleted_at IS NULL
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, scheduled_date
      FROM m ORDER BY primary_text ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('due_today_not_started', v_items);
  v_counts := v_counts || jsonb_build_object('due_today_not_started', v_count);

  -- 9. Completed deliveries not covered by an active delivery- or order-level invoice,
  --    and not billed outside CRX (delivery_external_billings).
  WITH m AS (
    SELECT
      d.id,
      d.delivery_number AS primary_text,
      c.farm_name AS secondary_text,
      d.scheduled_date
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.status = 'completed'
      AND d.deleted_at IS NULL
      AND d.order_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM invoices i
        WHERE i.order_id = d.order_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND (i.delivery_id = d.id OR i.delivery_id IS NULL)
          AND i.invoice_type <> 'credit_memo'
          AND i.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM delivery_external_billings b WHERE b.delivery_id = d.id
      )
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, scheduled_date
      FROM m ORDER BY scheduled_date ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('unbilled_deliveries', v_items);
  v_counts := v_counts || jsonb_build_object('unbilled_deliveries', v_count);

  RETURN v_result || jsonb_build_object('counts', v_counts);
END;
$function$;

DO $reverse_postflight$
DECLARE
  v_pin record;
BEGIN
  FOR v_pin IN SELECT * FROM (VALUES
      ('public._allocated_delivery_cents(uuid,numeric,uuid)', '401b886a577bd0d6ded65a54b74ac759'),
      ('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)', '41d6ec7fd81c96b8ab9bc1c1ae679245'),
      ('public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid,uuid,text)', '0a5997370d8e708c2bf87ba4e1b29199'),
      ('public.create_invoice_for_unbilled_delivery(uuid,uuid,text)', 'a7f2531bd09ea6c650063f9661871caa'),
      ('public.get_dashboard_action_items(integer)', 'cd2cc3c9f43d5d9eee85730e06fcfb92')) t(sig, md5)
  LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.md5 THEN
      RAISE EXCEPTION 'UNBILLED_REST_REVERSE_FAIL: % did not come back', v_pin.sig;
    END IF;
  END LOOP;
  RAISE NOTICE 'REVERSE_OK';
END;
$reverse_postflight$;
