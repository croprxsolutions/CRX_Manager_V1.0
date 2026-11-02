-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261102180000_bind_money_replay_receipts_batch4a.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-money-replay-binding-batch4a-real-schema.mjs,
-- never against the live database. The fixtures post invoices and transfer jobs to invoices, which
-- draw customer-visible document numbers from non-transactional sequences that a rollback does not
-- return; the container prover reports which sequences this chain moves. The chain also plants
-- [SMOKE] customers, products, jobs, orders, invoices, accounting periods and rebate claims.
--
-- Rule under test: unpost_invoice, unpost_invoice_group, close_accounting_period,
-- reopen_accounting_period, transfer_invoice_to_job, save_field_app_invoice,
-- update_field_app_invoice_billing, consolidate_draft_invoices, update_blend_ticket_billing_status,
-- create_rebate_claim and transition_rebate_claim replay a stored idempotency receipt only to the
-- person who wrote it, and only for the exact same request. A key reused for a different record or
-- different values is refused (IDEMPOTENCY_INTENT_MISMATCH) and changes nothing; a different admin
-- presenting the key is refused (IDEMPOTENCY_ACTOR_MISMATCH); an exact retry still returns the
-- original answer; a call with no key is refused (IDEMPOTENCY_KEY_REQUIRED, 22023); unpost_invoice
-- checks the caller's role before any stored result is returned. unpost_invoice_group still unposts
-- every member through unpost_invoice's body with no per-member key. Every fresh receipt is bound to
-- the actor with a 64-hex fingerprint.
--
-- Fail-first: before the migration step a fails (unpost_invoice hands invoice A's receipt back as
-- success for invoice B).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
--
-- Auth: auth.uid() reads request.jwt.claims, set with set_config(..., true) to two REAL active admin
-- profiles and one REAL active applicator found at run time (SMOKE_SETUP if any is missing). Fixture
-- INSERTs run as the table owner; the RPCs under test enforce their own role checks.
-- Precondition: today is not inside a CLOSED accounting period, and 1990-05/1990-06 hold no period.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_admin_b uuid;
  v_applicator uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_key text;
  v_year int := EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int;
  v_customer uuid;
  v_customer_b uuid;
  v_product uuid;
  v_field uuid;
  v_inv uuid[] := ARRAY[]::uuid[];      -- a: 1 A, 2 B (posted)
  v_grp uuid[] := ARRAY[]::uuid[];
  v_split_field uuid;
  v_pricing jsonb;
  v_period uuid[] := ARRAY[]::uuid[];
  v_job uuid[] := ARRAY[]::uuid[];
  v_job_inv uuid[] := ARRAY[]::uuid[];
  v_order uuid[] := ARRAY[]::uuid[];
  v_ticket uuid[] := ARRAY[]::uuid[];
  v_claim uuid[] := ARRAY[]::uuid[];
  v_program uuid;
  v_locations jsonb;
  v_chemicals jsonb;
  v_fa_inv uuid;
  v_id uuid;
  v_i int;
  v_res jsonb;
  v_res2 jsonb;
  v_n int;
  v_status text;
  v_detail text;
BEGIN
  -- --------------------------------------------------------------------------------------------
  -- 0. Preconditions, two real admins and an applicator, fixtures.
  -- --------------------------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.accounting_periods
              WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: today falls in a CLOSED accounting period';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_periods
              WHERE period_start <= DATE '1990-06-30' AND period_end >= DATE '1990-05-01') THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the fixed pre-history months 1990-05/1990-06 are occupied';
  END IF;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_admin_b FROM public.profiles
   WHERE role = 'admin' AND is_active = true AND id IS DISTINCT FROM v_admin ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_applicator FROM public.profiles
   WHERE role = 'applicator' AND is_active = true ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_admin_b IS NULL OR v_applicator IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two active admin profiles and one active applicator are required';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_prefix := 'smk-mrb4a-' || v_suffix || '-';

  INSERT INTO public.customers (farm_name, account_number, assigned_tier)
  VALUES ('[SMOKE] Money Replay Farm ' || v_suffix, '[SMOKE]-MRB4A-' || v_suffix, 1)
  RETURNING id INTO v_customer;
  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] Money Replay Farm B ' || v_suffix, '[SMOKE]-MRB4A-B-' || v_suffix)
  RETURNING id INTO v_customer_b;
  -- A pricing-free shell (pricing goes only through the governed path); every line sets its price.
  INSERT INTO public.products (product_name, unit_size, product_form)
  VALUES ('[SMOKE] Money Replay Product ' || v_suffix, 'GL', 'liquid')
  RETURNING id INTO v_product;
  -- Its cost and tier prices go through the governed preview -> approve -> apply path.
  v_pricing := public.preview_product_cost_basis_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', (SELECT pricing_version FROM public.products WHERE id = v_product),
      'pricing_mode', 'price_driven', 'new_cost', '1.00',
      'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00',
      'change_reason', '[SMOKE] MRB4A cost fixture', 'price_source', '[SMOKE] MRB4A',
      'basis_type', 'manual_override', 'basis_source', 'product_page',
      'basis_reason', '[SMOKE] MRB4A cost fixture', 'basis_selection', false)),
    v_admin, v_prefix || 'price-preview');
  IF (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed cost preview refused: %', v_pricing;
  END IF;
  PERFORM public.approve_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint',
    COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', w->>'product_id', 'warning_codes', w->'warning_codes',
                                                  'reason', '[SMOKE] acknowledged'))
                FROM jsonb_array_elements(v_pricing->'warnings') AS w), '[]'::jsonb),
    NULL, v_admin, v_prefix || 'price-approve');
  PERFORM public.apply_product_cost_basis_change_set((v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint', v_admin, v_prefix || 'price-apply');
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[SMOKE] MRB4A Field ' || v_suffix, 'corn', 40)
  RETURNING id INTO v_field;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_field, v_customer, 100, true);

  -- Two posted invoices (a) and two posted two-member groups (b).
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('[SMOKE] MRB4A-INV-' || v_i || '-' || v_suffix, v_customer, 'field_application', 'draft', CURRENT_DATE, 10000 * v_i, v_admin)
    RETURNING id INTO v_id;
    PERFORM public.post_invoice(v_id, public._invoice_post_version(v_id), v_prefix || 'post-' || v_i);
    v_inv := v_inv || v_id;
  END LOOP;
  -- Posted split groups come only from the real split save, posted through post_invoice_group.
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[SMOKE] MRB4A Split Field ' || v_suffix, 'corn', 40)
  RETURNING id INTO v_split_field;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_split_field, v_customer, 50, true), (v_split_field, v_customer_b, 50, false);
  FOR v_i IN 1..2 LOOP
    v_res := public.save_field_app_invoice(NULL,
      jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] MRB4A group ' || v_i),
      jsonb_build_array(jsonb_build_object(
        'field_id', v_split_field, 'map_number', 1, 'total_acres', 40, 'planted_acres', NULL,
        'applied_acres', 40, 'crop_type', NULL, 'wind_direction', NULL, 'sort_order', 0)),
      jsonb_build_array(jsonb_build_object(
        'product_id', v_product, 'description', '[SMOKE] MRB4A Group Chem', 'quantity', 0, 'unit_size', 'GL',
        'unit_price_cents', 1000 * v_i, 'cost_cents', 100, 'sort_order', 0, 'rate_per_acre', 0.1,
        'rate_unit', 'GL', 'manual_override', true)),
      v_admin, NULL, v_prefix || 'grp-save-' || v_i);
    v_id := (v_res->>'invoice_group_id')::uuid;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'SMOKE_SETUP: the split save made no invoice group: %', v_res;
    END IF;
    PERFORM public.post_invoice_group(v_id, v_admin,
      (SELECT jsonb_object_agg(i.id, public._invoice_post_version(i.id)) FROM public.invoices i
        WHERE i.invoice_group_id = v_id AND i.deleted_at IS NULL),
      v_prefix || 'grp-post-' || v_i);
    v_grp := v_grp || v_id;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.invoices
   WHERE (id = ANY(v_inv) OR invoice_group_id = ANY(v_grp)) AND status = 'posted';
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: expected 6 posted fixture invoices, found %', v_n;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- a. unpost_invoice: a key reused for a DIFFERENT invoice is refused; B stays posted.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'unpost';
  v_res := public.unpost_invoice(v_inv[1], v_admin, v_key);
  IF (SELECT status FROM public.invoices WHERE id = v_inv[1]) IS DISTINCT FROM 'unposted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice on invoice A did not unpost it: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.unpost_invoice(v_inv[2], v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice replayed invoice A''s receipt as success for invoice B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unpost_invoice refusal for invoice B: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.invoices WHERE id = v_inv[2]) IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice B changed after a refused unpost_invoice';
  END IF;

  -- The exact retry of A returns the identical result; one unpost audit row.
  v_res2 := public.unpost_invoice(v_inv[1], v_admin, v_key);
  SELECT count(*) INTO v_n FROM public.financial_audit_log
   WHERE entity_id = v_inv[1] AND operation_type = 'invoice_unposted';
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact unpost_invoice retry did not replay once (% audit rows): % vs %', v_n, v_res2, v_res;
  END IF;

  -- The same person, after losing the role, retrying their own exact request is stopped by the
  -- role check and is not handed the stored result.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  UPDATE public.profiles SET role = 'applicator' WHERE id = v_admin;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    v_res2 := public.unpost_invoice(v_inv[1], v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice handed a stored result to its author after they lost the role: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'Not authorized: requires admin,sales_rep role' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong demoted-author unpost_invoice refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  UPDATE public.profiles SET role = 'admin' WHERE id = v_admin;

  -- A different admin presenting the key is refused and shown nothing.
  BEGIN
    v_res2 := public.unpost_invoice(v_inv[1], v_admin_b, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice replayed another admin''s receipt: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong other-admin unpost_invoice refusal: %', SQLERRM;
    END IF;
    IF COALESCE(v_detail, '') LIKE '%' || v_inv[1]::text || '%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the other-admin refusal disclosed the stored result: %', v_detail;
    END IF;
  END;

  -- An applicator presenting the admin's key is stopped by the role check.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_applicator::text, true);
  BEGIN
    v_res2 := public.unpost_invoice(v_inv[1], v_applicator, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice handed an admin''s stored result to an applicator: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'Not authorized: requires admin,sales_rep role' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong applicator unpost_invoice refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  BEGIN
    v_res2 := public.unpost_invoice(v_inv[2], v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' OR SQLSTATE <> '22023' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless unpost_invoice refusal: % (%)', SQLERRM, SQLSTATE;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- b. unpost_invoice_group: unposts every member through the renamed unpost_invoice body (no
  --    per-member key); the key reused for group 2 is refused; an exact retry replays.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'unpost-group';
  BEGIN
    v_res := public.unpost_invoice_group(v_grp[1], v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice_group could not unpost through unpost_invoice: %', SQLERRM;
  END;
  SELECT count(*) INTO v_n FROM public.invoices WHERE invoice_group_id = v_grp[1] AND status = 'unposted';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice_group unposted % of 2 members: %', v_n, v_res;
  END IF;
  BEGIN
    v_res2 := public.unpost_invoice_group(v_grp[2], v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice_group replayed group 1''s receipt as success for group 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unpost_invoice_group refusal for group 2: %', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.invoices WHERE invoice_group_id = v_grp[2] AND status = 'posted';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: group 2 changed after a refused unpost_invoice_group (% posted)', v_n;
  END IF;
  v_res2 := public.unpost_invoice_group(v_grp[1], v_admin, v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact unpost_invoice_group retry did not replay: % vs %', v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.unpost_invoice_group(v_grp[2], v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: unpost_invoice_group ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless unpost_invoice_group refusal: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- c. close_accounting_period: the key reused for a different month is refused.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'close';
  v_res := public.close_accounting_period(DATE '1990-05-31', v_admin, v_key);
  BEGIN
    v_res2 := public.close_accounting_period(DATE '1990-06-30', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: close_accounting_period replayed May''s receipt as success for June: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong close_accounting_period refusal for June: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.accounting_periods WHERE period_start = DATE '1990-06-01') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: June changed after a refused close_accounting_period';
  END IF;
  v_res2 := public.close_accounting_period(DATE '1990-05-31', v_admin, v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact close_accounting_period retry did not replay: % vs %', v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.close_accounting_period(DATE '1990-06-30', v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: close_accounting_period ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless close_accounting_period refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM public.close_accounting_period(DATE '1990-06-30', v_admin, v_prefix || 'close-june');
  SELECT array_agg(id ORDER BY period_start) INTO v_period
    FROM public.accounting_periods
   WHERE period_start IN (DATE '1990-05-01', DATE '1990-06-01') AND status = 'closed';
  IF coalesce(array_length(v_period, 1), 0) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: May and June 1990 are not both closed';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- d. reopen_accounting_period: the key reused for a different period, or an edited reason, is
  --    refused.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'reopen';
  v_res := public.reopen_accounting_period(v_period[1], '[SMOKE] correction', v_admin, v_key);
  BEGIN
    v_res2 := public.reopen_accounting_period(v_period[2], '[SMOKE] correction', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: reopen_accounting_period replayed May''s receipt as success for June: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reopen_accounting_period refusal for June: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.accounting_periods WHERE id = v_period[2];
  IF v_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: June is % after a refused reopen_accounting_period', v_status;
  END IF;
  BEGIN
    v_res2 := public.reopen_accounting_period(v_period[1], '[SMOKE] other reason', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: reopen_accounting_period replayed a receipt for an edited reason: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-reason reopen_accounting_period refusal: %', SQLERRM;
    END IF;
  END;
  v_res2 := public.reopen_accounting_period(v_period[1], '[SMOKE] correction', v_admin, v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact reopen_accounting_period retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- e. transfer_invoice_to_job: the key reused for a different job invoice is refused.
  -- --------------------------------------------------------------------------------------------
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.jobs (job_number, customer_id, status, job_date, season, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] MRB4A JOB-' || v_i || '-' || v_suffix, v_customer, 'scheduled', CURRENT_DATE - 3, v_year, 20000, 8000, v_admin)
    RETURNING id INTO v_id;
    INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_id, v_field, 40, 1);
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_id, v_product, 4, 'GL', 0.1, 'GL', 2000, 5000, 1);
    UPDATE public.jobs SET status = 'in_progress' WHERE id = v_id;
    UPDATE public.jobs SET status = 'completed' WHERE id = v_id;
    v_res := public.transfer_job_to_invoice(v_id, v_admin, v_prefix || 'job-fwd-' || v_i);
    v_job := v_job || v_id;
    v_job_inv := v_job_inv || (v_res->>'invoice_id')::uuid;
  END LOOP;
  v_key := v_prefix || 'transfer-back';
  v_res := public.transfer_invoice_to_job(v_job_inv[1], v_admin, v_key);
  BEGIN
    v_res2 := public.transfer_invoice_to_job(v_job_inv[2], v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: transfer_invoice_to_job replayed job 1''s receipt as success for job 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong transfer_invoice_to_job refusal for job 2: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.jobs WHERE id = v_job[2];
  IF v_status IS DISTINCT FROM 'invoiced' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: job 2 is % after a refused transfer_invoice_to_job', v_status;
  END IF;
  v_res2 := public.transfer_invoice_to_job(v_job_inv[1], v_admin, v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact transfer_invoice_to_job retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- f. save_field_app_invoice: the key reused with edited invoice values is refused.
  -- --------------------------------------------------------------------------------------------
  v_locations := jsonb_build_array(jsonb_build_object(
    'field_id', v_field, 'map_number', 1, 'total_acres', 40, 'planted_acres', NULL,
    'applied_acres', 40, 'crop_type', NULL, 'wind_direction', NULL, 'sort_order', 0));
  v_chemicals := jsonb_build_array(jsonb_build_object(
    'product_id', v_product, 'description', '[SMOKE] MRB4A Chem', 'quantity', 0, 'unit_size', 'GL',
    'unit_price_cents', NULL, 'cost_cents', 0, 'sort_order', 0, 'rate_per_acre', 0.1, 'rate_unit', 'GL',
    'manual_override', false));
  v_key := v_prefix || 'fa-save';
  v_res := public.save_field_app_invoice(NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] first'),
    v_locations, v_chemicals, v_admin, NULL, v_key);
  v_fa_inv := ((v_res->'invoice_ids')->>0)::uuid;
  IF v_fa_inv IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field_app_invoice did not create an invoice: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.save_field_app_invoice(NULL,
      jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] edited'),
      v_locations, v_chemicals, v_admin, NULL, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: save_field_app_invoice replayed a receipt for edited invoice values: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-values save_field_app_invoice refusal: %', SQLERRM;
    END IF;
    -- The app reads the committed result from DETAIL to recover the invoice id.
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF COALESCE(v_detail, '') NOT LIKE '%' || v_fa_inv::text || '%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the save_field_app_invoice mismatch did not carry the committed invoice: %', v_detail;
    END IF;
  END;
  SELECT header_notes INTO v_status FROM public.invoices WHERE id = v_fa_inv;
  IF v_status IS DISTINCT FROM '[SMOKE] first' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the field invoice header changed to % after a refused save', v_status;
  END IF;
  v_res2 := public.save_field_app_invoice(NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] first'),
    v_locations, v_chemicals, v_admin, NULL, v_key);
  SELECT count(*) INTO v_n FROM public.invoices WHERE customer_id = v_customer AND header_notes = '[SMOKE] first';
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact save_field_app_invoice retry did not replay once (% invoices): % vs %', v_n, v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- g. update_field_app_invoice_billing: the key reused with an edited PO number is refused.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'fa-billing';
  v_res := public.update_field_app_invoice_billing(
    p_invoice_ids => ARRAY[v_fa_inv], p_purchase_order_ref => '[SMOKE] PO-1',
    p_performed_by => v_admin, p_idempotency_key => v_key);
  BEGIN
    v_res2 := public.update_field_app_invoice_billing(
      p_invoice_ids => ARRAY[v_fa_inv], p_purchase_order_ref => '[SMOKE] PO-2',
      p_performed_by => v_admin, p_idempotency_key => v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: update_field_app_invoice_billing replayed a receipt for an edited PO: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-PO update_field_app_invoice_billing refusal: %', SQLERRM;
    END IF;
  END;
  SELECT purchase_order_ref INTO v_status FROM public.invoices WHERE id = v_fa_inv;
  IF v_status IS DISTINCT FROM '[SMOKE] PO-1' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the PO number is % after a refused billing update', v_status;
  END IF;
  v_res2 := public.update_field_app_invoice_billing(
    p_invoice_ids => ARRAY[v_fa_inv], p_purchase_order_ref => '[SMOKE] PO-1',
    p_performed_by => v_admin, p_idempotency_key => v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact update_field_app_invoice_billing retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- h. consolidate_draft_invoices: the key reused for a different order is refused.
  -- --------------------------------------------------------------------------------------------
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
    VALUES ('[SMOKE] MRB4A-ORD-' || v_i || '-' || v_suffix, v_customer, 'confirmed', false)
    RETURNING id INTO v_id;
    v_order := v_order || v_id;
    INSERT INTO public.invoices (invoice_number, customer_id, status, invoice_date, total_amount_cents, created_by, order_id)
    VALUES ('[SMOKE] MRB4A-OD-' || v_i || 'a-' || v_suffix, v_customer, 'draft', CURRENT_DATE, 0, v_admin, v_id),
           ('[SMOKE] MRB4A-OD-' || v_i || 'b-' || v_suffix, v_customer, 'draft', CURRENT_DATE, 0, v_admin, v_id);
  END LOOP;
  v_key := v_prefix || 'consolidate';
  v_res := public.consolidate_draft_invoices(v_order[1], v_admin, v_key);
  BEGIN
    v_res2 := public.consolidate_draft_invoices(v_order[2], v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: consolidate_draft_invoices replayed order 1''s receipt as success for order 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong consolidate_draft_invoices refusal for order 2: %', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.invoices WHERE order_id = v_order[2] AND status = 'draft';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order 2 has % drafts after a refused consolidate_draft_invoices', v_n;
  END IF;
  v_res2 := public.consolidate_draft_invoices(v_order[1], v_admin, v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact consolidate_draft_invoices retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- i. update_blend_ticket_billing_status: the key reused for a different ticket or status is
  --    refused.
  -- --------------------------------------------------------------------------------------------
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, status, review_status,
                                      payment_status, order_link_status, season, total_acres, source)
    VALUES ('[SMOKE]-MRB4A-BT-' || v_i || '-' || v_suffix, v_admin, v_customer,
            'completed', 'approved', 'unbilled', 'unlinked', public.current_season(), 10, 'manual')
    RETURNING id INTO v_id;
    v_ticket := v_ticket || v_id;
  END LOOP;
  v_key := v_prefix || 'blend-billing';
  v_res := public.update_blend_ticket_billing_status(v_ticket[1], 'unbilled', v_admin, v_key)::jsonb;
  IF (v_res->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: update_blend_ticket_billing_status fixture failed: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.update_blend_ticket_billing_status(v_ticket[2], 'unbilled', v_admin, v_key)::jsonb;
    RAISE EXCEPTION 'SMOKE_FAIL: update_blend_ticket_billing_status replayed ticket 1''s receipt as success for ticket 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong update_blend_ticket_billing_status refusal for ticket 2: %', SQLERRM;
    END IF;
  END;
  BEGIN
    v_res2 := public.update_blend_ticket_billing_status(v_ticket[1], 'paid', v_admin, v_key)::jsonb;
    RAISE EXCEPTION 'SMOKE_FAIL: update_blend_ticket_billing_status replayed a receipt for an edited status: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-status update_blend_ticket_billing_status refusal: %', SQLERRM;
    END IF;
  END;
  v_res2 := public.update_blend_ticket_billing_status(v_ticket[1], 'unbilled', v_admin, v_key)::jsonb;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact update_blend_ticket_billing_status retry did not replay: % vs %', v_res2, v_res;
  END IF;
  -- A {success: false} answer stores no receipt and so binds none (and commits).
  v_res2 := public.update_blend_ticket_billing_status(gen_random_uuid(), 'unbilled', v_admin, v_prefix || 'blend-missing')::jsonb;
  IF (v_res2->>'success')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a missing blend ticket did not answer success false: %', v_res2;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- j. create_rebate_claim: the key reused with an edited quantity is refused.
  -- --------------------------------------------------------------------------------------------
  INSERT INTO public.rebate_programs (program_name, manufacturer, season, start_date, end_date)
  VALUES ('[SMOKE] MRB4A program ' || v_suffix, '[SMOKE]', v_year, make_date(v_year, 1, 1), make_date(v_year, 12, 31))
  RETURNING id INTO v_program;
  v_key := v_prefix || 'rebate-create';
  v_res := public.create_rebate_claim(v_program, 2, 1500, p_idempotency_key => v_key);
  BEGIN
    v_res2 := public.create_rebate_claim(v_program, 3, 1500, p_idempotency_key => v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: create_rebate_claim replayed a receipt for an edited quantity: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-quantity create_rebate_claim refusal: %', SQLERRM;
    END IF;
  END;
  v_res2 := public.create_rebate_claim(v_program, 2, 1500, p_idempotency_key => v_key);
  SELECT count(*) INTO v_n FROM public.rebate_claims WHERE program_id = v_program;
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_rebate_claim retry did not replay once (% claims): % vs %', v_n, v_res2, v_res;
  END IF;
  v_claim := v_claim || (v_res->>'claim_id')::uuid;
  v_res := public.create_rebate_claim(v_program, 1, 700, p_idempotency_key => v_prefix || 'rebate-create-2');
  v_claim := v_claim || (v_res->>'claim_id')::uuid;

  -- --------------------------------------------------------------------------------------------
  -- k. transition_rebate_claim: the key reused for a different claim is refused.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'rebate-transition';
  v_res := public.transition_rebate_claim(v_claim[1], 'submitted', p_idempotency_key => v_key);
  BEGIN
    v_res2 := public.transition_rebate_claim(v_claim[2], 'submitted', p_idempotency_key => v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: transition_rebate_claim replayed claim 1''s receipt as success for claim 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong transition_rebate_claim refusal for claim 2: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.rebate_claims WHERE id = v_claim[2];
  IF v_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: claim 2 is % after a refused transition_rebate_claim', v_status;
  END IF;
  v_res2 := public.transition_rebate_claim(v_claim[1], 'submitted', p_idempotency_key => v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact transition_rebate_claim retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- l. Every fresh receipt for the eleven operations is bound to its actor with a 64-hex fingerprint.
  -- --------------------------------------------------------------------------------------------
  SELECT count(*) FILTER (WHERE request_actor_id IS DISTINCT FROM v_admin
                             OR request_fingerprint IS NULL OR request_fingerprint !~ '^[0-9a-f]{64}$'),
         count(DISTINCT operation)
    INTO v_n, v_i
    FROM public.idempotency_keys
   WHERE idempotency_key LIKE v_prefix || '%'
     AND operation IN ('unpost_invoice', 'unpost_invoice_group', 'close_accounting_period',
                       'reopen_accounting_period', 'transfer_invoice_to_job', 'save_field_app_invoice',
                       'update_field_app_invoice_billing', 'consolidate_draft_invoices',
                       'update_blend_ticket_billing_status', 'create_rebate_claim', 'transition_rebate_claim');
  IF v_n <> 0 OR v_i <> 11 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % batch 4a receipts are unbound (operations with receipts: % of 11)', v_n, v_i;
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
