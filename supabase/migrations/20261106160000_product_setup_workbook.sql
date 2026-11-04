-- WP-PM-11a-2: the setup workbook (Setup and Rates tabs), separate from the price workbook.
--
-- New, all admin-only:
--   * get_product_setup_workbook(): every product's setup fields, rates and current per-acre prices,
--     with a per-row setup fingerprint, plus whether rates are locked. The download is built from it.
--   * preview_product_rates(rows): read-only. For each Rates-tab row (the same shape set_product_rates
--     takes, without the previewed prices) it says unchanged / change / stale / invalid, with the rate
--     and tier 1-3 per-acre prices before and after. The after prices come from
--     preview_product_rate_correction, the same math the save checks against. Saving goes through
--     WP-PM-11a-1's set_product_rates only, so the "Lock rates" switch, stale-row and previewed-price
--     checks all apply there.
--   * apply_product_setup(rows): the Setup tab's save. All-or-nothing, admin, retry key. Each row
--     carries the setup fingerprint from the download; a row changed since is refused by product name.
--     It writes only the setup fields below. Never prices, cost, rates, vendor (WP-PM-15b refuses a
--     direct vendor edit), active status (WP-PM-3's deactivation), or form, stock unit, pack size and
--     container unit (already guarded on saved products). The existing products triggers still check
--     every value (category, EPA format, name, SKU, REI, PHI, use timings, container type, signal word)
--     and the change-history trigger records each change. A refusal names the product.
-- Insert mode (new products) is WP-PM-10's, added to apply_product_setup so there is one setup write path.
-- No existing row is changed. Grants: EXECUTE on the three public functions to authenticated.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_product_setup_workbook()') IS NOT NULL
     OR to_regprocedure('public.preview_product_rates(jsonb)') IS NOT NULL
     OR to_regprocedure('public.apply_product_setup(jsonb,uuid,text)') IS NOT NULL
     OR to_regprocedure('public._product_setup_fingerprint(public.products)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_SETUP_WORKBOOK_ALREADY_EXISTS';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.check_idempotency(text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public.set_product_rates(jsonb,uuid,text)') IS NULL
     OR to_regprocedure('public.preview_product_rate_correction(uuid,numeric,text)') IS NULL
     OR to_regprocedure('public._product_rate_value_ok(jsonb)') IS NULL
     OR to_regprocedure('public._product_rate_value(jsonb)') IS NULL
     OR to_regprocedure('public._product_rate_unit_ok(numeric,text,text,text,text)') IS NULL
     OR to_regclass('public.product_rate_lock') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_SETUP_WORKBOOK_DEPENDENCY_MISSING';
  END IF;
END;
$preflight$;

-- The setup fields a download shows and the Setup tab may change. A change to any of them since the
-- download makes that row stale.
CREATE FUNCTION public._product_setup_fingerprint(p public.products) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT md5(jsonb_build_object(
    'product_name', p.product_name, 'sku', p.sku, 'category', p.category,
    'manufacturer', p.manufacturer, 'container_size', p.container_size,
    'container_type', p.container_type, 'epa_registration', p.epa_registration,
    'is_rup', p.is_rup, 'signal_word', p.signal_word, 'rei_hours', p.rei_hours,
    'phi_days', p.phi_days, 'max_label_rate', p.max_label_rate,
    'max_label_rate_unit', p.max_label_rate_unit, 'use_timings', to_jsonb(p.use_timings),
    'notes', p.notes, 'internal_notes', p.internal_notes, 'quoting_notes', p.quoting_notes)::text);
$function$;
ALTER FUNCTION public._product_setup_fingerprint(public.products) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_setup_fingerprint(public.products) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_product_setup_workbook() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  RETURN jsonb_build_object(
    'rates_locked', COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'product_id', p.id, 'product_name', p.product_name, 'sku', p.sku, 'is_active', p.is_active,
        'category', p.category, 'manufacturer', p.manufacturer, 'product_form', p.product_form,
        'inventory_unit', p.inventory_unit, 'unit_size', p.unit_size,
        'container_unit', p.container_unit, 'container_size', p.container_size::text,
        'container_type', p.container_type, 'epa_registration', p.epa_registration,
        'is_rup', p.is_rup, 'signal_word', p.signal_word, 'rei_hours', p.rei_hours,
        'phi_days', p.phi_days, 'max_label_rate', p.max_label_rate::text,
        'max_label_rate_unit', p.max_label_rate_unit, 'use_timings', to_jsonb(p.use_timings),
        'notes', p.notes, 'internal_notes', p.internal_notes, 'quoting_notes', p.quoting_notes,
        'setup_fingerprint', public._product_setup_fingerprint(p),
        -- Rates as exact text, so the file carries the stored value, not a float.
        'rate_per_acre', p.rate_per_acre::text, 'rate_unit', p.rate_unit,
        'suggested_rate', p.suggested_rate, 'pricing_version', p.pricing_version,
        'tier1_price_per_acre', p.tier1_price_per_acre, 'tier2_price_per_acre', p.tier2_price_per_acre,
        'tier3_price_per_acre', p.tier3_price_per_acre)
        ORDER BY lower(p.product_name), p.id)
      FROM public.products p), '[]'::jsonb));
END;
$function$;
ALTER FUNCTION public.get_product_setup_workbook() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_product_setup_workbook() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_setup_workbook() TO authenticated;

-- Read-only. Same checks, in the same order, as set_product_rates, but reported per row instead of
-- raised, so the preview names every problem at once.
CREATE FUNCTION public.preview_product_rates(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_row jsonb;
  v_product public.products%ROWTYPE;
  v_rate numeric;
  v_unit text;
  v_suggested text;
  v_status text;
  v_prices jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0
     OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_ROWS_REQUIRED: send 1 to 2000 rows';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) r
    WHERE jsonb_typeof(r) <> 'object'
       OR NOT (r ? 'product_id' AND r ? 'rate_per_acre' AND r ? 'rate_unit' AND r ? 'suggested_rate'
               AND r ? 'expected')
       OR jsonb_typeof(r->'expected') <> 'object'
       OR NOT (r->'expected' ? 'rate_per_acre' AND r->'expected' ? 'rate_unit'
               AND r->'expected' ? 'suggested_rate' AND r->'expected' ? 'pricing_version'
               AND r->'expected' ? 'unit_size' AND r->'expected' ? 'inventory_unit'
               AND r->'expected' ? 'product_form')
       OR jsonb_typeof(r->'expected'->'pricing_version') <> 'number'
       OR (r->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(r->'rate_unit') NOT IN ('string', 'null')
       OR jsonb_typeof(r->'suggested_rate') NOT IN ('string', 'null')
       OR length(r->>'rate_unit') > 40 OR length(r->>'suggested_rate') > 200
       OR NOT public._product_rate_value_ok(r->'expected'->'rate_per_acre')
  ) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_ROW_SHAPE_INVALID: each row needs product_id, rate_per_acre, rate_unit, suggested_rate and expected';
  END IF;
  IF (SELECT count(DISTINCT lower(r->>'product_id')) FROM jsonb_array_elements(p_rows) r)
     <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_DUPLICATE_PRODUCT: each product may appear once';
  END IF;

  FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) r LOOP
    SELECT * INTO v_product FROM public.products WHERE id = (v_row->>'product_id')::uuid;
    v_prices := NULL;
    IF NOT FOUND THEN
      v_results := v_results || jsonb_build_object('product_id', v_row->>'product_id', 'status', 'not_found');
      CONTINUE;
    END IF;
    v_unit := NULLIF(btrim(v_row->>'rate_unit'), '');
    v_suggested := NULLIF(btrim(v_row->>'suggested_rate'), '');
    IF NOT public._product_rate_value_ok(v_row->'rate_per_acre') THEN
      v_status := 'invalid_rate';
    ELSE
      v_rate := public._product_rate_value(v_row->'rate_per_acre');
      IF NOT public._product_rate_unit_ok(v_rate, v_unit, v_product.rate_unit, v_product.product_form,
                                          COALESCE(NULLIF(v_product.inventory_unit, ''), v_product.unit_size))
         -- validate_product_units refuses a seed or each rate unit other than the stock unit (unnamed);
         -- set_product_rates' own check lets an 'Ea'/'Unit' through, so name it here instead.
         OR (v_product.product_form IN ('seed', 'each') AND v_unit IS NOT NULL
             AND lower(v_unit) IS DISTINCT FROM lower(btrim(v_product.inventory_unit))) THEN
        v_status := 'invalid_unit';
      ELSIF public._product_rate_value(v_row->'expected'->'rate_per_acre') IS DISTINCT FROM v_product.rate_per_acre
         OR NULLIF(v_row->'expected'->>'rate_unit', '') IS DISTINCT FROM NULLIF(v_product.rate_unit, '')
         OR NULLIF(btrim(v_row->'expected'->>'suggested_rate'), '') IS DISTINCT FROM NULLIF(btrim(v_product.suggested_rate), '')
         OR (v_row->'expected'->>'pricing_version')::numeric IS DISTINCT FROM v_product.pricing_version
         OR (v_row->'expected'->>'unit_size') IS DISTINCT FROM v_product.unit_size
         OR (v_row->'expected'->>'inventory_unit') IS DISTINCT FROM v_product.inventory_unit
         OR (v_row->'expected'->>'product_form') IS DISTINCT FROM v_product.product_form THEN
        v_status := 'stale';
      ELSIF v_rate IS DISTINCT FROM v_product.rate_per_acre
         OR COALESCE(v_unit, CASE WHEN v_product.product_form IN ('seed', 'each') THEN v_product.inventory_unit END)
            IS DISTINCT FROM NULLIF(v_product.rate_unit, '')
         OR v_suggested IS DISTINCT FROM NULLIF(btrim(v_product.suggested_rate), '') THEN
        v_status := 'change';
        v_prices := public.preview_product_rate_correction(v_product.id, v_rate, v_unit)->'after';
      ELSE
        v_status := 'unchanged';
      END IF;
    END IF;
    v_results := v_results || jsonb_build_object(
      'product_id', v_product.id, 'product_name', v_product.product_name, 'status', v_status,
      'before', jsonb_build_object('rate_per_acre', v_product.rate_per_acre::text,
        'rate_unit', v_product.rate_unit, 'suggested_rate', v_product.suggested_rate,
        'tier1_price_per_acre', v_product.tier1_price_per_acre,
        'tier2_price_per_acre', v_product.tier2_price_per_acre,
        'tier3_price_per_acre', v_product.tier3_price_per_acre),
      'after', CASE WHEN v_status = 'change' THEN jsonb_build_object(
        'rate_per_acre', v_rate::text,
        -- What will be stored: a seed or each product keeps its stock unit.
        'rate_unit', CASE WHEN v_product.product_form IN ('seed', 'each') THEN v_product.inventory_unit ELSE v_unit END,
        'suggested_rate', v_suggested) || v_prices END);
  END LOOP;
  RETURN jsonb_build_object(
    'rates_locked', COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true),
    'rows', v_results);
END;
$function$;
ALTER FUNCTION public.preview_product_rates(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_product_rates(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_rates(jsonb) TO authenticated;

CREATE FUNCTION public.apply_product_setup(
  p_rows jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  c_text text[] := ARRAY['product_name', 'sku', 'category', 'manufacturer', 'container_type',
    'epa_registration', 'signal_word', 'max_label_rate_unit', 'notes', 'internal_notes', 'quoting_notes'];
  c_fields text[] := c_text || ARRAY['container_size', 'is_rup', 'rei_hours', 'phi_days',
    'max_label_rate', 'use_timings'];
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_row jsonb;
  v_changes jsonb;
  v_product public.products%ROWTYPE;
  v_stale text[] := ARRAY[]::text[];
  v_invalid text[] := ARRAY[]::text[];
  v_name text;
  v_version_before bigint;
  v_version_after bigint;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0
     OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_ROWS_REQUIRED: send 1 to 2000 rows';
  END IF;

  v_request_fp := md5(jsonb_build_object('actor_id', v_actor, 'rows', p_rows)::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'apply_product_setup');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) r
    WHERE jsonb_typeof(r) <> 'object'
       OR NOT (r ? 'product_id' AND r ? 'setup_fingerprint' AND r ? 'changes')
       OR (r->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(r->'setup_fingerprint') <> 'string'
       -- CASE, so jsonb_object_keys never sees a non-object (OR does not fix evaluation order).
       OR CASE WHEN jsonb_typeof(r->'changes') = 'object'
               THEN NOT EXISTS (SELECT 1 FROM jsonb_object_keys(r->'changes'))
                    OR EXISTS (SELECT 1 FROM jsonb_object_keys(r->'changes') k WHERE k <> ALL(c_fields))
               ELSE true END
  ) THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_ROW_SHAPE_INVALID: each row needs product_id, setup_fingerprint and at least one change to a setup field';
  END IF;
  IF (SELECT count(DISTINCT lower(r->>'product_id')) FROM jsonb_array_elements(p_rows) r)
     <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_DUPLICATE_PRODUCT: each product may appear once';
  END IF;
  IF (SELECT count(*) FROM public.products p
      WHERE p.id IN (SELECT (r->>'product_id')::uuid FROM jsonb_array_elements(p_rows) r))
     <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;
  PERFORM 1 FROM public.products p
   WHERE p.id IN (SELECT (r->>'product_id')::uuid FROM jsonb_array_elements(p_rows) r)
   ORDER BY p.id FOR UPDATE;

  -- Every value's type is checked before anything is written; the table's own checks run on write.
  FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) r LOOP
    SELECT * INTO v_product FROM public.products WHERE id = (v_row->>'product_id')::uuid;
    v_changes := v_row->'changes';
    IF v_row->>'setup_fingerprint' IS DISTINCT FROM public._product_setup_fingerprint(v_product) THEN
      v_stale := v_stale || v_product.product_name;
    ELSIF EXISTS (SELECT 1 FROM jsonb_each(v_changes) c
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
                                  THEN btrim(c.value #>> '{}')::numeric <= 0 ELSE true END)
                     OR (c.key = 'use_timings' AND (jsonb_typeof(c.value) <> 'array'
                         OR EXISTS (SELECT 1 FROM jsonb_array_elements(c.value) t
                                    WHERE jsonb_typeof(t) <> 'string')))) THEN
      v_invalid := v_invalid || v_product.product_name;
    END IF;
  END LOOP;
  IF cardinality(v_stale) > 0 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_STALE: changed by someone else since you downloaded them; download again: %',
      array_to_string(v_stale[1:20], ', ');
  END IF;
  IF cardinality(v_invalid) > 0 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_INVALID: a value has the wrong type (yes/no, whole number, decimal, or a container size above 0): %',
      array_to_string(v_invalid[1:20], ', ');
  END IF;

  BEGIN
    FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) r LOOP
      v_changes := v_row->'changes';
      SELECT pricing_version INTO v_version_before FROM public.products WHERE id = (v_row->>'product_id')::uuid;
      UPDATE public.products p SET
        product_name = CASE WHEN v_changes ? 'product_name' THEN NULLIF(btrim(v_changes->>'product_name'), '') ELSE p.product_name END,
        sku = CASE WHEN v_changes ? 'sku' THEN NULLIF(btrim(v_changes->>'sku'), '') ELSE p.sku END,
        category = CASE WHEN v_changes ? 'category' THEN NULLIF(btrim(v_changes->>'category'), '') ELSE p.category END,
        manufacturer = CASE WHEN v_changes ? 'manufacturer' THEN NULLIF(btrim(v_changes->>'manufacturer'), '') ELSE p.manufacturer END,
        container_type = CASE WHEN v_changes ? 'container_type' THEN NULLIF(btrim(v_changes->>'container_type'), '') ELSE p.container_type END,
        epa_registration = CASE WHEN v_changes ? 'epa_registration' THEN NULLIF(btrim(v_changes->>'epa_registration'), '') ELSE p.epa_registration END,
        signal_word = CASE WHEN v_changes ? 'signal_word' THEN NULLIF(btrim(v_changes->>'signal_word'), '') ELSE p.signal_word END,
        max_label_rate_unit = CASE WHEN v_changes ? 'max_label_rate_unit' THEN NULLIF(btrim(v_changes->>'max_label_rate_unit'), '') ELSE p.max_label_rate_unit END,
        notes = CASE WHEN v_changes ? 'notes' THEN NULLIF(btrim(v_changes->>'notes'), '') ELSE p.notes END,
        internal_notes = CASE WHEN v_changes ? 'internal_notes' THEN NULLIF(btrim(v_changes->>'internal_notes'), '') ELSE p.internal_notes END,
        quoting_notes = CASE WHEN v_changes ? 'quoting_notes' THEN NULLIF(btrim(v_changes->>'quoting_notes'), '') ELSE p.quoting_notes END,
        container_size = CASE WHEN v_changes ? 'container_size' THEN NULLIF(btrim(v_changes->>'container_size'), '')::numeric ELSE p.container_size END,
        max_label_rate = CASE WHEN v_changes ? 'max_label_rate' THEN NULLIF(btrim(v_changes->>'max_label_rate'), '')::numeric ELSE p.max_label_rate END,
        rei_hours = CASE WHEN v_changes ? 'rei_hours' THEN (v_changes->>'rei_hours')::integer ELSE p.rei_hours END,
        phi_days = CASE WHEN v_changes ? 'phi_days' THEN (v_changes->>'phi_days')::integer ELSE p.phi_days END,
        is_rup = CASE WHEN v_changes ? 'is_rup' THEN (v_changes->>'is_rup')::boolean ELSE p.is_rup END,
        use_timings = CASE WHEN v_changes ? 'use_timings'
          THEN ARRAY(SELECT jsonb_array_elements_text(v_changes->'use_timings')) ELSE p.use_timings END,
        updated_at = now()
      WHERE p.id = (v_row->>'product_id')::uuid
      RETURNING p.product_name, p.pricing_version INTO v_name, v_version_after;
      v_results := v_results || jsonb_build_object('product_id', v_row->>'product_id',
        'product_name', v_name,
        -- Notes and use timings move pricing_version (the price workbook's rule); the Rates tab uses these
        -- to tell its own Setup save from someone else's change.
        'pricing_version_before', v_version_before, 'pricing_version_after', v_version_after, 'fields', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(v_changes) k));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- Name the product the table's own check refused; nothing is saved.
    SELECT product_name INTO v_name FROM public.products WHERE id = (v_row->>'product_id')::uuid;
    RAISE EXCEPTION 'PRODUCT_SETUP_ROW_REFUSED: %: %', v_name, SQLERRM USING ERRCODE = SQLSTATE;
  END;

  v_result := jsonb_build_object('changed_count', jsonb_array_length(v_results), 'rows', v_results);
  PERFORM public.save_idempotency(p_idempotency_key, 'apply_product_setup',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.apply_product_setup(jsonb, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_product_setup(jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_setup(jsonb, uuid, text) TO authenticated;

DO $postflight$
BEGIN
  IF has_function_privilege('anon', 'public.get_product_setup_workbook()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_product_rates(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_product_setup(jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._product_setup_fingerprint(public.products)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._product_setup_fingerprint(public.products)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.apply_product_setup(jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_product_rates(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_product_setup_workbook()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_SETUP_WORKBOOK_GRANTS_WRONG';
  END IF;
END;
$postflight$;
