-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261109110000_tiers_credit_limits_admin_only.md.
-- Re-read the live ledger before applying.
--
-- WHAT (permissions; Mason's decision 2026-11-01, Taha's lane item 4, 2026-11-03):
--   1. Price tiers and credit limits are admin-only. guard_customer_rep_edit_20261013 (the trigger
--      that already keeps a customer's commission split admin-only) now also refuses a sales rep who
--      changes a customer's assigned_tier (TIER_ADMIN_ONLY) or credit_limit_cents
--      (CREDIT_LIMIT_ADMIN_ONLY), on every path: the API, save_customer and Bulk Customer Import.
--      A rep's new customer starts on the Settings Default Tier with no credit limit; an admin
--      changes either afterwards. Re-sending an unchanged tier or limit is not a change.
--   2. A booking's tier and planned flag change only through save_quote (permission matrix W05).
--      A new trigger refuses a direct API update of quotes.tier or quotes.is_planned
--      (QUOTE_TIER_PLANNED_VIA_SAVE_QUOTE), for admins too. The SECURITY DEFINER functions that set
--      them (save_quote's implementation, restore-version, auto-expire) run as the owner and are
--      unaffected. The screen's direct status and soft-delete updates don't touch these columns.
--
-- ALSO: the customer guard's trigger now also fires on assigned_tier and credit_limit_cents
--   (it listed only four columns, so a direct update of just the tier never reached it).
-- NOT CHANGED: every existing rule in the customer guard (reassigning a rep, the split,
--   deactivating with open invoices, the prepay balance), its owner, mode, search_path and grants;
--   save_customer and save_quote; every policy and table grant. No column or row changes.
--
-- ROLLBACK (its own reviewed migration): re-emit guard_customer_rep_edit_20261013 from its
--   20261027080200 body and its trigger on its four columns; DROP TRIGGER quotes_guard_direct_tier_planned_20261107 ON public.quotes;
--   DROP FUNCTION public.guard_quote_direct_tier_planned_20261107().
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE tiers_credit_admin_only_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF to_regclass('pg_temp.tiers_credit_admin_only_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.tiers_credit_admin_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'TIERS_CREDIT_ADMIN_ONLY_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- The re-emitted guard, pinned to its current body (20261027080200), owner, mode, search_path
  -- and grants. It has exactly one overload and still guards customers.
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.guard_customer_rep_edit_20261013()');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = 'guard_customer_rep_edit_20261013') <> 1
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '8792615a90e69e2c2ecdf90706fed532'
     OR p.proowner <> 'postgres'::regrole
     OR p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
          WHERE t.tgrelid = 'public.customers'::regclass AND t.tgname = 'customers_guard_rep_edit_20261013'
            AND t.tgfoid = p.oid AND t.tgenabled = 'O')
        IS DISTINCT FROM 'CREATE TRIGGER customers_guard_rep_edit_20261013 BEFORE INSERT OR UPDATE OF assigned_sales_rep, default_commission_split, is_active, prepay_balance_cents ON public.customers FOR EACH ROW EXECUTE FUNCTION guard_customer_rep_edit_20261013()' THEN
    RAISE EXCEPTION 'TIERS_CREDIT_ADMIN_ONLY_PREFLIGHT: guard_customer_rep_edit_20261013 or its trigger drifted from 20261027080200';
  END IF;
  IF to_regprocedure('public.guard_quote_direct_tier_planned_20261107()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass
                  AND tgname = 'quotes_guard_direct_tier_planned_20261107') THEN
    RAISE EXCEPTION 'TIERS_CREDIT_ADMIN_ONLY_PREFLIGHT: the quotes guard already exists';
  END IF;
  IF to_regclass('public.app_settings') IS NULL THEN
    RAISE EXCEPTION 'TIERS_CREDIT_ADMIN_ONLY_PREFLIGHT: app_settings is missing (Default Tier lives there)';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.guard_customer_rep_edit_20261013()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_default_tier integer;
BEGIN
  IF public.is_admin() OR NOT public.is_sales_rep() THEN
    RETURN NEW;
  END IF;
  -- A customer a rep creates directly starts with no prepay balance (prepayments add it later).
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.prepay_balance_cents, 0) <> 0 AND current_user = 'authenticated' THEN
      RAISE EXCEPTION 'PREPAY_BALANCE_SERVER_ONLY: a prepay balance changes only through prepayments and payments';
    END IF;
    -- Only an admin sets a new customer's split too (Mason 2026-10-27); a rep's create carries none.
    IF COALESCE(NEW.default_commission_split, 'null'::jsonb) <> 'null'::jsonb THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_ADMIN_ONLY: only an admin can set a customer''s default commission split';
    END IF;
    -- Price tiers and credit limits are admin-only (Mason 2026-11-01): a rep's new customer starts
    -- on the Settings Default Tier (read the way the screen reads it: 2 or 3, else 1) with no limit.
    SELECT CASE WHEN s.setting_value IN ('2', '3') THEN s.setting_value::integer ELSE 1 END
      INTO v_default_tier
      FROM public.app_settings s WHERE s.setting_key = 'default_tier';
    IF NEW.assigned_tier IS DISTINCT FROM COALESCE(v_default_tier, 1) THEN
      RAISE EXCEPTION 'TIER_ADMIN_ONLY: only an admin can set a customer''s price tier; a new customer starts on the Settings Default Tier';
    END IF;
    IF COALESCE(NEW.credit_limit_cents, 0) <> 0 THEN
      RAISE EXCEPTION 'CREDIT_LIMIT_ADMIN_ONLY: only an admin can set a customer''s credit limit';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.assigned_sales_rep IS DISTINCT FROM OLD.assigned_sales_rep THEN
    RAISE EXCEPTION 'REP_CANNOT_REASSIGN';
  END IF;
  -- Only an admin changes a split, even the customer's own rep (Mason 2026-10-14, 2026-10-26).
  -- Compared after canonical recipient stamping on both sides, so a rep re-saving a split they
  -- did not change (with or without stamped recipient ids) is never refused.
  -- SQL NULL and JSON null both mean "no split".
  IF COALESCE(NEW.default_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(OLD.default_commission_split, 'null'::jsonb)
     AND COALESCE(public.commission_split_with_recipient_ids(NEW.default_commission_split), 'null'::jsonb)
         IS DISTINCT FROM COALESCE(public.commission_split_with_recipient_ids(OLD.default_commission_split), 'null'::jsonb) THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_ADMIN_ONLY: only an admin can change a customer''s default commission split';
  END IF;
  -- Only an admin changes a price tier or a credit limit (Mason 2026-11-01). Re-sending the
  -- unchanged value (the edit page always sends both) is not a change; NULL and 0 are both "no limit".
  IF NEW.assigned_tier IS DISTINCT FROM OLD.assigned_tier THEN
    RAISE EXCEPTION 'TIER_ADMIN_ONLY: only an admin can change a customer''s price tier';
  END IF;
  IF COALESCE(NEW.credit_limit_cents, 0) IS DISTINCT FROM COALESCE(OLD.credit_limit_cents, 0) THEN
    RAISE EXCEPTION 'CREDIT_LIMIT_ADMIN_ONLY: only an admin can change a customer''s credit limit';
  END IF;
  IF OLD.is_active IS TRUE AND NEW.is_active IS NOT TRUE
     AND public._customer_has_open_invoice_20261013(OLD.id) THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_OPEN_INVOICES: this customer has posted or overdue invoices; resolve them before deactivating it';
  END IF;
  IF NEW.prepay_balance_cents IS DISTINCT FROM OLD.prepay_balance_cents
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'PREPAY_BALANCE_SERVER_ONLY: a prepay balance changes only through prepayments and payments';
  END IF;
  RETURN NEW;
END;
$function$
;

-- The trigger fires only on the columns it lists; add the tier and the credit limit so a direct
-- update of just those reaches the guard too (save_customer writes every column, so it already did).
DROP TRIGGER customers_guard_rep_edit_20261013 ON public.customers;
CREATE TRIGGER customers_guard_rep_edit_20261013
  BEFORE INSERT OR UPDATE OF assigned_sales_rep, default_commission_split, is_active, prepay_balance_cents,
                             assigned_tier, credit_limit_cents
  ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_rep_edit_20261013();

-- A booking's tier and planned flag change only through save_quote (W05). current_user is
-- 'authenticated'/'anon' only for a direct API write; SECURITY DEFINER functions run as the owner.
CREATE FUNCTION public.guard_quote_direct_tier_planned_20261107()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.tier IS DISTINCT FROM OLD.tier OR NEW.is_planned IS DISTINCT FROM OLD.is_planned) THEN
    RAISE EXCEPTION 'QUOTE_TIER_PLANNED_VIA_SAVE_QUOTE: a booking''s tier and planned flag change only by saving the quote';
  END IF;
  RETURN NEW;
END;
$function$
;

-- A trigger function: nobody calls it directly (same grants as the customer guard).
REVOKE ALL ON FUNCTION public.guard_quote_direct_tier_planned_20261107() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER quotes_guard_direct_tier_planned_20261107
  BEFORE UPDATE OF tier, is_planned ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote_direct_tier_planned_20261107();

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
  q pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.guard_customer_rep_edit_20261013()');
  SELECT * INTO q FROM pg_proc WHERE oid = to_regprocedure('public.guard_quote_direct_tier_planned_20261107()');
  IF p.oid IS NULL OR q.oid IS NULL
     OR position('TIER_ADMIN_ONLY' IN p.prosrc) = 0
     OR position('CREDIT_LIMIT_ADMIN_ONLY' IN p.prosrc) = 0
     OR position('COMMISSION_SPLIT_ADMIN_ONLY' IN p.prosrc) = 0
     OR position('PREPAY_BALANCE_SERVER_ONLY' IN p.prosrc) = 0
     OR position('CUSTOMER_HAS_OPEN_INVOICES' IN p.prosrc) = 0
     OR position('REP_CANNOT_REASSIGN' IN p.prosrc) = 0
     OR p.proowner <> 'postgres'::regrole OR p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR q.proowner <> 'postgres'::regrole OR q.prosecdef
     OR q.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR q.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
          WHERE t.tgrelid = 'public.customers'::regclass AND t.tgname = 'customers_guard_rep_edit_20261013'
            AND t.tgfoid = p.oid AND t.tgenabled = 'O')
        IS DISTINCT FROM 'CREATE TRIGGER customers_guard_rep_edit_20261013 BEFORE INSERT OR UPDATE OF assigned_sales_rep, default_commission_split, is_active, prepay_balance_cents, assigned_tier, credit_limit_cents ON public.customers FOR EACH ROW EXECUTE FUNCTION guard_customer_rep_edit_20261013()'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.quotes'::regclass AND t.tgname = 'quotes_guard_direct_tier_planned_20261107'
                       AND t.tgfoid = q.oid AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTFLIGHT: a guard lost its change, owner, mode, search_path, grants or trigger';
  END IF;
END
$postflight$;
