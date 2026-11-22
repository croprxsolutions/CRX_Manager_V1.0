-- #2162 (#2018 step 2): drivers read farm (customer) details only through get_driver_customers(uuid[]).
--
-- Until now the customers_select read rule let a driver read the WHOLE customers row (credit limit, prepay
-- balance, payment terms, notes, every column) of any farm on a delivery assigned to them dated yesterday or
-- later, and since #2018 a driver can pick that farm by taking an open delivery. Mason accepted that for one
-- release only (Sol on #2161, #2187, #2165; DECISION_LOG.md); this file removes it.
--
-- 1. customers_select loses its driver branch; its admin, sales rep and applicator branches are unchanged.
--    customers_select_location_dispatchee (job dispatches) no longer admits an active driver: office staff may add
--    any profile to a field crew, so a driver on a dispatched crew would otherwise still read the whole row. It is
--    unchanged for everyone else. A driver then reads no customers row directly; the driver screens (#2165) already
--    read farm name, phone, email and addresses through get_driver_customers.
-- 2. New _delivery_list_customer_labels(): SECURITY DEFINER, STABLE, names only: id, farm_name and the TOP farm
--    group name (the same walk as #1995). An active admin or sales rep gets a label for every customer on any
--    delivery; an active driver only for customers on deliveries assigned to them; anyone else (an inactive user,
--    another role holding an old assignment) nothing, as is_driver() gave them before. Never another column.
-- 3. get_deliveries_keyset_page (SECURITY INVOKER, unchanged otherwise) reads its customer name and farm group
--    from that helper instead of customers, so a driver's Deliveries list keeps its farm names. Signature,
--    results, order, search, paging, security, grants and comment unchanged. For admin and sales rep the output is
--    identical (they read every customer before too). A driver now also sees the name on their deliveries older
--    than yesterday (before: "Unknown"); Mason decided drivers may see every farm's name (2026-11-21).
--
-- Go-live order (Mason's two-step decision, 2026-11-21): apply only once the #2165 driver screens are live in
-- production. A driver on an older app copy reads customers directly and would see "Unknown customer" and no
-- phone or address. No row changes.
--
-- Recovery: fix forward (repair the helper, the list or the screens); the drivers' whole-row read stays closed.
-- Restoring it (the 20261013220000 customers_select and 20260626120000 dispatchee rule) would reopen the credit,
-- prepay, terms and notes exposure and needs Mason's explicit security decision first.

CREATE TEMP TABLE drivers_farm_read_2162_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.drivers_farm_read_2162_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.drivers_farm_read_2162_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  -- The rule and body this file replaces; anything else means someone changed them since (or a re-apply).
  IF (SELECT md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select')
     IS DISTINCT FROM '7b5322d993fa4ad4714e66baf5bc8738' THEN
    RAISE EXCEPTION 'DRIVER_FARM_READ_BASELINE_DRIFT: customers_select is not the 20261013220000 rule (already applied?)';
  END IF;
  IF (SELECT md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select_location_dispatchee')
     IS DISTINCT FROM '7e0066e0ab2cc42f8ce8c6249eebd700' THEN
    RAISE EXCEPTION 'DRIVER_FARM_READ_BASELINE_DRIFT: customers_select_location_dispatchee is not the 20260626120000 rule';
  END IF;
  -- Only these two rules let anyone read customers rows, so ending the drivers' read in both ends it.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND cmd IN ('SELECT', 'ALL')) <> 2 THEN
    RAISE EXCEPTION 'DRIVER_FARM_READ_BASELINE_DRIFT: customers has a read rule this file does not know';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb)'))
     IS DISTINCT FROM '1b9cc4f781e446830967dc808b318383' THEN
    RAISE EXCEPTION 'DRIVER_FARM_READ_BASELINE_DRIFT: get_deliveries_keyset_page is not the 20270201110000 body';
  END IF;
  IF to_regprocedure('public._delivery_list_customer_labels()') IS NOT NULL THEN
    RAISE EXCEPTION 'DRIVER_FARM_READ_BASELINE_DRIFT: _delivery_list_customer_labels already exists';
  END IF;
END;
$preflight$;

-- 2. The list's name source: names only, for the deliveries the caller may see.
CREATE FUNCTION public._delivery_list_customer_labels()
RETURNS TABLE (id uuid, farm_name text, farm_group_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH me AS (
    SELECT p.id, p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active
  ), shown AS (
    -- Office: every delivery (del_select shows them all). A driver: deliveries assigned to them.
    SELECT DISTINCT d.customer_id
      FROM public.deliveries d
      JOIN me ON me.role IN ('admin', 'sales_rep') OR (me.role = 'driver' AND d.assigned_driver = me.id)
     WHERE d.customer_id IS NOT NULL
  )
  SELECT c.id, c.farm_name, pc.farm_name
    FROM shown s
    JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN LATERAL (
      -- #1995: the farm group is the TOP parent. The walk recurses on customer ids with UNION, so it always ends;
      -- a loop has no top, so the direct parent stands in, as in get_deliveries_keyset_page before.
      WITH RECURSIVE up(id, parent_customer_id) AS (
        SELECT p.id, p.parent_customer_id FROM public.customers p WHERE p.id = c.parent_customer_id
        UNION
        SELECT p.id, p.parent_customer_id FROM public.customers p JOIN up u ON p.id = u.parent_customer_id
      )
      SELECT COALESCE((SELECT u.id FROM up u
                        WHERE u.parent_customer_id IS NULL
                           OR NOT EXISTS (SELECT 1 FROM up a WHERE a.id = u.parent_customer_id)
                        LIMIT 1), c.parent_customer_id) AS id
    ) fg ON c.parent_customer_id IS NOT NULL
    LEFT JOIN public.customers pc ON pc.id = fg.id;
$function$;

REVOKE ALL ON FUNCTION public._delivery_list_customer_labels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._delivery_list_customer_labels() TO authenticated, service_role;
COMMENT ON FUNCTION public._delivery_list_customer_labels() IS
  '#2162: farm name and top farm group name (never another customers column) for the customers on the deliveries the caller may see (active office: all; active driver: assigned to them; anyone else: none). The Deliveries list''s name source.';

-- 3. The Deliveries list reads names from the helper (body otherwise the 20270201110000 one).
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
        COALESCE(NULLIF(lbl.farm_name, ''), 'Unknown') AS customer_name,
        CASE WHEN d.assigned_driver IS NULL THEN 'Unassigned'
             ELSE COALESCE(NULLIF(pv.full_name, ''), 'Unknown driver') END AS driver_name,
        NULLIF(lbl.farm_group_name, '') AS farm_group_name,
        CASE WHEN d.scheduled_date = p_today THEN 1 WHEN d.scheduled_date > p_today THEN 2 ELSE 3 END AS bucket
      FROM public.deliveries d
      -- #2162: farm names and the top farm group come from the label helper (names only), not from customers,
      -- which a driver may no longer read.
      LEFT JOIN public._delivery_list_customer_labels() lbl ON lbl.id = d.customer_id
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

-- 1. Drivers no longer read customers rows directly (everyone else as before).
ALTER POLICY customers_select ON public.customers
  USING (
    is_admin()
    OR is_sales_rep()
    OR (is_applicator() AND (EXISTS (
      SELECT 1 FROM public.jobs j
       WHERE j.customer_id = customers.id
         AND j.applicator_id = (SELECT auth.uid() AS uid)
         AND j.job_date >= (CURRENT_DATE - '7 days'::interval))))
  );
ALTER POLICY customers_select_location_dispatchee ON public.customers
  USING (
    NOT is_driver()
    AND EXISTS (
      SELECT 1 FROM public.jobs j
       WHERE j.customer_id = customers.id
         AND public._is_dispatched_to_me(j.id)
    )
  );

DO $postflight$
BEGIN
  IF (SELECT transaction_id FROM pg_temp.drivers_farm_read_2162_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select')
     IS DISTINCT FROM 'a29e215314ac02cbe39e4a53423d4656' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: customers_select is not this file''s rule';
  END IF;
  IF (SELECT md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select_location_dispatchee')
     IS DISTINCT FROM '3319c0edd05857b6f00bcde285379af2' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: customers_select_location_dispatchee is not this file''s rule';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) || prosecdef::text FROM pg_proc
       WHERE oid = to_regprocedure('public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb)'))
     IS DISTINCT FROM '36c3bcd0e650d0d3c360d2b474c4ff44false' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_deliveries_keyset_page is not this file''s invoker body';
  END IF;
  IF (SELECT prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=public, pg_temp']
        FROM pg_proc WHERE oid = to_regprocedure('public._delivery_list_customer_labels()')) IS NOT TRUE
     OR has_function_privilege('anon', 'public._delivery_list_customer_labels()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public._delivery_list_customer_labels()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public._delivery_list_customer_labels()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: _delivery_list_customer_labels must be definer, stable, fixed search_path, authenticated and service_role only';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
