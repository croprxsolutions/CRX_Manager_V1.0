-- Written 2026-11-24. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270301130000_product_rate_unit_invoice_guard.md.
--
-- WHY (#2367; Mason D4, 2026-11-23): a field-app invoice line copies the product's rate unit and prices it in the
--   unit the product is sold in (field_app_priced_quantity); when that cannot convert, the invoice save refuses the
--   line. Nothing stopped a product reaching that state: a new size sold in a unit the group's rate unit cannot reach,
--   a size added while the group uses its approved rate, a blank rate that keeps its unit, a new standalone product.
--   And a size added while the group uses its approved rate could make switching back impossible.
--
-- WHAT (contract docs/plans/2026-11-24-product-rate-unit-guard-CONTRACT.md):
--   * _product_rate_unit_invoiceable(rate_unit, sold_unit, form): blank rate unit, a sold unit with no letter or digit
--     (refused by the invoice save whatever the rate), or field_app_priced_quantity(1, ...) not NULL.
--   * _product_size_restore_problem(product, sold unit, unit size, form): for a size of a group on its approved rate,
--     why switching back could not put the old rate unit on it (the switch back's own unit check, or invoiceability);
--     NULL otherwise. Same target as the switch back: the promote event's legacy unit, the stock unit on seed/each.
--   * BEFORE INSERT OR UPDATE trigger on products (sorts last): PRODUCT_RATE_UNIT_NOT_INVOICEABLE when an INSERT, or an
--     update changing rate_unit, inventory_unit or product_form, leaves a rate unit invoices cannot convert (rule 1);
--     an update changing none of them is never refused (rule 2). PRODUCT_PARENT_SIZE_NOT_RESTORABLE when a change to a
--     size of an approved group (rate unit, stock unit, unit size or form) would make switching back fail (rule 3).
--     A switch back's own write of each size's restore target is not refused (rule 4). It reads the size's group
--     FOR SHARE, so an edit racing a switch is judged against the group as the switch left it.
--   * BEFORE INSERT OR UPDATE OF product_id, parent_id trigger on product_parent_members: a size joining an approved
--     group must be restorable (rule 3); takes the group's row lock (FOR SHARE), so a switch running at the same time
--     either sees the new size or is waited on.
--
-- NOT CHANGED: every row, table, policy and grant; field_app_priced_quantity, _product_rate_unit_ok, the rate switch.
--   Live read 2026-11-24 (select only): 0 of 601 rated products have a rate unit invoices cannot convert; 0 groups on
--   their approved rate.
--
-- ROLLBACK (its own reviewed migration): drop the two triggers and the four functions.
--
-- ORDERING: after 20270227160000 (its planner is required). Not re-runnable (preflight refuses).

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._product_rate_unit_invoiceable(text,text,text)') IS NOT NULL
     OR to_regprocedure('public._rate_cutover_plan_20270125(uuid,text)') IS NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.field_app_priced_quantity(numeric,text,text,text)')) IS DISTINCT FROM '47985e0b809d5ce85a9423f03a9422e7'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public._product_rate_unit_ok(numeric,text,text,text,text)')) IS DISTINCT FROM '2afe7ed90b01550dbfc954281268f071'
     OR to_regclass('public.product_rate_cutover_passes') IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_GUARD_PREFLIGHT: a function this guard relies on is not the reviewed version';
  END IF;
END;
$preflight$;

CREATE FUNCTION public._product_rate_unit_invoiceable(p_rate_unit text, p_sold_unit text, p_form text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(p_rate_unit, '') = ''  -- only these fall back to the sold unit in the field app; spaces do not
      OR COALESCE(p_sold_unit, '') !~ '[[:alnum:]]'
      OR public.field_app_priced_quantity(1, p_rate_unit, p_sold_unit, p_form) IS NOT NULL;
$function$;


-- Why switching group p_parent_id back to its old rate could not put the old rate unit on a size that, at that
-- moment, has these values (p_rate_unit is the unit the switch back would replace), or NULL. NULL when the group is
-- not on its approved rate. Mirrors the switch back: _rate_cutover_plan_20270125 (target unit: blank on a seed/each
-- group), _apply_parent_rates (a seed/each size gets its stock unit) and _rate_cutover_plan's restore check.
CREATE FUNCTION public._product_size_restore_problem(p_parent_id uuid, p_rate_unit text, p_sold_unit text,
  p_unit_size text, p_form text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent public.product_parents%ROWTYPE;
  v_legacy jsonb;
  v_unit text;
BEGIN
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND OR v_parent.rate_source IS DISTINCT FROM 'approved' THEN
    RETURN NULL;
  END IF;
  SELECT e.after_values->'legacy' INTO v_legacy FROM public.product_parent_events e
   WHERE e.id = v_parent.rate_source_event_id AND e.parent_id = p_parent_id AND e.event_type = 'rates_promoted';
  IF jsonb_typeof(v_legacy) IS DISTINCT FROM 'object' THEN
    RETURN 'its old rate cannot be read';
  END IF;
  IF NOT public._product_rate_value_ok(to_jsonb(v_legacy->>'rate_per_acre')) THEN
    RETURN 'its old rate is not a valid rate';
  END IF;
  v_unit := CASE WHEN p_form IN ('seed', 'each') THEN p_sold_unit
                 WHEN v_parent.product_form IN ('seed', 'each') THEN NULL
                 ELSE NULLIF(btrim(v_legacy->>'rate_unit'), '') END;
  IF NOT COALESCE(public._product_rate_unit_ok(NULLIF(btrim(v_legacy->>'rate_per_acre'), '')::numeric, v_unit,
                    p_rate_unit, p_form, COALESCE(NULLIF(p_sold_unit, ''), p_unit_size)), false) THEN
    RETURN format('its old rate unit "%s" would not be accepted back on this size', COALESCE(v_unit, ''));
  END IF;
  IF NOT public._product_rate_unit_invoiceable(v_unit, p_sold_unit, p_form) THEN
    RETURN format('field-app invoices could not convert its old rate unit "%s" to this size''s sold unit "%s"',
                  v_unit, p_sold_unit);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION public.guard_product_field_app_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent public.product_parents%ROWTYPE;
  v_restoring boolean := false;
  v_problem text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.rate_unit IS NOT DISTINCT FROM OLD.rate_unit
     AND NEW.inventory_unit IS NOT DISTINCT FROM OLD.inventory_unit
     AND NEW.unit_size IS NOT DISTINCT FROM OLD.unit_size
     AND NEW.product_form IS NOT DISTINCT FROM OLD.product_form THEN
    RETURN NEW;  -- rule 2: nothing the invoice unit or the switch back depends on changed
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- FOR SHARE: a rate switch writing this group makes this edit wait, then read the group as the switch left it
    -- (an unlocked read could still see it on its old rate and skip rule 3). Same lock as the member trigger.
    SELECT pp.* INTO v_parent FROM public.product_parent_members m JOIN public.product_parents pp ON pp.id = m.parent_id
     WHERE m.product_id = NEW.id
       FOR SHARE OF pp;
    -- Rule 4: a switch back writes the sizes while the group is still approved, its pass held in this transaction,
    -- after writing the old unit on the group row. Only a size receiving exactly its restore target is let through.
    v_restoring := COALESCE(v_parent.rate_source = 'approved'
      AND EXISTS (SELECT 1 FROM public.product_rate_cutover_passes c
                   WHERE c.txid = txid_current() AND c.parent_id = v_parent.id)
      AND NULLIF(btrim(NEW.rate_unit), '') IS NOT DISTINCT FROM
          (SELECT CASE WHEN NEW.product_form IN ('seed', 'each') THEN NULLIF(btrim(NEW.inventory_unit), '')
                       WHEN v_parent.product_form IN ('seed', 'each') THEN NULL
                       ELSE NULLIF(btrim(e.after_values->'legacy'->>'rate_unit'), '') END
             FROM public.product_parent_events e
            WHERE e.id = v_parent.rate_source_event_id AND e.event_type = 'rates_promoted'), false);
  END IF;

  -- Rule 1.
  IF NOT v_restoring
     AND (TG_OP = 'INSERT' OR NEW.rate_unit IS DISTINCT FROM OLD.rate_unit
          OR NEW.inventory_unit IS DISTINCT FROM OLD.inventory_unit OR NEW.product_form IS DISTINCT FROM OLD.product_form)
     AND NOT public._product_rate_unit_invoiceable(NEW.rate_unit, NEW.inventory_unit, NEW.product_form::text) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_NOT_INVOICEABLE: field-app invoices could not convert the rate unit "%" of "%" to its sold unit "%" (%); use a rate unit that converts, or leave it blank',
      btrim(NEW.rate_unit), NEW.product_name, NEW.inventory_unit, COALESCE(NEW.product_form::text, 'no form')
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule 3: a size of a group on its approved rate must stay switchable back.
  IF TG_OP = 'UPDATE' AND NOT v_restoring AND v_parent.rate_source = 'approved' THEN
    v_problem := public._product_size_restore_problem(v_parent.id, NEW.rate_unit, NEW.inventory_unit, NEW.unit_size,
                                                      NEW.product_form::text);
    -- A size that already could not switch back stays editable (like rule 2); only a change that breaks it is refused.
    IF v_problem IS NOT NULL AND public._product_size_restore_problem(v_parent.id, OLD.rate_unit, OLD.inventory_unit,
                                                                      OLD.unit_size, OLD.product_form::text) IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_NOT_RESTORABLE: "%" could not be switched back to its old rate after this change to "%": %; switch the group back to its old rate first',
        v_parent.name, NEW.product_name, v_problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.guard_product_parent_member_restorable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent public.product_parents%ROWTYPE;
  v_size public.products%ROWTYPE;
  v_problem text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;
  -- The group's row lock: a switch locks the group row for update, so a join and a switch cannot interleave.
  SELECT * INTO v_parent FROM public.product_parents WHERE id = NEW.parent_id FOR SHARE;
  IF v_parent.rate_source IS DISTINCT FROM 'approved' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_size FROM public.products WHERE id = NEW.product_id;
  -- Judged as the size will be once the group's values are copied onto it (a seed/each size keeps its stock unit).
  v_problem := public._product_size_restore_problem(NEW.parent_id,
    CASE WHEN v_size.product_form IN ('seed', 'each') THEN v_size.inventory_unit ELSE v_parent.rate_unit END,
    v_size.inventory_unit, v_size.unit_size, v_size.product_form::text);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_NOT_RESTORABLE: "%" could not be switched back to its old rate with "%" in it: %; switch the group back to its old rate first',
      v_parent.name, v_size.product_name, v_problem
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._product_rate_unit_invoiceable(text, text, text) OWNER TO postgres;
ALTER FUNCTION public._product_size_restore_problem(uuid, text, text, text, text) OWNER TO postgres;
ALTER FUNCTION public.guard_product_field_app_unit() OWNER TO postgres;
ALTER FUNCTION public.guard_product_parent_member_restorable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_rate_unit_invoiceable(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._product_size_restore_problem(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_product_field_app_unit() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_product_parent_member_restorable() FROM PUBLIC, anon, authenticated, service_role;

-- Named to run after every other products and product_parent_members trigger (rule 5).
CREATE TRIGGER trigger_zzzzzz_products_field_app_unit_guard
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_field_app_unit();
CREATE TRIGGER trigger_zz_product_parent_member_restorable
  BEFORE INSERT OR UPDATE OF product_id, parent_id ON public.product_parent_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_parent_member_restorable();

DO $postflight$
DECLARE
  v_last text;
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public._product_rate_unit_invoiceable(text,text,text)',
                                        'public._product_size_restore_problem(uuid,text,text,text,text)',
                                        'public.guard_product_field_app_unit()',
                                        'public.guard_product_parent_member_restorable()']) f(sig)
               CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) r(role)
              WHERE has_function_privilege(r.role, f.sig, 'EXECUTE'))
     OR EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.oid IN ('public._product_rate_unit_invoiceable(text,text,text)'::regprocedure,
                                 'public._product_size_restore_problem(uuid,text,text,text,text)'::regprocedure,
                                 'public.guard_product_field_app_unit()'::regprocedure,
                                 'public.guard_product_parent_member_restorable()'::regprocedure)
                   AND NOT (p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'])) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_GUARD_POSTFLIGHT: a guard function is callable by an API role or lacks its settings';
  END IF;
  SELECT max(t.tgname::text COLLATE "C") INTO v_last FROM pg_trigger t
   WHERE t.tgrelid = 'public.products'::regclass AND NOT t.tgisinternal AND (t.tgtype & 2) = 2;
  IF v_last IS DISTINCT FROM 'trigger_zzzzzz_products_field_app_unit_guard' THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_GUARD_POSTFLIGHT: the guard is not the last BEFORE trigger on products (last: %)', v_last;
  END IF;
END;
$postflight$;
