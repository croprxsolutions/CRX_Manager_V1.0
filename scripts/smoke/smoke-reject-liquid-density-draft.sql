-- Use invented rows. The terminal exception leaves no business records behind.
DO $$
DECLARE
  v_admin uuid;
  v_reviewer uuid;
  v_rep uuid;
  v_result jsonb;
  v_group uuid;
  v_size uuid;
  v_draft uuid;
  v_receipt jsonb;
  v_tag text := gen_random_uuid()::text;
  v_cat text;
  v_actor uuid;
  v_reason text;
  v_key text;
  v_expected text;
  v_version bigint;
BEGIN
  IF has_function_privilege('anon', 'public.reject_liquid_density_draft(uuid,uuid,bigint,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anonymous caller can execute rejection';
  END IF;
  SELECT id INTO STRICT v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1;
  SELECT id INTO STRICT v_reviewer FROM public.profiles WHERE role = 'admin' AND is_active AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO STRICT v_rep FROM public.profiles WHERE role = 'sales_rep' AND is_active ORDER BY id LIMIT 1;
  SELECT name INTO STRICT v_cat FROM public.product_categories WHERE is_active ORDER BY name LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Density ' || v_tag, 'product_form', 'liquid', 'category', v_cat),
    jsonb_build_object('product_name', '[SMOKE] Density Size ' || v_tag, 'sku', 'SMOKE-DRAFT-' || v_tag, 'inventory_unit', 'Gal'),
    'smoke-density-product-' || v_tag);
  v_group := (v_result->>'parent_id')::uuid;
  v_size := (v_result->>'product_id')::uuid;
  PERFORM public.set_parent_density(v_group, 0, 9.5, 'lb_per_gal', 'sds', NULL, 'smoke-density-set-' || v_tag);
  EXECUTE 'RESET ROLE';
  v_result := public._save_parent_density_draft(v_group, 1, 10, 'lb_per_gal', 'sds', NULL, NULL, NULL);
  v_draft := (v_result->>'value_id')::uuid;

  FOR v_actor, v_reason, v_key, v_version, v_expected IN VALUES
    (v_rep, 'Different SDS', 'rep', 2, 'ADMIN_REQUIRED%'),
    (v_admin, 'Different SDS', 'self', 2, 'PRODUCT_WEIGHT_SECOND_ADMIN_REQUIRED%'),
    (v_reviewer, '', 'blank', 2, 'REASON_REQUIRED%'),
    (v_reviewer, 'Different SDS', NULL::text, 2, 'IDEMPOTENCY_KEY_REQUIRED%'),
    (v_reviewer, 'Different SDS', 'stale-version', 1, 'PRODUCT_WEIGHT_STALE%')
  LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
    BEGIN
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.reject_liquid_density_draft(v_group, v_draft, v_version, v_reason, v_key || v_tag);
      RAISE EXCEPTION 'SMOKE_FAIL: expected %', v_expected;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE v_expected THEN RAISE; END IF;
    END;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', v_reviewer::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_key := 'smoke-density-reject-' || v_tag;
  v_receipt := public.reject_liquid_density_draft(v_group, v_draft, 2, 'Different SDS', v_key);
  IF (v_receipt->>'version')::bigint IS DISTINCT FROM 3::bigint OR
     public.reject_liquid_density_draft(v_group, v_draft, 2, 'Different SDS', v_key) IS DISTINCT FROM v_receipt THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejection must advance the version once and replay the same receipt';
  END IF;
  BEGIN
    PERFORM public.reject_liquid_density_draft(v_group, v_draft, 2, 'Different reason', v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: changed reason must not replay';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'IDEMPOTENCY_PAYLOAD_MISMATCH' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.reject_liquid_density_draft(v_group, v_draft, 2, 'Different SDS', v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: another admin cannot redeem the reviewer receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'IDEMPOTENCY_PAYLOAD_MISMATCH' THEN RAISE; END IF;
  END;
  v_result := public.get_product_weights(ARRAY[v_size])->'products'->v_size::text->'weight';
  IF (v_result->>'lb_per_unit')::numeric IS DISTINCT FROM 9.5::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the already approved weight must stay in use';
  END IF;
  EXECUTE 'RESET ROLE';

  IF NOT EXISTS (SELECT 1 FROM public.product_parent_density_values WHERE id = v_draft AND review_state = 'superseded')
    OR (SELECT count(*) FROM public.product_weight_events WHERE parent_id = v_group AND event_type = 'draft_rejected') <> 1
    OR NOT EXISTS (SELECT 1 FROM public.product_weight_events
      WHERE id = (v_receipt->>'event_id')::bigint AND value_id = v_draft AND changed_by = v_reviewer AND reason = 'Different SDS') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejection must keep the draft and its reason and reviewer';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public._save_parent_density_draft(v_group, 3, 9.6, 'lb_per_gal', 'sds', NULL, NULL, NULL);
  IF (v_result->>'version')::bigint IS DISTINCT FROM 4::bigint OR (v_result->>'value_id')::uuid = v_draft THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a new proposal should get a new draft';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_reviewer::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.reject_liquid_density_draft(v_group, v_draft, 4, 'Old draft', 'smoke-old-' || v_tag);
    RAISE EXCEPTION 'SMOKE_FAIL: cannot reject the new draft using the previous draft ID';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRODUCT_WEIGHT_STALE%' THEN RAISE; END IF;
  END;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$$;
