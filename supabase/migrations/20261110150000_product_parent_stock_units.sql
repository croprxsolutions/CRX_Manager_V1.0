-- idempotency-body-check: exempt
-- (move_product_size checks its retry key through _product_parent_replay, which calls check_idempotency,
--  and saves its receipt with save_idempotency last, in the same transaction.)
--
-- PAR-1 follow-up: a seed or each parent's sizes share one stock unit.
--
-- A seed or each parent's one rate is per stock unit (20261108120000 previews and saves it in each
-- size's inventory_unit), so a parent with a 50 Lb bag and a size stocked as Unit would give 30 Lb/acre
-- to one and 30 Unit/acre to the other. add_product_size (through _insert_parent_size) and a size move
-- (through _product_size_move_refusal, which both preview_move_product_size and move_product_size call)
-- now refuse a size whose stock unit differs from the parent's other sizes, case and spaces ignored:
-- PRODUCT_PARENT_UNIT_MISMATCH. Liquid and dry parents are unchanged (their rate unit converts).
--
-- move_product_size (public; same signature, grants re-asserted) now stores the new parent's normalized
-- EPA number on a moved size whenever the parent has one, as an added size does; before, a size typed
-- "100 - 1" kept that spelling under a "100-1" parent (the move refusal already requires the size's
-- normalized number to be absent or the parent's).
--
-- _apply_parent_rates (private; same signature, grants re-asserted) now skips a parent whose rates and sizes
-- already match when called by set_parent_rates, so one unchanged row of a Rates-tab upload no longer refuses the
-- whole upload; correct_parent_rates still refuses an unchanged correction (PRODUCT_RATE_CORRECTION_NO_CHANGE).
--
-- New: _product_parent_unit_refusal (private; no API-role EXECUTE). Re-issued: _insert_parent_size and
-- _product_size_move_refusal (both private; same signatures, grants re-asserted), and move_product_size and
-- _apply_parent_rates as above. No table, row or grant on an existing object changes. Live had no parents when this was written; the
-- preflight refuses the apply if a seed or each parent already mixes stock units.
--
-- Rollback: re-issue _insert_parent_size, _product_size_move_refusal, move_product_size and _apply_parent_rates from
-- 20261108120000_product_parents.sql, then
-- DROP FUNCTION public._product_parent_unit_refusal(public.product_parents, text, uuid);

DO $preflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._insert_parent_size(public.product_parents,jsonb,text)'::regprocedure) IS DISTINCT FROM 'c021bf98575667d32d15d3e723ad51e8'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_size_move_refusal(uuid,uuid)'::regprocedure) IS DISTINCT FROM '0b850586f48a49ff47122b6b1573726b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)'::regprocedure) IS DISTINCT FROM 'aeb4c51b18b8d786b36b6afbd6dbb7ec'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._apply_parent_rates(uuid,bigint,numeric,text,text,jsonb,boolean,text)'::regprocedure) IS DISTINCT FROM 'd52ecfc3943bd3b2403336437bea356b' THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_HELPERS_CHANGED: re-base this on the installed bodies';
  END IF;
  -- The new check guards adds and moves; a seed or each parent that already mixes units must be fixed first.
  IF EXISTS (SELECT 1 FROM public.product_parent_members m
               JOIN public.product_parents pp ON pp.id = m.parent_id
               JOIN public.products p ON p.id = m.product_id
              WHERE pp.product_form IN ('seed', 'each')
              GROUP BY m.parent_id
             HAVING count(DISTINCT lower(btrim(coalesce(p.inventory_unit, '')))) > 1) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_MIXED_UNITS: a seed or each parent already holds sizes in different stock units';
  END IF;
END;
$preflight$;

CREATE FUNCTION public._product_parent_unit_refusal(p_parent public.product_parents, p_unit text, p_product_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  -- NULL when the parent is not seed or each, or every other size is stocked in p_unit (case and spaces ignored).
  SELECT format('PRODUCT_PARENT_UNIT_MISMATCH: every size of "%s" is stocked in %s; a seed or each parent''s rate is per stock unit',
                p_parent.name, p.inventory_unit)
    FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
   WHERE p_parent.product_form IN ('seed', 'each')
     AND m.parent_id = p_parent.id AND m.product_id <> p_product_id
     AND lower(btrim(coalesce(p.inventory_unit, ''))) IS DISTINCT FROM lower(btrim(coalesce(p_unit, '')))
   ORDER BY m.product_id
   LIMIT 1;
$function$;
ALTER FUNCTION public._product_parent_unit_refusal(public.product_parents, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_unit_refusal(public.product_parents, text, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._insert_parent_size(p_parent public.product_parents, p_size jsonb, p_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_fields jsonb;
  v_saved jsonb;
  v_product uuid;
  v_refusal text;
BEGIN
  IF p_size IS NULL OR jsonb_typeof(p_size) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_REQUIRED: send the new size''s fields';
  END IF;
  IF p_size ?| ARRAY['category', 'use_timing', 'use_timings', 'rate_per_acre', 'rate_unit', 'suggested_rate', 'rates'] THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_COPIED_VALUE: category, use timing and rates come from the parent; leave them off the size';
  END IF;
  IF p_size ? 'product_form' AND (p_size->>'product_form') IS DISTINCT FROM p_parent.product_form THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_FORM_MISMATCH: every size of "%" is %', p_parent.name, p_parent.product_form;
  END IF;
  -- Every size carries its parent's EPA number, or none does (build sheet §4.1).
  IF public._normalize_epa_registration(p_size->>'epa_registration') IS DISTINCT FROM p_parent.generic_epa_registration
     AND public._normalize_epa_registration(p_size->>'epa_registration') IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_EPA_MISMATCH: "%" has %', p_parent.name,
      COALESCE('EPA number ' || p_parent.generic_epa_registration, 'no EPA number; set it on the parent first');
  END IF;
  v_fields := (p_size - 'size_role') || jsonb_build_object('product_form', p_parent.product_form, 'category', p_parent.category);
  -- The size stores the parent's normalized number, never a spaced or lower-case spelling of it.
  IF p_parent.generic_epa_registration IS NOT NULL THEN
    v_fields := v_fields || jsonb_build_object('epa_registration', p_parent.generic_epa_registration);
  END IF;
  -- A fresh key: a retry is answered by the caller's own receipt before it gets here, so no setup
  -- receipt (for example one an admin saved under '<key>:insert') can hand back an existing product.
  v_saved := public.apply_product_setup(jsonb_build_array(jsonb_build_object('insert', v_fields)), auth.uid(),
    'product_parent_size:' || gen_random_uuid()::text);
  v_product := (v_saved->'rows'->0->>'product_id')::uuid;
  -- A seed or each parent's one rate is per stock unit, so every size must be stocked in the same unit.
  v_refusal := public._product_parent_unit_refusal(p_parent, (SELECT inventory_unit FROM public.products WHERE id = v_product), v_product);
  IF v_refusal IS NOT NULL THEN RAISE EXCEPTION '%', v_refusal; END IF;
  RETURN v_product;
END;
$function$;
ALTER FUNCTION public._insert_parent_size(public.product_parents, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._insert_parent_size(public.product_parents, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._product_size_move_refusal(p_product_id uuid, p_to_parent_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_member public.product_parent_members%ROWTYPE;
  v_to public.product_parents%ROWTYPE;
  v_size record;
BEGIN
  SELECT * INTO v_member FROM public.product_parent_members WHERE product_id = p_product_id;
  IF NOT FOUND THEN RETURN 'PRODUCT_PARENT_NOT_GROUPED: this size has no parent'; END IF;
  SELECT * INTO v_to FROM public.product_parents WHERE id = p_to_parent_id;
  IF NOT FOUND THEN RETURN 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  IF v_member.parent_id = p_to_parent_id THEN RETURN 'PRODUCT_PARENT_SAME: the size already belongs to this parent'; END IF;
  IF NOT v_to.is_active THEN RETURN format('PRODUCT_PARENT_INACTIVE: "%s" is inactive', v_to.name); END IF;
  SELECT p.product_form, p.epa_registration, p.rate_per_acre, p.rate_unit, p.suggested_rate, p.inventory_unit
    INTO v_size FROM public.products p WHERE p.id = p_product_id;
  IF v_size.product_form IS DISTINCT FROM v_to.product_form THEN
    RETURN format('PRODUCT_PARENT_FORM_MISMATCH: every size of "%s" is %s', v_to.name, v_to.product_form);
  END IF;
  IF public._normalize_epa_registration(v_size.epa_registration) IS DISTINCT FROM v_to.generic_epa_registration
     AND public._normalize_epa_registration(v_size.epa_registration) IS NOT NULL THEN
    RETURN format('PRODUCT_PARENT_EPA_MISMATCH: "%s" has %s', v_to.name,
      COALESCE('EPA number ' || v_to.generic_epa_registration, 'no EPA number; set it on the parent first'));
  END IF;
  IF public._product_parent_unit_refusal(v_to, v_size.inventory_unit, p_product_id) IS NOT NULL THEN
    RETURN public._product_parent_unit_refusal(v_to, v_size.inventory_unit, p_product_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_parent_members t WHERE t.fill_source_product_id = p_product_id) THEN
    RETURN 'PRODUCT_PARENT_FILL_SOURCE_IN_USE: a tote is filled from this bulk size; change the tote''s fill source first';
  END IF;
  IF v_member.fill_source_product_id IS NOT NULL THEN
    RETURN 'PRODUCT_PARENT_FILL_SOURCE_STAYS: this tote is filled from its parent''s bulk size; clear its fill source first';
  END IF;
  IF v_member.size_role = 'bulk' AND EXISTS (SELECT 1 FROM public.product_parent_members b
                                              WHERE b.parent_id = p_to_parent_id AND b.size_role = 'bulk') THEN
    RETURN format('PRODUCT_PARENT_ONE_BULK: "%s" already has a bulk size', v_to.name);
  END IF;
  IF COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true)
     AND (v_size.rate_per_acre IS DISTINCT FROM v_to.rate_per_acre
          OR NULLIF(btrim(v_size.suggested_rate), '') IS DISTINCT FROM v_to.suggested_rate
          OR (v_size.product_form NOT IN ('seed', 'each') AND NULLIF(v_size.rate_unit, '') IS DISTINCT FROM v_to.rate_unit)) THEN
    RETURN 'PRODUCT_RATES_LOCKED: the move would change this size''s live rate; correct its rate to match the parent first, or unlock rates';
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._product_size_move_refusal(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_size_move_refusal(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.move_product_size(p_product_id uuid, p_to_parent_id uuid, p_expected_from_version bigint,
  p_expected_to_version bigint, p_expected_size_fingerprint text, p_reason text, p_evidence text,
  p_expected_prices jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'product_id', p_product_id, 'to_parent_id', p_to_parent_id,
    'from_version', p_expected_from_version, 'to_version', p_expected_to_version,
    'size_fingerprint', p_expected_size_fingerprint, 'reason', btrim(p_reason), 'evidence', btrim(p_evidence),
    'expected_prices', p_expected_prices)::text);
  v_tier text;
  v_existing jsonb;
  v_reason text;
  v_evidence text;
  v_from uuid;
  v_refusal text;
  v_event bigint;
  v_copy jsonb;
  v_to_version bigint;
  v_from_left integer;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'move_product_size', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  IF p_expected_prices IS NULL OR jsonb_typeof(p_expected_prices) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: send the preview''s prices';
  END IF;
  SELECT parent_id INTO v_from FROM public.product_parent_members WHERE product_id = p_product_id;
  IF v_from IS NULL THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_GROUPED: this size has no parent'; END IF;
  -- Both parents in ID order, then the size.
  PERFORM 1 FROM public.product_parents WHERE id IN (v_from, p_to_parent_id) ORDER BY id FOR UPDATE;
  IF (SELECT parent_version FROM public.product_parents WHERE id = v_from) IS DISTINCT FROM p_expected_from_version
     OR (SELECT parent_version FROM public.product_parents WHERE id = p_to_parent_id) IS DISTINCT FROM p_expected_to_version
     OR (SELECT parent_id FROM public.product_parent_members WHERE product_id = p_product_id) IS DISTINCT FROM v_from THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_STALE: a parent changed since the preview; preview again';
  END IF;
  PERFORM 1 FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF public._product_size_fingerprint(p_product_id) IS DISTINCT FROM p_expected_size_fingerprint THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_STALE: the size changed since the preview; preview again';
  END IF;
  v_refusal := public._product_size_move_refusal(p_product_id, p_to_parent_id);
  IF v_refusal IS NOT NULL THEN RAISE EXCEPTION '%', v_refusal; END IF;

  UPDATE public.product_parent_members SET parent_id = p_to_parent_id, updated_at = now() WHERE product_id = p_product_id;
  UPDATE public.product_parents SET parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
   WHERE id IN (v_from, p_to_parent_id);
  SELECT count(*) INTO v_from_left FROM public.product_parent_members WHERE parent_id = v_from;
  -- A parent left with no sizes is kept, inactive.
  IF v_from_left = 0 THEN UPDATE public.product_parents SET is_active = false WHERE id = v_from; END IF;
  v_event := public._next_product_parent_event_id();
  -- The refusal above leaves a size with no EPA number or one whose normalized number is the parent's; either way
  -- it stores the parent's normalized spelling, as an added size does.
  v_copy := public._copy_parent_to_size(p_to_parent_id, p_product_id, v_event, true, false,
    (SELECT pp.generic_epa_registration IS NOT NULL FROM public.product_parents pp WHERE pp.id = p_to_parent_id));
  -- A unit conversion changed since the preview moves the prices but no version or fingerprint.
  FOREACH v_tier IN ARRAY ARRAY['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'] LOOP
    IF NOT (p_expected_prices ? v_tier) OR (v_copy->'after'->v_tier) IS DISTINCT FROM (p_expected_prices->v_tier) THEN
      RAISE EXCEPTION 'PRODUCT_RATE_PREVIEW_CHANGED: the per-acre prices changed since the preview; preview again: %',
        v_copy->'after'->>'product_name' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  PERFORM public._product_parent_event(v_event, p_to_parent_id, 'size_moved', v_reason, v_evidence,
    jsonb_build_object('from_parent_id', v_from), jsonb_build_object('to_parent_id', p_to_parent_id), jsonb_build_array(v_copy));
  -- The old parent's log records the move too.
  PERFORM public._product_parent_event(NULL, v_from, 'size_moved', v_reason, v_evidence,
    jsonb_build_object('from_parent_id', v_from, 'product_id', p_product_id, 'is_active', true),
    jsonb_build_object('to_parent_id', p_to_parent_id, 'is_active', v_from_left > 0),
    jsonb_build_array(v_copy));
  SELECT parent_version INTO v_to_version FROM public.product_parents WHERE id = p_to_parent_id;
  v_receipt := jsonb_build_object('product_id', p_product_id, 'from_parent_id', v_from, 'to_parent_id', p_to_parent_id,
      'to_parent_version', v_to_version, 'from_parent_inactive', v_from_left = 0, 'event_id', v_event, 'size', v_copy);
  PERFORM public.save_idempotency(p_idempotency_key, 'move_product_size',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) TO authenticated;

CREATE OR REPLACE FUNCTION public._apply_parent_rates(p_parent_id uuid, p_expected_parent_version bigint,
  p_rate_per_acre numeric, p_rate_unit text, p_suggested_rate text, p_expected_sizes jsonb,
  p_correction boolean, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_sizes uuid[];
  v_before public.product_parents%ROWTYPE;
  v_parent public.product_parents%ROWTYPE;
  v_unit text := NULLIF(btrim(p_rate_unit), '');
  v_suggested text := NULLIF(btrim(p_suggested_rate), '');
  v_size record;
  v_exp jsonb;
  v_event bigint;
  v_copy jsonb;
  v_affected jsonb := '[]'::jsonb;
  v_tier text;
  v_name text;
  v_pid uuid;
  v_any_change boolean := false;
BEGIN
  IF NOT public._product_rate_value_ok(to_jsonb(p_rate_per_acre::text)) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate per acre must be blank or a number of 0 or more with at most 6 decimals';
  END IF;
  IF length(v_unit) > 40 OR length(v_suggested) > 200 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: the rate unit or suggested rate is too long';
  END IF;
  IF p_expected_sizes IS NULL OR jsonb_typeof(p_expected_sizes) <> 'array' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATES_PREVIEW_REQUIRED: send every size''s preview snapshot';
  END IF;
  v_sizes := public._lock_product_parent(p_parent_id, p_expected_parent_version);
  SELECT * INTO v_before FROM public.product_parents WHERE id = p_parent_id;
  IF v_before.product_form IN ('seed', 'each') THEN v_unit := NULL; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_expected_sizes)) <> cardinality(v_sizes)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_expected_sizes) e
                WHERE jsonb_typeof(e) <> 'object' OR NOT ((e->>'product_id') = ANY(v_sizes::text[]))
                   OR jsonb_typeof(e->'pricing_version') <> 'number' OR jsonb_typeof(e->'prices') <> 'object')
     OR (SELECT count(DISTINCT e->>'product_id') FROM jsonb_array_elements(p_expected_sizes) e) <> cardinality(v_sizes) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATES_STALE: the sizes of "%" changed since the preview; preview again', v_before.name;
  END IF;

  FOR v_size IN SELECT p.id, p.product_name, p.pricing_version, p.unit_size, p.inventory_unit, p.product_form,
                       p.rate_per_acre, p.rate_unit, p.suggested_rate
                  FROM public.products p WHERE p.id = ANY(v_sizes) ORDER BY p.id LOOP
    SELECT e INTO v_exp FROM jsonb_array_elements(p_expected_sizes) e WHERE e->>'product_id' = v_size.id::text;
    IF (v_exp->>'pricing_version')::numeric IS DISTINCT FROM v_size.pricing_version
       OR (v_exp->>'unit_size') IS DISTINCT FROM v_size.unit_size
       OR (v_exp->>'inventory_unit') IS DISTINCT FROM v_size.inventory_unit
       OR (v_exp->>'product_form') IS DISTINCT FROM v_size.product_form
       OR (v_exp->>'rate_per_acre')::numeric IS DISTINCT FROM v_size.rate_per_acre
       OR NULLIF(v_exp->>'rate_unit', '') IS DISTINCT FROM NULLIF(v_size.rate_unit, '')
       OR NULLIF(btrim(v_exp->>'suggested_rate'), '') IS DISTINCT FROM NULLIF(btrim(v_size.suggested_rate), '') THEN
      RAISE EXCEPTION 'PRODUCT_RATES_STALE: % changed since the preview; preview again', v_size.product_name;
    END IF;
    IF NOT public._product_rate_unit_ok(p_rate_per_acre,
             CASE WHEN v_size.product_form IN ('seed', 'each') THEN v_size.inventory_unit ELSE v_unit END,
             v_size.rate_unit, v_size.product_form, COALESCE(NULLIF(v_size.inventory_unit, ''), v_size.unit_size)) THEN
      RAISE EXCEPTION 'PRODUCT_RATE_UNIT_INVALID: the rate unit is missing or not a known unit for %', v_size.product_name;
    END IF;
    v_any_change := v_any_change OR p_rate_per_acre IS DISTINCT FROM v_size.rate_per_acre
      OR v_suggested IS DISTINCT FROM NULLIF(btrim(v_size.suggested_rate), '')
      OR (v_size.product_form NOT IN ('seed', 'each') AND v_unit IS DISTINCT FROM NULLIF(v_size.rate_unit, ''));
  END LOOP;
  -- Nothing to do only when the parent and every size already hold these rates: a correction is refused, while
  -- set_parent_rates skips the parent (an empty array adds nothing to its rows), so one unchanged row of an upload
  -- does not refuse the others.
  IF NOT v_any_change AND p_rate_per_acre IS NOT DISTINCT FROM v_before.rate_per_acre
     AND v_unit IS NOT DISTINCT FROM v_before.rate_unit AND v_suggested IS NOT DISTINCT FROM v_before.suggested_rate THEN
    IF p_correction THEN
      RAISE EXCEPTION 'PRODUCT_RATE_CORRECTION_NO_CHANGE: the parent and every size already have these rates';
    END IF;
    RETURN '[]'::jsonb;
  END IF;

  UPDATE public.product_parents SET rate_per_acre = p_rate_per_acre, rate_unit = v_unit, suggested_rate = v_suggested,
    parent_version = parent_version + 1, updated_by = auth.uid(), updated_at = now()
  WHERE id = p_parent_id RETURNING * INTO v_parent;
  v_event := public._next_product_parent_event_id();
  SELECT full_name INTO v_name FROM public.profiles WHERE id = auth.uid();
  FOREACH v_pid IN ARRAY v_sizes LOOP
    SELECT e INTO v_exp FROM jsonb_array_elements(p_expected_sizes) e WHERE e->>'product_id' = v_pid::text;
    v_copy := public._copy_parent_to_size(p_parent_id, v_pid, v_event, true, p_correction, false);
    -- A unit conversion changed since the preview moves the prices but no version.
    FOREACH v_tier IN ARRAY ARRAY['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'] LOOP
      IF NOT (v_exp->'prices' ? v_tier) OR (v_copy->'after'->v_tier) IS DISTINCT FROM (v_exp->'prices'->v_tier) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_PREVIEW_CHANGED: the per-acre prices changed since the preview; preview again: %',
          v_copy->'after'->>'product_name' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    IF p_correction THEN
      INSERT INTO public.product_rate_events
        (event_type, product_id, reason, before_values, after_values, changed_by, changed_by_name)
      VALUES ('corrected', v_pid, p_reason, v_copy->'before', v_copy->'after', auth.uid(), v_name);
    END IF;
    v_affected := v_affected || v_copy;
  END LOOP;
  PERFORM public._product_parent_event(v_event, p_parent_id, CASE WHEN p_correction THEN 'rates_corrected' ELSE 'rates_set' END,
    p_reason, NULL, public._product_parent_values(v_before), public._product_parent_values(v_parent), v_affected);
  RETURN jsonb_build_object('parent_id', p_parent_id, 'parent_version', v_parent.parent_version,
    'event_id', v_event, 'sizes', v_affected);
END;
$function$;
ALTER FUNCTION public._apply_parent_rates(uuid, bigint, numeric, text, text, jsonb, boolean, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._apply_parent_rates(uuid, bigint, numeric, text, text, jsonb, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF has_function_privilege('authenticated', 'public._product_parent_unit_refusal(public.product_parents,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._insert_parent_size(public.product_parents,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._product_size_move_refusal(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._apply_parent_rates(uuid,bigint,numeric,text,text,jsonb,boolean,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_UNIT_GRANTS_WRONG';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_MOVE_PRODUCT_SIZE_GRANTS_WRONG';
  END IF;
END;
$postflight$;
