-- Smoke chain: fill a fertilizer tote from its Bulk (REQUIRES 20261117130000, BLK-1a).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so every product, parent, stock, ledger, fill
-- and idempotency row it writes is rolled back. Proves, as a real signed-in browser session (role
-- authenticated with the oldest active admin's claims) and as a signed-out visitor (role anon), on an
-- invented, unpriced (products are born pricing-free) fertilizer parent with a 1,000-gal Bulk and an
-- empty 265-gal tote:
--   * anon cannot execute preview_tote_fill, fill_tote_from_bulk or reverse_tote_fill;
--   * the preview writes nothing and shows 265 gal out, 735 left, one tote;
--   * the fill moves exactly that (two signed ledger rows, one tote_fills row) and changes no cost or
--     price; a same-key retry returns the same answer and writes nothing;
--   * the undo restores both counts; a same-key retry returns the same answer; a second undo is
--     refused TOTE_FILL_ALREADY_REVERSED;
--   * an active non-admin profile, when one exists, is refused ADMIN_REQUIRED.
-- Every other rule (races, stale previews, quarts, refusals) is proven on invented rows by
-- scripts/smoke/prove-tote-fill-real-schema.mjs.
DO $$
DECLARE
  v_admin uuid;
  v_other uuid;
  v_sig text;
  v_refused boolean;
  v_tag text := substr(md5(clock_timestamp()::text), 1, 10);
  v_parent uuid := gen_random_uuid();
  v_bulk uuid := gen_random_uuid();
  v_tote uuid := gen_random_uuid();
  v_prices text;
  v_p jsonb;
  v_a jsonb;
  v_again jsonb;
  v_u jsonb;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.preview_tote_fill(uuid,integer)', 'public.fill_tote_from_bulk(uuid,integer,jsonb,text)',
    'public.reverse_tote_fill(uuid,text,text)'] LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: anon can execute %', v_sig;
    END IF;
  END LOOP;

  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  SELECT p.id INTO v_other FROM public.profiles p WHERE p.role <> 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin';
  END IF;

  INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, container_size, container_unit, is_active) VALUES
    (v_bulk, '[SMOKE] Tote Fill Bulk ' || v_tag, 'SMOKE-TFB-' || v_tag, 'liquid', 'Gal', NULL, NULL, true),
    (v_tote, '[SMOKE] Tote Fill 265 ' || v_tag, 'SMOKE-TFT-' || v_tag, 'liquid', 'Ea', 265, 'Gal', true);
  INSERT INTO public.product_parents (id, name, product_form, category, created_by, updated_by)
    VALUES (v_parent, '[SMOKE] Tote Fill ' || v_tag, 'liquid', 'Liquid Fertilizer', v_admin, v_admin);
  INSERT INTO public.product_parent_members (product_id, parent_id, size_role, fill_source_product_id, added_by) VALUES
    (v_bulk, v_parent, 'bulk', NULL, v_admin), (v_tote, v_parent, 'fixed_tote', v_bulk, v_admin);
  INSERT INTO public.inventory (product_id, location, quantity_available) VALUES (v_bulk, 'Main Warehouse', 1000);
  INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
    VALUES (v_bulk, 'received', 1000, 'Main Warehouse', v_admin, '[SMOKE] opening');
  v_prices := (SELECT string_agg(concat_ws('|', id, current_cost, tier1_price), ',' ORDER BY id) FROM public.products WHERE id IN (v_bulk, v_tote));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_p := public.preview_tote_fill(v_tote, 1);
  IF (v_p->>'bulk_quantity')::numeric <> 265 OR (v_p->>'bulk_after')::numeric <> 735 OR (v_p->>'tote_after')::numeric <> 1
     OR (v_p->>'shortfall')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unexpected preview: %', v_p;
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory WHERE product_id = v_tote) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the preview wrote an inventory row';
  END IF;

  v_a := public.fill_tote_from_bulk(v_tote, 1, v_p, 'smoke-tf-fill-' || v_tag);
  v_again := public.fill_tote_from_bulk(v_tote, 1, v_p, 'smoke-tf-fill-' || v_tag);
  IF v_again IS DISTINCT FROM v_a THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a same-key fill did not replay: % / %', v_a, v_again;
  END IF;
  IF (SELECT quantity_available FROM public.inventory WHERE product_id = v_bulk AND location = 'Main Warehouse') <> 735
     OR (SELECT quantity_available FROM public.inventory WHERE product_id = v_tote AND location = 'Main Warehouse') <> 1
     OR (SELECT count(*) FROM public.tote_fills WHERE tote_product_id = v_tote) <> 1
     OR (SELECT count(*) FROM public.inventory_transactions WHERE product_id IN (v_bulk, v_tote) AND transaction_type LIKE 'tote_fill_%') <> 2
     OR (SELECT quantity FROM public.inventory_transactions WHERE id = (v_a->>'out_transaction_id')::uuid) <> -265
     OR (SELECT quantity FROM public.inventory_transactions WHERE id = (v_a->>'in_transaction_id')::uuid) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the fill did not move exactly one tote: %', v_a;
  END IF;

  v_u := public.reverse_tote_fill((v_a->>'fill_id')::uuid, 'smoke entered by mistake', 'smoke-tf-undo-' || v_tag);
  v_again := public.reverse_tote_fill((v_a->>'fill_id')::uuid, 'smoke entered by mistake', 'smoke-tf-undo-' || v_tag);
  IF v_again IS DISTINCT FROM v_u THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a same-key undo did not replay: % / %', v_u, v_again;
  END IF;
  IF (SELECT quantity_available FROM public.inventory WHERE product_id = v_bulk AND location = 'Main Warehouse') <> 1000
     OR (SELECT quantity_available FROM public.inventory WHERE product_id = v_tote AND location = 'Main Warehouse') <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the undo did not restore both counts';
  END IF;
  v_refused := false;
  BEGIN
    PERFORM public.reverse_tote_fill((v_a->>'fill_id')::uuid, 'smoke again', 'smoke-tf-undo2-' || v_tag);
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE 'TOTE_FILL_ALREADY_REVERSED%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a second undo was not refused';
  END IF;
  EXECUTE 'RESET ROLE';

  IF (SELECT string_agg(concat_ws('|', id, current_cost, tier1_price), ',' ORDER BY id) FROM public.products WHERE id IN (v_bulk, v_tote))
     IS DISTINCT FROM v_prices THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a fill or undo changed a cost or price';
  END IF;

  IF v_other IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_refused := false;
    BEGIN
      PERFORM public.preview_tote_fill(v_tote, 1);
    EXCEPTION WHEN OTHERS THEN
      v_refused := SQLERRM LIKE '%ADMIN_REQUIRED%';
    END;
    EXECUTE 'RESET ROLE';
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a non-admin profile was not refused';
    END IF;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: tote fill, replay and undo on an invented fertilizer parent';
END
$$;
