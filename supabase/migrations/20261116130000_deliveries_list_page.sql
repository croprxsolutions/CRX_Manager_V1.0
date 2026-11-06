-- Goal 4: the Deliveries list reads one page at a time, with search, filters, sort and totals in the database.
--
-- Why: the Deliveries screen reads every delivery the user may see and then filters, searches, sorts and
-- counts in the browser. At volume that is slow and every number depends on the whole read succeeding.
-- get_deliveries_page returns one page of matching rows plus the true totals, all from one snapshot:
--   rows         the page, each row the full delivery plus customer_name, driver_name, item_count and
--                farm_group_name, exactly as the screen builds them today
--   total_count  every row matching the search and filters
--   summary      the screen's cards and 7-day strip over every visible delivery that is not cancelled or
--                voided (independent of the list's search and filters)
-- Every order ends with the delivery id, so pages never repeat or skip a row because of a tie.
--
-- Security: SECURITY INVOKER, so row level security decides what each person sees, exactly as the
-- screen's direct table reads do today (admins and sales reps: every delivery; drivers: only deliveries
-- assigned to them; anyone else: only a delivery assigned to them, normally none). It reads only;
-- it writes nothing.
--
-- New function only: no table, row, policy or existing function changes. Grants: authenticated and
-- service_role only.

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_ALREADY_EXISTS: get_deliveries_page is already installed';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.get_deliveries_page(
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
  p_offset integer DEFAULT 0
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
    -- Item counts for the matching rows only (idx_del_items_delivery), never the whole items table.
    counted AS (
      SELECT f.*, (SELECT count(*) FROM public.delivery_items di WHERE di.delivery_id = f.id) AS item_count
      FROM filtered f
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
        f.id
      ) AS ord
      FROM counted f
    )
    SELECT jsonb_build_object(
      'success', true,
      'total_count', (SELECT count(*) FROM filtered),
      'rows', COALESCE((
        SELECT jsonb_agg(to_jsonb(d) || jsonb_build_object(
                 'customer_name', o.customer_name,
                 'driver_name', o.driver_name,
                 'item_count', o.item_count,
                 'farm_group_name', o.farm_group_name) ORDER BY o.ord)
        FROM ordered o
        JOIN public.deliveries d ON d.id = o.id
        WHERE o.ord > p_offset
          AND o.ord <= p_offset::bigint + p_limit
      ), '[]'::jsonb),
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

REVOKE ALL ON FUNCTION public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_deliveries_page was not created';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_deliveries_page must be SECURITY INVOKER';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: anon or PUBLIC can execute get_deliveries_page';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: authenticated or service_role cannot execute get_deliveries_page';
  END IF;
END;
$postflight$;
