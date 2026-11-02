-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate).
--
-- WHAT: record product setup creation and field changes with the session actor and a name snapshot.
--   Note changes record only the field name; note text is never copied into permanent history.
--   A products AFTER trigger writes the history in the product transaction.
-- NOT CHANGED: the admin-only cost history stays as it is; product cost, margin, price, timestamps and
--   future product columns are not watched. Existing product rows are not backfilled.
-- ACCESS CHANGE: a new table is readable only by active authenticated profiles. No API role
--   can write it or execute its trigger functions.
--   Every product created after apply gets a history row; once it has one, it cannot be hard-deleted.
--   Retire products instead of deleting them.
-- ROLLBACK (reviewed migration): remove the products trigger, both functions, and the table.
--   Dropping the table destroys history and needs Mason's explicit approval.
-- ORDERING: apply after every older pending migration; re-read the live ledger before apply.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE product_change_history_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_field text;
BEGIN
  IF to_regclass('pg_temp.product_change_history_tx') IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_NOT_IN_TRANSACTION: apply as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.product_change_history_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_NOT_IN_TRANSACTION: apply as one transaction';
  END IF;
  IF to_regclass('public.product_change_history') IS NOT NULL
     OR to_regprocedure('public.write_product_change_history()') IS NOT NULL
     OR to_regprocedure('public.refuse_product_change_history_mutation()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                  AND tgname = 'trigger_zz_write_product_change_history') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_CHANGE_HISTORY_ALREADY_EXISTS';
  END IF;
  IF to_regclass('public.products') IS NULL OR to_regclass('public.profiles') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_CHANGE_HISTORY_DEPENDENCY_MISSING';
  END IF;
  FOREACH v_field IN ARRAY ARRAY[
    'product_name','sku','category','vendor','manufacturer','container_size','container_unit',
    'container_type','unit_size','inventory_unit','product_form','suggested_rate','rate_per_acre',
    'rate_unit','notes','internal_notes','quoting_notes','is_active','epa_registration','is_rup',
    'signal_word','rei_hours','phi_days','max_label_rate','max_label_rate_unit','use_timing',
    'product_family_id','return_policy','packaging_variant','is_full_tote_only'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.products'::regclass
                   AND attname = v_field AND NOT attisdropped) THEN
      RAISE EXCEPTION 'PREFLIGHT_PRODUCT_CHANGE_HISTORY_FIELD_MISSING: %', v_field;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass
                 AND attname = 'full_name' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_CHANGE_HISTORY_PROFILE_NAME_MISSING';
  END IF;
END;
$preflight$;

CREATE TABLE public.product_change_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  change_type text NOT NULL CHECK (change_type IN ('created', 'updated')),
  field_name text CHECK ((change_type = 'created' AND field_name IS NULL)
                      OR (change_type = 'updated' AND field_name IS NOT NULL)),
  old_value text,
  new_value text,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_change_history OWNER TO postgres;
CREATE INDEX product_change_history_product_recent_idx
  ON public.product_change_history(product_id, changed_at DESC, id DESC);
COMMENT ON TABLE public.product_change_history IS
  'Append-only product setup change history. Cost and price fields are excluded by design; no one edits history rows.';

ALTER TABLE public.product_change_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_change_history_select ON public.product_change_history
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.product_change_history FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_change_history TO authenticated;

CREATE FUNCTION public.refuse_product_change_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_IS_APPEND_ONLY';
END;
$function$;
ALTER FUNCTION public.refuse_product_change_history_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_product_change_history_mutation()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER product_change_history_no_update_delete
  BEFORE UPDATE OR DELETE ON public.product_change_history
  FOR EACH ROW EXECUTE FUNCTION public.refuse_product_change_history_mutation();
CREATE TRIGGER product_change_history_no_truncate
  BEFORE TRUNCATE ON public.product_change_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_product_change_history_mutation();

CREATE FUNCTION public.write_product_change_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_change record;
BEGIN
  SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.product_change_history(product_id, change_type, changed_by, changed_by_name)
    VALUES (NEW.id, 'created', v_actor, v_actor_name);
    RETURN NEW;
  END IF;

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
      ('phi_days', OLD.phi_days::text, NEW.phi_days::text),
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
      (product_id, change_type, field_name, old_value, new_value, changed_by, changed_by_name)
    VALUES (NEW.id, 'updated', v_change.field_name,
            CASE WHEN v_change.field_name IN ('notes', 'internal_notes', 'quoting_notes', 'product_family_id')
              THEN NULL ELSE v_change.old_value END,
            CASE WHEN v_change.field_name IN ('notes', 'internal_notes', 'quoting_notes', 'product_family_id')
              THEN NULL ELSE v_change.new_value END,
            v_actor, v_actor_name);
  END LOOP;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.write_product_change_history() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.write_product_change_history()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_zz_write_product_change_history
  AFTER INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.write_product_change_history();

DO $postflight$
DECLARE
  v_policy pg_policy%ROWTYPE;
BEGIN
  IF NOT (SELECT relrowsecurity AND relowner = 'postgres'::regrole FROM pg_class
          WHERE oid = 'public.product_change_history'::regclass) THEN
    RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_POSTFLIGHT: owner or RLS';
  END IF;
  SELECT * INTO v_policy FROM pg_policy WHERE polrelid = 'public.product_change_history'::regclass;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_change_history'::regclass) <> 1
     OR v_policy.polname <> 'product_change_history_select' OR v_policy.polcmd <> 'r'
     OR v_policy.polroles <> ARRAY['authenticated'::regrole::oid]
     OR position('is_active_profile()' IN pg_get_expr(v_policy.polqual, v_policy.polrelid)) = 0 THEN
    RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_POSTFLIGHT: active-profile SELECT policy';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.product_change_history', 'SELECT')
     OR NOT has_function_privilege('authenticated', 'public.is_active_profile()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.product_change_history', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.product_change_history', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('service_role', 'public.product_change_history', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('metabase_ro', 'public.product_change_history', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_POSTFLIGHT: table privileges';
  END IF;
  IF has_function_privilege('authenticated', 'public.write_product_change_history()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.write_product_change_history()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.write_product_change_history()', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public.write_product_change_history()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refuse_product_change_history_mutation()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refuse_product_change_history_mutation()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.refuse_product_change_history_mutation()', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public.refuse_product_change_history_mutation()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_POSTFLIGHT: trigger-function EXECUTE';
  END IF;
  IF NOT (SELECT prosecdef AND proowner = 'postgres'::regrole
                   AND proconfig = ARRAY['search_path=public, pg_temp']
            FROM pg_proc WHERE oid = 'public.write_product_change_history()'::regprocedure)
     OR NOT (SELECT NOT prosecdef AND proowner = 'postgres'::regrole
                   AND proconfig = ARRAY['search_path=public, pg_temp']
            FROM pg_proc WHERE oid = 'public.refuse_product_change_history_mutation()'::regprocedure) THEN
    RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_POSTFLIGHT: trigger-function owner or mode';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.product_change_history'::regclass
       AND tgname IN ('product_change_history_no_update_delete','product_change_history_no_truncate')
       AND tgenabled = 'O') <> 2
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
       AND tgname = 'trigger_zz_write_product_change_history' AND tgenabled = 'O') <> 1 THEN
    RAISE EXCEPTION 'PRODUCT_CHANGE_HISTORY_POSTFLIGHT: append-only or writer trigger missing';
  END IF;
END;
$postflight$;
