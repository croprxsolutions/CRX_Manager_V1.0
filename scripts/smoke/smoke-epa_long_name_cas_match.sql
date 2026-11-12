-- Smoke chain: EPA lookup with an over-long ingredient name (REQUIRES 20270107100000, the #1810 follow-up).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so the parent, registration, ingredient row, lookup and
-- proposal it writes are rolled back. On an invented product with one Glyphosate row:
--   * an admin (role authenticated with a live admin's claims) starts a lookup of the product's EPA number;
--   * the epa-lookup Edge Function's role (service_role) records EPA's answer, which lists Glyphosate by its
--     CAS under a 250-character name;
--   * the proposal shows that entry as an unticked "EPA unclear" conflict with no change, shows the product's
--     Glyphosate row beside it, and does NOT list that row as missing from EPA (Taha's #1810 LOW).
-- Before 20270107100000 the last two checks fail: the conflict shows no row and the row is listed as missing.
-- Every other case is proven on invented rows by scripts/smoke/prove-epa-chemistry-proposals-real-schema.mjs (H28).
DO $$
DECLARE
  c_cas constant text := '1071-83-6';
  v_admin uuid;
  v_cat text;
  v_tag text := substr(md5(clock_timestamp()::text), 1, 10);
  v_num text;
  v_parent uuid := gen_random_uuid();
  v_ing uuid;
  v_row uuid;
  v_start jsonb;
  v_rec jsonb;
  v_items jsonb;
  v_long jsonb;
BEGIN
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  SELECT c.name INTO v_cat FROM public.product_categories c WHERE c.is_active ORDER BY c.name LIMIT 1;
  IF v_admin IS NULL OR v_cat IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin and an active category';
  END IF;
  -- An EPA number no live registration uses.
  LOOP
    v_num := (900000 + floor(random() * 99999))::int::text || '-' || (1 + floor(random() * 9998))::int::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.epa_registrations WHERE epa_registration = v_num);
  END LOOP;

  INSERT INTO public.epa_registrations (epa_registration, registration_status, rup_status, created_by, updated_by)
    VALUES (v_num, 'unknown', 'unknown', v_admin, v_admin);
  INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by)
    VALUES (v_parent, '[SMOKE] EPA long name ' || v_tag, 'liquid', 'SL', v_cat, v_num, true, v_admin, v_admin);
  -- CAS is unique across every ingredient: use the live Glyphosate row if there is one.
  SELECT id INTO v_ing FROM public.active_ingredients WHERE cas = c_cas;
  IF v_ing IS NULL THEN
    INSERT INTO public.active_ingredients (name, cas, created_by, updated_by)
      VALUES ('[SMOKE] Glyphosate ' || v_tag, c_cas, v_admin, v_admin) RETURNING id INTO v_ing;
  END IF;
  INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unit, strength_basis, source, source_note, created_by, updated_by)
    VALUES (v_parent, v_ing, 41, 'pct_ww', 'active_ingredient', 'label', 'smoke', v_admin, v_admin) RETURNING id INTO v_row;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_start := public.start_epa_lookup(v_parent, v_num, 'smoke-epa-long-start-' || v_tag);
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  v_rec := public.record_epa_lookup((v_start->>'lookup_id')::uuid, jsonb_build_object(
    'found', true, 'regType', 'section3', 'eparegno', v_num, 'productname', '[SMOKE] ' || v_num, 'manufacturer', 'Smoke Co',
    'productStatus', 'Registered', 'latestLabelPdfUrl', NULL, 'signalWordCanonical', 'Caution', 'needsManual', false,
    'isCancelled', false, 'rupYn', 'No', 'labelPdfs', '[]'::jsonb,
    'activeIngredients', jsonb_build_array(jsonb_build_object('name', repeat('G', 250), 'percent', 40, 'pcCode', NULL, 'casNumber', c_cas))),
    'smoke-epa-long-record-' || v_tag);
  EXECUTE 'RESET ROLE';
  IF v_rec->>'outcome' IS DISTINCT FROM 'proposal' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the lookup did not make a proposal: %', v_rec;
  END IF;

  SELECT items INTO v_items FROM public.epa_chemistry_proposals WHERE id = (v_rec->>'proposal_id')::uuid;
  SELECT e INTO v_long FROM jsonb_array_elements(v_items) e WHERE e->>'kind' = 'ingredient' AND e->'epa'->>'cas' = c_cas;
  IF v_long IS NULL OR v_long->>'class' IS DISTINCT FROM 'epa_conflict' OR COALESCE((v_long->>'accept_default')::boolean, true)
     OR COALESCE(jsonb_typeof(v_long->'change'), 'null') <> 'null' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the long-name entry is not an unticked conflict with no change: %', v_long;
  END IF;
  IF (v_long->'current'->>'id')::uuid IS DISTINCT FROM v_row THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the long-name conflict does not show the product''s Glyphosate row: %', v_long;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) e WHERE e->>'class' = 'missing_from_epa') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the Glyphosate row is still listed as missing from EPA: %', v_items;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: EPA long-name CAS match chain passed';
END;
$$;
