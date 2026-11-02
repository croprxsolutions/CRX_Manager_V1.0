-- Product Use Timing now stores several stable option codes while keeping the legacy text in sync.
-- MASON-GATED: grants on the existing products table mirror the use_timing column.
-- ROLLBACK: drop trg_sync_product_use_timings, sync_product_use_timings(), use_timings,
-- and product_use_timing_options; use_timing retains its last joined label text.
SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE v_bad record;
BEGIN
  IF to_regclass('public.product_use_timing_options') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'use_timings') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_USE_TIMINGS_ALREADY_EXISTS';
  END IF;
  SELECT id, use_timing, category INTO v_bad FROM public.products
  WHERE use_timing IS NOT NULL AND NOT (
    (category = 'Herbicide' AND use_timing IN
      ('Post-Emergence','Pre-Emerge Soybean','Pre-Emerge Corn','Range/Pasture/Turf','Volunteer Corn'))
    OR (category = 'Foliar Fertilizer' AND use_timing = 'Foliar')) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_USE_TIMING_UNKNOWN_OR_CATEGORY: product %', v_bad.id;
  END IF;
END;
$preflight$;

CREATE TEMP TABLE product_use_timing_before ON COMMIT DROP AS
SELECT id, use_timing, pricing_version FROM public.products;

CREATE TABLE public.product_use_timing_options (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label text NOT NULL UNIQUE CHECK (label = btrim(label) AND label <> '' AND position(';' in label) = 0),
  timing_code text NOT NULL,
  crop text NULL,
  category text NOT NULL CHECK (category IN ('Herbicide', 'Foliar Fertilizer')),
  sort_order integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_use_timing_options OWNER TO postgres;
ALTER TABLE public.product_use_timing_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_use_timing_options_select ON public.product_use_timing_options
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.product_use_timing_options FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_use_timing_options TO authenticated, service_role;

INSERT INTO public.product_use_timing_options(code, label, timing_code, crop, category, sort_order) VALUES
  ('post_emergence', 'Post-Emergence', 'post_emergence', NULL, 'Herbicide', 40),
  ('post_emerge_corn', 'Post-Emerge Corn', 'post_emergence', 'corn', 'Herbicide', 50),
  ('post_emerge_soybeans', 'Post-Emerge Soybeans', 'post_emergence', 'soybeans', 'Herbicide', 60),
  ('pre_emerge', 'Pre-Emerge', 'pre_emergence', NULL, 'Herbicide', 10),
  ('pre_emerge_corn', 'Pre-Emerge Corn', 'pre_emergence', 'corn', 'Herbicide', 20),
  ('pre_emerge_soybean', 'Pre-Emerge Soybean', 'pre_emergence', 'soybeans', 'Herbicide', 30),
  ('volunteer_corn', 'Volunteer Corn', 'volunteer_corn', 'corn', 'Herbicide', 70),
  ('range_pasture_turf', 'Range/Pasture/Turf', 'range_pasture_turf', NULL, 'Herbicide', 80),
  ('foliar', 'Foliar', 'foliar', NULL, 'Foliar Fertilizer', 90);

ALTER TABLE public.products ADD COLUMN use_timings text[] NOT NULL DEFAULT '{}';
-- Same four column grants as use_timing in the latest product grant migrations.
GRANT INSERT (use_timings) ON public.products TO authenticated;
GRANT UPDATE (use_timings) ON public.products TO authenticated;
GRANT SELECT (use_timings) ON public.products TO authenticated;
GRANT REFERENCES (use_timings) ON public.products TO authenticated;
GRANT SELECT (use_timings) ON public.products TO anon;

-- The pricing BEFORE guard watches only price fields; the history AFTER trigger watches
-- use_timing text, not this new array. Backfill before installing sync so neither changes.
UPDATE public.products p SET use_timings = ARRAY[o.code]
FROM public.product_use_timing_options o WHERE p.use_timing = o.label;

DO $backfill$
BEGIN
  IF (SELECT count(*) FROM pg_temp.product_use_timing_before WHERE use_timing IS NOT NULL)
       <> (SELECT count(*) FROM public.products WHERE cardinality(use_timings) > 0)
     OR EXISTS (
       SELECT 1 FROM public.products p JOIN pg_temp.product_use_timing_before b USING (id)
       LEFT JOIN public.product_use_timing_options o ON o.code = p.use_timings[1]
       WHERE p.use_timing IS DISTINCT FROM b.use_timing
          OR p.pricing_version IS DISTINCT FROM b.pricing_version
          OR (b.use_timing IS NOT NULL AND (cardinality(p.use_timings) <> 1 OR o.label IS DISTINCT FROM b.use_timing))
          OR (b.use_timing IS NULL AND cardinality(p.use_timings) <> 0)) THEN
    RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_BACKFILL_MISMATCH';
  END IF;
END;
$backfill$;

CREATE FUNCTION public.sync_product_use_timings() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
DECLARE
  v_codes text[] := '{}';
  v_code text;
  v_part text;
  v_option public.product_use_timing_options%ROWTYPE;
  v_labels text;
  v_old_codes text[] := '{}';
  v_legacy boolean := false;
  v_list_changed boolean := false;
BEGIN
  IF NEW.use_timings IS NULL THEN
    RAISE EXCEPTION 'Use timings must be a list.' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF cardinality(NEW.use_timings) > 0 THEN
      v_codes := NEW.use_timings;
    ELSE
      v_legacy := true;
    END IF;
  ELSE
    v_old_codes := OLD.use_timings;
    v_list_changed := NEW.use_timings IS DISTINCT FROM OLD.use_timings;
    IF v_list_changed THEN
      v_codes := NEW.use_timings;
    ELSIF NEW.use_timing IS DISTINCT FROM OLD.use_timing THEN
      v_legacy := true;
    ELSE
      v_codes := NEW.use_timings;
    END IF;
  END IF;

  IF v_legacy THEN
    FOREACH v_part IN ARRAY string_to_array(COALESCE(NEW.use_timing, ''), ';') LOOP
      v_part := btrim(v_part);
      IF v_part = '' THEN CONTINUE; END IF;
      SELECT * INTO v_option FROM public.product_use_timing_options WHERE lower(label) = lower(v_part);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown use timing "%". Pick from the list.', v_part USING ERRCODE = '22023';
      END IF;
      v_codes := array_append(v_codes, v_option.code);
    END LOOP;
    IF TG_OP = 'UPDATE' AND cardinality(OLD.use_timings) >= 2
       AND cardinality(ARRAY(SELECT DISTINCT x FROM unnest(v_codes) x)) < cardinality(OLD.use_timings)
       AND NOT EXISTS (SELECT 1 FROM unnest(v_codes) x WHERE x <> ALL(OLD.use_timings)) THEN
      RAISE EXCEPTION 'This product has several use timings; change them on the product page (refresh if you only see one).'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.category NOT IN ('Herbicide', 'Foliar Fertilizer') OR NEW.category IS NULL THEN
    IF cardinality(v_codes) > 0 THEN
      RAISE EXCEPTION 'Only Herbicide and Foliar Fertilizer products have a use timing. Clear the timings to change the category.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  FOR v_code IN SELECT DISTINCT x FROM unnest(v_codes) x LOOP
    SELECT * INTO v_option FROM public.product_use_timing_options WHERE code = v_code;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown use timing "%". Pick from the list.', v_code USING ERRCODE = '22023';
    END IF;
    IF v_option.category IS DISTINCT FROM NEW.category OR
       (NOT v_option.is_active AND NOT (v_code = ANY(v_old_codes))) THEN
      RAISE EXCEPTION 'Use timing "%" is unavailable for category "%".', v_option.label, NEW.category
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(o.code ORDER BY o.sort_order, o.code), '{}'),
         string_agg(o.label, '; ' ORDER BY o.sort_order, o.code)
    INTO NEW.use_timings, v_labels
    FROM public.product_use_timing_options o WHERE o.code = ANY(v_codes);
  IF TG_OP = 'UPDATE' AND v_list_changed AND NEW.use_timing IS DISTINCT FROM OLD.use_timing
     AND NEW.use_timing IS DISTINCT FROM v_labels THEN
    RAISE EXCEPTION 'Use timing was changed two ways at once; refresh and try again.' USING ERRCODE = '22023';
  END IF;
  NEW.use_timing := v_labels;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.sync_product_use_timings() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_product_use_timings() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
-- Alphabetical BEFORE order: trg_normalize_product_category, trg_sync_product_use_timings,
-- trigger_y_require_governed_product_pricing, trigger_z_guard_version_product_pricing.
-- trigger_zz_write_product_change_history is AFTER, so sees the final joined text.
CREATE TRIGGER trg_sync_product_use_timings BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.sync_product_use_timings();

DO $postflight$
DECLARE v_role text; v_privilege text; v_policy pg_policy%ROWTYPE;
BEGIN
  IF (SELECT count(*) FROM public.product_use_timing_options) <> 9
     OR (SELECT array_agg(code ORDER BY sort_order) FROM public.product_use_timing_options)
       IS DISTINCT FROM ARRAY['pre_emerge','pre_emerge_corn','pre_emerge_soybean','post_emergence',
                              'post_emerge_corn','post_emerge_soybeans','volunteer_corn','range_pasture_turf','foliar'] THEN
    RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_POSTFLIGHT_OPTIONS';
  END IF;
  IF NOT (SELECT relrowsecurity AND relowner = 'postgres'::regrole FROM pg_class
          WHERE oid = 'public.product_use_timing_options'::regclass) THEN
    RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_POSTFLIGHT_RLS';
  END IF;
  SELECT * INTO v_policy FROM pg_policy WHERE polrelid = 'public.product_use_timing_options'::regclass;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_use_timing_options'::regclass) <> 1
     OR v_policy.polname <> 'product_use_timing_options_select' OR v_policy.polcmd <> 'r'
     OR v_policy.polroles <> ARRAY['authenticated'::regrole::oid]
     OR position('is_active_profile()' IN pg_get_expr(v_policy.polqual, v_policy.polrelid)) = 0 THEN
    RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_POSTFLIGHT_POLICY';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.product_use_timing_options', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.product_use_timing_options', 'SELECT')
     OR has_table_privilege('anon', 'public.product_use_timing_options', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('authenticated', 'public.product_use_timing_options', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('service_role', 'public.product_use_timing_options', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('metabase_ro', 'public.product_use_timing_options', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_POSTFLIGHT_OPTIONS_GRANTS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.products'::regclass
                 AND attname = 'use_timings' AND atttypid = 'text[]'::regtype AND attnotnull
                 AND pg_get_expr((SELECT adbin FROM pg_attrdef WHERE adrelid = 'public.products'::regclass
                                  AND adnum = attnum), 'public.products'::regclass) = '''{}''::text[]') THEN
    RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_POSTFLIGHT_COLUMN';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role','metabase_ro'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['SELECT','REFERENCES','INSERT','UPDATE'] LOOP
      IF has_column_privilege(v_role, 'public.products', 'use_timings', v_privilege)
         IS DISTINCT FROM has_column_privilege(v_role, 'public.products', 'use_timing', v_privilege) THEN
        RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_POSTFLIGHT_GRANT: % %', v_role, v_privilege;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
       AND tgname IN ('trg_normalize_product_category','trg_sync_product_use_timings',
       'trigger_y_require_governed_product_pricing','trigger_z_guard_version_product_pricing',
       'trigger_zz_write_product_change_history') AND tgenabled = 'O') <> 5
     OR NOT ('trg_normalize_product_category' < 'trg_sync_product_use_timings'
             AND 'trg_sync_product_use_timings' < 'trigger_y_require_governed_product_pricing'
             AND 'trigger_y_require_governed_product_pricing' < 'trigger_z_guard_version_product_pricing') THEN
    RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_POSTFLIGHT_TRIGGER_ORDER';
  END IF;
  IF (SELECT count(*) FROM pg_temp.product_use_timing_before WHERE use_timing IS NOT NULL)
       <> (SELECT count(*) FROM public.products WHERE cardinality(use_timings) > 0) THEN
    RAISE EXCEPTION 'PRODUCT_USE_TIMINGS_POSTFLIGHT_BACKFILL';
  END IF;
END;
$postflight$;
