-- Smoke chain: product parents (REQUIRES 20261108120000, PAR-1).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so every parent, size, rate, log and history row
-- it writes is rolled back. Proves, as a real signed-in browser session (role authenticated with each
-- live profile's claims) and as a signed-out visitor (role anon), on invented parents and sizes:
--   * anon cannot execute any of the twelve public parent functions;
--   * an admin creates a parent with its first size (a same-key retry answers the same), adds a bulk
--     size whose spaced EPA number is stored in the parent's normalized form, and edits the nickname;
--     a no-change edit is refused PRODUCT_PARENT_NO_CHANGE;
--   * a direct browser edit of a grouped size's category is refused PRODUCT_PARENT_VALUE;
--   * unlocked, the parent's rates reach every size at the previewed prices; locked, a correction
--     with a reason does too and logs one corrected rate event per size;
--   * a size moves to another parent at its previewed prices with a reason and evidence;
--   * the identity correction changes the formulation type; both reads find the parent with no cost
--     or price; every copied size change is a parent_copy history entry;
--   * an active sales rep, driver, applicator and commission-recipient profile are refused
--     ADMIN_REQUIRED by the create.
-- Every other rule is proven on invented rows by scripts/smoke/prove-product-parents-real-schema.mjs.
DO $$
DECLARE
  v_admin uuid;
  v_uid uuid;
  v_role text;
  v_sig text;
  v_refused boolean;
  v_cat text;
  v_tag text := substr(md5(clock_timestamp()::text), 1, 10);
  v_a jsonb;
  v_again jsonb;
  v_b jsonb;
  v_bulk uuid;
  v_pv jsonb;
  v_mv jsonb;
  v_read jsonb;
  v_was_locked boolean;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.create_product_with_parent(jsonb,jsonb,text)', 'public.add_product_size(uuid,bigint,jsonb,text)',
    'public.update_product_parent(uuid,bigint,jsonb,text,text)', 'public.preview_parent_rates(uuid,numeric,text,text)',
    'public.set_parent_rates(jsonb,text)', 'public.correct_parent_rates(uuid,numeric,text,text,bigint,jsonb,text,text)',
    'public.preview_move_product_size(uuid,uuid)', 'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)',
    'public.preview_product_parent_identity_correction(uuid,jsonb)', 'public.correct_product_parent_identity(uuid,bigint,jsonb,text,text,text)',
    'public.get_product_parents(uuid[])', 'public.search_product_parents(text,boolean)'] LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: anon can execute %', v_sig;
    END IF;
  END LOOP;

  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  SELECT c.name INTO v_cat FROM public.product_categories c WHERE c.is_active ORDER BY c.name LIMIT 1;
  IF v_admin IS NULL OR v_cat IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin and an active category';
  END IF;
  v_was_locked := COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF v_was_locked THEN
    PERFORM public.set_product_rate_lock(false, 'smoke', v_admin, 'smoke-pp-open-' || v_tag);
  END IF;

  -- Create, retry, add a bulk size, edit.
  v_a := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Parent A ' || v_tag, 'product_form', 'liquid', 'category', v_cat,
      'generic_epa_registration', '99999-1'),
    jsonb_build_object('product_name', '[SMOKE] Parent A 2.5 ' || v_tag, 'sku', 'SMOKE-PA-' || v_tag, 'inventory_unit', 'Gal'),
    'smoke-pp-create-a-' || v_tag);
  v_again := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Parent A ' || v_tag, 'product_form', 'liquid', 'category', v_cat,
      'generic_epa_registration', '99999-1'),
    jsonb_build_object('product_name', '[SMOKE] Parent A 2.5 ' || v_tag, 'sku', 'SMOKE-PA-' || v_tag, 'inventory_unit', 'Gal'),
    'smoke-pp-create-a-' || v_tag);
  IF v_again IS DISTINCT FROM v_a THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a same-key create did not replay: % / %', v_a, v_again;
  END IF;
  v_bulk := (public.add_product_size((v_a->>'parent_id')::uuid,
    (SELECT parent_version FROM public.product_parents WHERE id = (v_a->>'parent_id')::uuid),
    jsonb_build_object('product_name', '[SMOKE] Parent A Bulk ' || v_tag, 'sku', 'SMOKE-PAB-' || v_tag,
      'inventory_unit', 'Gal', 'size_role', 'bulk', 'epa_registration', '99999 - 1'),
    'smoke-pp-add-' || v_tag)->>'product_id')::uuid;
  PERFORM public.update_product_parent((v_a->>'parent_id')::uuid,
    (SELECT parent_version FROM public.product_parents WHERE id = (v_a->>'parent_id')::uuid),
    jsonb_build_object('nickname', 'Smokey ' || v_tag), 'smoke', 'smoke-pp-edit-' || v_tag);
  v_refused := false;
  BEGIN
    PERFORM public.update_product_parent((v_a->>'parent_id')::uuid,
      (SELECT parent_version FROM public.product_parents WHERE id = (v_a->>'parent_id')::uuid),
      jsonb_build_object('nickname', 'Smokey ' || v_tag), 'smoke', 'smoke-pp-noop-' || v_tag);
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE 'PRODUCT_PARENT_NO_CHANGE%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a no-change parent edit was not refused';
  END IF;
  v_refused := false;
  BEGIN
    UPDATE public.products SET category = NULL WHERE id = v_bulk;
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE 'PRODUCT_PARENT_VALUE%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a grouped size''s category was edited directly';
  END IF;

  -- Rates: set unlocked, then correct locked.
  v_pv := public.preview_parent_rates((v_a->>'parent_id')::uuid, 4, 'oz', '4 oz/A');
  PERFORM public.set_parent_rates(jsonb_build_array(jsonb_build_object('parent_id', v_a->>'parent_id',
    'expected_parent_version', v_pv->'parent_version', 'rate_per_acre', '4', 'rate_unit', 'oz',
    'suggested_rate', '4 oz/A', 'sizes', v_pv->'sizes')), 'smoke-pp-rates-' || v_tag);
  PERFORM public.set_product_rate_lock(true, 'smoke', v_admin, 'smoke-pp-lock-' || v_tag);
  v_pv := public.preview_parent_rates((v_a->>'parent_id')::uuid, 5, 'oz', '5 oz/A');
  PERFORM public.correct_parent_rates((v_a->>'parent_id')::uuid, 5, 'oz', '5 oz/A',
    (v_pv->>'parent_version')::bigint, v_pv->'sizes', 'smoke label check', 'smoke-pp-correct-' || v_tag);
  PERFORM public.set_product_rate_lock(false, 'smoke', v_admin, 'smoke-pp-unlock-' || v_tag);

  -- Move the first size to a second parent with the same EPA number.
  v_b := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Parent B ' || v_tag, 'product_form', 'liquid', 'category', v_cat,
      'generic_epa_registration', '99999-1'),
    jsonb_build_object('product_name', '[SMOKE] Parent B 1 ' || v_tag, 'sku', 'SMOKE-PB-' || v_tag, 'inventory_unit', 'Gal'),
    'smoke-pp-create-b-' || v_tag);
  v_mv := public.preview_move_product_size((v_a->>'product_id')::uuid, (v_b->>'parent_id')::uuid);
  IF v_mv->>'refusal' IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the move preview refused: %', v_mv->>'refusal';
  END IF;
  PERFORM public.move_product_size((v_a->>'product_id')::uuid, (v_b->>'parent_id')::uuid,
    (v_mv->>'from_parent_version')::bigint, (v_mv->>'to_parent_version')::bigint, v_mv->>'size_fingerprint',
    'smoke wrong group', 'smoke label', v_mv->'prices', 'smoke-pp-move-' || v_tag);

  -- Identity correction and reads.
  PERFORM public.preview_product_parent_identity_correction((v_a->>'parent_id')::uuid, '{"formulation_type":"EC"}'::jsonb);
  PERFORM public.correct_product_parent_identity((v_a->>'parent_id')::uuid,
    (SELECT parent_version FROM public.product_parents WHERE id = (v_a->>'parent_id')::uuid),
    '{"formulation_type":"EC"}'::jsonb, 'smoke', 'smoke label', 'smoke-pp-identity-' || v_tag);
  v_read := jsonb_build_array(public.get_product_parents(ARRAY[(v_a->>'product_id')::uuid]),
    public.search_product_parents('Smokey ' || v_tag, true));
  IF v_was_locked THEN
    PERFORM public.set_product_rate_lock(true, 'smoke', v_admin, 'smoke-pp-relock-' || v_tag);
  END IF;
  EXECUTE 'RESET ROLE';

  IF (SELECT epa_registration FROM public.products WHERE id = v_bulk) IS DISTINCT FROM '99999-1' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the added size did not store the parent''s normalized EPA number';
  END IF;
  IF (SELECT rate_per_acre FROM public.products WHERE id = v_bulk) IS DISTINCT FROM 5
     OR (SELECT count(*) FROM public.product_rate_events WHERE event_type = 'corrected'
           AND product_id IN (v_bulk, (v_a->>'product_id')::uuid) AND reason = 'smoke label check') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the parent rate correction did not reach and log both sizes';
  END IF;
  IF (SELECT parent_id FROM public.product_parent_members WHERE product_id = (v_a->>'product_id')::uuid)
       IS DISTINCT FROM (v_b->>'parent_id')::uuid THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the size did not move';
  END IF;
  IF (SELECT formulation_type FROM public.product_parents WHERE id = (v_a->>'parent_id')::uuid) IS DISTINCT FROM 'EC' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the identity correction did not save';
  END IF;
  IF jsonb_array_length(v_read->0) <> 1 OR (v_read->0->0->>'id') IS DISTINCT FROM v_b->>'parent_id'
     OR jsonb_array_length(v_read->1) <> 1 OR (v_read->1->0->>'id') IS DISTINCT FROM v_a->>'parent_id'
     OR v_read::text ~* '(price|cost|margin)' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the reads did not find the parents without price: %', v_read;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_change_history WHERE product_id = v_bulk AND change_type = 'parent_copy'
                   AND field_name = 'rate_per_acre' AND parent_event_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.product_change_history WHERE product_id IN (v_bulk, (v_a->>'product_id')::uuid)
                  AND change_type = 'updated' AND field_name IN ('category', 'use_timing', 'rate_per_acre', 'rate_unit',
                    'suggested_rate', 'epa_registration')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a copied size change is not a parent_copy history entry';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['sales_rep', 'driver', 'applicator', 'entity_recipient'] LOOP
    SELECT p.id INTO v_uid FROM public.profiles p WHERE p.role = v_role AND p.is_active ORDER BY p.created_at LIMIT 1;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no active % profile to probe with', v_role;
    END IF;
    v_refused := false;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.create_product_with_parent(jsonb_build_object('name', '[SMOKE] Rep ' || v_tag, 'product_form', 'liquid'),
        jsonb_build_object('product_name', '[SMOKE] Rep 1 ' || v_tag, 'sku', 'SMOKE-PR-' || v_tag, 'inventory_unit', 'Gal'),
        'smoke-pp-rep-' || v_role || v_tag);
    EXCEPTION WHEN OTHERS THEN
      v_refused := SQLERRM = 'ADMIN_REQUIRED';
    END;
    EXECUTE 'RESET ROLE';
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an active % was not refused ADMIN_REQUIRED', v_role;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: product parents chain passed';
END;
$$;
