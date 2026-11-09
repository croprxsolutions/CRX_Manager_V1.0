-- Written 2026-11-09. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261228100000_sales_reports_per_payer.md.
-- Re-read the live ledger before applying.
--
-- WHAT (Mason, 2026-11-06, top priority; replaces "sales reports stay under the main customer until M15"
--   in 20261215110000): sales reports credit each payer of a Bill Split sale with their share. A $1,000
--   line where the landlord pays 40% shows the farmer $600 and the landlord $400; totals stay exact.
--   Build sheet: docs/plans/2026-11-09-sales-reports-per-payer-BUILD-SHEET.md.
--   - New helper _sales_line_payers(order_item_id): one row per payer of a sale line. A line on a sale
--     with no Bill Split (_order_has_bill_split; field splits included) returns one row, the main customer,
--     with exactly the expressions the reports used before. A Bill Split line splits its rounded total
--     with _bill_split_line_shares, the rule the payers' invoices use, so the payers add up to the line
--     exactly. Quantity: the other payers' share from that rule, the taker (its first row: the main
--     customer, else the largest share) the rest of the exact quantity. Cost: each other payer's quantity
--     times the unit cost, rounded down to the cent, the taker the rest of the line's rounded cost, so
--     cost and profit totals don't move either.
--   - _get_sales_detail_report_cost_impl_20261019: one row per payer; customer and the customer filter
--     are the payer's; the invoice number is the payer's own live invoice on a Bill Split line (as before
--     on any other line).
--   - _get_sales_summary_report_cost_impl_20261019: same rows; "customer" groups by payer; line_count
--     counts sale lines (unchanged for every grouping when there is no split).
--   - financial_dashboard_summary: top_customers and bottom_customers_by_margin use each payer's share.
--     Every other section is unchanged.
--   The reports split the sale line's ordered total once; the invoices split each delivery. Where a line is
--   delivered in several parts or past its planned quantity, a payer's report share can differ from the sum of
--   their invoices by a cent per delivery; each line's total stays exact, as before (the report reads the sale).
--   Read only. The helper is STABLE, SECURITY DEFINER, owner postgres, search_path public, pg_temp, and
--   callable by no API role (only from these definer functions). The wrappers that admins and reps call
--   are not changed: cost, profit and margin stay admin-only; the dashboard stays admin-only.
--
-- NOT CHANGED: every table, policy, trigger and writer; the report wrappers, their columns and grants;
--   which sales are counted (deleted, cancelled, voided and unpriced rush lines stay out); credits and
--   returns (not subtracted, as before); the sale's date, season and rep filters.
--
-- ROLLBACK (its own reviewed migration): re-emit the three bodies from 20260812115235 (the two impls,
--   renamed in 20261019010000) and 20261121090000 (financial_dashboard_summary), then
--   DROP FUNCTION public._sales_line_payers(uuid).
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE sales_reports_per_payer_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.sales_reports_per_payer_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.sales_reports_per_payer_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'SALES_REPORTS_PER_PAYER_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._sales_line_payers(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'SALES_REPORTS_PER_PAYER_PREFLIGHT: _sales_line_payers already exists';
  END IF;
  -- The split rule this reads (20261215110000) must be live as reviewed.
  IF to_regprocedure('public._bill_split_line_shares(uuid, bigint, bigint)') IS NULL
     OR to_regprocedure('public._order_has_bill_split(uuid)') IS NULL THEN
    RAISE EXCEPTION 'SALES_REPORTS_PER_PAYER_PREFLIGHT: the Bill Split helpers (20261215110000) are not live';
  END IF;
  -- The bodies replaced or read below must be the ones this was written against (live, 2026-11-09; line endings aside).
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._get_sales_detail_report_cost_impl_20261019(date, date, uuid, uuid[], uuid, text, integer)'::regprocedure)
       IS DISTINCT FROM 'f593dc52b3248b8f7d8d6911d7d21eb9'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._get_sales_summary_report_cost_impl_20261019(text, date, date, uuid, uuid[], uuid, text, integer)'::regprocedure)
       IS DISTINCT FROM '3360945856296ac10a661e21c0b0ff83'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.financial_dashboard_summary()'::regprocedure)
       IS DISTINCT FROM '403d5c76f557c2c0066fc333f9da786b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._bill_split_line_shares(uuid, bigint, bigint)'::regprocedure)
       IS DISTINCT FROM '15c874dec13c93af012aae48b61aa2c0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._order_has_bill_split(uuid)'::regprocedure)
       IS DISTINCT FROM 'e51d27f8794007cab80f30b8a9ad00fe' THEN
    RAISE EXCEPTION 'SALES_REPORTS_PER_PAYER_PREFLIGHT: a function this replaces or reads changed since 2026-11-09; re-review';
  END IF;
END
$preflight$;

-- One row per payer of a sale line (see the header). customer_id is the payer; bill_split says whether
-- the line's sale bills other payers.
CREATE FUNCTION public._sales_line_payers(p_order_item_id uuid)
RETURNS TABLE (customer_id uuid, revenue numeric, quantity numeric, cost numeric, bill_split boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH line AS (
    SELECT oi.id,
           o.customer_id AS main,
           public._order_has_bill_split(o.id) AS split,
           ROUND(oi.total_price, 2) AS revenue,
           oi.total_units_needed AS qty,
           COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) AS unit_cost,
           ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2) AS cost
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE oi.id = p_order_item_id
  ), shares AS (
    -- The taker is the split rule's first row (it returns the taker first); rn > 1 are the other payers.
    SELECT s.customer_id, s.cents, s.units, s.rn,
           FLOOR(line.unit_cost * s.units / 10000.0 * 100) / 100 AS floor_cost
      FROM line,
           LATERAL public._bill_split_line_shares(
             line.id, (line.revenue * 100)::bigint, FLOOR(COALESCE(line.qty, 0) * 10000)::bigint
           ) WITH ORDINALITY AS s(customer_id, cents, units, rn)
     WHERE line.split
  )
  SELECT line.main, line.revenue, line.qty, line.cost, false
    FROM line
   WHERE NOT line.split
  UNION ALL
  SELECT sh.customer_id,
         ROUND(sh.cents / 100.0, 2),
         CASE WHEN sh.rn = 1
              THEN line.qty - (SELECT COALESCE(sum(o.units), 0) FROM shares o WHERE o.rn > 1) * 0.0001
              ELSE sh.units * 0.0001 END,
         ROUND(CASE WHEN sh.rn = 1
                    THEN line.cost - (SELECT COALESCE(sum(o.floor_cost), 0) FROM shares o WHERE o.rn > 1)
                    ELSE sh.floor_cost END, 2),
         true
    FROM shares sh, line;
$function$;

ALTER FUNCTION public._sales_line_payers(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sales_line_payers(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._get_sales_detail_report_cost_impl_20261019(p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_customer_ids uuid[] DEFAULT NULL::uuid[], p_sales_rep_id uuid DEFAULT NULL::uuid, p_category text DEFAULT NULL::text, p_season integer DEFAULT NULL::integer)
 RETURNS TABLE(order_date date, order_number text, customer_name text, customer_id uuid, product_name text, product_id uuid, sku text, category text, quantity numeric, unit text, unit_price numeric, total_price numeric, cost numeric, profit numeric, margin_pct numeric, sales_rep_name text, invoice_number text, season integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  -- One row per payer of each line (20261228100000): a Bill Split sale's payers each get their share.
  RETURN QUERY
  SELECT
    o.order_date,
    o.order_number,
    c.farm_name AS customer_name,
    lp.customer_id,
    oi.product_name,
    oi.product_id,
    p.sku,
    p.category,
    lp.quantity,
    oi.unit_size AS unit,
    oi.price_per_unit AS unit_price,
    lp.revenue AS total_price,
    lp.cost,
    lp.revenue - lp.cost AS profit,
    CASE
      WHEN lp.revenue > 0 THEN ROUND(((lp.revenue - lp.cost) / lp.revenue) * 100, 1)
      ELSE 0::numeric
    END AS margin_pct,
    COALESCE(rep.full_name, 'Unassigned') AS sales_rep_name,
    inv.invoice_number,
    o.season
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  CROSS JOIN LATERAL public._sales_line_payers(oi.id) lp
  JOIN public.customers c ON c.id = lp.customer_id
  JOIN public.products p ON p.id = oi.product_id
  LEFT JOIN public.profiles rep ON rep.id = o.salesman_id
  LEFT JOIN LATERAL (
    SELECT ii.invoice_id, i2.invoice_number
    FROM public.invoice_items ii
    JOIN public.invoices i2 ON i2.id = ii.invoice_id
    WHERE ii.order_item_id = oi.id
      AND i2.status NOT IN ('voided', 'cancelled')
      AND i2.invoice_type <> 'credit_memo'
      AND i2.deleted_at IS NULL
      -- A Bill Split payer's row shows that payer's own invoice.
      AND (NOT lp.bill_split OR i2.customer_id = lp.customer_id)
    ORDER BY i2.created_at DESC
    LIMIT 1
  ) inv ON true
  WHERE o.deleted_at IS NULL
    AND o.status NOT IN ('cancelled', 'voided')
    AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
    AND (p_start_date IS NULL OR o.order_date >= p_start_date)
    AND (p_end_date IS NULL OR o.order_date <= p_end_date)
    AND (p_product_id IS NULL OR oi.product_id = p_product_id)
    AND (p_customer_ids IS NULL OR lp.customer_id = ANY(p_customer_ids))
    AND (p_sales_rep_id IS NULL OR o.salesman_id = p_sales_rep_id)
    AND (p_category IS NULL OR p.category = p_category)
    AND (p_season IS NULL OR o.season = p_season)
  ORDER BY o.order_date DESC, c.farm_name, oi.product_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public._get_sales_summary_report_cost_impl_20261019(p_group_by text DEFAULT 'product'::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_customer_ids uuid[] DEFAULT NULL::uuid[], p_sales_rep_id uuid DEFAULT NULL::uuid, p_category text DEFAULT NULL::text, p_season integer DEFAULT NULL::integer)
 RETURNS TABLE(group_key text, group_id uuid, total_quantity numeric, total_revenue numeric, total_cost numeric, total_profit numeric, margin_pct numeric, order_count bigint, line_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  -- One row per payer of each line (20261228100000); line_count counts sale lines.
  RETURN QUERY
  WITH filtered AS (
    SELECT
      oi.id AS order_item_id,
      oi.product_id,
      oi.product_name,
      lp.customer_id,
      c.farm_name,
      o.salesman_id,
      COALESCE(rep.full_name, 'Unassigned') AS rep_name,
      p.category,
      o.order_date,
      o.id AS order_id,
      lp.quantity,
      lp.revenue,
      lp.cost,
      lp.revenue - lp.cost AS profit
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    CROSS JOIN LATERAL public._sales_line_payers(oi.id) lp
    JOIN public.customers c ON c.id = lp.customer_id
    JOIN public.products p ON p.id = oi.product_id
    LEFT JOIN public.profiles rep ON rep.id = o.salesman_id
    WHERE o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
    AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
      AND (p_start_date IS NULL OR o.order_date >= p_start_date)
      AND (p_end_date IS NULL OR o.order_date <= p_end_date)
      AND (p_product_id IS NULL OR oi.product_id = p_product_id)
      AND (p_customer_ids IS NULL OR lp.customer_id = ANY(p_customer_ids))
      AND (p_sales_rep_id IS NULL OR o.salesman_id = p_sales_rep_id)
      AND (p_category IS NULL OR p.category = p_category)
      AND (p_season IS NULL OR o.season = p_season)
  )
  SELECT
    CASE p_group_by
      WHEN 'product' THEN f.product_name
      WHEN 'customer' THEN f.farm_name
      WHEN 'sales_rep' THEN f.rep_name
      WHEN 'month' THEN TO_CHAR(f.order_date, 'YYYY-MM')
      WHEN 'category' THEN COALESCE(f.category, 'Uncategorized')
      ELSE f.product_name
    END AS group_key,
    CASE p_group_by
      WHEN 'product' THEN f.product_id
      WHEN 'customer' THEN f.customer_id
      WHEN 'sales_rep' THEN f.salesman_id
      ELSE NULL
    END AS group_id,
    SUM(f.quantity) AS total_quantity,
    SUM(f.revenue) AS total_revenue,
    SUM(f.cost) AS total_cost,
    SUM(f.profit) AS total_profit,
    CASE
      WHEN SUM(f.revenue) > 0 THEN ROUND((SUM(f.profit) / SUM(f.revenue)) * 100, 1)
      ELSE 0::numeric
    END AS margin_pct,
    COUNT(DISTINCT f.order_id) AS order_count,
    COUNT(DISTINCT f.order_item_id) AS line_count
  FROM filtered f
  GROUP BY
    CASE p_group_by
      WHEN 'product' THEN f.product_name
      WHEN 'customer' THEN f.farm_name
      WHEN 'sales_rep' THEN f.rep_name
      WHEN 'month' THEN TO_CHAR(f.order_date, 'YYYY-MM')
      WHEN 'category' THEN COALESCE(f.category, 'Uncategorized')
      ELSE f.product_name
    END,
    CASE p_group_by
      WHEN 'product' THEN f.product_id
      WHEN 'customer' THEN f.customer_id
      WHEN 'sales_rep' THEN f.salesman_id
      ELSE NULL
    END
  ORDER BY SUM(f.revenue) DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.financial_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  result jsonb;
  -- KI-18: the business day is America/Chicago; the session clock is UTC.
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  WITH
  -- HEADLINE (Codex P2-C): revenue/profit are aggregated item-level from the
  -- SAME canonical snapshot expression the lower CTEs use, instead of the
  -- stored orders.total_price / total_profit header columns. Those header
  -- columns drift from the snapshot basis, so the one RPC used to return a
  -- headline profit that disagreed with its own bottom_products /
  -- bottom_customers / monthly_margin sections (FinancialDashboard.tsx and
  -- FinanceSnapshotCard.tsx read the headline). Filters (deleted_at, status)
  -- and the emitted JSON keys are unchanged.
  order_agg AS (
    SELECT
      COALESCE(SUM(ROUND(oi.total_price, 2)), 0) AS total_revenue,
      COALESCE(SUM(
        ROUND(oi.total_price, 2)
        - ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2)
      ), 0) AS total_profit
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided', 'draft')
      AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
  ),
  quote_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
      COALESCE(SUM(total_price) FILTER (WHERE status IN ('draft', 'sent')), 0) AS pipeline_value
    FROM public.quotes
  ),
  -- monthly_revenue rides on the same headline basis (P2-C): it is the revenue
  -- /profit trend shown beside the headline totals, so it is aggregated
  -- item-level from the canonical snapshot expression too. Keys (month,
  -- revenue, profit), ordering, and the 12-month window are unchanged.
  monthly AS (
    SELECT jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(o.order_date, o.created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(ROUND(oi.total_price, 2)), 0) AS revenue,
        COALESCE(SUM(
          ROUND(oi.total_price, 2)
          - ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2)
        ), 0) AS profit
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) m
  ),
  top_cust AS (
    SELECT jsonb_agg(row_to_json(tc)::jsonb ORDER BY tc.total DESC) AS arr
    FROM (
      -- Item-level revenue, matching order_agg and monthly above. Reading
      -- orders.total_price here would let the top-customers panel disagree with
      -- the headline and the trend in this same payload.
      -- Each payer of a Bill Split sale gets their share (20261228100000).
      SELECT c.farm_name, COALESCE(SUM(lp.revenue), 0) AS total
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      CROSS JOIN LATERAL public._sales_line_payers(oi.id) lp
      JOIN public.customers c ON c.id = lp.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
      GROUP BY c.id, c.farm_name
      ORDER BY total DESC
      LIMIT 5
    ) tc
  ),
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0) / 100.0 AS balance
    FROM public.invoices
    WHERE status IN ('posted', 'overdue')
      AND deleted_at IS NULL
  ),
  over_credit AS (
    SELECT COUNT(*) AS cnt
    FROM public.customers c
    WHERE c.credit_limit_cents IS NOT NULL
      AND c.credit_limit_cents > 0
      AND (
        SELECT COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0)
        FROM public.invoices i
        WHERE i.customer_id = c.id
          AND i.status IN ('posted', 'overdue')
          AND i.deleted_at IS NULL
      ) > c.credit_limit_cents
  ),
  ar_aging AS (
    SELECT
      -- KI-18: the same day ranges as get_ar_aging (0-29, 30-59, 60-89, 90+) on the Chicago
      -- date, so an invoice sits in the same bucket here and on the AR Aging page. The JSON
      -- keys keep their old names (days_31_60 ...) because the screens read them by name.
      COALESCE(SUM(CASE WHEN age_days <= 29 THEN balance ELSE 0 END), 0) AS current_bucket,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 30 AND 59 THEN balance ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 60 AND 89 THEN balance ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN age_days >= 90 THEN balance ELSE 0 END), 0) AS days_90_plus
    FROM (
      SELECT
        GREATEST(i.balance_cents, 0) / 100.0 AS balance,
        (v_today - COALESCE(i.due_date, i.invoice_date))::int AS age_days
      FROM public.invoices i
      WHERE i.status IN ('posted', 'overdue')
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
    ) aged
  ),
  prepay_bal AS (
    SELECT COALESCE(SUM(prepay_balance_cents), 0) / 100.0 AS total_unallocated
    FROM public.customers
    WHERE prepay_balance_cents > 0
  ),
  commission_owed AS (
    SELECT COALESCE(SUM(commission_amount), 0) AS total_owed
    FROM public.commissions
    WHERE status = 'pending'
      AND paid_date IS NULL
  ),
  period_info AS (
    SELECT
      COALESCE(TO_CHAR(period_start, 'Mon YYYY'), TO_CHAR(v_today, 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(period_end - v_today, 0)
        ELSE (DATE_TRUNC('month', v_today) + INTERVAL '1 month' - INTERVAL '1 day')::date - v_today
      END AS days_remaining
    FROM public.accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  ),
  po_unreceived AS (
    SELECT COALESCE(SUM(
      (poi.quantity_ordered - COALESCE(poi.quantity_received, 0)) * poi.unit_cost
    ), 0) AS value
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),
  floor_inv AS (
    SELECT
      COALESCE(SUM(inv.quantity_available * COALESCE(p.current_cost, 0)), 0) AS total_value,
      COALESCE(SUM(
        GREATEST(inv.quantity_available - inv.quantity_prebooked, 0) * COALESCE(p.current_cost, 0)
      ), 0) AS free_value
    FROM public.inventory inv
    JOIN public.products p ON p.id = inv.product_id
    WHERE inv.quantity_available > 0
  ),
  committed_orders AS (
    -- Deliberately NOT rounded per line, unlike every COGS expression in this
    -- migration. This is a stock VALUATION -- what the units still owed on open
    -- orders are worth -- not a cost that has to reconcile against revenue and
    -- profit at a cents boundary. Rounding each line here would add error to a
    -- valuation for the sake of a consistency that does not apply to it. Left
    -- explicit so it is not mistaken for one of the sites the rounding sweep
    -- missed.
    SELECT COALESCE(SUM(
      oi.quantity_remaining * COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0)
    ), 0) AS value
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),
  bottom_products AS (
    SELECT jsonb_agg(row_to_json(bp)::jsonb ORDER BY bp.margin_pct ASC) AS arr
    FROM (
      SELECT
        p.product_name,
        -- ROUND(oi.total_price, 2), not quantity * price. Older rows can retain
        -- a sub-cent stored line total, so settle that stored value at the
        -- reporting boundary; recomputing quantity * price would independently
        -- re-derive sub-cent extended prices and make the
        -- product ranking, its margin and the headline disagree. One revenue
        -- basis, as with cost. (Codex round 25.)
        COALESCE(SUM(ROUND(oi.total_price, 2)), 0) AS total_revenue,
        COALESCE(SUM(ROUND(oi.total_units_needed * COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0), 2)), 0) AS total_cost,
        ROUND(
          CASE
            WHEN SUM(ROUND(oi.total_price, 2)) > 0 THEN
              ((SUM(ROUND(oi.total_price, 2)) -
                SUM(ROUND(oi.total_units_needed * COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0), 2))) /
                NULLIF(SUM(ROUND(oi.total_price, 2)), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct,
        COALESCE(SUM(oi.total_units_needed), 0) AS units_sold
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.products p ON p.id = oi.product_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
        AND public.compute_season(COALESCE(o.order_date, o.created_at::date)) =
            public.compute_season(v_today)
      GROUP BY p.id, p.product_name
      HAVING SUM(ROUND(oi.total_price, 2)) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bp
  ),
  bottom_customers AS (
    SELECT jsonb_agg(row_to_json(bc)::jsonb ORDER BY bc.margin_pct ASC) AS arr
    FROM (
      SELECT
        c.farm_name,
        -- Each payer of a Bill Split sale gets their share (20261228100000).
        COALESCE(SUM(lp.revenue), 0) AS total_revenue,
        COALESCE(SUM(lp.cost), 0) AS total_cost,
        ROUND(
          CASE
            WHEN SUM(lp.revenue) > 0 THEN
              ((SUM(lp.revenue) - SUM(lp.cost)) / NULLIF(SUM(lp.revenue), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct,
        COUNT(DISTINCT o.id)::int AS order_count
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      CROSS JOIN LATERAL public._sales_line_payers(oi.id) lp
      JOIN public.customers c ON c.id = lp.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
        AND public.compute_season(COALESCE(o.order_date, o.created_at::date)) =
            public.compute_season(v_today)
      GROUP BY c.id, c.farm_name
      HAVING SUM(lp.revenue) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bc
  ),
  monthly_margin AS (
    SELECT jsonb_agg(row_to_json(mm)::jsonb ORDER BY mm.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(o.order_date, o.created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(ROUND(oi.total_price, 2)), 0) AS revenue,
        COALESCE(SUM(ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2)), 0) AS cost,
        ROUND(
          CASE
            WHEN SUM(ROUND(oi.total_price, 2)) > 0 THEN
              ((SUM(ROUND(oi.total_price, 2)) -
                SUM(ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2))) /
                NULLIF(SUM(ROUND(oi.total_price, 2)), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) mm
  )
  SELECT jsonb_build_object(
    'total_revenue', oa.total_revenue,
    'total_profit', oa.total_profit,
    'overall_margin', CASE
      WHEN oa.total_revenue > 0 THEN ROUND((oa.total_profit / oa.total_revenue) * 100, 1)
      ELSE 0
    END,
    'quote_counts', jsonb_build_object(
      'draft', qa.draft_count,
      'sent', qa.sent_count,
      'accepted', qa.accepted_count
    ),
    'quote_pipeline_value', qa.pipeline_value,
    'monthly_revenue', COALESCE(mr.arr, '[]'::jsonb),
    'top_customers', COALESCE(tc.arr, '[]'::jsonb),
    'open_ar_balance', ar_total.balance,
    'customers_over_credit_count', oc.cnt,
    'ar_aging_buckets', jsonb_build_object(
      'current', aa.current_bucket,
      'days_31_60', aa.days_31_60,
      'days_61_90', aa.days_61_90,
      'days_90_plus', aa.days_90_plus
    ),
    'total_prepay_unallocated', pb.total_unallocated,
    'total_commission_owed', co.total_owed,
    'current_period', jsonb_build_object(
      'name', COALESCE(pi.name, TO_CHAR(v_today, 'Mon YYYY')),
      'status', COALESCE(pi.status, 'open'),
      'days_remaining', COALESCE(pi.days_remaining, 0)
    ),
    'po_unreceived_value', pour.value,
    'floor_inventory_value', fi.total_value,
    'floor_free_value', fi.free_value,
    'committed_order_value', co2.value,
    'bottom_products_by_margin', COALESCE(bpm.arr, '[]'::jsonb),
    'bottom_customers_by_margin', COALESCE(bcm.arr, '[]'::jsonb),
    'monthly_margin_trend', COALESCE(mmt.arr, '[]'::jsonb)
  ) INTO result
  FROM order_agg oa
  CROSS JOIN quote_agg qa
  CROSS JOIN monthly mr
  CROSS JOIN top_cust tc
  CROSS JOIN ar ar_total
  CROSS JOIN over_credit oc
  CROSS JOIN ar_aging aa
  CROSS JOIN prepay_bal pb
  CROSS JOIN commission_owed co
  CROSS JOIN po_unreceived pour
  CROSS JOIN floor_inv fi
  CROSS JOIN committed_orders co2
  CROSS JOIN bottom_products bpm
  CROSS JOIN bottom_customers bcm
  CROSS JOIN monthly_margin mmt
  LEFT JOIN period_info pi ON true;

  RETURN result;
END;
$function$;

-- caller-analysis: financial_dashboard_summary :: grants restated unchanged from 20261121090000 (anon and PUBLIC stay revoked, authenticated keeps EXECUTE); FinancialDashboard.tsx, FinanceSnapshotCard.tsx and DailyBrief.tsx call it as signed-in admins, unaffected
REVOKE ALL ON FUNCTION public.financial_dashboard_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_dashboard_summary() TO authenticated, service_role;
