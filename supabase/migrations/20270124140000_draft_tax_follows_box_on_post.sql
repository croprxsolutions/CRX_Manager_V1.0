-- Written 2026-11-17. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270124140000_draft_tax_follows_box_on_post.md.
-- Re-read the live ledger before applying.
--
-- WHY (Sol HIGH on staging, 17 Nov, PR #1940 round 21, at 20270117120000_billing_sol_fixes_staging.sql:361):
--   set_order_sales_tax keeps the tax a draft already has when the save path can't re-save that draft (a Bill Split
--   payer's draft with a no-quantity line, or a governed field split; 20270117120000 (D)). Nothing then stopped that
--   draft posting: a sale ticked for tax could post an untaxed payer invoice, and an unticked one a taxed invoice.
--
-- WHAT: posting a chemical-sale DRAFT is refused (SALES_TAX_BOX_MISMATCH, nothing changes) when its tax doesn't
--   follow its sale's sales tax box:
--     - it has a tax rate (an invoice_sales_tax_rates row) but the box is off; or
--     - the box is on, it has no tax rate, and the M4 switch is on. (While the switch is off a new draft is untaxed
--       by design, 20270117140000, so that case is allowed then.)
--   A BEFORE UPDATE OF status trigger on invoices, beside the stale-line guard (20270109100200), so every posting
--   path is covered (post_invoice, post_invoice_group, any later writer), and draft -> unposted too. The office fixes it by
--   switching the box over and back, ending where they want it (any change re-applies the box to the drafts the save
--   path can re-save), or by voiding a locked group and redrafting it (the redraft follows the box).
--
-- NOT CHANGED: set_order_sales_tax, the tax amounts and recompute, the stale-line guard, the M4 switch, unposted
--   invoices being posted again (they keep the tax they were first posted with), misc-charge and other invoice types.
--
-- EXISTING ROWS: live has no tax rate rows and no ticked sale (the feature ships with the switch off), so no live
--   draft is refused. A draft that would be refused today is counted in a NOTICE; nothing is changed or blocked.
--
-- ROLLBACK (its own reviewed migration): DROP TRIGGER zz_sales_tax_matches_box_on_post_20270124 ON public.invoices;
--   DROP FUNCTION public.guard_sales_tax_box_on_post_20270124();
--   Roll this back BEFORE any rollback of 20270117140000 (that one drops _billing_m4_enabled_20270117, which this calls).
--
-- ORDERING: after 20270117140000_billing_m4_db_switch (calls _billing_m4_enabled_20270117).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE draft_tax_box_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.draft_tax_box_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.draft_tax_box_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DRAFT_TAX_BOX_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public.guard_sales_tax_box_on_post_20270124()') IS NOT NULL THEN
    RAISE EXCEPTION 'DRAFT_TAX_BOX_PREFLIGHT: already applied';
  END IF;
  IF to_regclass('public.invoice_sales_tax_rates') IS NULL
     OR to_regprocedure('public._billing_m4_enabled_20270117()') IS NULL
     -- The stale-line guard checks the tax cents; this one only checks taxed vs untaxed, so it relies on that one.
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.invoices'::regclass
                       AND t.tgname = 'invoices_sales_tax_current_on_post_20261231' AND t.tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sales_tax') THEN
    RAISE EXCEPTION 'DRAFT_TAX_BOX_PREFLIGHT: needs orders.sales_tax, invoice_sales_tax_rates and the M4 switch';
  END IF;
END
$preflight$;

CREATE FUNCTION public.guard_sales_tax_box_on_post_20270124()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_box boolean;
  v_taxed boolean;
BEGIN
  v_box := COALESCE((SELECT o.sales_tax FROM orders o WHERE o.id = NEW.order_id), false);
  v_taxed := EXISTS (SELECT 1 FROM invoice_sales_tax_rates r WHERE r.invoice_id = NEW.id);
  IF (v_taxed AND NOT v_box) OR (v_box AND NOT v_taxed AND public._billing_m4_enabled_20270117()) THEN
    RAISE EXCEPTION 'SALES_TAX_BOX_MISMATCH: this draft is % but its sale''s sales tax box is %; switch the box over and back, ending at the setting you want, to re-apply it to the sale''s drafts (a split draft that can''t be edited: void the group and redraft it), then post',
      CASE WHEN v_taxed THEN 'taxed' ELSE 'untaxed' END, CASE WHEN v_box THEN 'on' ELSE 'off' END
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_sales_tax_box_on_post_20270124() FROM PUBLIC, anon, authenticated, service_role;

-- Only a draft leaving draft (draft -> unposted is a legal step too, so it can't skip the check): an invoice already
-- unposted keeps the tax it was first posted with. A soft-deleted draft is checked too (no app path posts one). Named zz_ to fire last of the
-- BEFORE triggers (they run by name): a stale tax line (invoices_sales_tax_current_on_post_20261231), a closed sale,
-- a stale discount or a blank unit still reports its own, more specific, refusal first.
CREATE TRIGGER zz_sales_tax_matches_box_on_post_20270124
  BEFORE UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status IN ('unposted', 'posted', 'paid', 'overdue')
        AND NEW.invoice_type = 'chemical_sale')
  EXECUTE FUNCTION public.guard_sales_tax_box_on_post_20270124();

DO $postflight$
DECLARE
  v_refused int;
  v_later int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.guard_sales_tax_box_on_post_20270124()'::regprocedure
                    AND p.prosecdef AND p.proowner = 'postgres'::regrole
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                    AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[])
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgname = 'zz_sales_tax_matches_box_on_post_20270124'
                       AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O' AND NOT t.tgisinternal
                       AND t.tgfoid = 'public.guard_sales_tax_box_on_post_20270124()'::regprocedure) THEN
    RAISE EXCEPTION 'DRAFT_TAX_BOX_POSTFLIGHT: the guard''s grants, settings or trigger are not as written';
  END IF;
  SELECT count(*) INTO v_refused
    FROM invoices i LEFT JOIN orders o ON o.id = i.order_id
   WHERE i.status = 'draft' AND i.deleted_at IS NULL AND i.invoice_type = 'chemical_sale'
     AND ((EXISTS (SELECT 1 FROM invoice_sales_tax_rates r WHERE r.invoice_id = i.id) AND NOT COALESCE(o.sales_tax, false))
          OR (COALESCE(o.sales_tax, false) AND public._billing_m4_enabled_20270117()
              AND NOT EXISTS (SELECT 1 FROM invoice_sales_tax_rates r WHERE r.invoice_id = i.id)));
  -- Ticked sales' untaxed drafts made while the switch is off: allowed now, refused once the switch goes on.
  SELECT count(*) INTO v_later
    FROM invoices i JOIN orders o ON o.id = i.order_id
   WHERE i.status = 'draft' AND i.deleted_at IS NULL AND i.invoice_type = 'chemical_sale' AND o.sales_tax
     AND NOT public._billing_m4_enabled_20270117()
     AND NOT EXISTS (SELECT 1 FROM invoice_sales_tax_rates r WHERE r.invoice_id = i.id);
  RAISE NOTICE 'DRAFT_TAX_BOX_POSTFLIGHT_OK: % draft(s) now refused at posting until redrafted or the box is set back; % more once the M4 switch is on', v_refused, v_later;
END
$postflight$;
