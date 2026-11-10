-- KI-18 batch 3: statement and AR aging buckets.
-- (1) Customer statements use the AR Aging page's day ranges (Mason, 2026-11-07: "AR Aging ranges").
--     get_detailed_statement_data counted days past due as <=30 / 31-60 / 61-90 / 91-120 / >120, while
--     get_ar_aging (the AR Aging page, the customer page and the Financial Dashboard strip) uses
--     0-29 / 30-59 / 60-89 / 90-119 / 120+, so an invoice exactly 30 days past due was "Current" on the
--     statement and "30-59" on the AR Aging page. The statement's five bucket lines now use the AR Aging
--     ranges; nothing else in its body changes (same due-date basis, same balances, same JSON keys).
--     generate_batch_statements (Month-End Close) builds each statement with get_detailed_statement_data,
--     so printed, emailed and batch statements all change together.
-- (2) get_ar_aging(date) defaulted p_as_of_date to CURRENT_DATE, the UTC date, which is tomorrow from 6 pm
--     (CST) / 7 pm (CDT) Central until midnight. The default is now (now() AT TIME ZONE 'America/Chicago')::date,
--     the expression batches 1 and 2 use; its body is the live one byte for byte. No caller omits the date today.
-- Read-only live check (2026-11-07): every other statement and aging path already ages by the Chicago date.
-- get_detailed_statement_data, generate_batch_statements and get_customer_balance_listing take p_as_of_date
-- with no default; get_ap_aging defaults to the Chicago date; every screen sends todayInBusinessTz() (localToday()
-- returns the same date); the buckets subtract dates, so with the right date they are right at any evening instant.
-- Each statement below is the function's live definition (md5 checked, CR-normalized) with only the edits above.
-- Signatures, return types, volatility, SECURITY DEFINER, search_path, owners and EXECUTE grants are unchanged
-- (CREATE OR REPLACE keeps owners and grants; the preflight and postflight pin them). No row is read or written.
-- Re-runnable: the preflight accepts the pre-image or this file's body.
-- Rollback: a forward migration re-emitting the pre-images (their md5s are in the preflight).
DO $preflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('get_ar_aging(date)', 'd8cee7b2fd320100a86d74880d81ef4c', 'd8cee7b2fd320100a86d74880d81ef4c'),
    ('get_detailed_statement_data(uuid,date,text)', '2f90d93ebc665862a091bab4a358b602', '563262933514ab15e5bc5e0559168e64')
  ) AS t(sig, pre_md5, post_md5)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % is missing', v_row.sig;
    END IF;
    IF md5(replace(v_fn.prosrc, chr(13), '')) NOT IN (v_row.pre_md5, v_row.post_md5)
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR v_fn.prosecdef IS DISTINCT FROM true
       OR v_fn.provolatile <> 's'
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL')
          IS DISTINCT FROM '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % body, settings, SECURITY DEFINER, owner or grants drifted; re-review the current definition', v_row.sig;
    END IF;
  END LOOP;
  -- Argument defaults are outside the body md5: get_ar_aging's date default must be the UTC one this replaces,
  -- or (re-run) the Chicago date, never something else this file would silently overwrite.
  IF pg_get_function_arguments('public.get_ar_aging(date)'::regprocedure) !~
     '^p_as_of_date date DEFAULT (CURRENT_DATE|\(\(now\(\) AT TIME ZONE ''America/Chicago''::text\)\)::date)$' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: get_ar_aging date default drifted; re-review the current definition';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT ((now() AT TIME ZONE 'America/Chicago'))::date)
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

CREATE OR REPLACE FUNCTION public.get_detailed_statement_data(
  p_customer_id uuid,
  p_as_of_date date,
  p_mode text DEFAULT 'summary'::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer RECORD;
  v_aging jsonb;
  v_balance bigint := 0;
  v_open_credit_cents bigint := 0;
  v_inv RECORD;
  v_items jsonb;
  v_shares jsonb;
  v_finance_cents bigint;
  v_txn_list jsonb := '[]'::jsonb;
  v_days_aged integer;
  v_description text;
  v_grower_names text[];
BEGIN
  PERFORM require_admin();
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  -- Generic void_invoice deliberately zeroes the mutable money columns. Its
  -- audit snapshot is not a complete event ledger for every possible change
  -- between the cutoff and the void, so emitting a guessed historical balance
  -- would be unsafe. Credit-memo unapply is different: it preserves the memo's
  -- face amount and reverses applications in the immutable application ledger.
  IF EXISTS (
    SELECT 1
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND i.invoice_date <= p_as_of_date
      AND (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
      AND EXISTS (
        SELECT 1
        FROM financial_audit_log fal
        WHERE fal.entity_type = 'invoice'
          AND fal.entity_id = i.id
          AND fal.operation_type = 'invoice_voided'
      )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE: a later generic invoice void prevents a trustworthy statement at this cutoff';
  END IF;

  -- An invoice unposted after the cutoff becomes editable again.  The audit
  -- ledger records its posting interval but not every subsequent header or
  -- line-item edit, so today's mutable row cannot prove its former contents.
  IF EXISTS (
    SELECT 1
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND i.invoice_date <= p_as_of_date
      AND EXISTS (
        SELECT 1
        FROM financial_audit_log fal
        WHERE fal.entity_type = 'invoice'
          AND fal.entity_id = i.id
          AND fal.operation_type = 'invoice_unposted'
          AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
      )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE: a later invoice unpost prevents a trustworthy statement at this cutoff';
  END IF;

  IF public.statement_customer_has_later_balance_activity(p_customer_id, p_as_of_date) THEN
    RAISE EXCEPTION 'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE: later payment, prepay, or write-off activity prevents a trustworthy statement at this cutoff';
  END IF;

  -- The generated balance contains today's credit_applied_cents. Replace that
  -- one lever with applications active at the cutoff so a later application or
  -- reversal changes neither side of a regenerated historical statement.
  FOR v_inv IN
    SELECT i.*,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM invoices i
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(cma.amount_cents), 0)::bigint AS applied_cents
      FROM credit_memo_applications cma
      WHERE cma.target_invoice_id = i.id
        AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
        AND (cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    ) credit_at_cutoff
    WHERE i.customer_id = p_customer_id
      AND i.invoice_type <> 'credit_memo'
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND i.invoice_date <= p_as_of_date
      AND (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      ) > 0
    ORDER BY i.invoice_date, i.invoice_number
  LOOP
    v_balance := v_balance + v_inv.statement_balance_cents;
    v_days_aged := p_as_of_date - v_inv.invoice_date;

    IF v_inv.invoice_type = 'field_application' AND v_inv.crop_type IS NOT NULL THEN
      v_description := COALESCE(v_inv.crop_type, '')
        || ' - ' || COALESCE(v_inv.total_acres::text, '')
        || ' - ' || COALESCE(array_to_string(v_inv.field_names, ', '), '');
    ELSIF v_inv.invoice_type = 'chemical_sale' THEN
      v_description := 'Chemical Sale: ' || COALESCE(v_inv.header_notes, '');
    ELSE
      v_description := COALESCE(v_inv.header_notes, v_inv.invoice_type);
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'customer_name', s.customer_name,
          'split_percentage', s.split_percentage,
          'acres', s.acres,
          'amount_cents', s.amount_cents,
          'is_primary', s.is_primary,
          'price_per_acre_cents', CASE
            WHEN s.customer_id = p_customer_id THEN s.price_per_acre_cents
            ELSE NULL
          END,
          'pricing_note', CASE
            WHEN s.customer_id = p_customer_id THEN s.pricing_note
            ELSE NULL
          END
        ) ORDER BY s.sort_order
      ),
      '[]'::jsonb
    )
    INTO v_shares
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

    SELECT array_agg(s.customer_name ORDER BY s.sort_order)
    INTO v_grower_names
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

    v_items := '[]'::jsonb;
    IF p_mode = 'detailed' THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'product_name', ii.description,
            'epa_registration', ii.epa_registration,
            'rate_per_acre', ii.rate_per_acre,
            'rate_unit', ii.rate_unit,
            'total_applied', ii.total_applied,
            'total_applied_unit', ii.total_applied_unit,
            'total_applied_gl_lb', ii.total_applied_gl_lb,
            'gl_lb_unit', ii.gl_lb_unit,
            'unit_price_cents', ii.unit_price_cents,
            'total_cost_cents', ii.extended_cents,
            'is_application_fee', COALESCE(ii.is_application_fee, false),
            'quantity', ii.quantity,
            'unit_size', ii.unit_size,
            'product_form', ii.product_form
          ) ORDER BY ii.sort_order
        ),
        '[]'::jsonb
      )
      INTO v_items
      FROM invoice_items ii
      WHERE ii.invoice_id = v_inv.id;
    END IF;

    SELECT COALESCE(sum(fc.amount_cents), 0)
    INTO v_finance_cents
    FROM finance_charges fc
    WHERE fc.invoice_id = v_inv.id;

    v_txn_list := v_txn_list || jsonb_build_object(
      'invoice_number', v_inv.invoice_number,
      'invoice_date', v_inv.invoice_date,
      'due_date', v_inv.due_date,
      'invoice_type', v_inv.invoice_type,
      'status', v_inv.status,
      'days_aged', v_days_aged,
      'description', v_description,
      'crop_type', v_inv.crop_type,
      'field_names', v_inv.field_names,
      'total_acres', v_inv.total_acres,
      'grower_names', v_grower_names,
      'total_amount_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents,
      'balance_cents', v_inv.statement_balance_cents,
      'items', v_items,
      'shares', v_shares,
      'finance_charge_cents', v_finance_cents,
      'net_due_cents', v_inv.statement_balance_cents,
      'price_per_acre', CASE
        WHEN v_inv.total_acres > 0 THEN
          round(v_inv.total_amount_cents / 100.0 / v_inv.total_acres, 2)
        ELSE NULL
      END
    );
  END LOOP;

  WITH statement_invoices AS (
    SELECT i.*,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM invoices i
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(cma.amount_cents), 0)::bigint AS applied_cents
      FROM credit_memo_applications cma
      WHERE cma.target_invoice_id = i.id
        AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
        AND (cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    ) credit_at_cutoff
    WHERE i.customer_id = p_customer_id
      AND i.invoice_type <> 'credit_memo'
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND i.invoice_date <= p_as_of_date
  )
  SELECT jsonb_build_object(
    'current_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) <= 29 THEN i.statement_balance_cents ELSE 0 END), 0),
    'days_30_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 30 AND 59 THEN i.statement_balance_cents ELSE 0 END), 0),
    'days_60_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 60 AND 89 THEN i.statement_balance_cents ELSE 0 END), 0),
    'days_90_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 90 AND 119 THEN i.statement_balance_cents ELSE 0 END), 0),
    'over_120_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) >= 120 THEN i.statement_balance_cents ELSE 0 END), 0)
  )
  INTO v_aging
  FROM statement_invoices i
  WHERE i.statement_balance_cents > 0;

  -- `balance_cents` is the memo's *current* generated balance.  A statement
  -- regenerated for an earlier date must instead replay the immutable credit
  -- application ledger as it stood on that date: applications made later do
  -- not reduce the historical credit, while an application reversed later was
  -- still consuming credit at the cutoff.
  SELECT COALESCE(SUM(
    GREATEST(-ci.total_amount_cents - COALESCE((
      SELECT SUM(cma.amount_cents)
      FROM credit_memo_applications cma
      WHERE cma.credit_memo_id = ci.id
        AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
        AND (cma.reversed_at IS NULL OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    ), 0), 0::bigint)
  ), 0)::bigint
  INTO v_open_credit_cents
  FROM invoices ci
  WHERE ci.customer_id = p_customer_id
    AND ci.invoice_type = 'credit_memo'
    AND public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date)
    AND (ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    AND (ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    AND ci.invoice_date <= p_as_of_date;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_customer.id,
      'farm_name', v_customer.farm_name,
      'contact_name', v_customer.contact_name,
      'account_number', v_customer.account_number,
      'email', v_customer.email,
      'phone', v_customer.phone,
      'billing_address', v_customer.billing_address,
      'city', v_customer.city,
      'state', v_customer.state,
      'zip', v_customer.zip,
      'payment_terms', v_customer.payment_terms
    ),
    'transactions', v_txn_list,
    'aging', v_aging,
    'outstanding_balance_cents', v_balance,
    'open_credit_cents', v_open_credit_cents,
    'net_account_position_cents', v_balance - v_open_credit_cents,
    'as_of_date', p_as_of_date,
    'mode', p_mode
  );
END;
$function$;

DO $postflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('get_ar_aging(date)', 'd8cee7b2fd320100a86d74880d81ef4c'),
    ('get_detailed_statement_data(uuid,date,text)', '563262933514ab15e5bc5e0559168e64')
  ) AS t(sig, post_md5)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL
       OR md5(replace(v_fn.prosrc, chr(13), '')) <> v_row.post_md5
       OR pg_get_function_arguments(v_fn.oid) ~* '\mcurrent_date\M'
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR v_fn.prosecdef IS DISTINCT FROM true
       OR v_fn.provolatile <> 's'
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL')
          IS DISTINCT FROM '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}'
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % did not take the new definition, or its settings, owner or grants changed', v_row.sig;
    END IF;
  END LOOP;
  -- Argument defaults are outside the body md5: get_ar_aging's date default must be the Chicago date.
  IF pg_get_function_arguments('public.get_ar_aging(date)'::regprocedure) !~ 'now\(\) AT TIME ZONE ''America/Chicago''::text' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_ar_aging date default is not the Chicago date';
  END IF;
END;
$postflight$;
