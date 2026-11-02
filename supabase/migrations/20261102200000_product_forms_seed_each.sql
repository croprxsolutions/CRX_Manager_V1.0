-- Add Seed and Each / unit product forms with exact allowed inventory and container units.
-- ROUTINE: a new table with its own grants, a superset CHECK, three function replacements,
-- and a new trigger function and trigger on an existing table.
-- No grants or policies change on existing tables; no data is deleted.
-- Rollback: restore the liquid/dry CHECK only after confirming no seed/each product exists;
-- re-create validate_product_units from 20260211000000_unit_tracking_pricing_overhaul.sql,
-- field_app_priced_quantity from 20260630180000_field_app_pricing_unit_fix.sql,
-- convert_to_gl_lb from 20260702133000_a14_convert_to_gl_lb_pint_quart_aliases.sql;
-- drop trg_guard_seed_each_quote_item_units on public.quote_items and
-- public.guard_seed_each_quote_item_units(); then drop public.product_form_units.

ALTER TABLE public.products DROP CONSTRAINT products_product_form_check;
ALTER TABLE public.products ADD CONSTRAINT products_product_form_check
  CHECK (product_form = ANY (ARRAY['liquid','dry','seed','each']));

CREATE TABLE public.product_form_units (
  product_form text NOT NULL CHECK (product_form IN ('seed','each')),
  unit text NOT NULL REFERENCES public.unit_conversions(unit),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_form, unit)
);
COMMENT ON TABLE public.product_form_units IS 'Exact allowed inventory and container units for seed and each products; changed only by migration.';
ALTER TABLE public.product_form_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_form_units_select ON public.product_form_units
  FOR SELECT TO authenticated USING (true);
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
     AND NULLIF(btrim(NEW.rate_unit), '') IS NOT NULL
     AND NULLIF(btrim(NEW.inventory_unit), '') IS NOT NULL
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
REVOKE ALL ON FUNCTION public.guard_seed_each_quote_item_units() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_guard_seed_each_quote_item_units
  BEFORE INSERT OR UPDATE OF product_id, rate_unit, price_unit ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_seed_each_quote_item_units();

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
END $postflight$;
