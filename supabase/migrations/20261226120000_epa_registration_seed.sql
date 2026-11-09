-- idempotency-body-check: exempt
-- (seed_epa_registrations requires p_idempotency_key and checks it before any write with PAR-1's
--  _product_parent_replay(key, scope, fingerprint), which refuses a key reused for another request or
--  another actor, then saves its receipt with save_idempotency. The hook only recognises check_idempotency.)
-- Written 2026-11-08, cut down 2026-11-09. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261226120000_epa_registration_seed.md (REG-1 Step 2, file 3 of 3).
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2, the one-time seed (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md 5). Mason,
--   2026-11-09: "Drop them" (the product-master guards). So this file no longer adds guards on products or
--   brands, wraps no size function and keeps the products INSERT grants as they are: the seed only fills the
--   registration list, once, from today's numbers.
--
-- WHAT:
--   - preview_epa_registration_seed(p_rup_default) and seed_epa_registrations(p_picks, p_rup_default,
--     p_expected_fingerprint, p_idempotency_key), admin only. The seed creates one registration per EPA number
--     found on sizes, brands, parents, invoice lines and job lines, with the facts every carrier agrees on and
--     Mason's pick where they disagree, and records the seed run last. It refuses a stale preview, a missing
--     or unknown pick, an invalid number and a second run. It changes no size, brand or invoice line.
--
-- NOT CHANGED: products, brands, parents, PAR-1 functions, invoice and job lines, and every grant.
--
-- ROLLBACK (its own reviewed migration): drop the seed functions and _epa_registration_seed_plan; before the
--   seed nothing else to undo; after it, a reviewed migration removes the seed's registrations, events and run row.
--
-- ORDERING: after 20261226110000_rup_records_by_sold_number.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE epa_registration_seed_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.epa_registration_seed_tx') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_FILE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.epa_registration_seed_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_FILE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public.get_epa_sales_to_check()') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_FILE_PREFLIGHT: apply 20261226110000_rup_records_by_sold_number first';
  END IF;
  IF to_regprocedure('public.seed_epa_registrations(jsonb,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_FILE_PREFLIGHT: this file was already applied';
  END IF;
  IF EXISTS (SELECT 1 FROM public.epa_registrations) OR public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_FILE_PREFLIGHT: registrations exist before the seed';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Seed preview and seed (sheet 5)
-- ---------------------------------------------------------------------------------------------

-- The seed plan: one entry per EPA number, the facts every carrier agrees on, each disagreement with its
-- candidates, and the rows it read (so a change between preview and seed changes the fingerprint).
CREATE FUNCTION public._epa_registration_seed_plan(p_rup_default text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_regs jsonb;
  v_rows text;
BEGIN
  WITH carriers AS (
    SELECT public._normalize_epa_registration(p.epa_registration) AS n, 'products' AS t, p.id,
           p.signal_word AS sw, p.is_rup AS rup, p.rei_hours AS rei, p.phi_days AS phi,
           CASE WHEN p.max_label_rate IS NOT NULL OR p.max_label_rate_unit IS NOT NULL
                THEN jsonb_build_object('max_label_rate', p.max_label_rate, 'max_label_rate_unit', p.max_label_rate_unit) END AS mlr
      FROM public.products p
    UNION ALL
    SELECT public._normalize_epa_registration(b.epa_registration), 'product_brands', b.id, b.signal_word, b.is_rup, NULL, NULL, NULL
      FROM public.product_brands b
    UNION ALL
    SELECT public._normalize_epa_registration(b.epa_registration), 'product_parent_brands', b.id, b.signal_word, b.is_rup, NULL, NULL, NULL
      FROM public.product_parent_brands b
  ), numbers AS (
    SELECT n FROM carriers WHERE n IS NOT NULL
    UNION SELECT public._normalize_epa_registration(generic_epa_registration) FROM public.product_parents
    UNION SELECT public._normalize_epa_registration(epa_registration) FROM public.invoice_items
    UNION SELECT public._normalize_epa_registration(epa_registration) FROM public.job_product_epa
  ), per AS (
    SELECT nb.n,
           count(c.id) > 0 AS carried,
           COALESCE(bool_or(c.rup), false) AS any_rup,
           COALESCE(jsonb_agg(DISTINCT to_jsonb(c.sw)) FILTER (WHERE c.sw IS NOT NULL), '[]') AS sw,
           COALESCE(jsonb_agg(DISTINCT to_jsonb(c.rei)) FILTER (WHERE c.rei IS NOT NULL), '[]') AS rei,
           COALESCE(jsonb_agg(DISTINCT to_jsonb(c.phi)) FILTER (WHERE c.phi IS NOT NULL), '[]') AS phi,
           COALESCE(jsonb_agg(DISTINCT c.mlr) FILTER (WHERE c.mlr IS NOT NULL), '[]') AS mlr
      FROM numbers nb LEFT JOIN carriers c ON c.n = nb.n
     WHERE nb.n IS NOT NULL
     GROUP BY nb.n
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'epa_registration', n,
           'number_valid', n ~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$',
           'carried', carried,
           'facts', jsonb_strip_nulls(jsonb_build_object(
             'rup_status', CASE WHEN any_rup THEN 'yes' WHEN carried THEN p_rup_default ELSE 'unknown' END,
             'signal_word', CASE WHEN jsonb_array_length(sw) = 1 THEN sw->0 END,
             'rei_hours', CASE WHEN jsonb_array_length(rei) = 1 THEN rei->0 END,
             'phi_days', CASE WHEN jsonb_array_length(phi) = 1 THEN phi->0 END))
             || CASE WHEN jsonb_array_length(mlr) = 1 THEN jsonb_strip_nulls(mlr->0) ELSE '{}'::jsonb END,
           'disagreements', jsonb_strip_nulls(jsonb_build_object(
             'signal_word', CASE WHEN jsonb_array_length(sw) > 1 THEN sw END,
             'rei_hours', CASE WHEN jsonb_array_length(rei) > 1 THEN rei END,
             'phi_days', CASE WHEN jsonb_array_length(phi) > 1 THEN phi END,
             'max_label_rate', CASE WHEN jsonb_array_length(mlr) > 1 THEN mlr END)))
           ORDER BY n), '[]'::jsonb)
    INTO v_regs FROM per;

  -- Every row the seed reads or writes, so any edit between preview and seed is caught.
  SELECT md5(string_agg(x, E'\n' ORDER BY x)) INTO v_rows FROM (
    SELECT 'p' || jsonb_build_array(p.id, p.epa_registration, p.signal_word, p.is_rup, p.rei_hours, p.phi_days,
             p.max_label_rate, p.max_label_rate_unit)::text AS x FROM public.products p
    UNION ALL SELECT 'b' || jsonb_build_array(b.id, b.epa_registration, b.signal_word, b.is_rup, b.row_version)::text FROM public.product_brands b
    UNION ALL SELECT 'pb' || jsonb_build_array(b.id, b.epa_registration, b.signal_word, b.is_rup, b.row_version)::text FROM public.product_parent_brands b
    UNION ALL SELECT 'pp' || jsonb_build_array(pp.id, pp.generic_epa_registration)::text FROM public.product_parents pp
    UNION ALL SELECT 'm' || jsonb_build_array(m.product_id, m.parent_id)::text FROM public.product_parent_members m
    UNION ALL SELECT 'j' || jsonb_build_array(j.job_id, j.product_id, j.epa_registration)::text FROM public.job_product_epa j
    UNION ALL SELECT 'i' || jsonb_build_array(ii.id, ii.epa_registration)::text FROM public.invoice_items ii
  ) rows_read;

  RETURN jsonb_build_object('rup_default', p_rup_default, 'registrations', v_regs, 'rows_md5', COALESCE(v_rows, ''));
END;
$function$;
ALTER FUNCTION public._epa_registration_seed_plan(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._epa_registration_seed_plan(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.preview_epa_registration_seed(p_rup_default text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_plan jsonb;
BEGIN
  IF p_rup_default IS NULL OR p_rup_default NOT IN ('unknown', 'no') THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_DEFAULT: the restricted-use default is unknown or no';
  END IF;
  IF public._epa_registrations_seeded() OR EXISTS (SELECT 1 FROM public.epa_registrations) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_DONE: EPA registrations are already set up';
  END IF;
  v_plan := public._epa_registration_seed_plan(p_rup_default);
  RETURN v_plan || jsonb_build_object(
    'fingerprint', md5(v_plan::text),
    'registration_count', jsonb_array_length(v_plan->'registrations'),
    'disagreement_count', (SELECT count(*) FROM jsonb_array_elements(v_plan->'registrations') r
                            WHERE r->'disagreements' <> '{}'::jsonb),
    'invalid_numbers', (SELECT COALESCE(jsonb_agg(r->'epa_registration'), '[]') FROM jsonb_array_elements(v_plan->'registrations') r
                         WHERE NOT (r->>'number_valid')::boolean));
END;
$function$;
ALTER FUNCTION public.preview_epa_registration_seed(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_epa_registration_seed(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_epa_registration_seed(text) TO authenticated;

-- p_picks: {"<number>": {"signal_word": <one candidate>, "rei_hours": ..., "phi_days": ...,
--   "max_label_rate": {"max_label_rate": ..., "max_label_rate_unit": ...}}}, one entry per disagreement only.
CREATE FUNCTION public.seed_epa_registrations(p_picks jsonb, p_rup_default text, p_expected_fingerprint text,
  p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text;
  v_existing jsonb;
  v_plan jsonb;
  v_r jsonb;
  v_n text;
  v_facts jsonb;
  v_col text;
  v_cands jsonb;
  v_pick jsonb;
  v_reg public.epa_registrations;
  v_reg_count integer := 0;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  v_fp := md5(jsonb_build_array(p_picks, p_rup_default, p_expected_fingerprint)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'seed_epa_registrations', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_rup_default IS NULL OR p_rup_default NOT IN ('unknown', 'no') THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_DEFAULT: the restricted-use default is unknown or no';
  END IF;
  IF p_picks IS NULL OR jsonb_typeof(p_picks) <> 'object' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_PICKS: send the picks as an object ({} when there are none)';
  END IF;

  -- Nothing that writes a number or a label fact the plan reads runs beside the seed.
  PERFORM public._epa_registration_lock(true);
  LOCK TABLE public.products, public.product_brands, public.product_parent_brands, public.product_parents,
    public.product_parent_members, public.invoice_items, public.job_product_epa
    IN SHARE ROW EXCLUSIVE MODE;
  IF public._epa_registrations_seeded() OR EXISTS (SELECT 1 FROM public.epa_registrations) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_DONE: EPA registrations are already set up';
  END IF;

  v_plan := public._epa_registration_seed_plan(p_rup_default);
  IF md5(v_plan::text) IS DISTINCT FROM p_expected_fingerprint THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_STALE: products, brands or invoice line numbers changed since the preview; preview again';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'registrations') r WHERE NOT (r->>'number_valid')::boolean) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_INVALID_NUMBER: fix the EPA numbers the preview lists as invalid first';
  END IF;
  -- Every pick must answer a listed disagreement with one of its candidates, and every disagreement needs one.
  SELECT k INTO v_n FROM jsonb_object_keys(p_picks) k
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'registrations') r
                      WHERE r->>'epa_registration' = k AND r->'disagreements' <> '{}'::jsonb)
   LIMIT 1;
  IF v_n IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_PICK_UNEXPECTED: EPA number % has no disagreement to pick', v_n;
  END IF;

  FOR v_r IN SELECT r FROM jsonb_array_elements(v_plan->'registrations') r ORDER BY r->>'epa_registration' LOOP
    v_n := v_r->>'epa_registration';
    v_facts := v_r->'facts';
    FOR v_col, v_cands IN SELECT key, value FROM jsonb_each(v_r->'disagreements') LOOP
      v_pick := p_picks->v_n->v_col;
      IF v_pick IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_cands) c WHERE c = v_pick) THEN
        RAISE EXCEPTION 'EPA_REGISTRATION_SEED_PICK_REQUIRED: pick % for EPA number % from %', v_col, v_n, v_cands;
      END IF;
      v_facts := v_facts || CASE WHEN v_col = 'max_label_rate' THEN jsonb_strip_nulls(v_pick) ELSE jsonb_build_object(v_col, v_pick) END;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(p_picks->v_n, '{}')) k WHERE NOT (v_r->'disagreements') ? k) THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_SEED_PICK_UNEXPECTED: EPA number % has a pick for a column with no disagreement', v_n;
    END IF;
    PERFORM public._epa_registration_facts(v_facts, true);
    v_reg := public._epa_registration_insert(v_n, v_facts);
    PERFORM public._epa_registration_event(v_n, 'seeded', 'seed (restricted-use default ' || p_rup_default || ')',
      NULL, to_jsonb(v_reg), '[]'::jsonb);
    v_reg_count := v_reg_count + 1;
  END LOOP;

  -- Last: from here on the registration tools and posting by registration are live.
  INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
  VALUES (v_actor, p_rup_default, p_expected_fingerprint);

  v_result := jsonb_build_object('registrations', v_reg_count,
    'rup_default', p_rup_default, 'fingerprint', p_expected_fingerprint);
  PERFORM public.save_idempotency(p_idempotency_key, 'seed_epa_registrations',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.seed_epa_registrations(jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.seed_epa_registrations(jsonb, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seed_epa_registrations(jsonb, text, text, text) TO authenticated;

DO $postflight$
BEGIN
  IF has_function_privilege('authenticated', 'public._epa_registration_seed_plan(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.seed_epa_registrations(jsonb,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_epa_registration_seed(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.seed_epa_registrations(jsonb,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_epa_registration_seed(text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                 AND p.proname LIKE '\_epa\_registration%'
                 AND (p.proowner <> 'postgres'::regrole
                      OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      OR has_function_privilege('anon', p.oid, 'EXECUTE')))
     OR EXISTS (SELECT 1 FROM public.epa_registrations) THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_REGISTRATION_SEED_FILE_WRONG';
  END IF;
END;
$postflight$;
