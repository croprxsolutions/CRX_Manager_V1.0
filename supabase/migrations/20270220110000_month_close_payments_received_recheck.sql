-- Written 2026-11-22. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270220110000_month_close_payments_received_recheck.md.
-- Re-read the live ledger before applying.
--
-- WHY (contract: docs/plans/2026-11-22-month-end-payments-and-close-recheck-CONTRACT.md):
--   KI-129 / #2195 (HIGH) Month-End Close and its close receipt total "payments received" from the legacy payments
--          table (0 rows live; the receipt even counted deleted rows), so a month paid through Record Payment shows $0.
--   #2175 (MED) closing a month saved whatever the figures were at the click, with no check that they still matched
--          what the admin reviewed; the payments and commission "reviewed" ticks were screen-only.
--          DECISION_LOG 2026-11-21: the payments fix must include this re-check.
--
-- WHAT:
--   1. _month_payments_received_20270208(start, end): money received in the dates, as (payment_count, total_cents):
--      - Record Payment: active allocation sets of type 'payment' (a voided one is inactive), dated by payment_date:
--        the whole check, including any part kept as prepay (overpayment);
--      - prepayment checks (Prepayment Manager, prepay_credits source 'check'), on the Chicago day entered, at the
--        current amount (an edit changes it; a delete leaves only what was already applied); the bucket splits of
--        one check are one payment. Overpayment credits are not added again (their cash is in their payment);
--      - legacy payments rows that are not deleted (none live).
--   0. allocation_sets_payment_has_date: a Record Payment set must carry its payment_date. Its only writer
--      (allocate_payment) always stores one (live 2026-11-22: 0 undated). Then the payment's report month and the
--      month void_payment checks (check_period_open(COALESCE(payment_date, today))) are always the same, so a void
--      cannot take money out of a closed month's figure (Sol round 2 HIGH). No row changes; the apply stops if any
--      undated payment set exists.
--   2. _month_close_figures_20270208(start, end): every period figure Month-End Close shows (the get_monthly_summary
--      body, except today's AR) plus the figures the close receipt saves (close_receipt), payments from (1).
--   3. get_monthly_summary: those figures, plus today's AR and review_token = md5 of the figures.
--   4. close_accounting_period (and its impl) gain p_reviewed_token, p_payments_reviewed, p_commissions_reviewed. Under
--      the month lock the impl computes the figures once; it refuses CLOSE_REVIEW_REQUIRED when the token is missing,
--      or payments exist and are not confirmed, or commission is not $0 and not confirmed; CLOSE_FIGURES_CHANGED when
--      the token differs. The receipt is built from that same computation (payments received from (1)).
--      A retry with the same key still replays the saved receipt before any check.
--
-- NOT CHANGED: who may call each function, the receipt's keys, every other summary figure, saved receipts, rows.
-- ROLLOUT: the deployed screen calls close without a token and is refused (CLOSE_REVIEW_REQUIRED, "reload") until
-- the screen in this PR is deployed.
-- caller-analysis: close_accounting_period :: re-created with three added review arguments; the REVOKE is only from PUBLIC and anon, authenticated keeps EXECUTE; its one caller (src/pages/MonthEndClose.tsx) sends the review arguments in this same PR
-- ROLLBACK (its own reviewed migration): re-create get_monthly_summary and the close impl from
-- 20270206110000_pnl_commission_share_billed.sql and the 3-argument wrapper from
-- 20261102180000_bind_money_replay_receipts_batch4a.sql, then drop the two helpers and the
-- allocation_sets_payment_has_date constraint.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE month_close_recheck_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.month_close_recheck_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.month_close_recheck_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'MONTH_CLOSE_RECHECK_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._month_close_figures_20270208(date,date)') IS NOT NULL THEN
    RAISE EXCEPTION 'MONTH_CLOSE_RECHECK_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._report_commission_cents_20270203(date,date)') IS NULL THEN
    RAISE EXCEPTION 'MONTH_CLOSE_RECHECK_PREFLIGHT: 20270206110000_pnl_commission_share_billed is not applied';
  END IF;
  -- The three functions replaced below, exactly as 20270206110000 / batch 4a left them.
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public.get_monthly_summary(date,date)', '49e129e03cfd5bb4bf289c57d408e7d8', 0,
       ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']),
      ('public._close_accounting_period_replay_impl_20261015(date,uuid,text)', '734d7ed6d4a6819527dc5bb569d1922b', 1,
       ARRAY['postgres=X/postgres']),
      ('public.close_accounting_period(date,uuid,text)', 'a1196c5be02d733147c0c64b5242ef32', 1,
       ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres'])
    ) AS f(name, md5, ndefaults, acl)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef
        AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl = f.acl::aclitem[]
        AND p.pronargdefaults = f.ndefaults);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MONTH_CLOSE_RECHECK_PREFLIGHT: drifted: %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.allocation_sets'::regclass
               AND conname = 'allocation_sets_payment_has_date') THEN
    RAISE EXCEPTION 'MONTH_CLOSE_RECHECK_PREFLIGHT: allocation_sets_payment_has_date already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.allocation_sets WHERE entity_type = 'payment' AND payment_date IS NULL) THEN
    RAISE EXCEPTION 'MONTH_CLOSE_RECHECK_PREFLIGHT: % payment set(s) have no payment_date; date them in a reviewed change first',
      (SELECT count(*) FROM public.allocation_sets WHERE entity_type = 'payment' AND payment_date IS NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('close_accounting_period', '_close_accounting_period_replay_impl_20261015')
               AND pronamespace = 'public'::regnamespace AND pronargs <> 3) THEN
    RAISE EXCEPTION 'MONTH_CLOSE_RECHECK_PREFLIGHT: an unexpected close_accounting_period overload exists';
  END IF;
END
$preflight$;

-- 0. A Record Payment always has its date (see WHAT 0) ------------------------------------------------------------
ALTER TABLE public.allocation_sets
  ADD CONSTRAINT allocation_sets_payment_has_date CHECK (entity_type <> 'payment' OR payment_date IS NOT NULL);

-- 1. Money received in the dates --------------------------------------------------------------------------------
CREATE FUNCTION public._month_payments_received_20270208(p_start date, p_end date)
RETURNS TABLE(payment_count bigint, total_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH received AS (
    -- Record Payment: the whole check, including a part kept as prepay; a voided payment is inactive.
    SELECT COALESCE(a.total_payment_cents, a.total_allocated_cents, 0)::numeric AS cents
      FROM public.allocation_sets a
     WHERE a.entity_type = 'payment'
       AND a.is_active
       AND a.payment_date BETWEEN p_start AND p_end
    UNION ALL
    -- Prepayment Manager checks at their current amount; the bucket splits of one check (one call: one created_at and
    -- one source_reference, never edited) are one payment.
    SELECT sum(pc.original_amount_cents)::numeric
      FROM public.prepay_credits pc
     WHERE pc.source_type = 'check'
       AND pc.allocation_set_id IS NULL
       AND pc.original_amount_cents > 0
       AND (pc.created_at AT TIME ZONE 'America/Chicago')::date BETWEEN p_start AND p_end
     GROUP BY pc.customer_id, pc.created_at, pc.source_reference
    UNION ALL
    -- Legacy payments table (none live), not deleted; dollars kept exact and rounded once on the total.
    SELECT p.amount * 100
      FROM public.payments p
     WHERE p.deleted_at IS NULL
       AND p.payment_date BETWEEN p_start AND p_end
  )
  SELECT count(*)::bigint, round(COALESCE(sum(cents), 0))::bigint FROM received;
$function$;

REVOKE ALL ON FUNCTION public._month_payments_received_20270208(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._month_payments_received_20270208(date, date) TO service_role;

-- 2. Every Month-End figure for the dates, plus what the close receipt saves --------------------------------------
-- Invoices, orders, deliveries, applications and commissions are the get_monthly_summary expressions of
-- 20270206110000, unchanged; the receipt's are the close impl's, unchanged except payments received.
CREATE FUNCTION public._month_close_figures_20270208(p_period_start date, p_period_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_payments record;
BEGIN
  SELECT * INTO v_payments FROM public._month_payments_received_20270208(p_period_start, p_period_end);
  RETURN jsonb_build_object(
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
    -- (KI-129) money received: Record Payment, prepayment checks and live legacy rows
    'payments', jsonb_build_object('count', v_payments.payment_count, 'total_cents', v_payments.total_cents),
    'orders', jsonb_build_object('count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)),
    'deliveries', jsonb_build_object('count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status NOT IN ('cancelled', 'voided') AND deleted_at IS NULL), 'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)),
    'applications', jsonb_build_object('count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)),
    -- (KI-125) commission matched to the share of its sale billed in this period
    'commissions', (SELECT jsonb_build_object('earned_cents', r.earned_cents, 'paid_count', r.paid_count, 'basis', 'billed_share')
                       FROM public._report_commission_cents_20270203(p_period_start, p_period_end) r),
    'close_receipt', jsonb_build_object(
      'invoices_posted', (
        SELECT count(*) FROM public.invoices
         WHERE invoice_date BETWEEN p_period_start AND p_period_end
           AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_invoiced_cents', COALESCE((
        SELECT sum(total_amount_cents) FROM public.invoices
         WHERE invoice_date BETWEEN p_period_start AND p_period_end
           AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'payments_received_cents', v_payments.total_cents,
      'orders_count', (
        SELECT count(*) FROM public.orders
         WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL),
      'deliveries_count', (
        SELECT count(*) FROM public.deliveries
         WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL)
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._month_close_figures_20270208(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._month_close_figures_20270208(date, date) TO service_role;

-- 3. Month-End Close summary --------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_monthly_summary(p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_figures jsonb;
BEGIN
  PERFORM require_admin();
  v_figures := public._month_close_figures_20270208(p_period_start, p_period_end);
  RETURN (v_figures - 'close_receipt') || jsonb_build_object(
    -- today's receivables, whatever the period (KI-130: the screen labels it "Current AR (today)")
    'ar_balance_cents', COALESCE((SELECT sum(balance_cents) FROM public.invoices WHERE status IN ('posted', 'overdue') AND balance_cents > 0 AND deleted_at IS NULL), 0),
    -- (#2175) the close refuses unless it is sent back and the figures still give the same token
    'review_token', md5(v_figures::text));
END;
$function$;

-- 4. Month close: same checks as before, then the review re-check; the receipt comes from the same figures ----------
DROP FUNCTION public.close_accounting_period(date, uuid, text);
DROP FUNCTION public._close_accounting_period_replay_impl_20261015(date, uuid, text);

CREATE FUNCTION public._close_accounting_period_replay_impl_20261015(
  p_period_end date,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_reviewed_token text DEFAULT NULL::text,
  p_payments_reviewed boolean DEFAULT NULL::boolean,
  p_commissions_reviewed boolean DEFAULT NULL::boolean
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
  v_figures jsonb;
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

  -- An edit saved in the same instant as this close (by a writer that does not take this month's lock) shows on the
  -- screen, not on the saved receipt, the same as an edit after the close (Mason, DECISION_LOG 2026-11-22, option A).
  -- (#2175) The figures the admin reviewed must still hold; computed once, so what is checked is what is saved.
  v_figures := public._month_close_figures_20270208(v_period_start, p_period_end);
  IF p_reviewed_token IS NULL THEN
    RAISE EXCEPTION 'CLOSE_REVIEW_REQUIRED: reload Month-End Close and review this month''s figures before closing';
  END IF;
  IF p_reviewed_token IS DISTINCT FROM md5(v_figures::text) THEN
    RAISE EXCEPTION 'CLOSE_FIGURES_CHANGED: this month''s figures changed since you reviewed them; review them again before closing';
  END IF;
  IF (v_figures #>> '{payments,count}')::bigint > 0 AND p_payments_reviewed IS NOT TRUE THEN
    RAISE EXCEPTION 'CLOSE_REVIEW_REQUIRED: confirm you reviewed this month''s payments before closing';
  END IF;
  IF (v_figures #>> '{commissions,earned_cents}')::bigint <> 0 AND p_commissions_reviewed IS NOT TRUE THEN
    RAISE EXCEPTION 'CLOSE_REVIEW_REQUIRED: confirm you reviewed this month''s commissions before closing';
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

  v_summary := jsonb_build_object(
    'period_id', v_period_id,
    'period_start', v_period_start,
    'period_end', p_period_end
  ) || (v_figures -> 'close_receipt');

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

REVOKE ALL ON FUNCTION public._close_accounting_period_replay_impl_20261015(date, uuid, text, text, boolean, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.close_accounting_period(
  p_period_end date,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_reviewed_token text DEFAULT NULL::text,
  p_payments_reviewed boolean DEFAULT NULL::boolean,
  p_commissions_reviewed boolean DEFAULT NULL::boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: close_accounting_period requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND role = 'admin' AND is_active = true) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;
  -- The review arguments are not part of the intent: a retry of a close that succeeded replays its receipt.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'period_end', p_period_end));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'close_accounting_period', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._close_accounting_period_replay_impl_20261015(p_period_end, p_performed_by, p_idempotency_key,
    p_reviewed_token, p_payments_reviewed, p_commissions_reviewed);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'close_accounting_period', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.close_accounting_period(date, uuid, text, text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_accounting_period(date, uuid, text, text, boolean, boolean) TO authenticated, service_role;

DO $postflight$
BEGIN
  IF (SELECT proacl FROM pg_proc WHERE oid = 'public.get_monthly_summary(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public.close_accounting_period(date,uuid,text,text,boolean,boolean)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._close_accounting_period_replay_impl_20261015(date,uuid,text,text,boolean,boolean)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._month_close_figures_20270208(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._month_payments_received_20270208(date,date)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.allocation_sets'::regclass
                      AND conname = 'allocation_sets_payment_has_date' AND contype = 'c' AND convalidated)
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('close_accounting_period', '_close_accounting_period_replay_impl_20261015')) <> 2
     OR EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid IN ('public.get_monthly_summary(date,date)'::regprocedure,
                               'public.close_accounting_period(date,uuid,text,text,boolean,boolean)'::regprocedure,
                               'public._close_accounting_period_replay_impl_20261015(date,uuid,text,text,boolean,boolean)'::regprocedure,
                               'public._month_close_figures_20270208(date,date)'::regprocedure,
                               'public._month_payments_received_20270208(date,date)'::regprocedure)
                   AND (proowner <> 'postgres'::regrole
                        OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
                        -- the summary, wrapper and impl run as definer; the two helpers as the caller
                        OR prosecdef IS DISTINCT FROM (proname NOT IN ('_month_close_figures_20270208', '_month_payments_received_20270208')))) THEN
    RAISE EXCEPTION 'MONTH_CLOSE_RECHECK_POSTFLIGHT: grants, owner, overloads, security mode, search_path or the payment-date rule drifted';
  END IF;
END
$postflight$;
