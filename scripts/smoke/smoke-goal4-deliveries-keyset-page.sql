-- Rolled-back smoke chain (Goal 4 follow-up): the Deliveries list bookmark (keyset) paging on live data.
--
-- Covers get_deliveries_keyset_page (and get_deliveries_page, now its wrapper) after
-- 20261202100000_deliveries_list_keyset_page.sql.
--
-- Read only: signs in as the oldest active admin (then the active driver with the most deliveries, when one
-- exists) and calls the functions as the authenticated role, so row level security applies. Writes nothing.
-- Proves, for the default order and three column sorts:
--   * following next_cursor in pages of 7 returns exactly the offset read (pages of 500 joined), in the same
--     order, and the last page carries no next_cursor;
--   * get_deliveries_page returns the same first page as get_deliveries_keyset_page;
--   * a bookmark made for another sort is refused;
--   * a driver's bookmark pages list only deliveries assigned to them.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin uuid;
  v_driver uuid;
  v_r jsonb;
  v_first jsonb;
  v_after jsonb;
  v_offset integer;
  v_total bigint;
  v_full text;
  v_keyset text;
  v_pages integer;
  v_sort text;
  v_desc boolean;
  v_refused boolean := false;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT p.id INTO v_driver FROM public.profiles p
    WHERE p.role = 'driver' AND p.is_active
    ORDER BY (SELECT count(*) FROM public.deliveries d WHERE d.assigned_driver = p.id) DESC, p.id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin is required';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  FOR v_sort, v_desc IN SELECT * FROM (VALUES (NULL::text, false), ('customer_name', false), ('priority', true), ('item_count', true)) s LOOP
    -- The offset read: pages of 500 joined.
    v_full := NULL;
    v_offset := 0;
    LOOP
      v_r := public.get_deliveries_page(v_today, v_today - 6, p_sort_key => v_sort, p_sort_desc => v_desc, p_limit => 500, p_offset => v_offset);
      v_total := (v_r->>'total_count')::bigint;
      v_full := concat_ws(',', v_full, (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(v_r->'rows') WITH ORDINALITY q(e, o)));
      v_offset := v_offset + 500;
      EXIT WHEN v_offset >= v_total;
    END LOOP;

    -- The bookmark read: pages of 7, each after the previous page's next_cursor.
    v_keyset := NULL;
    v_after := NULL;
    v_pages := 0;
    LOOP
      v_r := public.get_deliveries_keyset_page(v_today, v_today - 6, p_sort_key => v_sort, p_sort_desc => v_desc, p_limit => 7, p_after => v_after);
      v_pages := v_pages + 1;
      IF (v_r->>'total_count')::bigint <> v_total OR jsonb_array_length(v_r->'rows') > 7 THEN
        RAISE EXCEPTION 'SMOKE_FAIL: sort % bookmark page % has % rows, total_count % (offset read %)',
          v_sort, v_pages, jsonb_array_length(v_r->'rows'), v_r->>'total_count', v_total;
      END IF;
      v_keyset := concat_ws(',', v_keyset, (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(v_r->'rows') WITH ORDINALITY q(e, o)));
      EXIT WHEN jsonb_typeof(v_r->'next_cursor') IS DISTINCT FROM 'object';
      v_after := v_r->'next_cursor';
      IF v_pages > 100000 THEN
        RAISE EXCEPTION 'SMOKE_FAIL: next_cursor never ended';
      END IF;
    END LOOP;
    IF v_keyset IS DISTINCT FROM v_full THEN
      RAISE EXCEPTION 'SMOKE_FAIL: sort % % bookmark pages of 7 differ from the offset read', v_sort, v_desc;
    END IF;

    v_first := public.get_deliveries_keyset_page(v_today, v_today - 6, p_sort_key => v_sort, p_sort_desc => v_desc, p_limit => 7);
    IF public.get_deliveries_page(v_today, v_today - 6, p_sort_key => v_sort, p_sort_desc => v_desc, p_limit => 7) IS DISTINCT FROM v_first THEN
      RAISE EXCEPTION 'SMOKE_FAIL: sort % get_deliveries_page and get_deliveries_keyset_page disagree on page one', v_sort;
    END IF;
    RAISE NOTICE 'get_deliveries_keyset_page: sort % desc %: % deliveries, % bookmark pages of 7 equal the offset read',
      COALESCE(v_sort, 'default'), v_desc, v_total, v_pages;
  END LOOP;

  -- A bookmark made for the default order, read with the status sort (built here, so it runs on any data).
  BEGIN
    PERFORM public.get_deliveries_keyset_page(v_today, v_today - 6, p_sort_key => 'status', p_limit => 1,
      p_after => jsonb_build_object('k', NULL, 'dir', 'asc', 'today', to_char(v_today, 'YYYY-MM-DD'), 'v', NULL, 's', to_char(v_today, 'YYYY-MM-DD'), 'n', 'SMOKE', 'id', gen_random_uuid()));
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE 'DELIVERIES_PAGE_STALE_CURSOR%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a bookmark from another sort was not refused';
  END IF;
  EXECUTE 'RESET ROLE';

  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_after := NULL;
    v_pages := 0;
    LOOP
      v_r := public.get_deliveries_keyset_page(v_today, v_today - 6, p_limit => 7, p_after => v_after);
      v_pages := v_pages + 1;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'rows') e WHERE (e->>'assigned_driver')::uuid IS DISTINCT FROM v_driver) THEN
        EXECUTE 'RESET ROLE';
        RAISE EXCEPTION 'SMOKE_FAIL: a driver''s bookmark page holds a delivery assigned to someone else';
      END IF;
      EXIT WHEN jsonb_typeof(v_r->'next_cursor') IS DISTINCT FROM 'object';
      v_after := v_r->'next_cursor';
      IF v_pages > 100000 THEN
        EXECUTE 'RESET ROLE';
        RAISE EXCEPTION 'SMOKE_FAIL: the driver''s next_cursor never ended';
      END IF;
    END LOOP;
    EXECUTE 'RESET ROLE';
    RAISE NOTICE 'get_deliveries_keyset_page: the busiest active driver''s % bookmark pages hold only their own deliveries', v_pages;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
