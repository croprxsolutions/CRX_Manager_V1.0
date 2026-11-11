-- Smoke chain: preferred vendor enforcement (REQUIRES 20261105180000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so the product and links it makes are rolled back.
-- Proves, as a real signed-in browser session (role authenticated with each live profile's claims)
-- and as a signed-out visitor (role anon), on an invented product and two real active vendors:
--   * the installed unlink_product_vendor and get_product_vendors bodies are 20261105180000's, and
--     anon cannot execute either;
--   * the product's vendor name follows the preferred vendor when an admin links and switches it;
--   * get_product_vendors lists the preferred vendor first, with cost keys for an admin and null
--     cost for a sales rep;
--   * removing the preferred vendor is refused PREFERRED_VENDOR_REQUIRED; removing the other one
--     works and replays under the same key; a sales rep is refused ADMIN_REQUIRED;
--   * a direct edit of the product's vendor name is refused, and a signed-out visitor is refused EXECUTE.
-- Every other rule is proven on invented rows by scripts/smoke/prove-preferred-vendor-enforcement-real-schema.mjs.
DO $$
DECLARE
  v_unlink regprocedure := 'public.unlink_product_vendor(uuid,uuid,text)'::regprocedure;
  v_list regprocedure := 'public.get_product_vendors(uuid)'::regprocedure;
  v_admin uuid;
  v_rep uuid;
  v_product uuid;
  v_vendor_a uuid;
  v_vendor_b uuid;
  v_name_a text;
  v_name_b text;
  v_link_a jsonb;
  v_link_b jsonb;
  v_rows jsonb;
  v_first jsonb;
  v_again jsonb;
  v_refused boolean;
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = v_unlink), chr(13), '')) <> 'bb1d7141eb1a08806f42c0a30f8cdd12' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unlink_product_vendor is not the body of 20261105180000';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = v_list), chr(13), '')) <> '8511e8a2c94d3b5aa5ebb6ad217a1495' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_product_vendors is not the body of 20261105180000';
  END IF;
  IF has_function_privilege('anon', v_unlink, 'EXECUTE') OR has_function_privilege('anon', v_list, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon can execute a product vendor RPC';
  END IF;

  SELECT v.id, v.name INTO v_vendor_a, v_name_a FROM public.vendors v WHERE v.deleted_at IS NULL ORDER BY v.created_at, v.id LIMIT 1;
  SELECT v.id, v.name INTO v_vendor_b, v_name_b FROM public.vendors v
   WHERE v.deleted_at IS NULL AND v.id <> v_vendor_a ORDER BY v.created_at, v.id LIMIT 1;
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  SELECT p.id INTO v_rep FROM public.profiles p WHERE p.role = 'sales_rep' AND p.is_active ORDER BY p.created_at LIMIT 1;
  IF v_vendor_b IS NULL OR v_admin IS NULL OR v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need two active vendors, an active admin and an active sales rep';
  END IF;
  INSERT INTO public.products (product_name, sku, vendor, inventory_unit, is_active, product_form)
  VALUES ('[SMOKE] preferred vendor', 'SMOKE-PVE-' || md5(clock_timestamp()::text), NULL, 'Gal', true, 'liquid')
  RETURNING id INTO v_product;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_link_a := public.link_product_vendor(v_product, v_vendor_a, false, v_admin, 'smoke-pve-a-' || v_product);
  IF (SELECT vendor FROM public.products WHERE id = v_product) IS DISTINCT FROM v_name_a THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the first vendor did not become the product vendor name';
  END IF;
  v_link_b := public.link_product_vendor(v_product, v_vendor_b, true, v_admin, 'smoke-pve-b-' || v_product);
  IF (SELECT vendor FROM public.products WHERE id = v_product) IS DISTINCT FROM v_name_b THEN
    RAISE EXCEPTION 'SMOKE_FAIL: switching the preferred vendor did not change the product vendor name';
  END IF;

  v_rows := public.get_product_vendors(v_product);
  IF jsonb_array_length(v_rows) <> 2 OR v_rows->0->>'vendor_id' <> v_vendor_b::text
     OR (v_rows->0->>'is_preferred')::boolean IS NOT TRUE OR NOT (v_rows->0 ? 'last_cost_cents') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an admin did not get both vendors, preferred first: %', v_rows;
  END IF;

  v_refused := false;
  BEGIN
    PERFORM public.unlink_product_vendor((v_link_b->>'id')::uuid, v_admin, 'smoke-pve-unlink-pref-' || v_product);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PREFERRED_VENDOR_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: removing the preferred vendor failed oddly: % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: the preferred vendor was removed'; END IF;

  v_refused := false;
  BEGIN
    UPDATE public.products SET vendor = 'Smoke Typed Vendor' WHERE id = v_product;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRODUCT_VENDOR_FOLLOWS_PREFERRED_VENDOR%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a vendor name edit failed oddly: % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: the vendor name was edited directly'; END IF;

  v_first := public.unlink_product_vendor((v_link_a->>'id')::uuid, v_admin, 'smoke-pve-unlink-' || v_product);
  v_again := public.unlink_product_vendor((v_link_a->>'id')::uuid, v_admin, 'smoke-pve-unlink-' || v_product);
  EXECUTE 'RESET ROLE';
  IF v_again IS DISTINCT FROM v_first OR (SELECT is_active FROM public.product_supplier_links WHERE id = (v_link_a->>'id')::uuid) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: removing the other vendor did not stick or replay: % vs %', v_first, v_again;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_rows := public.get_product_vendors(v_product);
  v_refused := false;
  BEGIN
    PERFORM public.unlink_product_vendor((v_link_b->>'id')::uuid, v_rep, 'smoke-pve-rep-' || v_product);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ADMIN_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a sales rep got an unexpected error: % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  EXECUTE 'RESET ROLE';
  IF jsonb_array_length(v_rows) <> 1 OR v_rows->0->'last_cost_cents' <> 'null'::jsonb
     OR v_rows->0->'last_quoted_package_cost_cents' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep saw cost or the wrong vendors: %', v_rows;
  END IF;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a sales rep removed a vendor'; END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_refused := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.get_product_vendors(v_product);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor listed product vendors'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$$;
