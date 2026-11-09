-- RT-2 step 1 companion: the field-app gal/lb equivalent reads "Dry oz" on a dry product as pounds / 16.
--
-- WHY: convert_to_gl_lb gives a field job's chemical line its gallon (liquid) or pound (dry) equivalent, which
-- the job-to-invoice transfer and the field-app invoice save copy onto the invoice line. Its dry branch knows
-- "oz" but not "Dry oz", so the 76 live products whose rate unit is "Dry oz" get no pound figure (NULL, the
-- screen shows a dash). RT-2 step 1 (20261227100000) moves two more dry products from "oz" to "Dry oz";
-- without this they would lose the pound figure they show today. Mason, 2026-11-09: these products are
-- priced by the pound, so the figure must be pounds.
--
-- WHAT: one new case in the dry branch, 'DRY OZ' -> value / 16, unit 'LB'. Every other input returns exactly
-- what it returned before. The liquid branch is unchanged, so "Dry oz" on a liquid product stays NULL (a unit
-- of the wrong form is never guessed). Callers only store the returned pair (no branch, no money math):
-- _transfer_job_to_invoice_intent_impl_20260908 and _save_field_app_invoice_impl_20260714. Saved invoice and
-- job lines are history and are not recomputed. src/lib/chemCalculator.ts toGallonOrLbEquivalent gains the same
-- case so the on-screen preview equals the saved figure.
--
-- SAFETY: CREATE OR REPLACE keeps the owner and grants. The preflight refuses unless the live body is the
-- reviewed one (20261104150000), so a body changed by anyone since is never overwritten.
DO $preflight$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.convert_to_gl_lb(numeric, text, text)'::regprocedure)
     IS DISTINCT FROM '0eb4daca9c04701975f88394beed4b8c' THEN
    RAISE EXCEPTION 'GLLB_DRY_OZ_BODY_DRIFT: convert_to_gl_lb is not the reviewed body; nothing was changed.';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.convert_to_gl_lb(p_total_applied numeric, p_rate_unit text, p_product_form text)
 RETURNS TABLE(converted_value numeric, converted_unit text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_total_applied IS NULL OR p_rate_unit IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::text;
    RETURN;
  END IF;

  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN QUERY SELECT NULL::numeric, NULL::text; RETURN; END IF;
  IF p_product_form = 'dry' THEN
    CASE upper(p_rate_unit)
      WHEN 'OZ', 'DRY OZ', 'OUNCE', 'OUNCES' THEN converted_value := p_total_applied / 16.0; converted_unit := 'LB';
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
  'PT=q/8, QT=q/4, GL/GAL/GALLON/GALLONS=q. Dry: OZ or DRY OZ=q/16, LB=q. An unrecognized unit '
  'returns NULL value+unit (UI shows a dash) — never a guessed number. Seed/each return NULL value+unit. Matches '
  'src/lib/chemCalculator.ts toGallonOrLbEquivalent.';

DO $postflight$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.convert_to_gl_lb(16, 'Dry oz', 'dry');
  IF r.converted_value IS DISTINCT FROM 1 OR r.converted_unit IS DISTINCT FROM 'LB' THEN
    RAISE EXCEPTION 'GLLB_DRY_OZ_POSTFLIGHT: 16 Dry oz on a dry product is not 1 LB';
  END IF;
  SELECT * INTO r FROM public.convert_to_gl_lb(16, 'oz', 'dry');
  IF r.converted_value IS DISTINCT FROM 1 OR r.converted_unit IS DISTINCT FROM 'LB' THEN
    RAISE EXCEPTION 'GLLB_DRY_OZ_POSTFLIGHT: 16 oz on a dry product is no longer 1 LB';
  END IF;
  SELECT * INTO r FROM public.convert_to_gl_lb(128, 'oz', 'liquid');
  IF r.converted_value IS DISTINCT FROM 1 OR r.converted_unit IS DISTINCT FROM 'GL' THEN
    RAISE EXCEPTION 'GLLB_DRY_OZ_POSTFLIGHT: 128 oz on a liquid product is no longer 1 GL';
  END IF;
  SELECT * INTO r FROM public.convert_to_gl_lb(16, 'Dry oz', 'liquid');
  IF r.converted_value IS NOT NULL OR r.converted_unit IS NOT NULL THEN
    RAISE EXCEPTION 'GLLB_DRY_OZ_POSTFLIGHT: Dry oz on a liquid product must stay unconverted';
  END IF;
  IF NOT (has_function_privilege('anon', 'public.convert_to_gl_lb(numeric, text, text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.convert_to_gl_lb(numeric, text, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.convert_to_gl_lb(numeric, text, text)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'GLLB_DRY_OZ_POSTFLIGHT: grants changed';
  END IF;
END;
$postflight$;
