-- Smoke chain: the vendor link proposal report is admin-only and read-only (REQUIRES 20261104180000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, and the report itself writes nothing.
-- Proves, as a real signed-in browser session (role authenticated with each live profile's claims)
-- and as a signed-out visitor (role anon):
--   * the installed body is exactly 20261104180000's, anon cannot execute it;
--   * an active admin gets one row per active product, each with a known status, a summary that
--     adds up, and no cost or price key;
--   * an active sales rep, driver, applicator and commission-recipient profile, and an id with no
--     active profile, are refused ADMIN_REQUIRED;
--   * a signed-out visitor is refused EXECUTE.
-- The status rules themselves are proven on invented rows by
-- scripts/smoke/prove-vendor-link-proposals-real-schema.mjs.
DO $$
DECLARE
  v_proc regprocedure := 'public.get_vendor_link_proposals()'::regprocedure;
  v_src text;
  v_result jsonb;
  v_uid uuid;
  v_role text;
  v_refused boolean;
  v_active bigint;
  v_bad bigint;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
  IF md5(replace(v_src, chr(13), '')) <> '2a6cf41f6a12c77c39429c18e684df2a' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_vendor_link_proposals is not the body of 20261104180000';
  END IF;
  IF has_function_privilege('anon', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon can execute get_vendor_link_proposals';
  END IF;
  SELECT count(*) INTO v_active FROM public.products WHERE is_active;

  FOR v_role IN SELECT unnest(ARRAY['admin', 'sales_rep', 'driver', 'applicator', 'entity_recipient']) LOOP
    SELECT p.id INTO v_uid FROM public.profiles p WHERE p.role = v_role AND p.is_active ORDER BY p.created_at LIMIT 1;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no active % profile to probe with', v_role;
    END IF;
    v_refused := false;
    v_result := NULL;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      v_result := public.get_vendor_link_proposals();
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'ADMIN_REQUIRED' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % got an unexpected error: % %', v_role, SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF v_role = 'admin' THEN
      IF v_refused OR v_result IS NULL THEN
        RAISE EXCEPTION 'SMOKE_FAIL: admin was refused the report';
      END IF;
      -- Exactly one row per active product: same set, no duplicates.
      SELECT count(*) INTO v_bad FROM (
        (SELECT (r->>'product_id')::uuid FROM jsonb_array_elements(v_result->'rows') r
         EXCEPT ALL SELECT p.id FROM public.products p WHERE p.is_active)
        UNION ALL
        (SELECT p.id FROM public.products p WHERE p.is_active
         EXCEPT ALL SELECT (r->>'product_id')::uuid FROM jsonb_array_elements(v_result->'rows') r)
      ) d;
      IF v_bad <> 0 OR jsonb_array_length(v_result->'rows') <> v_active THEN
        RAISE EXCEPTION 'SMOKE_FAIL: rows are not one per active product (% mismatches, % rows, % products)',
          v_bad, jsonb_array_length(v_result->'rows'), v_active;
      END IF;
      SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_result->'rows') r
       WHERE r->>'status' IS NULL
          OR r->>'status' NOT IN ('linked', 'linked_text_differs', 'linked_no_preferred', 'proposed', 'ambiguous', 'unresolved', 'no_vendor');
      IF v_bad <> 0 THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % rows have a missing or unknown status', v_bad;
      END IF;
      -- No cost or price key anywhere in the result, at any depth, in any case.
      IF EXISTS (SELECT 1 FROM jsonb_path_query(v_result, 'strict $.**') v
                  WHERE jsonb_typeof(v) = 'object'
                    AND EXISTS (SELECT 1 FROM jsonb_object_keys(v) k WHERE k ~* '(cost|price|tier)')) THEN
        RAISE EXCEPTION 'SMOKE_FAIL: the report carries a cost or price key';
      END IF;
      -- Each summary count matches its rows, in both directions.
      SELECT count(*) INTO v_bad FROM (
        SELECT s.key, s.value::bigint AS n FROM jsonb_each_text(v_result->'summary') s
        EXCEPT
        SELECT r->>'status', count(*) FROM jsonb_array_elements(v_result->'rows') r GROUP BY 1
      ) x;
      IF v_bad <> 0 OR (SELECT count(DISTINCT r->>'status') FROM jsonb_array_elements(v_result->'rows') r)
                        <> (SELECT count(*) FROM jsonb_object_keys(v_result->'summary')) THEN
        RAISE EXCEPTION 'SMOKE_FAIL: the summary does not match the rows';
      END IF;
    ELSIF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % pulled the vendor proposal report', v_role;
    END IF;
  END LOOP;

  -- A signed-in id with no active profile.
  v_uid := gen_random_uuid();
  v_refused := false;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.get_vendor_link_proposals();
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ADMIN_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an id with no profile got an unexpected error: % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an id with no active profile pulled the report';
  END IF;

  -- Signed-out visitor.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_refused := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.get_vendor_link_proposals();
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor pulled the report';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$$;
