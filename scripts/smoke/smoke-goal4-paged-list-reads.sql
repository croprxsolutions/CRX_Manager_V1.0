-- Rolled-back smoke chain (Goal 4): the three list functions the screens now read page by page return
-- every row exactly once when paged, on live data.
--
-- Covers get_receiving_log, get_watchdog_flags and get_fields_with_geojson after
-- 20261113110000_paged_read_tiebreakers.sql (each sorts with the row id as its last key).
--
-- Read only: signs in as the oldest active admin and writes nothing.
-- Proves, for each function:
--   * the whole list in one read has no repeated id (the sort is total);
--   * reading it in pages of 50 (the receiving log with its own p_limit/p_offset; the two table
--     functions with LIMIT/OFFSET over separate calls, as the Data API pages them) returns exactly the
--     one-shot read, in the same order;
--   * an active driver, when one exists, is still refused the receiving log and the watchdog list, with
--     their own access-denied errors (any other error fails the chain).
-- Each read is its own statement, so a row written on live between the one-shot read and the pages makes
-- the chain FAIL (never pass falsely): re-run it once before treating a mismatch as a defect.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin uuid;
  v_driver uuid;
  v_all text[];
  v_paged text[];
  v_page text[];
  v_off integer;
  v_n integer;
  v_refused boolean;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_driver FROM public.profiles WHERE role = 'driver' AND is_active ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin is required';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- 1. Receiving log (jsonb array; pages itself).
  SELECT array_agg(e->>'id' ORDER BY o) INTO v_all
    FROM jsonb_array_elements(public.get_receiving_log(100000, 0)) WITH ORDINALITY x(e, o);
  v_all := COALESCE(v_all, '{}');
  IF cardinality(v_all) <> (SELECT count(DISTINCT u) FROM unnest(v_all) u) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_receiving_log repeats an id in one read';
  END IF;
  v_paged := '{}'; v_off := 0;
  LOOP
    SELECT array_agg(e->>'id' ORDER BY o) INTO v_page
      FROM jsonb_array_elements(public.get_receiving_log(50, v_off)) WITH ORDINALITY x(e, o);
    EXIT WHEN v_page IS NULL;
    v_paged := v_paged || v_page; v_off := v_off + 50;
  END LOOP;
  IF v_paged IS DISTINCT FROM v_all THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_receiving_log pages of 50 (% ids) differ from one read (% ids)', cardinality(v_paged), cardinality(v_all);
  END IF;
  RAISE NOTICE 'get_receiving_log: % rows, pages of 50 match', cardinality(v_all);

  -- 2. Watchdog flags (table function, dismissed included so the list is as large as it gets).
  SELECT array_agg(f.id::text ORDER BY f.o) INTO v_all
    FROM (SELECT w.id, w.ordinality AS o FROM public.get_watchdog_flags(p_include_dismissed => true) WITH ORDINALITY w ORDER BY w.ordinality) f;
  v_all := COALESCE(v_all, '{}');
  IF cardinality(v_all) <> (SELECT count(DISTINCT u) FROM unnest(v_all) u) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_watchdog_flags repeats an id in one read';
  END IF;
  v_paged := '{}'; v_off := 0;
  LOOP
    SELECT array_agg(f.id::text ORDER BY f.o) INTO v_page
      FROM (SELECT w.id, w.ordinality AS o FROM public.get_watchdog_flags(p_include_dismissed => true) WITH ORDINALITY w ORDER BY w.ordinality LIMIT 50 OFFSET v_off) f;
    EXIT WHEN v_page IS NULL;
    v_paged := v_paged || v_page; v_off := v_off + 50;
  END LOOP;
  IF v_paged IS DISTINCT FROM v_all THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_watchdog_flags pages of 50 (% ids) differ from one read (% ids)', cardinality(v_paged), cardinality(v_all);
  END IF;
  RAISE NOTICE 'get_watchdog_flags: % rows, pages of 50 match', cardinality(v_all);

  -- 3. Fields with geojson (table function, every customer).
  SELECT array_agg(f.id::text ORDER BY f.o) INTO v_all
    FROM (SELECT g.id, g.ordinality AS o FROM public.get_fields_with_geojson() WITH ORDINALITY g ORDER BY g.ordinality) f;
  v_all := COALESCE(v_all, '{}');
  IF cardinality(v_all) <> (SELECT count(DISTINCT u) FROM unnest(v_all) u) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_fields_with_geojson repeats an id in one read';
  END IF;
  v_paged := '{}'; v_off := 0;
  LOOP
    SELECT array_agg(f.id::text ORDER BY f.o) INTO v_page
      FROM (SELECT g.id, g.ordinality AS o FROM public.get_fields_with_geojson() WITH ORDINALITY g ORDER BY g.ordinality LIMIT 50 OFFSET v_off) f;
    EXIT WHEN v_page IS NULL;
    v_paged := v_paged || v_page; v_off := v_off + 50;
  END LOOP;
  IF v_paged IS DISTINCT FROM v_all THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_fields_with_geojson pages of 50 (% ids) differ from one read (% ids)', cardinality(v_paged), cardinality(v_all);
  END IF;
  RAISE NOTICE 'get_fields_with_geojson: % rows, pages of 50 match', cardinality(v_all);

  -- 4. Role gates: an active driver is refused the receiving log and the watchdog list.
  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    v_refused := false;
    BEGIN
      PERFORM public.get_receiving_log(1, 0);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = $m$Not authorized$m$ THEN v_refused := true; ELSE RAISE; END IF;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a driver read the receiving log'; END IF;
    v_refused := false;
    BEGIN
      SELECT count(*) INTO v_n FROM public.get_watchdog_flags();
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE $m$WATCHDOG_ACCESS_DENIED%$m$ THEN v_refused := true; ELSE RAISE; END IF;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a driver read the watchdog list (% rows)', v_n; END IF;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
