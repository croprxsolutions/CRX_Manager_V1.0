-- STATUS: NOT APPLIED
-- The business day is America/Chicago; the database session is UTC.
-- 1. current_season() read CURRENT_DATE (UTC), so the season flipped at ~7pm
--    Central on Sept 30. It now reads the Chicago date. Every caller (column
--    defaults, prepay splits, field dashboard, prep card, call lists, ...)
--    follows without change.
-- 2. The customer statement dated prepay applications (applied_at) and
--    allocation-set payments without a payment_date (created_at) by the UTC
--    date, while write-offs already used Chicago. Evening entries landed on the
--    next day (or month). Both now use the Chicago date. Nothing else changes:
--    access check, rows, amounts, order, defaults, owner and grants are kept.
-- 3. Invoices: invoices.season defaults to current_season() (now Chicago), so
--    invoices.invoice_date's default moves from the UTC CURRENT_DATE to the
--    Chicago date too, and the return-credit header (the one live writer that
--    pairs current_season() with CURRENT_DATE) dates its credit memo, due date
--    and period check by the Chicago date. Otherwise a 30 Sept 7 pm-midnight
--    Central invoice would carry a 1 Oct date with the 30 Sept season.
-- No existing row is rewritten.

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.current_season()');
  IF NOT FOUND OR md5(replace(v_fn.prosrc, chr(13), '')) <> 'e2b73d55a7a134ba0cfaeabe4c445ec0'
     OR v_fn.prosecdef OR v_fn.provolatile <> 's'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: current_season drift; re-review before applying';
  END IF;
  SELECT * INTO v_fn FROM pg_proc
   WHERE oid = to_regprocedure('public._get_customer_statement_scoped_impl(uuid,date,date)');
  IF NOT FOUND OR md5(replace(v_fn.prosrc, chr(13), '')) <> 'fc53067bcf2adb69cad2a2cc381983a4'
     OR NOT v_fn.prosecdef OR v_fn.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: _get_customer_statement_scoped_impl drift; re-review before applying';
  END IF;
  SELECT * INTO v_fn FROM pg_proc
   WHERE oid = to_regprocedure('public._issue_return_credit_header_only_impl_20260825(uuid,uuid,text)');
  IF NOT FOUND OR md5(replace(v_fn.prosrc, chr(13), '')) <> '4b32da9a350ca22e9dece371b1985493'
     OR NOT v_fn.prosecdef OR v_fn.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.provolatile <> 'v' OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: _issue_return_credit_header_only_impl_20260825 drift; re-review before applying';
  END IF;
  IF (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
        JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'public.invoices'::regclass AND a.attname = 'invoice_date')
     IS DISTINCT FROM 'CURRENT_DATE' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: invoices.invoice_date default drift; re-review before applying';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.current_season()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT compute_season((now() AT TIME ZONE 'America/Chicago')::date);
$function$;

CREATE OR REPLACE FUNCTION public._get_customer_statement_scoped_impl(p_customer_id uuid, p_start_date date DEFAULT ((CURRENT_DATE - '90 days'::interval))::date, p_end_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'INVALID_STATEMENT_DATE_RANGE';
  END IF;

  RETURN QUERY
  WITH all_txns AS (
    SELECT
      i.invoice_date::date AS txn_date,
      CASE WHEN i.invoice_type = 'credit_memo' THEN 'credit' ELSE 'invoice' END AS txn_type,
      i.invoice_number AS ref_num,
      CASE WHEN i.invoice_type = 'credit_memo'
           THEN 'Credit Memo ' || i.invoice_number
           ELSE 'Invoice ' || i.invoice_number END AS descr,
      i.total_amount_cents AS amt,
      10 AS source_rank,
      i.id AS sort_id
    FROM public.invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status IN ('posted', 'paid', 'overdue')
      AND i.deleted_at IS NULL

    UNION ALL

    SELECT
      p.payment_date::date,
      'payment',
      COALESCE(p.reference_number, ''),
      'Payment - ' || p.payment_method,
      -(p.amount * 100)::bigint,
      20,
      p.id
    FROM public.payments p
    LEFT JOIN public.orders o ON o.id = p.order_id
    WHERE COALESCE(o.customer_id, p.customer_id) = p_customer_id
      AND p.deleted_at IS NULL

    UNION ALL

    SELECT
      COALESCE(a.payment_date, (a.created_at AT TIME ZONE 'America/Chicago')::date),
      'payment',
      COALESCE(a.reference_number, a.check_number, ''),
      'Payment - ' || COALESCE(a.payment_method, 'other'),
      -COALESCE(a.total_allocated_cents, 0),
      21,
      a.id
    FROM public.allocation_sets a
    WHERE a.entity_type = 'payment'
      AND a.is_active = true
      AND a.customer_id = p_customer_id
      AND COALESCE(a.total_allocated_cents, 0) > 0

    UNION ALL

    SELECT
      (pa.applied_at AT TIME ZONE 'America/Chicago')::date,
      'prepay',
      '',
      'Prepay Applied',
      -pa.applied_amount_cents,
      30,
      pa.id
    FROM public.prepay_applications pa
    INNER JOIN public.prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.customer_id = p_customer_id

    UNION ALL

    SELECT
      (wo.created_at AT TIME ZONE 'America/Chicago')::date,
      'write_off',
      i.invoice_number,
      'Write-off - ' || wo.reason,
      -wo.amount_cents,
      40,
      wo.id
    FROM public.write_offs wo
    INNER JOIN public.invoices i ON i.id = wo.invoice_id
    WHERE wo.customer_id = p_customer_id
      AND wo.reversed_at IS NULL
  ),
  opening AS (
    SELECT COALESCE(SUM(a.amt), 0)::bigint AS amt
      FROM all_txns a
     WHERE a.txn_date < p_start_date
  ),
  statement_txns AS (
    SELECT
      p_start_date AS txn_date,
      'opening_balance'::text AS txn_type,
      ''::text AS ref_num,
      'Opening Balance'::text AS descr,
      o.amt,
      0 AS source_rank,
      '00000000-0000-0000-0000-000000000000'::uuid AS sort_id
    FROM opening o
    WHERE o.amt <> 0

    UNION ALL

    SELECT a.txn_date, a.txn_type, a.ref_num, a.descr, a.amt,
           a.source_rank, a.sort_id
      FROM all_txns a
     WHERE a.txn_date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    t.txn_date,
    t.txn_type,
    t.ref_num,
    t.descr,
    t.amt,
    SUM(t.amt) OVER (
      ORDER BY t.txn_date, t.source_rank, t.sort_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )::bigint
  FROM statement_txns t
  ORDER BY t.txn_date, t.source_rank, t.sort_id;
END;
$function$;

ALTER TABLE public.invoices ALTER COLUMN invoice_date SET DEFAULT (now() AT TIME ZONE 'America/Chicago')::date;

CREATE OR REPLACE FUNCTION public._issue_return_credit_header_only_impl_20260825(p_return_id uuid, p_actor_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_return record;
  v_total bigint;
  v_invoice_id uuid;
  v_invoice_num text;
  v_customer_id uuid;
  v_order_id uuid;
  v_return_number text;
  v_salesman_id uuid;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT r.id, r.status, r.customer_id, r.order_id, r.return_number
    INTO v_return
    FROM returns r
   WHERE r.id = p_return_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND'; END IF;
  IF v_return.status <> 'received' THEN RAISE EXCEPTION 'INVALID_RETURN_STATUS: %', v_return.status; END IF;

  v_customer_id := v_return.customer_id;
  v_order_id := v_return.order_id;
  v_return_number := v_return.return_number;

  PERFORM check_period_open((now() AT TIME ZONE 'America/Chicago')::date);

  SELECT COALESCE(SUM(ri.extended_cents), 0)
    INTO v_total
    FROM return_items ri
   WHERE ri.return_id = p_return_id;

  IF v_total <= 0 THEN RAISE EXCEPTION 'RETURN_CREDIT_EMPTY'; END IF;

  v_invoice_num := next_invoice_number('credit_memo');

  IF v_order_id IS NOT NULL THEN
    SELECT o.salesman_id INTO v_salesman_id
      FROM orders o
     WHERE o.id = v_order_id;
  END IF;

  INSERT INTO invoices (
    invoice_number, order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, paid_amount_cents,
    prepay_applied_cents, posted_by, posted_at, invoice_date, due_date,
    header_notes, parent_invoice_id
  ) VALUES (
    v_invoice_num, v_order_id, v_customer_id, 'credit_memo', 'posted', current_season(),
    v_salesman_id, v_actor, -v_total, 0, 0, v_actor, now(),
    (now() AT TIME ZONE 'America/Chicago')::date, (now() AT TIME ZONE 'America/Chicago')::date,
    'Credit memo for return ' || v_return_number, NULL
  )
  RETURNING id INTO v_invoice_id;

  PERFORM set_config('app.return_rpc', 'true', true);  -- PARKED-004
  UPDATE returns
     SET status = 'credited',
         total_credit_cents = v_total,
         credit_invoice_id = v_invoice_id,
         credited_at = now(),
         credited_by = v_actor,
         updated_at = now()
   WHERE id = p_return_id;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'credit_memo_created', 'credit_memo', v_invoice_id,
    v_actor, -v_total,
    'Credit memo ' || v_invoice_num || ' created for return ' || v_return_number,
    jsonb_build_object(
      'invoice_id', v_invoice_id,
      'invoice_number', v_invoice_num,
      'return_id', p_return_id,
      'return_number', v_return_number,
      'customer_id', v_customer_id,
      'credit_amount_cents', v_total
    )
  );

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'return_credit_issued', 'return', p_return_id,
    v_actor, -v_total,
    'Credit issued for return ' || v_return_number || ' -> invoice ' || v_invoice_num,
    jsonb_build_object(
      'credit_invoice_id', v_invoice_id,
      'credit_invoice_number', v_invoice_num,
      'credit_amount_cents', v_total,
      'customer_id', v_customer_id
    )
  );

  v_result := jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return_number,
    'credit_invoice_id', v_invoice_id,
    'credit_invoice_number', v_invoice_num,
    'credit_amount_cents', v_total,
    'customer_id', v_customer_id,
    'credited_at', now()
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'issue_return_credit', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
