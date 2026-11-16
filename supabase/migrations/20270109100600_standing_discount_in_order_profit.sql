-- Written 2026-11-16. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270109100600_standing_discount_in_order_profit.md.
-- Re-read the live ledger before applying.
--
-- WHY (Sol HIGH from Mason's agents, 2026-11-16, on 20270109100100_standing_grower_discount ~253): the standing
-- discount lowers the invoice total (and so the P&L), but the order-line reports still counted the undiscounted
-- line. A $100 sale at $60 cost with 10% off showed $30 profit on the invoice and P&L but $40 on the dashboard,
-- the profitability report, the sales reports, the season comparison and the sale page's profit tile.
--
-- WHAT: the discount counted is the sum of 'standing_discount' lines on a sale's chemical-sale invoices that are
-- not voided or deleted (drafts included, as these order-basis reports include sales not yet invoiced in full).
--   1. _order_item_standing_discount_20270109(order line, payer): one order line's share of those discount lines
--      (each invoice spreads its discount over its product lines exactly as the invoice does:
--      _invoice_line_tax_shares_20270109), for one payer or all. Dollars, 0 or negative.
--   2. _order_standing_discount_20270109(sale): the whole sale's discount. Dollars, 0 or negative.
--   3. Re-emitted, changes marked (discount): financial_dashboard_summary (every line revenue and profit),
--      _get_profitability_report_cost_impl_20261019 (line revenue), _sales_line_payers (each payer's revenue, which
--      the sales summary and detail reports and the dashboard's per-payer panels read), get_season_comparison
--      (revenue and profit), get_admin_cost_fields 'orders' (the sale page's profit and margin).
--
-- NOT CHANGED: orders.total_price ("Products only" on the sale page) and orders.total_profit, the stored values,
--   because commission reads total_profit (_update_order_items_impl, _close_undelivered_order_remainder_20260718):
--   commission after the discount is its own planned change. The gross sales report stays gross (before discounts).
--   Line-level profit on order_items. Untaxed, undiscounted sales give exactly the same numbers as before.
--
-- ROLLBACK (its own reviewed migration): restore the five functions to the bodies pinned below and drop the two helpers.
--
-- ORDERING: after 20270109100400_sales_tax_not_revenue (uses _invoice_line_tax_shares_20270109).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE standing_discount_in_order_profit_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.standing_discount_in_order_profit_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.standing_discount_in_order_profit_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DISCOUNT_IN_ORDER_PROFIT_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._order_item_standing_discount_20270109(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public._order_standing_discount_20270109(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'DISCOUNT_IN_ORDER_PROFIT_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._invoice_line_tax_shares_20270109(uuid)') IS NULL THEN
    RAISE EXCEPTION 'DISCOUNT_IN_ORDER_PROFIT_PREFLIGHT: 20270109100400_sales_tax_not_revenue is not applied';
  END IF;
  -- The five functions re-emitted below, exactly as staging has them (2026-11-16).
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public.financial_dashboard_summary()', '61e5eb4052cc2b6b599d799962d7678c', 0, ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']),
      ('public._get_profitability_report_cost_impl_20261019(text,date,date)', '2844268affacb636370b9525bde4e1ba', 2, ARRAY['postgres=X/postgres']),
      ('public._sales_line_payers(uuid)', '8a3b9482997e3ff21c3272343c81b93f', 0, ARRAY['postgres=X/postgres']),
      ('public.get_season_comparison(integer,integer)', 'e1cc6aaa5f7bf6839d6c658aa785f4c9', 0, ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']),
      ('public.get_admin_cost_fields(text,uuid[])', 'cda5e9b6574e4eb1583c4d8812b9e51b', 0, ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres'])
    ) AS f(name, md5, ndefaults, acl)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef
        AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl = f.acl::aclitem[]
        AND p.pronargdefaults = f.ndefaults);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'DISCOUNT_IN_ORDER_PROFIT_PREFLIGHT: drifted: %', v_bad;
  END IF;
END
$preflight$;

-- 1. One order line's share of its live invoices' standing discount -------------------------------------------------
CREATE FUNCTION public._order_item_standing_discount_20270109(p_order_item_id uuid, p_customer_id uuid DEFAULT NULL)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- the discount share inside a billed product line: its net (after discount, with tax share) less tax and extended
  -- ponytail: re-spreads each discounted invoice per call; a per-invoice cache if the dashboard ever gets slow
  SELECT round(COALESCE(sum(sh.net_cents - sh.tax_cents - b.extended_cents), 0) / 100.0, 2)
    FROM public.invoice_items b
    JOIN public.invoices i ON i.id = b.invoice_id
    CROSS JOIN LATERAL public._invoice_line_tax_shares_20270109(i.id) sh
   WHERE b.order_item_id = p_order_item_id
     AND b.product_id IS NOT NULL AND b.charge_type IS NULL
     AND sh.item_id = b.id
     AND i.invoice_type = 'chemical_sale' AND i.deleted_at IS NULL AND i.status <> 'voided'
     AND (p_customer_id IS NULL OR i.customer_id = p_customer_id)
     AND EXISTS (SELECT 1 FROM public.invoice_items d WHERE d.invoice_id = i.id AND d.charge_type = 'standing_discount');
$function$;
REVOKE ALL ON FUNCTION public._order_item_standing_discount_20270109(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._order_item_standing_discount_20270109(uuid, uuid) TO service_role;

-- 2. A whole sale's live standing discount ------------------------------------------------------------------------
CREATE FUNCTION public._order_standing_discount_20270109(p_order_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT round(COALESCE(sum(d.extended_cents), 0) / 100.0, 2)
    FROM public.invoice_items d
    JOIN public.invoices i ON i.id = d.invoice_id
   WHERE i.order_id = p_order_id
     AND d.charge_type = 'standing_discount'
     AND i.invoice_type = 'chemical_sale' AND i.deleted_at IS NULL AND i.status <> 'voided';
$function$;
REVOKE ALL ON FUNCTION public._order_standing_discount_20270109(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._order_standing_discount_20270109(uuid) TO service_role;

-- 3. The reports, re-emitted, changes marked (discount) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.financial_dashboard_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
      COALESCE(SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))), 0) AS total_revenue,
      COALESCE(SUM(
        (ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))
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
        COALESCE(SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))), 0) AS revenue,
        COALESCE(SUM(
          (ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))
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
        COALESCE(SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))), 0) AS total_revenue,
        COALESCE(SUM(ROUND(oi.total_units_needed * COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0), 2)), 0) AS total_cost,
        ROUND(
          CASE
            WHEN SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))) > 0 THEN
              ((SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))) -
                SUM(ROUND(oi.total_units_needed * COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0), 2))) /
                NULLIF(SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))), 0)) * 100
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
      HAVING SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))) > 0
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
        COALESCE(SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))), 0) AS revenue,
        COALESCE(SUM(ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2)), 0) AS cost,
        ROUND(
          CASE
            WHEN SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))) > 0 THEN
              ((SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))) -
                SUM(ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2))) /
                NULLIF(SUM((ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id))), 0)) * 100
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

CREATE OR REPLACE FUNCTION public._get_profitability_report_cost_impl_20261019(p_group_by text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS TABLE(group_key text, total_revenue numeric, total_cost numeric, total_profit numeric, margin_pct numeric, order_count bigint, units_sold numeric)
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

  IF p_group_by NOT IN ('customer', 'product', 'month') THEN
    RAISE EXCEPTION 'Invalid p_group_by: % (expected customer, product, or month)', p_group_by;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT
      CASE p_group_by
        WHEN 'customer' THEN COALESCE(c.farm_name, 'Unknown')
        WHEN 'product' THEN oi.product_name
        ELSE TO_CHAR(COALESCE(o.order_date, o.created_at::date), 'YYYY-MM')
      END AS grp,
      o.id AS order_id,
      oi.total_units_needed AS quantity,
      -- (discount) the line's share of the standing discount on its live invoices, as the P&L counts it
      (ROUND(oi.total_price, 2) + public._order_item_standing_discount_20270109(oi.id)) AS revenue,
      -- Round each LINE to whole cents before aggregating, matching
      -- get_sales_detail_report and get_sales_summary_report. Summing unrounded
      -- line costs and rounding only the group total lets a fractional quantity
      -- with a sub-cent extended cost contribute a different number here than
      -- in the sibling reports, so the reports this migration is supposed to
      -- unify would disagree on profit and margin.
      ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2) AS cost
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    LEFT JOIN public.customers c ON c.id = o.customer_id
    WHERE o.deleted_at IS NULL
      -- Same inclusion rule as every other order-basis report in this
      -- migration. An allowlist here would silently disagree with the sales
      -- reports and the dashboard whenever a new order status is introduced.
      AND o.status NOT IN ('cancelled', 'voided', 'draft')
      AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
      -- Same effective date the month grouping uses. Filtering on the raw
      -- o.order_date while grouping on the COALESCE would drop every order with
      -- a NULL order_date the moment a caller supplies a date range, so those
      -- orders would appear in the unfiltered report and silently vanish from a
      -- filtered one.
      AND (p_start_date IS NULL OR COALESCE(o.order_date, o.created_at::date) >= p_start_date)
      AND (p_end_date IS NULL OR COALESCE(o.order_date, o.created_at::date) <= p_end_date)
  )
  SELECT
    f.grp AS group_key,
    ROUND(SUM(f.revenue)::numeric, 2) AS total_revenue,
    ROUND(SUM(f.cost)::numeric, 2) AS total_cost,
    ROUND(SUM(f.revenue - f.cost)::numeric, 2) AS total_profit,
    CASE
      WHEN SUM(f.revenue) > 0 THEN ROUND((SUM(f.revenue - f.cost) / SUM(f.revenue)) * 100, 1)
      ELSE 0::numeric
    END AS margin_pct,
    COUNT(DISTINCT f.order_id) AS order_count,
    ROUND(SUM(f.quantity)::numeric, 2) AS units_sold
  FROM filtered f
  GROUP BY f.grp
  ORDER BY SUM(f.revenue) DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public._sales_line_payers(p_order_item_id uuid)
 RETURNS TABLE(customer_id uuid, revenue numeric, quantity numeric, cost numeric, bill_split boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
  -- (discount) each payer's revenue is net of the standing discount on that payer's live invoices for this line
  SELECT line.main, line.revenue + public._order_item_standing_discount_20270109(line.id, NULL), line.qty, line.cost, false
    FROM line
   WHERE NOT line.split
  UNION ALL
  SELECT sh.customer_id,
         ROUND(sh.cents / 100.0, 2) + public._order_item_standing_discount_20270109(line.id, sh.customer_id),
         CASE WHEN sh.rn = 1
              THEN line.qty - (SELECT COALESCE(sum(o.units), 0) FROM shares o WHERE o.rn > 1) * 0.0001
              ELSE sh.units * 0.0001 END,
         ROUND(CASE WHEN sh.rn = 1
                    THEN line.cost - (SELECT COALESCE(sum(o.floor_cost), 0) FROM shares o WHERE o.rn > 1)
                    ELSE sh.floor_cost END, 2),
         true
    FROM shares sh, line
   -- Like the invoices, a payer whose share is 0 cents and 0 units gets no row (its cost share is 0 too).
   WHERE sh.rn = 1 OR sh.cents <> 0 OR sh.units <> 0;
$function$;

CREATE OR REPLACE FUNCTION public.get_season_comparison(p_season_a integer, p_season_b integer)
 RETURNS TABLE(metric text, season_a_val numeric, season_b_val numeric, change_pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a_start date;
  v_a_end date;
  v_b_start date;
  v_b_end date;
  v_a_revenue numeric;
  v_b_revenue numeric;
  v_a_profit numeric;
  v_b_profit numeric;
  v_a_orders int;
  v_b_orders int;
  v_a_customers int;
  v_b_customers int;
BEGIN
  PERFORM require_admin();
  v_a_start := season_start_date(p_season_a);
  v_a_end   := season_end_date(p_season_a);
  v_b_start := season_start_date(p_season_b);
  v_b_end   := season_end_date(p_season_b);

  -- (discount) net of the standing discount on each sale's live invoices, as the P&L counts it
  SELECT COALESCE(SUM(total_price + public._order_standing_discount_20270109(id)), 0),
         COALESCE(SUM(total_profit + public._order_standing_discount_20270109(id)), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_a_revenue, v_a_profit, v_a_orders, v_a_customers
  FROM orders
  WHERE order_date BETWEEN v_a_start AND v_a_end
    AND status <> 'cancelled';

  -- (discount) net of the standing discount on each sale's live invoices, as the P&L counts it
  SELECT COALESCE(SUM(total_price + public._order_standing_discount_20270109(id)), 0),
         COALESCE(SUM(total_profit + public._order_standing_discount_20270109(id)), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_b_revenue, v_b_profit, v_b_orders, v_b_customers
  FROM orders
  WHERE order_date BETWEEN v_b_start AND v_b_end
    AND status <> 'cancelled';

  RETURN QUERY VALUES
    ('Revenue'::text, v_a_revenue, v_b_revenue,
      CASE WHEN v_b_revenue > 0 THEN ROUND((v_a_revenue - v_b_revenue) / v_b_revenue * 100, 1) ELSE NULL END),
    ('Profit'::text, v_a_profit, v_b_profit,
      CASE WHEN v_b_profit > 0 THEN ROUND((v_a_profit - v_b_profit) / v_b_profit * 100, 1) ELSE NULL END),
    ('Orders'::text, v_a_orders::numeric, v_b_orders::numeric,
      CASE WHEN v_b_orders > 0 THEN ROUND((v_a_orders - v_b_orders)::numeric / v_b_orders * 100, 1) ELSE NULL END),
    ('Active Customers'::text, v_a_customers::numeric, v_b_customers::numeric,
      CASE WHEN v_b_customers > 0 THEN ROUND((v_a_customers - v_b_customers)::numeric / v_b_customers * 100, 1) ELSE NULL END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_cost_fields(p_table text, p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN '{}'::jsonb;
  END IF;
  IF cardinality(p_ids) > 5000 THEN
    RAISE EXCEPTION 'COST_FIELDS_TOO_MANY_IDS: ask for at most 5000 rows at a time';
  END IF;

  CASE p_table
    WHEN 'products' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'current_cost', t.current_cost, 'cost_updated_date', t.cost_updated_date,
               'tier1_margin', t.tier1_margin, 'tier2_margin', t.tier2_margin, 'tier3_margin', t.tier3_margin,
               'tier1_gross_margin', t.tier1_gross_margin, 'tier2_gross_margin', t.tier2_gross_margin,
               'tier3_gross_margin', t.tier3_gross_margin))
        INTO v_out FROM public.products t WHERE t.id = ANY(p_ids);
    WHEN 'quotes' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'total_cost', t.total_cost, 'total_profit', t.total_profit, 'total_margin_pct', t.total_margin_pct))
        INTO v_out FROM public.quotes t WHERE t.id = ANY(p_ids);
    WHEN 'quote_items' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'current_cost', t.current_cost, 'profit', t.profit, 'net_margin', t.net_margin,
               'cost_at_quote_cents', t.cost_at_quote_cents))
        INTO v_out FROM public.quote_items t WHERE t.id = ANY(p_ids);
    WHEN 'orders' THEN
      -- (discount) a sale's profit and margin are net of the standing discount on its live invoices, as the P&L
      -- counts it. orders.total_profit itself is unchanged: commission reads it (commission after the discount is
      -- its own change).
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'total_cost', t.total_cost,
               'total_profit', t.total_profit + d.cents,
               -- margin on what is billed after the discount (Luna MED)
               'total_margin_pct', CASE WHEN t.total_price + d.cents > 0
                                        THEN ROUND((t.total_profit + d.cents) / (t.total_price + d.cents) * 100, 2)
                                        ELSE t.total_margin_pct END))
        INTO v_out
        FROM public.orders t
        CROSS JOIN LATERAL (SELECT public._order_standing_discount_20270109(t.id) AS cents) d
       WHERE t.id = ANY(p_ids);
    WHEN 'order_items' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'cost_per_unit', t.cost_per_unit, 'profit', t.profit, 'net_margin', t.net_margin,
               'cost_at_time_cents', t.cost_at_time_cents))
        INTO v_out FROM public.order_items t WHERE t.id = ANY(p_ids);
    WHEN 'invoices' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('total_cost_cents', t.total_cost_cents))
        INTO v_out FROM public.invoices t WHERE t.id = ANY(p_ids);
    WHEN 'invoice_items' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'cost_cents', t.cost_cents, 'return_credit_cogs_cents', t.return_credit_cogs_cents))
        INTO v_out FROM public.invoice_items t WHERE t.id = ANY(p_ids);
    WHEN 'jobs' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('total_cost_cents', t.total_cost_cents))
        INTO v_out FROM public.jobs t WHERE t.id = ANY(p_ids);
    WHEN 'job_chemicals' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('cost_per_unit_cents', t.cost_per_unit_cents))
        INTO v_out FROM public.job_chemicals t WHERE t.id = ANY(p_ids);
    WHEN 'purchase_orders' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('total_cost', t.total_cost, 'total_cost_cents', t.total_cost_cents))
        INTO v_out FROM public.purchase_orders t WHERE t.id = ANY(p_ids);
    WHEN 'purchase_order_items' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('unit_cost', t.unit_cost, 'unit_cost_cents', t.unit_cost_cents))
        INTO v_out FROM public.purchase_order_items t WHERE t.id = ANY(p_ids);
    WHEN 'blend_ticket_products' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('unit_cost_cents', t.unit_cost_cents))
        INTO v_out FROM public.blend_ticket_products t WHERE t.id = ANY(p_ids);
    WHEN 'commissions' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('order_profit', t.order_profit))
        INTO v_out FROM public.commissions t WHERE t.id = ANY(p_ids);
    ELSE
      RAISE EXCEPTION 'COST_FIELDS_UNKNOWN_TABLE: %', p_table;
  END CASE;

  RETURN COALESCE(v_out, '{}'::jsonb);
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT proacl FROM pg_proc WHERE oid = 'public._order_item_standing_discount_20270109(uuid,uuid)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._order_standing_discount_20270109(uuid)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public.financial_dashboard_summary()'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._get_profitability_report_cost_impl_20261019(text,date,date)'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._sales_line_payers(uuid)'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public.get_season_comparison(integer,integer)'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public.get_admin_cost_fields(text,uuid[])'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'DISCOUNT_IN_ORDER_PROFIT_POSTFLIGHT: grants drifted';
  END IF;
END
$postflight$;
