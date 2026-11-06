-- Rolled-back smoke chain (Goal 4 follow-up): the Orders list bookmark (keyset) paging on live data.
--
-- Covers get_orders_keyset_page after 20261125100000_orders_list_keyset_page.sql.
--
-- Read only: signs in as the oldest active admin (and the oldest active driver, when one exists), calls
-- the function under the authenticated role so row security applies, and writes nothing.
-- Proves, for the current season (Oct 1 to Sep 30):
--   * total_count and total_price_cents equal the table (each order rounded to whole cents);
--   * following next_cursor in pages of 7 returns each season order exactly once, newest order date
--     first, ties by id, and the last page carries no next_cursor;
--   * get_orders_page (now a wrapper) returns the same first page;
--   * a bookmark made for another sort is refused;
--   * an active driver, when one exists, sees no order.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin uuid;
  v_driver uuid;
  v_season integer := EXTRACT(year FROM current_date)::integer + CASE WHEN EXTRACT(month FROM current_date) >= 10 THEN 1 ELSE 0 END;
  v_from date := make_date(v_season - 1, 10, 1);
  v_to date := make_date(v_season, 9, 30);
  v_count bigint;
  v_cents bigint;
  v_r jsonb;
  v_first jsonb;
  v_after jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_expected uuid[];
  v_pages integer := 0;
  v_refused boolean := false;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_driver FROM public.profiles WHERE role = 'driver' AND is_active ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin is required';
  END IF;

  SELECT count(*), COALESCE(sum(round(COALESCE(total_price, 0) * 100)), 0)::bigint,
         array_agg(id ORDER BY order_date DESC, id)
    INTO v_count, v_cents, v_expected
    FROM public.orders
   WHERE deleted_at IS NULL AND order_date BETWEEN v_from AND v_to;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  LOOP
    v_r := public.get_orders_keyset_page(v_from, v_to, p_limit => 7, p_after => v_after);
    v_pages := v_pages + 1;
    IF (v_r->>'total_count')::bigint IS DISTINCT FROM v_count
       OR (v_r->>'total_price_cents')::bigint IS DISTINCT FROM v_cents THEN
      RESET ROLE;
      RAISE EXCEPTION 'SMOKE_FAIL: totals % / % cents, table says % / % cents',
        v_r->>'total_count', v_r->>'total_price_cents', v_count, v_cents;
    END IF;
    IF jsonb_array_length(v_r->'rows') > 7 THEN
      RESET ROLE;
      RAISE EXCEPTION 'SMOKE_FAIL: a page of 7 held % rows', jsonb_array_length(v_r->'rows');
    END IF;
    v_ids := v_ids || ARRAY(SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_r->'rows') WITH ORDINALITY t(e, o) ORDER BY o);
    EXIT WHEN jsonb_typeof(v_r->'next_cursor') IS DISTINCT FROM 'object';
    v_after := v_r->'next_cursor';
    IF v_pages > 100000 THEN
      RESET ROLE;
      RAISE EXCEPTION 'SMOKE_FAIL: next_cursor never ended';
    END IF;
  END LOOP;
  IF v_ids IS DISTINCT FROM COALESCE(v_expected, ARRAY[]::uuid[]) THEN
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: bookmark paging returned % ids, expected % in (order_date DESC, id) order',
      cardinality(v_ids), cardinality(v_expected);
  END IF;

  v_first := public.get_orders_keyset_page(v_from, v_to, p_limit => 7);
  v_r := public.get_orders_page(v_from, v_to, p_limit => 7);
  IF v_r IS DISTINCT FROM v_first THEN
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: get_orders_page and get_orders_keyset_page disagree on page one';
  END IF;

  IF jsonb_typeof(v_first->'next_cursor') = 'object' THEN
    BEGIN
      PERFORM public.get_orders_keyset_page(v_from, v_to, p_sort_key => 'status', p_limit => 7, p_after => v_first->'next_cursor');
    EXCEPTION WHEN OTHERS THEN
      v_refused := SQLERRM LIKE 'ORDERS_PAGE_STALE_CURSOR%';
    END;
    IF NOT v_refused THEN
      RESET ROLE;
      RAISE EXCEPTION 'SMOKE_FAIL: a bookmark from another sort was not refused';
    END IF;
  END IF;
  RESET ROLE;
  RAISE NOTICE 'get_orders_keyset_page: season % to %, % orders, % cents, % bookmark pages of 7 match the table',
    v_from, v_to, v_count, v_cents, v_pages;

  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_r := public.get_orders_keyset_page(v_from, v_to);
    RESET ROLE;
    IF (v_r->>'total_count')::bigint <> 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a driver sees % orders', v_r->>'total_count';
    END IF;
    RAISE NOTICE 'get_orders_keyset_page: an active driver sees no order';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
