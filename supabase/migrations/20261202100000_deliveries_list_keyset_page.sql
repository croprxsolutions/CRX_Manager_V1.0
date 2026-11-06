-- Goal 4 follow-up: the Deliveries list can page by bookmark (keyset), so a page never skips a delivery.
--
-- Why: the Deliveries screen pages get_deliveries_page (20261130100000) by offset. If a delivery leaves the
-- list while someone is browsing (cancelled, voided, or edited out of the filter or search), every later
-- delivery moves up one place and the next page, read at the old offset, skips one. The Orders list had the
-- same skip and was fixed the same way (get_orders_keyset_page, 20261125100000). get_deliveries_page's own
-- p_after_id cannot serve the screen: it walks deliveries in id order, not in the order the screen shows.
--
-- get_deliveries_keyset_page takes the same arguments plus p_after, the bookmark of the last row already shown,
-- and returns the rows that sort strictly after it. Each result adds next_cursor: the bookmark of its last row,
-- or null when no matching row comes after it (or when reading by id). The bookmark records the sort key,
-- direction and p_today it was made for (today decides the default order's today / upcoming / past groups);
-- a bookmark made for any other is refused (DELIVERIES_PAGE_STALE_CURSOR), so the screen restarts at page one.
--
-- How "after the bookmark" is decided: the bookmark is added to the rows being sorted as one placeholder row
-- carrying exactly the values the sort reads (the sort column's value, scheduled date, delivery number, id),
-- and the page is the real rows ranked after it. The test is the sort itself, so it cannot disagree with it.
-- When the bookmarked delivery still exists it ties the placeholder on every sort column; is_mark then puts
-- the placeholder after it, so it is not shown again.
--
-- get_deliveries_page keeps its signature, grants and results (plus a next_cursor key) and now calls this
-- function with no bookmark, so screens already in people's browsers and every full read keep working.
-- Rollback: restore get_deliveries_page's body from 20261130100000 first, then drop get_deliveries_keyset_page
-- (PL/pgSQL records no dependency, so dropping it first would silently break the wrapper).
--
-- The bookmark is tied to the sort and today only: the screen restarts at page one whenever the filters or
-- search change. A delivery edited so it moves across the bookmark can still appear once more or not at all
-- during one walk, as with any paging; what this removes is the skip caused by rows that left before it.
--
-- total_count and summary still cover every match, not only the rows after the bookmark.
-- Security as before: SECURITY INVOKER (row level security decides what each person sees), read only,
-- STABLE. Grants: authenticated and service_role only. No table, row or policy changes.

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERIES_KEYSET_PAGE_ALREADY_EXISTS: get_deliveries_keyset_page is already installed';
  END IF;
  IF to_regprocedure('public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid)') IS NULL THEN
    RAISE EXCEPTION 'DELIVERIES_KEYSET_PAGE_PRECONDITION: get_deliveries_page (20261130100000) must be installed first';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.get_deliveries_keyset_page(
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
      LEFT JOIN public.customers pc ON pc.id = c.parent_customer_id
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

COMMENT ON FUNCTION public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb) IS
  'Goal 4: one page of the Deliveries list after a bookmark (p_after = the previous page''s next_cursor), so rows leaving the list never cause a skip; total_count and summary cover every match. SECURITY INVOKER: row level security applies.';

REVOKE ALL ON FUNCTION public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb) TO authenticated, service_role;

-- The offset version keeps its signature and grants (CREATE OR REPLACE keeps them) and shares one body.
CREATE OR REPLACE FUNCTION public.get_deliveries_page(
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
  p_after_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.get_deliveries_keyset_page(p_today, p_week_start, p_search, p_statuses, p_driver_id, p_priority,
    p_customer_id, p_date_from, p_date_to, p_sort_key, p_sort_desc, p_limit, p_offset, p_after_id, NULL);
END;
$$;

COMMENT ON FUNCTION public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid) IS
  'Goal 4: one page of the Deliveries list by offset or by id (kept for screens already loaded and full reads; get_deliveries_keyset_page pages the screen without skips). Same rows and totals as get_deliveries_keyset_page with no bookmark. SECURITY INVOKER.';

DO $postflight$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb)');
  v_old regprocedure := to_regprocedure('public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_deliveries_keyset_page was not created';
  END IF;
  -- One function of each name, so the wrapper's call and PostgREST never meet an ambiguous overload.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_deliveries_keyset_page') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_deliveries_page') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a second get_deliveries_page or get_deliveries_keyset_page overload exists';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) OR (SELECT prosecdef FROM pg_proc WHERE oid = v_old) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: both deliveries page functions must be SECURITY INVOKER';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_old, 'EXECUTE') OR has_function_privilege('public', v_old, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: anon or PUBLIC can execute a deliveries page function';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_old, 'EXECUTE') OR NOT has_function_privilege('service_role', v_old, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: authenticated or service_role cannot execute a deliveries page function';
  END IF;
END;
$postflight$;
