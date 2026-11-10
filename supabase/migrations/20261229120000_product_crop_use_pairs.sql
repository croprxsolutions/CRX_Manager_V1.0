-- USE-1 (Product Master Stage 6): crop and timing pairs.
-- Build sheet: docs/plans/2026-11-08-product-USE1-USE3-BUILD-SHEET.md, sections 3 and 4.
--   * product_crop_options: the fixed crop list (Mason, 2026-11-09). A blank crop means "Any crop".
--   * product_use_timing_options: each option already is a (category, timing, crop) pair. This adds the
--     crop foreign key, one ACTIVE option per pair, a timing-code pattern, who/when columns and a version.
--     Volunteer Corn is re-filed to "Any crop" and Range/Pasture/Turf to its own crop (Mason, question 2);
--     one option is added: Burndown (preplant), any crop, Herbicide (Mason, 2026-11-09).
--   * add_use_timing_option / set_use_timing_option_active: admin RPCs to add a pair or turn one off/on.
--   * sync_product_use_timings re-emitted: a turned-off option is no longer refused (Mason, 2026-11-09: the
--     pickers hide it instead; a save racing a turn-off may keep it, and an admin can remove it); one row
--     never holds two options of the same pair.
--   * guard_product_parent_timing_pairs: a parent never holds one pair twice.
-- NON-DESTRUCTIVE: no products or product_parents column, grant or row changes (postflight md5s prove it).
-- New grants only on the new objects (SELECT on the crop table, EXECUTE on the two RPCs, to authenticated).
-- ROLLBACK (its own reviewed migration; sheet 4.D): re-emit sync_product_use_timings from 20261103210000;
-- drop trg_guard_product_parent_timing_pairs and its function; drop the two RPCs; drop
-- product_use_timing_options_crop_fkey, product_use_timing_options_active_pair_key and
-- product_use_timing_options_timing_code_check; drop created_by, updated_by, updated_at, option_version;
-- set volunteer_corn's crop back to 'corn' and range_pasture_turf's back to NULL; delete burndown_preplant
-- only if no product or parent holds it (else keep it and say so); drop product_crop_options.
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE use1_crop_pairs_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.use1_crop_pairs_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.use1_crop_pairs_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'USE1_NOT_IN_TRANSACTION';
  END IF;
  IF to_regclass('public.product_crop_options') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                 AND proname IN ('add_use_timing_option', 'set_use_timing_option_active',
                                 'guard_product_parent_timing_pairs'))
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_use_timing_options'::regclass
                 AND conname IN ('product_use_timing_options_crop_fkey', 'product_use_timing_options_timing_code_check'))
     OR to_regclass('public.product_use_timing_options_active_pair_key') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_product_parent_timing_pairs')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'product_use_timing_options'
                 AND column_name IN ('created_by', 'updated_by', 'updated_at', 'option_version')) THEN
    RAISE EXCEPTION 'PREFLIGHT_USE1_ALREADY_EXISTS';
  END IF;
  -- The 9 live options, exactly (sheet section 1).
  IF (SELECT string_agg(concat_ws('|', code, label, timing_code, COALESCE(crop, '-'), category, sort_order, is_active::text),
                        ' ; ' ORDER BY code COLLATE "C")
        FROM public.product_use_timing_options) IS DISTINCT FROM
     'foliar|Foliar|foliar|-|Foliar Fertilizer|90|true ; '
     || 'post_emerge_corn|Post-Emerge Corn|post_emergence|corn|Herbicide|50|true ; '
     || 'post_emerge_soybeans|Post-Emerge Soybeans|post_emergence|soybeans|Herbicide|60|true ; '
     || 'post_emergence|Post-Emergence|post_emergence|-|Herbicide|40|true ; '
     || 'pre_emerge|Pre-Emerge|pre_emergence|-|Herbicide|10|true ; '
     || 'pre_emerge_corn|Pre-Emerge Corn|pre_emergence|corn|Herbicide|20|true ; '
     || 'pre_emerge_soybean|Pre-Emerge Soybean|pre_emergence|soybeans|Herbicide|30|true ; '
     || 'range_pasture_turf|Range/Pasture/Turf|range_pasture_turf|-|Herbicide|80|true ; '
     || 'volunteer_corn|Volunteer Corn|volunteer_corn|corn|Herbicide|70|true' THEN
    RAISE EXCEPTION 'PREFLIGHT_USE1_OPTIONS_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_use_timing_options a JOIN public.product_use_timing_options b
               ON lower(a.label) = lower(b.code) AND a.code <> b.code) THEN
    RAISE EXCEPTION 'PREFLIGHT_USE1_LABEL_EQUALS_CODE';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT p.id, o.category, o.timing_code, o.crop FROM public.products p
                              CROSS JOIN LATERAL unnest(p.use_timings) c(code)
                              JOIN public.product_use_timing_options o ON o.code = c.code) x
              GROUP BY id, category, timing_code, crop HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM (SELECT p.id, o.category, o.timing_code, o.crop FROM public.product_parents p
                              CROSS JOIN LATERAL unnest(p.use_timings) c(code)
                              JOIN public.product_use_timing_options o ON o.code = c.code) x
              GROUP BY id, category, timing_code, crop HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PREFLIGHT_USE1_PAIR_TWICE';
  END IF;
  IF to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regclass('public.product_parent_copy_passes') IS NULL
     OR to_regclass('public.product_parent_members') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_USE1_HELPERS_MISSING';
  END IF;
  -- The re-emit below starts from the live 20261103210000 body; refuse if live drifted.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.sync_product_use_timings()'::regprocedure) IS DISTINCT FROM 'd03877a2c05b92d72fce93ca312c6f3d'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                     AND tgname = 'trg_sync_product_use_timings' AND tgenabled = 'O' AND tgtype = 23) THEN
    RAISE EXCEPTION 'PREFLIGHT_USE1_SYNC_TRIGGER_DRIFTED';
  END IF;
END;
$preflight$;

CREATE TEMP TABLE use1_before_products ON COMMIT DROP AS
SELECT id, md5(concat_ws('|', use_timings::text, use_timing, pricing_version::text)) AS fp FROM public.products;
CREATE TEMP TABLE use1_before_parents ON COMMIT DROP AS
SELECT id, md5(concat_ws('|', use_timings::text, parent_version::text)) AS fp FROM public.product_parents;
CREATE TEMP TABLE use1_before_functions ON COMMIT DROP AS
SELECT p.proname::text AS name, md5(string_agg(concat_ws('|', p.oid::regprocedure::text, p.prosrc, p.proconfig::text, p.proowner::regrole::text, p.prosecdef::text, p.proacl::text), '#' ORDER BY p.oid::regprocedure::text)) AS fp
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('_product_parent_timings', 'update_product_parent', 'guard_product_parent_timings',
                     'guard_product_parent_values', 'add_product_size', 'move_product_size', '_copy_parent_to_size')
 GROUP BY p.proname;
CREATE TEMP TABLE use1_before_misc ON COMMIT DROP AS
SELECT (SELECT relacl::text FROM pg_class WHERE oid = 'public.product_use_timing_options'::regclass) AS options_acl,
       (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_use_timing_options'::regclass) AS options_policies,
       (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.sync_product_use_timings()'::regprocedure) AS sync_fp;

DO $captured$
BEGIN
  IF (SELECT count(*) FROM pg_temp.use1_before_functions) <> 7 THEN
    RAISE EXCEPTION 'PREFLIGHT_USE1_FUNCTIONS_MISSING';
  END IF;
END;
$captured$;

-- ---------------------------------------------------------------------------------------------
-- The crop list
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.product_crop_options (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label text NOT NULL CHECK (label = btrim(label) AND label <> '' AND length(label) <= 60),
  sort_order integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_crop_options_lower_label_key ON public.product_crop_options (lower(label));
ALTER TABLE public.product_crop_options OWNER TO postgres;
COMMENT ON TABLE public.product_crop_options IS
  'USE-1: crops a use timing option can name. Written only by migrations. A NULL option crop means "Any crop".';
ALTER TABLE public.product_crop_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_crop_options_select ON public.product_crop_options
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.product_crop_options FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_crop_options TO authenticated;

-- The first seven match customers.crops (without 'other'); range_pasture_turf is a use site.
INSERT INTO public.product_crop_options (code, label, sort_order) VALUES
  ('corn', 'Corn', 10),
  ('soybeans', 'Soybeans', 20),
  ('wheat', 'Wheat', 30),
  ('milo', 'Milo', 40),
  ('cotton', 'Cotton', 50),
  ('alfalfa', 'Alfalfa', 60),
  ('pasture_hay', 'Pasture/Hay', 70),
  ('range_pasture_turf', 'Range/Pasture/Turf', 80);

-- ---------------------------------------------------------------------------------------------
-- Options: who/when, version, re-filing, Burndown, and the pair rules
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.product_use_timing_options
  ADD COLUMN created_by uuid NULL,
  ADD COLUMN updated_by uuid NULL,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN option_version bigint NOT NULL DEFAULT 1;

-- Products store the code, not the crop, so no product row changes (Mason, question 2).
UPDATE public.product_use_timing_options SET crop = NULL WHERE code = 'volunteer_corn';
UPDATE public.product_use_timing_options SET crop = 'range_pasture_turf' WHERE code = 'range_pasture_turf';

-- Before planting, on any crop (Mason, 2026-11-09). Sort 5: listed first.
INSERT INTO public.product_use_timing_options (code, label, timing_code, crop, category, sort_order)
VALUES ('burndown_preplant', 'Burndown (preplant)', 'burndown', NULL, 'Herbicide', 5);

ALTER TABLE public.product_use_timing_options
  ADD CONSTRAINT product_use_timing_options_crop_fkey FOREIGN KEY (crop)
    REFERENCES public.product_crop_options(code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT product_use_timing_options_timing_code_check CHECK (timing_code ~ '^[a-z][a-z0-9_]*$');
CREATE UNIQUE INDEX product_use_timing_options_active_pair_key
  ON public.product_use_timing_options (category, timing_code, crop) NULLS NOT DISTINCT WHERE is_active;

-- ---------------------------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.add_use_timing_option(p_category text, p_timing_code text, p_crop text, p_label text,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_category text := btrim(p_category);
  v_timing text := btrim(p_timing_code);
  v_crop text := NULLIF(btrim(p_crop), '');
  v_label text := btrim(p_label);
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'category', btrim(p_category),
    'timing_code', btrim(p_timing_code), 'crop', NULLIF(btrim(p_crop), ''), 'label', btrim(p_label))::text);
  v_existing jsonb;
  v_taken text;
  v_base text;
  v_code text;
  v_n integer := 1;
  v_row public.product_use_timing_options%ROWTYPE;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'add_use_timing_option', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  -- Two admins cannot add (or turn on) the same pair at once.
  PERFORM pg_advisory_xact_lock(hashtext('crx_use_timing_options'));

  IF v_category IS NULL OR v_category NOT IN ('Herbicide', 'Foliar Fertilizer') THEN
    RAISE EXCEPTION 'USE_TIMING_CATEGORY: only Herbicide and Foliar Fertilizer products take a crop and timing';
  END IF;
  IF v_timing IS NULL OR v_timing !~ '^[a-z][a-z0-9_]*$' OR length(v_timing) > 60 THEN
    RAISE EXCEPTION 'USE_TIMING_CODE_INVALID: a timing code is lowercase letters, digits and _, starting with a letter';
  END IF;
  IF v_crop IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.product_crop_options c WHERE c.code = v_crop AND c.is_active) THEN
    RAISE EXCEPTION 'USE_TIMING_CROP_UNKNOWN: pick a crop from the list, or Any crop';
  END IF;
  IF v_label IS NULL OR length(v_label) > 60 OR v_label !~ '^[A-Za-z][ -~]*$' OR position(';' IN v_label) > 0 THEN
    RAISE EXCEPTION 'USE_TIMING_LABEL_INVALID: a name is 1 to 60 characters, starts with a letter, uses plain keyboard characters and has no ;';
  END IF;
  SELECT o.label INTO v_taken FROM public.product_use_timing_options o WHERE lower(o.label) = lower(v_label);
  IF FOUND THEN
    RAISE EXCEPTION 'USE_TIMING_LABEL_TAKEN: "%" is already a choice', v_taken;
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_use_timing_options o WHERE lower(o.code) = lower(v_label)) THEN
    RAISE EXCEPTION 'USE_TIMING_LABEL_IS_CODE: "%" is the code of another choice; pick another name', v_label;
  END IF;
  SELECT o.label INTO v_taken FROM public.product_use_timing_options o
   WHERE o.is_active AND o.category = v_category AND o.timing_code = v_timing AND o.crop IS NOT DISTINCT FROM v_crop;
  IF FOUND THEN
    RAISE EXCEPTION 'USE_TIMING_PAIR_EXISTS: "%" already offers this crop and timing', v_taken;
  END IF;

  -- The label starts with an ASCII letter, so the slug does too and matches the code pattern.
  v_base := btrim(regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g'), '_');
  v_code := v_base;
  WHILE EXISTS (SELECT 1 FROM public.product_use_timing_options o WHERE o.code = v_code OR lower(o.label) = v_code) LOOP
    v_n := v_n + 1;
    v_code := v_base || '_' || v_n;
  END LOOP;

  INSERT INTO public.product_use_timing_options (code, label, timing_code, crop, category, sort_order,
    created_by, updated_by)
  VALUES (v_code, v_label, v_timing, v_crop, v_category,
    COALESCE((SELECT max(o.sort_order) FROM public.product_use_timing_options o WHERE o.category = v_category), 0) + 10,
    v_actor, v_actor)
  RETURNING * INTO v_row;

  v_receipt := jsonb_build_object('code', v_row.code, 'label', v_row.label, 'timing_code', v_row.timing_code,
    'crop', v_row.crop, 'category', v_row.category, 'sort_order', v_row.sort_order,
    'is_active', v_row.is_active, 'option_version', v_row.option_version);
  PERFORM public.save_idempotency(p_idempotency_key, 'add_use_timing_option',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.add_use_timing_option(text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_use_timing_option(text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_use_timing_option(text, text, text, text, text) TO authenticated;

-- Turning off is allowed while products hold the option: they keep it, it leaves the picker.
CREATE FUNCTION public.set_use_timing_option_active(p_code text, p_is_active boolean, p_expected_option_version bigint,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'code', p_code, 'is_active', p_is_active,
    'expected_option_version', p_expected_option_version)::text);
  v_existing jsonb;
  v_row public.product_use_timing_options%ROWTYPE;
  v_taken text;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_use_timing_option_active', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_code IS NULL OR p_is_active IS NULL OR p_expected_option_version IS NULL THEN
    RAISE EXCEPTION 'USE_TIMING_INVALID: send the choice, on or off, and the version you loaded';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('crx_use_timing_options'));
  SELECT * INTO v_row FROM public.product_use_timing_options WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USE_TIMING_NOT_FOUND: no such crop and timing choice'; END IF;
  IF v_row.option_version <> p_expected_option_version THEN
    RAISE EXCEPTION 'USE_TIMING_STALE: "%" changed since you loaded it; refresh and try again', v_row.label;
  END IF;
  IF v_row.is_active = p_is_active THEN
    RAISE EXCEPTION 'USE_TIMING_NO_CHANGE: "%" is already %', v_row.label, CASE WHEN p_is_active THEN 'on' ELSE 'off' END;
  END IF;
  IF p_is_active THEN
    IF v_row.crop IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.product_crop_options c
                                               WHERE c.code = v_row.crop AND c.is_active) THEN
      RAISE EXCEPTION 'USE_TIMING_CROP_UNKNOWN: the crop of "%" is no longer on the list', v_row.label;
    END IF;
    SELECT o.label INTO v_taken FROM public.product_use_timing_options o
     WHERE o.is_active AND o.code <> v_row.code AND o.category = v_row.category
       AND o.timing_code = v_row.timing_code AND o.crop IS NOT DISTINCT FROM v_row.crop;
    IF FOUND THEN
      RAISE EXCEPTION 'USE_TIMING_PAIR_EXISTS: "%" already offers this crop and timing', v_taken;
    END IF;
  END IF;

  UPDATE public.product_use_timing_options
     SET is_active = p_is_active, updated_by = v_actor, updated_at = now(), option_version = option_version + 1
   WHERE code = p_code RETURNING * INTO v_row;

  v_receipt := jsonb_build_object('code', v_row.code, 'label', v_row.label, 'timing_code', v_row.timing_code,
    'crop', v_row.crop, 'category', v_row.category, 'sort_order', v_row.sort_order,
    'is_active', v_row.is_active, 'option_version', v_row.option_version,
    'sizes_holding', (SELECT count(*) FROM public.products p WHERE v_row.code = ANY(p.use_timings)),
    'parents_holding', (SELECT count(*) FROM public.product_parents pp WHERE v_row.code = ANY(pp.use_timings)));
  PERFORM public.save_idempotency(p_idempotency_key, 'set_use_timing_option_active',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.set_use_timing_option_active(text, boolean, bigint, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_use_timing_option_active(text, boolean, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_use_timing_option_active(text, boolean, bigint, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Size trigger: re-emitted from 20261103210000 with two changes (marked USE-1)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_product_use_timings() RETURNS trigger
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
  v_codes_changed boolean := true;
  v_twice text[];
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
      BEGIN
        SELECT * INTO STRICT v_option FROM public.product_use_timing_options WHERE lower(label) = lower(v_part);
      EXCEPTION WHEN NO_DATA_FOUND THEN
        RAISE EXCEPTION 'Unknown use timing "%". Pick from the list.', v_part USING ERRCODE = '22023';
      END;
      v_codes := array_append(v_codes, v_option.code);
    END LOOP;
    IF TG_OP = 'UPDATE' AND cardinality(OLD.use_timings) >= 2
       AND current_setting('crx.pricing_authorized', true) IS DISTINCT FROM 'phase1a'
       AND EXISTS (SELECT 1 FROM unnest(OLD.use_timings) old_code
                   WHERE old_code <> ALL(v_codes)) THEN
      RAISE EXCEPTION 'This product has several use timings; change them on the product page (refresh if you only see one).'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_codes_changed := ARRAY(SELECT DISTINCT x FROM unnest(v_codes) x ORDER BY x)
      IS DISTINCT FROM ARRAY(SELECT DISTINCT x FROM unnest(v_old_codes) x ORDER BY x);
  END IF;

  IF NEW.category NOT IN ('Herbicide', 'Foliar Fertilizer') OR NEW.category IS NULL THEN
    IF cardinality(v_codes) > 0 THEN
      RAISE EXCEPTION 'Only Herbicide and Foliar Fertilizer products have a use timing. Clear the timings to change the category.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  FOR v_code IN SELECT DISTINCT x FROM unnest(v_codes) x LOOP
    IF TG_OP = 'UPDATE' AND NOT v_codes_changed AND NEW.category IS NOT DISTINCT FROM OLD.category THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_option FROM public.product_use_timing_options WHERE code = v_code;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown use timing "%". Pick from the list.', v_code USING ERRCODE = '22023';
    END IF;
    -- USE-1 (Mason, 2026-11-09): a turned-off option is no longer refused here; the pickers hide it.
    IF v_option.category IS DISTINCT FROM NEW.category THEN
      RAISE EXCEPTION 'Use timing "%" is unavailable for category "%".', v_option.label, NEW.category
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- USE-1: one row never holds two options of the same (category, timing, crop) pair.
  IF v_codes_changed THEN
    SELECT array_agg(o.label ORDER BY o.sort_order, o.code) INTO v_twice
      FROM public.product_use_timing_options o
     WHERE o.code = ANY(v_codes)
     GROUP BY o.category, o.timing_code, o.crop HAVING count(*) > 1
     ORDER BY min(o.sort_order) LIMIT 1;
    IF v_twice IS NOT NULL THEN
      RAISE EXCEPTION 'USE_TIMING_PAIR_TWICE: "%" and "%" are the same crop and timing; keep one.', v_twice[1], v_twice[2]
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT COALESCE(array_agg(o.code ORDER BY o.sort_order, o.code), '{}'),
         string_agg(o.label, '; ' ORDER BY o.sort_order, o.code)
    INTO NEW.use_timings, v_labels
    FROM public.product_use_timing_options o WHERE o.code = ANY(v_codes);
  IF TG_OP = 'INSERT' AND NOT v_legacy AND cardinality(v_codes) > 0 AND NEW.use_timing IS NOT NULL
     AND NEW.use_timing IS DISTINCT FROM v_labels THEN
    RAISE EXCEPTION 'Use timing was changed two ways at once; refresh and try again.' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' AND v_list_changed AND NEW.use_timing IS DISTINCT FROM OLD.use_timing
     AND NEW.use_timing IS DISTINCT FROM v_labels THEN
    RAISE EXCEPTION 'Use timing was changed two ways at once; refresh and try again.' USING ERRCODE = '22023';
  END IF;
  NEW.use_timing := v_labels;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Parent trigger: a parent never holds one pair twice
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.guard_product_parent_timing_pairs() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
DECLARE
  v_twice text[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.use_timings IS NOT DISTINCT FROM OLD.use_timings THEN RETURN NEW; END IF;
  SELECT array_agg(o.label ORDER BY o.sort_order, o.code) INTO v_twice
    FROM public.product_use_timing_options o
   WHERE o.code = ANY(NEW.use_timings)
   GROUP BY o.category, o.timing_code, o.crop HAVING count(*) > 1
   ORDER BY min(o.sort_order) LIMIT 1;
  IF v_twice IS NOT NULL THEN
    RAISE EXCEPTION 'USE_TIMING_PAIR_TWICE: "%" and "%" are the same crop and timing; keep one.', v_twice[1], v_twice[2]
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_parent_timing_pairs() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_parent_timing_pairs() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_guard_product_parent_timing_pairs
  BEFORE INSERT OR UPDATE OF use_timings ON public.product_parents
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_parent_timing_pairs();

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------

DO $postflight$
DECLARE
  v_policy pg_policy%ROWTYPE;
  v_fn text;
  v_role text;
BEGIN
  -- Counts match: no product's or parent's timings, joined text or version moved.
  IF (SELECT count(*) FROM pg_temp.use1_before_products) <> (SELECT count(*) FROM public.products)
     OR EXISTS (SELECT 1 FROM public.products p LEFT JOIN pg_temp.use1_before_products b USING (id)
                 WHERE b.fp IS DISTINCT FROM md5(concat_ws('|', p.use_timings::text, p.use_timing, p.pricing_version::text)))
     OR (SELECT count(*) FROM pg_temp.use1_before_parents) <> (SELECT count(*) FROM public.product_parents)
     OR EXISTS (SELECT 1 FROM public.product_parents p LEFT JOIN pg_temp.use1_before_parents b USING (id)
                 WHERE b.fp IS DISTINCT FROM md5(concat_ws('|', p.use_timings::text, p.parent_version::text))) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_PRODUCTS_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.products p CROSS JOIN LATERAL unnest(p.use_timings) c(code)
              WHERE NOT EXISTS (SELECT 1 FROM public.product_use_timing_options o WHERE o.code = c.code)) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_CODE_UNRESOLVED';
  END IF;
  IF (SELECT string_agg(concat_ws('|', code, label, timing_code, COALESCE(crop, '-'), category, sort_order, is_active::text,
                                  option_version, (created_by IS NULL)::text),
                        ' ; ' ORDER BY code COLLATE "C")
        FROM public.product_use_timing_options) IS DISTINCT FROM
     'burndown_preplant|Burndown (preplant)|burndown|-|Herbicide|5|true|1|true ; '
     || 'foliar|Foliar|foliar|-|Foliar Fertilizer|90|true|1|true ; '
     || 'post_emerge_corn|Post-Emerge Corn|post_emergence|corn|Herbicide|50|true|1|true ; '
     || 'post_emerge_soybeans|Post-Emerge Soybeans|post_emergence|soybeans|Herbicide|60|true|1|true ; '
     || 'post_emergence|Post-Emergence|post_emergence|-|Herbicide|40|true|1|true ; '
     || 'pre_emerge|Pre-Emerge|pre_emergence|-|Herbicide|10|true|1|true ; '
     || 'pre_emerge_corn|Pre-Emerge Corn|pre_emergence|corn|Herbicide|20|true|1|true ; '
     || 'pre_emerge_soybean|Pre-Emerge Soybean|pre_emergence|soybeans|Herbicide|30|true|1|true ; '
     || 'range_pasture_turf|Range/Pasture/Turf|range_pasture_turf|range_pasture_turf|Herbicide|80|true|1|true ; '
     || 'volunteer_corn|Volunteer Corn|volunteer_corn|-|Herbicide|70|true|1|true' THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_OPTIONS';
  END IF;
  IF (SELECT string_agg(concat_ws('|', code, label, sort_order, is_active::text), ' ; ' ORDER BY sort_order)
        FROM public.product_crop_options) IS DISTINCT FROM
     'corn|Corn|10|true ; soybeans|Soybeans|20|true ; wheat|Wheat|30|true ; milo|Milo|40|true ; '
     || 'cotton|Cotton|50|true ; alfalfa|Alfalfa|60|true ; pasture_hay|Pasture/Hay|70|true ; '
     || 'range_pasture_turf|Range/Pasture/Turf|80|true' THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_CROPS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_use_timing_options_crop_fkey'
                  AND conrelid = 'public.product_use_timing_options'::regclass AND contype = 'f'
                  AND confrelid = 'public.product_crop_options'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_use_timing_options_timing_code_check'
                     AND conrelid = 'public.product_use_timing_options'::regclass AND contype = 'c')
     OR NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'public.product_use_timing_options_active_pair_key'::regclass
                     AND i.indisunique AND i.indnullsnotdistinct AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_PAIR_RULES';
  END IF;

  -- The crop table: RLS, one read policy, SELECT for authenticated only.
  IF NOT (SELECT relrowsecurity AND relowner = 'postgres'::regrole FROM pg_class
          WHERE oid = 'public.product_crop_options'::regclass) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_CROPS_RLS';
  END IF;
  SELECT * INTO v_policy FROM pg_policy WHERE polrelid = 'public.product_crop_options'::regclass;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_crop_options'::regclass) <> 1
     OR v_policy.polname <> 'product_crop_options_select' OR v_policy.polcmd <> 'r'
     OR v_policy.polroles <> ARRAY['authenticated'::regrole::oid]
     OR position('is_active_profile()' IN pg_get_expr(v_policy.polqual, v_policy.polrelid)) = 0 THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_CROPS_POLICY';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.product_crop_options', 'SELECT')
     OR has_table_privilege('authenticated', 'public.product_crop_options', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('anon', 'public.product_crop_options', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('service_role', 'public.product_crop_options', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('metabase_ro', 'public.product_crop_options', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
                 WHERE c.oid = 'public.product_crop_options'::regclass AND a.grantee = 0) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_CROPS_GRANTS';
  END IF;
  -- The options table gains no privilege and no policy.
  IF (SELECT relacl::text FROM pg_class WHERE oid = 'public.product_use_timing_options'::regclass)
       IS DISTINCT FROM (SELECT options_acl FROM pg_temp.use1_before_misc)
     OR (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_use_timing_options'::regclass)
       <> (SELECT options_policies FROM pg_temp.use1_before_misc) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_OPTIONS_GRANTS';
  END IF;

  -- The two RPCs: owner postgres, SECURITY DEFINER, pinned search_path, EXECUTE for authenticated only.
  FOREACH v_fn IN ARRAY ARRAY['public.add_use_timing_option(text,text,text,text,text)',
                              'public.set_use_timing_option_active(text,boolean,bigint,text)'] LOOP
    IF NOT (SELECT prosecdef AND proowner = 'postgres'::regrole AND proconfig = ARRAY['search_path=public, pg_temp']
              FROM pg_proc WHERE oid = v_fn::regprocedure)
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                   WHERE p.oid = v_fn::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'USE1_POSTFLIGHT_RPC: %', v_fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('add_use_timing_option', 'set_use_timing_option_active')) <> 2 THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_RPC_OVERLOAD';
  END IF;

  -- The seven parent functions are untouched.
  IF EXISTS (SELECT 1 FROM pg_temp.use1_before_functions b
              WHERE b.fp IS DISTINCT FROM (SELECT md5(string_agg(concat_ws('|', p.oid::regprocedure::text, p.prosrc, p.proconfig::text, p.proowner::regrole::text, p.prosecdef::text, p.proacl::text), '#' ORDER BY p.oid::regprocedure::text))
                                             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = b.name)) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_PARENT_FUNCTIONS_CHANGED';
  END IF;

  -- The size trigger: changed only by the re-emit, same owner, search_path and trigger.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.sync_product_use_timings()'::regprocedure) = (SELECT sync_fp FROM pg_temp.use1_before_misc)
     OR NOT (SELECT NOT prosecdef AND proowner = 'postgres'::regrole AND proconfig = ARRAY['search_path=public, pg_temp']
                    AND position('USE_TIMING_PAIR_TWICE' IN prosrc) > 0
               FROM pg_proc WHERE oid = 'public.sync_product_use_timings()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                     AND tgname = 'trg_sync_product_use_timings' AND tgenabled = 'O' AND tgtype = 23
                     AND tgfoid = 'public.sync_product_use_timings()'::regprocedure) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_SYNC_TRIGGER';
  END IF;

  -- The parent trigger: BEFORE INSERT OR UPDATE OF use_timings, row level; its function has no EXECUTE.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.product_parents'::regclass
                  AND t.tgname = 'trg_guard_product_parent_timing_pairs' AND t.tgenabled = 'O' AND t.tgtype = 23
                  AND t.tgfoid = 'public.guard_product_parent_timing_pairs()'::regprocedure
                  AND t.tgattr::text = (SELECT attnum::text FROM pg_attribute
                                         WHERE attrelid = 'public.product_parents'::regclass AND attname = 'use_timings')) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_PARENT_TRIGGER';
  END IF;
  IF NOT (SELECT NOT prosecdef AND proowner = 'postgres'::regrole AND proconfig = ARRAY['search_path=public, pg_temp']
            FROM pg_proc WHERE oid = 'public.guard_product_parent_timing_pairs()'::regprocedure)
     OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                 WHERE p.oid = 'public.guard_product_parent_timing_pairs()'::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'USE1_POSTFLIGHT_PARENT_TRIGGER_FUNCTION';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'public.guard_product_parent_timing_pairs()', 'EXECUTE') THEN
      RAISE EXCEPTION 'USE1_POSTFLIGHT_PARENT_TRIGGER_GRANT: %', v_role;
    END IF;
  END LOOP;
END;
$postflight$;
