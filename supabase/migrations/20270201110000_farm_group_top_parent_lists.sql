-- #1995: the Orders and Deliveries lists show, and search, the TOP parent of a farm group.
--
-- Mason decided 2026-11-19 that farm groups may be more than one level deep (a top farm, its child farms, their
-- child farms). get_customer_farm_group (Sales Reports, KI-146 20270127200000) already treats a group as the top
-- parent plus everyone below it. get_orders_keyset_page and get_deliveries_keyset_page still named the DIRECT
-- parent as farm_group_name, so with A > B > C, C's rows said "B" and a search for "A" did not find them.
--
-- Both functions are re-created with the same signature, results, security (SECURITY INVOKER: the caller's row
-- security applies to every customer read), STABLE, search_path, grants and comments. The only change in each
-- body: the one-level parent join becomes a walk up to the top parent. The walk recurses on customer ids with
-- UNION, so it always ends, even if a loop were in the data (KI-146's trigger now refuses new loops); with a loop
-- (no top) the direct parent is shown, as before. A customer with no parent still shows no farm group, and the
-- top farm's own rows still show none. If the caller cannot see an ancestor, the highest one they can see is shown.
-- The wrappers get_orders_page and get_deliveries_page call these functions, so they follow automatically.
--
-- No table, row, policy or grant changes. Live 2026-11-18 (KI-146): 19 grouped customers, all one level, so the
-- lists show the same names today. Rollback: re-run the two CREATE FUNCTION bodies from 20261125100000 and
-- 20261202100000 as CREATE OR REPLACE.

CREATE TEMP TABLE farm_group_top_1995_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.farm_group_top_1995_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.farm_group_top_1995_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  -- The bodies this file replaces (20261125100000 and 20261202100000); anything else means someone changed them since.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.get_orders_keyset_page(date,date,text,text,boolean,text,boolean,text,text,integer,integer,jsonb)'))
     IS DISTINCT FROM '85dfbdbc07adbd339ee6514b3c5d64ca' THEN
    RAISE EXCEPTION 'FARM_GROUP_TOP_BASELINE_DRIFT: get_orders_keyset_page is not the 20261125100000 body (already applied?)';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb)'))
     IS DISTINCT FROM '9bd91f86adf1904bb13fb247acfbbcb8' THEN
    RAISE EXCEPTION 'FARM_GROUP_TOP_BASELINE_DRIFT: get_deliveries_keyset_page is not the 20261202100000 body (already applied?)';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_orders_keyset_page(
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
    LEFT JOIN LATERAL (
      -- #1995: the farm group is the TOP parent (groups may be several levels deep), as in get_customer_farm_group.
      -- The walk recurses on customer ids with UNION, so it always ends, even on a loop (KI-146 refuses new ones).
      WITH RECURSIVE up(id, parent_customer_id) AS (
        SELECT p.id, p.parent_customer_id FROM customers p WHERE p.id = c.parent_customer_id
        UNION
        SELECT p.id, p.parent_customer_id FROM customers p JOIN up u ON p.id = u.parent_customer_id
      )
      -- The top is the ancestor whose own parent is not above it (none, or not visible to the caller). A loop has no
      -- top: the direct parent stands in, as before.
      SELECT COALESCE((SELECT u.id FROM up u
                        WHERE u.parent_customer_id IS NULL
                           OR NOT EXISTS (SELECT 1 FROM up a WHERE a.id = u.parent_customer_id)
                        LIMIT 1), c.parent_customer_id) AS id
    ) fg ON c.parent_customer_id IS NOT NULL
    LEFT JOIN customers pc ON pc.id = fg.id
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

CREATE OR REPLACE FUNCTION public.get_deliveries_keyset_page(
  p_today date,
  p_week_start date,
  p_search text DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_driver_id uuid DEFAULT NULL,
  p_priority text DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sort_key text DEFAULT NULL,
  p_sort_desc boolean DEFAULT false,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_after_id uuid DEFAULT NULL,
  p_after jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_search text := NULLIF(btrim(p_search), '');
  v_pattern text;
  v_dir text := CASE WHEN p_sort_desc THEN 'desc' ELSE 'asc' END;
  -- The bookmark's values, typed as the sort reads them (null when there is no bookmark).
  v_mark_id uuid;
  v_mark_text text;
  v_mark_count bigint;
  v_mark_date date;
  v_mark_number text;
BEGIN
  -- p_today / p_week_start are the browser's own calendar day and week start, as the screen used them.
  IF p_today IS NULL OR p_week_start IS NULL THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_ARGS: p_today and p_week_start are required';
  END IF;
  -- Every call returns at most 500 rows, so no single response can hold the whole delivery history.
  -- Callers that need every matching row (exports, the calendar, the load sheet) read pages of 500.
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_ARGS: p_limit must be 1 to 500';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_ARGS: p_offset must be 0 or more';
  END IF;
  -- p_after_id reads the matching rows in delivery id order, the p_limit after that id (the nil uuid
  -- starts at the beginning; deliveries_id_not_nil guarantees no delivery has it). Ids never change, so a full
  -- read made this way skips or repeats no delivery that exists for the whole read, whatever is edited
  -- meanwhile; the caller then sorts the rows by sort_position.
  IF p_after_id IS NOT NULL AND p_offset <> 0 THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_ARGS: p_after_id pages by id, so p_offset must be 0';
  END IF;
  IF p_sort_key IS NOT NULL AND p_sort_key NOT IN
      ('delivery_number', 'customer_name', 'driver_name', 'scheduled_date', 'priority', 'status', 'item_count') THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_ARGS: unknown sort key %', p_sort_key;
  END IF;
  IF p_sort_desc IS NULL THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_ARGS: p_sort_desc must be true or false';
  END IF;
  IF length(v_search) > 200 THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_ARGS: search text is limited to 200 characters';
  END IF;
  IF v_search IS NOT NULL THEN
    -- A plain case-insensitive "contains": the user's %, _ and \ match themselves.
    v_pattern := '%' || replace(replace(replace(lower(v_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  IF p_after IS NOT NULL THEN
    -- A bookmark already marks the place: an offset on top would skip rows, and a read by id has its own.
    IF p_offset <> 0 OR p_after_id IS NOT NULL THEN
      RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_ARGS: a bookmark pages from its row, so p_offset must be 0 and p_after_id null';
    END IF;
    -- Shape: {k, dir, today, v, s, n, id}; id is required, v / s / n are present as text or null.
    IF jsonb_typeof(p_after) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_after->'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_after->'dir') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_after->'today') IS DISTINCT FROM 'string'
       OR NOT (p_after ? 'k' AND p_after ? 'v' AND p_after ? 's' AND p_after ? 'n')
       OR jsonb_typeof(p_after->'k') NOT IN ('string', 'null')
       OR jsonb_typeof(p_after->'v') NOT IN ('string', 'null')
       OR jsonb_typeof(p_after->'s') NOT IN ('string', 'null')
       OR jsonb_typeof(p_after->'n') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_CURSOR';
    END IF;
    IF (p_after->>'k') IS DISTINCT FROM p_sort_key OR (p_after->>'dir') <> v_dir
       OR (p_after->>'today') <> to_char(p_today, 'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'DELIVERIES_PAGE_STALE_CURSOR';
    END IF;
    -- v carries the sort column's value only for the columns that are not already in s (date) or n (number).
    IF (p_after->>'v') IS NOT NULL AND (p_sort_key IS NULL OR p_sort_key IN ('delivery_number', 'scheduled_date')) THEN
      RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_CURSOR';
    END IF;
    BEGIN
      v_mark_id := (p_after->>'id')::uuid;
      v_mark_date := (p_after->>'s')::date;
      v_mark_number := p_after->>'n';
      v_mark_text := CASE WHEN p_sort_key IN ('customer_name', 'driver_name', 'priority', 'status') THEN p_after->>'v' END;
      v_mark_count := CASE WHEN p_sort_key = 'item_count' THEN (p_after->>'v')::bigint END;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow
                    OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'DELIVERIES_PAGE_BAD_CURSOR';
    END;
  END IF;

  RETURN (
    -- Only the columns the filters, sort and counts need are carried through; the full row is
    -- built for the returned page alone, and item counts are read only for the matching deliveries.
    WITH base AS (
      SELECT
        d.id,
        d.status,
        d.scheduled_date,
        d.assigned_driver,
        d.priority,
        d.customer_id,
        d.completed_at,
        d.delivery_number,
        COALESCE(NULLIF(c.farm_name, ''), 'Unknown') AS customer_name,
        CASE WHEN d.assigned_driver IS NULL THEN 'Unassigned'
             ELSE COALESCE(NULLIF(pv.full_name, ''), 'Unknown driver') END AS driver_name,
        NULLIF(pc.farm_name, '') AS farm_group_name,
        CASE WHEN d.scheduled_date = p_today THEN 1 WHEN d.scheduled_date > p_today THEN 2 ELSE 3 END AS bucket
      FROM public.deliveries d
      LEFT JOIN public.customers c ON c.id = d.customer_id
      LEFT JOIN LATERAL (
        -- #1995: the farm group is the TOP parent (groups may be several levels deep), as in get_customer_farm_group.
        -- The walk recurses on customer ids with UNION, so it always ends, even on a loop (KI-146 refuses new ones).
        WITH RECURSIVE up(id, parent_customer_id) AS (
          SELECT p.id, p.parent_customer_id FROM public.customers p WHERE p.id = c.parent_customer_id
          UNION
          SELECT p.id, p.parent_customer_id FROM public.customers p JOIN up u ON p.id = u.parent_customer_id
        )
        -- The top is the ancestor whose own parent is not above it (none, or not visible to the caller). A loop has no
        -- top: the direct parent stands in, as before.
        SELECT COALESCE((SELECT u.id FROM up u
                          WHERE u.parent_customer_id IS NULL
                             OR NOT EXISTS (SELECT 1 FROM up a WHERE a.id = u.parent_customer_id)
                          LIMIT 1), c.parent_customer_id) AS id
      ) fg ON c.parent_customer_id IS NOT NULL
      LEFT JOIN public.customers pc ON pc.id = fg.id
      LEFT JOIN public.profile_public_view pv ON pv.id = d.assigned_driver
    ),
    visible AS (
      SELECT * FROM base WHERE status NOT IN ('cancelled', 'voided')
    ),
    filtered AS (
      SELECT b.*
      FROM base b
      WHERE (CASE WHEN COALESCE(cardinality(p_statuses), 0) = 0 THEN b.status NOT IN ('cancelled', 'voided')
                  ELSE b.status = ANY (p_statuses) END)
        AND (p_driver_id IS NULL OR b.assigned_driver = p_driver_id)
        AND (p_priority IS NULL OR b.priority = p_priority)
        AND (p_customer_id IS NULL OR b.customer_id = p_customer_id)
        AND (p_date_from IS NULL OR b.scheduled_date >= p_date_from)
        AND (p_date_to IS NULL OR b.scheduled_date <= p_date_to)
        AND (v_pattern IS NULL
             OR lower(b.delivery_number) LIKE v_pattern ESCAPE '\'
             OR lower(b.customer_name) LIKE v_pattern ESCAPE '\'
             OR lower(b.driver_name) LIKE v_pattern ESCAPE '\'
             OR lower(b.farm_group_name) LIKE v_pattern ESCAPE '\')
    ),
    -- Item counts for every matching row only when sorting by them (idx_del_items_delivery); otherwise
    -- they are counted for the returned page alone, below. Row level security checks each item row it
    -- reads, so counting every match on every page was most of the cost at volume.
    counted AS (
      SELECT f.*, CASE WHEN p_sort_key = 'item_count'
               THEN (SELECT count(*) FROM public.delivery_items di WHERE di.delivery_id = f.id) END AS item_count,
             false AS is_mark
      FROM filtered f
    ),
    -- The bookmark as one placeholder row: only the columns the sort reads carry values.
    marked AS (
      SELECT * FROM counted
      UNION ALL
      SELECT v_mark_id, CASE WHEN p_sort_key = 'status' THEN v_mark_text END, v_mark_date, NULL,
             CASE WHEN p_sort_key = 'priority' THEN v_mark_text END, NULL, NULL, v_mark_number,
             CASE WHEN p_sort_key = 'customer_name' THEN v_mark_text END,
             CASE WHEN p_sort_key = 'driver_name' THEN v_mark_text END, NULL,
             CASE WHEN v_mark_date = p_today THEN 1 WHEN v_mark_date > p_today THEN 2 ELSE 3 END,
             v_mark_count, true
       WHERE p_after IS NOT NULL
    ),
    ordered AS (
      SELECT f.*, row_number() OVER (ORDER BY
        -- A chosen column first, either direction; empty values last either way, as the screen sorts them.
        -- Rows tied on it keep the default order below, as the screen's stable sort keeps them.
        CASE WHEN NOT p_sort_desc THEN CASE p_sort_key
          WHEN 'delivery_number' THEN f.delivery_number WHEN 'customer_name' THEN f.customer_name
          WHEN 'driver_name' THEN f.driver_name WHEN 'priority' THEN f.priority WHEN 'status' THEN f.status END END ASC NULLS LAST,
        CASE WHEN p_sort_desc THEN CASE p_sort_key
          WHEN 'delivery_number' THEN f.delivery_number WHEN 'customer_name' THEN f.customer_name
          WHEN 'driver_name' THEN f.driver_name WHEN 'priority' THEN f.priority WHEN 'status' THEN f.status END END DESC NULLS LAST,
        CASE WHEN NOT p_sort_desc AND p_sort_key = 'scheduled_date' THEN f.scheduled_date END ASC NULLS LAST,
        CASE WHEN p_sort_desc AND p_sort_key = 'scheduled_date' THEN f.scheduled_date END DESC NULLS LAST,
        CASE WHEN NOT p_sort_desc AND p_sort_key = 'item_count' THEN f.item_count END ASC NULLS LAST,
        CASE WHEN p_sort_desc AND p_sort_key = 'item_count' THEN f.item_count END DESC NULLS LAST,
        -- Default: today first, then upcoming (soonest first), then past (newest first), then number.
        f.bucket,
        CASE WHEN f.bucket < 3 THEN f.scheduled_date END ASC,
        CASE WHEN f.bucket = 3 THEN f.scheduled_date END DESC,
        f.delivery_number,
        -- The unique tie-breaker: no row repeats or goes missing across pages.
        f.id,
        -- The placeholder after the bookmarked row itself, so that row is not shown twice.
        f.is_mark
      ) AS ord
      FROM marked f
    ),
    -- The page starts after the placeholder, or at p_offset with no bookmark.
    start_at AS (
      SELECT COALESCE((SELECT o.ord FROM ordered o WHERE o.is_mark), p_offset::bigint) AS n
    ),
    pg AS (
      SELECT o1.* FROM ordered o1, start_at s
       WHERE p_after_id IS NULL AND NOT o1.is_mark AND o1.ord > s.n AND o1.ord <= s.n + p_limit
      UNION ALL
      SELECT k.* FROM (
        SELECT o2.* FROM ordered o2 WHERE p_after_id IS NOT NULL AND o2.id > p_after_id ORDER BY o2.id LIMIT p_limit
      ) k
    ),
    last_row AS (
      SELECT l.* FROM pg l WHERE p_after_id IS NULL ORDER BY l.ord DESC LIMIT 1
    )
    SELECT jsonb_build_object(
      'success', true,
      'total_count', (SELECT count(*) FROM filtered),
      'rows', COALESCE((
        SELECT jsonb_agg(to_jsonb(d) || jsonb_build_object(
                 'customer_name', o.customer_name,
                 'driver_name', o.driver_name,
                 'item_count', COALESCE(o.item_count,
                   (SELECT count(*) FROM public.delivery_items di WHERE di.delivery_id = o.id)),
                 'farm_group_name', o.farm_group_name,
                 -- The row's place in the chosen order, so a caller reading by id can put the rows back in it
                 -- (after a bookmark, the placeholder's own place is not counted).
                 'sort_position', o.ord - CASE WHEN p_after IS NULL THEN 0 ELSE 1 END)
                 ORDER BY CASE WHEN p_after_id IS NULL THEN o.ord END, o.id)
        FROM pg o
        JOIN public.deliveries d ON d.id = o.id
      ), '[]'::jsonb),
      -- The bookmark of the page's last row, only when a matching row follows it.
      'next_cursor', (
        SELECT jsonb_build_object(
                 'k', p_sort_key, 'dir', v_dir, 'today', to_char(p_today, 'YYYY-MM-DD'),
                 'v', CASE p_sort_key WHEN 'customer_name' THEN l.customer_name WHEN 'driver_name' THEN l.driver_name
                        WHEN 'priority' THEN l.priority WHEN 'status' THEN l.status
                        WHEN 'item_count' THEN l.item_count::text END,
                 's', to_char(l.scheduled_date, 'YYYY-MM-DD'), 'n', l.delivery_number, 'id', l.id::text)
          FROM last_row l
         WHERE EXISTS (SELECT 1 FROM ordered a WHERE NOT a.is_mark AND a.ord > l.ord)
      ),
      'summary', jsonb_build_object(
        'visible_count', (SELECT count(*) FROM visible),
        'open_count', (SELECT count(*) FROM visible WHERE status IN ('scheduled', 'in_progress')),
        'scheduled_today', (SELECT count(*) FROM visible
                             WHERE scheduled_date = p_today AND status IN ('scheduled', 'in_progress')),
        'in_progress', (SELECT count(*) FROM visible WHERE status = 'in_progress'),
        -- The screen compared the UTC date of completed_at with the browser's week start.
        'completed_this_week', (SELECT count(*) FROM visible
                                 WHERE status = 'completed' AND completed_at IS NOT NULL
                                   AND (completed_at AT TIME ZONE 'UTC')::date >= p_week_start),
        'strip', (
          SELECT jsonb_agg(jsonb_build_object(
                   'date', day.d,
                   'count', (SELECT count(*) FROM visible v WHERE v.scheduled_date = day.d),
                   'unassigned', (SELECT count(*) FROM visible v WHERE v.scheduled_date = day.d AND v.assigned_driver IS NULL))
                 ORDER BY day.d)
          FROM (SELECT p_today + i AS d FROM generate_series(0, 6) i) day
        )
      )
    )
  );
END;
$$;

DO $postflight$
DECLARE
  v_fn text;
BEGIN
  IF (SELECT transaction_id FROM pg_temp.farm_group_top_1995_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  -- Both keep their shape and grants: invoker, stable, fixed search_path, authenticated and service_role only.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.get_orders_keyset_page(date,date,text,text,boolean,text,boolean,text,text,integer,integer,jsonb)',
    'public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb)']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(v_fn)
         AND NOT p.prosecdef AND p.provolatile = 's'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']
         AND p.prosrc LIKE '%WITH RECURSIVE up(id, parent_customer_id)%')
       OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % shape or grants wrong', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
