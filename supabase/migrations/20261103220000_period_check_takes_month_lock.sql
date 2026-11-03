-- Written 2026-11-02. Apply status is tracked in docs/reference/migrations.d/.
--
-- WHAT (KI-19): check_period_open now takes the shared accounting-month lock
--   (public._lock_accounting_months, namespace 73492010) for its date before it reads
--   accounting_periods. close_accounting_period takes the exclusive lock on the same month, so a
--   write and a close of that month now serialize: a write that started first finishes before the
--   close reads; a write that starts after the close commits sees the month closed and is refused.
--   Every caller of check_period_open (32 live functions, 26 of which took no lock) is covered by
--   this one change; none of their bodies is redefined, so KI-10 batch 4's replay checks are untouched.
--   The lock is taken wherever each caller calls check_period_open, immediately before the period
--   read; some callers do that before their row locks, some after. Callers that already lock the
--   month re-take the same shared lock, which is a no-op. The lock lasts until the caller's
--   transaction ends. Known limit: a writer locking month-then-row and another locking row-then-month
--   on the same invoice, while a close of that past month is queued, can deadlock; PostgreSQL cancels
--   one of them (40P01) and nothing is written. Recorded under KI-19.
-- WHAT (KI-95 payment half): allocate_payment refuses a payment date after today in Central time
--   (PAYMENT_DATE_IN_FUTURE). Neither payment screen sends a date (both use today), so no screen
--   changes. Nothing else in allocate_payment changes: the postflight proves the new body minus the
--   inserted block is byte-identical to the pinned live body.
-- Signatures, owners, grants, SECURITY DEFINER and search paths stay as they are.
-- ROLLBACK: a new forward migration re-creating both bodies without the added blocks (the old
--   bodies are the pinned ones: check_period_open from 20260730114102, allocate_payment from
--   20261101120000), with a preflight pinning this migration's bodies. No data changes.
-- ============================================================================

SET LOCAL lock_timeout = '10s';

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'check_period_open') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'allocate_payment') <> 1
     OR to_regprocedure('public._lock_accounting_months(date[],boolean)') IS NULL THEN
    RAISE EXCEPTION 'PERIOD_LOCK_PREFLIGHT: check_period_open, allocate_payment or _lock_accounting_months overload drift';
  END IF;

  SELECT * INTO v_fn FROM pg_proc WHERE oid = 'public.check_period_open(date)'::regprocedure;
  IF md5(replace(v_fn.prosrc, chr(13), '')) <> 'b9be748c47885e7af707c9afc550c316'
     OR pg_get_userbyid(v_fn.proowner) <> 'postgres' OR NOT v_fn.prosecdef
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=""']
     OR v_fn.proacl::text IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'PERIOD_LOCK_PREFLIGHT: check_period_open body or contract drift; re-review before applying';
  END IF;

  SELECT * INTO v_fn FROM pg_proc WHERE oid = 'public.allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)'::regprocedure;
  IF md5(replace(v_fn.prosrc, chr(13), '')) <> '324500adf4684d7e0f993304ef58f494'
     OR pg_get_userbyid(v_fn.proowner) <> 'postgres' OR NOT v_fn.prosecdef
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.proacl::text IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'PERIOD_LOCK_PREFLIGHT: allocate_payment body or contract drift; re-review before applying';
  END IF;

  SELECT * INTO v_fn FROM pg_proc WHERE oid = 'public._lock_accounting_months(date[],boolean)'::regprocedure;
  IF md5(replace(v_fn.prosrc, chr(13), '')) <> '6a9ea03f7980d6d219a9b90f8c47a2e7'
     OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
    RAISE EXCEPTION 'PERIOD_LOCK_PREFLIGHT: _lock_accounting_months drift; re-review before applying';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.check_period_open(p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_period record;
BEGIN
  -- KI-19: serialize with close_accounting_period's exclusive month lock before reading.
  PERFORM public._lock_accounting_months(ARRAY[p_date], false);

  SELECT id, period_start, period_end
    INTO v_period
    FROM public.accounting_periods
   WHERE status = 'closed'
     AND p_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Date % falls in closed accounting period (% to %)',
      p_date, v_period.period_start, v_period.period_end;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.allocate_payment(p_customer_id uuid, p_total_cents bigint, p_payment_method text, p_reference_number text DEFAULT NULL::text, p_check_number text DEFAULT NULL::text, p_payment_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_allocations jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_alloc jsonb;
  v_inv record;
  v_alloc_cents bigint;
  v_sum_allocated bigint := 0;
  v_set_id uuid;
  v_current_season integer;
  v_business_date date;
  v_prepay_cents bigint;
  v_result jsonb;
  v_allocation_count integer := 0;
  v_next_version integer;
  v_customer_name text;
  v_idem_request jsonb;
  v_idem_row record;
  v_idem_claim_count integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_idem_request := jsonb_build_object(
      'customer_id', p_customer_id,
      'total_cents', p_total_cents,
      'payment_method', p_payment_method,
      'reference_number', p_reference_number,
      'check_number', p_check_number,
      'payment_date', p_payment_date,
      'notes', p_notes,
      'allocations', p_allocations,
      'performed_by', p_performed_by,
      'authenticated_actor', v_actor
    );

    -- Preserve check_idempotency()'s expiry behavior before claiming the key.
    DELETE FROM idempotency_keys WHERE expires_at < now();

    -- Atomic claim. A concurrent INSERT for this key blocks on the UNIQUE
    -- constraint. If its transaction commits, this INSERT takes the conflict
    -- path; if it rolls back, this INSERT succeeds and owns the claim.
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (
      p_idempotency_key,
      'allocate_payment',
      jsonb_build_object(
        '_contract', 'allocate_payment_v1',
        '_date_intent_version', 1,
        'request', v_idem_request,
        'response', NULL
      )
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    GET DIAGNOSTICS v_idem_claim_count = ROW_COUNT;

    IF v_idem_claim_count = 0 THEN
      SELECT operation, result INTO v_idem_row
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'allocate_payment';

      IF NOT FOUND THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CLAIM_LOST: key % disappeared after conflict', p_idempotency_key;
      END IF;

      IF v_idem_row.operation IS DISTINCT FROM 'allocate_payment' THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
          p_idempotency_key, v_idem_row.operation, 'allocate_payment';
      END IF;

      IF v_idem_row.result->>'_contract' = 'allocate_payment_v1' THEN
        -- Old v1 entries eagerly evaluated the date default and cannot tell
        -- omission from an explicit date. Normalize only those older entries.
        -- New entries mark raw date intent, so explicit-to-omitted changes
        -- reject while unchanged omitted-date retries work across midnight.
        IF p_payment_date IS NULL
           AND NOT (v_idem_row.result ? '_date_intent_version') THEN
          v_idem_request := jsonb_set(v_idem_request, '{payment_date}',
            v_idem_row.result->'request'->'payment_date');
        END IF;
        IF v_idem_row.result->'request' IS DISTINCT FROM v_idem_request THEN
          RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used for different allocate_payment arguments',
            p_idempotency_key;
        END IF;

        v_cached_result := v_idem_row.result->'response';
        IF v_cached_result IS NULL OR v_cached_result = 'null'::jsonb THEN
          RAISE EXCEPTION 'IDEMPOTENCY_RESULT_NOT_READY: key % has no committed allocate_payment result',
            p_idempotency_key;
        END IF;

        RETURN v_cached_result;
      END IF;

      -- Rows written before this migration contain the bare cached response
      -- and no request metadata. Keep their sequential replay behavior.
      IF v_idem_row.result IS NOT NULL THEN
        RETURN v_idem_row.result;
      END IF;

      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_NOT_READY: legacy key % has no cached allocate_payment result',
        p_idempotency_key;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to allocate payments';
  END IF;

  IF p_total_cents <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;

  -- Keep an omitted date as NULL in the request fingerprint. Resolve it only
  -- after replay so retries retain the original result across Chicago midnight.
  v_business_date := (now() AT TIME ZONE 'America/Chicago')::date;
  p_payment_date := COALESCE(p_payment_date, v_business_date);
  -- KI-95: a future-dated payment makes past-date AR aging unrebuildable; compare in Central business days.
  IF p_payment_date > v_business_date THEN
    RAISE EXCEPTION 'PAYMENT_DATE_IN_FUTURE: payment date % is after today (%) in Central time',
      p_payment_date, v_business_date USING ERRCODE = '22023';
  END IF;
  PERFORM check_period_open(p_payment_date);

  SELECT farm_name INTO v_customer_name FROM customers WHERE id = p_customer_id;

  -- Prepay still belongs to the current season, even for an explicit backdate.
  -- Advance that season at Chicago midnight on October 1, never at UTC midnight.
  v_current_season := CASE WHEN extract(month FROM v_business_date) >= 10
    THEN extract(year FROM v_business_date)::integer + 1
    ELSE extract(year FROM v_business_date)::integer END;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
  FROM allocation_sets WHERE entity_type = 'payment' AND entity_id = p_customer_id;

  INSERT INTO allocation_sets (
    entity_type, entity_id, version,
    customer_id, total_payment_cents, payment_method,
    reference_number, check_number, payment_date,
    notes, season, created_by
  ) VALUES (
    'payment', p_customer_id, v_next_version,
    p_customer_id, p_total_cents, p_payment_method,
    p_reference_number, p_check_number, p_payment_date,
    p_notes, v_current_season, v_actor
  ) RETURNING id INTO v_set_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_cents := (v_alloc->>'amount_cents')::bigint;
    IF v_alloc_cents <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM invoices
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND customer_id = p_customer_id
      AND status IN ('posted', 'overdue')
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found or not eligible for payment', (v_alloc->>'invoice_id');
    END IF;

    IF v_alloc_cents > v_inv.balance_cents THEN
      -- round(), not numeric(12,2): an absurd amount must reach this message, not a numeric overflow.
      RAISE EXCEPTION 'Allocation ($%) exceeds balance ($%) on invoice %',
        round(v_alloc_cents / 100.0, 2), round(v_inv.balance_cents / 100.0, 2), v_inv.invoice_number;
    END IF;

    INSERT INTO invoice_line_allocations (
      allocation_set_id, invoice_id, amount_cents,
      bill_to_customer_id, split_percentage
    ) VALUES (
      v_set_id, v_inv.id, v_alloc_cents, p_customer_id, 100
    );

    UPDATE invoices SET
      paid_amount_cents = paid_amount_cents + v_alloc_cents,
      status = CASE
        -- CREDIT-APPLY: include credit_applied_cents in the →paid recompute
        WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents - credit_applied_cents) <= 0
        THEN 'paid'
        ELSE status
      END,
      updated_at = now()
    WHERE id = v_inv.id;

    v_sum_allocated := v_sum_allocated + v_alloc_cents;
    v_allocation_count := v_allocation_count + 1;
  END LOOP;

  IF v_sum_allocated > p_total_cents THEN
    RAISE EXCEPTION 'OVER_ALLOCATED: allocations total $% but payment is only $%',
      (v_sum_allocated / 100.0)::numeric(12,2), (p_total_cents / 100.0)::numeric(12,2);
  END IF;

  UPDATE allocation_sets SET
    total_allocated_cents = v_sum_allocated,
    updated_at = now()
  WHERE id = v_set_id;

  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      source_type, source_reference, allocation_set_id, created_by
    ) VALUES (
      p_customer_id, v_current_season, v_prepay_cents, v_prepay_cents,
      'overpayment', 'From payment ' || COALESCE(p_reference_number, p_check_number, v_set_id::text),
      v_set_id,
      v_actor
    );
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'payment_allocated',
    'Payment of $' || (p_total_cents / 100.0)::text || ' allocated (' || v_allocation_count || ' invoices)',
    v_actor, 'allocation_set', v_set_id, p_customer_id
  );

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_allocated', 'allocation_set', v_set_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'customer_id', p_customer_id,
      'customer_name', v_customer_name,
      'payment_method', p_payment_method,
      'reference_number', p_reference_number,
      'total_cents', p_total_cents,
      'allocated_cents', v_sum_allocated,
      'prepay_cents', v_prepay_cents,
      'invoices_paid', v_allocation_count
    ),
    p_total_cents,
    'Payment $' || (p_total_cents / 100.0)::numeric(12,2) || ' from ' ||
    COALESCE(v_customer_name, 'customer') || ' via ' || p_payment_method ||
    CASE WHEN v_prepay_cents > 0 THEN ' ($' || (v_prepay_cents / 100.0)::numeric(12,2) || ' to prepay)' ELSE '' END
  );

  v_result := jsonb_build_object(
    'success', true,
    'allocation_set_id', v_set_id,
    'total_allocated_cents', v_sum_allocated,
    'prepay_created_cents', v_prepay_cents,
    'invoices_paid', v_allocation_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE idempotency_keys
    SET result = jsonb_build_object(
      '_contract', 'allocate_payment_v1',
      '_date_intent_version', 1,
      'request', v_idem_request,
      'response', v_result
    )
    WHERE idempotency_key = p_idempotency_key
      AND operation = 'allocate_payment';
  END IF;

  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_fn record;
  v_lock_block constant text := E'  -- KI-19: serialize with close_accounting_period''s exclusive month lock before reading.\n  PERFORM public._lock_accounting_months(ARRAY[p_date], false);\n\n';
  v_future_block constant text := E'  -- KI-95: a future-dated payment makes past-date AR aging unrebuildable; compare in Central business days.\n  IF p_payment_date > v_business_date THEN\n    RAISE EXCEPTION ''PAYMENT_DATE_IN_FUTURE: payment date % is after today (%) in Central time'',\n      p_payment_date, v_business_date USING ERRCODE = ''22023'';\n  END IF;\n';
BEGIN
  -- Each new body minus its one inserted block must be byte-identical to the pinned old body.
  SELECT * INTO v_fn FROM pg_proc WHERE oid = 'public.check_period_open(date)'::regprocedure;
  IF position(v_lock_block IN replace(v_fn.prosrc, chr(13), '')) = 0
     OR md5(replace(replace(v_fn.prosrc, chr(13), ''), v_lock_block, '')) <> 'b9be748c47885e7af707c9afc550c316'
     OR pg_get_userbyid(v_fn.proowner) <> 'postgres' OR NOT v_fn.prosecdef
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=""']
     OR v_fn.proacl::text IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'PERIOD_LOCK_POSTFLIGHT: check_period_open body or contract is not the expected one';
  END IF;

  SELECT * INTO v_fn FROM pg_proc WHERE oid = 'public.allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)'::regprocedure;
  IF position(v_future_block IN replace(v_fn.prosrc, chr(13), '')) = 0
     OR md5(replace(replace(v_fn.prosrc, chr(13), ''), v_future_block, '')) <> '324500adf4684d7e0f993304ef58f494'
     OR pg_get_userbyid(v_fn.proowner) <> 'postgres' OR NOT v_fn.prosecdef
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.proacl::text IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'PERIOD_LOCK_POSTFLIGHT: allocate_payment body or contract is not the expected one';
  END IF;

  -- check_period_open now runs the helper as its owner: every money write fails if that right is lost.
  IF NOT has_function_privilege('postgres', 'public._lock_accounting_months(date[],boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PERIOD_LOCK_POSTFLIGHT: postgres lacks EXECUTE on _lock_accounting_months';
  END IF;
  PERFORM public.check_period_open((now() AT TIME ZONE 'America/Chicago')::date);
END;
$postflight$;
