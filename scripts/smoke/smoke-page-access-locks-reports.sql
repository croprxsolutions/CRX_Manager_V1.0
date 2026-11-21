-- KI-119 (Mason, 2026-11-19): Settings > Page Access locks report data in the database.
-- Migration 20270201100000_page_access_locks_reports.
-- As real active profiles, signed in under RLS (role authenticated), every change rolled back:
--   A. an admin and a sales rep with nothing hidden run every guarded report;
--   B. the rep with `reports` hidden is refused PAGE_ACCESS_DENIED: reports on the Reports Library
--      functions, keeps Sales Reports, and keeps the Customer page's one-customer year-end summary;
--   H. the rep with `reports` AND `customers` hidden is refused the one-customer year-end summary; `customers`
--      alone keeps it (Sol r4);
--   C. the rep with `sales-reports` hidden is refused on both sales reports and keeps the Reports Library;
--   D. a driver and an applicator are refused the logbooks; a user with no active profile is refused;
--   G. the rep's own commission rows disappear while `reports` is hidden (not for `sales-reports`), and the admin
--      still sees them;
--   E. an admin with a stale hidden list still passes; clearing the rep's list lets the next call through;
--   F. signed-out callers and PUBLIC cannot execute the helper or the logbooks.
-- Fails before the migration (the helper does not exist). Terminal rollback.
-- Each report is called by a short key through this static dispatcher (the live-smoke guard refuses EXECUTE of
-- computed SQL; Sol r2). Session-only (pg_temp).
CREATE OR REPLACE FUNCTION pg_temp.ki119_run(p_key text, p_customer uuid)
RETURNS bigint LANGUAGE plpgsql AS $fn$
BEGIN
  CASE p_key
    WHEN 'balance_listing' THEN RETURN (SELECT count(*) FROM public.get_customer_balance_listing(CURRENT_DATE));
    WHEN 'chemical_history' THEN RETURN (SELECT count(*) FROM public.get_chemical_history(NULL, CURRENT_DATE - 30, CURRENT_DATE));
    WHEN 'batch_year_end' THEN RETURN jsonb_array_length(public.get_batch_year_end_summaries(ARRAY[]::uuid[], extract(year FROM CURRENT_DATE)::int));
    WHEN 'logbook_faa' THEN RETURN (SELECT count(*) FROM public.get_logbook_faa(CURRENT_DATE - 30, CURRENT_DATE));
    WHEN 'logbook_by_field' THEN RETURN (SELECT count(*) FROM public.get_logbook_by_field(NULL, CURRENT_DATE - 30, CURRENT_DATE));
    WHEN 'logbook_by_customer' THEN RETURN (SELECT count(*) FROM public.get_logbook_by_customer(NULL, CURRENT_DATE - 30, CURRENT_DATE));
    WHEN 'logbook_by_applicator' THEN RETURN (SELECT count(*) FROM public.get_logbook_by_applicator(NULL, CURRENT_DATE - 30, CURRENT_DATE));
    WHEN 'sales_summary' THEN RETURN (SELECT count(*) FROM public.get_sales_summary_report());
    WHEN 'sales_detail' THEN RETURN (SELECT count(*) FROM public.get_sales_detail_report());
    WHEN 'year_end_one' THEN RETURN (SELECT count(*) FROM jsonb_object_keys(public.get_customer_year_end_summary(p_customer, extract(year FROM CURRENT_DATE)::int)));
  END CASE;
END
$fn$;
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
  v_reports text[] := ARRAY['balance_listing', 'chemical_history', 'batch_year_end', 'logbook_faa',
    'logbook_by_field', 'logbook_by_customer', 'logbook_by_applicator'];
  v_sales text[] := ARRAY['sales_summary', 'sales_detail'];
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
        v_n := pg_temp.ki119_run(v_fn, v_customer);
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
      v_n := pg_temp.ki119_run(v_fn, v_customer);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    IF v_err IS DISTINCT FROM 'PAGE_ACCESS_DENIED: reports' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (B) % with reports hidden: %', v_fn, coalesce(v_err, 'not refused');
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY v_sales || ARRAY['year_end_one'] LOOP
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      v_n := pg_temp.ki119_run(v_fn, v_customer);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'SMOKE_FAIL: (B) % refused with only reports hidden: %', v_fn, v_err;
    END;
    EXECUTE 'RESET ROLE';
  END LOOP;

  -- H (Sol r4, Mason 2026-11-21): Reports AND Customers hidden refuses the one-customer year-end summary;
  -- Customers alone keeps it.
  FOREACH v_who IN ARRAY ARRAY['{reports,customers}', '{customers}'] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    UPDATE public.profiles SET denied_pages = v_who::text[] WHERE id = v_rep;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
    v_err := NULL;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      v_n := pg_temp.ki119_run('year_end_one', v_customer);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    IF v_who = '{reports,customers}' AND v_err IS DISTINCT FROM 'PAGE_ACCESS_DENIED: reports, customers' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (H) year-end summary with Reports and Customers hidden: %', coalesce(v_err, 'not refused');
    ELSIF v_who = '{customers}' AND v_err IS NOT NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (H) year-end summary refused with only Customers hidden: %', v_err;
    END IF;
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
      v_n := pg_temp.ki119_run(v_fn, v_customer);
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
      v_n := pg_temp.ki119_run(v_fn, v_customer);
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
        v_n := pg_temp.ki119_run(v_fn, v_customer);
      EXCEPTION WHEN OTHERS THEN
        v_err := SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      IF v_err IS NULL OR v_err NOT LIKE 'PAGE_ACCESS_DENIED: %' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: (D) % as % (%): %', v_fn, v_uid, CASE WHEN v_uid = v_driver THEN 'driver' ELSE 'applicator' END, coalesce(v_err, 'not refused');
      END IF;
    END LOOP;
  END LOOP;
  -- A signed-in user with no active profile (the prover also checks a seeded inactive rep). Deactivating a real
  -- rep here would delete their sessions inside this transaction (Sol r1).
  v_uid := gen_random_uuid();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  FOREACH v_fn IN ARRAY v_reports || v_sales LOOP
    v_err := NULL;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      v_n := pg_temp.ki119_run(v_fn, v_customer);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    IF v_err IS NULL OR v_err NOT LIKE 'PAGE_ACCESS_DENIED: %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (D) % as a user with no active profile: %', v_fn, coalesce(v_err, 'not refused');
    END IF;
  END LOOP;

  -- G: the Commissions tab reads public.commissions directly. One pending row for the rep (rolled back).
  INSERT INTO public.commissions (customer_id, order_id, order_date, recipient_user_id, recipient, commission_amount, status)
  SELECT o.customer_id, o.id, CURRENT_DATE, v_rep, 'KI-119 smoke', 1.00, 'pending' FROM public.orders o ORDER BY o.created_at, o.id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (G) needs one order to hang a test commission on';
  END IF;
  FOREACH v_who IN ARRAY ARRAY['{}', '{reports}', '{sales-reports}'] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    UPDATE public.profiles SET denied_pages = v_who::text[] WHERE id = v_rep;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_n FROM public.commissions WHERE recipient = 'KI-119 smoke';
    EXECUTE 'RESET ROLE';
    IF v_n <> (CASE WHEN v_who = '{reports}' THEN 0 ELSE 1 END) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (G) rep with hidden pages % sees % of their own commission rows', v_who, v_n;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.commissions WHERE recipient = 'KI-119 smoke';
  EXECUTE 'RESET ROLE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (G) the admin (stale hidden list) sees % of the rep''s commission rows', v_n;
  END IF;

  -- E: undo. With `reports` hidden: refused; clear the list: the next call goes through.
  UPDATE public.profiles SET denied_pages = ARRAY['reports'] WHERE id = v_rep;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  v_err := NULL;
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    v_n := pg_temp.ki119_run(v_reports[1], v_customer);
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
    v_n := pg_temp.ki119_run(v_reports[1], v_customer);
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
