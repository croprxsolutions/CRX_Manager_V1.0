-- WP-PM-10: bulk product import saves through the setup workbook's save (WP-PM-11a-2) in insert mode,
-- so new products have one setup write path, and rates go through set_product_rates (WP-PM-11a-1) only.
--
-- Changed:
--   * apply_product_setup(rows, performed_by, key) keeps its signature and grants. 11a-2's body is
--     renamed _apply_product_setup_update (unchanged, no longer callable by any API role) and the new
--     apply_product_setup sends Setup-tab rows to it untouched. A request whose rows carry "insert"
--     is insert mode instead: admin, retry key (same scope, so one key cannot serve both modes),
--     all-or-nothing. Each row inserts one product from the setup fields below; the products triggers
--     check every value as they do for the product page (category, units, form, container type, EPA
--     format, signal word, use timings). A row with "rates" then gets them from one set_product_rates
--     call in the same transaction, with the per-acre prices its preview showed ("expected_prices"):
--     the Lock rates switch, the unit rules and the "prices moved since the preview" refusal all apply.
--     Rate columns are never written by the insert. A refusal names the product.
--   * Duplicates are refused: a SKU any product already has (case and spaces ignored), a name an active
--     product already has, or the same SKU or name twice in one file. The same EPA number under another
--     name is an allowed variant (the same chemical in another size). Inserts take a transaction
--     advisory lock, so two imports cannot both add the same name. Only spaces at either end and case
--     are ignored. The product page and Setup-tab renames do not take this lock, so an active name
--     they save at the same moment can still repeat; a SKU cannot (next point).
--   * New unique index products_sku_unique on lower(btrim(sku)) for non-blank SKUs: no two products,
--     active or not, share a SKU from any screen. Live had no duplicate SKU on 2026-11-05 (3 blank
--     SKUs, which the index ignores); the preflight refuses the apply if one appeared since.
--   * A row's vendor text links a vendor as the product page's insert does (link_new_product_vendor).
--   * The screen previews at most 500 rows (preview_product_import's cap), so an import is 500 rows.
-- New:
--   * preview_product_import(rows): admin. For each row, runs the real insert-mode save (and, with
--     rates, set_product_rates) inside a subtransaction that is always rolled back, and reports the
--     refusal or the resulting rate and tier 1-3 per-acre prices, plus duplicate and same-EPA matches.
--     Nothing it does is kept.
-- No existing row is changed; the one new index is products_sku_unique. Grants: EXECUTE on apply_product_setup (unchanged) and
-- preview_product_import to authenticated; the renamed body has no API-role grant.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.apply_product_setup(jsonb,uuid,text)') IS NULL
     OR to_regprocedure('public._apply_product_setup_update(jsonb,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.preview_product_import(jsonb)') IS NOT NULL
     OR to_regprocedure('public.set_product_rates(jsonb,uuid,text)') IS NULL
     OR to_regprocedure('public.preview_product_rate_correction(uuid,numeric,text)') IS NULL
     OR to_regprocedure('public._product_rate_value_ok(jsonb)') IS NULL
     OR to_regprocedure('public._product_rate_value(jsonb)') IS NULL
     OR to_regprocedure('public.normalize_rate_unit(text)') IS NULL
     OR to_regprocedure('public.check_idempotency(text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_IMPORT_DEPENDENCY_MISSING';
  END IF;
  IF to_regclass('public.products_sku_unique') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_SKU_INDEX_EXISTS';
  END IF;
  IF EXISTS (SELECT 1 FROM public.products WHERE NULLIF(btrim(sku), '') IS NOT NULL
             GROUP BY lower(btrim(sku)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_DUPLICATE_SKU: two products share a SKU; fix it before applying';
  END IF;
END;
$preflight$;

-- No two products share a SKU, from any screen (the import's duplicate check alone covers only imports).
CREATE UNIQUE INDEX products_sku_unique ON public.products (lower(btrim(sku)))
  WHERE NULLIF(btrim(sku), '') IS NOT NULL;

ALTER FUNCTION public.apply_product_setup(jsonb, uuid, text) RENAME TO _apply_product_setup_update;
REVOKE ALL ON FUNCTION public._apply_product_setup_update(jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.apply_product_setup(
  p_rows jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  c_text text[] := ARRAY['product_name', 'sku', 'category', 'vendor', 'manufacturer', 'product_form',
    'inventory_unit', 'unit_size', 'container_unit', 'container_type', 'epa_registration', 'signal_word',
    'max_label_rate_unit', 'use_timing', 'notes'];
  c_fields text[] := c_text || ARRAY['container_size', 'max_label_rate', 'rei_hours', 'phi_days', 'is_rup'];
  c_tiers text[] := ARRAY['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'];
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_row jsonb;
  v_f jsonb;
  v_invalid text[] := ARRAY[]::text[];
  v_bad_unit text[] := ARRAY[]::text[];
  v_dupes text[];
  v_product public.products%ROWTYPE;
  v_rate_rows jsonb := '[]'::jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_results jsonb;
  v_result jsonb;
BEGIN
  -- Setup-tab rows (no "insert") keep 11a-2's save exactly, including its own retry key handling.
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r
                    WHERE jsonb_typeof(r) = 'object' AND r ? 'insert') THEN
    RETURN public._apply_product_setup_update(p_rows, p_performed_by, p_idempotency_key);
  END IF;

  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_ROWS_REQUIRED: send 1 to 2000 rows';
  END IF;

  -- One import at a time, taken before the receipt lookup: an identical retry that waited here
  -- then finds the first one's receipt instead of tripping over its products as duplicates.
  PERFORM pg_advisory_xact_lock(hashtext('crx.product_setup_insert'));
  v_request_fp := md5(jsonb_build_object('actor_id', v_actor, 'rows', p_rows)::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'apply_product_setup');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- CASE, so key and array expansion never see a non-object (OR does not fix evaluation order).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) r
    WHERE CASE WHEN jsonb_typeof(r) <> 'object' OR jsonb_typeof(r->'insert') IS DISTINCT FROM 'object' THEN true
      ELSE EXISTS (SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN ('insert', 'rates', 'expected_prices'))
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(r->'insert') k WHERE k <> ALL(c_fields))
        OR (r ? 'rates') IS DISTINCT FROM (r ? 'expected_prices')
        OR (r ? 'rates' AND CASE WHEN jsonb_typeof(r->'rates') <> 'object' OR jsonb_typeof(r->'expected_prices') <> 'object' THEN true
              ELSE NOT (r->'rates' ? 'rate_per_acre' AND r->'rates' ? 'rate_unit' AND r->'rates' ? 'suggested_rate')
                OR EXISTS (SELECT 1 FROM jsonb_object_keys(r->'rates') k WHERE k NOT IN ('rate_per_acre', 'rate_unit', 'suggested_rate'))
                OR EXISTS (SELECT 1 FROM unnest(c_tiers) t WHERE NOT (r->'expected_prices' ? t)) END)
      END
  ) THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_ROW_SHAPE_INVALID: insert rows need an "insert" object of setup fields, and "rates" only with the "expected_prices" its preview showed';
  END IF;

  FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) r LOOP
    v_f := v_row->'insert';
    IF jsonb_typeof(v_f->'product_name') IS DISTINCT FROM 'string' OR btrim(v_f->>'product_name') = ''
       OR EXISTS (SELECT 1 FROM jsonb_each(v_f) c
                  WHERE (c.key = ANY(c_text) AND jsonb_typeof(c.value) NOT IN ('string', 'null'))
                     OR (c.key = ANY(c_text) AND length(c.value #>> '{}') > 5000)
                     OR (c.key = 'is_rup' AND jsonb_typeof(c.value) <> 'boolean')
                     OR (c.key IN ('rei_hours', 'phi_days') AND jsonb_typeof(c.value) <> 'null'
                         AND (jsonb_typeof(c.value) <> 'number' OR (c.value #>> '{}') !~ '^[0-9]{1,9}$'))
                     OR (c.key IN ('container_size', 'max_label_rate') AND jsonb_typeof(c.value) <> 'null'
                         AND (jsonb_typeof(c.value) NOT IN ('number', 'string')
                              OR btrim(c.value #>> '{}') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'))
                     OR (c.key = 'container_size' AND jsonb_typeof(c.value) <> 'null'
                         AND CASE WHEN btrim(c.value #>> '{}') ~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'
                                  THEN btrim(c.value #>> '{}')::numeric <= 0 ELSE true END))
       OR (v_row ? 'rates' AND (jsonb_typeof(v_row->'rates'->'rate_unit') NOT IN ('string', 'null')
                                OR jsonb_typeof(v_row->'rates'->'suggested_rate') NOT IN ('string', 'null')
                                OR length(v_row->'rates'->>'rate_unit') > 40
                                OR length(v_row->'rates'->>'suggested_rate') > 200
                                OR NOT public._product_rate_value_ok(v_row->'rates'->'rate_per_acre')
                                OR EXISTS (SELECT 1 FROM unnest(c_tiers) t
                                           WHERE jsonb_typeof(v_row->'expected_prices'->t) NOT IN ('number', 'null')))) THEN
      v_invalid := v_invalid || COALESCE(NULLIF(btrim(v_f->>'product_name'), ''), '(no name)');
    -- Same rule as the Setup tab's save: a label maximum the field screens cannot compare would hide an over-label application.
    ELSIF NULLIF(btrim(v_f->>'max_label_rate'), '') IS NOT NULL
          AND COALESCE(public.normalize_rate_unit(v_f->>'max_label_rate_unit'), '')
              NOT IN ('oz', 'pt', 'qt', 'gal', 'lb', 'ton', 'g', 'kg', 'l', 'ml') THEN
      v_bad_unit := v_bad_unit || btrim(v_f->>'product_name');
    END IF;
  END LOOP;
  IF cardinality(v_invalid) > 0 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_INVALID: a value has the wrong type (name required; yes/no, whole number, decimal, a container size above 0, or a rate of 0 or more with at most 6 decimals): %',
      array_to_string(v_invalid[1:20], ', ');
  END IF;
  IF cardinality(v_bad_unit) > 0 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_INVALID: a maximum label rate needs a unit of oz, pt, qt, gal, lb, ton, g, kg, l or ml (per acre): %',
      array_to_string(v_bad_unit[1:20], ', ');
  END IF;

  -- The advisory lock above keeps this duplicate check true until the inserts commit.
  SELECT array_agg(DISTINCT n) INTO v_dupes FROM (
    SELECT btrim(r->'insert'->>'product_name') AS n
      FROM jsonb_array_elements(p_rows) r
     WHERE NULLIF(btrim(r->'insert'->>'sku'), '') IS NOT NULL
       AND (EXISTS (SELECT 1 FROM public.products p WHERE lower(btrim(p.sku)) = lower(btrim(r->'insert'->>'sku')))
            OR (SELECT count(*) FROM jsonb_array_elements(p_rows) o
                 WHERE lower(btrim(o->'insert'->>'sku')) = lower(btrim(r->'insert'->>'sku'))) > 1)
    UNION ALL
    SELECT btrim(r->'insert'->>'product_name')
      FROM jsonb_array_elements(p_rows) r
     WHERE EXISTS (SELECT 1 FROM public.products p
                    WHERE p.is_active AND lower(btrim(p.product_name)) = lower(btrim(r->'insert'->>'product_name')))
        OR (SELECT count(*) FROM jsonb_array_elements(p_rows) o
             WHERE lower(btrim(o->'insert'->>'product_name')) = lower(btrim(r->'insert'->>'product_name'))) > 1
  ) d;
  IF cardinality(v_dupes) > 0 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_DUPLICATE: the SKU or name is already used by a product or twice in this file: %',
      array_to_string(v_dupes[1:20], ', ');
  END IF;

  BEGIN
    FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) r LOOP
      v_f := v_row->'insert';
      INSERT INTO public.products (product_name, sku, category, vendor, manufacturer, product_form,
        inventory_unit, unit_size, container_unit, container_type, epa_registration, signal_word,
        max_label_rate_unit, use_timing, notes, container_size, max_label_rate, rei_hours, phi_days, is_rup)
      VALUES (btrim(v_f->>'product_name'), NULLIF(btrim(v_f->>'sku'), ''), NULLIF(btrim(v_f->>'category'), ''),
        NULLIF(btrim(v_f->>'vendor'), ''), NULLIF(btrim(v_f->>'manufacturer'), ''),
        NULLIF(btrim(v_f->>'product_form'), ''), NULLIF(btrim(v_f->>'inventory_unit'), ''),
        NULLIF(btrim(v_f->>'unit_size'), ''), NULLIF(btrim(v_f->>'container_unit'), ''),
        NULLIF(btrim(v_f->>'container_type'), ''), NULLIF(btrim(v_f->>'epa_registration'), ''),
        NULLIF(btrim(v_f->>'signal_word'), ''), NULLIF(btrim(v_f->>'max_label_rate_unit'), ''),
        NULLIF(btrim(v_f->>'use_timing'), ''),
        -- A note keeps its own spacing and line breaks; only a blank one is empty.
        CASE WHEN btrim(v_f->>'notes') <> '' THEN v_f->>'notes' END,
        NULLIF(btrim(v_f->>'container_size'), '')::numeric, NULLIF(btrim(v_f->>'max_label_rate'), '')::numeric,
        (v_f->>'rei_hours')::integer, (v_f->>'phi_days')::integer, COALESCE((v_f->>'is_rup')::boolean, false))
      RETURNING * INTO v_product;
      v_ids := v_ids || v_product.id;
      IF v_row ? 'rates' THEN
        -- Expected = the row as just inserted; prices = what the preview showed.
        v_rate_rows := v_rate_rows || jsonb_build_object('product_id', v_product.id,
          'rate_per_acre', v_row->'rates'->'rate_per_acre', 'rate_unit', v_row->'rates'->'rate_unit',
          'suggested_rate', v_row->'rates'->'suggested_rate',
          'expected', jsonb_build_object('rate_per_acre', v_product.rate_per_acre::text,
            'rate_unit', v_product.rate_unit, 'suggested_rate', v_product.suggested_rate,
            'pricing_version', v_product.pricing_version, 'unit_size', v_product.unit_size,
            'inventory_unit', v_product.inventory_unit, 'product_form', v_product.product_form,
            'prices', v_row->'expected_prices'));
      END IF;
    END LOOP;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'PRODUCT_SETUP_DUPLICATE: the SKU or name is already used by a product or twice in this file: %',
        btrim(v_f->>'product_name') USING ERRCODE = SQLSTATE;
    WHEN OTHERS THEN
    -- Name the product the table's own checks refused; nothing is saved.
    RAISE EXCEPTION 'PRODUCT_SETUP_ROW_REFUSED: %: %', btrim(v_f->>'product_name'), SQLERRM USING ERRCODE = SQLSTATE;
  END;

  -- Its refusals (locked, unit, prices moved) already name the products; the whole import rolls back.
  IF jsonb_array_length(v_rate_rows) > 0 THEN
    PERFORM public.set_product_rates(v_rate_rows, v_actor, p_idempotency_key || ':rates');
  END IF;

  SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'product_name', p.product_name,
           'rate_per_acre', p.rate_per_acre::text, 'rate_unit', p.rate_unit, 'suggested_rate', p.suggested_rate,
           'tier1_price_per_acre', p.tier1_price_per_acre, 'tier2_price_per_acre', p.tier2_price_per_acre,
           'tier3_price_per_acre', p.tier3_price_per_acre) ORDER BY o.n)
    INTO v_results
    FROM unnest(v_ids) WITH ORDINALITY AS o(id, n) JOIN public.products p ON p.id = o.id;
  v_result := jsonb_build_object('inserted_count', cardinality(v_ids), 'rows', v_results);
  PERFORM public.save_idempotency(p_idempotency_key, 'apply_product_setup',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.apply_product_setup(jsonb, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_product_setup(jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_setup(jsonb, uuid, text) TO authenticated;

-- Read-only in effect: every row's save runs in a subtransaction that is always rolled back.
CREATE FUNCTION public.preview_product_import(p_rows jsonb) RETURNS jsonb
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
BEGIN
  IF to_regclass('public.products_sku_unique') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_SKU_INDEX_MISSING';
  END IF;
  IF has_function_privilege('anon', 'public.apply_product_setup(jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_product_import(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._apply_product_setup_update(jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._apply_product_setup_update(jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._apply_product_setup_update(jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.apply_product_setup(jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_product_import(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_IMPORT_GRANTS_WRONG';
  END IF;
END;
$postflight$;
