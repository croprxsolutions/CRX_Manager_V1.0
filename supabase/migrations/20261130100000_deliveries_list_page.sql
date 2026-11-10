-- Goal 4: the Deliveries list reads one page at a time, with search, filters, sort and totals in the database.
--
-- Why: the Deliveries screen reads every delivery the user may see and then filters, searches, sorts and
-- counts in the browser. At volume that is slow and every number depends on the whole read succeeding.
-- get_deliveries_page returns one page of matching rows plus the true totals, all from one snapshot:
--   rows         the page, each row the full delivery plus customer_name, driver_name, item_count and
--                farm_group_name, exactly as the screen builds them today, and sort_position (its place in
--                the chosen order)
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
-- A new function, plus one CHECK constraint so no delivery id is the nil uuid (the read by id's start
-- cursor). No row, policy or existing function changes. Grants: authenticated and service_role only.

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERIES_PAGE_ALREADY_EXISTS: get_deliveries_page is already installed';
  END IF;
END;
$preflight$;

-- Ids come from gen_random_uuid() (never all zeros); this makes that a rule, so the nil start cursor skips nothing.
ALTER TABLE public.deliveries ADD CONSTRAINT deliveries_id_not_nil CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid);

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
  p_offset integer DEFAULT 0,
  p_after_id uuid DEFAULT NULL
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
  -- p_after_id reads the matching rows in delivery id order, the p_limit after that id (the nil uuid
  -- starts at the beginning; deliveries_id_not_nil below guarantees no delivery has it). Ids never change, so a full read made this way skips or repeats no
  -- delivery that exists for the whole read, whatever is edited meanwhile; the caller then sorts the
  -- rows by sort_position.
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
               THEN (SELECT count(*) FROM public.delivery_items di WHERE di.delivery_id = f.id) END AS item_count
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
                 'item_count', COALESCE(o.item_count,
                   (SELECT count(*) FROM public.delivery_items di WHERE di.delivery_id = o.id)),
                 'farm_group_name', o.farm_group_name,
                 -- The row's place in the chosen order, so a caller reading by id can put the rows back in it.
                 'sort_position', o.ord) ORDER BY CASE WHEN p_after_id IS NULL THEN o.ord END, o.id)
        FROM (
          SELECT o1.* FROM ordered o1
           WHERE p_after_id IS NULL AND o1.ord > p_offset AND o1.ord <= p_offset::bigint + p_limit
          UNION ALL
          SELECT k.* FROM (
            SELECT o2.* FROM ordered o2 WHERE p_after_id IS NOT NULL AND o2.id > p_after_id ORDER BY o2.id LIMIT p_limit
          ) k
        ) o
        JOIN public.deliveries d ON d.id = o.id
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

REVOKE ALL ON FUNCTION public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid)');
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.deliveries'::regclass
                   AND conname = 'deliveries_id_not_nil' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: deliveries_id_not_nil must be a validated CHECK';
  END IF;
END;
$postflight$;
