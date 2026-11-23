-- Written 2026-11-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270227100000_rate_cutover_refuses_unrestorable.md.
--
-- WHY (Sol, RT-4a button review, 2026-11-23; Mason chose the database fix the same day): a switch to the approved
--   rate (20270125100000) could succeed in two cases it should refuse.
--   1. Old values that the switch back could never re-save. Switching back re-saves the old rate, unit and suggested
--      rate through the rate save's checks, now judged against the approved unit (an old dry "oz" kept only because it
--      was unchanged no longer passes). The group stays approved, its rates frozen, and the rate lock cannot be turned off.
--   2. An approved unit the field-app invoice save cannot convert to the product's sold unit (field_app_priced_quantity,
--      e.g. g/acre on a product sold in Lb). New field-app lines copy the default rate unit, and the invoice save
--      refuses them (FIELD_APP_UNIT_UNCONVERTIBLE).
--
-- WHAT: _rate_cutover_plan (20270125100000) is renamed _rate_cutover_plan_20270125, unchanged. A new
--   _rate_cutover_plan calls it (same locks, same plan) and, for a promote that changes the rate or unit, refuses:
--   * PRODUCT_PARENT_CUTOVER_NOT_RESTORABLE when the old values fail any check the switch back would run on them
--     (_apply_parent_rates and preview_product_rate_correction: rate value, unit and suggested-rate length, and
--     _product_rate_unit_ok per size with the approved unit as the unit being replaced);
--   * PRODUCT_PARENT_CUTOVER_UNIT_NOT_INVOICEABLE when a size with a sold unit could not price the approved unit.
--   preview_parent_rate_cutover and commit_parent_rate_cutover call _rate_cutover_plan by name, so both pick it up:
--   the preview shows the refusal, and commit refuses the same way. Restores and unchanged promotes are not touched.
--
-- NOT CHANGED: preview_parent_rate_cutover, commit_parent_rate_cutover, every table, row, policy and other function.
--   No parent switches when this applies.
--
-- ROLLBACK (its own reviewed migration): drop the new _rate_cutover_plan and rename _rate_cutover_plan_20270125 back.
--
-- ORDERING: after 20270125100000. Not re-runnable (preflight refuses).

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._rate_cutover_plan_20270125(uuid,text)') IS NOT NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public._rate_cutover_plan(uuid,text)')) IS DISTINCT FROM '584d8f916dcc4be37cbe92b851c9fe2b'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.field_app_priced_quantity(numeric,text,text,text)')) IS DISTINCT FROM '47985e0b809d5ce85a9423f03a9422e7'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public._product_rate_unit_ok(numeric,text,text,text,text)')) IS DISTINCT FROM '2afe7ed90b01550dbfc954281268f071'
     OR to_regprocedure('public._product_rate_value_ok(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'RATE_CUTOVER_RESTORABLE_PREFLIGHT: the cutover planner or a check it relies on is not the reviewed version';
  END IF;
END;
$preflight$;

ALTER FUNCTION public._rate_cutover_plan(uuid, text) RENAME TO _rate_cutover_plan_20270125;

CREATE FUNCTION public._rate_cutover_plan(p_parent_id uuid, p_direction text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_plan jsonb := public._rate_cutover_plan_20270125(p_parent_id, p_direction);
  v_old jsonb := v_plan->'snapshot'->'legacy';
  v_new_unit text := v_plan->'target'->>'rate_unit';
  v_seed_each boolean;
  v_old_unit text;
  v_old_rate numeric;
  v_bad text;
BEGIN
  IF p_direction <> 'promote' OR NOT (v_plan->>'changes')::boolean THEN
    RETURN v_plan;
  END IF;
  SELECT product_form IN ('seed', 'each') INTO v_seed_each FROM public.product_parents WHERE id = p_parent_id;
  -- The switch back sends the old unit blank on seed and each parents (the plan does), as it would be re-saved.
  v_old_unit := CASE WHEN v_seed_each THEN NULL ELSE NULLIF(btrim(v_old->>'rate_unit'), '') END;

  -- 1. The switch back's checks on the old values, in the order _apply_parent_rates runs them.
  IF NOT public._product_rate_value_ok(to_jsonb(v_old->>'rate_per_acre')) THEN
    v_bad := 'its old rate per acre is not a number with at most 6 decimals';
  ELSIF length(v_old_unit) > 40 THEN
    v_bad := 'its old rate unit is longer than 40 characters';
  ELSIF length(NULLIF(btrim(v_old->>'suggested_rate'), '')) > 200 THEN
    v_bad := 'its old suggested rate is longer than 200 characters';
  ELSE
    v_old_rate := NULLIF(btrim(v_old->>'rate_per_acre'), '')::numeric;
    -- Per size, as the switch back judges it: the old unit replacing the approved one (seed and each re-save their
    -- stock unit over the unit they keep).
    SELECT 'its old unit "' || COALESCE(v_old_unit, '') || '" would not be accepted back on ' || min(p.product_name)
      INTO v_bad
      FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
     WHERE m.parent_id = p_parent_id
       AND NOT public._product_rate_unit_ok(v_old_rate,
             CASE WHEN p.product_form IN ('seed', 'each') THEN p.inventory_unit ELSE v_old_unit END,
             CASE WHEN p.product_form IN ('seed', 'each') THEN p.rate_unit ELSE v_new_unit END,
             p.product_form, COALESCE(NULLIF(p.inventory_unit, ''), p.unit_size))
    HAVING count(*) > 0;
  END IF;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_NOT_RESTORABLE: "%" would be stuck on its approved rate: %, so it could not be switched back; correct its rates first',
      v_plan->>'name', v_bad;
  END IF;

  -- 2. Field-app invoicing prices a line's rate unit in the product's sold unit; a size with no sold unit is refused
  -- there whatever its rate, so only a sold unit the approved unit cannot reach refuses here.
  IF v_plan->'target'->>'rate_per_acre' IS NOT NULL THEN
    SELECT min(p.product_name || ' (sold in ' || p.inventory_unit || ')') INTO v_bad
      FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
     WHERE m.parent_id = p_parent_id
       AND COALESCE(p.inventory_unit, '') ~ '[[:alnum:]]'
       AND public.field_app_priced_quantity(1, v_new_unit, p.inventory_unit, p.product_form::text) IS NULL
    HAVING count(*) > 0;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_UNIT_NOT_INVOICEABLE: field-app invoices for "%" could not convert its approved unit "%" for %',
        v_plan->>'name', v_new_unit, v_bad;
    END IF;
  END IF;
  RETURN v_plan;
END;
$function$;
ALTER FUNCTION public._rate_cutover_plan(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._rate_cutover_plan(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public._rate_cutover_plan(uuid,text)', 'public._rate_cutover_plan_20270125(uuid,text)']) f(sig)
               CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) r(role)
              WHERE has_function_privilege(r.role, f.sig, 'EXECUTE'))
     OR NOT (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp'] FROM pg_proc
              WHERE oid = 'public._rate_cutover_plan(uuid,text)'::regprocedure) THEN
    RAISE EXCEPTION 'RATE_CUTOVER_RESTORABLE_POSTFLIGHT_GRANTS_WRONG';
  END IF;
END;
$postflight$;
