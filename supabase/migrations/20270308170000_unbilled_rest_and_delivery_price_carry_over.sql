-- A4 + delivery price carry-over (Mason, Slack 25 Nov; plan docs/research/2026-11-25-chemical-sales-final-plan.md,
-- "Billing what was delivered" and "Multi-delivery price").
--
-- 1. Carry-over. _allocated_delivery_cents priced a delivery's units as the line's allocation through every billed
--    unit MINUS the cents already billed, so a price change on one delivery's invoice was charged back on the next:
--    10 at $40, the first 6 billed at $35 ($210), the last 4 drafted at $190, not $160. It now telescopes on billed
--    QUANTITY: allocation through (billed + these) minus allocation through billed. Each delivery's units carry
--    their own share of the order line; repeated partial deliveries still sum to the line total exactly, a void still
--    frees its units, and nothing is caught up from another invoice, up or down. Every caller is fixed at once:
--    completion's auto-draft, its partial refresh, Create Invoice on a delivery and the Bill Split drafts.
-- 2. A4. The Unbilled list counted a delivery billed once any active invoice touched it: 10 delivered, the line
--    lowered to 6, and 4 units were never billed. delivery_billing_remainders compares delivered and billed units
--    per delivery and order line, matched by product as the invoice caps match (whole-order invoice lines cover the
--    order's deliveries in completion order). get_dashboard_action_items lists a delivery while any of its units is
--    unbilled, and Create Invoice on such a delivery drafts exactly the rest (units, and cents through _allocated_delivery_cents) on a new draft: on the
--    delivery, or on the order when a whole-order invoice covers it (a delivery invoice beside it is refused).
--    A Bill Split sale is refused with BILL_SPLIT_REST_NOT_SUPPORTED (redraft it by voiding its group); a field
--    split stays refused as before (ORDER_NEEDS_SPLIT_BILLING).
-- Nothing is rewritten: invoices drafted before this file keep their cents.
--
-- actor-binding-check: exempt -- _create_invoice_for_unbilled_delivery_impl_20260718 is an internal _impl with
--   EXECUTE revoked from every client role; it still binds p_performed_by to auth.uid() itself (unchanged lines).
-- idempotency-body-check: exempt -- the key handling (check_idempotency / save_idempotency) is unchanged.
-- caller-analysis: _allocated_delivery_cents :: same signature, result and grants; callers
--   _complete_delivery_authorized_impl_20270122, _create_invoice_for_unbilled_delivery_impl_20260718,
--   _create_bill_split_delivery_invoices get the same cents unless an earlier invoice's line price was changed.
--   _create_invoice_for_unbilled_delivery_impl_20260718 :: same signature and result keys plus billed_rest.
--   get_dashboard_action_items :: same signature and shape; unbilled_deliveries also lists short-billed deliveries.
--
-- ROLLBACK: scripts/smoke/unbilled-rest-and-carry-over-reverse.sql (proven by
--   scripts/smoke/prove-unbilled-rest-and-carry-over-real-schema.mjs).

CREATE TEMP TABLE unbilled_rest_carry_over_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.unbilled_rest_carry_over_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.unbilled_rest_carry_over_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regclass('public.delivery_billing_remainders') IS NOT NULL THEN
    RAISE EXCEPTION 'UNBILLED_REST_BASELINE_DRIFT: delivery_billing_remainders already exists (already applied?)';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._allocated_delivery_cents(uuid,numeric,uuid)'))
     IS DISTINCT FROM '401b886a577bd0d6ded65a54b74ac759' THEN
    RAISE EXCEPTION 'UNBILLED_REST_BASELINE_DRIFT: _allocated_delivery_cents is not the 20260827041100 body';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)'))
     IS DISTINCT FROM '41d6ec7fd81c96b8ab9bc1c1ae679245' THEN
    RAISE EXCEPTION 'UNBILLED_REST_BASELINE_DRIFT: _create_invoice_for_unbilled_delivery_impl_20260718 is not the 20261215110000 body';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_dashboard_action_items(integer)'))
     IS DISTINCT FROM 'cd2cc3c9f43d5d9eee85730e06fcfb92' THEN
    RAISE EXCEPTION 'UNBILLED_REST_BASELINE_DRIFT: get_dashboard_action_items is not the 20261109120000 body';
  END IF;
END;
$preflight$;

-- One row per completed delivery and order line: units delivered, units billed, the units not billed yet and the
-- cents billing them would add. Billing is matched by product, as the invoice caps do (_delivery_invoice_overbilling,
-- _order_invoice_overbilling): a line the invoice editor adds carries no order line. A delivery's own active sale
-- lines cover its order lines of that product first; the order's whole-order sale lines then cover its deliveries of
-- that product in completion order. Credit memos never count as billing. The cents use the order line's allocation
-- (_allocated_cumulative_cents, inlined so a reader needs no EXECUTE on it), counted from the units already billed on
-- that order line, the way _allocated_delivery_cents prices the draft.
-- security_invoker: each reader sees only the rows the policies on these tables let them read.
CREATE VIEW public.delivery_billing_remainders WITH (security_invoker = true) AS
WITH delivered AS (
  SELECT d.id AS delivery_id, d.order_id, d.completed_at, di.order_item_id, di.product_id,
         sum(round(COALESCE(di.quantity_delivered, 0), 4)) AS delivered_qty
    FROM public.deliveries d
    JOIN public.delivery_items di ON di.delivery_id = d.id
   WHERE d.status = 'completed' AND d.deleted_at IS NULL
     AND d.order_id IS NOT NULL AND di.order_item_id IS NOT NULL
   GROUP BY d.id, d.order_id, d.completed_at, di.order_item_id, di.product_id
), sale_lines AS (
  SELECT i.order_id, i.delivery_id, ii.order_item_id, ii.product_id, ii.quantity
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
     AND i.status NOT IN ('voided', 'cancelled')
     AND ii.product_id IS NOT NULL AND i.order_id IS NOT NULL
), own_pool AS (
  SELECT s.delivery_id, s.product_id, sum(s.quantity) AS qty
    FROM sale_lines s WHERE s.delivery_id IS NOT NULL GROUP BY s.delivery_id, s.product_id
), order_pool AS (
  SELECT s.order_id, s.product_id, sum(s.quantity) AS qty
    FROM sale_lines s WHERE s.delivery_id IS NULL GROUP BY s.order_id, s.product_id
), own AS (
  SELECT dl.delivery_id, dl.order_id, dl.completed_at, dl.order_item_id, dl.product_id, dl.delivered_qty,
         LEAST(dl.delivered_qty, GREATEST(COALESCE(op.qty, 0) - COALESCE(sum(dl.delivered_qty)
           OVER (PARTITION BY dl.delivery_id, dl.product_id ORDER BY dl.order_item_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0)) AS own_billed,
         COALESCE(wp.qty, 0) AS order_level_billed
    FROM delivered dl
    LEFT JOIN own_pool op ON op.delivery_id = dl.delivery_id AND op.product_id = dl.product_id
    LEFT JOIN order_pool wp ON wp.order_id = dl.order_id AND wp.product_id = dl.product_id
), covered AS (
  SELECT o.delivery_id, o.order_id, o.order_item_id, o.delivered_qty,
         o.own_billed + LEAST(o.delivered_qty - o.own_billed, GREATEST(o.order_level_billed - COALESCE(sum(o.delivered_qty - o.own_billed)
           OVER (PARTITION BY o.order_id, o.product_id ORDER BY o.completed_at, o.delivery_id, o.order_item_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0)) AS billed_qty
    FROM own o
), line_billed AS (
  SELECT s.order_item_id, sum(s.quantity) AS billed_qty
    FROM sale_lines s WHERE s.order_item_id IS NOT NULL GROUP BY s.order_item_id
)
SELECT c.delivery_id, c.order_id, c.order_item_id, c.delivered_qty, c.billed_qty,
       c.delivered_qty - c.billed_qty AS unbilled_qty,
       GREATEST(x.cents, 0) AS unbilled_cents
  FROM covered c
  JOIN public.order_items oi ON oi.id = c.order_item_id
  LEFT JOIN line_billed lb ON lb.order_item_id = c.order_item_id
  CROSS JOIN LATERAL (
    SELECT sum(v.sign * CASE
             WHEN COALESCE(oi.total_units_needed, 0) <= 0 THEN round(GREATEST(v.qty, 0) * COALESCE(oi.price_per_unit, 0) * 100)
             ELSE round(round(COALESCE(oi.total_price, 0) * 100) * LEAST(GREATEST(v.qty, 0), oi.total_units_needed) / oi.total_units_needed)
           END)::bigint AS cents
      FROM (VALUES (COALESCE(lb.billed_qty, 0) + c.delivered_qty - c.billed_qty, 1),
                   (COALESCE(lb.billed_qty, 0), -1)) v(qty, sign)
  ) x;
REVOKE ALL ON public.delivery_billing_remainders FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.delivery_billing_remainders TO authenticated, service_role;
COMMENT ON VIEW public.delivery_billing_remainders IS
  'A4: per completed delivery and order line, units delivered, billed (own invoices, then whole-order invoices in completion order) and not billed, with the cents billing them would add. Read under the reader''s own row policies (security_invoker).';

CREATE OR REPLACE FUNCTION public._allocated_delivery_cents(p_order_item_id uuid, p_quantity numeric, p_exclude_invoice_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prior_qty numeric := 0;
BEGIN
  IF p_order_item_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(ii.quantity), 0)
    INTO v_prior_qty
    FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE ii.order_item_id = p_order_item_id
     AND inv.invoice_type <> 'credit_memo'
     AND inv.deleted_at IS NULL
     AND inv.status NOT IN ('voided', 'cancelled')
     AND (p_exclude_invoice_id IS NULL OR inv.id <> p_exclude_invoice_id);

  -- These units' share of the order line: the allocation through the units billed so far plus these, minus the
  -- allocation through the units billed so far. Telescoping on billed QUANTITY keeps partial deliveries summing to
  -- the line total exactly; a price changed on another invoice's line stays on that invoice (it is never caught up
  -- here, up or down).
  RETURN GREATEST(
    public._allocated_cumulative_cents(
      p_order_item_id,
      v_prior_qty + GREATEST(COALESCE(p_quantity, 0), 0)
    ) - public._allocated_cumulative_cents(p_order_item_id, v_prior_qty),
    0);
END;
$function$
;

REVOKE ALL ON FUNCTION public._allocated_delivery_cents(uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
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
  -- A4: true when this bills the units an active invoice left unbilled; v_order_level when a whole-order invoice
  -- covers the order, so the rest is billed on the order too.
  v_rest boolean := false;
  v_order_level boolean := false;
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
    -- A4 (Mason, 2026-11-25): an invoice that bills fewer units than the delivery delivered leaves the rest on
    -- Unbilled; this bills exactly that rest on a new draft (delivery_billing_remainders).
    IF NOT EXISTS (SELECT 1 FROM public.delivery_billing_remainders r
                    WHERE r.delivery_id = p_delivery_id AND r.unbilled_qty > 0) THEN
      RAISE EXCEPTION 'This delivery already has an active invoice (or an order-level invoice covers the whole order) — nothing to backfill. Find and review the existing invoice instead.';
    END IF;
    IF public._order_has_bill_split(v_delivery.order_id) THEN
      RAISE EXCEPTION 'BILL_SPLIT_REST_NOT_SUPPORTED: delivery % is billed per payer and part of it is not billed yet; void its Bill Split invoices, then Create Invoice bills it again in full', v_delivery.delivery_number
        USING ERRCODE = 'check_violation';
    END IF;
    v_rest := true;
    -- Beside a whole-order invoice a delivery invoice is refused (ORDER_INVOICE_OVERLAPS_DELIVERY_INVOICE).
    v_order_level := EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.order_id = v_delivery.order_id AND i.delivery_id IS NULL
         AND i.status NOT IN ('voided', 'cancelled') AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL);
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
    CASE WHEN v_order_level THEN NULL ELSE p_delivery_id END, 'draft', (now() AT TIME ZONE 'America/Chicago')::date, 0, 0, v_actor) RETURNING id INTO v_invoice_id;
  FOR v_item IN
    SELECT di.product_id,
      CASE WHEN v_rest THEN r.unbilled_qty ELSE di.quantity_delivered END AS quantity_delivered,
      di.unit_size, di.order_item_id,
      oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name, p.product_name AS p_name
    FROM delivery_items di JOIN order_items oi ON oi.id = di.order_item_id
    JOIN products p ON p.id = di.product_id
    LEFT JOIN public.delivery_billing_remainders r
      ON v_rest AND r.delivery_id = di.delivery_id AND r.order_item_id = di.order_item_id
    WHERE di.delivery_id = p_delivery_id
      AND COALESCE(CASE WHEN v_rest THEN r.unbilled_qty ELSE di.quantity_delivered END, 0) > 0
      -- The rest is one line per order line, on the delivery's first row for it.
      AND (NOT v_rest OR di.id = (SELECT d2.id FROM delivery_items d2
                                   WHERE d2.delivery_id = p_delivery_id AND d2.order_item_id = di.order_item_id
                                   ORDER BY d2.id LIMIT 1))
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
      'order_id', v_delivery.order_id, 'customer_id', v_delivery.customer_id, 'total_cents', v_total_cents, 'billed_rest', v_rest),
    v_total_cents, 'Invoice ' || v_invoice_number
      || CASE WHEN v_rest THEN ' bills the unbilled rest of completed delivery ' ELSE ' backfilled for completed delivery ' END
      || v_delivery.delivery_number);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_backfilled_for_delivery', CASE WHEN v_rest THEN 'Drafted invoice ' || v_invoice_number || ' for the unbilled rest of'
      ELSE 'Backfilled draft invoice ' || v_invoice_number || ' for' END ||
    ' completed delivery ' || v_delivery.delivery_number, v_actor, 'invoice', v_invoice_id, v_delivery.customer_id);
  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id,
    'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number, 'total_cents', v_total_cents,
    'billed_rest', v_rest);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
  END IF;
  RETURN v_result;
END;
$function$
;

REVOKE ALL ON FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

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

  -- 9. Completed deliveries not covered by an active delivery- or order-level invoice, or with delivered units
  --    those invoices leave unbilled (A4, delivery_billing_remainders), and not billed outside CRX
  --    (delivery_external_billings).
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
      AND (NOT EXISTS (
        SELECT 1
        FROM invoices i
        WHERE i.order_id = d.order_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND (i.delivery_id = d.id OR i.delivery_id IS NULL)
          AND i.invoice_type <> 'credit_memo'
          AND i.deleted_at IS NULL
      ) OR d.id IN (SELECT r.delivery_id FROM public.delivery_billing_remainders r WHERE r.unbilled_qty > 0))
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
$function$
;

REVOKE ALL ON FUNCTION public.get_dashboard_action_items(integer) FROM PUBLIC, anon;

DO $postflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._allocated_delivery_cents(uuid,numeric,uuid)'::regprocedure)
       IS DISTINCT FROM '280399d95c5581d3114e1673580d3fba'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)'::regprocedure)
       IS DISTINCT FROM '82345065b9453bd66bf70de59e66bed4'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.get_dashboard_action_items(integer)'::regprocedure)
       IS DISTINCT FROM 'eb96aacf4dfc840a22df32d6bb549aeb' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a function is not this file''s body';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public._allocated_delivery_cents(uuid,numeric,uuid)'::regprocedure
              AND (prosecdef OR provolatile <> 's' OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)'::regprocedure,
                                                    'public.get_dashboard_action_items(integer)'::regprocedure)
                 AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']))
     OR has_function_privilege('anon', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_dashboard_action_items(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_dashboard_action_items(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: security settings or grants drifted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.delivery_billing_remainders'::regclass
                  AND c.reloptions @> ARRAY['security_invoker=true'])
     OR has_table_privilege('anon', 'public.delivery_billing_remainders', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.delivery_billing_remainders', 'SELECT')
     OR has_table_privilege('authenticated', 'public.delivery_billing_remainders', 'INSERT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: delivery_billing_remainders must be a security_invoker view readable by authenticated only';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
