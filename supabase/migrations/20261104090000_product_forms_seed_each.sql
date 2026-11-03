-- Add Seed and Each / unit product forms with exact allowed inventory and container units.
-- ROUTINE: a new table with its own grants, a superset CHECK, three function replacements,
-- and two new trigger functions with triggers on existing tables (quote_items, job_chemicals).
-- No grants or policies change on existing tables; no data is deleted.
-- Rollback: restore the liquid/dry CHECK only after confirming no seed/each product exists;
-- re-create validate_product_units from 20260211000000_unit_tracking_pricing_overhaul.sql,
-- field_app_priced_quantity from 20260630180000_field_app_pricing_unit_fix.sql,
-- convert_to_gl_lb from 20260702133000_a14_convert_to_gl_lb_pint_quart_aliases.sql;
-- drop trg_guard_seed_each_quote_item_units on public.quote_items and
-- public.guard_seed_each_quote_item_units(); drop trg_guard_seed_each_job_chemical_units on
-- public.job_chemicals and public.guard_seed_each_job_chemical_units(); then drop public.product_form_units.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.field_app_priced_quantity(numeric,text,text,text)')) IS DISTINCT FROM 'bc91a52577840973f18f1710e47edf2b'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.convert_to_gl_lb(numeric,text,text)')) IS DISTINCT FROM 'ce9265521821c09b0cf74de45afb375b'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.validate_product_units()')) IS DISTINCT FROM '83a51c58c83cd83bea760bd117410a38' THEN
    RAISE EXCEPTION 'PRODUCT_FORMS_SOURCE_BODY_DRIFT';
  END IF;
END $preflight$;

ALTER TABLE public.products DROP CONSTRAINT products_product_form_check;
ALTER TABLE public.products ADD CONSTRAINT products_product_form_check
  CHECK (product_form = ANY (ARRAY['liquid','dry','seed','each']));

CREATE TABLE public.product_form_units (
  product_form text NOT NULL CHECK (product_form IN ('seed','each')),
  unit text NOT NULL REFERENCES public.unit_conversions(unit),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_form, unit)
);
ALTER TABLE public.product_form_units OWNER TO postgres;
COMMENT ON TABLE public.product_form_units IS 'Exact allowed inventory and container units for seed and each products; changed only by migration.';
ALTER TABLE public.product_form_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_form_units_select ON public.product_form_units
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.product_form_units FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_form_units TO authenticated, service_role;

INSERT INTO public.product_form_units (product_form, unit)
SELECT v.form, uc.unit FROM (VALUES ('seed','Lb'),('seed','Unit'),('each','Ea'),('each','Unit')) v(form, unit)
JOIN public.unit_conversions uc ON uc.unit = v.unit ON CONFLICT DO NOTHING;
DO $notice$ BEGIN
  RAISE NOTICE 'product_form_units rule rows present: %', (SELECT count(*) FROM public.product_form_units);
END $notice$;

CREATE OR REPLACE FUNCTION public.validate_product_units()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  -- Normalise blank seed/each rate units as well as validating their stock units.
  IF NEW.product_form IN ('seed','each') THEN
    IF NULLIF(btrim(NEW.inventory_unit), '') IS NULL THEN
      RAISE EXCEPTION 'A seed or each product needs a stock unit (inventory_unit).'
        USING ERRCODE = '22023';
    END IF;
    IF NULLIF(btrim(NEW.rate_unit), '') IS NULL THEN
      NEW.rate_unit := NEW.inventory_unit;
    END IF;
    -- BEFORE triggers run in name order: trg_validate_product_units precedes
    -- trigger_recalc_product_price_per_acre, so pricing sees the filled rate.
    -- A blank existing unit counts as different: pricing reads it as one ounce.
    IF TG_OP = 'UPDATE' AND OLD.product_form IS NULL AND EXISTS (
      SELECT 1 FROM public.quote_items qi WHERE qi.product_id = NEW.id
        AND (lower(btrim(coalesce(qi.rate_unit, ''))) <> lower(btrim(NEW.inventory_unit))
          OR lower(btrim(coalesce(qi.price_unit, ''))) <> lower(btrim(NEW.inventory_unit)))
    ) THEN
      RAISE EXCEPTION 'Existing quote lines use another unit; fix them before setting this form.'
        USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.product_form IS NULL AND EXISTS (
      SELECT 1 FROM public.job_chemicals jc WHERE jc.product_id = NEW.id
        AND (normalize_rate_unit(jc.unit) IS DISTINCT FROM normalize_rate_unit(NEW.inventory_unit)
          OR (normalize_rate_unit(jc.rate_unit) IS NOT NULL
              AND normalize_rate_unit(jc.rate_unit) <> normalize_rate_unit(NEW.inventory_unit)))
    ) THEN
      RAISE EXCEPTION 'Existing job lines use another unit; fix them before setting this form.'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  -- Validate inventory_unit matches product_form
  IF NEW.product_form IS NOT NULL AND NEW.inventory_unit IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM unit_conversions
      WHERE unit = NEW.inventory_unit
        AND (unit_type = NEW.product_form OR unit_type = 'both')
        AND NEW.product_form NOT IN ('seed','each')
    ) AND NOT EXISTS (
      SELECT 1 FROM product_form_units
      WHERE product_form = NEW.product_form AND unit = NEW.inventory_unit
    ) THEN
      RAISE EXCEPTION 'inventory_unit "%" is not valid for product_form "%"',
        NEW.inventory_unit, NEW.product_form;
    END IF;
  END IF;

  -- Validate container_unit matches product_form
  IF NEW.product_form IS NOT NULL AND NEW.container_unit IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM unit_conversions
      WHERE unit = NEW.container_unit
        AND (unit_type = NEW.product_form OR unit_type = 'both')
        AND NEW.product_form NOT IN ('seed','each')
    ) AND NOT EXISTS (
      SELECT 1 FROM product_form_units
      WHERE product_form = NEW.product_form AND unit = NEW.container_unit
    ) THEN
      RAISE EXCEPTION 'container_unit "%" is not valid for product_form "%"',
        NEW.container_unit, NEW.product_form;
    END IF;
  END IF;

  IF NEW.product_form IN ('seed','each')
     AND lower(btrim(NEW.rate_unit)) <> lower(btrim(NEW.inventory_unit)) THEN
    RAISE EXCEPTION 'rate_unit "%" must match inventory_unit "%" for product_form "%"',
      NEW.rate_unit, NEW.inventory_unit, NEW.product_form;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_seed_each_quote_item_units()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_product_form text;
  v_inventory_unit text;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;

  SELECT p.product_form, p.inventory_unit
    INTO v_product_form, v_inventory_unit
    FROM public.products p WHERE p.id = NEW.product_id;

  IF v_product_form IN ('seed','each') THEN
    IF NULLIF(btrim(NEW.rate_unit), '') IS NULL OR NULLIF(btrim(NEW.price_unit), '') IS NULL THEN
      RAISE EXCEPTION 'Seed and each quote lines need their unit set (%).', v_inventory_unit
        USING ERRCODE = '22023';
    END IF;
    IF (NULLIF(btrim(NEW.rate_unit), '') IS NOT NULL
        AND lower(btrim(NEW.rate_unit)) IS DISTINCT FROM lower(btrim(v_inventory_unit)))
       OR (NULLIF(btrim(NEW.price_unit), '') IS NOT NULL
        AND lower(btrim(NEW.price_unit)) IS DISTINCT FROM lower(btrim(v_inventory_unit))) THEN
      RAISE EXCEPTION 'Seed and each products are quoted only in their own unit (%); "%" can''t be converted.',
        v_inventory_unit,
        CASE WHEN NULLIF(btrim(NEW.rate_unit), '') IS NOT NULL
                  AND lower(btrim(NEW.rate_unit)) IS DISTINCT FROM lower(btrim(v_inventory_unit))
             THEN NEW.rate_unit ELSE NEW.price_unit END
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_seed_each_quote_item_units() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_seed_each_quote_item_units() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trg_guard_seed_each_quote_item_units
  BEFORE INSERT OR UPDATE OF product_id, rate_unit, price_unit ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_seed_each_quote_item_units();

-- Job completion deducts stock by converting jc.unit to the stock unit and falls back
-- to the raw number when it can't, so a seed/each line must already be in the stock unit.
CREATE FUNCTION public.guard_seed_each_job_chemical_units()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_product_form text;
  v_inventory_unit text;
BEGIN
  SELECT p.product_form, p.inventory_unit
    INTO v_product_form, v_inventory_unit
    FROM public.products p WHERE p.id = NEW.product_id;

  IF v_product_form IN ('seed','each') THEN
    -- A blank unit is filled from the stock unit, so completion deducts it exactly.
    IF normalize_rate_unit(NEW.unit) IS NULL THEN NEW.unit := v_inventory_unit; END IF;
    IF normalize_rate_unit(NEW.rate_unit) IS NULL THEN NEW.rate_unit := v_inventory_unit; END IF;
    IF normalize_rate_unit(NEW.unit) IS DISTINCT FROM normalize_rate_unit(v_inventory_unit)
       OR normalize_rate_unit(NEW.rate_unit) IS DISTINCT FROM normalize_rate_unit(v_inventory_unit) THEN
      RAISE EXCEPTION 'Seed and each job lines use only the product''s own unit (%); "%" can''t be converted.',
        v_inventory_unit,
        CASE WHEN normalize_rate_unit(NEW.unit) IS DISTINCT FROM normalize_rate_unit(v_inventory_unit)
             THEN NEW.unit ELSE NEW.rate_unit END
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.guard_seed_each_job_chemical_units() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_seed_each_job_chemical_units() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trg_guard_seed_each_job_chemical_units
  BEFORE INSERT OR UPDATE OF product_id, unit, rate_unit ON public.job_chemicals
  FOR EACH ROW EXECUTE FUNCTION public.guard_seed_each_job_chemical_units();

CREATE OR REPLACE FUNCTION public.field_app_priced_quantity(
  p_applied_qty numeric, p_rate_unit text, p_inventory_unit text, p_product_form text
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $fapq$
DECLARE
  r  text := lower(btrim(coalesce(p_rate_unit, '')));
  i  text := lower(btrim(coalesce(p_inventory_unit, '')));
  sr numeric;  -- size of the rate unit in the form's base unit
  si numeric;  -- size of the inventory unit in the form's base unit
BEGIN
  IF p_applied_qty IS NULL THEN RETURN NULL; END IF;
  IF r = i THEN RETURN p_applied_qty; END IF;            -- same unit: no conversion needed
  IF r = '' OR i = '' THEN RETURN NULL; END IF;
  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN NULL; END IF;  -- no conversions for seed/each
  IF lower(coalesce(p_product_form, '')) = 'dry' THEN
    -- Dry base = ounce. (dry oz == oz == 1; lb = 16; ton = 32000.)
    sr := CASE WHEN r IN ('oz','dry oz','ounce','ounces') THEN 1
               WHEN r IN ('lb','lbs','pound','pounds')    THEN 16
               WHEN r IN ('ton','tons')                   THEN 32000 ELSE NULL END;
    si := CASE WHEN i IN ('oz','dry oz','ounce','ounces') THEN 1
               WHEN i IN ('lb','lbs','pound','pounds')    THEN 16
               WHEN i IN ('ton','tons')                   THEN 32000 ELSE NULL END;
  ELSE
    -- Liquid base = fluid ounce. (oz/fl oz = 1; pt = 16; qt = 32; gal = 128.)
    -- NULL/unknown product_form is treated as liquid, matching convert_to_gl_lb.
    sr := CASE WHEN r IN ('oz','fl oz','floz','fluid ounce') THEN 1
               WHEN r IN ('pt','pint','pints')                THEN 16
               WHEN r IN ('qt','quart','quarts')              THEN 32
               WHEN r IN ('gl','gal','gallon','gallons')      THEN 128 ELSE NULL END;
    si := CASE WHEN i IN ('oz','fl oz','floz','fluid ounce') THEN 1
               WHEN i IN ('pt','pint','pints')                THEN 16
               WHEN i IN ('qt','quart','quarts')              THEN 32
               WHEN i IN ('gl','gal','gallon','gallons')      THEN 128 ELSE NULL END;
  END IF;
  IF sr IS NULL OR si IS NULL THEN RETURN NULL; END IF;  -- not convertible -> caller errors
  RETURN p_applied_qty * sr / si;                        -- qty in inventory (pricing) unit
END;
$fapq$;

CREATE OR REPLACE FUNCTION public.convert_to_gl_lb(p_total_applied numeric, p_rate_unit text, p_product_form text)
 RETURNS TABLE(converted_value numeric, converted_unit text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_total_applied IS NULL OR p_rate_unit IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::text;
    RETURN;
  END IF;

  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN QUERY SELECT NULL::numeric, NULL::text; RETURN; END IF;
  IF p_product_form = 'dry' THEN
    CASE upper(p_rate_unit)
      WHEN 'OZ', 'OUNCE', 'OUNCES' THEN converted_value := p_total_applied / 16.0; converted_unit := 'LB';
      WHEN 'LB', 'LBS', 'POUND', 'POUNDS' THEN converted_value := p_total_applied;  converted_unit := 'LB';
      WHEN 'TON', 'TONS' THEN converted_value := p_total_applied * 2000.0;          converted_unit := 'LB';
      ELSE converted_value := NULL; converted_unit := NULL;
    END CASE;
  ELSE
    CASE upper(p_rate_unit)
      WHEN 'OZ', 'FL OZ', 'FLOZ', 'FLUID OUNCE' THEN converted_value := p_total_applied / 128.0; converted_unit := 'GL';
      WHEN 'PT', 'PINT', 'PINTS' THEN converted_value := p_total_applied / 8.0;   converted_unit := 'GL';
      WHEN 'QT', 'QUART', 'QUARTS' THEN converted_value := p_total_applied / 4.0;   converted_unit := 'GL';
      WHEN 'GL', 'GAL', 'GALLON', 'GALLONS' THEN converted_value := p_total_applied; converted_unit := 'GL';
      ELSE converted_value := NULL; converted_unit := NULL;
    END CASE;
  END IF;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.convert_to_gl_lb(numeric, text, text) IS
  'Field-app gal/lb equivalent for tank planning (display only). Liquid: OZ=q/128, '
  'PT=q/8, QT=q/4, GL/GAL/GALLON/GALLONS=q. Dry: OZ=q/16, LB=q. An unrecognized unit '
  'returns NULL value+unit (UI shows a dash) — never a guessed number. Seed/each return NULL value+unit. Matches '
  'src/lib/chemCalculator.ts toGallonOrLbEquivalent.';

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.products'::regclass
        AND conname = 'products_product_form_check'
        AND pg_get_constraintdef(oid) LIKE '%liquid%'
        AND pg_get_constraintdef(oid) LIKE '%dry%'
        AND pg_get_constraintdef(oid) LIKE '%seed%'
        AND pg_get_constraintdef(oid) LIKE '%each%') THEN
    RAISE EXCEPTION 'PRODUCT_FORM_CHECK_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.product_form_units'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'PRODUCT_FORM_UNITS_RLS_MISSING';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_form_units'::regclass) <> 1 THEN
    RAISE EXCEPTION 'PRODUCT_FORM_UNITS_POLICY_COUNT';
  END IF;
  IF has_table_privilege('anon', 'public.product_form_units', 'SELECT') THEN
    RAISE EXCEPTION 'PRODUCT_FORM_UNITS_ANON_ACCESS';
  END IF;
  IF has_table_privilege('metabase_ro', 'public.product_form_units', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_function_privilege('metabase_ro', 'public.guard_seed_each_quote_item_units()', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public.guard_seed_each_job_chemical_units()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRODUCT_FORM_UNITS_METABASE_ACCESS';
  END IF;
  IF has_table_privilege('authenticated', 'public.product_form_units', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'PRODUCT_FORM_UNITS_WRITE_ACCESS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.guard_seed_each_quote_item_units()'::regprocedure
      AND prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'PRODUCT_FORM_QUOTE_GUARD_UNSAFE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quote_items'::regclass
      AND tgname = 'trg_guard_seed_each_quote_item_units' AND tgenabled IN ('O','A') AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PRODUCT_FORM_QUOTE_GUARD_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.guard_seed_each_job_chemical_units()'::regprocedure
      AND prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'PRODUCT_FORM_JOB_GUARD_UNSAFE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.job_chemicals'::regclass
      AND tgname = 'trg_guard_seed_each_job_chemical_units' AND tgenabled IN ('O','A') AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PRODUCT_FORM_JOB_GUARD_MISSING';
  END IF;
  IF (SELECT count(*) FROM public.unit_conversions WHERE unit IN ('Lb','Unit','Ea')) = 3 THEN
    IF (SELECT count(*) FROM public.product_form_units) <> 4
       OR EXISTS (
         (VALUES ('seed','Lb'),('seed','Unit'),('each','Ea'),('each','Unit'))
         EXCEPT SELECT product_form, unit FROM public.product_form_units
       ) THEN
      RAISE EXCEPTION 'PRODUCT_FORM_UNITS_RULE_ROWS_DRIFT';
    END IF;
  ELSE
    RAISE NOTICE 'Skipping product_form_units exact-row postflight: Lb, Unit, Ea are not all present';
  END IF;
END $postflight$;
