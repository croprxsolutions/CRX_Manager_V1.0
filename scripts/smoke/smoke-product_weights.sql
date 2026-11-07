-- Smoke chain: product weights (REQUIRES 20261207100000, DM-2).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so every parent, size, weight value, state and event row
-- it writes is rolled back. Proves, as a real signed-in admin session (role authenticated with a live admin
-- profile's claims) and as a signed-out visitor (role anon), on invented liquid parents:
--   * anon cannot execute any of the five public weight writers or the reader;
--   * an admin sets a measured 9.5 lb/gal on a parent and its size reads it; a same-key retry replays;
--   * 20.00005 lb/gal is refused PRODUCT_WEIGHT_OUT_OF_RANGE and exactly 20 saves (the cap, Mason 2026-11-07);
--   * an older version is refused PRODUCT_WEIGHT_STALE;
--   * a label draft is not read until approve_weights approves it, then the size reads 9.9;
--   * an active sales rep profile is refused ADMIN_REQUIRED.
-- Every other rule is proven on invented rows by scripts/smoke/prove-product-weights-real-schema.mjs.
DO $$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_sig text;
  v_refused boolean;
  v_cat text;
  v_tag text := substr(md5(clock_timestamp()::text), 1, 10);
  v_a jsonb;
  v_b jsonb;
  v_pa uuid;
  v_sa uuid;
  v_pb uuid;
  v_sb uuid;
  v_ver bigint;
  v_r1 jsonb;
  v_r2 jsonb;
  v_w jsonb;
  v_draft uuid;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.get_product_weights(uuid[])',
    'public.set_parent_density(uuid,bigint,numeric,text,text,text,text)',
    'public.correct_parent_density(uuid,bigint,numeric,text,text,text,text,text,text)',
    'public.set_size_net_weight(uuid,bigint,numeric,text,text,text)',
    'public.correct_size_net_weight(uuid,bigint,numeric,text,text,text,text,text)',
    'public.approve_weights(jsonb,text)'] LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: anon can execute %', v_sig;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated',
      'public._save_parent_density_draft(uuid,bigint,numeric,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a signed-in user can call the private density draft helper';
  END IF;

  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  SELECT p.id INTO v_rep FROM public.profiles p WHERE p.role = 'sales_rep' AND p.is_active ORDER BY p.created_at LIMIT 1;
  SELECT c.name INTO v_cat FROM public.product_categories c WHERE c.is_active ORDER BY c.name LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_cat IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin, an active sales rep and an active category';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_a := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Weight A ' || v_tag, 'product_form', 'liquid', 'category', v_cat),
    jsonb_build_object('product_name', '[SMOKE] Weight A 2.5 ' || v_tag, 'sku', 'SMOKE-WA-' || v_tag, 'inventory_unit', 'Gal'),
    'smoke-pw-create-a-' || v_tag);
  v_b := public.create_product_with_parent(
    jsonb_build_object('name', '[SMOKE] Weight B ' || v_tag, 'product_form', 'liquid', 'category', v_cat),
    jsonb_build_object('product_name', '[SMOKE] Weight B 2.5 ' || v_tag, 'sku', 'SMOKE-WB-' || v_tag, 'inventory_unit', 'Gal'),
    'smoke-pw-create-b-' || v_tag);
  v_pa := (v_a->>'parent_id')::uuid;
  v_sa := (v_a->>'product_id')::uuid;
  v_pb := (v_b->>'parent_id')::uuid;
  v_sb := (v_b->>'product_id')::uuid;
  IF v_pa IS NULL OR v_sa IS NULL OR v_pb IS NULL OR v_sb IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_product_with_parent did not return parent_id and product_id: % / %', v_a, v_b;
  END IF;

  v_w := public.get_product_weights(ARRAY[v_sa])->'products'->(v_sa::text)->'weight';
  IF v_w->>'kind' IS DISTINCT FROM 'none' OR v_w->>'none_reason' IS DISTINCT FROM 'no_approved_weight' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a new parent should read no_approved_weight, read %', v_w;
  END IF;

  -- Set, replay, read.
  v_r1 := public.set_parent_density(v_pa, 0, 9.5, 'lb_per_gal', 'measured', NULL, 'smoke-pw-set-' || v_tag);
  v_r2 := public.set_parent_density(v_pa, 0, 9.5, 'lb_per_gal', 'measured', NULL, 'smoke-pw-set-' || v_tag);
  IF v_r2 IS DISTINCT FROM v_r1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a same-key density set did not replay: % / %', v_r1, v_r2;
  END IF;
  v_w := public.get_product_weights(ARRAY[v_sa])->'products'->(v_sa::text)->'weight';
  IF v_w->>'kind' IS DISTINCT FROM 'density' OR (v_w->>'lb_per_unit')::numeric <> 9.5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the size should read 9.5 lb per Gal, read %', v_w;
  END IF;

  -- The 20 lb/gal cap.
  EXECUTE 'RESET ROLE';
  SELECT density_version INTO v_ver FROM public.product_parent_density_state WHERE parent_id = v_pa;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_refused := false;
  BEGIN
    PERFORM public.set_parent_density(v_pa, v_ver, 20.00005, 'lb_per_gal', 'measured', NULL, 'smoke-pw-over-' || v_tag);
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE 'PRODUCT_WEIGHT_OUT_OF_RANGE%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: 20.00005 lb/gal was not refused PRODUCT_WEIGHT_OUT_OF_RANGE';
  END IF;
  PERFORM public.set_parent_density(v_pa, v_ver, 20, 'lb_per_gal', 'measured', NULL, 'smoke-pw-cap-' || v_tag);
  v_w := public.get_product_weights(ARRAY[v_sa])->'products'->(v_sa::text)->'weight';
  IF (v_w->>'lb_per_unit')::numeric <> 20 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: exactly 20 lb/gal should save and read, read %', v_w;
  END IF;

  -- An older version is refused.
  v_refused := false;
  BEGIN
    PERFORM public.set_parent_density(v_pa, v_ver, 9.1, 'lb_per_gal', 'measured', NULL, 'smoke-pw-stale-' || v_tag);
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE 'PRODUCT_WEIGHT_STALE%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an older density version was not refused PRODUCT_WEIGHT_STALE';
  END IF;

  -- A draft is not read until approved.
  EXECUTE 'RESET ROLE';
  PERFORM public._save_parent_density_draft(v_pb, 0, 9.9, 'lb_per_gal', 'label', NULL, NULL, NULL);
  SELECT id INTO v_draft FROM public.product_parent_density_values WHERE parent_id = v_pb AND review_state = 'draft';
  SELECT density_version INTO v_ver FROM public.product_parent_density_state WHERE parent_id = v_pb;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_w := public.get_product_weights(ARRAY[v_sb])->'products'->(v_sb::text)->'weight';
  IF v_w->>'kind' IS DISTINCT FROM 'none' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a draft density was read before approval: %', v_w;
  END IF;
  PERFORM public.approve_weights(jsonb_build_array(jsonb_build_object('kind', 'density', 'subject_id', v_pb,
    'draft_id', v_draft, 'expected_version', v_ver)), 'smoke-pw-approve-' || v_tag);
  v_w := public.get_product_weights(ARRAY[v_sb])->'products'->(v_sb::text)->'weight';
  IF v_w->>'kind' IS DISTINCT FROM 'density' OR (v_w->>'lb_per_unit')::numeric <> 9.9 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the approved draft should read 9.9 lb per Gal, read %', v_w;
  END IF;
  EXECUTE 'RESET ROLE';

  -- A non-admin is refused.
  v_refused := false;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.set_parent_density(v_pa, 99, 9, 'lb_per_gal', 'measured', NULL, 'smoke-pw-rep-' || v_tag);
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM = 'ADMIN_REQUIRED';
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an active sales rep was not refused ADMIN_REQUIRED';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: product weights chain passed';
END;
$$;
