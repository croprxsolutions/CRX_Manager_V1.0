-- Written 2026-11-16. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270109100500_billing_sol_fixes_staging.md.
-- Re-read the live ledger before applying.
--
-- WHY: Mason's agents' Sol runs on staging (16 Nov, #1904 comments) found, in the unreleased billing migrations:
--   (A) BLOCKER: the return-credit tax freeze (20270109100400) refused a credit line with no source line, but
--       _issue_return_credit_impl writes one on purpose for quantity delivered but never billed, so issuing that
--       credit rolled back, and the freeze's backfill could fail on a database that already has one.
--   (D) HIGH x2 + MED: set_invoice_standing_discount and set_order_sales_tax re-save each draft through save_invoice,
--       which refuses a governed field-split draft (SPLIT_INVOICE_EDIT_REQUIRES_REISSUE) and a Bill Split payer's
--       draft with a no-quantity line (BILL_SPLIT_SLIVER_LOCKED). The tax switch then rolled back for the whole sale.
--   (E) HIGH: "the customer's rate" (p_pct NULL) deleted the draft's recorded rate, so the next recompute recorded the
--       customer's CURRENT rate: drafted at 5%, customer moved to 10%, office overrode to 3%, reverted -> 10%, not 5%.
--
-- WHAT:
--   1. _freeze_credit_sales_tax_20270109: the refusal is gone. A line with no source line was never billed, so it
--      carries no tax; the freeze's JOIN already leaves it out. Nothing else in the body changes.
--   2. _invoice_resave_locked_20270109(invoice): NULL when save_invoice can re-save the draft, else the plain reason,
--      using save_invoice's own two tests (20261215110000).
--   3. set_invoice_standing_discount: a locked draft is refused up front with that reason (nothing changes). The first
--      office override keeps the drafted rate in invoice_standing_discount_rates.drafted_rate_pct (new column), and
--      "the customer's rate" puts it back; a draft never overridden keeps its drafted row.
--   4. set_order_sales_tax: a locked draft keeps the tax it has (like a posted invoice) instead of rolling back the
--      whole switch; the sale's box still changes, a void-and-redraft follows it, and the answer lists those drafts
--      in 'drafts_kept'.
--
-- NOT CHANGED: posting, the tax and discount amounts, the recompute, save_invoice and its guards, return credits'
-- amounts, every other writer. Office-typed credit memos: Mason, 16 Nov: they never include sales tax.
-- Existing overrides on staging have no drafted rate recorded (drafted_rate_pct NULL), so reverting one of those still
-- takes today's path; every override from now on can be reverted to its drafted rate. Live has no overrides.
--
-- ROLLBACK (its own reviewed migration): restore the three functions to the bodies pinned below, drop
-- _invoice_resave_locked_20270109 and invoice_standing_discount_rates.drafted_rate_pct.
--
-- ORDERING: after 20270109100400_sales_tax_not_revenue (re-emits its freeze and the two setters it re-emitted).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE billing_sol_fixes_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.billing_sol_fixes_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.billing_sol_fixes_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'BILLING_SOL_FIXES_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._invoice_resave_locked_20270109(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'invoice_standing_discount_rates' AND column_name = 'drafted_rate_pct') THEN
    RAISE EXCEPTION 'BILLING_SOL_FIXES_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._order_has_bill_split(uuid)') IS NULL
     OR to_regclass('public.split_invoice_provenance') IS NULL THEN
    RAISE EXCEPTION 'BILLING_SOL_FIXES_PREFLIGHT: the split tables or _order_has_bill_split are missing';
  END IF;
  -- The three functions re-emitted below, exactly as 20270109100400 left them.
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public._freeze_credit_sales_tax_20270109(uuid)', 'e78e4f22b63fc4ce9d4924656f3060bc', ARRAY['postgres=X/postgres'], 0),
      ('public.set_invoice_standing_discount(uuid,numeric,text)', '8e27085f3b2395f61a35957e149e1f9b', ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres'], 1),
      ('public.set_order_sales_tax(uuid,boolean,text)', '0dfa51c2c66f78dd94dd0afb95c3ae77', ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres'], 1)
    ) AS f(name, md5, acl, ndef)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef
        AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl = f.acl::aclitem[]
        AND p.pronargdefaults = f.ndef);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'BILLING_SOL_FIXES_PREFLIGHT: drifted from 20270109100400: %', v_bad;
  END IF;
END
$preflight$;

-- 1. (A) The return-credit tax freeze no longer refuses a never-billed line ---------------------------------------
CREATE OR REPLACE FUNCTION public._freeze_credit_sales_tax_20270109(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record;
  v_key record;
  v_pool_cents numeric;
  v_pool_tax numeric;
  v_tax bigint;
BEGIN
  SELECT i.id, i.invoice_type, i.status, i.deleted_at, i.customer_id,
         COALESCE(i.posted_at, i.created_at) AS booked_at INTO v_inv
    FROM public.invoices i WHERE i.id = p_invoice_id;
  IF NOT FOUND OR v_inv.invoice_type IS DISTINCT FROM 'credit_memo' THEN
    RETURN;
  END IF;
  -- one freeze or clear per customer at a time, so a credit never freezes against one being cleared
  -- (ponytail: per customer; a per-line-pool lock if credits ever queue up)
  PERFORM pg_advisory_xact_lock(hashtextextended('credit_memo_sales_tax:' || v_inv.customer_id::text, 0));
  IF v_inv.deleted_at IS NOT NULL OR v_inv.status NOT IN ('posted', 'overdue', 'paid') THEN
    DELETE FROM public.credit_memo_sales_tax WHERE invoice_id = p_invoice_id;
    RETURN;
  END IF;
  -- (A) A return credit line with no source line is the quantity delivered but never billed
  -- (_issue_return_credit_impl's NULL arm): it carries no tax, so it simply isn't in the loop below (the JOIN
  -- skips it). It used to refuse the credit here, which rolled back a valid return.
  IF EXISTS (SELECT 1 FROM public.credit_memo_sales_tax WHERE invoice_id = p_invoice_id) THEN
    RETURN;  -- already frozen (posted -> overdue -> paid keeps it)
  END IF;
  FOR v_key IN
    -- a credited line with no order line (a charge, or a product billed by hand) pools on its own source line, at
    -- that line's own whole-cent tax share
    SELECT COALESCE(src.order_item_id, src.id) AS line_key, src.order_item_id IS NULL AS is_charge,
           sum(ii.extended_cents) AS cents
      FROM public.invoice_items ii
      JOIN public.invoice_items src ON src.id = ii.return_credit_source_item_id
     WHERE ii.invoice_id = p_invoice_id
     GROUP BY 1, 2
  LOOP
    SELECT COALESCE(sum(sh.net_cents), 0), COALESCE(sum(sh.tax_cents), 0) INTO v_pool_cents, v_pool_tax
      FROM public.invoices i
      CROSS JOIN LATERAL public._invoice_line_tax_shares_20270109(i.id) sh
      JOIN public.invoice_items b ON b.id = sh.item_id
     WHERE i.customer_id = v_inv.customer_id
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status IN ('posted', 'overdue', 'paid')
       AND COALESCE(i.posted_at, i.created_at) <= v_inv.booked_at
       AND CASE WHEN v_key.is_charge
                THEN b.id = v_key.line_key AND b.order_item_id IS NULL
                ELSE i.id IN (SELECT o.invoice_id FROM public.invoice_items o WHERE o.order_item_id = v_key.line_key)
                     AND b.order_item_id = v_key.line_key AND b.quantity > 0 AND b.product_id IS NOT NULL
           END;
    SELECT v_pool_cents + COALESCE(sum(c.line_cents), 0), v_pool_tax + COALESCE(sum(c.tax_cents), 0)
      INTO v_pool_cents, v_pool_tax
      FROM public.credit_memo_sales_tax c
     WHERE c.line_key = v_key.line_key AND c.customer_id = v_inv.customer_id;
    v_tax := CASE
      WHEN v_pool_cents <= 0 THEN 0
      WHEN v_pool_cents + v_key.cents <= 0 THEN -v_pool_tax          -- takes all that remains
      ELSE round(v_key.cents * v_pool_tax / v_pool_cents)
    END;
    INSERT INTO public.credit_memo_sales_tax (invoice_id, line_key, customer_id, line_cents, tax_cents)
    VALUES (p_invoice_id, v_key.line_key, v_inv.customer_id, v_key.cents, v_tax);
  END LOOP;
END
$function$;

-- 2. (D) Can save_invoice re-save this draft? NULL if yes, else the plain reason ----------------------------------
-- The same two tests save_invoice makes (20261215110000): a governed split that isn't a Bill Split draft, and a
-- Bill Split draft with a no-quantity product line.
CREATE FUNCTION public._invoice_resave_locked_20270109(p_invoice_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH inv AS (
    SELECT i.id,
           (i.status IN ('draft', 'unposted') AND i.delivery_id IS NOT NULL AND i.invoice_group_id IS NOT NULL
            AND public._order_has_bill_split(i.order_id)) AS bill_split_draft
      FROM public.invoices i WHERE i.id = p_invoice_id
  )
  SELECT CASE
    WHEN inv.bill_split_draft AND EXISTS (SELECT 1 FROM public.invoice_items ii
                                           WHERE ii.invoice_id = inv.id AND ii.charge_type IS NULL AND ii.quantity = 0)
      THEN 'this payer''s draft has a product line with no quantity, so it can''t be edited. Post it as drafted, or void the group and redraft it'
    WHEN NOT inv.bill_split_draft AND EXISTS (SELECT 1 FROM public.split_invoice_provenance p WHERE p.invoice_id = inv.id)
      THEN 'this invoice is part of a field split, which can''t be edited. Void the group and redraft it'
  END
  FROM inv;
$function$;
REVOKE ALL ON FUNCTION public._invoice_resave_locked_20270109(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 3. (E) The drafted rate an office override replaced ---------------------------------------------------------------
ALTER TABLE public.invoice_standing_discount_rates ADD COLUMN drafted_rate_pct numeric(5,2)
  CONSTRAINT invoice_standing_discount_rates_drafted_range CHECK (drafted_rate_pct >= 0 AND drafted_rate_pct <= 100);
COMMENT ON COLUMN public.invoice_standing_discount_rates.drafted_rate_pct IS
  'The rate this draft was drafted at, kept when the office first overrides it (set_invoice_standing_discount), so "the customer''s rate" can put it back. NULL: never overridden, or overridden before this column existed.';

-- 4. (D, E) The two setters, changes marked (D) and (E) ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_invoice_standing_discount(p_invoice_id uuid, p_pct numeric, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_inv invoices%ROWTYPE;
  v_fingerprint text;
  v_replay jsonb;
  v_header jsonb;
  v_items jsonb;
  v_result jsonb;
  v_old_rate numeric;
  v_locked text;
BEGIN
  -- IS NOT TRUE: a NULL from is_admin() refuses too.
  IF v_actor IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_ADMIN_ONLY: only an admin can change a sale''s standing discount' USING ERRCODE = '42501';
  END IF;
  IF p_pct IS NOT NULL AND (p_pct < 0 OR p_pct > 100 OR p_pct <> round(p_pct, 2)) THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_INVALID: a rate is 0 to 100%% with at most two decimals' USING ERRCODE = '22023';
  END IF;

  -- Replay-safe: the same key, caller and request returns the first answer; a different request is refused.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('invoice_id', p_invoice_id, 'rate_pct', p_pct));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_invoice_standing_discount', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  -- A draft only (Mason: "before it's posted"): an unposted invoice keeps the amounts it was posted at.
  IF NOT FOUND OR v_inv.deleted_at IS NOT NULL OR v_inv.invoice_type <> 'chemical_sale' OR v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT: a standing discount changes only on a chemical-sale draft' USING ERRCODE = '22023';
  END IF;

  -- (D) A draft the save path can't re-save (a governed field split, or a Bill Split payer with a no-quantity line)
  -- is refused here in plain words, before anything changes; the group is voided and redrafted to change it.
  v_locked := public._invoice_resave_locked_20270109(v_inv.id);
  IF v_locked IS NOT NULL THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_SPLIT_LOCKED: %', v_locked USING ERRCODE = 'check_violation';
  END IF;

  v_old_rate := (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id);
  IF p_pct IS NULL THEN
    -- (E) "The customer's rate when this sale was drafted": an office override goes back to the drafted rate it
    -- replaced; a draft never overridden keeps its drafted row; only a draft with no row at all takes the customer's
    -- rate (recorded by the recompute, as when first drafted).
    UPDATE invoice_standing_discount_rates
       SET rate_pct = drafted_rate_pct, drafted_rate_pct = NULL, set_by = NULL, set_at = now()
     WHERE invoice_id = v_inv.id AND drafted_rate_pct IS NOT NULL;
    IF NOT FOUND THEN
      DELETE FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id AND set_by IS NOT NULL;
    END IF;
  ELSE
    -- (E) the first override keeps the drafted rate it replaces, so "the customer's rate" can bring it back
    INSERT INTO invoice_standing_discount_rates (invoice_id, rate_pct, set_by, set_at)
    VALUES (v_inv.id, p_pct, v_actor, now())
    ON CONFLICT (invoice_id) DO UPDATE SET
      drafted_rate_pct = COALESCE(invoice_standing_discount_rates.drafted_rate_pct,
                                  CASE WHEN invoice_standing_discount_rates.set_by IS NULL
                                       THEN invoice_standing_discount_rates.rate_pct END),
      rate_pct = EXCLUDED.rate_pct, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
  END IF;

  -- Re-saved as the invoice screen would, so a split payer's draft keeps its fingerprint (save_invoice's split
  -- guard refreshes it, and the discount goes in just before). A fresh key of its own: keys are unique across
  -- operations, and a reused one could replay an older save that never refreshes the fingerprint.
  v_header := jsonb_build_object('id', v_inv.id, 'customer_id', v_inv.customer_id, 'invoice_type', v_inv.invoice_type,
    'status', v_inv.status, 'season', v_inv.season, 'salesman_id', v_inv.salesman_id, 'invoice_date', v_inv.invoice_date,
    'due_date', v_inv.due_date, 'payment_terms', v_inv.payment_terms, 'purchase_order_ref', v_inv.purchase_order_ref,
    'header_notes', v_inv.header_notes, 'footer_notes', v_inv.footer_notes);
  -- Every field of every line, so the re-save keeps acres, rates, price source and the rest exactly as they are.
  SELECT COALESCE(jsonb_agg(to_jsonb(it) ORDER BY it.sort_order, it.id), '[]'::jsonb)
    INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv.id;
  PERFORM public.save_invoice(v_header, v_items, 'set_invoice_standing_discount:' || gen_random_uuid()::text);
  PERFORM public._recompute_standing_discount_20261231(v_inv.id);

  v_result := jsonb_build_object('invoice_id', v_inv.id,
    'rate_pct', (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id),
    'total_amount_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_inv.id));
  -- The office's change has its own audit entry, also when the rounded cents don't move (3% to 3.01% on a small sale).
  -- It records the rate only: the recompute's own entry already carries the change in total, so the trail adds up once.
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values,
                                   total_impact_cents, description)
  VALUES ('invoice_updated', 'invoice', v_inv.id, v_actor, (SELECT role FROM profiles WHERE id = v_actor),
          jsonb_build_object('rate_pct', v_old_rate),
          jsonb_build_object('rate_pct', (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id)),
          0,
          format('Standing discount rate set to %s', COALESCE(trim_scale(p_pct)::text || '%', 'the customer''s rate')));
  PERFORM public.save_idempotency(p_idempotency_key, 'set_invoice_standing_discount', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_invoice_standing_discount', v_fingerprint);
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.set_order_sales_tax(p_order_id uuid, p_sales_tax boolean, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_order orders%ROWTYPE;
  v_fingerprint text;
  v_replay jsonb;
  v_rate numeric;
  v_inv invoices%ROWTYPE;
  v_header jsonb;
  v_items jsonb;
  v_drafts int := 0;
  v_kept jsonb := '[]'::jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_ALLOWED: sign in to change a sale''s sales tax' USING ERRCODE = '42501';
  END IF;
  IF p_sales_tax IS NULL THEN
    RAISE EXCEPTION 'SALES_TAX_INVALID: the sales tax box is on or off' USING ERRCODE = '22023';
  END IF;

  -- Replay-safe: the same key, caller and request returns the first answer; a different request is refused.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('order_id', p_order_id, 'sales_tax', p_sales_tax));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_order_sales_tax', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND deleted_at IS NULL FOR UPDATE;
  -- An admin, or the sale's own rep. IS NOT TRUE over the whole test: a sale with no salesman makes the rep test
  -- NULL, and a NULL must refuse (20270103190000).
  IF NOT FOUND OR (public.is_admin() IS TRUE OR (public.is_sales_rep() IS TRUE AND v_order.salesman_id = v_actor)) IS NOT TRUE THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_ALLOWED: only an admin or the sale''s own rep can change its sales tax' USING ERRCODE = '42501';
  END IF;
  IF v_order.status IN ('cancelled', 'voided') THEN
    RAISE EXCEPTION 'SALES_TAX_ORDER_CLOSED: a cancelled or voided sale can''t change' USING ERRCODE = '22023';
  END IF;

  UPDATE orders SET sales_tax = p_sales_tax WHERE id = p_order_id;
  IF p_sales_tax THEN
    v_rate := public._sales_tax_setting_rate_20261231();
  END IF;

  -- Its chemical-sale drafts follow the box (posted and unposted invoices keep what they were posted with). A draft
  -- already taxed keeps its rate.
  FOR v_inv IN
    SELECT * FROM invoices
     WHERE order_id = p_order_id AND invoice_type = 'chemical_sale' AND status = 'draft' AND deleted_at IS NULL
     ORDER BY id
     FOR UPDATE
  LOOP
    -- (D) A draft the save path can't re-save (a governed field split, or a Bill Split payer with a no-quantity line)
    -- keeps the tax it has, like a posted invoice, instead of rolling back the whole switch: the sale's box still
    -- changes, and a void-and-redraft of that group follows it. Listed in the answer so the screen can say so.
    IF public._invoice_resave_locked_20270109(v_inv.id) IS NOT NULL THEN
      v_kept := v_kept || to_jsonb(v_inv.id);
      CONTINUE;
    END IF;
    IF p_sales_tax THEN
      INSERT INTO invoice_sales_tax_rates (invoice_id, rate_pct) VALUES (v_inv.id, v_rate) ON CONFLICT (invoice_id) DO NOTHING;
    ELSE
      DELETE FROM invoice_sales_tax_rates WHERE invoice_id = v_inv.id;
    END IF;
    -- Re-saved as the invoice screen would (as set_invoice_standing_discount does), so a split payer's draft keeps its
    -- fingerprint: save_invoice's split guard refreshes it, and the recompute goes in just before. A fresh key of its
    -- own per draft: keys are unique across operations.
    v_header := jsonb_build_object('id', v_inv.id, 'customer_id', v_inv.customer_id, 'invoice_type', v_inv.invoice_type,
      'status', v_inv.status, 'season', v_inv.season, 'salesman_id', v_inv.salesman_id, 'invoice_date', v_inv.invoice_date,
      'due_date', v_inv.due_date, 'payment_terms', v_inv.payment_terms, 'purchase_order_ref', v_inv.purchase_order_ref,
      'header_notes', v_inv.header_notes, 'footer_notes', v_inv.footer_notes);
    SELECT COALESCE(jsonb_agg(to_jsonb(it) ORDER BY it.sort_order, it.id), '[]'::jsonb)
      INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv.id;
    PERFORM public.save_invoice(v_header, v_items, 'set_order_sales_tax:' || gen_random_uuid()::text);
    PERFORM public._recompute_standing_discount_20261231(v_inv.id);
    v_drafts := v_drafts + 1;
  END LOOP;

  v_result := jsonb_build_object('order_id', p_order_id, 'sales_tax', p_sales_tax, 'drafts_updated', v_drafts,
                                'drafts_kept', v_kept);
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values,
                                   total_impact_cents, description)
  VALUES ('order_updated', 'order', p_order_id, v_actor, (SELECT role FROM profiles WHERE id = v_actor),
          jsonb_build_object('sales_tax', v_order.sales_tax), v_result, 0,
          CASE WHEN p_sales_tax THEN 'Sales tax on' ELSE 'Sales tax off' END);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_order_sales_tax', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_order_sales_tax', v_fingerprint);
  RETURN v_result;
END
$function$;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid IN ('public.set_invoice_standing_discount(uuid,numeric,text)'::regprocedure,
                       'public.set_order_sales_tax(uuid,boolean,text)'::regprocedure)
         AND p.prosecdef AND p.pronargdefaults = 1
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND p.proacl = ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]) <> 2
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._freeze_credit_sales_tax_20270109(uuid)'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._invoice_resave_locked_20270109(uuid)'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public._freeze_credit_sales_tax_20270109(uuid)'::regprocedure)
          LIKE '%CREDIT_SALES_TAX_UNLINKED_LINE%' THEN
    RAISE EXCEPTION 'BILLING_SOL_FIXES_POSTFLIGHT: a function''s grants, settings or body are not as written';
  END IF;
END
$postflight$;
