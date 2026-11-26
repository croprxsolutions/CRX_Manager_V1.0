-- Written 2026-11-26. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270308070000_credit_tax_ledger_timing.md.
-- Re-read the live ledger before applying.
--
-- WHY (#2091, a release #1990 follow-up; Mason 20 Nov, Taha agreed): the return-credit tax ledger
--   (credit_memo_sales_tax, frozen by _freeze_credit_sales_tax_20270109 at the credit's commit) pooled only sale lots
--   stamped at or before the credit's posting time, which is its transaction's start. The credit itself is priced from
--   every lot posted when it runs. A sale invoice that posted while the credit was being issued was in the credit's
--   amount, tax included, but the ledger recorded 0 tax for it, which misstates month-end revenue.
--
-- WHAT: _freeze_credit_sales_tax_20270109 pools every lot of the line that is posted when the credit freezes. A return
--   credit holds its order lines' locks (361) until commit, and posting or unposting a sale of those lines takes the
--   same locks, so this is exactly the set the credit was priced from. Nothing else in the body changes.
--
-- KNOWN LIMIT (Taha accepted, 25 Nov): a sale lot posted later in the SAME transaction as the credit is pooled too.
--   The old filter did the same (that lot's posted_at equals the credit's now()), and no app call issues a credit and
--   posts a sale in one transaction. Ledger rows already frozen stay as they are (live has no taxed credit yet: tax is
--   off and the 24 Nov reset).
--
-- NOT CHANGED: every other function, the return credit amounts, the table, every stored row. The re-emitted body is
--   staging's current body (pinned below) plus only the hunk marked (#2091). CREATE OR REPLACE keeps its OID, owner and
--   exact ACL; the postflight proves it.
--
-- ROLLBACK (its own reviewed migration): re-emit the body pinned below (20270117120000).
--
-- ORDERING: after 20270117120000_billing_sol_fixes_staging (the freeze it re-emits).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE credit_tax_ledger_timing_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.credit_tax_ledger_timing_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.credit_tax_ledger_timing_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'CREDIT_TAX_LEDGER_TIMING_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public._freeze_credit_sales_tax_20270109(uuid)')
              AND position('(#2091)' in prosrc) > 0) THEN
    RAISE EXCEPTION 'CREDIT_TAX_LEDGER_TIMING_PREFLIGHT: already applied';
  END IF;
  -- The function re-emitted below, exactly as 20270117120000 left it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._freeze_credit_sales_tax_20270109(uuid)')
       AND md5(replace(p.prosrc, chr(13), '')) = '6b175becb29ac202c5b1983ddc6686a5'
       AND p.proowner = 'postgres'::regrole
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
       AND p.pronargdefaults = 0
  ) THEN
    RAISE EXCEPTION 'CREDIT_TAX_LEDGER_TIMING_PREFLIGHT: _freeze_credit_sales_tax_20270109 drifted from staging';
  END IF;
END
$preflight$;

-- (#2091) The credit's tax ledger pools the same invoices the credit was priced from ----------------------------------
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
       -- (#2091) every lot of the pool that is posted now, not only those stamped at or before the credit's posting
       -- time: a return credit holds its order lines' locks (361), which posting or unposting a sale of the line also
       -- takes, so this is exactly the set the credit was priced from, including a lot that posted after the credit's
       -- transaction began.
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

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._freeze_credit_sales_tax_20270109(uuid)')
       AND position('(#2091)' in p.prosrc) > 0
       AND position('<= v_inv.booked_at' in p.prosrc) = 0
       AND p.proowner = 'postgres'::regrole
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
       AND p.pronargdefaults = 0
  ) THEN
    RAISE EXCEPTION 'CREDIT_TAX_LEDGER_TIMING_POSTFLIGHT: _freeze_credit_sales_tax_20270109 is not as written';
  END IF;
  RAISE NOTICE 'CREDIT_TAX_LEDGER_TIMING_POSTFLIGHT_OK';
END
$postflight$;
