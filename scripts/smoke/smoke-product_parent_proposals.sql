-- Smoke chain: product parent proposals and parent brands (REQUIRES 20261203110000, PAR-2).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so the proposal, groups, parents, brands, events and
-- receipts it writes are rolled back. Proves, as a real signed-in browser session (role authenticated with
-- each live profile's claims) and as a signed-out visitor (role anon), on three invented two-size products:
--   * anon cannot execute any of the six public PAR-2 functions;
--   * while the grouping switch is off (as shipped), approval and parent-brand edits are refused
--     PRODUCT_PARENT_GROUPING_NOT_OPEN; the chain then turns it on inside its own rolled-back transaction;
--   * an admin builds a proposal (a same-key retry answers the same) that proposes each invented product
--     as one group by its EPA number;
--   * the admin approves one group (a same-key retry answers the same): both sizes join one new parent;
--     holds the second and rejects the third, each with a reason; a decision without a reason is refused;
--   * the old per-size brand writer refuses a grouped size PRODUCT_BRANDS_BELONG_TO_PARENT;
--   * the admin adds a brand to the new parent, which get_product_brands then lists for a size, and
--     retires it with a reason; the read no longer lists it;
--   * an active sales rep, driver, applicator and commission-recipient profile are refused ADMIN_REQUIRED
--     by the build.
-- Every other rule is proven on invented rows by scripts/smoke/prove-product-parent-proposals-real-schema.mjs.
DO $$
DECLARE
  v_admin uuid;
  v_uid uuid;
  v_role text;
  v_sig text;
  v_refused boolean;
  v_was_open boolean;
  v_cat text;
  v_tag text := translate(substr(md5(clock_timestamp()::text), 1, 10), '0123456789', 'ghijklmnop');
  v_ids uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                        gen_random_uuid(), gen_random_uuid()];
  v_word text[] := ARRAY['Alpha', 'Bravo', 'Charlie'];
  v_i integer;
  v_p jsonb;
  v_again jsonb;
  v_g public.product_parent_proposal_groups%ROWTYPE;
  v_ga public.product_parent_proposal_groups%ROWTYPE;
  v_gb public.product_parent_proposal_groups%ROWTYPE;
  v_gc public.product_parent_proposal_groups%ROWTYPE;
  v_entry jsonb;
  v_ok jsonb;
  v_parent uuid;
  v_brand jsonb;
  v_read jsonb;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.build_product_parent_proposal(text)',
    'public.approve_product_parent_groups(uuid,bigint,jsonb,text)',
    'public.hold_product_parent_group(uuid,bigint,text,text,text)',
    'public.reject_product_parent_group(uuid,bigint,text,text,text)',
    'public.upsert_parent_brand(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)',
    'public.get_product_brands(uuid)'] LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: anon can execute %', v_sig;
    END IF;
  END LOOP;

  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  SELECT c.name INTO v_cat FROM public.product_categories c WHERE c.is_active ORDER BY c.name LIMIT 1;
  IF v_admin IS NULL OR v_cat IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin and an active category';
  END IF;

  -- Three invented products, two sizes each, one EPA number each; no price, rate or brand.
  FOR v_i IN 1..3 LOOP
    INSERT INTO public.products (id, product_name, sku, category, epa_registration, product_form, inventory_unit, is_active,
                                 container_size, container_unit)
    VALUES (v_ids[2 * v_i - 1], '[SMOKE] Partwo ' || v_word[v_i] || ' ' || v_tag || ' 2.5 gal', 'SMOKE-P2-' || v_i || 'a-' || v_tag,
            v_cat, '9999' || v_i || '-7', 'liquid', 'Gal', true, 2.5, 'Gal'),
           (v_ids[2 * v_i], '[SMOKE] Partwo ' || v_word[v_i] || ' ' || v_tag || ' 1 gal', 'SMOKE-P2-' || v_i || 'b-' || v_tag,
            v_cat, '9999' || v_i || '-7', 'liquid', 'Gal', true, 1, 'Gal');
  END LOOP;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- The grouping switch ships off until the PAR-2 screens are live. Off: both writers refuse. Then on, here only.
  EXECUTE 'RESET ROLE';
  v_was_open := public._product_parent_grouping_open();
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT v_was_open THEN
    BEGIN
      PERFORM public.approve_product_parent_groups(gen_random_uuid(), 1, '[]'::jsonb, 'smoke:par2:closed-a:' || v_tag);
      v_refused := false;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'PRODUCT_PARENT_GROUPING_NOT_OPEN%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a closed approval failed for another reason: %', SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: an approval ran while grouping is closed'; END IF;
    BEGIN
      PERFORM public.upsert_parent_brand(gen_random_uuid(), gen_random_uuid(), 'Smoke Closed ' || v_tag, NULL, NULL, true, false, NULL,
        NULL, NULL, false, NULL, 'smoke:par2:closed-b:' || v_tag);
      v_refused := false;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'PRODUCT_PARENT_GROUPING_NOT_OPEN%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a closed parent-brand edit failed for another reason: %', SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a parent-brand edit ran while grouping is closed'; END IF;
    EXECUTE 'RESET ROLE';
    CREATE OR REPLACE FUNCTION public._product_parent_grouping_open() RETURNS boolean
    LANGUAGE sql STABLE SET search_path = public, pg_temp AS $open$ SELECT true; $open$;
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;

  v_p := public.build_product_parent_proposal('smoke-pp2-build-' || v_tag);
  v_again := public.build_product_parent_proposal('smoke-pp2-build-' || v_tag);
  IF v_again IS DISTINCT FROM v_p THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a same-key build did not replay: % / %', v_p, v_again;
  END IF;
  FOR v_i IN 1..3 LOOP
    SELECT g.* INTO v_g FROM public.product_parent_proposal_groups g
     WHERE g.proposal_id = (v_p->>'proposal_id')::uuid
       AND g.members @> jsonb_build_array(jsonb_build_object('product_id', v_ids[2 * v_i - 1]));
    IF v_g.id IS NULL OR v_g.status <> 'proposed' OR v_g.identity_basis <> 'epa_number'
       OR jsonb_array_length(v_g.members) <> 2
       OR NOT v_g.members @> jsonb_build_array(jsonb_build_object('product_id', v_ids[2 * v_i])) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: invented product % was not proposed as one EPA-number group: % %', v_i, v_g.status, v_g.flags;
    END IF;
    IF v_i = 1 THEN v_ga := v_g; ELSIF v_i = 2 THEN v_gb := v_g; ELSE v_gc := v_g; END IF;
  END LOOP;

  -- Approve the first group.
  v_entry := jsonb_build_object('group_id', v_ga.id, 'group_fingerprint', v_ga.group_fingerprint, 'name', v_ga.suggested_name);
  v_ok := public.approve_product_parent_groups((v_p->>'proposal_id')::uuid, (v_p->>'proposal_version')::bigint,
    jsonb_build_array(v_entry), 'smoke-pp2-approve-' || v_tag);
  v_again := public.approve_product_parent_groups((v_p->>'proposal_id')::uuid, (v_p->>'proposal_version')::bigint,
    jsonb_build_array(v_entry), 'smoke-pp2-approve-' || v_tag);
  IF v_again IS DISTINCT FROM v_ok THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a same-key approval did not replay';
  END IF;
  v_parent := (v_ok->'groups'->0->>'parent_id')::uuid;

  -- Hold and reject the others; a decision needs a reason.
  v_refused := false;
  BEGIN
    PERFORM public.hold_product_parent_group(v_gb.id, (v_p->>'proposal_version')::bigint, v_gb.group_fingerprint, ' ',
      'smoke-pp2-noreason-' || v_tag);
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a hold without a reason was not refused';
  END IF;
  PERFORM public.hold_product_parent_group(v_gb.id, (v_p->>'proposal_version')::bigint, v_gb.group_fingerprint,
    'smoke check later', 'smoke-pp2-hold-' || v_tag);
  PERFORM public.reject_product_parent_group(v_gc.id, (v_p->>'proposal_version')::bigint, v_gc.group_fingerprint,
    'smoke not one product', 'smoke-pp2-reject-' || v_tag);

  -- The old per-size writer refuses a grouped size.
  v_refused := false;
  BEGIN
    PERFORM public.upsert_product_brand(v_ids[1], 'Smoke Old ' || v_tag, NULL, NULL, true, NULL, NULL, NULL, NULL,
      'smoke-pp2-old-' || v_tag);
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLERRM LIKE 'PRODUCT_BRANDS_BELONG_TO_PARENT%';
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the per-size brand writer did not refuse a grouped size';
  END IF;

  -- Parent brand: add, read through a size, retire with a reason.
  v_brand := public.upsert_parent_brand(v_parent, v_ids[2], 'Smoke Brand ' || v_tag, '99991-7', 'Smoke Co', true, false, NULL,
    NULL, NULL, false, NULL, 'smoke-pp2-brand-' || v_tag);
  v_read := public.get_product_brands(v_ids[2]);
  IF v_read->>'source' <> 'parent' OR (v_read->>'parent_id')::uuid IS DISTINCT FROM v_parent
     OR jsonb_array_length(v_read->'brands') <> 1 OR v_read->'brands'->0->>'id' <> v_brand->>'id' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the size did not read its parent''s brand: %', v_read;
  END IF;
  PERFORM public.upsert_parent_brand(v_parent, v_ids[2], 'Smoke Brand ' || v_tag, '99991-7', 'Smoke Co', true, false, NULL,
    (v_brand->>'id')::uuid, (v_brand->>'row_version')::integer, true, 'smoke no longer carried', 'smoke-pp2-retire-' || v_tag);
  v_read := public.get_product_brands(v_ids[2]);
  EXECUTE 'RESET ROLE';

  IF jsonb_array_length(v_read->'brands') <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a retired parent brand is still listed: %', v_read;
  END IF;
  IF (SELECT count(*) FROM public.product_parent_members WHERE parent_id = v_parent AND product_id IN (v_ids[1], v_ids[2])) <> 2
     OR EXISTS (SELECT 1 FROM public.product_parent_members WHERE product_id = ANY(v_ids[3:6])) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the approval did not group exactly the approved sizes';
  END IF;
  IF (SELECT string_agg(status || ':' || CASE WHEN status = 'approved' THEN '' ELSE COALESCE(reason, '') END, ',' ORDER BY suggested_name)
        FROM public.product_parent_proposal_groups WHERE id IN (v_ga.id, v_gb.id, v_gc.id))
     IS DISTINCT FROM 'approved:,held:smoke check later,rejected:smoke not one product' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the decisions were not recorded';
  END IF;
  IF (SELECT string_agg(event_type, ',' ORDER BY changed_at, id) FROM public.product_parent_brand_events
       WHERE parent_brand_id = (v_brand->>'id')::uuid) IS DISTINCT FROM 'created,retired' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the parent brand events were not logged';
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
      PERFORM public.build_product_parent_proposal('smoke-pp2-rep-' || v_role || v_tag);
    EXCEPTION WHEN OTHERS THEN
      v_refused := SQLERRM = 'ADMIN_REQUIRED';
    END;
    EXECUTE 'RESET ROLE';
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an active % was not refused ADMIN_REQUIRED', v_role;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: product parent proposals chain passed';
END;
$$;
