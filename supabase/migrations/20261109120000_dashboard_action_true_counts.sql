-- Goal 4 part 4, H36: the dashboard Action Queue returns a true count for each group.
--
-- Why: get_dashboard_action_items cuts each group at p_limit (the dashboard asks for 10) and returns
-- no count, so the screen shows "Overdue Invoices (10)" when there are 37. Staff read that as the real
-- number. This re-issues the function so each group's filter is written once, in a CTE, and feeds both
-- the example rows (still ordered and cut at p_limit, unchanged) and an exact count.
--
-- Shape: every existing key and row is unchanged; one key is added, 'counts', an object with the same
-- nine group names mapped to whole numbers. A screen that does not know 'counts' ignores it, so the
-- live bundle keeps working until the screen change ships.
--
-- Read only: no table, row, grant or owner changes. CREATE OR REPLACE keeps the function's OID, owner,
-- grants (EXECUTE: authenticated, service_role), SECURITY DEFINER, search_path and the
-- require_admin_or_sales_rep() gate (office staff only, row 11.4). No cost or margin is returned.
--
-- Safety: the preflight refuses unless the live body is exactly the one 20261023090000 installed; the
-- postflight checks the new body and that owner, grants, security mode and settings did not move.

CREATE TEMP TABLE dashboard_action_true_counts_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proconfig,
       p.prorettype, p.provolatile, p.prosecdef, pg_current_xact_id()::text AS transaction_id
  FROM pg_proc p
 WHERE p.oid = to_regprocedure('public.get_dashboard_action_items(integer)');

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_temp.dashboard_action_true_counts_attrs) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.get_dashboard_action_items(integer) is missing';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.get_dashboard_action_items(integer)'))
     IS DISTINCT FROM '7f919a8d0189478cbe1e023a6c7a7e5a' THEN
    -- Already applied, or live drifted from the body 20261023090000 installed.
    RAISE EXCEPTION 'DASHBOARD_ACTION_COUNTS_BASELINE_DRIFT: get_dashboard_action_items body is not the 20261023090000 body';
  END IF;
  IF to_regprocedure('public.require_admin_or_sales_rep()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.require_admin_or_sales_rep() is missing';
  END IF;
END;
$preflight$;

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

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  SELECT md5(replace(p.prosrc, chr(13), '')) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
         p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
         a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
         a.provolatile AS was_volatile, a.prosecdef AS was_secdef, a.transaction_id
    INTO v_fn
    FROM pg_proc p
    JOIN pg_temp.dashboard_action_true_counts_attrs a ON a.fn_oid = p.oid
   WHERE p.oid = to_regprocedure('public.get_dashboard_action_items(integer)');
  IF NOT FOUND OR v_fn.transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF v_fn.body_md5 IS DISTINCT FROM 'cd2cc3c9f43d5d9eee85730e06fcfb92'
     OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
     OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
     OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
     OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
     OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
     OR v_fn.prosecdef IS DISTINCT FROM v_fn.was_secdef
     OR NOT v_fn.prosecdef THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_dashboard_action_items is not the expected body/attributes (md5 %)', v_fn.body_md5;
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: dashboard action items return true counts (H36)';
END;
$postflight$;
