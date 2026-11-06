-- Goal 4: the Orders list reads one page at a time, with search, filters, sort and totals done here.
--
-- Why: the Orders screen reads every order of the season plus every line, active invoice, active
-- delivery and farm-group parent behind them, then filters, searches, sorts and counts in the browser.
-- At season volume that is tens of thousands of rows per visit. get_orders_page applies the screen's
-- search, filters and sort here and returns one page of rows plus the true totals of every match:
--   total_count        every order matching the season, filters and search
--   total_price_cents  the sum of those orders' totals, each rounded to whole cents first
--   rows               the requested page, with the same fields the screen builds today
-- Count, total and page come from one statement, so they always describe the same rows.
--
-- Each row's derived fields are computed exactly as src/pages/Orders.tsx computes them today:
--   fulfillment_pct  delivered value / needed value of the order's lines (units x price), rounded
--   invoiced_pct     active non-credit-memo invoice cents / order cents, rounded, capped at 100
--   active_delivery_count / earliest_delivery_date  scheduled and in-progress deliveries
--   product_names    the order's distinct line product names, comma separated (searchable)
--   farm_group_name  the parent customer's farm name; customer_name the customer's farm name
-- Search is a case-insensitive substring match on order number, customer, farm group and products,
-- like the screen's search box. Every sort ends with order date (newest first) and then the order id, so
-- the order is total: paging by offset never shows one row twice or skips one while nothing changes.
-- p_planned: true = planned only, false = committed only. p_needs_split_billing: true = only orders
-- queued for split billing; false or NULL = no filter (the screen's filter is on/off).
--
-- Security: SECURITY INVOKER, so every table is read under the caller's own row security, exactly
-- as the screen reads them today (orders and lines: admin and sales rep; a rep's invoiced % counts
-- only the invoices that rep can see, as today). No cost column is read. Read only and STABLE.
-- Grants: authenticated and service_role only.

CREATE FUNCTION public.get_orders_page(
  p_from date,
  p_to date,
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_planned boolean DEFAULT NULL,
  p_pricing_status text DEFAULT NULL,
  p_needs_split_billing boolean DEFAULT NULL,
  p_sort_key text DEFAULT NULL,
  p_sort_dir text DEFAULT 'asc',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_search text := NULLIF(lower(btrim(p_search)), '');
  v_desc boolean := lower(COALESCE(p_sort_dir, 'asc')) = 'desc';
  v_result jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'ORDERS_PAGE_DATES_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_sort_key IS NOT NULL AND p_sort_key NOT IN
     ('order_number', 'status', 'total_price', 'order_date', 'fulfillment_pct', 'invoiced_pct') THEN
    RAISE EXCEPTION 'ORDERS_PAGE_BAD_SORT: %', p_sort_key USING ERRCODE = '22023';
  END IF;
  IF lower(COALESCE(p_sort_dir, 'asc')) NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'ORDERS_PAGE_BAD_SORT_DIR: %', p_sort_dir USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'ORDERS_PAGE_BAD_RANGE: limit % offset %', p_limit, p_offset USING ERRCODE = '22023';
  END IF;

  WITH base AS (
    SELECT
      o.id, o.order_number, o.quote_id, o.customer_id, o.status, o.commission_split, o.total_price,
      o.order_date, o.notes, o.created_at, o.updated_at, o.season, o.salesman_id, o.deleted_at,
      o.order_name, o.customer_po_number, o.is_planned, o.program_notes, o.booking_draw,
      o.pricing_status, o.pricing_reminder_sent_at, o.pricing_escalation_sent_at,
      o.needs_split_billing, o.row_version,
      CASE WHEN c.id IS NULL THEN NULL
           ELSE jsonb_build_object('farm_name', c.farm_name, 'parent_customer_id', c.parent_customer_id)
      END AS customer,
      COALESCE(c.farm_name, '') AS customer_name,
      pc.farm_name AS farm_group_name,
      -- bigint: an odd order (delivered far past needed) shows a large %, never fails the whole list.
      CASE WHEN it.needed > 0 THEN round(it.delivered / it.needed * 100)::bigint ELSE 0 END AS fulfillment_pct,
      CASE WHEN round(COALESCE(o.total_price, 0) * 100) > 0
           THEN LEAST(round(COALESCE(inv.cents, 0)::numeric / round(o.total_price * 100) * 100), 100)::integer
           ELSE 0 END AS invoiced_pct,
      COALESCE(d.n, 0)::integer AS active_delivery_count,
      d.earliest AS earliest_delivery_date,
      COALESCE(it.product_names, '') AS product_names
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN customers pc ON pc.id = c.parent_customer_id
    LEFT JOIN LATERAL (
      SELECT sum(COALESCE(oi.total_units_needed, 0) * COALESCE(oi.price_per_unit, 0)) AS needed,
             sum(COALESCE(oi.quantity_delivered, 0) * COALESCE(oi.price_per_unit, 0)) AS delivered,
             string_agg(DISTINCT NULLIF(oi.product_name, ''), ', ') AS product_names
        FROM order_items oi
       WHERE oi.order_id = o.id
    ) it ON true
    LEFT JOIN LATERAL (
      SELECT sum(i.total_amount_cents) AS cents
        FROM invoices i
       WHERE i.order_id = o.id
         AND i.status NOT IN ('voided', 'cancelled')
         AND i.deleted_at IS NULL
         AND i.invoice_type IS DISTINCT FROM 'credit_memo'
    ) inv ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, min(dl.scheduled_date) AS earliest
        FROM deliveries dl
       WHERE dl.order_id = o.id
         AND dl.status IN ('scheduled', 'in_progress')
    ) d ON true
    WHERE o.deleted_at IS NULL
      AND o.order_date BETWEEN p_from AND p_to
      AND (p_status IS NULL OR o.status = p_status)
      AND (p_planned IS NULL OR COALESCE(o.is_planned, false) = p_planned)
      AND (p_pricing_status IS NULL OR o.pricing_status = p_pricing_status)
      AND (p_needs_split_billing IS NOT TRUE OR o.needs_split_billing IS TRUE)
  ),
  matched AS (
    SELECT b.*,
           row_number() OVER (ORDER BY
             CASE WHEN p_sort_key = 'order_number' AND NOT v_desc THEN b.order_number END ASC NULLS LAST,
             CASE WHEN p_sort_key = 'order_number' AND v_desc THEN b.order_number END DESC NULLS LAST,
             CASE WHEN p_sort_key = 'status' AND NOT v_desc THEN b.status END ASC NULLS LAST,
             CASE WHEN p_sort_key = 'status' AND v_desc THEN b.status END DESC NULLS LAST,
             CASE WHEN p_sort_key = 'total_price' AND NOT v_desc THEN b.total_price END ASC NULLS LAST,
             CASE WHEN p_sort_key = 'total_price' AND v_desc THEN b.total_price END DESC NULLS LAST,
             CASE WHEN p_sort_key = 'order_date' AND NOT v_desc THEN b.order_date END ASC NULLS LAST,
             CASE WHEN p_sort_key = 'order_date' AND v_desc THEN b.order_date END DESC NULLS LAST,
             CASE WHEN p_sort_key = 'fulfillment_pct' AND NOT v_desc THEN b.fulfillment_pct END ASC NULLS LAST,
             CASE WHEN p_sort_key = 'fulfillment_pct' AND v_desc THEN b.fulfillment_pct END DESC NULLS LAST,
             CASE WHEN p_sort_key = 'invoiced_pct' AND NOT v_desc THEN b.invoiced_pct END ASC NULLS LAST,
             CASE WHEN p_sort_key = 'invoiced_pct' AND v_desc THEN b.invoiced_pct END DESC NULLS LAST,
             -- Then newest order date first (the whole order with no column sort; among equal values
             -- otherwise, as the screen's stable sort kept them), then the id so the order is total.
             b.order_date DESC NULLS LAST,
             b.id ASC) AS rn
      FROM base b
     WHERE v_search IS NULL
        OR position(v_search IN lower(COALESCE(b.order_number, ''))) > 0
        OR position(v_search IN lower(b.customer_name)) > 0
        OR position(v_search IN lower(COALESCE(b.farm_group_name, ''))) > 0
        OR position(v_search IN lower(b.product_names)) > 0
  )
  SELECT jsonb_build_object(
           'total_count', count(*),
           'total_price_cents', COALESCE(sum(round(COALESCE(m.total_price, 0) * 100)), 0)::bigint,
           'rows', COALESCE(
             jsonb_agg(to_jsonb(m) - 'rn' ORDER BY m.rn)
               FILTER (WHERE m.rn > p_offset AND m.rn <= p_offset + p_limit),
             '[]'::jsonb))
    INTO v_result
    FROM matched m;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.get_orders_page(date, date, text, text, boolean, text, boolean, text, text, integer, integer) IS
  'Goal 4: one page of the Orders list (season, filters, search, sort; id tie-breaker) with total_count and total_price_cents of every match. SECURITY INVOKER: the caller''s row security applies.';

REVOKE ALL ON FUNCTION public.get_orders_page(date, date, text, text, boolean, text, boolean, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_orders_page(date, date, text, text, boolean, text, boolean, text, text, integer, integer) TO authenticated, service_role;
