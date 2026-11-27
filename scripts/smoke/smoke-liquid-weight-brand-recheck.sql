-- Exercise the normal brand writer with synthetic fixtures that roll back.
DO $$
DECLARE
  v_admin uuid;
  v_reviewer uuid;
  v_category text;
  v_parent uuid;
  v_size uuid;
  v_brand uuid;
  v_draft uuid;
  v_approved uuid;
  v_customer uuid := gen_random_uuid();
  v_ticket uuid := gen_random_uuid();
  v_tag text := gen_random_uuid()::text;
  v_change text;
  v_result jsonb;
BEGIN
  SELECT id INTO STRICT v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1;
  SELECT id INTO STRICT v_reviewer FROM public.profiles WHERE role = 'admin' AND is_active AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT name INTO STRICT v_category FROM public.product_categories WHERE is_active ORDER BY name LIMIT 1;
  INSERT INTO public.customers(id, farm_name) VALUES (v_customer, '[SMOKE] Rename ' || v_tag);

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Rename ' || v_tag, 'product_form', 'liquid', 'category', v_category),
    jsonb_build_object('product_name', '[SMOKE] Rename Size ' || v_tag, 'sku', 'SMOKE-RENAME-' || v_tag, 'inventory_unit', 'Gal'),
    'rename-product-' || v_tag);
  v_parent := (v_result->>'parent_id')::uuid;
  v_size := (v_result->>'product_id')::uuid;
  v_result := public.upsert_parent_brand(v_parent, v_size, 'Smoke Brand A', '12345-1', 'Smoke Maker', true,
    NULL, NULL, p_idempotency_key => 'rename-brand-' || v_tag);
  v_brand := (v_result->>'id')::uuid;
  v_result := public.submit_liquid_density_draft(v_parent, 0, 9.5, 'lb_per_gal', 'sds', NULL, NULL, NULL, 'rename-draft-' || v_tag);
  v_approved := (v_result->>'value_id')::uuid;
  PERFORM set_config('request.jwt.claim.sub', v_reviewer::text, true);
  PERFORM public.approve_liquid_density_draft(v_parent, v_approved, 1, public.get_liquid_density_review(v_parent)->'brands',
    true, 'rename-approve-' || v_tag);
  PERFORM public.create_blend_ticket(v_ticket, jsonb_build_object('customer_id', v_customer, 'ticket_date', current_date),
    jsonb_build_array(jsonb_build_object('product_id', v_size, 'product_name', '[SMOKE] Rename Size', 'quantity', 10, 'unit', 'Gal')),
    '[]'::jsonb, false, v_reviewer, 'rename-ticket-' || v_tag);

  BEGIN
    EXECUTE 'RESET ROLE';
    EXECUTE $closed$
      CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
      LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS 'SELECT false';
    $closed$;
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.upsert_parent_brand(v_parent, v_size, 'Closed Switch Brand', '12345-1', 'Smoke Maker', true,
      NULL, NULL, v_brand, 1, p_idempotency_key => 'rename-closed-' || v_tag);
    v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
    IF (v_result->'weight'->>'lb_per_unit')::numeric IS DISTINCT FROM 9.5 OR
       (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 2::bigint THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a rename while the switch is closed must preserve the approval and version';
    END IF;
    RAISE EXCEPTION 'SMOKE_CLOSED_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'SMOKE_CLOSED_ROLLBACK' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.upsert_parent_brand(v_parent, v_size, 'Compound Edit Brand', '12345-2', 'Smoke Maker', true,
      NULL, NULL, v_brand, 1, p_idempotency_key => 'rename-compound-' || v_tag);
    EXECUTE 'RESET ROLE';
    IF NOT EXISTS (
      SELECT 1 FROM public.product_weight_events WHERE parent_id = v_parent AND value_id = v_approved
        AND event_type = 'returned_to_draft' AND reason = 'An active brand changed its EPA registration or manufacturer'
    ) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a compound edit must report the EPA or manufacturer change first';
    END IF;
    RAISE EXCEPTION 'SMOKE_COMPOUND_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'SMOKE_COMPOUND_ROLLBACK' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM public.upsert_parent_brand(v_parent, v_size, E'  sMOKE\t  BRAND A  ', '12345-1', 'Smoke Maker', true,
    NULL, NULL, v_brand, 1, p_idempotency_key => 'rename-cosmetic-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF (v_result->'weight'->>'lb_per_unit')::numeric IS DISTINCT FROM 9.5 OR
     (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: case and whitespace edits must preserve the approval and version';
  END IF;

  PERFORM public.upsert_parent_brand(v_parent, v_size, 'Smoke Brand B', '12345-1', 'Smoke Maker', true,
    NULL, NULL, v_brand, 2, p_idempotency_key => 'rename-substantive-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF v_result->'weight'->>'kind' IS DISTINCT FROM 'none' OR
     (v_result->'draft'->>'id')::uuid IS DISTINCT FROM v_approved OR
     (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a substantive rename must return the approved weight to draft';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_reviewer::text, true);
  PERFORM public.approve_liquid_density_draft(v_parent, v_approved, 3, public.get_liquid_density_review(v_parent)->'brands',
    true, 'rename-reapprove-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF (v_result->'weight'->>'lb_per_unit')::numeric IS DISTINCT FROM 9.5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a rechecked weight must be available for new paperwork';
  END IF;
  FOREACH v_change IN ARRAY ARRAY['name', 'EPA registration', 'manufacturer'] LOOP
    BEGIN
      EXECUTE 'RESET ROLE';
      UPDATE public.product_parents SET is_active = false WHERE id = v_parent;
      UPDATE public.product_parent_brands
         SET brand_name = CASE WHEN v_change = 'name' THEN 'Inactive Brand Correction' ELSE brand_name END,
             epa_registration = CASE WHEN v_change = 'EPA registration' THEN '12345-2' ELSE epa_registration END,
             manufacturer = CASE WHEN v_change = 'manufacturer' THEN 'Second Smoke Maker' ELSE manufacturer END
       WHERE id = v_brand;
      IF (SELECT review_state FROM public.product_parent_density_values WHERE id = v_approved) IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a % change must withdraw an inactive group approval', v_change;
      END IF;
      RAISE EXCEPTION 'SMOKE_INACTIVE_ROLLBACK';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'SMOKE_INACTIVE_ROLLBACK' THEN RAISE; END IF;
    END;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.submit_liquid_density_draft(v_parent, 4, 9.8, 'lb_per_gal', 'sds', NULL, NULL, NULL, 'rename-waiting-' || v_tag);
  v_draft := (v_result->>'value_id')::uuid;
  PERFORM public.upsert_parent_brand(v_parent, v_size, 'Smoke Brand C', '12345-1', 'Smoke Maker', true,
    NULL, NULL, v_brand, 3, p_idempotency_key => 'rename-with-draft-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF v_result->'weight'->>'kind' IS DISTINCT FROM 'none' OR
     (v_result->'draft'->>'id')::uuid IS DISTINCT FROM v_draft OR
     (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 6::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a substantive rename must keep the draft already waiting';
  END IF;

  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (
    SELECT 1 FROM public.product_weight_events WHERE parent_id = v_parent AND event_type = 'returned_to_draft'
      AND reason = 'An active brand name changed' AND after_value->0->>'review_state' = 'superseded'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.product_weight_events WHERE parent_id = v_parent AND value_id = v_approved
      AND event_type = 'returned_to_draft' AND reason = 'An active brand name changed'
      AND before_value->0->>'review_state' = 'approved' AND after_value->0->>'review_state' = 'draft'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.blend_ticket_product_weights
     WHERE blend_ticket_id = v_ticket AND product_id = v_size AND weight_kind = 'density' AND lb_per_unit = 9.5
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the rename must retain approval history and the saved ticket weight';
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$$;
