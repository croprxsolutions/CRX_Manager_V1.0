-- Smoke chain: vendor-only product links through link_product_vendor (REQUIRES 20261105180000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so every link it records is rolled back.
-- Proves, as a real signed-in browser session (role authenticated with each live profile's claims)
-- and as a signed-out visitor (role anon), on an invented product with no links and two real
-- active vendors:
--   * the installed body is exactly 20261105090000's, anon cannot execute it;
--   * an admin's first link is recorded vendor-only (no item facts, not reusable) and is preferred
--     even when not asked, a same-key replay returns the same answer, and making a second vendor
--     preferred leaves exactly one preferred;
--   * the product's vendor name follows the preferred vendor (20261105180000);
--   * an active sales rep, driver, applicator and commission-recipient profile are refused
--     ADMIN_REQUIRED, and a signed-out visitor is refused EXECUTE.
-- Every other rule is proven on invented rows by scripts/smoke/prove-vendor-only-links-real-schema.mjs.
DO $$
DECLARE
  v_proc regprocedure := 'public.link_product_vendor(uuid,uuid,boolean,uuid,text)'::regprocedure;
  v_src text;
  v_admin uuid;
  v_uid uuid;
  v_role text;
  v_refused boolean;
  v_product uuid;
  v_vendor_a uuid;
  v_vendor_b uuid;
  v_name_b text;
  v_first jsonb;
  v_again jsonb;
  v_second jsonb;
  v_link public.product_supplier_links%ROWTYPE;
  v_n bigint;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
  IF md5(replace(v_src, chr(13), '')) <> 'dc4ecfce44a207354bf422a44eab5758' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: link_product_vendor is not the body of 20261105090000';
  END IF;
  IF has_function_privilege('anon', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon can execute link_product_vendor';
  END IF;

  SELECT v.id INTO v_vendor_a FROM public.vendors v WHERE v.deleted_at IS NULL ORDER BY v.created_at, v.id LIMIT 1;
  SELECT v.id, v.name INTO v_vendor_b, v_name_b FROM public.vendors v WHERE v.deleted_at IS NULL AND v.id <> v_vendor_a ORDER BY v.created_at, v.id LIMIT 1;
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  IF v_vendor_a IS NULL OR v_vendor_b IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need two active vendors and an active admin';
  END IF;
  INSERT INTO public.products (product_name, sku, vendor, inventory_unit, is_active, product_form)
  VALUES ('[SMOKE] vendor-only link', 'SMOKE-LPV-' || md5(clock_timestamp()::text), NULL, 'Gal', true, 'liquid')
  RETURNING id INTO v_product;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_first := public.link_product_vendor(v_product, v_vendor_a, false, v_admin, 'smoke-lpv-1-' || v_product);
  v_again := public.link_product_vendor(v_product, v_vendor_a, false, v_admin, 'smoke-lpv-1-' || v_product);
  v_second := public.link_product_vendor(v_product, v_vendor_b, true, v_admin, 'smoke-lpv-2-' || v_product);
  EXECUTE 'RESET ROLE';

  IF (v_first->>'created')::boolean IS NOT TRUE OR (v_first->>'is_preferred')::boolean IS NOT TRUE
     OR (v_first->>'item_details_known')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: first link is not a new, preferred, vendor-only link: %', v_first;
  END IF;
  IF v_again IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a same-key replay answered differently: % vs %', v_again, v_first;
  END IF;
  SELECT * INTO v_link FROM public.product_supplier_links WHERE id = (v_first->>'id')::uuid;
  IF v_link.supplier_product_name IS NOT NULL OR v_link.supplier_sku IS NOT NULL OR v_link.supplier_uom IS NOT NULL
     OR v_link.supplier_pack_description IS NOT NULL OR v_link.is_reusable OR v_link.link_status <> 'confirmed'
     OR v_link.confirmed_by IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the vendor-only link carries item facts or the wrong status';
  END IF;
  SELECT count(*) INTO v_n FROM public.product_supplier_links
   WHERE product_id = v_product AND is_active AND link_status = 'confirmed' AND is_preferred;
  IF v_n <> 1 OR (v_second->>'is_preferred')::boolean IS NOT TRUE
     OR (SELECT is_preferred FROM public.product_supplier_links WHERE id = (v_first->>'id')::uuid) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: switching the preferred vendor did not leave exactly one preferred (% preferred)', v_n;
  END IF;
  IF (SELECT vendor FROM public.products WHERE id = v_product) IS DISTINCT FROM v_name_b THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the product vendor name is not the preferred vendor''s';
  END IF;

  FOR v_role IN SELECT unnest(ARRAY['sales_rep', 'driver', 'applicator', 'entity_recipient']) LOOP
    SELECT p.id INTO v_uid FROM public.profiles p WHERE p.role = v_role AND p.is_active ORDER BY p.created_at LIMIT 1;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no active % profile to probe with', v_role;
    END IF;
    v_refused := false;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.link_product_vendor(v_product, v_vendor_a, true, v_uid, 'smoke-lpv-' || v_role);
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'ADMIN_REQUIRED' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % got an unexpected error: % %', v_role, SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % linked a vendor', v_role;
    END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_refused := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.link_product_vendor(v_product, v_vendor_a, true, v_admin, 'smoke-lpv-anon');
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor linked a vendor';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$$;
