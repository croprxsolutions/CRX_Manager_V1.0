-- KI-18 batch 2: boards, dashboards and reports take "today" from the Chicago date.
-- The live database clock is UTC, so CURRENT_DATE is tomorrow from 6 pm (CST) / 7 pm (CDT) Central
-- until midnight Central: every evening the boards showed tomorrow's work as "today", the morning recap
-- read the wrong "yesterday", and day counts were off by one. Each function below is its live definition
-- (2026-11-06, md5 checked) with only CURRENT_DATE replaced by (now() AT TIME ZONE 'America/Chicago')::date,
-- the expression the invoice_date and order_date defaults already use. The database timezone stays UTC.
-- Where a timestamp is compared with that date, it is read on the Chicago calendar too:
-- get_call_list_stale_quotes (quote age from updated_at), get_customer_summary (season deliveries by
-- completed_at), get_receiving_summary (week and season receipts by received_at), and
-- operational_dashboard_summary (this month's and the season's orders and deliveries, and the 12-month
-- order, delivery and receiving charts), so an event on the evening of the last day of a month or season
-- stays in that month or season.
-- Access (Mason, 2026-11-06): get_expiring_planned_holds and get_inventory_forecast feed admin and
-- sales-rep screens only, but any signed-in user could call them and read customer holds or the
-- business-wide stock forecast. Both now refuse anyone but an active admin or sales rep (the same check
-- _get_customer_statement_scoped_impl uses). EXECUTE grants are unchanged.
--   * dashboards: operational_dashboard_summary (also its accounting-period name and days left, which read
--     NOW() and now read the Chicago wall clock, so the month does not roll early on the last evening),
--     get_customer_summary, get_receiving_summary
--   * boards and lists: get_dispatch_board_jobs, get_dispatched_list, get_team_board_deliveries,
--     get_team_workload, get_yesterday_delivery_recap, get_call_list_stale_quotes
--   * stock outlook: get_expiring_planned_holds, get_inventory_forecast
--   * statement date range defaults (bodies unchanged): get_customer_statement,
--     _get_customer_statement_scoped_impl
-- Signatures, return types, volatility, SECURITY DEFINER and search_path are unchanged (each statement is
-- the function's current live definition, reviewed here, with only its dates changed); CREATE OR REPLACE keeps owners and grants. The preflight and
-- postflight pin each function's body md5, search_path, SECURITY DEFINER, owner and exact live EXECUTE grants.
-- No row is read or written. Re-runnable: the preflight accepts the pre-image or this file's body.
-- Not changed here: rolling windows that subtract an interval from now() (they do not depend on the
-- calendar day); statement and
-- AR aging buckets (batch 3).
-- Rollback: a forward migration re-emitting the pre-images (their md5s are in the preflight).
DO $preflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('operational_dashboard_summary()', '77655108c73c1a98d826a21d55d7739d', '5eb8dec7f9f3b630fa9b81f7d83e0f26', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_customer_summary(uuid)', 'bf700aa02e7df78c79f02a0dc425e583', '5ab6a0dd177c7f5ff025afcceb8ff336', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_receiving_summary()', 'da09c3911448a80451a3c2592d1f1f5a', '30901f8c234b5a56f1dd8ff0fd9bbb05', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_call_list_stale_quotes(uuid,integer)', '6ddc2b4b3bbbfcf0304b7879261643de', '32e3084dab9b7e8093d20f1f677ab27e', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_dispatch_board_jobs(uuid,text,date,date)', 'a0cb35e0fae1e2fd0c7cddbd2b33ac13', '7795522b437d296121437ca237d9e588', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_dispatched_list(uuid,uuid)', '1b544f558c4b4c2f503dd157ccf7b1e1', '00a961e63d243e4d8d162a1e267b3624', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_expiring_planned_holds(integer,text)', '80cd30fbb5c0569c4630d577a8b0ed76', 'd18dd0de10282408feecc192773c7de7', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_inventory_forecast(integer)', 'f93b242a58945e5fb7128bbaea81c87f', 'd09a7eb840476fdbe05a189e1093c804', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_team_board_deliveries()', '2dd884639ed907554532d420a2ad6676', 'bb25c0f24732b70c62d48121f03cf6de', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_team_workload()', '4afd88dcb7f7df47b694c805dd2e0933', '2915daf61d2444f8a2d065590ac20fdb', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_yesterday_delivery_recap()', '5994e38938f09c94a3b7fa1bb2f11e43', '5ba5ded6da9a5441375dd55c749380ad', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_customer_statement(uuid,date,date)', 'ccfb77ef3e00a2457d3a387213d5eacb', 'ccfb77ef3e00a2457d3a387213d5eacb', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('_get_customer_statement_scoped_impl(uuid,date,date)', 'ee463c1bee06baa4b71943695da3bacf', 'ee463c1bee06baa4b71943695da3bacf', true, '{postgres=X/postgres}')
  ) AS t(sig, pre_md5, post_md5, secdef, acl)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % is missing', v_row.sig;
    END IF;
    IF md5(replace(v_fn.prosrc, chr(13), '')) NOT IN (v_row.pre_md5, v_row.post_md5)
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR v_fn.prosecdef IS DISTINCT FROM v_row.secdef
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL') IS DISTINCT FROM v_row.acl
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % body, settings, SECURITY DEFINER, owner or grants drifted; re-review the current definition', v_row.sig;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.operational_dashboard_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result       jsonb;
  _season_start date;
  _season_end   date;
BEGIN
  -- Role check (ROLE-8)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Calculate season boundaries (Oct 1 – Sep 30)
  IF EXTRACT(MONTH FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10 THEN
    _season_start := MAKE_DATE(EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int, 10, 1);
    _season_end   := MAKE_DATE(EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int + 1, 9, 30);
  ELSE
    _season_start := MAKE_DATE(EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int - 1, 10, 1);
    _season_end   := MAKE_DATE(EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int, 9, 30);
  END IF;

  WITH
  active_orders AS (
    SELECT COUNT(*) AS cnt
    FROM orders
    WHERE status IN ('confirmed', 'partially_fulfilled')
      AND deleted_at IS NULL
  ),
  open_quotes AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft') AS draft_cnt,
      COUNT(*) FILTER (WHERE status = 'sent')  AS sent_cnt
    FROM quotes
  ),
  pending_deliveries AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE status IN ('scheduled', 'in_progress')
  ),
  open_pos AS (
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE status IN ('submitted', 'partially_received')
  ),
  inv_agg AS (
    SELECT
      COALESCE(SUM(quantity_available), 0) AS total_available,
      COALESCE(SUM(quantity_prebooked), 0) AS total_prebooked
    FROM inventory
  ),
  on_order_units AS (
    SELECT
      COALESCE(SUM(poi.quantity_ordered - COALESCE(poi.quantity_received, 0)), 0) AS units,
      COUNT(DISTINCT po.id) AS po_count
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),
  committed_units AS (
    SELECT
      COALESCE(SUM(oi.quantity_remaining), 0) AS units,
      COUNT(DISTINCT o.id) AS order_count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),
  upcoming AS (
    SELECT jsonb_agg(row_to_json(ud)::jsonb ORDER BY ud.scheduled_date ASC) AS arr
    FROM (
      SELECT
        d.id,
        d.delivery_number,
        d.scheduled_date::text AS scheduled_date,
        d.status,
        cust.farm_name AS customer_name,
        drv.full_name  AS driver_name,
        d.assigned_driver
      FROM deliveries d
      LEFT JOIN customers cust ON cust.id = d.customer_id
      LEFT JOIN profiles  drv  ON drv.id  = d.assigned_driver
      WHERE d.status IN ('scheduled', 'in_progress')
      ORDER BY d.scheduled_date ASC
      LIMIT 10
    ) ud
  ),
  delivery_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE d.scheduled_date = (now() AT TIME ZONE 'America/Chicago')::date)                                AS today_count,
      COUNT(*) FILTER (WHERE d.scheduled_date BETWEEN (now() AT TIME ZONE 'America/Chicago')::date AND (now() AT TIME ZONE 'America/Chicago')::date + 6)     AS this_week_count,
      COUNT(*) FILTER (WHERE d.assigned_driver IS NULL)                                       AS unassigned_count
    FROM deliveries d
    WHERE d.status IN ('scheduled', 'in_progress')
  ),
  remainder_count AS (
    SELECT COUNT(*) AS cnt
    FROM delivery_remainders
    WHERE status = 'pending'
  ),
  quote_pipeline AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft')    AS draft_cnt,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent_cnt,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_cnt
    FROM quotes
  ),
  orders_ytd AS (
    SELECT
      COUNT(*) AS season_total,
      COUNT(*) FILTER (
        WHERE DATE_TRUNC('month', COALESCE(order_date, (created_at AT TIME ZONE 'America/Chicago')::date)) = DATE_TRUNC('month', (now() AT TIME ZONE 'America/Chicago')::date)
      ) AS this_month
    FROM orders
    WHERE COALESCE(order_date, (created_at AT TIME ZONE 'America/Chicago')::date) >= _season_start
      AND deleted_at IS NULL
  ),
  deliveries_completed AS (
    SELECT
      COUNT(*) AS season_total,
      COUNT(*) FILTER (
        WHERE DATE_TRUNC('month', (completed_at AT TIME ZONE 'America/Chicago')) = DATE_TRUNC('month', (now() AT TIME ZONE 'America/Chicago')::date)
      ) AS this_month
    FROM deliveries
    WHERE status = 'completed'
      AND (completed_at AT TIME ZONE 'America/Chicago')::date >= _season_start
  ),
  low_stock AS (
    SELECT COUNT(*) AS cnt
    FROM inventory
    WHERE reorder_point > 0
      AND quantity_available <= reorder_point
  ),
  driver_issues AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE issue_type IS NOT NULL
      AND status = 'completed'
  ),
  expired_holds AS (
    SELECT COUNT(DISTINCT q.id) AS cnt
    FROM quotes q
    JOIN inventory_holds ih ON ih.source_id = q.id AND ih.is_active = true
    WHERE q.status IN ('expired', 'declined')
  ),
  cancelled_posted AS (
    SELECT COUNT(DISTINCT d.id) AS cnt
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN invoices i ON i.order_id = o.id
    WHERE d.status = 'cancelled'
      AND i.status = 'posted'
  ),
  expiring_quotes AS (
    SELECT COUNT(*) AS cnt
    FROM quotes
    WHERE status IN ('draft', 'sent')
      AND expires_at IS NOT NULL
      AND expires_at BETWEEN (now() AT TIME ZONE 'America/Chicago')::date AND (now() AT TIME ZONE 'America/Chicago')::date + 3
  ),
  overdue_deliveries AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE scheduled_date < (now() AT TIME ZONE 'America/Chicago')::date
      AND status IN ('scheduled', 'in_progress')
  ),
  pos_expected_today AS (
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE expected_delivery_date = (now() AT TIME ZONE 'America/Chicago')::date
      AND status IN ('submitted', 'partially_received')
  ),
  expiring_licenses AS (
    SELECT COUNT(*) AS cnt
    FROM applicator_licenses
    WHERE is_active = true
      AND expiry_date BETWEEN (now() AT TIME ZONE 'America/Chicago')::date AND (now() AT TIME ZONE 'America/Chicago')::date + 30
  ),
  monthly_activity AS (
    SELECT jsonb_agg(row_to_json(ma)::jsonb ORDER BY ma.month) AS arr
    FROM (
      SELECT
        m.month,
        COALESCE(oc.cnt, 0) AS orders_created,
        COALESCE(dc.cnt, 0) AS deliveries_completed,
        COALESCE(pr.cnt, 0) AS pos_received
      FROM (
        SELECT TO_CHAR(d, 'YYYY-MM') AS month
        FROM generate_series(
          DATE_TRUNC('month', (now() AT TIME ZONE 'America/Chicago')::date) - INTERVAL '11 months',
          DATE_TRUNC('month', (now() AT TIME ZONE 'America/Chicago')::date),
          '1 month'::interval
        ) d
      ) m
      LEFT JOIN (
        SELECT TO_CHAR(COALESCE(order_date, (created_at AT TIME ZONE 'America/Chicago')::date), 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM orders WHERE deleted_at IS NULL GROUP BY 1
      ) oc ON oc.month = m.month
      LEFT JOIN (
        SELECT TO_CHAR(completed_at AT TIME ZONE 'America/Chicago', 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM deliveries WHERE status = 'completed' AND completed_at IS NOT NULL GROUP BY 1
      ) dc ON dc.month = m.month
      LEFT JOIN (
        SELECT TO_CHAR(received_at AT TIME ZONE 'America/Chicago', 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM receiving_records GROUP BY 1
      ) pr ON pr.month = m.month
      ORDER BY m.month
    ) ma
  ),
  period_info AS (
    SELECT
      COALESCE(TO_CHAR(period_start, 'Mon YYYY'), TO_CHAR((now() AT TIME ZONE 'America/Chicago'), 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(EXTRACT(DAY FROM period_end - (now() AT TIME ZONE 'America/Chicago'))::int, 0)
        ELSE EXTRACT(DAY FROM (DATE_TRUNC('month', (now() AT TIME ZONE 'America/Chicago')) + INTERVAL '1 month' - INTERVAL '1 day') - (now() AT TIME ZONE 'America/Chicago'))::int
      END AS days_remaining
    FROM accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  ),
  activity AS (
    SELECT jsonb_agg(row_to_json(af)::jsonb ORDER BY af.created_at DESC) AS arr
    FROM (
      SELECT id, event_type, description, created_at
      FROM activity_feed
      ORDER BY created_at DESC
      LIMIT 15
    ) af
  ),
  team_action_items AS (
    SELECT jsonb_agg(row_to_json(ti)::jsonb) AS arr
    FROM (
      SELECT
        tn.id,
        tn.title,
        tn.priority,
        tn.due_date::text AS due_date,
        tn.note_type,
        tn.is_pinned,
        tn.assigned_to,
        p.full_name AS assignee_name
      FROM team_notes tn
      LEFT JOIN profiles p ON p.id = tn.assigned_to
      WHERE tn.is_completed = false
        AND tn.deleted_at IS NULL
        AND (
          tn.is_pinned = true
          OR tn.priority IN ('urgent', 'high')
          OR (tn.due_date IS NOT NULL AND tn.due_date < (now() AT TIME ZONE 'America/Chicago')::date)
          OR tn.assigned_to = auth.uid()
        )
      ORDER BY
        CASE WHEN tn.is_pinned THEN 0 ELSE 1 END,
        CASE tn.priority
          WHEN 'urgent' THEN 0
          WHEN 'high'   THEN 1
          WHEN 'medium' THEN 2
          ELSE 3
        END,
        tn.due_date NULLS LAST
      LIMIT 10
    ) ti
  )

  SELECT jsonb_build_object(
    'active_orders_count',        ao.cnt,
    'open_quotes_draft',          oq.draft_cnt,
    'open_quotes_sent',           oq.sent_cnt,
    'pending_deliveries_count',   pd.cnt,
    'open_pos_count',             op.cnt,
    'team_action_items',          COALESCE(tai.arr, '[]'::jsonb),
    'inventory_available',        ia.total_available,
    'inventory_prebooked',        ia.total_prebooked,
    'on_order_units',             oou.units,
    'on_order_po_count',          oou.po_count,
    'committed_units',            cu.units,
    'committed_order_count',      cu.order_count,
    'upcoming_deliveries',        COALESCE(ud.arr, '[]'::jsonb),
    'delivery_today',             ds.today_count,
    'delivery_this_week',         ds.this_week_count,
    'delivery_unassigned',        ds.unassigned_count,
    'delivery_remainders_count',  rc.cnt,
    'quote_pipeline_draft',       qp.draft_cnt,
    'quote_pipeline_sent',        qp.sent_cnt,
    'quote_pipeline_accepted',    qp.accepted_cnt,
    'orders_ytd_total',           oytd.season_total,
    'orders_this_month',          oytd.this_month,
    'deliveries_completed_total', dcomp.season_total,
    'deliveries_completed_this_month', dcomp.this_month,
    'low_stock_count',            ls.cnt,
    'driver_issues_count',        di.cnt,
    'expired_holds_count',        eh.cnt,
    'cancelled_posted_count',     cp.cnt,
    'expiring_quotes_count',      eq.cnt,
    'overdue_deliveries_count',   od.cnt,
    'pos_expected_today_count',   pet.cnt,
    'expiring_licenses_count',    el.cnt,
    'monthly_activity',           COALESCE(mact.arr, '[]'::jsonb),
    'season_label',               CASE WHEN EXTRACT(MONTH FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10
                                    THEN EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int || '-' || (EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int + 1)
                                    ELSE (EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int - 1) || '-' || EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int
                                  END,
    'season_days_remaining',      (_season_end - (now() AT TIME ZONE 'America/Chicago')::date),
    'season_days_elapsed',        ((now() AT TIME ZONE 'America/Chicago')::date - _season_start),
    'period_name',                COALESCE(pi.name, TO_CHAR((now() AT TIME ZONE 'America/Chicago'), 'Mon YYYY')),
    'period_status',              COALESCE(pi.status, 'open'),
    'period_days_remaining',      COALESCE(pi.days_remaining, 0),
    'recent_activity',            COALESCE(act.arr, '[]'::jsonb)
  ) INTO result
  FROM active_orders       ao
  CROSS JOIN open_quotes        oq
  CROSS JOIN pending_deliveries pd
  CROSS JOIN open_pos           op
  CROSS JOIN inv_agg            ia
  CROSS JOIN on_order_units     oou
  CROSS JOIN committed_units    cu
  CROSS JOIN upcoming           ud
  CROSS JOIN delivery_stats     ds
  CROSS JOIN remainder_count    rc
  CROSS JOIN quote_pipeline     qp
  CROSS JOIN orders_ytd         oytd
  CROSS JOIN deliveries_completed dcomp
  CROSS JOIN low_stock          ls
  CROSS JOIN driver_issues      di
  CROSS JOIN expired_holds      eh
  CROSS JOIN cancelled_posted   cp
  CROSS JOIN expiring_quotes    eq
  CROSS JOIN overdue_deliveries od
  CROSS JOIN pos_expected_today pet
  CROSS JOIN expiring_licenses  el
  CROSS JOIN monthly_activity   mact
  CROSS JOIN activity           act
  CROSS JOIN team_action_items  tai
  LEFT JOIN  period_info        pi ON true;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_summary(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_ar_balance bigint;
  v_order_count int;
  v_delivery_count int;
  v_credit_tier int;
  v_last_activity timestamptz;
  v_season_start date;
  v_season_end date;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  IF extract(month FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10 THEN
    v_season_start := make_date(extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::int, 10, 1);
    v_season_end := make_date(extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::int + 1, 9, 30);
  ELSE
    v_season_start := make_date(extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::int - 1, 10, 1);
    v_season_end := make_date(extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::int, 9, 30);
  END IF;

  SELECT COALESCE(sum(balance_cents), 0)
  INTO v_ar_balance
  FROM invoices
  WHERE customer_id = p_customer_id
    AND status IN ('posted', 'overdue');

  SELECT count(*)
  INTO v_order_count
  FROM orders
  WHERE customer_id = p_customer_id
    AND order_date >= v_season_start
    AND order_date <= v_season_end
    AND status NOT IN ('cancelled', 'voided');

  SELECT count(*)
  INTO v_delivery_count
  FROM deliveries
  WHERE customer_id = p_customer_id
    AND status = 'completed'
    AND (completed_at AT TIME ZONE 'America/Chicago')::date >= v_season_start
    AND (completed_at AT TIME ZONE 'America/Chicago')::date <= v_season_end;

  SELECT assigned_tier
  INTO v_credit_tier
  FROM customers
  WHERE id = p_customer_id;

  SELECT max(created_at)
  INTO v_last_activity
  FROM activity_feed
  WHERE customer_id = p_customer_id;

  v_result := jsonb_build_object(
    'ar_balance_cents', v_ar_balance,
    'order_count', v_order_count,
    'delivery_count', v_delivery_count,
    'credit_tier', v_credit_tier,
    'last_activity', v_last_activity
  );

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_receiving_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_week_start date := date_trunc('week', (now() AT TIME ZONE 'America/Chicago')::date)::date;
  v_year_start date := season_start_date(compute_season((now() AT TIME ZONE 'America/Chicago')::date));
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (select auth.uid()) AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT jsonb_build_object(
    'expected_today', (
      SELECT count(*) FROM purchase_orders
      WHERE status IN ('submitted', 'partially_received')
        AND expected_delivery_date = v_today
    ),
    'pending_receipt', (
      SELECT count(*) FROM purchase_orders
      WHERE status IN ('submitted', 'partially_received')
    ),
    'received_this_week', (
      SELECT count(DISTINCT rr.id) FROM receiving_records rr
      WHERE (rr.received_at AT TIME ZONE 'America/Chicago')::date >= v_week_start
    ),
    'items_received_ytd', (
      SELECT COALESCE(sum(rr.quantity_received), 0) FROM receiving_records rr
      WHERE (rr.received_at AT TIME ZONE 'America/Chicago')::date >= v_year_start
    ),
    'damaged_this_week', (
      SELECT count(*) FROM receiving_records rr
      WHERE (rr.received_at AT TIME ZONE 'America/Chicago')::date >= v_week_start
        AND rr.condition <> 'good'
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_call_list_stale_quotes(p_rep_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  IF p_days < 0 THEN
    RAISE EXCEPTION 'CALL_LIST_INVALID_DAYS';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      -- Every matching row, before the 200-row cut, so the screen can say "200 of N".
      'total_count', COALESCE(MAX(rows.total_count), 0),
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'quote_id', rows.quote_id,
        'quote_number', rows.quote_number,
        'quote_total_cents', rows.quote_total_cents,
        'quote_updated_at', rows.quote_updated_at,
        'quote_age_days', rows.quote_age_days
      ) ORDER BY rows.quote_updated_at, rows.quote_number, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        count(*) OVER () AS total_count,
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        q.id AS quote_id,
        q.quote_number,
        ROUND(q.total_price * 100)::bigint AS quote_total_cents,
        q.updated_at AS quote_updated_at,
        ((now() AT TIME ZONE 'America/Chicago')::date - (q.updated_at AT TIME ZONE 'America/Chicago')::date) AS quote_age_days
      FROM public.quotes q
      JOIN public.customers c ON c.id = q.customer_id
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND q.deleted_at IS NULL
        AND q.status IN ('draft', 'sent', 'revised')
        AND q.updated_at < now() - make_interval(days => p_days)
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY q.updated_at, q.quote_number, c.id
      LIMIT 200
    ) rows
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(p_applicator_id uuid, p_status text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A dispatch row is VISIBLE to the caller (mirrors job_location_dispatches_select):
  --   admin/sales see all; the job's whole-job applicator sees every row on their job;
  --   otherwise a field user sees a row where they are the assignee or an active member
  --   of the assigned active crew.
  WITH matched AS (
    -- _total_count: every matching job before the 500-row cut, so the board can say "500 of N".
    SELECT j.*, count(*) OVER () AS _total_count
      FROM public.jobs j
     WHERE j.deleted_at IS NULL
       AND p_applicator_id IS NOT NULL
       AND (p_status IS NULL OR j.status = p_status)
       AND (p_start_date IS NULL OR j.job_date >= p_start_date)
       AND (p_end_date IS NULL OR j.job_date <= p_end_date)
       AND (
         -- (a) a CURRENT per-location dispatch to this applicator the CALLER can see
         EXISTS (
           SELECT 1 FROM public.job_location_dispatches d
            WHERE d.job_id = j.id
              AND d.dispatch_status = 'dispatched'
              AND d.applicator_id = p_applicator_id
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND j.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
              )
         )
         OR (
           -- (b) whole-job applicator = this one AND the job has NO per-location dispatch
           j.applicator_id = p_applicator_id
           AND NOT EXISTS (
             SELECT 1 FROM public.job_location_dispatches d2
              WHERE d2.job_id = j.id
                AND d2.dispatch_status = 'dispatched'
           )
         )
       )
       -- VISIBILITY GATE — the live jobs SELECT predicate. Never return a hidden job.
       AND (
         is_admin()
         OR is_sales_rep()
         OR (is_applicator() AND j.applicator_id = (select auth.uid()))
         OR public._is_dispatched_to_me(j.id)
       )
     ORDER BY j.job_date DESC NULLS LAST, j.id DESC
     LIMIT 500
  )
  SELECT
    -- Job cost is admin-only and readable through get_admin_cost_fields; never send it here.
    (to_jsonb(m) - 'total_cost_cents')
    || jsonb_build_object(
         -- CUSTOMER NAME — RLS-equivalent (Codex re-review-3 P2): this function is
         -- SECURITY DEFINER, so a raw `customers` read would bypass customers_select and
         -- could leak a farm_name the caller can't otherwise see (a sales_rep is limited
         -- to assigned customers; an applicator/driver to a time-windowed set). Return the
         -- name ONLY when the caller would pass customers_select OR
         -- customers_select_location_dispatchee for THIS job's customer; else farm_name
         -- is null (the board renders 'Unknown', exactly as the unfiltered RLS embed would).
         'customer',
         (SELECT jsonb_build_object(
                   'farm_name',
                   CASE WHEN (
                     is_admin()
                     OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                     OR (is_driver() AND EXISTS (
                           SELECT 1 FROM public.deliveries d
                            WHERE d.customer_id = c.id
                              AND d.assigned_driver = (select auth.uid())
                              AND d.scheduled_date >= ((now() AT TIME ZONE 'America/Chicago')::date - interval '1 day')))
                     OR (is_applicator() AND EXISTS (
                           SELECT 1 FROM public.jobs j2
                            WHERE j2.customer_id = c.id
                              AND j2.applicator_id = (select auth.uid())
                              AND j2.job_date >= ((now() AT TIME ZONE 'America/Chicago')::date - interval '7 days')))
                     OR EXISTS (
                           SELECT 1 FROM public.jobs j3
                            WHERE j3.customer_id = c.id
                              AND public._is_dispatched_to_me(j3.id))
                   ) THEN c.farm_name ELSE NULL END)
            FROM public.customers c WHERE c.id = m.customer_id),
         -- JOB_FIELDS — job_fields_select is satisfied for every job that passed this
         -- function's visibility gate (admin/sales_rep/whole-job applicator/_is_dispatched_to_me
         -- are exactly its conditions), so listing the rows leaks nothing. field_name is
         -- gated to the fields_select predicate (admin/sales_rep/applicator) so a dispatched
         -- crew member whose role is NOT applicator doesn't get a field name they couldn't
         -- read under RLS (null → the board falls back to 'Field'). (Codex re-review-3 P2.)
         'job_fields',
         coalesce((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', jf.id,
                      'field_id', jf.field_id,
                      'acres_to_treat', jf.acres_to_treat,
                      'sort_order', jf.sort_order,
                      'field', jsonb_build_object(
                        'id', f.id,
                        'field_name', CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                                           THEN f.field_name ELSE NULL END)
                    ) ORDER BY jf.sort_order
                  )
             FROM public.job_fields jf
             JOIN public.fields f ON f.id = jf.field_id
            WHERE jf.job_id = m.id
         ), '[]'::jsonb),
         -- per-location dispatch rows the CALLER can see, for client-side label aggregation
         '_dispatches',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('applicator_id', d.applicator_id, 'crew_id', d.crew_id))
             FROM public.job_location_dispatches d
            WHERE d.job_id = m.id
              AND d.dispatch_status = 'dispatched'
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND m.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
                OR (
                  d.crew_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                     WHERE gcm.crew_id = d.crew_id
                       AND gcm.profile_id = (select auth.uid())
                       AND gcm.is_active
                       AND gc.is_active
                  )
                )
              )
         ), '[]'::jsonb)
       )
    FROM matched m
   ORDER BY m.job_date DESC NULLS LAST, m.id DESC;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatched_list(p_applicator_id uuid DEFAULT NULL::uuid, p_crew_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'dispatch_id',     d.id,
    'job_field_id',    d.job_field_id,
    'job_id',          d.job_id,
    'job_number',      j.job_number,
    'job_status',      j.status,
    -- U12 addition: the job's scheduled date, so the FieldView card shows it
    -- and can sort Today-first / group a Done section without an extra fetch.
    'job_date',        j.job_date,
    -- U12 addition (Codex R1 P1): the underlying fields.id, so the FieldView
    -- completion form can send per-field applied acres keyed by the REAL field id
    -- (job_field_id is the join-row id — application_record_fields.field_id
    -- references fields.id, so the client needs this to build 'field_acres').
    -- Gated to the same role set as field_name (RLS R2 M3): the only consumer
    -- (the completion form) requires is_applicator() anyway, and a dispatched
    -- non-applicator crew member shouldn't get a dereferenceable fields.id when
    -- field_name is deliberately withheld from them.
    'field_id',        CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN jf.field_id ELSE NULL END,
    'dispatch_status', d.dispatch_status,
    'dispatched_at',   d.dispatched_at,
    'assignee_kind',   CASE WHEN d.applicator_id IS NOT NULL THEN 'applicator' ELSE 'crew' END,
    'applicator_id',   d.applicator_id,
    'crew_id',         d.crew_id,
    -- assignee NAME resolved server-side. field_name gated to the fields_select roles
    -- (admin/sales_rep/applicator) so a dispatched crew member whose role is not
    -- applicator never receives a field name they couldn't read under RLS (null ->
    -- the client falls back to 'Field'). Customer name gated likewise.
    'assignee_name',   CASE WHEN d.applicator_id IS NOT NULL
                            THEN (SELECT p.full_name FROM profiles p WHERE p.id = d.applicator_id)
                            ELSE (SELECT g.name FROM ground_crews g WHERE g.id = d.crew_id) END,
    'field_name',      CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN (SELECT f.field_name FROM fields f WHERE f.id = jf.field_id)
                            ELSE NULL END,
    'customer_name',   CASE WHEN (
                              is_admin()
                              OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                              OR (is_applicator() AND EXISTS (
                                    SELECT 1 FROM public.jobs j2
                                     WHERE j2.customer_id = c.id
                                       AND j2.applicator_id = (select auth.uid())
                                       AND j2.job_date >= ((now() AT TIME ZONE 'America/Chicago')::date - interval '7 days')))
                              OR EXISTS (
                                    SELECT 1 FROM public.jobs j3
                                     WHERE j3.customer_id = c.id
                                       AND public._is_dispatched_to_me(j3.id))
                            ) THEN c.farm_name ELSE NULL END,
    'location_acres',  jf.acres_to_treat,
    'job_applied_acres', j.applied_acres,
    'job_total_acres',   j.total_acres
  )
    FROM public.job_location_dispatches d
    JOIN public.jobs j        ON j.id = d.job_id AND j.deleted_at IS NULL
    JOIN public.job_fields jf ON jf.id = d.job_field_id
    JOIN public.customers c   ON c.id = j.customer_id
   WHERE (
       d.dispatch_status = 'dispatched'
       -- A1: also return RECENTLY-completed dispatch rows (the job-terminal trigger
       -- flips rows to 'completed' when the job completes) so a just-finished job
       -- moves to the FieldView "Done" section instead of vanishing. 7-day window
       -- bounds the tail; 'cancelled' rows stay EXCLUDED — an undispatched
       -- applicator must not keep seeing the job (undispatch_job_locations also
       -- writes 'cancelled').
       OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
     )
     AND (p_applicator_id IS NULL OR d.applicator_id = p_applicator_id)
     AND (p_crew_id IS NULL OR d.crew_id = p_crew_id)
     -- VISIBILITY GATE — mirrors job_location_dispatches_select, with ONE deliberate
     -- A1 relaxation: the table policy's assignee/crew branches require
     -- dispatch_status='dispatched', but this gate intentionally does NOT — otherwise
     -- a per-location assignee's just-completed rows would never reach their Done
     -- section (the whole point of the 7-day completed tail). The rows are still
     -- bounded to the caller's OWN dispatches (or their active crew's) — data they
     -- could already read while the row was 'dispatched'. is_admin()/is_sales_rep()/
     -- is_applicator() each re-check profiles.is_active internally, BUT the bare
     -- `applicator_id = auth.uid()` and crew-member branches must ALSO re-check is_active
     -- — this is a SECURITY DEFINER read that bypasses RLS, so without the re-check a
     -- DEACTIVATED user with a still-valid token would keep seeing their dispatch rows
     -- (the #36 policy includes this active-profile guard for exactly this reason —
     -- Codex #37 P1).
     AND (
       is_admin()
       OR is_sales_rep()
       OR (is_applicator() AND j.applicator_id = (select auth.uid()))
       OR (
         d.applicator_id = (select auth.uid())
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
       )
       OR (
         d.crew_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
         AND EXISTS (
           SELECT 1 FROM public.ground_crew_members gcm
             JOIN public.ground_crews gc ON gc.id = gcm.crew_id
            WHERE gcm.crew_id = d.crew_id
              AND gcm.profile_id = (select auth.uid())
              AND gcm.is_active
              AND gc.is_active
         )
       )
     )
   -- d.id is the UNIQUE tiebreaker that makes this a TOTAL order — without it two
   -- same-job/same-transaction rows (equal dispatched_at) can be skipped/duplicated
   -- across a .range() page boundary (Codex #37 follow-up LOW).
   ORDER BY j.job_number, d.dispatched_at DESC, d.id;
$function$;

CREATE OR REPLACE FUNCTION public.get_expiring_planned_holds(p_days_ahead integer DEFAULT 7, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      SELECT
        ih.id AS hold_id,
        ih.product_id,
        p.product_name,
        ih.quantity,
        ih.expires_at,
        (ih.expires_at - INTERVAL '14 days')::date AS needed_by_date,
        ih.source_id AS quote_id,
        q.quote_number,
        c.farm_name AS customer_name,
        ih.customer_id
      FROM inventory_holds ih
      JOIN products p ON p.id = ih.product_id
      JOIN quotes q ON q.id = ih.source_id
      JOIN customers c ON c.id = ih.customer_id
      WHERE ih.is_active = true
        AND ih.hold_type = 'crop_program'
        AND (ih.expires_at - INTERVAL '14 days')::date <= (now() AT TIME ZONE 'America/Chicago')::date + p_days_ahead
        AND ih.expires_at > (now() AT TIME ZONE 'America/Chicago')::date  -- not yet expired
      ORDER BY (ih.expires_at - INTERVAL '14 days')::date ASC
    ) r
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_inventory_forecast(p_months_ahead integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      WITH demand_rows AS (
        -- crop_program holds bucketed by expiry − 14d (live behavior, unchanged)
        SELECT ih.product_id, ih.source_id, ih.customer_id, ih.quantity,
               'crop_program'::text AS kind,
               DATE_TRUNC('month', (ih.expires_at - INTERVAL '14 days'))::date AS needed_month
        FROM inventory_holds ih
        WHERE ih.is_active = true
          AND ih.hold_type = 'crop_program'
          AND ih.expires_at IS NOT NULL
          AND (ih.expires_at - INTERVAL '14 days') <= (now() AT TIME ZONE 'America/Chicago')::date + (p_months_ahead || ' months')::interval
        UNION ALL
        -- LAYER2: job holds bucketed by jobs.job_date (expires_at is NULL for job holds)
        SELECT ih.product_id, ih.source_id, ih.customer_id, ih.quantity,
               'job'::text AS kind,
               DATE_TRUNC('month', j.job_date)::date AS needed_month
        FROM inventory_holds ih
        JOIN jobs j ON j.id = ih.source_id
        WHERE ih.is_active = true
          AND ih.hold_type = 'job'
          AND j.deleted_at IS NULL
          AND j.job_date IS NOT NULL
          AND j.job_date <= ((now() AT TIME ZONE 'America/Chicago')::date + (p_months_ahead || ' months')::interval)::date
      )
      SELECT
        p.id AS product_id,
        p.product_name,
        p.sku,
        dr.needed_month,
        SUM(dr.quantity) AS planned_demand,
        COALESCE(SUM(dr.quantity) FILTER (WHERE dr.kind = 'job'), 0) AS job_demand,
        -- Codex A+B P2 #5: wrap the scalar subquery in COALESCE so a NO-ROW result
        -- (product with a job hold but no Main Warehouse inventory row) yields 0, not
        -- NULL — the inner COALESCE only guards a NULL column, not a missing row, and
        -- the frontend calls .toLocaleString() on these (would crash on null).
        COALESCE((SELECT i.quantity_available FROM inventory i WHERE i.product_id = p.id AND i.location = 'Main Warehouse' LIMIT 1), 0) AS current_available,
        COALESCE((SELECT i.quantity_prebooked FROM inventory i WHERE i.product_id = p.id AND i.location = 'Main Warehouse' LIMIT 1), 0) AS prebooked,
        (SELECT COALESCE(SUM(poi.quantity_ordered - poi.quantity_received), 0)
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE poi.product_id = p.id AND po.status IN ('submitted', 'partially_received')
        ) AS on_order,
        COUNT(DISTINCT dr.source_id) FILTER (WHERE dr.kind = 'crop_program') AS quote_count,
        COUNT(DISTINCT dr.customer_id) AS customer_count
      FROM demand_rows dr
      JOIN products p ON p.id = dr.product_id
      GROUP BY p.id, p.product_name, p.sku, dr.needed_month
      ORDER BY dr.needed_month, p.product_name
    ) r
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_team_board_deliveries()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_tomorrow date := (now() AT TIME ZONE 'America/Chicago')::date + 1;
  v_result jsonb;
BEGIN
  -- Active profiles only: an inactive or missing profile is refused, not shown "my deliveries".
  SELECT role INTO v_role FROM profiles WHERE id = v_user_id AND is_active = true;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: active account required';
  END IF;

  SELECT jsonb_build_object(
    'today', COALESCE((
      SELECT jsonb_agg(row_to_json(d.*)::jsonb ORDER BY d.scheduled_time NULLS LAST, d.priority_sort)
      FROM (
        SELECT
          del.id,
          del.delivery_number,
          del.status,
          del.priority,
          -- deliveries_priority_check allows urgent, high, normal, low (or NULL, which sorts last).
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END AS priority_sort,
          del.scheduled_date,
          del.scheduled_time,
          ca.address_line AS delivery_address,
          del.delivery_notes,
          c.farm_name AS customer_name,
          p.full_name AS driver_name,
          del.assigned_driver,
          (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id) AS item_count
        FROM deliveries del
        JOIN customers c ON c.id = del.customer_id
        LEFT JOIN customer_addresses ca ON ca.id = del.delivery_address_id
        LEFT JOIN profiles p ON p.id = del.assigned_driver
        WHERE del.scheduled_date = v_today
          AND del.status IN ('scheduled', 'in_progress')
          AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
      ) d
    ), '[]'::jsonb),
    'tomorrow', COALESCE((
      SELECT jsonb_agg(row_to_json(d.*)::jsonb ORDER BY d.scheduled_time NULLS LAST, d.priority_sort)
      FROM (
        SELECT
          del.id,
          del.delivery_number,
          del.status,
          del.priority,
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END AS priority_sort,
          del.scheduled_date,
          del.scheduled_time,
          ca.address_line AS delivery_address,
          c.farm_name AS customer_name,
          p.full_name AS driver_name,
          del.assigned_driver
        FROM deliveries del
        JOIN customers c ON c.id = del.customer_id
        LEFT JOIN customer_addresses ca ON ca.id = del.delivery_address_id
        LEFT JOIN profiles p ON p.id = del.assigned_driver
        WHERE del.scheduled_date = v_tomorrow
          AND del.status = 'scheduled'
          AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
      ) d
    ), '[]'::jsonb),
    'unassigned_count', (
      SELECT count(*)
      FROM deliveries
      WHERE scheduled_date = v_today
        AND status = 'scheduled'
        AND assigned_driver IS NULL
    ),
    'today_total', (
      SELECT count(*)
      FROM deliveries
      WHERE scheduled_date = v_today
        AND status IN ('scheduled', 'in_progress')
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_team_workload()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  SELECT jsonb_agg(row_to_json(t) ORDER BY t.full_name)
  INTO v_result
  FROM (
    SELECT
      p.id,
      p.full_name,
      p.role,
      (SELECT count(*)
       FROM team_notes tn
       WHERE tn.assigned_to = p.id
         AND tn.is_completed = false
         AND tn.deleted_at IS NULL
      )::int AS open_tasks,
      (SELECT count(*)
       FROM team_notes tn
       WHERE tn.assigned_to = p.id
         AND tn.is_completed = false
         AND tn.deleted_at IS NULL
         AND tn.due_date < v_today
      )::int AS overdue_tasks,
      (SELECT count(*)
       FROM deliveries d
       WHERE d.assigned_driver = p.id
         AND d.scheduled_date = v_today
         AND d.status IN ('scheduled', 'in_progress')
      )::int AS today_deliveries,
      (SELECT count(*)
       FROM deliveries d
       WHERE d.assigned_driver = p.id
         AND d.scheduled_date >= date_trunc('week', v_today)
         AND d.scheduled_date < date_trunc('week', v_today) + interval '7 days'
         AND d.status IN ('scheduled', 'in_progress', 'completed')
      )::int AS week_deliveries
    FROM profiles p
    WHERE p.is_active = true
  ) t;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_yesterday_delivery_recap()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_yesterday date := (now() AT TIME ZONE 'America/Chicago')::date - 1;
  v_result jsonb;
BEGIN
  -- Active profiles only: an inactive or missing profile is refused, not shown "my deliveries".
  SELECT role INTO v_role FROM profiles WHERE id = v_user_id AND is_active = true;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: active account required';
  END IF;

  SELECT jsonb_build_object(
    'completed', COALESCE((
      -- completed_at, not updated_at: a later edit to a completed delivery must not move it.
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.farm_name,
        'driver_name', p.full_name,
        'completed_at', COALESCE(del.completed_at, del.updated_at),
        'item_count', (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id),
        'has_issues', (del.issue_type IS NOT NULL)
      ) ORDER BY COALESCE(del.completed_at, del.updated_at))
      FROM deliveries del
      JOIN customers c ON c.id = del.customer_id
      LEFT JOIN profiles p ON p.id = del.assigned_driver
      WHERE del.scheduled_date = v_yesterday
        AND del.status = 'completed'
        AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
    ), '[]'::jsonb),
    'issues', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.farm_name,
        'driver_name', p.full_name,
        'issue_type', del.issue_type,
        'issue_description', del.issue_notes
      ))
      FROM deliveries del
      JOIN customers c ON c.id = del.customer_id
      LEFT JOIN profiles p ON p.id = del.assigned_driver
      WHERE del.scheduled_date = v_yesterday
        AND del.issue_type IS NOT NULL
        AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_completed', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND status = 'completed'
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      ),
      'total_with_issues', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND issue_type IS NOT NULL
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      ),
      'total_cancelled', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND status IN ('cancelled', 'voided')
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_statement(p_customer_id uuid, p_start_date date DEFAULT (((now() AT TIME ZONE 'America/Chicago')::date - '90 days'::interval))::date, p_end_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  -- Reps read ANY customer's statement (Mason, 2026-10-13); the assigned-rep
  -- check is removed by 20261013220000.
  IF v_actor_role IS DISTINCT FROM 'sales_rep'
     AND v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  RETURN QUERY
  SELECT *
    FROM public._get_customer_statement_scoped_impl(
      p_customer_id,
      p_start_date,
      p_end_date
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public._get_customer_statement_scoped_impl(p_customer_id uuid, p_start_date date DEFAULT (((now() AT TIME ZONE 'America/Chicago')::date - '90 days'::interval))::date, p_end_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
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

  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'INVALID_STATEMENT_DATE_RANGE';
  END IF;

  RETURN QUERY
  WITH all_txns AS (
    SELECT
      i.invoice_date::date AS txn_date,
      CASE WHEN i.invoice_type = 'credit_memo' THEN 'credit' ELSE 'invoice' END AS txn_type,
      i.invoice_number AS ref_num,
      CASE WHEN i.invoice_type = 'credit_memo'
           THEN 'Credit Memo ' || i.invoice_number
           ELSE 'Invoice ' || i.invoice_number END AS descr,
      i.total_amount_cents AS amt,
      10 AS source_rank,
      i.id AS sort_id
    FROM public.invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status IN ('posted', 'paid', 'overdue')
      AND i.deleted_at IS NULL

    UNION ALL

    SELECT
      p.payment_date::date,
      'payment',
      COALESCE(p.reference_number, ''),
      'Payment - ' || p.payment_method,
      -(p.amount * 100)::bigint,
      20,
      p.id
    FROM public.payments p
    LEFT JOIN public.orders o ON o.id = p.order_id
    WHERE COALESCE(o.customer_id, p.customer_id) = p_customer_id
      AND p.deleted_at IS NULL

    UNION ALL

    SELECT
      COALESCE(a.payment_date, (a.created_at AT TIME ZONE 'America/Chicago')::date),
      'payment',
      COALESCE(a.reference_number, a.check_number, ''),
      'Payment - ' || COALESCE(a.payment_method, 'other'),
      -COALESCE(a.total_allocated_cents, 0),
      21,
      a.id
    FROM public.allocation_sets a
    WHERE a.entity_type = 'payment'
      AND a.is_active = true
      AND a.customer_id = p_customer_id
      AND COALESCE(a.total_allocated_cents, 0) > 0

    UNION ALL

    SELECT
      (pa.applied_at AT TIME ZONE 'America/Chicago')::date,
      'prepay',
      '',
      'Prepay Applied',
      -pa.applied_amount_cents,
      30,
      pa.id
    FROM public.prepay_applications pa
    INNER JOIN public.prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.customer_id = p_customer_id

    UNION ALL

    SELECT
      (wo.created_at AT TIME ZONE 'America/Chicago')::date,
      'write_off',
      i.invoice_number,
      'Write-off - ' || wo.reason,
      -wo.amount_cents,
      40,
      wo.id
    FROM public.write_offs wo
    INNER JOIN public.invoices i ON i.id = wo.invoice_id
    WHERE wo.customer_id = p_customer_id
      AND wo.reversed_at IS NULL
  ),
  opening AS (
    SELECT COALESCE(SUM(a.amt), 0)::bigint AS amt
      FROM all_txns a
     WHERE a.txn_date < p_start_date
  ),
  statement_txns AS (
    SELECT
      p_start_date AS txn_date,
      'opening_balance'::text AS txn_type,
      ''::text AS ref_num,
      'Opening Balance'::text AS descr,
      o.amt,
      0 AS source_rank,
      '00000000-0000-0000-0000-000000000000'::uuid AS sort_id
    FROM opening o
    WHERE o.amt <> 0

    UNION ALL

    SELECT a.txn_date, a.txn_type, a.ref_num, a.descr, a.amt,
           a.source_rank, a.sort_id
      FROM all_txns a
     WHERE a.txn_date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    t.txn_date,
    t.txn_type,
    t.ref_num,
    t.descr,
    t.amt,
    SUM(t.amt) OVER (
      ORDER BY t.txn_date, t.source_rank, t.sort_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )::bigint
  FROM statement_txns t
  ORDER BY t.txn_date, t.source_rank, t.sort_id;
END;
$function$;

DO $postflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('operational_dashboard_summary()', '77655108c73c1a98d826a21d55d7739d', '5eb8dec7f9f3b630fa9b81f7d83e0f26', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_customer_summary(uuid)', 'bf700aa02e7df78c79f02a0dc425e583', '5ab6a0dd177c7f5ff025afcceb8ff336', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_receiving_summary()', 'da09c3911448a80451a3c2592d1f1f5a', '30901f8c234b5a56f1dd8ff0fd9bbb05', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_call_list_stale_quotes(uuid,integer)', '6ddc2b4b3bbbfcf0304b7879261643de', '32e3084dab9b7e8093d20f1f677ab27e', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_dispatch_board_jobs(uuid,text,date,date)', 'a0cb35e0fae1e2fd0c7cddbd2b33ac13', '7795522b437d296121437ca237d9e588', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_dispatched_list(uuid,uuid)', '1b544f558c4b4c2f503dd157ccf7b1e1', '00a961e63d243e4d8d162a1e267b3624', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_expiring_planned_holds(integer,text)', '80cd30fbb5c0569c4630d577a8b0ed76', 'd18dd0de10282408feecc192773c7de7', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_inventory_forecast(integer)', 'f93b242a58945e5fb7128bbaea81c87f', 'd09a7eb840476fdbe05a189e1093c804', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_team_board_deliveries()', '2dd884639ed907554532d420a2ad6676', 'bb25c0f24732b70c62d48121f03cf6de', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_team_workload()', '4afd88dcb7f7df47b694c805dd2e0933', '2915daf61d2444f8a2d065590ac20fdb', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_yesterday_delivery_recap()', '5994e38938f09c94a3b7fa1bb2f11e43', '5ba5ded6da9a5441375dd55c749380ad', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('get_customer_statement(uuid,date,date)', 'ccfb77ef3e00a2457d3a387213d5eacb', 'ccfb77ef3e00a2457d3a387213d5eacb', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'),
    ('_get_customer_statement_scoped_impl(uuid,date,date)', 'ee463c1bee06baa4b71943695da3bacf', 'ee463c1bee06baa4b71943695da3bacf', true, '{postgres=X/postgres}')
  ) AS t(sig, pre_md5, post_md5, secdef, acl)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL
       OR md5(replace(v_fn.prosrc, chr(13), '')) <> v_row.post_md5
       OR regexp_replace(v_fn.prosrc, '--[^\n]*', '', 'g') ~* '\mcurrent_date\M'
       OR pg_get_function_arguments(v_fn.oid) ~* '\mcurrent_date\M'
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR v_fn.prosecdef IS DISTINCT FROM v_row.secdef
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL') IS DISTINCT FROM v_row.acl
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % still uses the UTC date or did not take the new body', v_row.sig;
    END IF;
  END LOOP;
  -- Argument defaults are outside the body md5: both statement date defaults must be the Chicago date.
  FOR v_row IN SELECT unnest(ARRAY['get_customer_statement(uuid,date,date)', '_get_customer_statement_scoped_impl(uuid,date,date)']) AS sig
  LOOP
    IF (SELECT count(*) FROM regexp_matches(pg_get_function_arguments(to_regprocedure('public.' || v_row.sig)),
          'now\(\) AT TIME ZONE ''America/Chicago''::text', 'g')) <> 2 THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % date defaults are not the Chicago date', v_row.sig;
    END IF;
  END LOOP;
END;
$postflight$;
