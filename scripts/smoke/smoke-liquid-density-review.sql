-- Prove the current switch state. No fixture is committed.
DO $$
DECLARE
  v_admin uuid;
  v_reviewer uuid;
  v_rep uuid;
  v_first_receipt jsonb;
  v_group uuid;
  v_size uuid;
  v_brand uuid;
  v_draft uuid;
  v_dry_size uuid;
  v_dry_item jsonb;
  v_workbook_rows jsonb;
  v_result jsonb;
  v_brands jsonb;
  v_previous_brands jsonb;
  v_tag text := gen_random_uuid()::text;
  v_category text;
BEGIN
  SELECT id INTO STRICT v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1;
  SELECT name INTO STRICT v_category FROM public.product_categories WHERE is_active ORDER BY name LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Review ' || v_tag, 'product_form', 'liquid', 'category', v_category),
    jsonb_build_object('product_name', '[SMOKE] Review Size ' || v_tag, 'sku', 'SMOKE-REV-' || v_tag, 'inventory_unit', 'Gal'),
    'core-density-product-' || v_tag);
  v_group := (v_result->>'parent_id')::uuid;
  v_size := (v_result->>'product_id')::uuid;
  IF NOT public.liquid_density_review_open() THEN
    BEGIN
      PERFORM public.submit_liquid_density_draft(v_group, 0, 9.5, 'lb_per_gal', 'measured', NULL, NULL, NULL,
        'core-closed-draft-' || v_tag);
      RAISE EXCEPTION 'SMOKE_FAIL: the new draft path opened early';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'PRODUCT_WEIGHT_REVIEW_NOT_OPEN' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM public.approve_liquid_density_draft(v_group, gen_random_uuid(), 0, '[]'::jsonb, true,
        'core-closed-review-' || v_tag);
      RAISE EXCEPTION 'SMOKE_FAIL: the new approval path opened early';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'PRODUCT_WEIGHT_REVIEW_NOT_OPEN' THEN RAISE; END IF;
    END;
    PERFORM public.set_parent_density(v_group, 0, 9.5, 'lb_per_gal', 'measured', NULL, 'core-closed-legacy-' || v_tag);
    PERFORM public.upsert_parent_brand(v_group, v_size, 'Smoke Brand A', '12345-1', 'Smoke Manufacturer A',
      true, NULL, NULL, p_idempotency_key => 'core-closed-brand-' || v_tag);
    v_result := public.get_product_weights(ARRAY[v_size])->'products'->(v_size::text)->'weight';
    IF v_result->>'kind' IS DISTINCT FROM 'density' OR (v_result->>'lb_per_unit')::numeric IS DISTINCT FROM 9.5 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a brand join withdrew an approval before cutover';
    END IF;
    RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
  END IF;
  EXECUTE 'RESET ROLE';
  SELECT id INTO STRICT v_reviewer FROM public.profiles WHERE role = 'admin' AND is_active AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO STRICT v_rep FROM public.profiles WHERE role = 'sales_rep' AND is_active ORDER BY id LIMIT 1;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := public.upsert_parent_brand(v_group, v_size, 'Smoke Brand A', '12345-1', 'Smoke Manufacturer A',
    true, NULL, NULL, p_idempotency_key => 'core-brand-a-' || v_tag);
  v_brand := (v_result->>'id')::uuid;
  v_previous_brands := public.get_liquid_density_review(v_group)->'brands';
  PERFORM public.change_brand_document_links(v_brand, true, 1,
    '[{"action":"save","kind":"sds","url":"https://manufacturer.example/sds.pdf"}]'::jsonb, 'core-sds-' || v_tag);
  v_brands := public.get_liquid_density_review(v_group)->'brands';
  IF v_brands->0->>'sds_url' IS DISTINCT FROM 'https://manufacturer.example/sds.pdf' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: roster must show the current official SDS link';
  END IF;

  BEGIN
    PERFORM public.set_parent_density(v_group, 0, 9.5, 'lb_per_gal', 'sds', NULL, 'core-legacy-set-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: the legacy direct approval path stayed open';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRODUCT_WEIGHT_REVIEW_RELOAD%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    PERFORM public.submit_liquid_density_draft(v_group, 0, 1.15, 'specific_gravity', 'sds', NULL, NULL, NULL, 'core-rep-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep cannot submit a liquid weight draft';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.submit_liquid_density_draft(v_group, 0, 1.15, 'specific_gravity', 'sds', NULL,
    'Manufacturer correction', 'SDS Section 9', 'core-draft-' || v_tag);
  IF public.submit_liquid_density_draft(v_group, 0, 1.15, 'specific_gravity', 'sds', NULL,
      'Manufacturer correction', 'SDS Section 9', 'core-draft-' || v_tag) IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a retry must return the original draft receipt';
  END IF;
  BEGIN
    PERFORM public.submit_liquid_density_draft(v_group, 0, 1.16, 'specific_gravity', 'sds', NULL,
      'Manufacturer correction', 'SDS Section 9', 'core-draft-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: a changed draft cannot reuse the same key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'IDEMPOTENCY_PAYLOAD_MISMATCH' THEN RAISE; END IF;
  END;
  v_draft := (v_result->>'value_id')::uuid;
  IF (v_result->>'lb_per_gal')::numeric IS DISTINCT FROM 9.5972::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: specific gravity must use the existing stored conversion';
  END IF;
  BEGIN
    PERFORM public.submit_liquid_density_draft(v_group, 1, 10, 'lb_per_gal', 'sds', NULL, NULL, NULL, 'core-overwrite-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: a second draft must be refused';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRODUCT_WEIGHT_DRAFT_WAITING%' THEN RAISE; END IF;
  END;
  v_workbook_rows := jsonb_build_array(jsonb_build_object(
    'kind', 'density', 'subject_id', v_group, 'expected_version', 1, 'value', 10, 'source', 'sds'));
  v_result := public.preview_weights_tab(v_workbook_rows)->'rows'->0;
  IF v_result->>'status' IS DISTINCT FROM 'invalid' OR
     NOT COALESCE(v_result->>'problem' LIKE 'PRODUCT_WEIGHT_DRAFT_WAITING%', false) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: workbook preview must identify the waiting draft';
  END IF;
  BEGIN
    PERFORM public.commit_weights_tab(v_workbook_rows, 'core-workbook-overwrite-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: workbook must refuse the overwrite';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'WORKBOOK_WEIGHTS_REFUSED:%PRODUCT_WEIGHT_DRAFT_WAITING%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.approve_liquid_density_draft(v_group, v_draft, 1, v_brands, true, 'core-self-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: the author cannot approve their own draft';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRODUCT_WEIGHT_SECOND_ADMIN_REQUIRED%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_reviewer::text, true);
  BEGIN
    PERFORM public.approve_liquid_density_draft(v_group, v_draft, 1, v_previous_brands, true, 'core-stale-link-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: reviewer must see the changed SDS link';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRODUCT_WEIGHT_BRANDS_CHANGED%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.approve_liquid_density_draft(v_group, v_draft, 1, v_brands, false, 'core-no-attestation-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: reviewer must explicitly confirm the whole group';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRODUCT_WEIGHT_BRAND_CHECK_REQUIRED%' THEN RAISE; END IF;
  END;
  v_result := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Dry ' || v_tag, 'product_form', 'dry', 'category', v_category),
    jsonb_build_object('product_name', '[SMOKE] Dry Pack ' || v_tag, 'sku', 'SMOKE-DRY-' || v_tag,
      'inventory_unit', 'Ea', 'container_size', 5, 'container_unit', 'Lb', 'container_type', 'Bag'),
    'core-dry-product-' || v_tag);
  v_dry_size := (v_result->>'product_id')::uuid;
  EXECUTE 'RESET ROLE';
  v_result := public._save_size_net_weight_draft(v_dry_size, 0, 5, 'label', NULL, NULL, NULL);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_dry_item := jsonb_build_object('kind', 'net_weight', 'subject_id', v_dry_size,
    'draft_id', v_result->>'value_id', 'expected_version', 1);
  BEGIN
    PERFORM public.approve_weights(jsonb_build_array(v_dry_item, jsonb_build_object(
      'kind', 'density', 'subject_id', v_group, 'draft_id', v_draft, 'expected_version', 1)), 'core-legacy-approve-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: the legacy path must refuse the whole mixed batch';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRODUCT_WEIGHT_REVIEW_RELOAD%' THEN RAISE; END IF;
  END;
  PERFORM public.approve_weights(jsonb_build_array(v_dry_item), 'core-dry-approve-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_dry_size])->'products'->v_dry_size::text->'weight';
  IF v_result->>'kind' IS DISTINCT FROM 'net_weight' OR
    (v_result->>'lb_per_unit')::numeric IS DISTINCT FROM 5::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the dry-only approval path must keep working';
  END IF;
  v_first_receipt := public.approve_liquid_density_draft(v_group, v_draft, 1, v_brands, true, 'core-approve-' || v_tag);
  IF public.approve_liquid_density_draft(v_group, v_draft, 1, v_brands, true, 'core-approve-' || v_tag)
     IS DISTINCT FROM v_first_receipt THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a retry must return the original approval receipt';
  END IF;
  IF (v_first_receipt->>'version')::bigint IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: complete review must approve a draft';
  END IF;
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.product_weight_events WHERE id = (v_first_receipt->>'event_id')::bigint
    AND after_value->0->'reviewed_brands' = v_brands AND changed_by = v_reviewer
    AND reason = 'Manufacturer correction' AND evidence = 'SDS Section 9') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the review must keep the exact confirmed brands and reviewer in history';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := public.submit_liquid_density_draft(v_group, 2, 9.8, 'lb_per_gal', 'sds', NULL, NULL, NULL, 'core-next-draft-' || v_tag);
  v_draft := (v_result->>'value_id')::uuid;
  PERFORM public.upsert_parent_brand(v_group, v_size, 'Smoke Brand B', '12345-2', 'Smoke Manufacturer B',
    true, NULL, NULL, p_idempotency_key => 'core-brand-b-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF v_result->'weight'->>'kind' IS DISTINCT FROM 'none' OR
     (v_result->'draft'->>'id')::uuid IS DISTINCT FROM v_draft THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a brand join must withdraw the approval and preserve the waiting draft';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_reviewer::text, true);
  v_brands := public.get_liquid_density_review(v_group)->'brands';
  PERFORM public.approve_liquid_density_draft(v_group, v_draft, 4, v_brands, true, 'core-reapprove-' || v_tag);
  v_result := public.upsert_parent_brand(v_group, v_size, 'Smoke Brand C', '12345-3', 'Smoke Manufacturer C',
    true, NULL, NULL, p_idempotency_key => 'core-brand-c-' || v_tag);
  v_brand := (v_result->>'id')::uuid;
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF v_result->'weight'->>'kind' IS DISTINCT FROM 'none' OR
     (v_result->'draft'->>'id')::uuid IS DISTINCT FROM v_draft OR
     (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 6::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a brand join with no waiting draft must return the last approval to draft';
  END IF;

  v_brands := public.get_liquid_density_review(v_group)->'brands';
  PERFORM public.approve_liquid_density_draft(v_group, v_draft, 6, v_brands, true, 'core-approve-after-c-' || v_tag);
  PERFORM public.upsert_parent_brand(v_group, v_size, 'Smoke Brand C', '12345-3', 'Smoke Manufacturer C',
    false, NULL, NULL, v_brand, 1, p_idempotency_key => 'core-sourcing-change-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF v_result->'weight'->>'kind' IS DISTINCT FROM 'density' OR
     (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 7::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: editing brand sourcing alone must keep the approved weight and version';
  END IF;
  PERFORM public.upsert_parent_brand(v_group, v_size, 'Smoke Brand C', '12345-3', 'New Manufacturer C',
    true, NULL, NULL, v_brand, 2, p_idempotency_key => 'core-new-manufacturer-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF v_result->'weight'->>'kind' IS DISTINCT FROM 'none' OR
     (v_result->'draft'->>'id')::uuid IS DISTINCT FROM v_draft OR
     (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 8::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an active manufacturer change must return the approval to draft';
  END IF;

  v_brands := public.get_liquid_density_review(v_group)->'brands';
  PERFORM public.approve_liquid_density_draft(v_group, v_draft, 8, v_brands, true, 'core-approve-after-maker-' || v_tag);
  PERFORM public.upsert_parent_brand(v_group, v_size, 'Smoke Brand C', '12345-4', 'New Manufacturer C',
    true, NULL, NULL, v_brand, 3, p_idempotency_key => 'core-new-epa-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF v_result->'weight'->>'kind' IS DISTINCT FROM 'none' OR
     (v_result->'draft'->>'id')::uuid IS DISTINCT FROM v_draft OR
     (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 10::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an active EPA registration change must return the approval to draft';
  END IF;

  v_brands := public.get_liquid_density_review(v_group)->'brands';
  PERFORM public.approve_liquid_density_draft(v_group, v_draft, 10, v_brands, true, 'core-approve-after-epa-' || v_tag);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.submit_liquid_density_draft(v_group, 11, 9.9, 'lb_per_gal', 'sds', NULL, NULL, NULL, 'core-waiting-for-review-' || v_tag);
  v_draft := (v_result->>'value_id')::uuid;
  PERFORM public.upsert_parent_brand(v_group, v_size, 'Smoke Brand C', '12345-4', 'Final Manufacturer C',
    true, NULL, NULL, v_brand, 4, p_idempotency_key => 'core-waiting-manufacturer-' || v_tag);
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text;
  IF v_result->'weight'->>'kind' IS DISTINCT FROM 'none' OR
     (v_result->'draft'->>'id')::uuid IS DISTINCT FROM v_draft OR
     (v_result->'subject'->>'version')::bigint IS DISTINCT FROM 13::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a new manufacturer must withdraw approval and keep the draft already waiting';
  END IF;
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (
    SELECT 1 FROM public.product_weight_events WHERE parent_id = v_group AND event_type = 'returned_to_draft'
      AND reason = 'An active brand changed its EPA registration or manufacturer'
      AND before_value->0->>'review_state' = 'approved' AND after_value->0->>'review_state' = 'superseded'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: identity recheck must record why the prior approval was archived';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$$;
