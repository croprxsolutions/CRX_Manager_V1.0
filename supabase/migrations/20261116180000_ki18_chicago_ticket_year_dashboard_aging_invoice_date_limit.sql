-- KI-18: the last database dates that followed the UTC clock instead of the Chicago business day.
-- 1. generate_ticket_number: blend-ticket numbers take the Chicago year (quote, order and rebate-claim
--    numbers already do, 20261029160300). Only the v_year line changes; the lock and format are kept.
-- 2. financial_dashboard_summary: the AR-aging strip uses get_ar_aging's day ranges (0-29, 30-59,
--    60-89, 90+) on the Chicago date, so a 30-day-old invoice is in the same bucket on the Financial
--    Dashboard and the AR Aging page. Its season panels and month label read the Chicago date too.
--    JSON keys, filters, money expressions, grants and settings are unchanged.
-- 3. invoices.invoice_date: a new trigger refuses a date more than 365 days after today's Chicago
--    date (a typed year like 2206). It checks only an insert or an update that changes the date, so
--    existing rows are never touched; live has no row past the limit (2026-11-06 read: max 2026-11-05).
-- Rollback: a forward migration re-emitting the prior bodies (20261028185500, 20260812115235) and
-- dropping the trigger and its function. Never renumber tickets.
DO $preflight$
DECLARE
  v_fn record;
BEGIN
  FOR v_fn IN
    SELECT * FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('generate_ticket_number', 'financial_dashboard_summary')
  LOOP
    IF v_fn.pronargs <> 0 OR NOT v_fn.prosecdef
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres'
       OR v_fn.proacl::text IS DISTINCT FROM (CASE v_fn.proname
            WHEN 'generate_ticket_number' THEN '{postgres=X/postgres}'
            ELSE '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' END)
       OR md5(replace(v_fn.prosrc, chr(13), '')) NOT IN (CASE v_fn.proname
            WHEN 'generate_ticket_number' THEN '3b860af530432a9c1f817f3563c93a32'
            ELSE '7b7939a757ea024c1f32e2d954d20296' END,
          CASE v_fn.proname
            WHEN 'generate_ticket_number' THEN '5470af919f5bc62fcc621b44a27364c4'
            ELSE '403d5c76f557c2c0066fc333f9da786b' END) THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % body, settings, owner or grants drifted; re-review current definition', v_fn.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('generate_ticket_number', 'financial_dashboard_summary')) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: unexpected overload or missing function';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices
              WHERE invoice_date > (now() AT TIME ZONE 'America/Chicago')::date + 365) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: an invoice is already dated more than 365 days ahead; decide it before adding the limit';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.generate_ticket_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year text := extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;
  v_max bigint;
  v_next text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('crx:blend-ticket-number:' || v_year, 0));
  SELECT coalesce(max(CASE WHEN ticket_number ~ ('^BT-' || v_year || '-\d+$')
    THEN split_part(ticket_number, '-', 3)::bigint ELSE 0 END), 0)
    INTO v_max FROM public.blend_tickets;
  v_next := (v_max + 1)::text;
  RETURN 'BT-' || v_year || '-' || lpad(v_next, greatest(4, length(v_next)), '0');
END;
$$;

REVOKE ALL ON FUNCTION public.generate_ticket_number() FROM PUBLIC, anon, authenticated, service_role;

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
      SELECT c.farm_name, COALESCE(SUM(ROUND(oi.total_price, 2)), 0) AS total
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.customers c ON c.id = o.customer_id
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
        COALESCE(SUM(ROUND(oi.total_price, 2)), 0) AS total_revenue,
        COALESCE(SUM(ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2)), 0) AS total_cost,
        ROUND(
          CASE
            WHEN SUM(ROUND(oi.total_price, 2)) > 0 THEN
              ((SUM(ROUND(oi.total_price, 2)) -
                SUM(ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2))) /
                NULLIF(SUM(ROUND(oi.total_price, 2)), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct,
        COUNT(DISTINCT o.id)::int AS order_count
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      AND COALESCE(oi.pricing_pending, false) = false -- see UNPRICED RUSH LINES
        AND public.compute_season(COALESCE(o.order_date, o.created_at::date)) =
            public.compute_season(v_today)
      GROUP BY c.id, c.farm_name
      HAVING SUM(ROUND(oi.total_price, 2)) > 0
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

REVOKE ALL ON FUNCTION public.financial_dashboard_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_dashboard_summary() TO authenticated, service_role;

-- Refuses an invoice date more than 365 days after today's Chicago date. Unchanged dates pass, so a
-- writer that rewrites other columns of an old row is never blocked.
CREATE OR REPLACE FUNCTION public.refuse_far_future_invoice_date()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.invoice_date IS NOT DISTINCT FROM OLD.invoice_date THEN
    RETURN NEW;
  END IF;
  IF NEW.invoice_date > (now() AT TIME ZONE 'America/Chicago')::date + 365 THEN
    RAISE EXCEPTION 'INVOICE_DATE_TOO_FAR_AHEAD: invoice date % is more than 365 days after today; check the year', NEW.invoice_date;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.refuse_far_future_invoice_date() FROM PUBLIC, anon, authenticated, service_role;

-- zz_ so it runs after the BEFORE triggers that may set invoice_date and sees the final value; on every
-- UPDATE (not only UPDATE OF invoice_date), so a date another trigger changes is checked too.
DROP TRIGGER IF EXISTS zz_refuse_far_future_invoice_date ON public.invoices;
CREATE TRIGGER zz_refuse_far_future_invoice_date
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.refuse_far_future_invoice_date();

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  FOR v_fn IN
    SELECT * FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('generate_ticket_number', 'financial_dashboard_summary')
  LOOP
    IF v_fn.pronargs <> 0 OR NOT v_fn.prosecdef
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres'
       OR v_fn.proacl::text IS DISTINCT FROM (CASE v_fn.proname
            WHEN 'generate_ticket_number' THEN '{postgres=X/postgres}'
            ELSE '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' END)
       OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM (CASE v_fn.proname
            WHEN 'generate_ticket_number' THEN '5470af919f5bc62fcc621b44a27364c4'
            ELSE '403d5c76f557c2c0066fc333f9da786b' END) THEN
      RAISE EXCEPTION 'CONTRACT_FAIL: % replacement body, settings, owner or grants mismatch', v_fn.proname;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.invoices'::regclass
                    AND tgname = 'zz_refuse_far_future_invoice_date'
                    AND tgfoid = 'public.refuse_far_future_invoice_date()'::regprocedure
                    AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'CONTRACT_FAIL: invoice date limit trigger missing';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.refuse_far_future_invoice_date()'::regprocedure)
     IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'CONTRACT_FAIL: invoice date limit function grants';
  END IF;
  IF extract(year FROM (TIMESTAMPTZ '2027-01-01 05:59:59+00' AT TIME ZONE 'America/Chicago')::date) <> 2026
     OR extract(year FROM (TIMESTAMPTZ '2027-01-01 06:00:00+00' AT TIME ZONE 'America/Chicago')::date) <> 2027 THEN
    RAISE EXCEPTION 'CONTRACT_FAIL: Chicago year boundary assertion failed';
  END IF;
END;
$postflight$;
