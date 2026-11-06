-- Goal 4 follow-up: the Orders list can page by bookmark (keyset), so a page never skips an order.
--
-- Why: get_orders_page (20261116120000) pages by offset. If an order leaves the list while someone is
-- browsing (deleted, or edited so it no longer matches the filter, search or sort position), every later
-- order moves up one place and the next page, read at the old offset, skips one. Sol raised it on PR 1559.
--
-- get_orders_keyset_page takes the same arguments plus p_after, the bookmark of the last row already
-- shown. It returns the rows that sort strictly after that bookmark, so a row leaving the list earlier
-- changes nothing for the next page. Each result carries next_cursor: the bookmark of its last row, or
-- null when no matching row comes after it. The bookmark records the sort key and direction it was made
-- for; a bookmark from another sort is refused (ORDERS_PAGE_STALE_CURSOR), so the screen restarts at
-- page one when the sort changes.
--
-- The sort is the one get_orders_page used: the chosen column (text columns in sk_txt, numeric and date
-- columns in sk_num, the other one always null), nulls last, then order date newest first, then the id.
-- The ORDER BY and the "after the bookmark" test below are written from the same two columns, so the
-- rows after a bookmark are exactly the rows that follow it in the list.
--
-- get_orders_page keeps its signature and results (plus a next_cursor key) and now calls this function
-- with no bookmark, so screens already in people's browsers keep working. Rollback: restore get_orders_page's
-- body from 20261116120000 first, then drop get_orders_keyset_page (plpgsql records no dependency on it).
--
-- The bookmark is tied to the sort key and direction only: the screen restarts at page one whenever the
-- season, filters or search change. An order edited so it moves across the bookmark can still appear once
-- more or not at all during one walk, as with any paging; what this removes is the skip caused by rows
-- that left the list before the bookmark.
--
-- total_count and total_price_cents still cover every match, not only the rows after the bookmark.
-- Security as before: SECURITY INVOKER (the caller's row security applies to every table read), read
-- only, STABLE, no cost column. Grants: authenticated and service_role only.

CREATE FUNCTION public.get_orders_keyset_page(
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
  p_offset integer DEFAULT 0,
  p_after jsonb DEFAULT NULL
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
  v_dir text := CASE WHEN lower(COALESCE(p_sort_dir, 'asc')) = 'desc' THEN 'desc' ELSE 'asc' END;
  v_after_t text;
  v_after_n numeric;
  v_after_d date;
  v_after_id uuid;
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
  IF p_after IS NOT NULL THEN
    IF jsonb_typeof(p_after) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_after->'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_after->'d') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'ORDERS_PAGE_BAD_CURSOR' USING ERRCODE = '22023';
    END IF;
    IF (p_after->>'k') IS DISTINCT FROM p_sort_key OR (p_after->>'dir') IS DISTINCT FROM v_dir THEN
      RAISE EXCEPTION 'ORDERS_PAGE_STALE_CURSOR' USING ERRCODE = '22023';
    END IF;
    -- Only the sort's own column may carry a value (a text key fills t, a number or date key fills n).
    IF ((p_after->>'t') IS NOT NULL AND p_sort_key IS DISTINCT FROM 'order_number' AND p_sort_key IS DISTINCT FROM 'status')
       OR ((p_after->>'n') IS NOT NULL AND (p_sort_key IS NULL OR p_sort_key IN ('order_number', 'status'))) THEN
      RAISE EXCEPTION 'ORDERS_PAGE_BAD_CURSOR' USING ERRCODE = '22023';
    END IF;
    -- ... and it must be there, as text or null (null = the last row's sort value was empty).
    IF (p_sort_key IN ('order_number', 'status')
        AND (NOT p_after ? 't' OR jsonb_typeof(p_after->'t') NOT IN ('string', 'null')))
       OR (p_sort_key IN ('total_price', 'order_date', 'fulfillment_pct', 'invoiced_pct')
        AND (NOT p_after ? 'n' OR jsonb_typeof(p_after->'n') NOT IN ('string', 'null'))) THEN
      RAISE EXCEPTION 'ORDERS_PAGE_BAD_CURSOR' USING ERRCODE = '22023';
    END IF;
    -- A bookmark already marks the place; an offset on top would skip rows.
    IF p_offset <> 0 THEN
      RAISE EXCEPTION 'ORDERS_PAGE_BAD_RANGE: a bookmark pages from its row, so offset must be 0' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_after_t := p_after->>'t';
      v_after_n := (p_after->>'n')::numeric;
      v_after_d := (p_after->>'d')::date;
      v_after_id := (p_after->>'id')::uuid;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'ORDERS_PAGE_BAD_CURSOR' USING ERRCODE = '22023';
    END;
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
             string_agg(DISTINCT NULLIF(oi.product_name, ''), ', ' ORDER BY NULLIF(oi.product_name, '')) AS product_names
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
  keyed AS (
    SELECT b.*,
           CASE p_sort_key WHEN 'order_number' THEN b.order_number WHEN 'status' THEN b.status END AS sk_txt,
           CASE p_sort_key
             WHEN 'total_price' THEN b.total_price
             WHEN 'order_date' THEN (b.order_date - date '2000-01-01')::numeric
             WHEN 'fulfillment_pct' THEN b.fulfillment_pct::numeric
             WHEN 'invoiced_pct' THEN b.invoiced_pct::numeric
           END AS sk_num
      FROM base b
     WHERE v_search IS NULL
        OR position(v_search IN lower(COALESCE(b.order_number, ''))) > 0
        OR position(v_search IN lower(b.customer_name)) > 0
        OR position(v_search IN lower(COALESCE(b.farm_group_name, ''))) > 0
        OR position(v_search IN lower(b.product_names)) > 0
  ),
  matched AS (
    SELECT k.*,
           row_number() OVER (ORDER BY
             CASE WHEN NOT v_desc THEN k.sk_txt END ASC NULLS LAST,
             CASE WHEN v_desc THEN k.sk_txt END DESC NULLS LAST,
             CASE WHEN NOT v_desc THEN k.sk_num END ASC NULLS LAST,
             CASE WHEN v_desc THEN k.sk_num END DESC NULLS LAST,
             -- Then newest order date first (the whole order with no column sort), then the id.
             k.order_date DESC NULLS LAST,
             k.id ASC) AS rn
      FROM keyed k
  ),
  -- The same order as rn, as a test: is row m after the bookmark? Nulls sort last in both directions.
  after_mark AS (
    SELECT m.*
      FROM matched m
     WHERE p_after IS NULL
        OR (v_after_t IS NOT NULL AND (m.sk_txt IS NULL
              OR (NOT v_desc AND m.sk_txt > v_after_t) OR (v_desc AND m.sk_txt < v_after_t)))
        OR (m.sk_txt IS NOT DISTINCT FROM v_after_t AND (
              (v_after_n IS NOT NULL AND (m.sk_num IS NULL
                 OR (NOT v_desc AND m.sk_num > v_after_n) OR (v_desc AND m.sk_num < v_after_n)))
              OR (m.sk_num IS NOT DISTINCT FROM v_after_n AND (
                    m.order_date < v_after_d OR (m.order_date = v_after_d AND m.id > v_after_id)))))
  ),
  pg AS (
    SELECT a.* FROM after_mark a ORDER BY a.rn LIMIT p_limit OFFSET p_offset
  ),
  last_row AS (
    SELECT l.* FROM pg l ORDER BY l.rn DESC LIMIT 1
  )
  SELECT jsonb_build_object(
           'total_count', (SELECT count(*) FROM matched),
           'total_price_cents', (SELECT COALESCE(sum(round(COALESCE(m.total_price, 0) * 100)), 0)::bigint FROM matched m),
           'rows', COALESCE((SELECT jsonb_agg(to_jsonb(p) - 'rn' - 'sk_txt' - 'sk_num' ORDER BY p.rn) FROM pg p), '[]'::jsonb),
           -- Values as text, so the numeric survives a round trip through the browser exactly.
           'next_cursor', (SELECT jsonb_build_object('k', p_sort_key, 'dir', v_dir, 't', l.sk_txt, 'n', l.sk_num::text,
                                                     'd', to_char(l.order_date, 'YYYY-MM-DD'), 'id', l.id::text)
                             FROM last_row l
                            WHERE EXISTS (SELECT 1 FROM after_mark a WHERE a.rn > l.rn)))
    INTO v_result;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.get_orders_keyset_page(date, date, text, text, boolean, text, boolean, text, text, integer, integer, jsonb) IS
  'Goal 4: one page of the Orders list after a bookmark (p_after = the previous page''s next_cursor), so rows leaving the list never cause a skip; total_count and total_price_cents cover every match. SECURITY INVOKER: the caller''s row security applies.';

REVOKE ALL ON FUNCTION public.get_orders_keyset_page(date, date, text, text, boolean, text, boolean, text, text, integer, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_orders_keyset_page(date, date, text, text, boolean, text, boolean, text, text, integer, integer, jsonb) TO authenticated, service_role;

-- The offset version keeps its signature and grants (CREATE OR REPLACE keeps them) and shares one body.
CREATE OR REPLACE FUNCTION public.get_orders_page(
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
BEGIN
  RETURN public.get_orders_keyset_page(p_from, p_to, p_search, p_status, p_planned, p_pricing_status,
                                       p_needs_split_billing, p_sort_key, p_sort_dir, p_limit, p_offset, NULL);
END;
$function$;

COMMENT ON FUNCTION public.get_orders_page(date, date, text, text, boolean, text, boolean, text, text, integer, integer) IS
  'Goal 4: one page of the Orders list by offset (kept for screens already loaded; get_orders_keyset_page pages without skips). Same rows and totals as get_orders_keyset_page with no bookmark. SECURITY INVOKER.';
