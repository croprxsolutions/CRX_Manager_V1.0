-- Smoke chain: the EPA batch fill's save (REQUIRES 20270130100000, issue #1976).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so the parents, registrations, lookups, proposals and
-- ingredient rows it writes are rolled back. On two invented products, each with one invented EPA number:
--   * an admin starts a lookup and the epa-lookup role (service_role) records EPA's answer (one ingredient);
--   * the admin saves product A through commit_epa_proposal_batch, accepting the ingredient and declining every
--     label item, as the batch screen does: the proposal is committed and exactly one ingredient row is written;
--   * the same call with the same key returns the same receipt and writes nothing more;
--   * product B's save declining its ingredient is refused EPA_BATCH_DECISION_INVALID and writes nothing.
-- Every refusal and race is proven on invented rows by scripts/smoke/prove-epa-batch-commit-real-schema.mjs,
-- which also runs this chain against the candidate.
DO $$
DECLARE
  v_admin uuid;
  v_cat text;
  v_tag text := substr(md5(clock_timestamp()::text), 1, 10);
  v_num text[] := ARRAY[]::text[];
  v_parent uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_prop uuid[] := ARRAY[]::uuid[];
  v_n text;
  v_start jsonb;
  v_rec jsonb;
  v_ver bigint;
  v_dec jsonb;
  v_first jsonb;
  v_again jsonb;
  v_err text;
  i int;
BEGIN
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  SELECT c.name INTO v_cat FROM public.product_categories c WHERE c.is_active ORDER BY c.name LIMIT 1;
  IF v_admin IS NULL OR v_cat IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin and an active category';
  END IF;

  FOR i IN 1..2 LOOP
    -- An EPA number no live registration uses.
    LOOP
      v_n := (900000 + floor(random() * 99999))::int::text || '-' || (1 + floor(random() * 9998))::int::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.epa_registrations WHERE epa_registration = v_n) AND NOT (v_n = ANY (v_num));
    END LOOP;
    v_num := v_num || v_n;
    INSERT INTO public.epa_registrations (epa_registration, registration_status, rup_status, created_by, updated_by)
      VALUES (v_n, 'unknown', 'no', v_admin, v_admin);
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by)
      VALUES (v_parent[i], '[SMOKE] EPA batch ' || i || ' ' || v_tag, 'liquid', 'SL', v_cat, v_n, true, v_admin, v_admin);

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_start := public.start_epa_lookup(v_parent[i], v_n, 'smoke-epa-batch-start-' || i || '-' || v_tag);
    EXECUTE 'RESET ROLE';

    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    EXECUTE 'SET LOCAL ROLE service_role';
    v_rec := public.record_epa_lookup((v_start->>'lookup_id')::uuid, jsonb_build_object(
      'found', true, 'regType', 'section3', 'eparegno', v_n, 'productname', '[SMOKE] ' || v_n, 'manufacturer', 'Smoke Co',
      'productStatus', 'Registered', 'latestLabelPdfUrl', NULL, 'signalWordCanonical', 'Caution', 'needsManual', false,
      'isCancelled', false, 'rupYn', 'No', 'labelPdfs', '[]'::jsonb,
      'activeIngredients', jsonb_build_array(jsonb_build_object('name', 'Atrazine', 'percent', 42.6, 'pcCode', NULL, 'casNumber', '1912-24-9'))),
      'smoke-epa-batch-record-' || i || '-' || v_tag);
    EXECUTE 'RESET ROLE';
    IF v_rec->>'outcome' IS DISTINCT FROM 'proposal' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: lookup % did not make a proposal: %', i, v_rec;
    END IF;
    v_prop := v_prop || (v_rec->>'proposal_id')::uuid;
  END LOOP;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- A: every writable item decided, only the ingredient accepted (the screen's batchDecision).
  SELECT p.proposal_version, COALESCE(jsonb_agg(jsonb_build_object('item_id', e->>'item_id', 'accept', e->>'kind' = 'ingredient'))
           FILTER (WHERE e->>'class' IN ('add', 'add_name_only', 'fill', 'confirm', 'rup_upgrade')), '[]'::jsonb)
    INTO v_ver, v_dec
    FROM public.epa_chemistry_proposals p, jsonb_array_elements(p.items) e WHERE p.id = v_prop[1] GROUP BY p.proposal_version;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_first := public.commit_epa_proposal_batch(v_prop[1], v_ver, v_dec, 'smoke-epa-batch-commit-' || v_tag);
  v_again := public.commit_epa_proposal_batch(v_prop[1], v_ver, v_dec, 'smoke-epa-batch-commit-' || v_tag);
  EXECUTE 'RESET ROLE';
  IF v_first->>'status' IS DISTINCT FROM 'committed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the batch save did not commit: %', v_first;
  END IF;
  IF v_again IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the same-key retry answered differently: % vs %', v_again, v_first;
  END IF;
  IF (SELECT count(*) FROM public.product_parent_ingredients WHERE parent_id = v_parent[1]) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: product A should have exactly one ingredient row';
  END IF;

  -- B: the ingredient declined too: refused, nothing written.
  SELECT p.proposal_version, COALESCE(jsonb_agg(jsonb_build_object('item_id', e->>'item_id', 'accept', false))
           FILTER (WHERE e->>'class' IN ('add', 'add_name_only', 'fill', 'confirm', 'rup_upgrade')), '[]'::jsonb)
    INTO v_ver, v_dec
    FROM public.epa_chemistry_proposals p, jsonb_array_elements(p.items) e WHERE p.id = v_prop[2] GROUP BY p.proposal_version;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.commit_epa_proposal_batch(v_prop[2], v_ver, v_dec, 'smoke-epa-batch-decline-' || v_tag);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  IF v_err IS NULL OR v_err NOT LIKE 'EPA_BATCH_DECISION_INVALID:%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: declining the ingredient was not refused EPA_BATCH_DECISION_INVALID: %', v_err;
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_parent_ingredients WHERE parent_id = v_parent[2])
     OR (SELECT status FROM public.epa_chemistry_proposals WHERE id = v_prop[2]) IS DISTINCT FROM 'proposed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the refused save wrote something or closed the proposal';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: EPA batch save chain passed';
END;
$$;
