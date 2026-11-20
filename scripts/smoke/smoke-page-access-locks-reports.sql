-- KI-119 (Mason, 2026-11-19): Settings > Page Access locks report data in the database.
-- Migration 20270201100000_page_access_locks_reports.
-- As real active profiles, signed in under RLS (role authenticated), every change rolled back:
--   A. an admin and a sales rep with nothing hidden run every guarded report;
--   B. the rep with `reports` hidden is refused PAGE_ACCESS_DENIED: reports on the Reports Library
--      functions, keeps Sales Reports, and keeps the Customer page's one-customer year-end summary;
--   C. the rep with `sales-reports` hidden is refused on both sales reports and keeps the Reports Library;
--   D. a driver and an applicator are refused the logbooks; an inactive rep is refused;
--   E. an admin with a stale hidden list still passes; clearing the rep's list lets the next call through;
--   F. signed-out callers and PUBLIC cannot execute the helper or the logbooks.
-- Fails before the migration (the helper does not exist). Terminal rollback.
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_driver uuid;
  v_appl uuid;
  v_customer uuid;
  v_n bigint;
  v_err text;
  v_fn text;
  v_who text;
  v_uid uuid;
  v_reports text[] := ARRAY[
    'SELECT count(*) FROM public.get_customer_balance_listing(CURRENT_DATE)',
    'SELECT count(*) FROM public.get_chemical_history(NULL, CURRENT_DATE - 30, CURRENT_DATE)',
    'SELECT jsonb_array_length(public.get_batch_year_end_summaries(ARRAY[]::uuid[], extract(year FROM CURRENT_DATE)::int))',
    'SELECT count(*) FROM public.get_logbook_faa(CURRENT_DATE - 30, CURRENT_DATE)',
    'SELECT count(*) FROM public.get_logbook_by_field(NULL, CURRENT_DATE - 30, CURRENT_DATE)',
    'SELECT count(*) FROM public.get_logbook_by_customer(NULL, CURRENT_DATE - 30, CURRENT_DATE)',
    'SELECT count(*) FROM public.get_logbook_by_applicator(NULL, CURRENT_DATE - 30, CURRENT_DATE)'
  ];
  v_sales text[] := ARRAY[
    'SELECT count(*) FROM public.get_sales_summary_report()',
    'SELECT count(*) FROM public.get_sales_detail_report()'
  ];
  v_logbooks text[] := ARRAY[
    'public.get_logbook_faa(date,date)', 'public.get_logbook_by_field(uuid,date,date)',
    'public.get_logbook_by_customer(uuid,date,date)', 'public.get_logbook_by_applicator(uuid,date,date)'
  ];
BEGIN
  IF to_regprocedure('public._require_page_access(text)') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: 20270201100000 is not applied (no _require_page_access)';
  END IF;
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles WHERE role = 'sales_rep' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_driver FROM public.profiles WHERE role = 'driver' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_appl FROM public.profiles WHERE role = 'applicator' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_customer FROM public.customers ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_driver IS NULL OR v_appl IS NULL OR v_customer IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, sales rep, driver and applicator, and a customer';
  END IF;

  -- Profile edits run as postgres with the admin's claims (the role-lock trigger allows admins).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.profiles SET denied_pages = ARRAY['reports', 'sales-reports'] WHERE id = v_admin;  -- E: stale list
  UPDATE public.profiles SET denied_pages = '{}' WHERE id = v_rep;

  -- A + E(admin): every guarded report runs for the admin (stale list ignored) and for the rep with nothing hidden.
  FOREACH v_uid IN ARRAY ARRAY[v_admin, v_rep] LOOP
    FOREACH v_fn IN ARRAY v_reports || v_sales LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      BEGIN
        EXECUTE v_fn INTO v_n;
      EXCEPTION WHEN OTHERS THEN
        v_err := SQLERRM;
        EXECUTE 'RESET ROLE';
        RAISE EXCEPTION 'SMOKE_FAIL: (A) % (%) was refused: %', v_fn, CASE WHEN v_uid = v_admin THEN 'admin' ELSE 'rep' END, v_err;
      END;
      EXECUTE 'RESET ROLE';
    END LOOP;
  END LOOP;

  -- B: `reports` hidden.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.profiles SET denied_pages = ARRAY['reports'] WHERE id = v_rep;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  FOREACH v_fn IN ARRAY v_reports LOOP
    v_err := NULL;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      EXECUTE v_fn INTO v_n;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    IF v_err IS DISTINCT FROM 'PAGE_ACCESS_DENIED: reports' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (B) % with reports hidden: %', v_fn, coalesce(v_err, 'not refused');
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY v_sales || ARRAY[
    format('SELECT count(*) FROM jsonb_object_keys(public.get_customer_year_end_summary(%L::uuid, extract(year FROM CURRENT_DATE)::int))', v_customer)
  ] LOOP
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      EXECUTE v_fn INTO v_n;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'SMOKE_FAIL: (B) % refused with only reports hidden: %', v_fn, v_err;
    END;
    EXECUTE 'RESET ROLE';
  END LOOP;

  -- C: `sales-reports` hidden.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.profiles SET denied_pages = ARRAY['sales-reports'] WHERE id = v_rep;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  FOREACH v_fn IN ARRAY v_sales LOOP
    v_err := NULL;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      EXECUTE v_fn INTO v_n;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    IF v_err IS DISTINCT FROM 'PAGE_ACCESS_DENIED: sales-reports' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (C) % with sales-reports hidden: %', v_fn, coalesce(v_err, 'not refused');
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY v_reports LOOP
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      EXECUTE v_fn INTO v_n;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'SMOKE_FAIL: (C) % refused with only sales-reports hidden: %', v_fn, v_err;
    END;
    EXECUTE 'RESET ROLE';
  END LOOP;

  -- D: a driver and an applicator are refused every guarded report; then an inactive rep is too.
  FOREACH v_uid IN ARRAY ARRAY[v_driver, v_appl] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    FOREACH v_fn IN ARRAY v_reports || v_sales LOOP
      v_err := NULL;
      EXECUTE 'SET LOCAL ROLE authenticated';
      BEGIN
        EXECUTE v_fn INTO v_n;
      EXCEPTION WHEN OTHERS THEN
        v_err := SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      IF v_err IS NULL OR v_err NOT LIKE 'PAGE_ACCESS_DENIED: %' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: (D) % as % (%): %', v_fn, v_uid, CASE WHEN v_uid = v_driver THEN 'driver' ELSE 'applicator' END, coalesce(v_err, 'not refused');
      END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.profiles SET denied_pages = '{}', is_active = false WHERE id = v_rep;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  FOREACH v_fn IN ARRAY v_reports || v_sales LOOP
    v_err := NULL;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      EXECUTE v_fn INTO v_n;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    IF v_err IS NULL OR v_err NOT LIKE 'PAGE_ACCESS_DENIED: %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (D) % as an inactive rep: %', v_fn, coalesce(v_err, 'not refused');
    END IF;
  END LOOP;

  -- E: undo. Reactivate with `reports` hidden: refused; clear the list: the next call goes through.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.profiles SET denied_pages = ARRAY['reports'], is_active = true WHERE id = v_rep;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  v_err := NULL;
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE v_reports[1] INTO v_n;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  IF v_err IS DISTINCT FROM 'PAGE_ACCESS_DENIED: reports' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) before undo: %', coalesce(v_err, 'not refused');
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.profiles SET denied_pages = '{}' WHERE id = v_rep;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE v_reports[1] INTO v_n;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'SMOKE_FAIL: (E) after undo still refused: %', v_err;
  END;
  EXECUTE 'RESET ROLE';

  -- F: signed-out callers and PUBLIC.
  FOREACH v_fn IN ARRAY v_logbooks || ARRAY['public._require_page_access(text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (F) anon can execute %', v_fn;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (F) PUBLIC can execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (F) authenticated cannot execute %', v_fn;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_err := NULL;
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public._require_page_access('reports');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  IF v_err IS DISTINCT FROM 'PAGE_ACCESS_DENIED: reports' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (F) a session with no user: %', coalesce(v_err, 'not refused');
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
