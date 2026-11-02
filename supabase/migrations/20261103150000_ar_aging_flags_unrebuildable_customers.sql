-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261103150000_ar_aging_flags_unrebuildable_customers.md.
--
-- WHAT (KI-95, report half): get_ar_aging(date) used to check every customer first and raise when
--   ONE customer's balance could not be rebuilt as of the chosen date, so the whole report came back
--   empty for everyone. It now returns every other customer normally and returns each customer it
--   cannot rebuild as one extra row: amounts all NULL (nothing invented) and the new trailing
--   column unavailable_reason set to the helper's reason code. Normal rows have
--   unavailable_reason NULL and are otherwise the old rows.
--
-- WHY: the refusal is deliberate (it stops invented historical balances) and stays exactly as it
--   is in assert_customer_balance_reconstructable_as_of; only what the report does with it changes.
--
-- HOW: built from the LIVE body (read-only catalog read, 2026-11-02, md5(prosrc)
--   1f516543e5a3e0e448017ee28621302d, pinned by the preflight). The per-customer assert now runs in
--   its own exception block that catches only the three HISTORICAL_*_RECONSTRUCTION_UNAVAILABLE
--   codes (anything else still raises). Flagged customers are left out of the money query and
--   returned after it. Adding a column changes the return type, so the function is dropped and
--   re-created (no function or view depends on it: read-only catalog check 2026-11-02) and its live
--   grants are re-asserted: PUBLIC and anon none; authenticated and service_role EXECUTE.
--   require_admin(), SECURITY DEFINER and search_path = public, pg_temp are unchanged.
--   allocate_payment (KI-95's other half) is untouched.
--
-- ROLLBACK: a reviewed migration that drops this version and re-creates the body from
--   20260805151605_fix_historical_ar_report_cutoffs.sql with the same grants.

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_ar_aging') <> 1
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_ar_aging(date)'::regprocedure)
        IS DISTINCT FROM '1f516543e5a3e0e448017ee28621302d' THEN
    RAISE EXCEPTION 'AR_AGING_FLAGS_PREFLIGHT: get_ar_aging(date) is not the reviewed live body';
  END IF;
END
$preflight$;

DROP FUNCTION public.get_ar_aging(date);

CREATE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(customer_id uuid, farm_name text, current_amount numeric, days_30 numeric, days_60 numeric, days_90 numeric, over_90 numeric, total_outstanding numeric, prepay_balance_cents bigint, open_credit_cents bigint, unavailable_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer_id uuid;
  v_code text;
  v_unavailable_ids uuid[] := ARRAY[]::uuid[];
  v_unavailable_codes text[] := ARRAY[]::text[];
BEGIN
  PERFORM public.require_admin();
  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_HISTORICAL_REPORT_INPUT';
  END IF;

  FOR v_customer_id IN
    SELECT DISTINCT i.customer_id
      FROM public.invoices i
     WHERE i.invoice_date <= p_as_of_date
       AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
  LOOP
    BEGIN
      PERFORM public.assert_customer_balance_reconstructable_as_of(v_customer_id, p_as_of_date);
    EXCEPTION WHEN raise_exception THEN
      v_code := split_part(SQLERRM, ':', 1);
      -- Only the helper's three refusals become a flag; any other error still fails the report.
      IF v_code NOT IN ('HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE') THEN
        RAISE;
      END IF;
      v_unavailable_ids := v_unavailable_ids || v_customer_id;
      v_unavailable_codes := v_unavailable_codes || v_code;
    END;
  END LOOP;

  RETURN QUERY
  WITH eligible_invoices AS (
    SELECT
      i.id,
      i.customer_id,
      COALESCE(i.due_date, i.invoice_date)::date AS aging_date,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM public.invoices i
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(cma.amount_cents), 0)::bigint AS applied_cents
        FROM public.credit_memo_applications cma
       WHERE cma.target_invoice_id = i.id
         AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
         AND (
           cma.reversed_at IS NULL
           OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
         )
    ) credit_at_cutoff
    WHERE i.invoice_type <> 'credit_memo'
      AND i.invoice_date <= p_as_of_date
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND i.customer_id <> ALL (v_unavailable_ids)
  ),
  open_credits AS (
    SELECT
      ci.customer_id,
      COALESCE(sum(
        greatest(
          -ci.total_amount_cents - COALESCE((
            SELECT sum(cma.amount_cents)
              FROM public.credit_memo_applications cma
             WHERE cma.credit_memo_id = ci.id
               AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
               AND (
                 cma.reversed_at IS NULL
                 OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
               )
          ), 0),
          0::bigint
        )
      ), 0)::bigint AS credit_cents
    FROM public.invoices ci
    WHERE ci.invoice_type = 'credit_memo'
      AND ci.invoice_date <= p_as_of_date
      AND public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date)
      AND (ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    GROUP BY ci.customer_id
  )
  SELECT
    c.id,
    c.farm_name,
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date <= 29 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date BETWEEN 30 AND 59 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date BETWEEN 60 AND 89 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date BETWEEN 90 AND 119 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date >= 120 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(ei.statement_balance_cents), 0)::numeric / 100.0),
    c.prepay_balance_cents,
    COALESCE(oc.credit_cents, 0)::bigint,
    NULL::text
  FROM public.customers c
  JOIN eligible_invoices ei
    ON ei.customer_id = c.id
   AND ei.statement_balance_cents > 0
  LEFT JOIN open_credits oc ON oc.customer_id = c.id
  GROUP BY c.id, c.farm_name, c.prepay_balance_cents, oc.credit_cents
  HAVING sum(ei.statement_balance_cents) > 0
  ORDER BY sum(ei.statement_balance_cents) DESC;

  -- Customers whose balance cannot be rebuilt as of this date: listed, with no amounts.
  RETURN QUERY
  SELECT
    c.id, c.farm_name,
    NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    NULL::bigint, NULL::bigint,
    u.code
  FROM unnest(v_unavailable_ids, v_unavailable_codes) AS u(id, code)
  JOIN public.customers c ON c.id = u.id
  ORDER BY c.farm_name, c.id;
END;
$function$;

-- caller-analysis: get_ar_aging :: the four UI callers (ARaging, AccountsReceivable, CustomerDetail, CustomerContextCard) run as authenticated, which keeps EXECUTE; only PUBLIC and anon are revoked, exactly the live grants re-asserted after the re-create
REVOKE ALL ON FUNCTION public.get_ar_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_aging(date) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_oid oid := 'public.get_ar_aging(date)'::regprocedure;
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_ar_aging') <> 1
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proowner FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'postgres'::regrole
     OR (SELECT prosrc FROM pg_proc WHERE oid = v_oid) NOT LIKE '%PERFORM public.require_admin();%'
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR pg_get_function_result(v_oid) NOT LIKE '%open_credit_cents bigint, unavailable_reason text)' THEN
    RAISE EXCEPTION 'AR_AGING_FLAGS_POSTFLIGHT: get_ar_aging(date) shape, security or grants are not as reviewed';
  END IF;
END
$postflight$;
