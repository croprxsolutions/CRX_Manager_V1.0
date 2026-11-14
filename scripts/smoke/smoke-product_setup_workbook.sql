-- Smoke chain: the product setup workbook (REQUIRES 20261107080000, 20261107130000 and 20261108120000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so every product and log row it writes is rolled
-- back. Proves, as a real signed-in browser session (role authenticated with each live profile's
-- claims) and as a signed-out visitor (role anon), on an invented product:
--   * the installed bodies are exactly 20261107080000's (apply_product_setup's update body renamed
--     _apply_product_setup_update by 20261107130000, which owns apply_product_setup; the fingerprint helper is 20261108120000's, which adds a grouped size's parent); anon cannot execute
--     any of the five functions and a signed-in user cannot call the fingerprint helper or the update body;
--   * an admin downloads the product, previews a rate change for it, saves a setup change with
--     apply_product_setup, a same-key replay answers the same, and the downloaded (now old) row is
--     refused PRODUCT_SETUP_STALE;
--   * an active sales rep, driver, applicator and commission-recipient profile are refused
--     ADMIN_REQUIRED by all three functions, and a signed-out visitor is refused EXECUTE.
-- Every other rule is proven on invented rows by scripts/smoke/prove-product-setup-workbook-real-schema.mjs.
DO $$
DECLARE
  v_admin uuid;
  v_uid uuid;
  v_role text;
  v_refused boolean;
  v_product uuid;
  v_row jsonb;
  v_preview jsonb;
  v_first jsonb;
  v_again jsonb;
  v_sig text;
  v_md5 text;
BEGIN
  FOR v_sig, v_md5 IN SELECT * FROM (VALUES
    ('public._product_setup_fingerprint(public.products)', 'ff3660ba6a4d3f7b1528a22f75985cdb'),
    ('public.get_product_setup_workbook()', '219acbf55ec555a29af3fe96250784a7'),
    ('public.preview_product_rates(jsonb)', '001a9d34bb4125c43daa4c22742415ab'),
    ('public._apply_product_setup_update(jsonb,uuid,text)', '9c1385aa3c9ce2c40f48415195db79b5'),
    ('public.apply_product_setup(jsonb,uuid,text)', '3d1f5d5d1fc8c8d046a388a23ee3f408')) AS pins(sig, body_md5) LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_sig::regprocedure) IS DISTINCT FROM v_md5 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % is not the pinned body', v_sig;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: anon can execute %', v_sig;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._product_setup_fingerprint(public.products)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a signed-in user can call the fingerprint helper';
  END IF;
  IF has_function_privilege('authenticated', 'public._apply_product_setup_update(jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a signed-in user can call the update body directly';
  END IF;

  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin';
  END IF;
  INSERT INTO public.products (product_name, sku, inventory_unit, is_active, product_form)
  VALUES ('[SMOKE] setup workbook', 'SMOKE-SW-' || md5(clock_timestamp()::text), 'Gal', true, 'liquid')
  RETURNING id INTO v_product;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT r INTO v_row FROM jsonb_array_elements(public.get_product_setup_workbook()->'rows') r
    WHERE r->>'product_id' = v_product::text;
  v_preview := public.preview_product_rates(jsonb_build_array(jsonb_build_object('product_id', v_product,
    'rate_per_acre', '13', 'rate_unit', 'oz', 'suggested_rate', '13 oz/A', 'expected', jsonb_build_object(
    'rate_per_acre', v_row->'rate_per_acre', 'rate_unit', v_row->'rate_unit', 'suggested_rate', v_row->'suggested_rate',
    'pricing_version', v_row->'pricing_version', 'unit_size', v_row->'unit_size',
    'inventory_unit', v_row->'inventory_unit', 'product_form', v_row->'product_form'))));
  v_first := public.apply_product_setup(jsonb_build_array(jsonb_build_object('product_id', v_product,
    'setup_fingerprint', v_row->'setup_fingerprint', 'changes', jsonb_build_object('manufacturer', 'Smoke Co'))),
    v_admin, 'smoke-sw-set-' || v_product);
  v_again := public.apply_product_setup(jsonb_build_array(jsonb_build_object('product_id', v_product,
    'setup_fingerprint', v_row->'setup_fingerprint', 'changes', jsonb_build_object('manufacturer', 'Smoke Co'))),
    v_admin, 'smoke-sw-set-' || v_product);
  v_refused := false;
  BEGIN
    PERFORM public.apply_product_setup(jsonb_build_array(jsonb_build_object('product_id', v_product,
      'setup_fingerprint', v_row->'setup_fingerprint', 'changes', jsonb_build_object('manufacturer', 'Other Co'))),
      v_admin, 'smoke-sw-stale-' || v_product);
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE 'PRODUCT_SETUP_STALE%';
  END;
  EXECUTE 'RESET ROLE';

  IF v_row IS NULL OR v_preview IS NULL OR v_preview::text NOT LIKE '%"status": "change"%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the download or rate preview did not show the invented product: % / %', v_row, v_preview;
  END IF;
  IF (v_first->>'changed_count')::int <> 1 OR v_again IS DISTINCT FROM v_first
     OR (SELECT manufacturer FROM public.products WHERE id = v_product) IS DISTINCT FROM 'Smoke Co' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: apply_product_setup did not save once and replay: % / %', v_first, v_again;
  END IF;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an old downloaded row saved over a newer change';
  END IF;

  FOR v_role IN SELECT unnest(ARRAY['sales_rep', 'driver', 'applicator', 'entity_recipient']) LOOP
    SELECT p.id INTO v_uid FROM public.profiles p WHERE p.role = v_role AND p.is_active ORDER BY p.created_at LIMIT 1;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no active % profile to probe with', v_role;
    END IF;
    FOR v_sig IN SELECT unnest(ARRAY['download', 'preview', 'apply']) LOOP
      v_refused := false;
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        IF v_sig = 'download' THEN
          PERFORM public.get_product_setup_workbook();
        ELSIF v_sig = 'preview' THEN
          PERFORM public.preview_product_rates('[]'::jsonb);
        ELSE
          PERFORM public.apply_product_setup('[]'::jsonb, v_uid, 'smoke-sw-' || v_role);
        END IF;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'ADMIN_REQUIRED' THEN
          RAISE EXCEPTION 'SMOKE_FAIL: % (%) got an unexpected error: % %', v_role, v_sig, SQLSTATE, SQLERRM;
        END IF;
        v_refused := true;
      END;
      IF NOT v_refused THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % ran %', v_role, v_sig;
      END IF;
    END LOOP;
  END LOOP;

  FOR v_sig IN SELECT unnest(ARRAY['download', 'preview', 'apply']) LOOP
    v_refused := false;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      EXECUTE 'SET LOCAL ROLE anon';
      IF v_sig = 'download' THEN
        PERFORM public.get_product_setup_workbook();
      ELSIF v_sig = 'preview' THEN
        PERFORM public.preview_product_rates('[]'::jsonb);
      ELSE
        PERFORM public.apply_product_setup('[]'::jsonb, NULL, 'smoke-sw-anon');
      END IF;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN insufficient_privilege THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor ran %', v_sig;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$$;
