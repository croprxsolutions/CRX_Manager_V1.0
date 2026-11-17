-- Written 2026-11-17. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270117140000_billing_m4_db_switch.md.
-- Re-read the live ledger before applying.
--
-- WHY: two more Sol HIGHs from Mason's agents on the unreleased staging billing work (17 Nov, #1892 comment):
--   (1) Sales tax (M4a) and standing discounts (M4b) ship switched OFF on live until commission ships (Mason, 16 Nov),
--       but the switch (src/lib/billingFeatures.ts) only hides the controls. set_order_sales_tax,
--       set_invoice_standing_discount and the customer's standing_discount_pct still accept a change on live.
--   (2) "A misc-charge draft retyped to a chemical sale while the box is ticked can stay untaxed": checked and not
--       changed. The tick (set_order_sales_tax) holds the sale's row; a retype through save_invoice waits on that same
--       row and ends taxed (reproduced locally with the two running at once: the retype waited, then took the rate).
--       The app can't write invoices.invoice_type directly (no column grant), so save_invoice is the only retype path.
--
-- WHAT:
--   1. billing_m4_switch: one row, enabled true/false. RLS on; an active user may read it, nobody can change it
--      through the app (no write grant or policy); a migration turns it on for live with commission. Its starting value: ON where sales tax or a
--      standing discount is already in use (staging), OFF everywhere else (live, which has none before the release
--      because the controls are hidden there; a fresh local or CI database).
--   2. While it's OFF, the database refuses (BILLING_M4_OFF) only what would start charging: ticking a sale's sales
--      tax, giving a customer a standing discount above 0, and setting a sale's own discount above 0. Unticking,
--      setting 0 and "use the customer's rate" always work. Triggers on the three tables, so every path is covered
--      (the RPCs, the customer form, bulk import, any later writer).
--
-- NOT CHANGED: the setters themselves, amounts, posting, drafts already taxed or discounted, the app's switch.
--
-- ROLLBACK (its own reviewed migration): drop the three triggers, their function, _billing_m4_enabled_20270117 and
-- billing_m4_switch.
--
-- ORDERING: after 20270117120000_billing_sol_fixes_staging and 20270117130000_standing_discount_in_order_profit.
-- TURNING IT ON (with commission): its own migration, `UPDATE public.billing_m4_switch SET enabled = true;`.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE billing_m4_switch_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.billing_m4_switch_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.billing_m4_switch_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'BILLING_M4_SWITCH_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.billing_m4_switch') IS NOT NULL THEN
    RAISE EXCEPTION 'BILLING_M4_SWITCH_PREFLIGHT: already applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders'
                  AND column_name = 'sales_tax')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers'
                     AND column_name = 'standing_discount_pct')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = 'invoice_standing_discount_rates' AND column_name = 'drafted_rate_pct') THEN
    RAISE EXCEPTION 'BILLING_M4_SWITCH_PREFLIGHT: the sales tax, standing discount or billing Sol fix migrations are missing';
  END IF;
END
$preflight$;

-- 1. The switch -----------------------------------------------------------------------------------------------
CREATE TABLE public.billing_m4_switch (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT billing_m4_switch_one_row CHECK (id),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.billing_m4_switch IS
  'Sales tax (M4a) and standing discounts (M4b): while enabled is false the database refuses ticking a sale''s tax and '
  'any standing discount above 0 (20270117140000). One row; no app access; a migration turns it on with commission.';
ALTER TABLE public.billing_m4_switch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_m4_switch FROM PUBLIC, anon, authenticated;
-- Reading it is harmless (an active user may see whether it's on); writing has no policy and no grant.
GRANT SELECT ON TABLE public.billing_m4_switch TO authenticated;
CREATE POLICY billing_m4_switch_select ON public.billing_m4_switch FOR SELECT TO authenticated
  USING ((SELECT public.is_active_profile()));

INSERT INTO public.billing_m4_switch (enabled)
SELECT EXISTS (SELECT 1 FROM orders WHERE sales_tax)
    OR EXISTS (SELECT 1 FROM customers WHERE standing_discount_pct > 0)
    OR EXISTS (SELECT 1 FROM invoice_standing_discount_rates WHERE rate_pct > 0);

CREATE FUNCTION public._billing_m4_enabled_20270117()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((SELECT enabled FROM billing_m4_switch), false)
$function$;

REVOKE ALL ON FUNCTION public._billing_m4_enabled_20270117() FROM PUBLIC, anon, authenticated, service_role;

-- 2. The refusals ---------------------------------------------------------------------------------------------
CREATE FUNCTION public._billing_m4_guard_20270117()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public._billing_m4_enabled_20270117() THEN
    RETURN NEW;
  END IF;
  -- Nested per table: PL/pgSQL resolves a NEW field even when an earlier AND is false.
  IF TG_TABLE_NAME = 'orders' THEN
    IF NEW.sales_tax AND (TG_OP = 'INSERT' OR NOT OLD.sales_tax) THEN
      RAISE EXCEPTION 'BILLING_M4_OFF: sales tax isn''t switched on yet; it turns on with commission'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'customers' THEN
    IF NEW.standing_discount_pct > 0
       AND (TG_OP = 'INSERT' OR NEW.standing_discount_pct IS DISTINCT FROM OLD.standing_discount_pct) THEN
      RAISE EXCEPTION 'BILLING_M4_OFF: standing discounts aren''t switched on yet; they turn on with commission'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'invoice_standing_discount_rates' THEN
    -- A sale's own rate (set_by is the office); a drafted row copies the customer's rate, guarded above.
    IF NEW.set_by IS NOT NULL AND NEW.rate_pct > 0
       AND (TG_OP = 'INSERT' OR NEW.rate_pct IS DISTINCT FROM OLD.rate_pct OR OLD.set_by IS NULL) THEN
      RAISE EXCEPTION 'BILLING_M4_OFF: standing discounts aren''t switched on yet; they turn on with commission'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public._billing_m4_guard_20270117() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER orders_billing_m4_guard_20270117
  BEFORE INSERT OR UPDATE OF sales_tax ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public._billing_m4_guard_20270117();
CREATE TRIGGER customers_billing_m4_guard_20270117
  BEFORE INSERT OR UPDATE OF standing_discount_pct ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public._billing_m4_guard_20270117();
CREATE TRIGGER invoice_standing_discount_rates_billing_m4_guard_20270117
  BEFORE INSERT OR UPDATE ON public.invoice_standing_discount_rates
  FOR EACH ROW EXECUTE FUNCTION public._billing_m4_guard_20270117();

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('orders_billing_m4_guard_20270117',
        'customers_billing_m4_guard_20270117', 'invoice_standing_discount_rates_billing_m4_guard_20270117')
        AND NOT tgisinternal) <> 3
     OR (SELECT count(*) FROM billing_m4_switch) <> 1
     OR has_table_privilege('authenticated', 'public.billing_m4_switch', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.billing_m4_switch', 'SELECT,INSERT,UPDATE,DELETE')
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._billing_m4_guard_20270117()'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._billing_m4_enabled_20270117()'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'BILLING_M4_SWITCH_POSTFLIGHT: a trigger, grant or body is not as written';
  END IF;
END
$postflight$;
