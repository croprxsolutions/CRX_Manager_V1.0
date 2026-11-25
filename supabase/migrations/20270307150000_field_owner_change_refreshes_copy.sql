-- 20270307150000_field_owner_change_refreshes_copy.sql
-- Record: docs/reference/migrations.d/20270307150000_field_owner_change_refreshes_copy.md
-- Contract: docs/plans/2026-11-25-fp1-owner-change-copy-CONTRACT.md (FP-1 follow-up, Sol round 6 on #2487).
--
-- WHAT: a field's owner decides its main payer (FP-1: the copy in field_billing_defaults marks the owner primary when
--   the owner pays, else the largest share). save_field refreshes the copy, but an owner change made by a direct
--   UPDATE left the old owner marked primary until the nightly refresh, so Create Invoice in between could anchor a
--   job to the old owner's invoice. Now every owner change refreshes that field's copy in the same transaction.
--
-- NOT CHANGED: who may change an owner (fields policies and FP-1's fields_owner_change_page_access BEFORE trigger),
--   split versions, shares and payers (the copy is rebuilt from the version in force today, as every refresh does),
--   posted invoices, the nightly job. save_field's code is unchanged; when it changes the owner the copy is rebuilt
--   twice in one transaction (this trigger, then save_field's own refresh), same result.
--
-- INSTALL WAIT: the catch-up runs FP-1's nightly refresh, whose own lock_timeout is 30s; while it waits behind an
--   order invoice, field writes queue behind this migration's trigger lock. Worst case it times out and nothing applies.
--
-- LOCK ORDER: the UPDATE holds the field row, then the refresh rewrites the copy rows: the same order as the split
--   writer and save_field (field, then copy), so no new wait cycle with invoice writers.
--
-- ROLLBACK (its own reviewed migration): DROP TRIGGER fields_owner_change_refreshes_copy ON public.fields;
--   DROP FUNCTION public._fields_owner_change_refresh_copy_20270305(). The nightly refresh still repairs copies.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._refresh_field_billing_defaults_copy_20270303(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: FP-1 (20270305190000_field_split_versions) must be applied first';
  END IF;
  IF NOT has_function_privilege('postgres', 'public._refresh_field_billing_defaults_copy_20270303(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: postgres cannot execute _refresh_field_billing_defaults_copy_20270303';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.fields'::regclass AND tgname = 'fields_owner_change_refreshes_copy') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: trigger fields_owner_change_refreshes_copy already exists';
  END IF;
END
$preflight$;

-- SECURITY DEFINER: the copy refresh is granted to no API role, and the person changing the owner may be any role the
-- fields policies allow.
CREATE FUNCTION public._fields_owner_change_refresh_copy_20270305()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._refresh_field_billing_defaults_copy_20270303(NEW.id);
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public._fields_owner_change_refresh_copy_20270305() FROM PUBLIC, anon, authenticated, service_role;
-- Owned by postgres, which the preflight confirmed can run the refresh helper (granted to no API role).
ALTER FUNCTION public._fields_owner_change_refresh_copy_20270305() OWNER TO postgres;

CREATE TRIGGER fields_owner_change_refreshes_copy AFTER UPDATE OF customer_id ON public.fields
  FOR EACH ROW WHEN (OLD.customer_id IS DISTINCT FROM NEW.customer_id)
  EXECUTE FUNCTION public._fields_owner_change_refresh_copy_20270305();

-- An owner changed by a direct UPDATE since the last nightly run is repaired now, not at the next run. A field row
-- someone holds is skipped (as the nightly run does); the next nightly run repairs it.
DO $catch_up$
DECLARE
  v_changed integer := public._refresh_all_field_billing_copies_20270303();
BEGIN
  RAISE NOTICE 'FIELD_OWNER_COPY_CATCH_UP: % stale copy(ies) refreshed', v_changed;
END
$catch_up$;

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.fields'::regclass
      AND tgname = 'fields_owner_change_refreshes_copy' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: trigger fields_owner_change_refreshes_copy missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public._fields_owner_change_refresh_copy_20270305()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fields_owner_change_refresh_copy_20270305()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._fields_owner_change_refresh_copy_20270305()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: an API role can execute _fields_owner_change_refresh_copy_20270305';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: owner change refreshes the billing copy';
END
$postflight$;
