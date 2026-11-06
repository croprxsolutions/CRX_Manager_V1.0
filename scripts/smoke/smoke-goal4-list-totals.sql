-- Rolled-back smoke chain (Goal 4): the Call Lists and the Dispatch Board report their true totals on
-- live data.
--
-- Covers the five get_call_list_* functions and get_dispatch_board_jobs after
-- 20261113120000_list_true_totals.sql.
--
-- Read only: signs in as the oldest active admin and writes nothing.
-- Proves:
--   * each call list (admin, every rep) returns success, rows, and a total_count that is at least the
--     rows shown, equal to them when fewer than 200 are shown, and never more than 200 rows;
--   * for the applicator with the most board jobs (the chain fails if that applicator gets none), every board row carries the same
--     _total_count, the board shows min(total, 500) rows, rows come in (job_date, id) DESC order, and
--     no row carries total_cost_cents;
--   * an active driver, when one exists, is still refused every call list.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin uuid;
  v_driver uuid;
  v_applicator uuid;
  v_list text;
  v_r jsonb;
  v_shown integer;
  v_total bigint;
  v_rows jsonb;
  v_refused boolean;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_driver FROM public.profiles WHERE role = 'driver' AND is_active ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin is required';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- 1. Call lists.
  FOREACH v_list IN ARRAY ARRAY['get_call_list_prepay_prospects', 'get_call_list_no_recent_contact',
      'get_call_list_stale_quotes', 'get_call_list_lapsed_products', 'get_call_list_unassigned_accounts'] LOOP
    CASE v_list
      WHEN 'get_call_list_prepay_prospects' THEN v_r := public.get_call_list_prepay_prospects();
      WHEN 'get_call_list_no_recent_contact' THEN v_r := public.get_call_list_no_recent_contact();
      WHEN 'get_call_list_stale_quotes' THEN v_r := public.get_call_list_stale_quotes();
      WHEN 'get_call_list_lapsed_products' THEN v_r := public.get_call_list_lapsed_products();
      ELSE v_r := public.get_call_list_unassigned_accounts();
    END CASE;
    v_shown := jsonb_array_length(v_r->'rows');
    v_total := (v_r->>'total_count')::bigint;
    IF (v_r->>'success') IS DISTINCT FROM 'true' OR v_total IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % lost success or total_count: %', v_list, left(v_r::text, 200);
    END IF;
    IF v_shown > 200 OR v_total < v_shown OR (v_shown < 200 AND v_total <> v_shown) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % shows % rows with total_count %', v_list, v_shown, v_total;
    END IF;
    RAISE NOTICE '%: shows %, total_count %', v_list, v_shown, v_total;
  END LOOP;

  -- 2. Dispatch board, for the applicator with the most board jobs (whole-job assignments on jobs with no
  --    per-location dispatch, which the board always lists for that applicator).
  SELECT j.applicator_id INTO v_applicator
    FROM public.jobs j
   WHERE j.deleted_at IS NULL AND j.applicator_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.job_location_dispatches d WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched')
   GROUP BY j.applicator_id
   ORDER BY count(*) DESC, j.applicator_id
   LIMIT 1;
  IF v_applicator IS NOT NULL THEN
    SELECT jsonb_agg(x ORDER BY o) INTO v_rows
      FROM public.get_dispatch_board_jobs(v_applicator) WITH ORDINALITY t(x, o);
    v_rows := COALESCE(v_rows, '[]'::jsonb);
    v_shown := jsonb_array_length(v_rows);
    IF v_shown = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the board returned no job for an applicator with board jobs';
    END IF;
    IF v_shown > 0 THEN
      IF (SELECT count(DISTINCT e->>'_total_count') FROM jsonb_array_elements(v_rows) e) <> 1 THEN
        RAISE EXCEPTION 'SMOKE_FAIL: board rows disagree on _total_count';
      END IF;
      v_total := (v_rows->0->>'_total_count')::bigint;
      IF v_shown <> least(v_total, 500) THEN
        RAISE EXCEPTION 'SMOKE_FAIL: board shows % rows with _total_count %', v_shown, v_total;
      END IF;
      IF (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(v_rows) WITH ORDINALITY q(e, o))
         IS DISTINCT FROM
         (SELECT string_agg(e->>'id', ',' ORDER BY (e->>'job_date')::date DESC NULLS LAST, (e->>'id')::uuid DESC)
            FROM jsonb_array_elements(v_rows) e) THEN
        RAISE EXCEPTION 'SMOKE_FAIL: board rows are not in (job_date, id) DESC order';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE e ? 'total_cost_cents') THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a board row carries total_cost_cents';
      END IF;
    END IF;
    RAISE NOTICE 'get_dispatch_board_jobs: shows %, _total_count %', v_shown, COALESCE(v_total::text, 'n/a (no rows)');
  END IF;

  -- 3. Role gate: an active driver is refused every call list.
  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    FOREACH v_list IN ARRAY ARRAY['get_call_list_prepay_prospects', 'get_call_list_no_recent_contact',
        'get_call_list_stale_quotes', 'get_call_list_lapsed_products', 'get_call_list_unassigned_accounts'] LOOP
      v_refused := false;
      BEGIN
        CASE v_list
          WHEN 'get_call_list_prepay_prospects' THEN v_r := public.get_call_list_prepay_prospects();
          WHEN 'get_call_list_no_recent_contact' THEN v_r := public.get_call_list_no_recent_contact();
          WHEN 'get_call_list_stale_quotes' THEN v_r := public.get_call_list_stale_quotes();
          WHEN 'get_call_list_lapsed_products' THEN v_r := public.get_call_list_lapsed_products();
          ELSE v_r := public.get_call_list_unassigned_accounts();
        END CASE;
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%CALL_LIST_ACCESS_DENIED%' THEN v_refused := true; ELSE RAISE; END IF;
      END;
      IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a driver read %', v_list; END IF;
    END LOOP;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
