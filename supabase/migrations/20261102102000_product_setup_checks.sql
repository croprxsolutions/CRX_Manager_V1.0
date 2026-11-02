-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate).
-- Product setup options and forward-looking checks. Existing product rows are never changed.
-- Existing invalid name/SKU/EPA rows remain visible; any later edit must repair the bad field.
-- ACCESS CHANGE: new categories are readable by active authenticated profiles; admin RPC writes.
-- ROLLBACK: reviewed migration removes the new FK, checks, guard trigger/function, RPC and table.
-- ORDERING: apply after 20261102100000_product_change_history and all older pending migrations.

SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE product_setup_checks_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_category text;
  v_bad record;
BEGIN
  IF to_regclass('pg_temp.product_setup_checks_tx') IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_CHECKS_NOT_IN_TRANSACTION';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.product_setup_checks_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_CHECKS_NOT_IN_TRANSACTION';
  END IF;
  IF to_regclass('public.product_categories') IS NOT NULL
     OR to_regprocedure('public.upsert_product_category(text,boolean,integer,text)') IS NOT NULL
     OR to_regprocedure('public.guard_product_category_assignment()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.products'::regclass
                AND conname LIKE 'product_setup_%') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_SETUP_CHECKS_ALREADY_EXISTS';
  END IF;
  IF to_regprocedure('public.normalize_product_category()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                    AND tgname = 'trg_normalize_product_category' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_CATEGORY_NORMALIZER_MISSING';
  END IF;
  IF to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public._bind_replay_receipt_20261015(text,text,text)') IS NULL
     OR to_regprocedure('public._replay_fingerprint_20261015(jsonb)') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL
     OR to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_SETUP_DEPENDENCY_MISSING';
  END IF;
  -- FK validation would fail on any unknown current value. Stop before creating anything.
  SELECT category INTO v_category FROM public.products
   WHERE category IS NOT NULL AND category NOT IN (
     'Adjuvant','Biological','Dry Water Soluble Fertilizer','Foliar Fertilizer',
     'Fungicide','Herbicide','Insecticide','Liquid Fertilizer','Nitrogen Stabilizer',
     'Other','Seed Treatment','Seed') LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'PREFLIGHT_PRODUCT_CATEGORY_UNKNOWN: %', v_category; END IF;
  RAISE NOTICE 'Existing product rows needing later cleanup: names %, SKU %, EPA %',
    (SELECT count(*) FROM public.products WHERE btrim(product_name) = '' OR product_name <> btrim(product_name)),
    (SELECT count(*) FROM public.products WHERE sku IS NOT NULL AND (btrim(sku) = '' OR sku <> btrim(sku))),
    (SELECT count(*) FROM public.products WHERE epa_registration IS NOT NULL AND
       epa_registration !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$');
  -- Identify rows without printing catalog names or changing them.
  FOR v_bad IN
    SELECT id, 'product_name' AS field FROM public.products
      WHERE btrim(product_name) = '' OR product_name <> btrim(product_name)
    UNION ALL SELECT id, 'sku' FROM public.products
      WHERE sku IS NOT NULL AND (btrim(sku) = '' OR sku <> btrim(sku))
    UNION ALL SELECT id, 'rate_per_acre' FROM public.products WHERE rate_per_acre < 0
    UNION ALL SELECT id, 'epa_registration' FROM public.products
      WHERE epa_registration IS NOT NULL AND
        epa_registration !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$'
    UNION ALL SELECT id, 'rei_hours' FROM public.products WHERE rei_hours < 0
    UNION ALL SELECT id, 'phi_days' FROM public.products WHERE phi_days < 0
    ORDER BY field, id
  LOOP
    RAISE NOTICE 'Product setup cleanup: product id %, field %', v_bad.id, v_bad.field;
  END LOOP;
END;
$preflight$;

CREATE TABLE public.product_categories (
  name text PRIMARY KEY CHECK (btrim(name) <> '' AND name = btrim(name)),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_categories OWNER TO postgres;
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_categories_select ON public.product_categories
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.product_categories FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_categories TO authenticated;
CREATE TRIGGER set_product_categories_updated_at BEFORE UPDATE ON public.product_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
INSERT INTO public.product_categories(name, sort_order) VALUES
  ('Adjuvant', 10), ('Biological', 20), ('Dry Water Soluble Fertilizer', 30),
  ('Foliar Fertilizer', 40), ('Fungicide', 50), ('Herbicide', 60),
  ('Insecticide', 70), ('Liquid Fertilizer', 80), ('Nitrogen Stabilizer', 90),
  ('Other', 100), ('Seed Treatment', 110), ('Seed', 120);

-- Existing invalid products do not block rollout. PostgreSQL still checks every new/updated row.
ALTER TABLE public.products
  ADD CONSTRAINT product_setup_category_fk FOREIGN KEY (category)
    REFERENCES public.product_categories(name) ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT product_setup_name_check CHECK (btrim(product_name) <> '' AND product_name = btrim(product_name)) NOT VALID,
  ADD CONSTRAINT product_setup_sku_check CHECK (sku IS NULL OR (btrim(sku) <> '' AND sku = btrim(sku))) NOT VALID,
  ADD CONSTRAINT product_setup_rate_check CHECK (rate_per_acre >= 0) NOT VALID,
  ADD CONSTRAINT product_setup_epa_check CHECK (epa_registration IS NULL OR
    epa_registration ~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$') NOT VALID,
  ADD CONSTRAINT product_setup_rei_check CHECK (rei_hours >= 0) NOT VALID,
  ADD CONSTRAINT product_setup_phi_check CHECK (phi_days >= 0) NOT VALID;
ALTER TABLE public.products VALIDATE CONSTRAINT product_setup_category_fk;

CREATE FUNCTION public.guard_product_category_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.category IS DISTINCT FROM OLD.category)
     AND NEW.category IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.product_categories
                  WHERE name = NEW.category AND NOT is_active) THEN
    RAISE EXCEPTION 'PRODUCT_CATEGORY_RETIRED: choose an active category' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_category_assignment() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_category_assignment()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trg_validate_product_category BEFORE INSERT OR UPDATE OF category ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_category_assignment();

-- Idempotency-body-check: exempt; the intent-bound sequence is the same as upsert_product_brand.
CREATE FUNCTION public.upsert_product_category(
  p_name text, p_is_active boolean, p_sort_order integer, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_name text := btrim(p_name);
  v_fingerprint text;
  v_replay jsonb;
  v_saved public.product_categories%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: upsert_product_category requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only an admin can change product categories' USING ERRCODE = '42501';
  END IF;
  IF v_name IS NULL OR v_name = '' THEN
    RAISE EXCEPTION 'PRODUCT_CATEGORY_NAME_REQUIRED: enter a category name' USING ERRCODE = '22023';
  END IF;
  IF p_is_active IS NULL OR p_sort_order IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_CATEGORY_FIELDS_REQUIRED: choose status and sort order' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'name', p_name, 'is_active', p_is_active, 'sort_order', p_sort_order));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'upsert_product_category', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;
  INSERT INTO public.product_categories(name, is_active, sort_order)
    VALUES (v_name, p_is_active, p_sort_order)
    ON CONFLICT (name) DO UPDATE SET is_active = EXCLUDED.is_active, sort_order = EXCLUDED.sort_order
    RETURNING * INTO v_saved;
  v_result := to_jsonb(v_saved);
  PERFORM public.save_idempotency(p_idempotency_key, 'upsert_product_category', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'upsert_product_category', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.upsert_product_category(text, boolean, integer, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_product_category(text, boolean, integer, text)
  FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.upsert_product_category(text, boolean, integer, text) TO authenticated;

DO $postflight$
DECLARE v_policy pg_policy%ROWTYPE;
BEGIN
  IF NOT (SELECT relrowsecurity AND relowner = 'postgres'::regrole FROM pg_class
          WHERE oid = 'public.product_categories'::regclass) THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_POSTFLIGHT: category table owner or RLS';
  END IF;
  SELECT * INTO v_policy FROM pg_policy WHERE polrelid = 'public.product_categories'::regclass;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_categories'::regclass) <> 1
     OR v_policy.polname <> 'product_categories_select' OR v_policy.polcmd <> 'r'
     OR v_policy.polroles <> ARRAY['authenticated'::regrole::oid]
     OR position('is_active_profile()' IN pg_get_expr(v_policy.polqual, v_policy.polrelid)) = 0 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_POSTFLIGHT: active-profile SELECT policy';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.product_categories', 'SELECT')
     OR has_table_privilege('authenticated', 'public.product_categories', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('anon', 'public.product_categories', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('service_role', 'public.product_categories', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('metabase_ro', 'public.product_categories', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_POSTFLIGHT: table privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.products'::regclass
                 AND conname = 'product_setup_category_fk' AND convalidated AND confupdtype = 'c')
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.products'::regclass
          AND conname LIKE 'product_setup_%' AND contype = 'c' AND NOT convalidated) <> 6 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_POSTFLIGHT: FK or forward checks';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
       AND tgname IN ('trg_normalize_product_category','trg_validate_product_category') AND tgenabled = 'O') <> 2
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.product_categories'::regclass
       AND tgname = 'set_product_categories_updated_at' AND tgenabled = 'O') <> 1 THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_POSTFLIGHT: trigger order or availability';
  END IF;
  IF NOT (SELECT prosecdef AND proowner = 'postgres'::regrole AND proconfig = ARRAY['search_path=public, pg_temp']
          FROM pg_proc WHERE oid = 'public.upsert_product_category(text,boolean,integer,text)'::regprocedure)
     OR NOT has_function_privilege('authenticated', 'public.upsert_product_category(text,boolean,integer,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.upsert_product_category(text,boolean,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_POSTFLIGHT: RPC access';
  END IF;
END;
$postflight$;
