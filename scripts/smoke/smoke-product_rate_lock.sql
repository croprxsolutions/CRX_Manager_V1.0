-- Smoke chain: the product rate lock (REQUIRES 20261105200000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so every rate, switch and log row it writes is
-- rolled back. Proves, as a real signed-in browser session (role authenticated with each live
-- profile's claims) and as a signed-out visitor (role anon), on an invented product:
--   * the installed bodies are exactly 20261105200000's and anon cannot execute the three functions;
--   * unlocked, an admin's set_product_rates saves the rates and a same-key replay answers the same;
--   * an admin locks rates with a reason; a direct browser rate edit and set_product_rates are then
--     refused PRODUCT_RATES_LOCKED; an admin's one-product correction saves and is logged;
--   * an active sales rep, driver, applicator and commission-recipient profile are refused
--     ADMIN_REQUIRED by all three functions, and a signed-out visitor is refused EXECUTE.
-- Every other rule is proven on invented rows by scripts/smoke/prove-product-rate-lock-real-schema.mjs.
DO $$
DECLARE
  v_admin uuid;
  v_uid uuid;
  v_role text;
  v_refused boolean;
  v_product uuid;
  v_first jsonb;
  v_again jsonb;
  v_fix jsonb;
  v_sig text;
  v_md5 text;
  v_facts jsonb;
  v_prices jsonb;
BEGIN
  FOR v_sig, v_md5 IN SELECT * FROM (VALUES
    ('public.set_product_rates(jsonb,uuid,text)', '06ff0dda8aff08f04e0a914145665e58'),
    ('public.set_product_rate_lock(boolean,text,uuid,text)', '46b19757c668c9e3fc7611aa0e545f27'),
    ('public.correct_product_rates(uuid,numeric,text,text,bigint,jsonb,text,uuid,text)', '37aeacd8ba0abb2333f13a48762f682b'),
    ('public._product_rate_unit_ok(numeric,text,text,text)', '8177b1aaaddb1659d00d19f28c3924df'),
    ('public.guard_product_rate_lock()', '9a4fa35ae3a1533e755d840aed47fa62'),
    ('public.refuse_price_workbook_rate_change()', '8e55d2451eb8beff17bac81d156f3bd4'),
    ('public.preview_product_rate_correction(uuid,numeric,text)', '8604511cd222c804da7913992b2f8daa')) AS pins(sig, body_md5) LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_sig::regprocedure) IS DISTINCT FROM v_md5 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % is not the body of 20261105200000', v_sig;
    END IF;
    IF v_sig <> 'public.guard_product_rate_lock()' AND has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: anon can execute %', v_sig;
    END IF;
  END LOOP;

  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin';
  END IF;
  INSERT INTO public.products (product_name, sku, inventory_unit, is_active)
  VALUES ('[SMOKE] rate lock', 'SMOKE-RL-' || md5(clock_timestamp()::text), 'gal', true)
  RETURNING id INTO v_product;

  -- The per-acre inputs a row was exported with, other than the rates.
  SELECT jsonb_build_object('pricing_version', pricing_version, 'unit_size', unit_size,
    'inventory_unit', inventory_unit, 'product_form', product_form)
    INTO v_facts FROM public.products WHERE id = v_product;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF (SELECT is_locked FROM public.product_rate_lock) THEN
    PERFORM public.set_product_rate_lock(false, 'smoke', v_admin, 'smoke-rl-open-' || v_product);
  END IF;
  v_prices := jsonb_build_object('prices', public.preview_product_rate_correction(v_product, 13, 'oz')->'after');
  v_first := public.set_product_rates(jsonb_build_array(jsonb_build_object('product_id', v_product,
    'rate_per_acre', '13', 'rate_unit', 'oz', 'suggested_rate', '13 oz/A',
    'expected', jsonb_build_object('rate_per_acre', NULL, 'rate_unit', NULL, 'suggested_rate', NULL) || v_facts || v_prices)),
    v_admin, 'smoke-rl-set-' || v_product);
  v_again := public.set_product_rates(jsonb_build_array(jsonb_build_object('product_id', v_product,
    'rate_per_acre', '13', 'rate_unit', 'oz', 'suggested_rate', '13 oz/A',
    'expected', jsonb_build_object('rate_per_acre', NULL, 'rate_unit', NULL, 'suggested_rate', NULL) || v_facts || v_prices)),
    v_admin, 'smoke-rl-set-' || v_product);
  PERFORM public.set_product_rate_lock(true, 'smoke', v_admin, 'smoke-rl-lock-' || v_product);
  v_refused := false;
  BEGIN
    UPDATE public.products SET rate_per_acre = 20 WHERE id = v_product;
  EXCEPTION WHEN check_violation THEN
    v_refused := SQLERRM LIKE 'PRODUCT_RATES_LOCKED%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a locked rate was edited directly';
  END IF;
  v_refused := false;
  BEGIN
    PERFORM public.set_product_rates(jsonb_build_array(jsonb_build_object('product_id', v_product,
      'rate_per_acre', '20', 'rate_unit', 'oz', 'suggested_rate', '',
      'expected', jsonb_build_object('rate_per_acre', '13', 'rate_unit', 'oz', 'suggested_rate', '13 oz/A', 'prices', '{}'::jsonb) || v_facts)),
      v_admin, 'smoke-rl-locked-' || v_product);
  EXCEPTION WHEN check_violation THEN
    v_refused := SQLERRM LIKE 'PRODUCT_RATES_LOCKED%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: set_product_rates wrote while locked';
  END IF;
  v_fix := public.correct_product_rates(v_product, 16, 'oz', '16 oz/A',
    (SELECT pricing_version FROM public.products WHERE id = v_product),
    public.preview_product_rate_correction(v_product, 16, 'oz')->'after', 'smoke', v_admin, 'smoke-rl-fix-' || v_product);
  EXECUTE 'RESET ROLE';

  IF (v_first->>'changed_count')::int <> 1 OR v_again IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'SMOKE_FAIL: set_product_rates did not save once and replay: % / %', v_first, v_again;
  END IF;
  IF (SELECT rate_per_acre FROM public.products WHERE id = v_product) IS DISTINCT FROM 16
     OR NOT EXISTS (SELECT 1 FROM public.product_rate_events WHERE product_id = v_product AND event_type = 'corrected')
     OR (v_fix->'before'->>'rate_per_acre') IS DISTINCT FROM '13' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the correction did not save or was not logged: %', v_fix;
  END IF;

  FOR v_role IN SELECT unnest(ARRAY['sales_rep', 'driver', 'applicator', 'entity_recipient']) LOOP
    SELECT p.id INTO v_uid FROM public.profiles p WHERE p.role = v_role AND p.is_active ORDER BY p.created_at LIMIT 1;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no active % profile to probe with', v_role;
    END IF;
    FOR v_sig IN SELECT unnest(ARRAY['set', 'lock', 'correct']) LOOP
      v_refused := false;
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        IF v_sig = 'set' THEN
          PERFORM public.set_product_rates(jsonb_build_array(jsonb_build_object('product_id', v_product,
            'rate_per_acre', '1', 'rate_unit', 'oz', 'suggested_rate', '', 'expected', jsonb_build_object(
            'rate_per_acre', '16', 'rate_unit', 'oz', 'suggested_rate', '16 oz/A'))), v_uid, 'smoke-rl-' || v_role);
        ELSIF v_sig = 'lock' THEN
          PERFORM public.set_product_rate_lock(false, 'smoke', v_uid, 'smoke-rl-' || v_role);
        ELSE
          PERFORM public.correct_product_rates(v_product, 1, 'oz', '', 0, '{}'::jsonb, 'smoke', v_uid, 'smoke-rl-' || v_role);
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

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_refused := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.set_product_rate_lock(false, 'smoke', v_admin, 'smoke-rl-anon');
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor switched the rate lock';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$$;
