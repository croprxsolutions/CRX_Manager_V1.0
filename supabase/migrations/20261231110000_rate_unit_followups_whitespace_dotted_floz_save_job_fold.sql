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
--   * save_job (the 731-char wrapper only): each chemical line's string rate_unit is passed through
--     unit_fold_invisible before _save_job_cost_step2_impl sees it, so its denominator and character rules judge the
--     same folded text as rate_unit_line_refusal. The impl is NOT re-emitted: its md5 is pinned before and after.
--   * guard_product_rate_unit_for_blend_lines: ignores soft-deleted tickets (blend_tickets.deleted_at IS NOT NULL).
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
--   normalize_rate_unit and guard_product_rate_unit_for_blend_lines, and the 20261019230000 save_job wrapper. No data
--   changes; job lines saved meanwhile keep their folded rate unit text.

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_expected CONSTANT text[][] := ARRAY[
    ['public.normalize_rate_unit(text)', 'ac8e7b56f9b08f627a035b2330f958fb'],
    ['public.unit_fold_invisible(text)', '4966a39646767af017bd5a5289302bfe'],
    ['public.guard_product_rate_unit_for_blend_lines()', 'e956e4b8b2bf51817b0d2f9f60afa0f1'],
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

CREATE OR REPLACE FUNCTION public.guard_product_rate_unit_for_blend_lines()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_refusal text;
BEGIN
  IF NEW.rate_unit IS NOT DISTINCT FROM OLD.rate_unit THEN RETURN NEW; END IF;
  v_refusal := public.rate_unit_line_refusal(NEW.rate_unit, true);
  IF v_refusal IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(160016, hashtext(NEW.id::text));
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
  -- Fold invisible characters and tabs out of each line's rate unit first, as the job_chemicals trigger's
  -- rate_unit_line_refusal does, so the impl's own unit rules judge the same text (KI-16). Order and other keys kept.
  IF jsonb_typeof(p_chemicals) = 'array' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(t.e -> 'rate_unit') = 'string'
                                   THEN jsonb_set(t.e, '{rate_unit}', to_jsonb(public.unit_fold_invisible(t.e ->> 'rate_unit')))
                                   ELSE t.e END
                              ORDER BY t.o), '[]'::jsonb)
      INTO v_chemicals
      FROM jsonb_array_elements(p_chemicals) WITH ORDINALITY AS t(e, o);
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
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure) THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: grants are not as reviewed';
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
     -- Invisible-only line units stay refused on every ticket, deleted or not, as the line trigger does.
     OR EXISTS (SELECT 1 FROM public.blend_ticket_products b
                 WHERE btrim(COALESCE(b.rate_per_acre_unit, '')) <> ''
                   AND btrim(public.unit_fold_invisible(b.rate_per_acre_unit)) = '') THEN
    RAISE EXCEPTION 'KI16_FOLLOWUP_POSTFLIGHT: an existing line would be refused; review it before applying';
  END IF;
END;
$postflight$;
