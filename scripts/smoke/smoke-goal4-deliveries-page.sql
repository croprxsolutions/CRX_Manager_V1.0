-- Rolled-back smoke chain (Goal 4): the Deliveries list pages, searches and totals in the database.
--
-- Covers get_deliveries_page after 20261130100000_deliveries_list_page.sql.
--
-- Read only: signs in as the oldest active admin (then the active driver with the most deliveries, when
-- one exists) and calls the function as the authenticated role, so row level security applies as it
-- does in the app. Writes nothing.
-- Proves:
--   * pages of 50 return exactly the full read (pages of 500 joined) in the same order, with no repeated
--     id, and total_count equals the full read's row count, for the default order and two column sorts;
--   * total_count equals a direct count of the deliveries that are not cancelled or voided, and the
--     summary's visible_count and open_count equal direct counts;
--   * searching the delivery number of the last row of the default order finds that row;
--   * a driver sees only deliveries assigned to them;
--   * the whole-list read the screen makes (pages of 500 in delivery id order, each after the last id) returns
--     the same rows as the full read, in id order;
--   * a bad page size is refused, and so is a request for every row at once (p_limit NULL) and an id
--     cursor with an offset.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin uuid;
  v_driver uuid;
  v_all jsonb;
  v_r jsonb;
  v_paged text;
  v_total bigint;
  v_n bigint;
  v_offset integer;
  v_sort text;
  v_desc boolean;
  v_last text;
  v_refused boolean;
  v_after uuid;
  v_byid text;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT p.id INTO v_driver FROM public.profiles p
    WHERE p.role = 'driver' AND p.is_active
    ORDER BY (SELECT count(*) FROM public.deliveries d WHERE d.assigned_driver = p.id) DESC, p.id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin is required';
  END IF;
  SELECT count(*) INTO v_n FROM public.deliveries WHERE status NOT IN ('cancelled', 'voided');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- 1. Pages equal the one-shot read, for the default order and two column sorts.
  FOR v_sort, v_desc IN SELECT * FROM (VALUES (NULL::text, false), ('customer_name', false), ('item_count', true)) s LOOP
    -- The full read, as the screen's exports make it: pages of 500 joined end to end.
    v_all := NULL;
    v_offset := 0;
    LOOP
      v_r := public.get_deliveries_page(v_today, v_today - 6, p_sort_key => v_sort, p_sort_desc => v_desc, p_limit => 500, p_offset => v_offset);
      v_all := CASE WHEN v_all IS NULL THEN v_r ELSE jsonb_set(v_all, '{rows}', (v_all->'rows') || (v_r->'rows')) END;
      v_offset := v_offset + 500;
      EXIT WHEN v_offset >= (v_r->>'total_count')::bigint;
    END LOOP;
    v_total := (v_all->>'total_count')::bigint;
    IF (v_all->>'success') IS DISTINCT FROM 'true' OR v_total IS DISTINCT FROM jsonb_array_length(v_all->'rows')::bigint THEN
      RAISE EXCEPTION 'SMOKE_FAIL: sort % one-shot read has % rows but total_count %', v_sort, jsonb_array_length(v_all->'rows'), v_total;
    END IF;
    IF v_total <> v_n THEN
      RAISE EXCEPTION 'SMOKE_FAIL: total_count % but % deliveries are not cancelled or voided', v_total, v_n;
    END IF;
    v_paged := NULL;
    v_offset := 0;
    WHILE v_offset < v_total LOOP
      v_r := public.get_deliveries_page(v_today, v_today - 6, p_sort_key => v_sort, p_sort_desc => v_desc, p_limit => 50, p_offset => v_offset);
      IF (v_r->>'total_count')::bigint <> v_total THEN
        RAISE EXCEPTION 'SMOKE_FAIL: page at % reports total_count %, one-shot %', v_offset, v_r->>'total_count', v_total;
      END IF;
      v_paged := concat_ws(',', v_paged, (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(v_r->'rows') WITH ORDINALITY q(e, o)));
      v_offset := v_offset + 50;
    END LOOP;
    IF v_paged IS DISTINCT FROM (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(v_all->'rows') WITH ORDINALITY q(e, o)) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: sort % pages of 50 differ from the one-shot read', v_sort;
    END IF;
    IF (SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(v_all->'rows') e) <> v_total THEN
      RAISE EXCEPTION 'SMOKE_FAIL: sort % repeats an id', v_sort;
    END IF;
    -- The read by id: same rows, in id order.
    v_byid := NULL;
    v_after := '00000000-0000-0000-0000-000000000000';
    LOOP
      v_r := public.get_deliveries_page(v_today, v_today - 6, p_sort_key => v_sort, p_sort_desc => v_desc, p_limit => 500, p_after_id => v_after);
      v_byid := concat_ws(',', v_byid, (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(v_r->'rows') WITH ORDINALITY q(e, o)));
      EXIT WHEN jsonb_array_length(v_r->'rows') < 500;
      v_after := (v_r->'rows'->-1->>'id')::uuid;
    END LOOP;
    -- Both sides empty (no active deliveries) compare as equal: concat_ws gives '', string_agg gives NULL.
    IF NULLIF(v_byid, '') IS DISTINCT FROM (SELECT string_agg(e->>'id', ',' ORDER BY (e->>'id')::uuid) FROM jsonb_array_elements(v_all->'rows') e) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: sort % read by id differs from the full read', v_sort;
    END IF;
    RAISE NOTICE 'get_deliveries_page sort %: % rows, pages of 50 match', COALESCE(v_sort, 'default'), v_total;
  END LOOP;

  -- 2. Summary counts (the admin reads every delivery under row level security).
  v_all := public.get_deliveries_page(v_today, v_today - 6, p_limit => 1, p_offset => GREATEST(v_n - 1, 0)::integer);
  IF (v_all->'summary'->>'visible_count')::bigint <> v_n
     OR (v_all->'summary'->>'open_count')::bigint
        <> (SELECT count(*) FROM public.deliveries WHERE status IN ('scheduled', 'in_progress')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: summary counts disagree: %', v_all->'summary';
  END IF;

  -- 3. Search finds the last row of the default order.
  IF v_n > 0 THEN
    v_last := v_all->'rows'->0->>'delivery_number';
    v_r := public.get_deliveries_page(v_today, v_today - 6, p_search => v_last, p_limit => 50);
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'rows') e WHERE e->>'delivery_number' = v_last) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: search % did not find its row', v_last;
    END IF;
  END IF;

  -- 4. A bad page size is refused, and so is a request for every row at once, and an id cursor with an offset.
  v_refused := false;
  BEGIN
    v_r := public.get_deliveries_page(v_today, v_today - 6, p_limit => 501);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'DELIVERIES_PAGE_BAD_ARGS%' THEN v_refused := true; ELSE RAISE; END IF;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: p_limit 501 was not refused'; END IF;
  v_refused := false;
  BEGIN
    v_r := public.get_deliveries_page(v_today, v_today - 6, p_limit => NULL);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'DELIVERIES_PAGE_BAD_ARGS%' THEN v_refused := true; ELSE RAISE; END IF;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: p_limit NULL was not refused'; END IF;
  v_refused := false;
  BEGIN
    v_r := public.get_deliveries_page(v_today, v_today - 6, p_limit => 50, p_offset => 50,
                                      p_after_id => '00000000-0000-0000-0000-000000000000');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'DELIVERIES_PAGE_BAD_ARGS%' THEN v_refused := true; ELSE RAISE; END IF;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: an id cursor with an offset was not refused'; END IF;

  -- 5. A driver sees only their own deliveries.
  IF v_driver IS NOT NULL THEN
    EXECUTE 'RESET ROLE';
    SELECT count(*) INTO v_n FROM public.deliveries
     WHERE assigned_driver = v_driver AND status NOT IN ('cancelled', 'voided');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_offset := 0;
    LOOP
      v_r := public.get_deliveries_page(v_today, v_today - 6, p_limit => 500, p_offset => v_offset);
      IF (v_r->>'total_count')::bigint <> v_n
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'rows') e WHERE (e->>'assigned_driver')::uuid IS DISTINCT FROM v_driver) THEN
        RAISE EXCEPTION 'SMOKE_FAIL: the driver sees % rows, % assigned to them', v_r->>'total_count', v_n;
      END IF;
      v_offset := v_offset + 500;
      EXIT WHEN v_offset >= v_n;
    END LOOP;
    RAISE NOTICE 'get_deliveries_page driver: % own rows', v_n;
  END IF;

  -- 6. A sales rep sees every delivery an admin sees; a user of another role with no delivery assigned to them sees none.
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO v_n FROM public.deliveries WHERE status NOT IN ('cancelled', 'voided');
  SELECT id INTO v_driver FROM public.profiles WHERE role = 'sales_rep' AND is_active ORDER BY created_at, id LIMIT 1;
  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_r := public.get_deliveries_page(v_today, v_today - 6, p_limit => 1);
    IF (v_r->>'total_count')::bigint <> v_n OR (v_r->'summary'->>'visible_count')::bigint <> v_n THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the sales rep sees %, expected %', v_r->>'total_count', v_n;
    END IF;
    EXECUTE 'RESET ROLE';
  END IF;
  -- Row level security also shows anyone the deliveries assigned to them, so pick a user with none.
  SELECT p.id INTO v_driver FROM public.profiles p
   WHERE p.is_active AND p.role NOT IN ('admin', 'sales_rep', 'driver')
     AND NOT EXISTS (SELECT 1 FROM public.deliveries d WHERE d.assigned_driver = p.id)
   ORDER BY p.created_at, p.id LIMIT 1;
  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_r := public.get_deliveries_page(v_today, v_today - 6, p_limit => 1);
    IF (v_r->>'total_count')::bigint <> 0 OR (v_r->'summary'->>'visible_count')::bigint <> 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a user with no delivery access sees % deliveries', v_r->>'total_count';
    END IF;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
