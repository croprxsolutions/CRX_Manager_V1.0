-- Written 2026-11-21. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270204130000_pnl_commission_share_billed.md.
-- Re-read the live ledger before applying.
--
-- WHY: the two profit reports (Reports > Bottom Line P&L, Month-End Close) and the month-close receipt (2026-11-10 sweeps):
--   KI-125 (HIGH) commissions were subtracted for every booked order by order date, but revenue counts only invoices
--          posted in CRX, so most 2026 sales (billed in Chem Man) showed commission with no revenue: a six-figure loss
--          that is not real. Mason 2026-11-10 "Only CRX-billed" and 2026-11-13 "Split by share billed" (DECISION_LOG).
--   KI-126 (latent) an application-fee line stores its cost already extended by acres (quantity = acres); both
--          reports multiplied it by acres again.
--   KI-129 (part) the close receipt counted only invoices still 'posted'. Payments received (the legacy payments
--          table; payments live in allocation_sets) are NOT changed here: a follow-up, it needs a rule for
--          prepayment checks and a re-check at close.
--
-- WHAT:
--   1. _report_commission_cents_20270203(start, end): commission matched to the share of its sale billed in CRX in
--      the period. Per commission, recognized(d) = round(cents x share billed through d) in whole cents; a period gets
--      recognized(end) - recognized(start - 1), so months add up exactly to the whole range. Same cancelled/replaced
--      filter as before, now also skipping deleted commissions and deleted replacements.
--      - application commission (invoice_id set): all of it when that invoice is recognized (posted/overdue/paid,
--        not deleted) with invoice_date in the period; else none.
--      - order commission: B = the order's booked total in cents (orders.total_price = sum of its lines, no tax);
--        billed(d) = product-line cents (a product on the line; charge_type IS NULL and not an application fee: no
--        freight, fee, service, other, discount, tax or legacy untyped charge) on the order's recognized sale
--        invoices (chemical sale or misc charge) dated on or before d, taking the highest cumulative sale amount so
--        far (a later sale adjustment never takes commission back), plus the order's recognized return credits
--        (credit memos) dated on or before d. Part(d) = cents x billed(d) / B, billed kept between 0 and B, exact
--        half-up cents (_report_billed_part_cents_20270203); an order booked at $0 or less counts in full once billed.
--      - a return credit takes commission back in proportion (Mason 2026-08-09, reaffirmed 2026-11-13): the month of
--        the credit shows a negative commission. Commission rows are not changed (paying it back is KI-13).
--      - the report reads today's commission and order rows, as the old one did: closing an order's undelivered
--        remainder recomputes its commission and its booked total, so earlier periods' figures follow (the old report
--        restated the order-date month the same way). Close receipts keep the figures they saved.
--      - paid_count: paid commissions with an amount in the period (was: paid commissions by order date).
--   2. get_monthly_summary: commissions from (1), with 'basis': 'billed_share' so the screen labels it only once this
--      is live; COGS fee lines not times acres.
--   3. _get_bottom_line_pnl_cost_impl_20261019: Commissions from (1) (Net Profit and % follow); COGS fee lines.
--   4. _close_accounting_period_replay_impl_20261015: invoices_posted / total_invoiced_cents count posted, overdue and
--      paid (total_invoiced keeps sales tax: what was invoiced). Every other
--      line of the body is re-emitted byte for byte (checked by the prover against the pinned md5).
--
-- NOT CHANGED: revenue, invoices, payments and payments received, commission rows, Commissions page, keys and shapes of every result
-- (one key added: commissions.basis), who may call each report. A receipt saved under an idempotency key replays as saved.
--
-- ROLLBACK (its own reviewed migration): restore the three bodies pinned in the preflight and drop the two helpers.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE pnl_commission_share_billed_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.pnl_commission_share_billed_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.pnl_commission_share_billed_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PNL_COMMISSION_SHARE_BILLED_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._report_commission_cents_20270203(date,date)') IS NOT NULL
     OR to_regprocedure('public._report_billed_part_cents_20270203(numeric,numeric,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'PNL_COMMISSION_SHARE_BILLED_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._invoice_sales_tax_cents_20270109(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PNL_COMMISSION_SHARE_BILLED_PREFLIGHT: 20270109100400_sales_tax_not_revenue is not applied';
  END IF;
  -- The three functions changed below, exactly as live has them (read 2026-11-21).
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public.get_monthly_summary(date,date)', 'c79c69296a4c158c9fe9e6aa4698061a', true, 0,
       ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']),
      ('public._get_bottom_line_pnl_cost_impl_20261019(date,date)', '9179e4b31deb9337212fcbecf65f0cb6', false, 0,
       ARRAY['postgres=X/postgres']),
      ('public._close_accounting_period_replay_impl_20261015(date,uuid,text)', 'f29caf0f2bf34e8710dd538d091e4188', true, 1,
       ARRAY['postgres=X/postgres'])
    ) AS f(name, md5, secdef, ndefaults, acl)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef = f.secdef
        AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl = f.acl::aclitem[]
        AND p.pronargdefaults = f.ndefaults);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PNL_COMMISSION_SHARE_BILLED_PREFLIGHT: drifted: %', v_bad;
  END IF;
END
$preflight$;

-- 1. Commission matched to the share billed in the period (KI-125) ---------------------------------------------
-- The part of a commission matching its order's billed share, in whole cents: cents x billed / booked, with billed
-- kept between 0 and booked, rounded half up exactly (integer arithmetic, so no division scale can round twice).
-- An order booked at $0 or less, or with an unusable booked total (NULL: NaN or infinite, which the order check
-- allows but no live order has), counts in full once its billed product total is above $0: the share is unknown and
-- the cost is never hidden. No billing yet, or a net $0 or credit, is 0.
CREATE FUNCTION public._report_billed_part_cents_20270203(p_cents numeric, p_billed_cents numeric, p_booked_cents numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
           WHEN COALESCE(p_billed_cents, 0) <= 0 THEN 0
           WHEN p_booked_cents IS NULL OR p_booked_cents <= 0 THEN p_cents
           ELSE div(2 * p_cents * LEAST(p_billed_cents, p_booked_cents) + p_booked_cents, 2 * p_booked_cents)
         END;
$function$;
REVOKE ALL ON FUNCTION public._report_billed_part_cents_20270203(numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._report_billed_part_cents_20270203(numeric, numeric, numeric) TO service_role;

CREATE FUNCTION public._report_commission_cents_20270203(p_start date, p_end date)
 RETURNS TABLE(earned_cents bigint, paid_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Per commission: recognized(d) = its billed part through day d, in whole cents; the period gets
  -- recognized(end) - recognized(start - 1), so consecutive periods add up exactly to the whole range. A period is
  -- negative only when a return credit takes commission back.
  WITH daily AS (
    -- product-line cents on each order's recognized invoices, per invoice day: sales (chemical sale, or misc charge,
    -- which a draft may switch to and keep its order lines) and return credits (credit memos) kept apart.
    SELECT i.order_id, i.invoice_date,
           COALESCE(sum(ii.extended_cents) FILTER (WHERE i.invoice_type <> 'credit_memo'), 0)::numeric AS sale_cents,
           COALESCE(sum(ii.extended_cents) FILTER (WHERE i.invoice_type = 'credit_memo'), 0)::numeric AS credit_cents
      FROM public.invoices i
      JOIN public.invoice_items ii ON ii.invoice_id = i.id AND ii.charge_type IS NULL AND ii.is_application_fee IS NOT TRUE
                                  AND ii.product_id IS NOT NULL  -- a legacy untyped charge has no product
     WHERE i.order_id IS NOT NULL
       AND i.invoice_type IN ('chemical_sale', 'misc_charge', 'credit_memo')
       AND i.status IN ('posted', 'overdue', 'paid')
       AND i.deleted_at IS NULL
       AND i.invoice_date <= p_end
     GROUP BY i.order_id, i.invoice_date
  ), cumulative AS (
    SELECT d.order_id, d.invoice_date, d.credit_cents,
           sum(d.sale_cents) OVER (PARTITION BY d.order_id ORDER BY d.invoice_date) AS cum_sale_cents
      FROM daily d
  ), billed AS (
    -- billed through a day = the highest cumulative sale billing so far (a later sale adjustment never takes
    -- commission back) plus every return credit so far (a return does: Mason 2026-08-09, reaffirmed 2026-11-13,
    -- "a return claws back commission proportionally"). The helper keeps it between 0 and the booked total.
    SELECT c.order_id,
           max(c.cum_sale_cents) FILTER (WHERE c.invoice_date < p_start)
             + COALESCE(sum(c.credit_cents) FILTER (WHERE c.invoice_date < p_start), 0) AS before_cents,
           max(c.cum_sale_cents) + sum(c.credit_cents) AS through_cents
      FROM cumulative c
     GROUP BY c.order_id
  ), parts AS (
    SELECT c.status,
           CASE
             WHEN c.invoice_id IS NOT NULL THEN  -- application commission: all of it once its invoice is recognized
               (SELECT CASE WHEN ci.invoice_date < p_start THEN c.commission_amount * 100 ELSE 0 END FROM public.invoices ci
                 WHERE ci.id = c.invoice_id AND ci.status IN ('posted', 'overdue', 'paid') AND ci.deleted_at IS NULL
                   AND ci.invoice_date <= p_end)
             ELSE public._report_billed_part_cents_20270203(c.commission_amount * 100, b.before_cents, o.booked_cents)
           END AS part_before,
           CASE
             WHEN c.invoice_id IS NOT NULL THEN
               (SELECT c.commission_amount * 100 FROM public.invoices ci
                 WHERE ci.id = c.invoice_id AND ci.status IN ('posted', 'overdue', 'paid') AND ci.deleted_at IS NULL
                   AND ci.invoice_date <= p_end)
             ELSE public._report_billed_part_cents_20270203(c.commission_amount * 100, b.through_cents, o.booked_cents)
           END AS part_through
      FROM public.commissions c
      -- booked total in cents; a non-finite legacy value (NaN and Infinity sort above 1e15) is unusable (NULL)
      LEFT JOIN LATERAL (SELECT CASE WHEN ord.total_price < 1e15 THEN ROUND(ord.total_price * 100) END AS booked_cents
                           FROM public.orders ord WHERE ord.id = c.order_id) o ON true
      LEFT JOIN billed b ON b.order_id = c.order_id
     -- A cancelled commission still counts unless a live row replaced it (Fix Delivery re-creates the order's commission).
     WHERE c.deleted_at IS NULL
       AND (c.status <> 'cancelled'
            OR NOT EXISTS (SELECT 1 FROM public.commissions r WHERE r.replaces_commission_id = c.id AND r.deleted_at IS NULL))
  ), periods AS (
    SELECT p.status, COALESCE(p.part_through, 0) - COALESCE(p.part_before, 0) AS cents
      FROM parts p
  )
  -- paid_count: paid commissions with an amount in this period (the same rows the dollar figure counts)
  -- a missing start or end date is no range: 0, as revenue and cost are
  SELECT COALESCE(sum(x.cents), 0)::bigint, count(*) FILTER (WHERE x.status = 'paid' AND x.cents <> 0)::bigint
    FROM periods x
   WHERE p_start IS NOT NULL AND p_end IS NOT NULL;
$function$;
REVOKE ALL ON FUNCTION public._report_commission_cents_20270203(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._report_commission_cents_20270203(date, date) TO service_role;

-- 2. Month-End Close summary ------------------------------------------------------------------------------------
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
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents - public._invoice_sales_tax_cents_20270109(id)) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((SELECT sum(CASE
        WHEN inv.invoice_type = 'credit_memo'
         AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = inv.id)
          THEN inv.total_cost_cents
        -- (KI-126) a fee line's cost is already extended by acres
        ELSE (SELECT COALESCE(sum(CASE WHEN ii.is_application_fee THEN ii.cost_cents
                                       ELSE ROUND(ii.cost_cents * ii.quantity)::bigint END), 0)
              FROM public.invoice_items ii WHERE ii.invoice_id = inv.id)
      END) FROM public.invoices inv WHERE inv.invoice_date BETWEEN p_period_start AND p_period_end AND inv.status IN ('posted', 'overdue', 'paid') AND inv.deleted_at IS NULL), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft', 'unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    'payments', jsonb_build_object('count', (SELECT count(*) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 'total_cents', COALESCE((SELECT sum((amount * 100)::bigint) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 0)),
    'orders', jsonb_build_object('count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)),
    'deliveries', jsonb_build_object('count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status NOT IN ('cancelled', 'voided') AND deleted_at IS NULL), 'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)),
    'applications', jsonb_build_object('count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)),
    -- (KI-125) commission matched to the share of its sale billed in this period
    'commissions', (SELECT jsonb_build_object('earned_cents', r.earned_cents, 'paid_count', r.paid_count, 'basis', 'billed_share')
                       FROM public._report_commission_cents_20270203(p_period_start, p_period_end) r),
    -- today's receivables, whatever the period (KI-130: the screen labels it "Current AR (today)")
    'ar_balance_cents', COALESCE((SELECT sum(balance_cents) FROM public.invoices WHERE status IN ('posted', 'overdue') AND balance_cents > 0 AND deleted_at IS NULL), 0)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

-- 3. P&L report -------------------------------------------------------------------------------------------------
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
    COALESCE(SUM(i.total_amount_cents - public._invoice_sales_tax_cents_20270109(i.id)), 0) / 100.0,
    COALESCE(SUM(CASE
      WHEN i.invoice_type = 'credit_memo'
       AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = i.id)
        THEN i.total_cost_cents
      -- (KI-126) a fee line's cost is already extended by acres
      ELSE (SELECT COALESCE(SUM(CASE WHEN ii.is_application_fee THEN ii.cost_cents
                                     ELSE ROUND(ii.cost_cents * ii.quantity)::bigint END), 0)
            FROM public.invoice_items ii WHERE ii.invoice_id = i.id)
    END), 0) / 100.0
  INTO v_revenue, v_cogs
  FROM public.invoices i
  WHERE i.status IN ('posted', 'overdue', 'paid')
    AND i.invoice_date >= p_start_date
    AND i.invoice_date <= p_end_date
    AND i.deleted_at IS NULL;

  v_gross_profit := v_revenue - v_cogs;
  -- (KI-125) commission matched to the share of its sale billed in this period
  v_commissions := (SELECT r.earned_cents FROM public._report_commission_cents_20270203(p_start_date, p_end_date) r) / 100.0;
  v_net_profit := v_gross_profit - v_commissions;

  RETURN QUERY VALUES
    ('Revenue'::text, v_revenue, 100.0::numeric),
    ('Cost of Goods Sold', v_cogs, CASE WHEN v_revenue > 0 THEN ROUND(v_cogs / v_revenue * 100, 1) ELSE 0 END),
    ('Gross Profit', v_gross_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_gross_profit / v_revenue * 100, 1) ELSE 0 END),
    ('Commissions', v_commissions, CASE WHEN v_revenue > 0 THEN ROUND(v_commissions / v_revenue * 100, 1) ELSE 0 END),
    ('Net Profit', v_net_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_net_profit / v_revenue * 100, 1) ELSE 0 END);
END;
$function$;

-- 4. Month-close receipt (KI-129 invoice count); the rest of the body is unchanged -------------------------------------------
CREATE OR REPLACE FUNCTION public._close_accounting_period_replay_impl_20261015(
  p_period_end date,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_period_start date;
  v_unposted_count integer;
  v_period_id uuid;
  v_summary jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND role = 'admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;

  IF p_period_end IS NULL
     OR p_period_end <>
          (
            pg_catalog.date_trunc(
              'month',
              p_period_end::timestamp without time zone
            ) + INTERVAL '1 month - 1 day'
          )::date THEN
    RAISE EXCEPTION 'Period end % must be the last day of a calendar month', p_period_end;
  END IF;
  IF p_period_end >= (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Cannot close period ending %: the period has not ended yet', p_period_end;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_accounting_period');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_period_start :=
    pg_catalog.date_trunc(
      'month',
      p_period_end::timestamp without time zone
    )::date;
  PERFORM public._lock_accounting_months(ARRAY[v_period_start], true);

  -- Redundant defense in depth: the canonical helper already serializes this
  -- key at the first lookup, but retain a post-month-lock replay check.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_accounting_period');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT count(*)
    INTO v_unposted_count
    FROM public.invoices
   WHERE invoice_date BETWEEN v_period_start AND p_period_end
     AND status IN ('draft', 'unposted')
     AND deleted_at IS NULL;
  IF v_unposted_count > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unposted invoice(s) exist between % and %',
      v_unposted_count, v_period_start, p_period_end;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.accounting_periods
     WHERE period_start = v_period_start
       AND period_end = p_period_end
       AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Period % to % is already closed', v_period_start, p_period_end;
  END IF;

  INSERT INTO public.accounting_periods (
    period_start,
    period_end,
    status,
    closed_by,
    closed_at
  )
  VALUES (v_period_start, p_period_end, 'closed', v_actor, now())
  ON CONFLICT (period_start, period_end)
  DO UPDATE SET
    status = 'closed',
    closed_by = v_actor,
    closed_at = now(),
    updated_at = now()
  RETURNING id INTO v_period_id;

  SELECT jsonb_build_object(
    'period_id', v_period_id,
    'period_start', v_period_start,
    'period_end', p_period_end,
    'invoices_posted', (
      SELECT count(*)
        FROM public.invoices
       WHERE invoice_date BETWEEN v_period_start AND p_period_end
         AND status IN ('posted', 'overdue', 'paid')  -- (KI-129) a since-paid or overdue invoice was posted too
         AND deleted_at IS NULL
    ),
    'total_invoiced_cents', COALESCE((
      SELECT sum(total_amount_cents)
        FROM public.invoices
       WHERE invoice_date BETWEEN v_period_start AND p_period_end
         AND status IN ('posted', 'overdue', 'paid')  -- (KI-129)
         AND deleted_at IS NULL
    ), 0),
    'payments_received_cents', COALESCE((
      SELECT (sum(amount) * 100)::bigint
        FROM public.payments
       WHERE payment_date BETWEEN v_period_start AND p_period_end
    ), 0),
    'orders_count', (
      SELECT count(*)
        FROM public.orders
       WHERE order_date BETWEEN v_period_start AND p_period_end
         AND deleted_at IS NULL
    ),
    'deliveries_count', (
      SELECT count(*)
        FROM public.deliveries
       WHERE scheduled_date BETWEEN v_period_start AND p_period_end
         AND deleted_at IS NULL
    )
  )
  INTO v_summary;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'close_accounting_period',
      v_summary
    );
  END IF;
  RETURN v_summary;
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT proacl FROM pg_proc WHERE oid = 'public.get_monthly_summary(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._get_bottom_line_pnl_cost_impl_20261019(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._close_accounting_period_replay_impl_20261015(date,uuid,text)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._report_commission_cents_20270203(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._report_billed_part_cents_20270203(numeric,numeric,numeric)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid IN ('public.get_monthly_summary(date,date)'::regprocedure,
                               'public._get_bottom_line_pnl_cost_impl_20261019(date,date)'::regprocedure,
                               'public._close_accounting_period_replay_impl_20261015(date,uuid,text)'::regprocedure,
                               'public._report_commission_cents_20270203(date,date)'::regprocedure,
                               'public._report_billed_part_cents_20270203(numeric,numeric,numeric)'::regprocedure)
                   AND (proowner <> 'postgres'::regrole
                        OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[])) THEN
    RAISE EXCEPTION 'PNL_COMMISSION_SHARE_BILLED_POSTFLIGHT: grants, owner or search_path drifted';
  END IF;
END
$postflight$;
