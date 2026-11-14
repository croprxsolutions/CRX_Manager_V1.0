-- KI-16 last gap: a fluid ounce on a DRY product (contract: docs/plans/2026-11-10-ki16-dry-fluid-ounce-CONTRACT.md).
--
-- WHY: normalize_rate_unit maps 'fl oz', 'floz' and 'fluid ounce' (any spacing, any per-acre suffix) to 'oz', and
--   field_app_priced_quantity's DRY branch sizes 'oz' as a weight ounce, so a dry product's 16 fl oz bills, holds and
--   deducts as 16 dry oz = 1 lb. save_job refuses it (CHEM_UNIT_FORM_MISMATCH, 20260904185900); scheduling from a
--   booking, recipes, blend ticket lines and a product's own rate unit did not. Changing the normalizer instead would
--   turn the wrong amount into a raw-quantity fallback on job holds and job stock deduction.
--
-- WHAT: #1741's unit_names_fluid_ounce (20270101000000, save_job's concept test) also drops a leading package count
--   ('32 fl oz', '2.5 fl oz': a product size or a typed quantity unit), and four BEFORE row
--   triggers that refuse storing a fluid-ounce unit against a dry product, so no bill, hold or stock deduction can
--   read one:
--   * job_chemicals: unit or rate_unit (every writer: save_job, create_job_from_quote_section, load_recipe_into_job).
--   * blend_ticket_products: unit (blend stock deduction) or the unit billing uses, NULLIF(btrim(rate_per_acre_unit),
--     ''), else the product's rate_unit.
--   * quote_items (bookings): rate_unit or price_unit, so a dry fluid-ounce booking line is refused when saved.
--   * products: a dry product's rate_unit, unit_size or inventory_unit; and every product must have a form
--     (Mason 2026-11-10: "require a form"). products.product_form becomes NOT NULL. guard_product_setup_fields
--     (20261102102000) already refuses changing a saved form, so with no blank forms a product's form never changes:
--     no line can be re-read under a new form, and the line checks need no lock against a product turning dry.
--   The trigger functions only read; they are SECURITY DEFINER so RLS never hides a row from the check, and no role
--   may EXECUTE them.
--
-- LIVE EVIDENCE (read-only, 2026-11-10): 0 rows in job_chemicals.unit/rate_unit, blend_ticket_products.unit/
--   rate_per_acre_unit, products.rate_unit, quote_items.rate_unit/price_unit or blend_recipe_items.unit pass the
--   concept test, on any form; blend_tickets has 0 rows; job_chemicals has 4 rows, all liquid; 0 of 606 products
--   have no product_form. Product parents already require a form (product_parents.product_form NOT NULL), so only
--   the spreadsheet import (apply_product_setup) could still create a product with a blank form; it is now refused.
--
-- idempotency-body-check: exempt -- no RPC is added or changed; the triggers only refuse, inside the caller's
--   transaction, so a refused RPC rolls back with its idempotency record.
-- caller-analysis: unit_names_fluid_ounce :: replaced (same signature, grants kept); live callers are #1741's
--   guard_blend_ticket_product_rate_unit and guard_product_rate_unit_for_blend_lines, which both refuse only a
--   DRY product, so a package-count spelling is now refused there too; plus the four triggers below.
-- caller-analysis: job_chemicals / blend_ticket_products / quote_items / products writers :: a write naming a fluid ounce on a dry
--   product now raises CHEM_UNIT_FORM_MISMATCH; every other write is unchanged (0 live rows affected).
--
-- ROLLBACK (its own reviewed migration): DROP the four triggers and their four functions; restore 20270101000000's
--   unit_names_fluid_ounce body;
--   ALTER products.product_form DROP NOT NULL. No data changes.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  -- This file relies on 20270101000000's unit_fold_invisible (tabs fold to a space) and dotted fl. oz mapping.
  IF to_regprocedure('public.unit_fold_invisible(text)') IS NULL
     OR public.unit_fold_invisible('fl' || chr(9) || 'oz') IS DISTINCT FROM 'fl oz'
     OR public.normalize_rate_unit('fl. oz') IS DISTINCT FROM 'fl oz' THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_PREFLIGHT: 20270101000000 (KI-16 follow-ups) is not applied; nothing was changed.';
  END IF;
  -- The helper this file widens, and #1741's two guards that call it, exactly as live (md5 read 2026-11-10).
  IF to_regprocedure('public.unit_names_fluid_ounce(text)') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.unit_names_fluid_ounce(text)'::regprocedure)
        IS DISTINCT FROM 'ab8814259efbfd8d8158d0061b1022cf'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.guard_blend_ticket_product_rate_unit()'::regprocedure)
        IS DISTINCT FROM '2db3051cdaeb7f902cde477445c07af9'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.guard_product_rate_unit_for_blend_lines()'::regprocedure)
        IS DISTINCT FROM '7aec8c0caf2ff392288bfcdb82ee7adb' THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_PREFLIGHT: unit_names_fluid_ounce or a #1741 guard is not the reviewed body; nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.products WHERE product_form IS NULL) THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_PREFLIGHT: a product has no form (liquid, dry, seed or each); set it before applying; nothing was changed.';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.unit_names_fluid_ounce(p_unit text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- save_job's rule (20260904185900): reduce the unit to what it names (fold separators keeping '/', drop from the
  -- first '/', drop a 'per ...' tail, delete every non-alphanumeric), then match the concept, not a spelling list.
  -- Also drops a leading package count ('32 fl oz', '2.5 fl oz', '1/2 fl oz', '1 1/2 fl oz'), which save_job's rule does not.
  SELECT regexp_replace(
           regexp_replace(
             split_part(
               regexp_replace(btrim(regexp_replace(lower(public.unit_fold_invisible(COALESCE(p_unit, ''))), '[^a-z0-9/]+', ' ', 'g')),
                              '^[0-9]+([ /][0-9]+)* ?', ''),
               '/', 1),
             '\s+per\s+.*$', ''),
           '[^a-z0-9]', '', 'g')
         ~ '^(fl|fluid)(oz|ozs|ounce|ounces)$';
$function$;

REVOKE EXECUTE ON FUNCTION public.unit_names_fluid_ounce(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unit_names_fluid_ounce(text) TO authenticated, service_role;

CREATE FUNCTION public.guard_job_chemical_dry_fluid_ounce()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_form text;
  v_name text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.unit IS NOT DISTINCT FROM OLD.unit
     AND NEW.rate_unit IS NOT DISTINCT FROM OLD.rate_unit
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    RETURN NEW;
  END IF;
  IF NEW.product_id IS NULL
     OR NOT (public.unit_names_fluid_ounce(NEW.unit) OR public.unit_names_fluid_ounce(NEW.rate_unit)) THEN
    RETURN NEW;
  END IF;
  SELECT lower(p.product_form::text), p.product_name INTO v_form, v_name FROM public.products p WHERE p.id = NEW.product_id;
  -- A product another transaction is still inserting is invisible here, but the foreign key would wait for it and
  -- accept the line (Sol v2 round 1 HIGH): a fluid-ounce line on a product this check cannot see is refused.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHEM_UNIT_FORM_MISMATCH: the product on this line is not saved yet, so a fluid-ounce unit cannot be checked against its form. Save the product first, then this line.';
  END IF;
  IF v_form = 'dry' THEN
    RAISE EXCEPTION
      'CHEM_UNIT_FORM_MISMATCH: % is a DRY product, so it cannot be measured or priced in fluid ounces -- a fluid ounce measures volume and a dry product is billed by weight, so a rate in "%" with a quantity in "%" cannot be converted. Re-enter the rate and the quantity in a dry unit (oz, lb or ton); if this line came from a booking or a recipe, correct it there.',
      COALESCE(NULLIF(btrim(v_name), ''), 'This product'), COALESCE(NEW.rate_unit, ''), COALESCE(NEW.unit, '');
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.guard_job_chemical_dry_fluid_ounce() FROM PUBLIC, anon, authenticated, service_role;

-- Named to sort after trg_guard_seed_each_job_chemical_units and trg_job_chemicals_rate_unit_guard.
CREATE TRIGGER trg_job_chemicals_zz_dry_fluid_ounce_guard
  BEFORE INSERT OR UPDATE ON public.job_chemicals
  FOR EACH ROW EXECUTE FUNCTION public.guard_job_chemical_dry_fluid_ounce();

CREATE FUNCTION public.guard_blend_ticket_product_dry_fluid_ounce()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_form      text;
  v_name      text;
  v_prod_rate text;
  v_rate      text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.unit IS NOT DISTINCT FROM OLD.unit
     AND NEW.rate_per_acre_unit IS NOT DISTINCT FROM OLD.rate_per_acre_unit
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    RETURN NEW;
  END IF;
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  SELECT lower(p.product_form::text), p.product_name, p.rate_unit INTO v_form, v_name, v_prod_rate
    FROM public.products p WHERE p.id = NEW.product_id;
  IF NOT FOUND AND (public.unit_names_fluid_ounce(NEW.unit) OR public.unit_names_fluid_ounce(NEW.rate_per_acre_unit)) THEN
    -- See guard_job_chemical_dry_fluid_ounce: an invisible (still inserting) product cannot be checked.
    RAISE EXCEPTION 'CHEM_UNIT_FORM_MISMATCH: the product on this line is not saved yet, so a fluid-ounce unit cannot be checked against its form. Save the product first, then this line.';
  END IF;
  IF v_form IS DISTINCT FROM 'dry' THEN RETURN NEW; END IF;
  -- The unit billing uses (create_invoice_from_blend_ticket), and the unit stock deduction uses (btp.unit).
  v_rate := COALESCE(NULLIF(btrim(NEW.rate_per_acre_unit), ''), v_prod_rate);
  IF public.unit_names_fluid_ounce(v_rate) OR public.unit_names_fluid_ounce(NEW.unit) THEN
    RAISE EXCEPTION
      'CHEM_UNIT_FORM_MISMATCH: % is a DRY product, so it cannot be measured or priced in fluid ounces -- a fluid ounce measures volume and a dry product is billed by weight, so a rate in "%" with a quantity in "%" cannot be converted.%',
      COALESCE(NULLIF(btrim(NEW.product_name), ''), NULLIF(btrim(v_name), ''), 'This product'), COALESCE(v_rate, ''), COALESCE(NEW.unit, ''),
      CASE WHEN NULLIF(btrim(NEW.rate_per_acre_unit), '') IS NULL AND public.unit_names_fluid_ounce(v_prod_rate)
           THEN ' This line has no rate unit, so the product''s default was used: enter a dry per-acre rate unit (oz, lb or ton) on the line.'
           ELSE ' Re-enter the rate and quantity in a dry unit (oz, lb or ton).' END;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.guard_blend_ticket_product_dry_fluid_ounce() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_zz_blend_ticket_products_dry_fluid_ounce_guard
  BEFORE INSERT OR UPDATE ON public.blend_ticket_products
  FOR EACH ROW EXECUTE FUNCTION public.guard_blend_ticket_product_dry_fluid_ounce();

CREATE FUNCTION public.guard_product_dry_fluid_ounce()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name text := COALESCE(NULLIF(btrim(NEW.product_name), ''), 'This product');
BEGIN
  -- Every product has a form (the NOT NULL below); say so in words before the constraint does.
  IF NEW.product_form IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_SETUP_INVALID: % needs a product form (liquid, dry, seed or each) -- it decides how its units are measured and billed.', v_name
      USING ERRCODE = '22023';
  END IF;
  IF lower(NEW.product_form::text) IS DISTINCT FROM 'dry' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.rate_unit IS NOT DISTINCT FROM OLD.rate_unit
     AND NEW.unit_size IS NOT DISTINCT FROM OLD.unit_size
     AND NEW.inventory_unit IS NOT DISTINCT FROM OLD.inventory_unit
     AND NEW.product_form IS NOT DISTINCT FROM OLD.product_form THEN
    RETURN NEW;
  END IF;
  -- Its own units: rate_unit is a blank blend line's rate; unit_size/inventory_unit are the stock side.
  IF public.unit_names_fluid_ounce(NEW.rate_unit)
     OR public.unit_names_fluid_ounce(NEW.unit_size)
     OR public.unit_names_fluid_ounce(NEW.inventory_unit) THEN
    RAISE EXCEPTION
      'CHEM_UNIT_FORM_MISMATCH: % is a DRY product, so its rate unit or stock unit cannot be fluid ounces (rate "%", unit "%", stock "%") -- a fluid ounce measures volume and a dry product is billed by weight. Use a dry unit (oz, lb or ton).',
      v_name, COALESCE(NEW.rate_unit, ''), COALESCE(NEW.unit_size, ''), COALESCE(NEW.inventory_unit, '');
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.guard_product_dry_fluid_ounce() FROM PUBLIC, anon, authenticated, service_role;

-- Named to sort after every other BEFORE trigger on products (live: trigger_zzzz_products_rate_unit_blend_guard).
CREATE TRIGGER trigger_zzzzz_products_dry_fluid_ounce_guard
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_dry_fluid_ounce();

-- Every product has a form, so a saved form never changes (guard_product_setup_fields) and nothing is re-read.
ALTER TABLE public.products ALTER COLUMN product_form SET NOT NULL;

-- Bookings: refused when saved, so a dry fluid-ounce line never reaches scheduling (the job trigger refuses it there too).
CREATE FUNCTION public.guard_quote_item_dry_fluid_ounce()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_form text;
  v_name text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.rate_unit IS NOT DISTINCT FROM OLD.rate_unit
     AND NEW.price_unit IS NOT DISTINCT FROM OLD.price_unit
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    RETURN NEW;
  END IF;
  IF NEW.product_id IS NULL
     OR NOT (public.unit_names_fluid_ounce(NEW.rate_unit) OR public.unit_names_fluid_ounce(NEW.price_unit)) THEN
    RETURN NEW;
  END IF;
  SELECT lower(p.product_form::text), p.product_name INTO v_form, v_name FROM public.products p WHERE p.id = NEW.product_id;
  -- A product another transaction is still inserting is invisible here, but the foreign key would wait for it and
  -- accept the line (Sol v2 round 1 HIGH): a fluid-ounce line on a product this check cannot see is refused.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHEM_UNIT_FORM_MISMATCH: the product on this line is not saved yet, so a fluid-ounce unit cannot be checked against its form. Save the product first, then this line.';
  END IF;
  IF v_form = 'dry' THEN
    RAISE EXCEPTION
      'CHEM_UNIT_FORM_MISMATCH: % is a DRY product, so a booking line cannot measure or price it in fluid ounces (rate "%", priced per "%") -- a fluid ounce measures volume and a dry product is billed by weight. Use a dry unit (oz, lb or ton).',
      COALESCE(NULLIF(btrim(v_name), ''), 'This product'), COALESCE(NEW.rate_unit, ''), COALESCE(NEW.price_unit, '');
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.guard_quote_item_dry_fluid_ounce() FROM PUBLIC, anon, authenticated, service_role;

-- Named to sort after every other BEFORE trigger on quote_items (live: zz_crx_below_cost_quote_items).
CREATE TRIGGER zzz_quote_items_dry_fluid_ounce_guard
  BEFORE INSERT OR UPDATE ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote_item_dry_fluid_ounce();

DO $postflight$
DECLARE
  v_unit text;
BEGIN
  -- Every fluid-ounce spelling save_job refuses, and none of the dry units it accepts.
  FOREACH v_unit IN ARRAY ARRAY['fl oz', 'FL OZ', 'floz', 'fl oz/ac', 'FLOZ/acre', 'fl. oz', 'fl.oz/a', 'fl oz.',
      'fluid ounce', 'Fluid Ounces per acre', 'fl-oz', 'fl_oz', 'fl ozs', 'fl' || chr(160) || 'oz', 'fl' || chr(8203) || 'oz',
      'fl' || chr(8208) || 'oz', 'fl' || chr(9) || 'oz/ac', ' fl oz ', 'fl oz/cwt', '32 fl oz', '2.5 fl oz', '1,000 FLOZ'] LOOP
    IF NOT public.unit_names_fluid_ounce(v_unit) THEN
      RAISE EXCEPTION 'KI16_DRY_FLOZ_POSTFLIGHT: unit_names_fluid_ounce misses "%"', v_unit;
    END IF;
  END LOOP;
  FOREACH v_unit IN ARRAY ARRAY['oz', 'OZ/ac', 'dry oz', 'Dry oz/acre', 'lb', 'lbs/ac', 'ton', 'mg', 'g', 'gal', 'pt/ac',
      'flour oz', 'oz fl', '', ' ', '32 oz', '2.5 lb', '32'] LOOP
    IF public.unit_names_fluid_ounce(v_unit) THEN
      RAISE EXCEPTION 'KI16_DRY_FLOZ_POSTFLIGHT: unit_names_fluid_ounce flags "%"', v_unit;
    END IF;
  END LOOP;
  IF public.unit_names_fluid_ounce(NULL) THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_POSTFLIGHT: unit_names_fluid_ounce flags NULL';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('trg_job_chemicals_zz_dry_fluid_ounce_guard', 'trg_zz_blend_ticket_products_dry_fluid_ounce_guard',
                        'trigger_zzzzz_products_dry_fluid_ounce_guard', 'zzz_quote_items_dry_fluid_ounce_guard')
         AND tgenabled = 'O') <> 4 THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_POSTFLIGHT: guard triggers are missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.unit_names_fluid_ounce(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.unit_names_fluid_ounce(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.unit_names_fluid_ounce(text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r(role),
                       unnest(ARRAY['public.guard_job_chemical_dry_fluid_ounce()', 'public.guard_blend_ticket_product_dry_fluid_ounce()',
                                    'public.guard_product_dry_fluid_ounce()', 'public.guard_quote_item_dry_fluid_ounce()']) f(fn)
                 WHERE has_function_privilege(r.role, f.fn, 'EXECUTE')) THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_POSTFLIGHT: grants are not as reviewed';
  END IF;
  -- The checks run as the function owner; it must see every row (BYPASSRLS), as postgres does live.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
              WHERE p.oid IN ('public.guard_job_chemical_dry_fluid_ounce()'::regprocedure, 'public.guard_blend_ticket_product_dry_fluid_ounce()'::regprocedure,
                              'public.guard_product_dry_fluid_ounce()'::regprocedure, 'public.guard_quote_item_dry_fluid_ounce()'::regprocedure)
                AND NOT (r.rolbypassrls OR r.rolsuper)) THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_POSTFLIGHT: the guard functions are owned by a role that RLS can filter';
  END IF;
  IF NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.products'::regclass AND attname = 'product_form') THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_POSTFLIGHT: products.product_form is not NOT NULL';
  END IF;
  -- Every stored row passes its new guard.
  IF EXISTS (SELECT 1 FROM public.job_chemicals jc JOIN public.products p ON p.id = jc.product_id
              WHERE lower(p.product_form::text) = 'dry'
                AND (public.unit_names_fluid_ounce(jc.unit) OR public.unit_names_fluid_ounce(jc.rate_unit)))
     OR EXISTS (SELECT 1 FROM public.blend_ticket_products b JOIN public.products p ON p.id = b.product_id
                 WHERE lower(p.product_form::text) = 'dry'
                   AND (public.unit_names_fluid_ounce(b.unit)
                        OR public.unit_names_fluid_ounce(COALESCE(NULLIF(btrim(b.rate_per_acre_unit), ''), p.rate_unit))))
     OR EXISTS (SELECT 1 FROM public.quote_items qi JOIN public.products p ON p.id = qi.product_id
                 WHERE lower(p.product_form::text) = 'dry'
                   AND (public.unit_names_fluid_ounce(qi.rate_unit) OR public.unit_names_fluid_ounce(qi.price_unit)))
     OR EXISTS (SELECT 1 FROM public.products p
                 WHERE lower(p.product_form::text) = 'dry'
                   AND (public.unit_names_fluid_ounce(p.rate_unit)
                        OR public.unit_names_fluid_ounce(p.unit_size)
                        OR public.unit_names_fluid_ounce(p.inventory_unit))) THEN
    RAISE EXCEPTION 'KI16_DRY_FLOZ_POSTFLIGHT: an existing dry product line or product names a fluid ounce; review it before applying';
  END IF;
END;
$postflight$;
