-- Rolled-back smoke chain (Goal 4): the Orders list page function on live data.
--
-- Covers get_orders_page after 20261116120000_orders_list_page.sql.
--
-- Read only: signs in as the oldest active admin (and the oldest active driver, when one exists), calls
-- the function under the authenticated role so row security applies, and writes nothing.
-- Proves, for the current season (Oct 1 to Sep 30):
--   * total_count equals the season's undeleted orders and total_price_cents equals their totals summed
--     after rounding each to whole cents (counted directly from the table);
--   * reading every page of 7 rows returns each of those orders exactly once, newest order date first,
--     ties by id, and no page holds more than 7 rows;
--   * a search for one order's number finds that order;
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
  v_ids uuid[] := ARRAY[]::uuid[];
  v_expected uuid[];
  v_offset integer := 0;
  v_number text;
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
  SELECT order_number INTO v_number FROM public.orders
   WHERE deleted_at IS NULL AND order_date BETWEEN v_from AND v_to ORDER BY order_date, id LIMIT 1;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  LOOP
    v_r := public.get_orders_page(v_from, v_to, p_limit => 7, p_offset => v_offset);
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
    EXIT WHEN jsonb_array_length(v_r->'rows') < 7;
    v_offset := v_offset + 7;
  END LOOP;
  IF v_ids IS DISTINCT FROM COALESCE(v_expected, ARRAY[]::uuid[]) THEN
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: paging returned % ids, expected % in (order_date DESC, id) order',
      cardinality(v_ids), cardinality(v_expected);
  END IF;
  IF v_number IS NOT NULL THEN
    v_r := public.get_orders_page(v_from, v_to, p_search => v_number);
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'rows') e WHERE e->>'order_number' = v_number) THEN
      RESET ROLE;
      RAISE EXCEPTION 'SMOKE_FAIL: a search for % did not find it', v_number;
    END IF;
  END IF;
  RESET ROLE;
  RAISE NOTICE 'get_orders_page: season % to %, % orders, % cents, % pages of 7 match the table', v_from, v_to, v_count, v_cents, v_offset / 7 + 1;

  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_r := public.get_orders_page(v_from, v_to);
    RESET ROLE;
    IF (v_r->>'total_count')::bigint <> 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a driver sees % orders', v_r->>'total_count';
    END IF;
    RAISE NOTICE 'get_orders_page: an active driver sees no order';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
