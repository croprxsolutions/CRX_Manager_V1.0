-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261103160000_balance_reports_flag_unrebuildable_customers.md.
--
-- WHAT (KI-95, the two report gaps left by 20261103150000):
--   1. get_ar_aging(date): HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE (two posting events on one
--      invoice with the same audit timestamp, raised by statement_invoice_was_posted_as_of) was
--      raised by the customer-list query and the money query, outside the per-customer check, so
--      it still emptied the whole report. Each customer's invoices are now read inside that
--      customer's own check, so that code flags only the affected customer, like the other three.
--   2. get_customer_balance_listing(date) gets the same flag-don't-fail behaviour: every customer it
--      can rebuild as of the date is returned exactly as before, and each one it cannot is one extra
--      row with every amount, the invoice count and the oldest-unpaid date NULL (nothing invented)
--      and the new trailing column unavailable_reason set to the reason code. Normal rows have
--      unavailable_reason NULL.
--
-- WHY: the refusals are deliberate (they stop invented historical balances) and stay exactly as
--   they are in assert_customer_balance_reconstructable_as_of and statement_invoice_was_posted_as_of;
--   only what the two reports do with them changes.
--
-- HOW: built from the LIVE bodies (read-only catalog read, 2026-11-02): get_ar_aging(date)
--   md5(prosrc) 2f2ed6575515b425782a56f3128c2d9a (the 20261103150000 body) and
--   get_customer_balance_listing(date) md5(prosrc) eec2150d984104acc17a8ecc3c20fd16 (the
--   20261013220000 body), both pinned by the preflight.
--   - The customer loop now lists every customer with an invoice dated on or before the date (in
--     the caller's scope), and inside the per-customer exception block reads the posting state of
--     EVERY one of that customer's invoices the report later reads (count(*) FILTER evaluates each
--     row). A customer with no invoice posted as of the date is skipped, exactly as before; the rest
--     run the unchanged reconstruction assert. The block catches only the four
--     HISTORICAL_*_RECONSTRUCTION_UNAVAILABLE codes; anything else still raises.
--   - The money queries call statement_invoice_was_posted_as_of inside a CASE that first returns
--     false for an invoice dated after the cutoff, outside a rep's scope, or of a flagged customer
--     (CASE fixes the evaluation order; a plain AND would not). So the helper there reads only
--     invoices the loop already read without error, under the same snapshot (both are STABLE).
--   - get_customer_balance_listing adds a column, so it is dropped and re-created (no function, view
--     or other dependency names it: read-only catalog check 2026-11-02). get_ar_aging keeps its
--     signature and is replaced in place. Live grants are re-asserted on both: PUBLIC and anon none;
--     authenticated and service_role EXECUTE. The admin / sales-rep checks, the reps' invoice scope,
--     the reps' no-history rule, SECURITY DEFINER and search_path = public, pg_temp are unchanged.
--   allocate_payment (KI-95's payment half, KI-19 lane) is untouched.
--
-- ROLLBACK: a reviewed migration that re-creates get_ar_aging from
--   20261103150000_ar_aging_flags_unrebuildable_customers.sql, and drops this
--   get_customer_balance_listing and re-creates it from 20261013220000_reps_work_any_customer.sql,
--   with the same grants.

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_ar_aging') <> 1
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_ar_aging(date)'::regprocedure)
        IS DISTINCT FROM '2f2ed6575515b425782a56f3128c2d9a'
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_customer_balance_listing') <> 1
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_customer_balance_listing(date)'::regprocedure)
        IS DISTINCT FROM 'eec2150d984104acc17a8ecc3c20fd16' THEN
    RAISE EXCEPTION 'BALANCE_REPORT_FLAGS_PREFLIGHT: get_ar_aging(date) or get_customer_balance_listing(date) is not the reviewed live body';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(customer_id uuid, farm_name text, current_amount numeric, days_30 numeric, days_60 numeric, days_90 numeric, over_90 numeric, total_outstanding numeric, prepay_balance_cents bigint, open_credit_cents bigint, unavailable_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer_id uuid;
  v_code text;
  v_posted bigint;
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
  LOOP
    BEGIN
      -- Reads the posting state of every invoice the report reads for this customer, here, so an
      -- unreadable posting history flags only this customer instead of failing the report.
      SELECT count(*) FILTER (WHERE public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date))
        INTO v_posted
        FROM public.invoices i
       WHERE i.customer_id = v_customer_id
         AND i.invoice_date <= p_as_of_date;
      IF v_posted > 0 THEN
        PERFORM public.assert_customer_balance_reconstructable_as_of(v_customer_id, p_as_of_date);
      END IF;
    EXCEPTION WHEN raise_exception THEN
      v_code := split_part(SQLERRM, ':', 1);
      -- Only the four reconstruction refusals become a flag; any other error still fails the report.
      IF v_code NOT IN ('HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE') THEN
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
      -- CASE fixes the order (a plain AND has none): the helper reads only invoices the loop
      -- already read, never one dated after the cutoff or a flagged customer's.
      AND CASE WHEN i.invoice_date > p_as_of_date OR i.customer_id = ANY (v_unavailable_ids) THEN false
               ELSE public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date) END
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
      AND CASE WHEN ci.invoice_date > p_as_of_date OR ci.customer_id = ANY (v_unavailable_ids) THEN false
               ELSE public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date) END
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

DROP FUNCTION public.get_customer_balance_listing(date);

CREATE FUNCTION public.get_customer_balance_listing(p_as_of_date date)
 RETURNS TABLE(customer_id uuid, farm_name text, total_invoiced numeric, total_paid numeric, prepay_applied numeric, outstanding_balance numeric, open_credit numeric, invoice_count bigint, oldest_unpaid_date date, unavailable_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_is_admin boolean;
  v_customer_id uuid;
  v_code text;
  v_posted bigint;
  v_unavailable_ids uuid[] := ARRAY[]::uuid[];
  v_unavailable_codes text[] := ARRAY[]::text[];
BEGIN
  IF v_actor IS NULL OR p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_HISTORICAL_REPORT_INPUT';
  END IF;

  SELECT p.role
    INTO v_role
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Permission denied: requires admin or sales_rep role';
  END IF;
  v_is_admin := v_role = 'admin';
  -- Reps list balances of ANY customer (Mason, 2026-10-13; 20261013220000 removed the
  -- assigned-rep filters), still counting only invoices they created or are the salesperson on.

  IF NOT v_is_admin
     AND p_as_of_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Admin access required for historical customer balance report';
  END IF;

  FOR v_customer_id IN
    SELECT DISTINCT i.customer_id
      FROM public.invoices i
      JOIN public.customers c ON c.id = i.customer_id
     WHERE i.invoice_date <= p_as_of_date
       AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
  LOOP
    BEGIN
      -- Reads the posting state of every invoice the listing reads for this customer, here, so an
      -- unreadable posting history flags only this customer instead of failing the listing.
      SELECT count(*) FILTER (WHERE public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date))
        INTO v_posted
        FROM public.invoices i
       WHERE i.customer_id = v_customer_id
         AND i.invoice_date <= p_as_of_date
         AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor);
      IF v_posted > 0 THEN
        PERFORM public.assert_customer_balance_reconstructable_as_of(v_customer_id, p_as_of_date);
      END IF;
    EXCEPTION WHEN raise_exception THEN
      v_code := split_part(SQLERRM, ':', 1);
      -- Only the four reconstruction refusals become a flag; any other error still fails the listing.
      IF v_code NOT IN ('HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE') THEN
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
      i.invoice_date::date,
      i.total_amount_cents,
      i.paid_amount_cents,
      i.prepay_applied_cents,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM public.invoices i
    JOIN public.customers scoped_customer ON scoped_customer.id = i.customer_id
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
      AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
      -- CASE fixes the order (a plain AND has none): the helper reads only invoices the loop
      -- already read, never one dated after the cutoff, outside a rep's scope, or a flagged customer's.
      AND CASE WHEN i.invoice_date > p_as_of_date
                    OR NOT (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
                    OR i.customer_id = ANY (v_unavailable_ids) THEN false
               ELSE public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date) END
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
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
    JOIN public.customers scoped_customer ON scoped_customer.id = ci.customer_id
    WHERE ci.invoice_type = 'credit_memo'
      AND ci.invoice_date <= p_as_of_date
      AND (v_is_admin OR ci.created_by = v_actor OR ci.salesman_id = v_actor)
      AND CASE WHEN ci.invoice_date > p_as_of_date
                    OR NOT (v_is_admin OR ci.created_by = v_actor OR ci.salesman_id = v_actor)
                    OR ci.customer_id = ANY (v_unavailable_ids) THEN false
               ELSE public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date) END
      AND (ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    GROUP BY ci.customer_id
  )
  SELECT
    c.id,
    c.farm_name,
    round(COALESCE(sum(ei.total_amount_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.paid_amount_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.prepay_applied_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) / 100.0, 2),
    round(COALESCE(oc.credit_cents, 0) / 100.0, 2),
    count(ei.id),
    min(ei.invoice_date) FILTER (WHERE ei.statement_balance_cents > 0),
    NULL::text
  FROM public.customers c
  LEFT JOIN eligible_invoices ei ON ei.customer_id = c.id
  LEFT JOIN open_credits oc ON oc.customer_id = c.id
  WHERE c.id <> ALL (v_unavailable_ids)
  GROUP BY c.id, c.farm_name, oc.credit_cents
  HAVING COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) > 0
      OR COALESCE(oc.credit_cents, 0) > 0
  ORDER BY COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) DESC;

  -- Customers whose balance cannot be rebuilt as of this date: listed, with no amounts.
  RETURN QUERY
  SELECT
    c.id, c.farm_name,
    NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    NULL::bigint, NULL::date,
    u.code
  FROM unnest(v_unavailable_ids, v_unavailable_codes) AS u(id, code)
  JOIN public.customers c ON c.id = u.id
  ORDER BY c.farm_name, c.id;
END;
$function$;

-- caller-analysis: get_ar_aging :: the four UI callers (ARaging, AccountsReceivable, CustomerDetail, CustomerContextCard) run as authenticated, which keeps EXECUTE; only PUBLIC and anon are revoked, exactly the live grants re-asserted
REVOKE ALL ON FUNCTION public.get_ar_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_aging(date) TO authenticated, service_role;
-- caller-analysis: get_customer_balance_listing :: the one UI caller (Reports, Customer Balance tab) runs as authenticated, which keeps EXECUTE; only PUBLIC and anon are revoked, exactly the live grants re-asserted after the re-create
REVOKE ALL ON FUNCTION public.get_customer_balance_listing(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_balance_listing(date) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_aging oid := 'public.get_ar_aging(date)'::regprocedure;
  v_listing oid := 'public.get_customer_balance_listing(date)'::regprocedure;
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_ar_aging') <> 1
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_customer_balance_listing') <> 1
     OR EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid IN (v_aging, v_listing)
          AND (NOT p.prosecdef
               OR p.proowner IS DISTINCT FROM 'postgres'::regrole
               OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
               OR p.prosrc NOT LIKE '%''HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE''%'
               OR has_function_privilege('anon', p.oid, 'EXECUTE')
               OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')))
     OR (SELECT prosrc FROM pg_proc WHERE oid = v_aging) NOT LIKE '%PERFORM public.require_admin();%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = v_listing) NOT LIKE '%requires admin or sales_rep role%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = v_listing) NOT LIKE '%Admin access required for historical customer balance report%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = v_listing) NOT LIKE '%(v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)%'
     OR pg_get_function_result(v_aging) NOT LIKE '%open_credit_cents bigint, unavailable_reason text)'
     OR pg_get_function_result(v_listing) NOT LIKE '%oldest_unpaid_date date, unavailable_reason text)' THEN
    RAISE EXCEPTION 'BALANCE_REPORT_FLAGS_POSTFLIGHT: get_ar_aging or get_customer_balance_listing shape, security or grants are not as reviewed';
  END IF;
END
$postflight$;
