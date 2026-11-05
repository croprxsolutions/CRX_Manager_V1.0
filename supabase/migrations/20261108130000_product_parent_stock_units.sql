-- PAR-1 follow-up: a seed or each parent's sizes share one stock unit.
--
-- A seed or each parent's one rate is per stock unit (20261108120000 previews and saves it in each
-- size's inventory_unit), so a parent with a 50 Lb bag and a size stocked as Unit would give 30 Lb/acre
-- to one and 30 Unit/acre to the other. add_product_size (through _insert_parent_size) and a size move
-- (through _product_size_move_refusal, which both preview_move_product_size and move_product_size call)
-- now refuse a size whose stock unit differs from the parent's other sizes, case and spaces ignored:
-- PRODUCT_PARENT_UNIT_MISMATCH. Liquid and dry parents are unchanged (their rate unit converts).
--
-- New: _product_parent_unit_refusal (private; no API-role EXECUTE). Re-issued: _insert_parent_size and
-- _product_size_move_refusal (both private; same signatures, grants re-asserted). No table, row, grant
-- on an existing object, or public function changes. Live had no parents when this was written.
--
-- Rollback: re-issue both functions from 20261108120000_product_parents.sql, then
-- DROP FUNCTION public._product_parent_unit_refusal(public.product_parents, text, uuid);

DO $preflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._insert_parent_size(public.product_parents,jsonb,text)'::regprocedure) IS DISTINCT FROM 'c021bf98575667d32d15d3e723ad51e8'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_size_move_refusal(uuid,uuid)'::regprocedure) IS DISTINCT FROM '0b850586f48a49ff47122b6b1573726b' THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_HELPERS_CHANGED: re-base this on the installed bodies';
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

DO $postflight$
BEGIN
  IF has_function_privilege('authenticated', 'public._product_parent_unit_refusal(public.product_parents,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._insert_parent_size(public.product_parents,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._product_size_move_refusal(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_UNIT_GRANTS_WRONG';
  END IF;
END;
$postflight$;
