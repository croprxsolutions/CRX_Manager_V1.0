-- REI / PHI "not applicable" (contract: docs/plans/2026-11-24-rei-phi-not-applicable-CONTRACT.md).
--
-- WHY: many pesticide labels give no REI or no corn/soybean PHI. Today a blank interval means "not entered", so those
--   products show "Incomplete setup" forever. Storing 0 instead would be unsafe: 0 means "no wait".
--
-- WHAT:
--   * products.rei_not_applicable / phi_not_applicable (boolean, default false = today's meaning for every row).
--   * CHECK: a flag is only allowed while its interval is blank.
--   * BEFORE trigger: every accepted numeric interval write clears its flag (a number wins), so Label Review,
--     the setup workbook and bulk import keep working on a flagged product. A changed EPA number clears a flag the
--     same statement did not set (a new label needs a new review). It never sets a flag or a number.
--   * Column grants mirror rei_hours for authenticated; products RLS (admin-only writes) is unchanged.
--   * write_product_change_history re-issued from 20261108120000 (body verified identical to live 2026-11-24)
--     with the two flags added to its watched-field list.
--
-- NON-DESTRUCTIVE: adds two columns with a constant default, two CHECKs (valid on every existing row: all flags
--   false), one trigger; no row is changed.
-- ROLLBACK: prefer rolling back the screens only (the columns are additive and harmless to the old app). A schema
--   rollback is a reviewed migration that first saves the flagged product ids, then drops the trigger and its
--   function, the two CHECKs and the two columns, and re-issues write_product_change_history from its then-current
--   body minus the two flag lines. History rows naming the flags stay as written.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.products'::regclass
              AND attname IN ('rei_not_applicable', 'phi_not_applicable') AND NOT attisdropped)
     OR to_regprocedure('public.clear_product_interval_not_applicable()') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_INTERVAL_NA_ALREADY_EXISTS';
  END IF;
  IF to_regprocedure('public.write_product_change_history()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                    AND tgname = 'trigger_zz_write_product_change_history' AND tgenabled = 'O')
     -- The exact 20261108120000 body (line endings ignored), read on production 2026-11-24.
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
          WHERE oid = 'public.write_product_change_history()'::regprocedure)
        IS DISTINCT FROM '2e314e3507a700a78d91e72885a861dd' THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_CHANGE_HISTORY_CHANGED: re-read write_product_change_history before re-issuing it';
  END IF;
END;
$preflight$;

ALTER TABLE public.products
  ADD COLUMN rei_not_applicable boolean NOT NULL DEFAULT false,
  ADD COLUMN phi_not_applicable boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT products_rei_not_applicable_blank CHECK (NOT (rei_not_applicable AND rei_hours IS NOT NULL)),
  ADD CONSTRAINT products_phi_not_applicable_blank CHECK (NOT (phi_not_applicable AND phi_days IS NOT NULL));
COMMENT ON COLUMN public.products.rei_not_applicable IS
  'The label gives no REI. Only while rei_hours is blank; writing rei_hours clears it. Never stored as 0.';
COMMENT ON COLUMN public.products.phi_not_applicable IS
  'The label gives no PHI. Only while phi_days is blank; writing phi_days clears it. Never stored as 0.';

GRANT INSERT (rei_not_applicable, phi_not_applicable) ON public.products TO authenticated;
GRANT UPDATE (rei_not_applicable, phi_not_applicable) ON public.products TO authenticated;
GRANT SELECT (rei_not_applicable, phi_not_applicable) ON public.products TO authenticated;
GRANT REFERENCES (rei_not_applicable, phi_not_applicable) ON public.products TO authenticated;

CREATE FUNCTION public.clear_product_interval_not_applicable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  -- Same spelling rule as _normalize_epa_registration, inlined: this runs as the saving user, who may not call it.
  IF TG_OP = 'UPDATE' AND NULLIF(upper(regexp_replace(COALESCE(NEW.epa_registration, ''), '\s', '', 'g')), '')
       IS DISTINCT FROM NULLIF(upper(regexp_replace(COALESCE(OLD.epa_registration, ''), '\s', '', 'g')), '') THEN
    IF NEW.rei_not_applicable IS NOT DISTINCT FROM OLD.rei_not_applicable THEN NEW.rei_not_applicable := false; END IF;
    IF NEW.phi_not_applicable IS NOT DISTINCT FROM OLD.phi_not_applicable THEN NEW.phi_not_applicable := false; END IF;
  END IF;
  IF NEW.rei_hours IS NOT NULL THEN NEW.rei_not_applicable := false; END IF;
  IF NEW.phi_days IS NOT NULL THEN NEW.phi_not_applicable := false; END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.clear_product_interval_not_applicable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clear_product_interval_not_applicable()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trg_clear_product_interval_not_applicable
  BEFORE INSERT OR UPDATE OF rei_hours, phi_days, rei_not_applicable, phi_not_applicable, epa_registration
  ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.clear_product_interval_not_applicable();

-- Re-issued from 20261108120000 with one change: the two not-applicable flags are watched fields.
CREATE OR REPLACE FUNCTION public.write_product_change_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_change record;
  v_parent_event bigint;
BEGIN
  SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.product_change_history(product_id, change_type, changed_by, changed_by_name)
    VALUES (NEW.id, 'created', v_actor, v_actor_name);
    RETURN NEW;
  END IF;
  SELECT parent_event_id INTO v_parent_event FROM public.product_parent_copy_passes
   WHERE txid = txid_current() AND product_id = NEW.id;

  -- Explicit setup allow-list: a future product column is not watched until added here.
  -- Notes and product_family_id record only the changed field, never either value.
  FOR v_change IN
    SELECT field_name, old_value, new_value FROM (VALUES
      ('product_name', NULLIF(OLD.product_name::text, ''), NULLIF(NEW.product_name::text, '')),
      ('sku', NULLIF(OLD.sku::text, ''), NULLIF(NEW.sku::text, '')),
      ('category', NULLIF(OLD.category::text, ''), NULLIF(NEW.category::text, '')),
      ('vendor', NULLIF(OLD.vendor::text, ''), NULLIF(NEW.vendor::text, '')),
      ('manufacturer', NULLIF(OLD.manufacturer::text, ''), NULLIF(NEW.manufacturer::text, '')),
      ('container_size', trim_scale(OLD.container_size)::text, trim_scale(NEW.container_size)::text),
      ('container_unit', NULLIF(OLD.container_unit::text, ''), NULLIF(NEW.container_unit::text, '')),
      ('container_type', NULLIF(OLD.container_type::text, ''), NULLIF(NEW.container_type::text, '')),
      ('unit_size', NULLIF(OLD.unit_size::text, ''), NULLIF(NEW.unit_size::text, '')),
      ('inventory_unit', NULLIF(OLD.inventory_unit::text, ''), NULLIF(NEW.inventory_unit::text, '')),
      ('product_form', NULLIF(OLD.product_form::text, ''), NULLIF(NEW.product_form::text, '')),
      ('suggested_rate', NULLIF(OLD.suggested_rate::text, ''), NULLIF(NEW.suggested_rate::text, '')),
      ('rate_per_acre', trim_scale(OLD.rate_per_acre)::text, trim_scale(NEW.rate_per_acre)::text),
      ('rate_unit', NULLIF(OLD.rate_unit::text, ''), NULLIF(NEW.rate_unit::text, '')),
      ('notes', NULLIF(OLD.notes::text, ''), NULLIF(NEW.notes::text, '')),
      ('internal_notes', NULLIF(OLD.internal_notes::text, ''), NULLIF(NEW.internal_notes::text, '')),
      ('quoting_notes', NULLIF(OLD.quoting_notes::text, ''), NULLIF(NEW.quoting_notes::text, '')),
      ('is_active', OLD.is_active::text, NEW.is_active::text),
      ('epa_registration', NULLIF(OLD.epa_registration::text, ''), NULLIF(NEW.epa_registration::text, '')),
      ('is_rup', OLD.is_rup::text, NEW.is_rup::text),
      ('signal_word', NULLIF(OLD.signal_word::text, ''), NULLIF(NEW.signal_word::text, '')),
      ('rei_hours', OLD.rei_hours::text, NEW.rei_hours::text),
      ('rei_not_applicable', OLD.rei_not_applicable::text, NEW.rei_not_applicable::text),
      ('phi_days', OLD.phi_days::text, NEW.phi_days::text),
      ('phi_not_applicable', OLD.phi_not_applicable::text, NEW.phi_not_applicable::text),
      ('max_label_rate', trim_scale(OLD.max_label_rate)::text, trim_scale(NEW.max_label_rate)::text),
      ('max_label_rate_unit', NULLIF(OLD.max_label_rate_unit::text, ''), NULLIF(NEW.max_label_rate_unit::text, '')),
      ('use_timing', NULLIF(OLD.use_timing::text, ''), NULLIF(NEW.use_timing::text, '')),
      ('product_family_id', OLD.product_family_id::text, NEW.product_family_id::text),
      ('return_policy', NULLIF(OLD.return_policy::text, ''), NULLIF(NEW.return_policy::text, '')),
      ('packaging_variant', NULLIF(OLD.packaging_variant::text, ''), NULLIF(NEW.packaging_variant::text, '')),
      ('is_full_tote_only', OLD.is_full_tote_only::text, NEW.is_full_tote_only::text)
    ) AS fields(field_name, old_value, new_value)
    WHERE old_value IS DISTINCT FROM new_value
  LOOP
    INSERT INTO public.product_change_history
      (product_id, change_type, field_name, old_value, new_value, changed_by, changed_by_name, parent_event_id)
    VALUES (NEW.id, CASE WHEN v_parent_event IS NULL THEN 'updated' ELSE 'parent_copy' END, v_change.field_name,
            CASE WHEN v_change.field_name IN ('notes', 'internal_notes', 'quoting_notes', 'product_family_id')
              THEN NULL ELSE v_change.old_value END,
            CASE WHEN v_change.field_name IN ('notes', 'internal_notes', 'quoting_notes', 'product_family_id')
              THEN NULL ELSE v_change.new_value END,
            v_actor, v_actor_name, v_parent_event);
  END LOOP;
  RETURN NEW;
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM public.products WHERE rei_not_applicable OR phi_not_applicable) <> 0 THEN
    RAISE EXCEPTION 'PRODUCT_INTERVAL_NA_POSTFLIGHT: an existing row was flagged';
  END IF;
  -- Each flag carries exactly its interval column's privileges (table-level grants included).
  IF EXISTS (
    SELECT 1 FROM (VALUES ('rei_not_applicable', 'rei_hours'), ('phi_not_applicable', 'phi_days')) AS c(col, base)
     WHERE EXISTS (SELECT grantee, privilege_type FROM information_schema.column_privileges
                    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = c.base
                   EXCEPT SELECT grantee, privilege_type FROM information_schema.column_privileges
                    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = c.col)
        OR EXISTS (SELECT grantee, privilege_type FROM information_schema.column_privileges
                    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = c.col
                   EXCEPT SELECT grantee, privilege_type FROM information_schema.column_privileges
                    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = c.base)
  ) THEN
    RAISE EXCEPTION 'PRODUCT_INTERVAL_NA_POSTFLIGHT: column privileges differ from the interval column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                 AND tgname = 'trg_clear_product_interval_not_applicable' AND tgenabled = 'O')
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.write_product_change_history()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.clear_product_interval_not_applicable()'::regprocedure)
     OR (SELECT proconfig FROM pg_proc WHERE oid = 'public.write_product_change_history()'::regprocedure)
        IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) AS r(role_name)
                 WHERE has_function_privilege(r.role_name, 'public.write_product_change_history()', 'EXECUTE')
                    OR has_function_privilege(r.role_name, 'public.clear_product_interval_not_applicable()', 'EXECUTE')) THEN
    RAISE EXCEPTION 'PRODUCT_INTERVAL_NA_POSTFLIGHT: triggers';
  END IF;
END;
$postflight$;
