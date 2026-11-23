-- KI-103: a bulk product import row with an unknown top-level field previewed "ready", then the save refused the whole
-- file (apply_product_setup accepts only insert, rates and expected_prices). preview_product_import now refuses such a
-- file up front with PRODUCT_SETUP_ROW_SHAPE_INVALID naming the field. The screen never sends extra fields, so its
-- behavior is unchanged. Same signature and grants; the body is the 20261107130000 body (md5-pinned below) plus one
-- check (and refuses "expected_prices" without "rates", which the save also refuses). No data changes.
--
-- Rollback: a NEW forward migration restoring the 20261107130000 body (never re-run or edit this file), with its own
-- ledger record and the preview_product_import allowlist entry re-keyed back.

SET LOCAL lock_timeout = '10s';

DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  CREATE TEMP TABLE ki103_preview_tx (x int) ON COMMIT DROP;
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.preview_product_import(jsonb)');
  IF v_md5 IS DISTINCT FROM '01217783ad5b73151cb1c10bd405dbb4' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: preview_product_import changed since 2026-11-22 (md5 %); re-read it before applying', v_md5;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'preview_product_import') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected exactly one preview_product_import';
  END IF;
END
$preflight$;

DO $tx$
BEGIN
  IF to_regclass('pg_temp.ki103_preview_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 / the apply script)';
  END IF;
END
$tx$;

CREATE OR REPLACE FUNCTION public.preview_product_import(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_row jsonb;
  v_n bigint;
  v_f jsonb;
  v_saved jsonb;
  v_prices jsonb;
  v_after jsonb;
  v_error text;
  v_in_file_dupe boolean;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0
     OR jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'PRODUCT_IMPORT_ROWS_REQUIRED: send 1 to 500 rows';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r
             WHERE jsonb_typeof(r) <> 'object' OR jsonb_typeof(r->'insert') IS DISTINCT FROM 'object'
                OR (r ? 'rates' AND jsonb_typeof(r->'rates') <> 'object')) THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_ROW_SHAPE_INVALID: each row needs an "insert" object of setup fields';
  END IF;
  -- KI-103: the save (apply_product_setup) refuses any other top-level key on a row, so the preview refuses it
  -- too instead of showing "ready". Rows are objects here (checked just above).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r, jsonb_object_keys(r) k
             WHERE k NOT IN ('insert', 'rates', 'expected_prices')) THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_ROW_SHAPE_INVALID: a row has a field the save does not accept: %',
      (SELECT string_agg(DISTINCT k, ', ' ORDER BY k) FROM jsonb_array_elements(p_rows) r, jsonb_object_keys(r) k
        WHERE k NOT IN ('insert', 'rates', 'expected_prices'));
  END IF;
  -- The save also refuses "expected_prices" without "rates" (the preview computes those prices from the rates).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE r ? 'expected_prices' AND NOT r ? 'rates') THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_ROW_SHAPE_INVALID: a row has "expected_prices" without "rates"; the save refuses it';
  END IF;

  FOR v_row, v_n IN SELECT r, n FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, n) LOOP
    v_f := v_row->'insert';
    v_error := NULL;
    v_saved := NULL;
    v_prices := NULL;
    v_in_file_dupe := (SELECT count(*) > 1 FROM jsonb_array_elements(p_rows) o
                       WHERE lower(btrim(o->'insert'->>'product_name')) = lower(btrim(v_f->>'product_name'))
                          OR (NULLIF(btrim(v_f->>'sku'), '') IS NOT NULL
                              AND lower(btrim(o->'insert'->>'sku')) = lower(btrim(v_f->>'sku'))));
    -- The save refuses the whole file for a repeat, so the preview refuses each repeated row too.
    IF v_in_file_dupe THEN
      v_error := 'PRODUCT_SETUP_DUPLICATE: the same SKU or name appears twice in this file: ' || btrim(v_f->>'product_name');
    END IF;
    -- PL/pgSQL variables keep their values when a subtransaction rolls back; the rows do not.
    IF v_error IS NULL THEN
    BEGIN
      v_saved := public.apply_product_setup(jsonb_build_array(jsonb_build_object('insert', v_f)), v_actor,
        'preview:' || gen_random_uuid());
      IF v_row ? 'rates' THEN
        IF NOT public._product_rate_value_ok(v_row->'rates'->'rate_per_acre') THEN
          RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate per acre must be blank or a number of 0 or more with at most 6 decimals';
        END IF;
        v_prices := public.preview_product_rate_correction((v_saved->'rows'->0->>'product_id')::uuid,
          public._product_rate_value(v_row->'rates'->'rate_per_acre'), v_row->'rates'->>'rate_unit')->'after';
      END IF;
      RAISE EXCEPTION 'PREVIEW_ROLLBACK' USING ERRCODE = 'CRXPV';
    EXCEPTION
      WHEN SQLSTATE 'CRXPV' THEN NULL;
      WHEN OTHERS THEN v_error := SQLERRM;
    END;
    END IF;
    -- Then the exact save the import makes, with the prices just previewed, so a refusal shows here first.
    IF v_error IS NULL AND v_row ? 'rates' THEN
      BEGIN
        v_saved := public.apply_product_setup(jsonb_build_array(jsonb_build_object('insert', v_f,
          'rates', v_row->'rates', 'expected_prices', v_prices)), v_actor, 'preview:' || gen_random_uuid());
        RAISE EXCEPTION 'PREVIEW_ROLLBACK' USING ERRCODE = 'CRXPV';
      EXCEPTION
        WHEN SQLSTATE 'CRXPV' THEN NULL;
        WHEN OTHERS THEN v_error := SQLERRM;
      END;
    END IF;
    v_after := v_saved->'rows'->0;
    v_results := v_results || jsonb_build_object(
      'row', v_n, 'product_name', v_f->>'product_name',
      'status', CASE WHEN v_error IS NULL THEN 'ok' ELSE 'refused' END,
      'error', v_error,
      'after', CASE WHEN v_error IS NULL THEN v_after - 'product_id' END,
      'expected_prices', CASE WHEN v_error IS NULL THEN v_prices END,
      'sku_matches', (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_name', p.product_name, 'is_active', p.is_active)), '[]')
                        FROM public.products p WHERE NULLIF(btrim(v_f->>'sku'), '') IS NOT NULL
                         AND lower(btrim(p.sku)) = lower(btrim(v_f->>'sku'))),
      'name_matches', (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_name', p.product_name, 'is_active', p.is_active)), '[]')
                         FROM public.products p WHERE p.is_active
                          AND lower(btrim(p.product_name)) = lower(btrim(v_f->>'product_name'))),
      'epa_matches', (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_name', p.product_name, 'is_active', p.is_active)), '[]')
                        FROM public.products p WHERE NULLIF(btrim(v_f->>'epa_registration'), '') IS NOT NULL
                         AND btrim(p.epa_registration) = btrim(v_f->>'epa_registration')
                         AND lower(btrim(p.product_name)) <> lower(btrim(v_f->>'product_name'))),
      'in_file_duplicate', v_in_file_dupe);
  END LOOP;
  RETURN jsonb_build_object(
    'rates_locked', COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true),
    'rows', v_results);
END;
$function$;

ALTER FUNCTION public.preview_product_import(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_product_import(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_import(jsonb) TO authenticated;

DO $postflight$
DECLARE
  v_oid oid := to_regprocedure('public.preview_product_import(jsonb)');
BEGIN
  IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND p.prosecdef
       AND pg_get_userbyid(p.proowner) = 'postgres' AND p.proconfig = ARRAY['search_path=public, pg_temp']
       AND p.prosrc LIKE '%KI-103%') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: security definer, owner, search_path or body is wrong';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: grants are wrong';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
