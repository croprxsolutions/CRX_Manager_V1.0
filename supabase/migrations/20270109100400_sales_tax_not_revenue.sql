-- Written 2026-11-16. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270109100400_sales_tax_not_revenue.md.
-- Re-read the live ledger before applying.
--
-- WHY (issue #1868, Sol HIGH on staging, 2026-11-15): a taxed chemical sale's invoice total includes its
-- 'sales_tax' line (20270109100200_sales_tax_checkbox, formerly 20261231120000), and the two profit reports sum
-- invoice totals as revenue. A $100 sale with $6.25 tax showed $106.25 revenue and $6.25 too much gross margin.
-- Sales tax is collected for the state; it is not revenue.
--
-- WHAT:
--   1. _invoice_sales_tax_cents_20270109(invoice): the sales tax inside an invoice's total.
--      - A chemical sale: its 'sales_tax' line.
--      - A posted return credit memo: the tax it refunds, which sits inside its line amounts (no tax line of its own),
--        worked out ONCE when it posts and stored in credit_memo_sales_tax, never recomputed. So a later invoice,
--        return or posting cannot change an earlier month's revenue. At posting, each credited order line is stepped
--        through in time order the way return pricing works (_credit_sales_tax_unrounded_20270109: billed lots add
--        cents and tax, earlier credits take theirs out at the pool's rate, this credit takes its cents at what
--        remains), rounded on the running total of that sale's frozen credits for that customer, so a full return
--        refunds exactly the tax billed, in one credit or many. Unpost, void or delete clears it; a re-post freezes
--        it again. A deferred trigger on invoices does it at commit; existing posted credits are frozen once here.
--      - Anything else: 0.
--   2. get_monthly_summary (Month-End Close): invoices.total_amount_cents is now revenue without sales tax,
--      so "Recognized Invoices" and "Gross Margin" (total - cost) leave tax out. Same keys, no screen code change;
--      that figure no longer equals the invoice list's sum on taxed months (the difference is the tax).
--   3. _get_bottom_line_pnl_cost_impl_20261019 (P&L report via get_bottom_line_pnl): Revenue leaves sales tax
--      out, so Gross Profit, Net Profit and every % follow. Its search_path gains pg_temp (last), like its wrapper.
--   4. #1868 MED: p_idempotency_key gets DEFAULT NULL on set_invoice_standing_discount and set_order_sales_tax.
--      Only the signature's default changes: each body (prosrc) is re-emitted byte for byte and
--      checked unchanged afterwards (md5). Owner and grants stay (CREATE OR REPLACE).
--
-- NOT CHANGED: invoice totals, balances, posting, statements, AR, customer purchase summaries (what a customer
-- was billed includes the tax), close_accounting_period's total_invoiced_cents (what was invoiced), commission.
-- Untaxed invoices give the same numbers as before (the helper returns 0).
--
-- ROLLBACK (its own reviewed migration): restore get_monthly_summary and _get_bottom_line_pnl_cost_impl_20261019
-- to the bodies pinned below, drop the trigger, credit_memo_sales_tax and the four new functions, and re-create the two setters without the
-- default (CREATE OR REPLACE cannot drop a default: DROP and re-create with the same body, owner and grants).
--
-- ORDERING: after 20270109100300_sales_tax_rep_no_salesman (needs the 'sales_tax' line and both setters).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE sales_tax_not_revenue_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.sales_tax_not_revenue_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.sales_tax_not_revenue_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_REVENUE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._invoice_sales_tax_cents_20270109(uuid)') IS NOT NULL
     OR to_regclass('public.credit_memo_sales_tax') IS NOT NULL THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_REVENUE_PREFLIGHT: already applied';
  END IF;
  IF to_regclass('public.invoice_sales_tax_rates') IS NULL THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_REVENUE_PREFLIGHT: the sales tax checkbox migration is not applied';
  END IF;
  -- The four functions changed below, exactly as staging has them (2026-11-16).
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public.get_monthly_summary(date,date)', '192a956ae0a2dda912f5ba2355617267', true,
       ARRAY['search_path=public, pg_temp'], ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']),
      ('public._get_bottom_line_pnl_cost_impl_20261019(date,date)', '25276e99e5ce377eff61615213369fda', false,
       ARRAY['search_path=public'], ARRAY['postgres=X/postgres']),
      ('public.set_invoice_standing_discount(uuid,numeric,text)', '8e27085f3b2395f61a35957e149e1f9b', true,
       ARRAY['search_path=public, pg_temp'], ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']),
      ('public.set_order_sales_tax(uuid,boolean,text)', '0dfa51c2c66f78dd94dd0afb95c3ae77', true,
       ARRAY['search_path=public, pg_temp'], ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres'])
    ) AS f(name, md5, secdef, config, acl)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef = f.secdef
        AND p.proconfig = f.config::text[]
        AND p.proacl = f.acl::aclitem[]
        AND p.pronargdefaults = 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_REVENUE_PREFLIGHT: drifted: %', v_bad;
  END IF;
  -- one version of each setter only, so a call without the key reaches the one given the default below
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('set_invoice_standing_discount', 'set_order_sales_tax')) <> 2 THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_REVENUE_PREFLIGHT: another overload of a setter exists';
  END IF;
END
$preflight$;

-- 1. The tax inside a return credit's lines --------------------------------------------------------------------
-- The tax inside a return credit's lines, before rounding (0 for anything else), as of now. Internal; read only by
-- the freeze below, at the moment the credit posts.
-- Returns price an order line from what that customer was billed for it, less what earlier returns took
-- (_return_customer_line_share). So each order line is stepped through in time order: a billed lot adds its cents
-- and its tax (WITH its tax share: _standing_discount_net_cents_20261231, so both sides include tax; the lot's tax is
-- at its own invoice's tax / total, and every charge is in that tax base: _sales_tax_expected_20261231), and a credit
-- takes its cents at the remaining pool's tax / cents and removes that tax from the pool. Only lots posted before a
-- Example: 10625 (625 tax) billed and fully credited, then 10888 (888 tax) billed and credited: 625 + 888 = 1513.
CREATE FUNCTION public._credit_sales_tax_unrounded_20270109(p_invoice_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cm record;
  v_key record;
  v_ev record;
  v_rc numeric;
  v_rt numeric;
  v_total numeric := 0;
BEGIN
  SELECT i.id, i.customer_id, i.created_at, i.invoice_type INTO v_cm FROM public.invoices i WHERE i.id = p_invoice_id;
  IF v_cm.invoice_type IS DISTINCT FROM 'credit_memo' THEN
    RETURN 0;
  END IF;
  FOR v_key IN
    SELECT src.order_item_id, min(src.invoice_id::text)::uuid AS any_source, sum(ii.extended_cents)::numeric AS cents
      FROM public.invoice_items ii
      JOIN public.invoice_items src ON src.id = ii.return_credit_source_item_id
     WHERE ii.invoice_id = p_invoice_id
     -- a credited line with no order line (a charge) is keyed by its own source invoice
     GROUP BY src.order_item_id, CASE WHEN src.order_item_id IS NULL THEN src.invoice_id END
  LOOP
    IF v_key.order_item_id IS NULL THEN
      v_total := v_total + v_key.cents * COALESCE(
        COALESCE((SELECT sum(t.extended_cents) FROM public.invoice_items t
                   WHERE t.invoice_id = v_key.any_source AND t.charge_type = 'sales_tax'), 0)::numeric
        / NULLIF((SELECT i.total_amount_cents FROM public.invoices i WHERE i.id = v_key.any_source), 0), 0);
      CONTINUE;
    END IF;
    v_rc := 0;
    v_rt := 0;
    FOR v_ev IN
      SELECT 0 AS kind, COALESCE(i.posted_at, i.created_at) AS ts, b.id,
             public._standing_discount_net_cents_20261231(b.id)::numeric AS cents,
             public._standing_discount_net_cents_20261231(b.id)::numeric
               * COALESCE((SELECT sum(t.extended_cents) FROM public.invoice_items t
                            WHERE t.invoice_id = i.id AND t.charge_type = 'sales_tax'), 0)
               / NULLIF(i.total_amount_cents, 0) AS tax
        FROM public.invoice_items b
        JOIN public.invoices i ON i.id = b.invoice_id
       WHERE b.order_item_id = v_key.order_item_id AND b.quantity > 0 AND b.product_id IS NOT NULL
         AND i.customer_id = v_cm.customer_id
         AND i.invoice_type <> 'credit_memo'
         AND i.deleted_at IS NULL
         AND i.status IN ('posted', 'overdue', 'paid')
      UNION ALL
      SELECT 1, x.created_at, x.id, sum(ci.extended_cents)::numeric, NULL
        FROM public.invoices x
        JOIN public.invoice_items ci ON ci.invoice_id = x.id
        JOIN public.invoice_items s ON s.id = ci.return_credit_source_item_id
       WHERE s.order_item_id = v_key.order_item_id
         AND x.customer_id = v_cm.customer_id
         AND x.invoice_type = 'credit_memo'
         AND x.deleted_at IS NULL
         AND (x.id = p_invoice_id OR x.status IN ('posted', 'overdue', 'paid'))
       GROUP BY x.id, x.created_at
      ORDER BY 2, 1, 3
    LOOP
      IF v_ev.kind = 0 THEN
        v_rc := v_rc + v_ev.cents;
        v_rt := v_rt + COALESCE(v_ev.tax, 0);
      ELSIF v_ev.id = p_invoice_id THEN
        v_total := v_total + v_key.cents * CASE WHEN v_rc <> 0 THEN v_rt / v_rc ELSE 0 END;
        EXIT;
      ELSE
        -- an earlier credit (its cents are negative) takes its share of the pool's tax out with it
        IF v_rc <> 0 THEN
          v_rt := v_rt + v_ev.cents * v_rt / v_rc;
        END IF;
        v_rc := v_rc + v_ev.cents;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_total;
END
$function$;
REVOKE ALL ON FUNCTION public._credit_sales_tax_unrounded_20270109(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._credit_sales_tax_unrounded_20270109(uuid) TO service_role;

-- 2. A return credit's tax, frozen when it posts -----------------------------------------------------------------
CREATE TABLE public.credit_memo_sales_tax (
  invoice_id uuid PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  sale_id uuid,
  customer_id uuid NOT NULL,
  unrounded_cents numeric NOT NULL,
  tax_cents bigint NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.credit_memo_sales_tax IS
  'The sales tax a posted return credit memo refunds inside its line amounts (issue #1868), worked out once when it posts and never recomputed, so a later invoice or posting cannot change an earlier month''s revenue. Written only by _freeze_credit_sales_tax_20270109.';

ALTER TABLE public.credit_memo_sales_tax ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credit_memo_sales_tax FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.credit_memo_sales_tax TO authenticated;
GRANT ALL ON public.credit_memo_sales_tax TO service_role;

CREATE POLICY credit_memo_sales_tax_select ON public.credit_memo_sales_tax
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = credit_memo_sales_tax.invoice_id));

-- Freeze (or clear) one credit's tax from its current state. Posted: work it out once, rounded on the running total
-- of that sale's frozen credits for that customer (so a full return refunds exactly the tax billed, in one credit
-- or many). Unposted, voided or deleted: cleared (a re-post freezes it again). A credit with no order takes the sale
-- of the invoice its first credited line came from.
CREATE FUNCTION public._freeze_credit_sales_tax_20270109(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record;
  v_sale uuid;
  v_mine numeric;
  v_prior numeric := 0;
BEGIN
  SELECT i.id, i.invoice_type, i.status, i.deleted_at, i.order_id, i.customer_id INTO v_inv
    FROM public.invoices i WHERE i.id = p_invoice_id;
  IF NOT FOUND OR v_inv.invoice_type IS DISTINCT FROM 'credit_memo' THEN
    RETURN;
  END IF;
  IF v_inv.deleted_at IS NOT NULL OR v_inv.status NOT IN ('posted', 'overdue', 'paid') THEN
    DELETE FROM public.credit_memo_sales_tax WHERE invoice_id = p_invoice_id;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.credit_memo_sales_tax WHERE invoice_id = p_invoice_id) THEN
    RETURN;  -- already frozen (posted -> overdue -> paid keeps it)
  END IF;
  v_sale := COALESCE(v_inv.order_id, (SELECT si.order_id
                                        FROM public.invoice_items ci
                                        JOIN public.invoice_items s ON s.id = ci.return_credit_source_item_id
                                        JOIN public.invoices si ON si.id = s.invoice_id
                                       WHERE ci.invoice_id = p_invoice_id
                                       ORDER BY ci.id LIMIT 1));
  -- one credit of a sale and customer at a time, so the running total never reads a half-written neighbour
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'credit_memo_sales_tax:' || COALESCE(v_sale::text, p_invoice_id::text) || ':' || v_inv.customer_id::text, 0));
  v_mine := public._credit_sales_tax_unrounded_20270109(p_invoice_id);
  IF v_sale IS NOT NULL THEN
    v_prior := COALESCE((SELECT sum(c.unrounded_cents) FROM public.credit_memo_sales_tax c
                          WHERE c.sale_id = v_sale AND c.customer_id = v_inv.customer_id), 0);
  END IF;
  INSERT INTO public.credit_memo_sales_tax (invoice_id, sale_id, customer_id, unrounded_cents, tax_cents)
  VALUES (p_invoice_id, v_sale, v_inv.customer_id, v_mine, (round(v_prior + v_mine) - round(v_prior))::bigint);
END
$function$;
REVOKE ALL ON FUNCTION public._freeze_credit_sales_tax_20270109(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- At commit, when its lines are all in place.
CREATE FUNCTION public.trg_freeze_credit_sales_tax_20270109()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public._freeze_credit_sales_tax_20270109(NEW.id);
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public.trg_freeze_credit_sales_tax_20270109() FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER trg_freeze_credit_sales_tax_20270109
  AFTER INSERT OR UPDATE OF status, deleted_at ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.invoice_type = 'credit_memo')
  EXECUTE FUNCTION public.trg_freeze_credit_sales_tax_20270109();

-- Credits already posted, frozen once in posting order.
DO $backfill$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN
    SELECT i.id FROM public.invoices i
     WHERE i.invoice_type = 'credit_memo' AND i.deleted_at IS NULL AND i.status IN ('posted', 'overdue', 'paid')
     ORDER BY COALESCE(i.posted_at, i.created_at), i.id
  LOOP
    PERFORM public._freeze_credit_sales_tax_20270109(v_id);
  END LOOP;
END
$backfill$;

-- 3. The sales tax inside an invoice's total ---------------------------------------------------------------------
CREATE FUNCTION public._invoice_sales_tax_cents_20270109(p_invoice_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- (a 'sales_tax' line exists only on a chemical sale: guard_sales_tax_line_scope_20261231 refuses it elsewhere)
  SELECT COALESCE((SELECT sum(t.extended_cents) FROM public.invoice_items t
                    WHERE t.invoice_id = p_invoice_id AND t.charge_type = 'sales_tax'), 0)::bigint
       -- a posted return credit: the tax frozen when it posted (negative)
       + COALESCE((SELECT c.tax_cents FROM public.credit_memo_sales_tax c WHERE c.invoice_id = p_invoice_id), 0);
$function$;
REVOKE ALL ON FUNCTION public._invoice_sales_tax_cents_20270109(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._invoice_sales_tax_cents_20270109(uuid) TO service_role;

-- 4. Month-End Close summary: revenue without sales tax, changes marked (tax) -------------------------------
CREATE OR REPLACE FUNCTION public.get_monthly_summary(p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_result jsonb;
BEGIN
  PERFORM require_admin();
  SELECT jsonb_build_object(
    'period_start', p_period_start,
    'period_end', p_period_end,
    'invoices', jsonb_build_object(
      'posted_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents - public._invoice_sales_tax_cents_20270109(id))  /* (tax) */ FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((SELECT sum(CASE
        WHEN inv.invoice_type = 'credit_memo'
         AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = inv.id)
          THEN inv.total_cost_cents
        ELSE (SELECT COALESCE(sum(ROUND(ii.cost_cents * ii.quantity)::bigint), 0)
              FROM public.invoice_items ii WHERE ii.invoice_id = inv.id)
      END) FROM public.invoices inv WHERE inv.invoice_date BETWEEN p_period_start AND p_period_end AND inv.status IN ('posted', 'overdue', 'paid') AND inv.deleted_at IS NULL), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft', 'unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    'payments', jsonb_build_object('count', (SELECT count(*) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 'total_cents', COALESCE((SELECT sum((amount * 100)::bigint) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 0)),
    'orders', jsonb_build_object('count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)),
    'deliveries', jsonb_build_object('count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status NOT IN ('cancelled', 'voided') AND deleted_at IS NULL), 'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)),
    'applications', jsonb_build_object('count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)),
    'commissions', jsonb_build_object('earned_cents', COALESCE((SELECT sum((c.commission_amount * 100)::bigint) FROM public.commissions c WHERE c.order_date BETWEEN p_period_start AND p_period_end AND (c.status <> 'cancelled' OR NOT EXISTS (SELECT 1 FROM public.commissions r WHERE r.replaces_commission_id = c.id))), 0), 'paid_count', (SELECT count(*) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end AND status = 'paid')),
    'ar_balance_cents', COALESCE((SELECT sum(balance_cents) FROM public.invoices WHERE status IN ('posted', 'overdue') AND balance_cents > 0 AND deleted_at IS NULL), 0)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

-- 5. P&L report: revenue without sales tax --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._get_bottom_line_pnl_cost_impl_20261019(p_start_date date, p_end_date date)
 RETURNS TABLE(line_item text, amount numeric, pct_of_revenue numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_revenue numeric := 0;
  v_cogs numeric := 0;
  v_gross_profit numeric := 0;
  v_commissions numeric := 0;
  v_net_profit numeric := 0;
BEGIN
  SELECT
    COALESCE(SUM(i.total_amount_cents - public._invoice_sales_tax_cents_20270109(i.id)), 0) / 100.0,  -- (tax)
    COALESCE(SUM(CASE
      WHEN i.invoice_type = 'credit_memo'
       AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = i.id)
        THEN i.total_cost_cents
      ELSE (SELECT COALESCE(SUM(ROUND(ii.cost_cents * ii.quantity)::bigint), 0)
            FROM public.invoice_items ii WHERE ii.invoice_id = i.id)
    END), 0) / 100.0
  INTO v_revenue, v_cogs
  FROM public.invoices i
  WHERE i.status IN ('posted', 'overdue', 'paid')
    AND i.invoice_date >= p_start_date
    AND i.invoice_date <= p_end_date
    AND i.deleted_at IS NULL;

  v_gross_profit := v_revenue - v_cogs;
  -- A cancelled commission still counts unless a row replaced it (Fix Delivery re-creates the
  -- order's commission), so an ordinary invoice void does not change a past month's total.
  SELECT COALESCE(SUM(c.commission_amount), 0) INTO v_commissions
  FROM public.commissions c
  WHERE c.order_date >= p_start_date AND c.order_date <= p_end_date
    AND (c.status <> 'cancelled' OR NOT EXISTS (SELECT 1 FROM public.commissions r WHERE r.replaces_commission_id = c.id));
  v_net_profit := v_gross_profit - v_commissions;

  RETURN QUERY VALUES
    ('Revenue'::text, v_revenue, 100.0::numeric),
    ('Cost of Goods Sold', v_cogs, CASE WHEN v_revenue > 0 THEN ROUND(v_cogs / v_revenue * 100, 1) ELSE 0 END),
    ('Gross Profit', v_gross_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_gross_profit / v_revenue * 100, 1) ELSE 0 END),
    ('Commissions', v_commissions, CASE WHEN v_revenue > 0 THEN ROUND(v_commissions / v_revenue * 100, 1) ELSE 0 END),
    ('Net Profit', v_net_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_net_profit / v_revenue * 100, 1) ELSE 0 END);
END;
$function$;

-- 6. #1868 MED: DEFAULT NULL on p_idempotency_key, bodies unchanged ------------------------------------------
-- Re-emitted exactly as staging has them (md5 pinned in the preflight and checked again below); the only
-- change is the default on the last argument.
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

  v_old_rate := (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id);
  IF p_pct IS NULL THEN
    DELETE FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id;
  ELSE
    INSERT INTO invoice_standing_discount_rates (invoice_id, rate_pct, set_by, set_at)
    VALUES (v_inv.id, p_pct, v_actor, now())
    ON CONFLICT (invoice_id) DO UPDATE SET rate_pct = EXCLUDED.rate_pct, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
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

  v_result := jsonb_build_object('order_id', p_order_id, 'sales_tax', p_sales_tax, 'drafts_updated', v_drafts);
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
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public.set_invoice_standing_discount(uuid,numeric,text)', '8e27085f3b2395f61a35957e149e1f9b'),
      ('public.set_order_sales_tax(uuid,boolean,text)', '0dfa51c2c66f78dd94dd0afb95c3ae77')) AS f(name, md5)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.pronargdefaults = 1
        AND pg_get_expr(p.proargdefaults, 0) = 'NULL::text'
        AND p.proacl = ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_REVENUE_POSTFLIGHT: %', v_bad;
  END IF;
  IF (SELECT proacl FROM pg_proc WHERE oid = 'public.get_monthly_summary(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._get_bottom_line_pnl_cost_impl_20261019(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proconfig FROM pg_proc WHERE oid = 'public._get_bottom_line_pnl_cost_impl_20261019(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._credit_sales_tax_unrounded_20270109(uuid)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._freeze_credit_sales_tax_20270109(uuid)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public.trg_freeze_credit_sales_tax_20270109()'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR has_table_privilege('authenticated', 'public.credit_memo_sales_tax', 'INSERT, UPDATE, DELETE')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.credit_memo_sales_tax'::regclass)
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._invoice_sales_tax_cents_20270109(uuid)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_REVENUE_POSTFLIGHT: grants drifted';
  END IF;
END
$postflight$;
