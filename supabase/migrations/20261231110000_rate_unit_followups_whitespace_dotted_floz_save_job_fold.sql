-- KI-16 rate-unit follow-ups after 20261231100000 (contract: docs/plans/2026-11-10-ki16-rate-unit-followups-CONTRACT.md).
--
-- WHY (each failed closed before: refused at save or at billing, never a wrong amount):
--   1. normalize_rate_unit has no dotted fluid ounce ('fl. oz'), so billing refuses it.
--   2. save_job's own denominator probe does not fold invisible characters, so 'pt/a<ZWSP>c' passes the screen and
--      the 20261231100000 trigger but save_job refuses it (CHEM_RATE_DENOMINATOR_NOT_ACRES).
--   3. JavaScript .trim() strips tabs and Unicode spaces; SQL btrim strips U+0020 only, so 'oz<TAB>' looks fine on
--      the blend screen and the database refuses it.
--   4. guard_product_rate_unit_for_blend_lines counts soft-deleted blend tickets, so a deleted draft can block a
--      product rate unit edit.
--
-- WHAT:
--   * unit_fold_invisible: every character JS .trim() strips (TAB, LF, VT, FF, CR, U+00A0, U+1680, U+2000-U+200A,
--     U+2028, U+2029, U+202F, U+205F, U+3000) becomes a space; U+00AD, U+200B-U+200D, U+2060, U+FEFF are still
--     deleted. Then SQL btrim and JS .trim() remove the same characters (src/lib/labelGuardrails.ts mirrors it).
--   * normalize_rate_unit: same body; dotted spellings 'fl. oz', 'fl.oz', 'fl oz.', 'fl. oz.', 'fl.oz.', 'floz.' map
--     to 'fl oz', NOT 'oz'. field_app_priced_quantity sizes 'fl oz' on the liquid branch and not on the dry one, so a
--     dry product still refuses a fluid ounce at billing; mapping to 'oz' would bill it as a weight ounce.
--   * save_job (the 731-char wrapper only): each chemical line's string rate_unit and unit (Taha, PR #1741) pass through
--     unit_fold_invisible before _save_job_cost_step2_impl sees it, so its denominator and character rules judge the
--     same folded text as rate_unit_line_refusal. The impl is NOT re-emitted: its md5 is pinned before and after.
--   * guard_product_rate_unit_for_blend_lines: ignores soft-deleted tickets (blend_tickets.deleted_at IS NOT NULL).
--   * Dry fluid ounces (Sol round 1 HIGH; Mason 2026-11-10 "Yes, fix here"): new unit_names_fluid_ounce(text), save_job's
--     CHEM_UNIT_FORM_MISMATCH reduction after the fold. guard_blend_ticket_product_rate_unit refuses a blend line on a
--     DRY product whose billed unit (line, else the product's) names fluid ounces in any spelling, which billing would
--     otherwise size as weight ounces (16 fl oz/ac -> 1 lb/ac); guard_product_rate_unit_for_blend_lines refuses a dry
--     product's own unit becoming fluid ounces under a live unbilled blank-unit line, and a product turning dry under a
--     live line in fluid ounces. Job lines already get CHEM_UNIT_FORM_MISMATCH from _save_job_cost_step2_impl.
--
-- LIVE EVIDENCE (read-only, 2026-11-10): md5(replace(prosrc, chr(13), '')): normalize_rate_unit
--   ac8e7b56f9b08f627a035b2330f958fb, unit_fold_invisible 4966a39646767af017bd5a5289302bfe,
--   guard_product_rate_unit_for_blend_lines e956e4b8b2bf51817b0d2f9f60afa0f1, save_job 88ca038686daffbbb2c7a46a05d37e5d
--   (20261019230000), _save_job_cost_step2_impl 8acf34542105a90212ddb0a5e7c5d272. No job_chemicals, products or
--   quote_items unit holds a tab/CR/LF/VT/FF or a dotted 'fl.'; blend_tickets has 0 rows. No index uses either helper.
--
-- idempotency-body-check: exempt -- save_job's idempotency is unchanged: p_idempotency_key is passed through to the
--   impl, which fingerprints the (now folded) chemical lines exactly as before.
-- caller-analysis: save_job :: grants unchanged (restated: anon/PUBLIC none, authenticated + service_role EXECUTE);
--   src/pages/JobDetail.tsx calls it as authenticated with the same arguments and gets the same result shape.
-- caller-analysis: normalize_rate_unit :: output changes only for inputs carrying a JS-whitespace character or a
--   dotted fluid-ounce spelling; its 15 callers compare it for equality or size it in field_app_priced_quantity, so
--   such a unit now matches its plain spelling (liquid) instead of matching nothing; a dry product still refuses it.
-- caller-analysis: unit_fold_invisible :: callers normalize_rate_unit, rate_unit_line_refusal,
--   guard_blend_ticket_product_rate_unit and now save_job; each folds before judging, so a tab now reads as a space
--   instead of an unreadable character. Grants unchanged (restated).
--
-- ROLLBACK (its own reviewed migration): re-create the 20261231100000 bodies of unit_fold_invisible,
--   normalize_rate_unit, guard_blend_ticket_product_rate_unit and guard_product_rate_unit_for_blend_lines, drop
--   unit_names_fluid_ounce, and the 20261019230000 save_job wrapper. No data
--   changes; job lines saved meanwhile keep their folded rate unit text.

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_expected CONSTANT text[][] := ARRAY[
    ['public.normalize_rate_unit(text)', 'ac8e7b56f9b08f627a035b2330f958fb'],
    ['public.unit_fold_invisible(text)', '4966a39646767af017bd5a5289302bfe'],
    ['public.guard_product_rate_unit_for_blend_lines()', 'e956e4b8b2bf51817b0d2f9f60afa0f1'],
    ['public.guard_blend_ticket_product_rate_unit()', 'a5f396b3c4a3106c71ce71f78d92aced'],
    ['public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', '88ca038686daffbbb2c7a46a05d37e5d'],
    ['public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)', '8acf34542105a90212ddb0a5e7c5d272']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_expected, 1) LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_expected[i][1]::regprocedure)
       IS DISTINCT FROM v_expected[i][2] THEN
      RAISE EXCEPTION 'KI16_FOLLOWUP_PREFLIGHT: % is not the reviewed body; nothing was changed.', v_expected[i][1];
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.unit_fold_invisible(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The first 23 (every character JavaScript's trim() strips, bar U+FEFF) map to a space, positionally; the last six
  -- have no counterpart and are deleted. The postflight checks each one.
  SELECT translate(p_text,
                   chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(160) || chr(5760)
                   || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
                   || chr(8199) || chr(8200) || chr(8201) || chr(8202)
                   || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288)
                   || chr(173) || chr(8203) || chr(8204) || chr(8205) || chr(8288) || chr(65279),
                   repeat(' ', 23));
$function$;

-- Kept by CREATE OR REPLACE; restated so the file is self-describing.
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
    -- Dotted fluid ounce: 'fl oz', not 'oz', so a dry product still refuses it at billing (KI-16).
    WHEN 'fl. oz' THEN 'fl oz' WHEN 'fl.oz' THEN 'fl oz' WHEN 'fl oz.' THEN 'fl oz'
    WHEN 'fl. oz.' THEN 'fl oz' WHEN 'fl.oz.' THEN 'fl oz' WHEN 'floz.' THEN 'fl oz'
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

-- Kept by CREATE OR REPLACE; restated so the file is self-describing.
REVOKE EXECUTE ON FUNCTION public.normalize_rate_unit(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.normalize_rate_unit(text) TO authenticated, service_role;

-- True when a unit names fluid ounces in any spelling: save_job's CHEM_UNIT_FORM_MISMATCH reduction (fold separators
-- keeping '/', drop from the first '/', drop a 'per ...' tail, delete the rest of the non-alphanumerics), after the
-- invisible fold. A DRY product cannot be measured in fluid ounces without a density (Sol round 1 HIGH, PR #1741).
CREATE FUNCTION public.unit_names_fluid_ounce(p_unit text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT regexp_replace(
           regexp_replace(
             split_part(
               btrim(regexp_replace(lower(public.unit_fold_invisible(COALESCE(p_unit, ''))), '[^a-z0-9/]+', ' ', 'g')),
               '/', 1),
             '\s+per\s+.*$', ''),
           '[^a-z0-9]', '', 'g')
         ~ '^(fl|fluid)(oz|ozs|ounce|ounces)$';
$function$;

REVOKE EXECUTE ON FUNCTION public.unit_names_fluid_ounce(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unit_names_fluid_ounce(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_blend_ticket_product_rate_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_refusal text;
  v_unit    text;
BEGIN
  -- Billing reads NULLIF(btrim(rate_per_acre_unit), '') before folding, so an invisible-only unit skips the
  -- product fallback, normalizes to nothing and can pass the unit check with no unit at all. Refuse it
  -- (Sol round 2 HIGH) rather than blank it; only when that unit is being written.
  IF (TG_OP = 'INSERT' OR NEW.rate_per_acre_unit IS DISTINCT FROM OLD.rate_per_acre_unit)
     AND btrim(COALESCE(NEW.rate_per_acre_unit, '')) <> ''
     AND btrim(public.unit_fold_invisible(NEW.rate_per_acre_unit)) = '' THEN
    RAISE EXCEPTION
      'CHEM_UNIT_UNSUPPORTED_CHARACTER: % has a rate unit made only of invisible characters, usually from a copy-and-paste. Clear the rate unit or re-type it using plain letters.',
      COALESCE(NULLIF(btrim(NEW.product_name), ''), 'This product');
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
    -- Takes turns with guard_product_rate_unit_for_blend_lines, so a product edit committing at the same
    -- moment cannot pass unseen (Luna round 3); the read below then sees the committed unit. Shared, so
    -- two ticket saves touching the same products in any order never wait on (or deadlock) each other;
    -- only the product edit takes this key exclusively.
    PERFORM pg_advisory_xact_lock_shared(160016, hashtext(NEW.product_id::text));
    SELECT p.rate_unit INTO v_unit FROM public.products p WHERE p.id = NEW.product_id;
  END IF;
  -- A fluid-ounce unit on a DRY product would bill as weight ounces (Sol round 1 HIGH, PR #1741). The same lock
  -- makes a product turning dry wait for this line, and this read see a committed form.
  IF NEW.product_id IS NOT NULL AND public.unit_names_fluid_ounce(v_unit) THEN
    PERFORM pg_advisory_xact_lock_shared(160016, hashtext(NEW.product_id::text));
    IF (SELECT p.product_form FROM public.products p WHERE p.id = NEW.product_id) = 'dry' THEN
      RAISE EXCEPTION
        'CHEM_UNIT_FORM_MISMATCH: % is a DRY product, so it cannot be measured in fluid ounces ("%"): a fluid ounce is a volume and cannot become pounds without a density.%',
        COALESCE(NULLIF(btrim(NEW.product_name), ''), 'This product'), btrim(v_unit),
        CASE WHEN NULLIF(btrim(NEW.rate_per_acre_unit), '') IS NULL
             THEN ' This line has no rate unit, so the product''s default was used: enter a weight rate unit per acre on the line.'
             ELSE ' Enter the rate as a weight per acre (lb/ac or oz/ac).' END;
    END IF;
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

CREATE OR REPLACE FUNCTION public.guard_product_rate_unit_for_blend_lines()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_refusal    text;
  v_became_dry boolean := NEW.product_form = 'dry' AND OLD.product_form IS DISTINCT FROM 'dry';
BEGIN
  IF NEW.rate_unit IS NOT DISTINCT FROM OLD.rate_unit AND NOT v_became_dry THEN RETURN NEW; END IF;
  IF NEW.rate_unit IS DISTINCT FROM OLD.rate_unit THEN
    v_refusal := public.rate_unit_line_refusal(NEW.rate_unit, true);
  END IF;
  -- A dry product's own unit in fluid ounces would bill a blank-unit line as weight ounces (Sol round 1 HIGH, PR #1741).
  IF v_refusal IS NULL AND NEW.product_form = 'dry' AND public.unit_names_fluid_ounce(NEW.rate_unit) THEN
    v_refusal := 'CHEM_UNIT_FORM_MISMATCH';
  END IF;
  IF v_refusal IS NULL AND NOT v_became_dry THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(160016, hashtext(NEW.id::text));
  -- Becoming dry while a live unbilled line carries its own fluid-ounce unit (PR #1741).
  IF v_became_dry AND EXISTS (SELECT 1 FROM public.blend_ticket_products b
                                JOIN public.blend_tickets t ON t.id = b.blend_ticket_id
                               WHERE b.product_id = NEW.id
                                 AND public.unit_names_fluid_ounce(NULLIF(btrim(b.rate_per_acre_unit), ''))
                                 AND t.deleted_at IS NULL
                                 AND t.payment_status NOT IN ('billed', 'no_charge')) THEN
    RAISE EXCEPTION
      'CHEM_UNIT_FORM_MISMATCH: % has blend ticket lines not yet billed measured in fluid ounces, so it cannot become a dry product. Give those lines a weight rate unit first.',
      COALESCE(NULLIF(btrim(NEW.product_name), ''), 'This product');
  END IF;
  IF v_refusal IS NULL THEN RETURN NEW; END IF;
  -- A soft-deleted ticket is never billed (no path restores one), so it does not hold the product's unit (KI-16).
  IF EXISTS (SELECT 1 FROM public.blend_ticket_products b
               JOIN public.blend_tickets t ON t.id = b.blend_ticket_id
              WHERE b.product_id = NEW.id
                AND NULLIF(btrim(b.rate_per_acre_unit), '') IS NULL
                AND t.deleted_at IS NULL
                AND t.payment_status NOT IN ('billed', 'no_charge')) THEN
    RAISE EXCEPTION
      '%: % has blend ticket lines not yet billed that use its rate unit, so it cannot become "%". Give those lines their own per-acre rate unit first.',
      v_refusal, COALESCE(NULLIF(btrim(NEW.product_name), ''), 'This product'), btrim(NEW.rate_unit);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.guard_product_rate_unit_for_blend_lines() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_job(p_job_id uuid, p_job_payload jsonb, p_fields jsonb, p_chemicals jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_chemicals jsonb := p_chemicals;
BEGIN
  IF auth.uid() IS NULL OR p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- Fold invisible characters and tabs out of each line's rate unit and stock Unit first, as the job_chemicals
  -- trigger's rate_unit_line_refusal does, so the impl's own unit rules judge the same text the screen shows
  -- (KI-16). Order and other keys kept.
  IF jsonb_typeof(p_chemicals) = 'array' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(r.e -> 'unit') = 'string'
                                   THEN jsonb_set(r.e, '{unit}', to_jsonb(public.unit_fold_invisible(r.e ->> 'unit')))
                                   ELSE r.e END
                              ORDER BY r.o), '[]'::jsonb)
      INTO v_chemicals
      FROM (SELECT CASE WHEN jsonb_typeof(t.e -> 'rate_unit') = 'string'
                        THEN jsonb_set(t.e, '{rate_unit}', to_jsonb(public.unit_fold_invisible(t.e ->> 'rate_unit')))
                        ELSE t.e END AS e, t.o
              FROM jsonb_array_elements(p_chemicals) WITH ORDINALITY AS t(e, o)) r;
  END IF;
  -- Cost is admin-only (Mason, 2026-10-15): a non-admin's chemical cost comes from the server.
  -- The impl keeps every check it had (actor, role, units, totals, idempotency).
  IF public.is_admin() THEN
    RETURN public._save_job_cost_step2_impl(
      p_job_id, p_job_payload, p_fields, v_chemicals, p_performed_by, p_idempotency_key);
  END IF;
  RETURN public._save_job_cost_step2_impl(
    p_job_id, p_job_payload, p_fields,
    public._cost_step2_job_chemicals(p_job_id, v_chemicals),
    p_performed_by, p_idempotency_key);
END;
$function$;

-- Kept by CREATE OR REPLACE; restated so the file is self-describing.
REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated, service_role;

DO $postflight$
DECLARE
  c int;
BEGIN
  -- Every JS-trim whitespace character folds to one space; every deleted character disappears.
  FOREACH c IN ARRAY ARRAY[9, 10, 11, 12, 13, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
                           8202, 8232, 8233, 8239, 8287, 12288] LOOP
    IF public.unit_fold_invisible('a' || chr(c) || 'b') IS DISTINCT FROM 'a b' THEN
      RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: unit_fold_invisible does not map U+% to a space', to_hex(c);
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY[173, 8203, 8204, 8205, 8288, 65279] LOOP
    IF public.unit_fold_invisible('a' || chr(c) || 'b') IS DISTINCT FROM 'ab' THEN
      RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: unit_fold_invisible does not delete U+%', to_hex(c);
    END IF;
  END LOOP;
  IF public.unit_fold_invisible(NULL) IS NOT NULL OR public.unit_fold_invisible('Fl oz/AC') IS DISTINCT FROM 'Fl oz/AC' THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: unit_fold_invisible changes plain text';
  END IF;
  -- 20261231100000's normalizer table, unchanged, plus the new cases.
  IF public.normalize_rate_unit('oz' || chr(8203)) IS DISTINCT FROM 'oz'
     OR public.normalize_rate_unit(chr(65279) || 'Gal' || chr(160)) IS DISTINCT FROM 'gal'
     OR public.normalize_rate_unit('fl' || chr(160) || 'oz') IS DISTINCT FROM 'oz'
     OR public.normalize_rate_unit('pt/ac') IS DISTINCT FROM 'pt'
     OR public.normalize_rate_unit('oz/cwt') IS DISTINCT FROM 'oz/cwt'
     OR public.normalize_rate_unit('Dry oz') IS DISTINCT FROM 'dry oz'
     OR public.normalize_rate_unit(chr(8203)) IS NOT NULL
     OR public.normalize_rate_unit('fl oz') IS DISTINCT FROM 'oz'
     OR public.normalize_rate_unit('FLOZ/acre') IS DISTINCT FROM 'oz'
     OR public.normalize_rate_unit('oz' || chr(9)) IS DISTINCT FROM 'oz'
     OR public.normalize_rate_unit('fl' || chr(9) || 'oz/ac') IS DISTINCT FROM 'oz'
     OR public.normalize_rate_unit(chr(12288) || 'gal' || chr(13) || chr(10)) IS DISTINCT FROM 'gal'
     OR public.normalize_rate_unit(chr(9) || chr(10)) IS NOT NULL
     OR public.normalize_rate_unit('fl. oz') IS DISTINCT FROM 'fl oz'
     OR public.normalize_rate_unit('FL.OZ/ac') IS DISTINCT FROM 'fl oz'
     OR public.normalize_rate_unit('fl oz.') IS DISTINCT FROM 'fl oz'
     OR public.normalize_rate_unit('fl. oz. per acre') IS DISTINCT FROM 'fl oz'
     OR public.normalize_rate_unit('floz.') IS DISTINCT FROM 'fl oz'
     OR public.normalize_rate_unit('fl. oz/cwt') IS DISTINCT FROM 'fl. oz/cwt' THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: normalize_rate_unit outputs are not as reviewed';
  END IF;
  -- Billing sizes the dotted fluid ounce on a liquid product and still refuses it on a dry one.
  IF public.field_app_priced_quantity(128, public.normalize_rate_unit('fl. oz/ac'), public.normalize_rate_unit('gal'), 'liquid') IS DISTINCT FROM 1
     OR public.field_app_priced_quantity(16, public.normalize_rate_unit('fl. oz/ac'), public.normalize_rate_unit('lb'), 'dry') IS NOT NULL THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: a dotted fluid ounce does not size as reviewed';
  END IF;
  IF public.rate_unit_line_refusal('oz' || chr(9), true) IS NOT NULL
     OR public.rate_unit_line_refusal('pt' || chr(9) || '/ac', true) IS NOT NULL
     OR public.rate_unit_line_refusal(chr(9), true) IS DISTINCT FROM 'CHEM_UNIT_UNSUPPORTED_CHARACTER'
     OR public.rate_unit_line_refusal('oz/' || chr(9) || 'cwt', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES'
     OR public.rate_unit_line_refusal('fl. oz/ac', true) IS NOT NULL
     OR public.rate_unit_line_refusal('oz/cwt', false) IS DISTINCT FROM 'CHEM_RATE_DENOMINATOR_NOT_ACRES' THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: rate_unit_line_refusal does not read whitespace as reviewed';
  END IF;
  -- save_job's impl was not touched.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure)
     IS DISTINCT FROM '8acf34542105a90212ddb0a5e7c5d272' THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: _save_job_cost_step2_impl changed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('trg_job_chemicals_rate_unit_guard', 'trg_blend_ticket_products_rate_unit_guard',
                        'trigger_zzzz_products_rate_unit_blend_guard')
         AND tgenabled = 'O') <> 3 THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: guard triggers are missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.normalize_rate_unit(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.unit_fold_invisible(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_product_rate_unit_for_blend_lines()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_product_rate_unit_for_blend_lines()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_product_rate_unit_for_blend_lines()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.normalize_rate_unit(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.unit_fold_invisible(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.normalize_rate_unit(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.unit_fold_invisible(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.unit_names_fluid_ounce(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.unit_names_fluid_ounce(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.unit_names_fluid_ounce(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_blend_ticket_product_rate_unit()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_blend_ticket_product_rate_unit()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_blend_ticket_product_rate_unit()', 'EXECUTE')
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure) THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: grants are not as reviewed';
  END IF;
  -- Fluid-ounce spellings, as save_job's CHEM_UNIT_FORM_MISMATCH reads them (PR #1741).
  IF NOT (public.unit_names_fluid_ounce('fl oz') AND public.unit_names_fluid_ounce('FL OZ/AC')
          AND public.unit_names_fluid_ounce('fl' || chr(9) || 'oz/ac') AND public.unit_names_fluid_ounce('fl. oz/ac')
          AND public.unit_names_fluid_ounce('floz') AND public.unit_names_fluid_ounce('fluid ounces per acre')
          AND public.unit_names_fluid_ounce('fl' || chr(8203) || 'oz'))
     OR public.unit_names_fluid_ounce('oz') OR public.unit_names_fluid_ounce('oz/ac')
     OR public.unit_names_fluid_ounce('dry oz') OR public.unit_names_fluid_ounce('lb/ac')
     OR public.unit_names_fluid_ounce('flat') OR public.unit_names_fluid_ounce(NULL)
     OR public.unit_names_fluid_ounce('') THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: unit_names_fluid_ounce does not read units as reviewed';
  END IF;
  -- Every existing row still passes its guard (20261231100000's check, re-run under the wider fold).
  IF EXISTS (SELECT 1 FROM public.job_chemicals jc
              WHERE public.rate_unit_line_refusal(jc.rate_unit, COALESCE(jc.price_per_unit_cents, 0) <> 0) IS NOT NULL)
     -- A soft-deleted ticket's blank-unit line may now rely on a per-X product unit (item 4), so it is skipped here.
     OR EXISTS (SELECT 1 FROM public.blend_ticket_products b LEFT JOIN public.products p ON p.id = b.product_id
                  JOIN public.blend_tickets t ON t.id = b.blend_ticket_id
                 WHERE t.deleted_at IS NULL
                   AND public.rate_unit_line_refusal(
                         COALESCE(NULLIF(btrim(public.unit_fold_invisible(b.rate_per_acre_unit)), ''), p.rate_unit),
                         b.product_id IS NOT NULL) IS NOT NULL)
     -- No live unbilled line on a dry product bills in fluid ounces (the new refusal, PR #1741).
     OR EXISTS (SELECT 1 FROM public.blend_ticket_products b JOIN public.products p ON p.id = b.product_id
                  JOIN public.blend_tickets t ON t.id = b.blend_ticket_id
                 WHERE t.deleted_at IS NULL AND t.payment_status NOT IN ('billed', 'no_charge')
                   AND p.product_form = 'dry'
                   AND public.unit_names_fluid_ounce(COALESCE(NULLIF(btrim(b.rate_per_acre_unit), ''), p.rate_unit)))
     -- Invisible-only line units stay refused on every ticket, deleted or not, as the line trigger does.
     OR EXISTS (SELECT 1 FROM public.blend_ticket_products b
                 WHERE btrim(COALESCE(b.rate_per_acre_unit, '')) <> ''
                   AND btrim(public.unit_fold_invisible(b.rate_per_acre_unit)) = '') THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: an existing line would be refused; review it before applying';
  END IF;
END;
$postflight$;
