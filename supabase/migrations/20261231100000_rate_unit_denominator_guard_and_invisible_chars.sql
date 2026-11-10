-- KI-16 bullets 1-2 (contract: docs/plans/2026-11-10-ki16-rate-unit-denominator-and-invisible-chars-CONTRACT.md).
--
-- WHY:
--   1. save_job refuses a job chemical line whose rate unit is per something other than acres ('oz/cwt'):
--      quantity = rate x acres cannot be derived from it (CHEM_RATE_DENOMINATOR_NOT_ACRES, added 20260820120000;
--      live body _save_job_cost_step2_impl from 20260904185900, same text).
--      Other writers skip that rule: scheduling a job from a booking copies quote_items.rate_unit into
--      job_chemicals unchecked, load_recipe_into_job copies products.rate_unit, and a blend ticket line is
--      refused only when it is billed. Each now refuses at write time, with save_job's rule and message.
--   2. normalize_rate_unit trims ASCII spaces only, so a pasted 'oz<ZERO WIDTH SPACE>' matches no size
--      table and a blend ticket carrying it cannot be invoiced. Invisible characters are now folded.
--
-- WHAT:
--   * unit_fold_invisible(text): U+00A0, U+2007, U+202F become a space; U+00AD, U+200B, U+200C, U+200D,
--     U+2060, U+FEFF are deleted. The one list, shared by the normalizer and the new guard (save_job keeps its
--     own narrower fold and stays the stricter side).
--   * normalize_rate_unit: same body, with the fold applied before the trim. Every input without one of
--     those characters returns exactly what it returned before.
--   * rate_unit_line_refusal(rate_unit, check_characters): the invisible fold, then save_job's denominator
--     probe verbatim (so 'oz p<ZWSP>er cwt' cannot hide its 'per'), plus save_job's unsupported-character
--     probe when asked. Returns the refusal token or NULL.
--   * BEFORE INSERT/UPDATE triggers on job_chemicals and blend_ticket_products. They fire on every UPDATE
--     (so a value another BEFORE trigger sets is still judged) and compare OLD with NEW: a row whose judged
--     values did not change is never re-judged. Job lines check characters only when priced, as save_job
--     does. Blend lines check the unit billing will use: the line's own, or the product's rate unit when the
--     line's is blank (an invisible-only unit is stored as NULL so billing falls back the same way); they
--     check characters on product lines, which billing converts, not on free-text lines.
--
-- LIVE EVIDENCE (read-only, 2026-11-10): normalize_rate_unit prosrc md5 3a0e2e8f1ed5611ae7ee343d40a7b3ad,
--   owner postgres, IMMUTABLE, invoker, EXECUTE postgres/authenticated/service_role. No index, constraint or
--   generated column uses it. job_chemicals rate units: 'oz' x2, 'pt/ac', '32'; blend_ticket_products: 0 rows.
--   No quote_items, products or recipe-product rate unit would be refused either. Nothing existing is refused.
--
-- idempotency-body-check: exempt -- no RPC is added or changed; immutable helpers and row triggers only.
-- caller-analysis: normalize_rate_unit :: output changes only for inputs carrying the folded characters;
--   callers compare or size its result (save_job, blend invoice, holds, shortfalls, watchdog, product units,
--   guard_seed_each_job_chemical_units),
--   so such a unit now matches its plain spelling instead of matching nothing.
--
-- ROLLBACK: drop the two triggers and four new functions; re-create the 20260630170000 normalize_rate_unit
--   body. No data changes.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.normalize_rate_unit(text)'::regprocedure)
     IS DISTINCT FROM '3a0e2e8f1ed5611ae7ee343d40a7b3ad' THEN
    RAISE EXCEPTION 'KI16_RATE_UNIT_PREFLIGHT: normalize_rate_unit is not the reviewed 20260630170000 body; nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname IN ('trg_job_chemicals_rate_unit_guard', 'trg_blend_ticket_products_rate_unit_guard')) THEN
    RAISE EXCEPTION 'KI16_RATE_UNIT_PREFLIGHT: a rate-unit guard trigger already exists; nothing was changed.';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.unit_fold_invisible(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The first three map to a space (positional); the rest have no counterpart and are deleted.
  SELECT translate(p_text,
                   chr(160) || chr(8199) || chr(8239)
                   || chr(173) || chr(8203) || chr(8204) || chr(8205) || chr(8288) || chr(65279),
                   '   ');
$function$;

REVOKE EXECUTE ON FUNCTION public.unit_fold_invisible(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unit_fold_invisible(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.normalize_rate_unit(p_unit text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  raw  text := lower(btrim(public.unit_fold_invisible(COALESCE(p_unit, ''))));
  base text;
BEGIN
  IF raw = '' THEN RETURN NULL; END IF;
  IF raw ~ '\s*/\s*(ac|acre|acres|a)\s*$' THEN
    base := btrim(regexp_replace(raw, '\s*/\s*(ac|acre|acres|a)\s*$', ''));
  ELSIF raw ~ '\s+per\s+acre$' THEN
    base := btrim(regexp_replace(raw, '\s+per\s+acre$', ''));
  ELSIF position('/' IN raw) > 0 THEN
    -- A non-acre denominator present → keep the whole string so it can't match a bare unit.
    RETURN raw;
  ELSE
    base := raw;
  END IF;
  IF base = '' THEN RETURN NULL; END IF;
  RETURN CASE base
    WHEN 'oz'    THEN 'oz'  WHEN 'ounce'    THEN 'oz'  WHEN 'ounces'    THEN 'oz'
    WHEN 'fl oz' THEN 'oz'  WHEN 'floz'     THEN 'oz'  WHEN 'fluid ounce' THEN 'oz'
    WHEN 'pt'    THEN 'pt'  WHEN 'pint'     THEN 'pt'  WHEN 'pints'     THEN 'pt'
    WHEN 'qt'    THEN 'qt'  WHEN 'quart'    THEN 'qt'  WHEN 'quarts'    THEN 'qt'
    WHEN 'gal'   THEN 'gal' WHEN 'gallon'   THEN 'gal' WHEN 'gallons'   THEN 'gal' WHEN 'gl' THEN 'gal'
    WHEN 'lb'    THEN 'lb'  WHEN 'lbs'      THEN 'lb'  WHEN 'pound'     THEN 'lb'  WHEN 'pounds' THEN 'lb'
    WHEN 'ton'   THEN 'ton' WHEN 'tons'     THEN 'ton'
    WHEN 'g'     THEN 'g'   WHEN 'gram'     THEN 'g'   WHEN 'grams'     THEN 'g'
    WHEN 'kg'    THEN 'kg'  WHEN 'kilogram' THEN 'kg'  WHEN 'kilograms' THEN 'kg'
    WHEN 'l'     THEN 'l'   WHEN 'liter'    THEN 'l'   WHEN 'liters'    THEN 'l' WHEN 'litre' THEN 'l' WHEN 'litres' THEN 'l'
    WHEN 'ml'    THEN 'ml'
    ELSE base
  END;
END;
$function$;

-- normalize_rate_unit keeps its grants (CREATE OR REPLACE); restated so the file is self-describing.
REVOKE EXECUTE ON FUNCTION public.normalize_rate_unit(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.normalize_rate_unit(text) TO authenticated, service_role;

CREATE FUNCTION public.rate_unit_line_refusal(p_rate_unit text, p_check_characters boolean)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_raw   text := lower(btrim(public.unit_fold_invisible(COALESCE(p_rate_unit, ''))));
  v_canon text;
  v_probe text;
BEGIN
  IF v_raw = '' THEN RETURN NULL; END IF;
  -- save_job's denominator rule (20260820120000 / 20260904185900), verbatim, on the invisible-folded unit: fold every
  -- separator except '/', strip ONE trailing per-acre suffix, refuse whatever denominator survives.
  v_canon := btrim(regexp_replace(v_raw, '[^a-z0-9/]+', ' ', 'g'));
  v_probe := regexp_replace(v_canon, '\s*/\s*(acres|acre|ac|a)\s*$', '');
  IF v_probe = v_canon THEN
    v_probe := regexp_replace(v_probe, '\s+per\s+(acres|acre|ac|a)$', '');
  END IF;
  IF position('/' IN v_probe) > 0 OR v_probe ~ '(^| )per( |$)' THEN
    RETURN 'CHEM_RATE_DENOMINATOR_NOT_ACRES';
  END IF;
  -- save_job's unsupported-character rule: after the invisible fold, only plain ASCII unit characters.
  -- A lookalike slash ('oz' U+2215 'cwt') or letter would otherwise hide a denominator from the rule above.
  IF p_check_characters AND v_raw ~ '[^a-z0-9 ./-]' THEN
    RETURN 'CHEM_UNIT_UNSUPPORTED_CHARACTER';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rate_unit_line_refusal(text, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rate_unit_line_refusal(text, boolean) TO authenticated, service_role;

CREATE FUNCTION public.guard_job_chemical_rate_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_refusal text;
  v_product_name text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.rate_unit IS NOT DISTINCT FROM OLD.rate_unit
     AND NEW.price_per_unit_cents IS NOT DISTINCT FROM OLD.price_per_unit_cents THEN
    RETURN NEW;
  END IF;
  v_refusal := public.rate_unit_line_refusal(NEW.rate_unit, COALESCE(NEW.price_per_unit_cents, 0) <> 0);
  IF v_refusal IS NULL THEN RETURN NEW; END IF;
  SELECT p.product_name INTO v_product_name FROM public.products p WHERE p.id = NEW.product_id;
  IF v_refusal = 'CHEM_RATE_DENOMINATOR_NOT_ACRES' THEN
    RAISE EXCEPTION
      'CHEM_RATE_DENOMINATOR_NOT_ACRES: % has a rate unit of "%", which is measured per something other than acres, so a per-acre quantity cannot be derived from it.',
      COALESCE(v_product_name, 'This product'), btrim(NEW.rate_unit);
  END IF;
  RAISE EXCEPTION
    'CHEM_UNIT_UNSUPPORTED_CHARACTER: % has a rate unit containing a character this system cannot read ("%"). That is usually a copy-and-paste from a spreadsheet or a web page carrying a lookalike letter or symbol. Re-type the rate unit using plain letters.',
    COALESCE(v_product_name, 'This product'), btrim(NEW.rate_unit);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.guard_job_chemical_rate_unit() FROM PUBLIC, anon, authenticated, service_role;

-- Named to sort after trg_guard_seed_each_job_chemical_units, which may fill a blank rate unit first.
CREATE TRIGGER trg_job_chemicals_rate_unit_guard
  BEFORE INSERT OR UPDATE ON public.job_chemicals
  FOR EACH ROW EXECUTE FUNCTION public.guard_job_chemical_rate_unit();

CREATE FUNCTION public.guard_blend_ticket_product_rate_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_refusal text;
  v_unit    text;
BEGIN
  -- Billing reads NULLIF(btrim(rate_per_acre_unit), '') before folding, so an invisible-only unit would
  -- skip the product fallback and fail to convert. Store it as blank (NULL) instead.
  -- Only on a row whose unit is being written, so an unrelated edit never rewrites a stored value.
  IF (TG_OP = 'INSERT' OR NEW.rate_per_acre_unit IS DISTINCT FROM OLD.rate_per_acre_unit)
     AND btrim(COALESCE(NEW.rate_per_acre_unit, '')) <> ''
     AND btrim(public.unit_fold_invisible(NEW.rate_per_acre_unit)) = '' THEN
    NEW.rate_per_acre_unit := NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.rate_per_acre_unit IS NOT DISTINCT FROM OLD.rate_per_acre_unit
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    RETURN NEW;
  END IF;
  -- The unit billing will use (create_invoice_from_blend_ticket): NULLIF(btrim(line), ''), else the product's,
  -- so a line unit of '' or spaces is checked through the product's unit exactly as billing reads it.
  v_unit := NULLIF(btrim(NEW.rate_per_acre_unit), '');
  IF v_unit IS NULL AND NEW.product_id IS NOT NULL THEN
    SELECT p.rate_unit INTO v_unit FROM public.products p WHERE p.id = NEW.product_id;
  END IF;
  v_refusal := public.rate_unit_line_refusal(v_unit, NEW.product_id IS NOT NULL);
  IF v_refusal IS NULL THEN RETURN NEW; END IF;
  IF v_refusal = 'CHEM_RATE_DENOMINATOR_NOT_ACRES' THEN
    RAISE EXCEPTION
      'CHEM_RATE_DENOMINATOR_NOT_ACRES: % has a rate unit of "%", which is measured per something other than acres, so a per-acre quantity cannot be derived from it.%',
      COALESCE(NULLIF(btrim(NEW.product_name), ''), 'This product'), btrim(v_unit),
      CASE WHEN NULLIF(btrim(NEW.rate_per_acre_unit), '') IS NULL
           THEN ' This line has no rate unit, so the product''s default was used: enter a per-acre rate unit on the line.'
           ELSE ' Enter the rate per acre.' END;
  END IF;
  RAISE EXCEPTION
    'CHEM_UNIT_UNSUPPORTED_CHARACTER: % has a rate unit containing a character this system cannot read ("%"). That is usually a copy-and-paste from a spreadsheet or a web page carrying a lookalike letter or symbol. Re-type the rate unit using plain letters.',
    COALESCE(NULLIF(btrim(NEW.product_name), ''), 'This product'), btrim(v_unit);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.guard_blend_ticket_product_rate_unit() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_blend_ticket_products_rate_unit_guard
  BEFORE INSERT OR UPDATE ON public.blend_ticket_products
  FOR EACH ROW EXECUTE FUNCTION public.guard_blend_ticket_product_rate_unit();

DO $postflight$
BEGIN
  IF public.normalize_rate_unit('oz' || chr(8203)) IS DISTINCT FROM 'oz'
     OR public.normalize_rate_unit(chr(65279) || 'Gal' || chr(160)) IS DISTINCT FROM 'gal'
     OR public.normalize_rate_unit('fl' || chr(160) || 'oz') IS DISTINCT FROM 'oz'
     OR public.normalize_rate_unit('pt/ac') IS DISTINCT FROM 'pt'
     OR public.normalize_rate_unit('oz/cwt') IS DISTINCT FROM 'oz/cwt'
     OR public.normalize_rate_unit('Dry oz') IS DISTINCT FROM 'dry oz'
     OR public.normalize_rate_unit(chr(8203)) IS NOT NULL THEN
    RAISE EXCEPTION 'KI16_RATE_UNIT_POSTFLIGHT: normalize_rate_unit does not fold invisible characters as reviewed';
  END IF;
  IF public.rate_unit_line_refusal('oz/cwt', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES'
     OR public.rate_unit_line_refusal('oz per cwt', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES'
     OR public.rate_unit_line_refusal('oz/cwt/ac', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES'
     OR public.rate_unit_line_refusal('oz per acre/ac', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES'
     OR public.rate_unit_line_refusal('per cwt', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES'
     OR public.rate_unit_line_refusal('oz' || chr(8725) || 'cwt', true) IS DISTINCT FROM 'CHEM_UNIT_UNSUPPORTED_CHARACTER'
     OR public.rate_unit_line_refusal('oz' || chr(8725) || 'cwt', false) IS NOT NULL
     OR public.rate_unit_line_refusal('pt/ac', true) IS NOT NULL
     OR public.rate_unit_line_refusal('gal per acre', true) IS NOT NULL
     OR public.rate_unit_line_refusal('fl. oz/acre', true) IS NOT NULL
     OR public.rate_unit_line_refusal('oz p' || chr(8203) || 'er cwt', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES'
     OR public.rate_unit_line_refusal('oz/' || chr(160) || 'cwt', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES'
     OR public.rate_unit_line_refusal('pt/a' || chr(8203) || 'c', true) IS NOT NULL
     OR public.rate_unit_line_refusal('oz' || chr(8203), true) IS NOT NULL
     OR public.rate_unit_line_refusal('32', true) IS NOT NULL
     OR public.rate_unit_line_refusal(NULL, true) IS NOT NULL THEN
    RAISE EXCEPTION 'KI16_RATE_UNIT_POSTFLIGHT: rate_unit_line_refusal does not match the save_job rule';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('trg_job_chemicals_rate_unit_guard', 'trg_blend_ticket_products_rate_unit_guard')
         AND tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'KI16_RATE_UNIT_POSTFLIGHT: guard triggers are missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.normalize_rate_unit(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.unit_fold_invisible(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rate_unit_line_refusal(text, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_job_chemical_rate_unit()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_blend_ticket_product_rate_unit()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.normalize_rate_unit(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rate_unit_line_refusal(text, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.unit_fold_invisible(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'KI16_RATE_UNIT_POSTFLIGHT: grants are not as reviewed';
  END IF;
  -- Every existing row still passes its guard.
  IF EXISTS (SELECT 1 FROM public.job_chemicals jc
              WHERE public.rate_unit_line_refusal(jc.rate_unit, COALESCE(jc.price_per_unit_cents, 0) <> 0) IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.blend_ticket_products b LEFT JOIN public.products p ON p.id = b.product_id
                 WHERE public.rate_unit_line_refusal(
                         COALESCE(NULLIF(btrim(public.unit_fold_invisible(b.rate_per_acre_unit)), ''), p.rate_unit),
                         b.product_id IS NOT NULL) IS NOT NULL)
     -- Billing does not fold before its blank test, so a stored invisible-only unit would fail there (live: 0 rows).
     OR EXISTS (SELECT 1 FROM public.blend_ticket_products b
                 WHERE btrim(COALESCE(b.rate_per_acre_unit, '')) <> ''
                   AND btrim(public.unit_fold_invisible(b.rate_per_acre_unit)) = '') THEN
    RAISE EXCEPTION 'KI16_RATE_UNIT_POSTFLIGHT: an existing line would be refused; review it before applying';
  END IF;
END;
$postflight$;
