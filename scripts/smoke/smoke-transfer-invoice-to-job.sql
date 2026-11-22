-- ============================================================================
-- SMOKE TEST (rolled back by design): transfer_invoice_to_job (#27 reverse leg)
-- migration 20260625120000_transfer_invoice_to_job.sql.
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260625120000. Proves the inverse of transfer_job_to_invoice:
--
--   ROUND-TRIP   completed job -> transfer_job_to_invoice -> invoice (unposted),
--                job invoiced + invoice_id set + application_records linked + shares;
--                then transfer_invoice_to_job -> invoice cancelled, items+shares gone,
--                application_records.invoice_id cleared, job back to completed +
--                jobs.invoice_id NULL. Re-transfer works (job is reusable).
--   IDEMPOTENCY  calling transfer_invoice_to_job twice with the SAME key mutates
--                once (second call returns the saved result, no second teardown).
--   ACTOR        forged p_performed_by -> ACTOR_MISMATCH, writes nothing.
--   GUARD        a POSTED invoice cannot be reversed (honest error, no mutation).
--   GUARD        a non-job (engine-built) field invoice cannot be reversed.
--   GROUP        a two-owner job bills one invoice per owner (U7, 20260707140000), each
--                with one share to its own owner, and cannot be returned to scheduling
--                from its anchor (JOB_BILLED_AS_GROUP; voiding each owner invoice does
--                that). Rewritten for #2168: this chain used to expect ONE invoice with
--                2 customer shares, the pre-U7 shape.
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8);
  v_cust uuid; v_cust2 uuid; v_prodA uuid; v_field uuid; v_field2 uuid;
  v_job uuid; v_res jsonb; v_inv uuid; v_invR RECORD; v_jobR RECORD;
  v_n int; v_forged uuid := gen_random_uuid();
  v_apprec uuid; v_inv2 uuid; v_posted_job uuid; v_posted_inv uuid;
  v_eng_inv uuid; v_grp_job uuid; v_grp jsonb; v_anchor uuid;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] RT A '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] RT B '||v_sfx) RETURNING id INTO v_cust2;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form, inventory_unit) VALUES ('[SMOKE] RT Prod '||v_sfx,'Gal','999999-99999','liquid', 'Gal') RETURNING id INTO v_prodA;
  -- Governed cost (a bare products insert has none, so billing refuses with COST_BASIS_REQUIRED).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  DECLARE v_pricing jsonb;
  BEGIN
    v_pricing := preview_product_cost_basis_changes('product_page', NULL,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_prodA, 'row_version', (SELECT pricing_version FROM products WHERE id = v_prodA),
        'pricing_mode', 'price_driven', 'new_cost', '1.00',
        'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00',
        'change_reason', '[SMOKE] cost fixture', 'price_source', '[SMOKE]',
        'basis_type', 'manual_override', 'basis_source', 'product_page',
        'basis_reason', '[SMOKE] cost fixture', 'basis_selection', false)),
      v_admin, '[SMOKE] rt-price-preview-'||v_sfx);
    PERFORM approve_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint',
      COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', w->>'product_id', 'warning_codes', w->'warning_codes',
                                                    'reason', '[SMOKE] acknowledged'))
                  FROM jsonb_array_elements(v_pricing->'warnings') AS w), '[]'::jsonb),
      NULL, v_admin, '[SMOKE] rt-price-approve-'||v_sfx);
    PERFORM apply_product_cost_basis_change_set((v_pricing->>'change_set_id')::uuid,
      v_pricing->>'request_fingerprint', v_admin, '[SMOKE] rt-price-apply-'||v_sfx);
  END;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] RT F1 '||v_sfx,'corn') RETURNING id INTO v_field;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] RT F2 '||v_sfx,'corn') RETURNING id INTO v_field2;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- Build a completed single-owner job and transfer it (round trip below).
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] RT JOB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, 50000, 20000, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job, v_field, 100, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_job, v_prodA, 10, 'Gal', 0.5, 'PT', 2000, 5000, 1);
  -- An as-applied legal record on the job (so the reverse must detach it).
  INSERT INTO application_records (record_number, source_type, source_id, customer_id, application_date, created_by)
    VALUES ('[SMOKE] REC-'||v_sfx, 'job', v_job, v_cust, CURRENT_DATE-1, v_admin) RETURNING id INTO v_apprec;
  UPDATE jobs SET status='in_progress' WHERE id=v_job; UPDATE jobs SET status='completed' WHERE id=v_job;

  v_res := transfer_job_to_invoice(v_job, v_admin, 'SMOKE-rt-fwd-'||v_sfx);
  v_inv := (v_res->>'invoice_id')::uuid;
  SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT * INTO v_jobR FROM jobs WHERE id=v_job;
  IF v_jobR.status<>'invoiced' OR v_jobR.invoice_id<>v_inv THEN RAISE EXCEPTION 'SMOKE_FAIL: fwd job not invoiced/linked (% / %)', v_jobR.status, v_jobR.invoice_id; END IF;
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id=v_inv; IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected 1 customer share, got %', v_n; END IF;
  IF v_invR.customer_id<>v_cust OR v_invR.invoice_group_id IS NOT NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: single-owner invoice not billed alone to its owner'; END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv; IF v_n<1 THEN RAISE EXCEPTION 'SMOKE_FAIL: no invoice items after fwd'; END IF;
  SELECT invoice_id INTO v_inv2 FROM application_records WHERE id=v_apprec; IF v_inv2 IS DISTINCT FROM v_inv THEN RAISE EXCEPTION 'SMOKE_FAIL: app record not linked to invoice'; END IF;

  -- Forged actor must be rejected (no mutation).
  BEGIN
    PERFORM transfer_invoice_to_job(v_inv, v_forged, '[SMOKE] rt-forged-'||v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: forged actor allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH got %', SQLERRM; END IF;
  END;
  -- ...and the invoice/job are untouched by the rejected call.
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv;
  IF v_invR.status<>'unposted' THEN RAISE EXCEPTION 'SMOKE_FAIL: invoice changed by forged call'; END IF;

  -- The reverse (idempotency key X).
  v_res := transfer_invoice_to_job(v_inv, v_admin, '[SMOKE] rt-rev-'||v_sfx);
  IF (v_res->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE_FAIL: reverse did not succeed'; END IF;
  SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT * INTO v_jobR FROM jobs WHERE id=v_job;
  IF v_invR.status<>'cancelled' THEN RAISE EXCEPTION 'SMOKE_FAIL: invoice not cancelled (%)', v_invR.status; END IF;
  IF v_invR.total_amount_cents<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: cancelled invoice total not zeroed (%)', v_invR.total_amount_cents; END IF;
  -- P3 remediation: the internal COGS header is zeroed too, so a cancelled, line-less
  -- invoice never keeps a stale forward cost total on its PDF.
  IF v_invR.total_cost_cents<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: cancelled invoice total_cost_cents not zeroed (%)', v_invR.total_cost_cents; END IF;
  IF v_jobR.status<>'completed' THEN RAISE EXCEPTION 'SMOKE_FAIL: job not returned to completed (%)', v_jobR.status; END IF;
  IF v_jobR.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: job.invoice_id not cleared'; END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv; IF v_n<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: invoice_items not deleted (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id=v_inv; IF v_n<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: invoice_shares not deleted (%)', v_n; END IF;
  SELECT invoice_id INTO v_inv2 FROM application_records WHERE id=v_apprec; IF v_inv2 IS NOT NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: app record invoice_id not cleared'; END IF;
  -- An invoice_cancelled audit row exists for this invoice.
  PERFORM 1 FROM financial_audit_log WHERE entity_id=v_inv AND operation_type='invoice_cancelled';
  IF NOT FOUND THEN RAISE EXCEPTION 'SMOKE_FAIL: no invoice_cancelled audit row'; END IF;

  -- Idempotent replay: same key -> returns saved result, NO second mutation (the job is
  -- already 'completed' so a second real reverse would error; the saved result returns instead).
  v_res := transfer_invoice_to_job(v_inv, v_admin, '[SMOKE] rt-rev-'||v_sfx);
  IF (v_res->>'job_status')<>'completed' THEN RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay wrong result'; END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log WHERE entity_id=v_inv AND operation_type='invoice_cancelled';
  IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay wrote a 2nd audit row (%)', v_n; END IF;

  -- The job is reusable: re-transfer the now-completed job to a NEW invoice.
  v_res := transfer_job_to_invoice(v_job, v_admin, 'SMOKE-rt-fwd2-'||v_sfx);
  v_inv2 := (v_res->>'invoice_id')::uuid;
  IF v_inv2 = v_inv THEN RAISE EXCEPTION 'SMOKE_FAIL: re-transfer reused cancelled invoice id'; END IF;
  SELECT status INTO v_jobR.status FROM jobs WHERE id=v_job;
  IF v_jobR.status<>'invoiced' THEN RAISE EXCEPTION 'SMOKE_FAIL: re-transfer did not re-invoice the job'; END IF;

  -- GUARD: a POSTED invoice cannot be reversed.
  -- Post the freshly re-transferred invoice, then attempt the reverse -> honest error.
  PERFORM post_invoice(v_inv2, public._invoice_post_version(v_inv2), '[SMOKE] rt-post-'||v_sfx);
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv2;
  IF v_invR.status<>'posted' THEN RAISE EXCEPTION 'SMOKE_FAIL: post_invoice did not post (%)', v_invR.status; END IF;
  BEGIN
    PERFORM transfer_invoice_to_job(v_inv2, v_admin, '[SMOKE] rt-posted-'||v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: reversed a POSTED invoice';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'Only a draft or unposted invoice%' THEN RAISE EXCEPTION 'SMOKE_FAIL: posted-guard wrong error: %', SQLERRM; END IF;
  END;

  -- GUARD: an engine-built field invoice (no job_id) cannot be reversed.
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('[SMOKE] RT-ENG-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, 0, v_admin) RETURNING id INTO v_eng_inv;
  BEGIN
    PERFORM transfer_invoice_to_job(v_eng_inv, v_admin, '[SMOKE] rt-eng-'||v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: reversed a non-job field invoice';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%not created from a job%' THEN RAISE EXCEPTION 'SMOKE_FAIL: no-job-guard wrong error: %', SQLERRM; END IF;
  END;

  -- GROUP: a two-owner (60/40) job bills one invoice per owner and refuses the reverse.
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] RT GRP-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, 50000, 20000, v_admin) RETURNING id INTO v_grp_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_grp_job, v_field2, 100, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_grp_job, v_prodA, 10, 'Gal', 0.5, 'PT', 2000, 5000, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_grp_job; UPDATE jobs SET status='completed' WHERE id=v_grp_job;
  v_grp := transfer_job_to_invoice(v_grp_job, v_admin, 'SMOKE-rt-grp-'||v_sfx);
  v_anchor := (v_grp->>'invoice_id')::uuid;
  IF jsonb_array_length(v_grp->'invoice_ids') <> 2 OR v_grp->>'invoice_group_id' IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: two-owner job did not bill one invoice per owner (%)', v_grp; END IF;
  SELECT count(*) INTO v_n FROM invoices i
   WHERE i.invoice_group_id = (v_grp->>'invoice_group_id')::uuid AND i.status = 'unposted'
     AND (SELECT count(*) FROM invoice_shares x WHERE x.invoice_id = i.id) = 1
     AND (SELECT x.customer_id FROM invoice_shares x WHERE x.invoice_id = i.id) = i.customer_id;
  -- The group holds exactly those two invoices, nothing else.
  IF v_n <> 2 OR (SELECT count(*) FROM invoices WHERE invoice_group_id = (v_grp->>'invoice_group_id')::uuid) <> 2
     OR (SELECT count(DISTINCT customer_id) FROM invoices WHERE invoice_group_id = (v_grp->>'invoice_group_id')::uuid
                    AND customer_id IN (v_cust, v_cust2)) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: each owner should get one unposted invoice with one share to itself (% matched)', v_n; END IF;
  IF (SELECT invoice_id FROM jobs WHERE id=v_grp_job AND status='invoiced') IS DISTINCT FROM v_anchor THEN
    RAISE EXCEPTION 'SMOKE_FAIL: group job not invoiced to its anchor'; END IF;
  BEGIN
    PERFORM transfer_invoice_to_job(v_anchor, v_admin, '[SMOKE] rt-grp-rev-'||v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: returned a multi-owner group to scheduling';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'JOB_BILLED_AS_GROUP%' THEN RAISE EXCEPTION 'SMOKE_FAIL: group-guard wrong error: %', SQLERRM; END IF;
  END;
  IF (SELECT status FROM jobs WHERE id=v_grp_job) <> 'invoiced'
     OR (SELECT count(*) FROM invoices WHERE invoice_group_id = (v_grp->>'invoice_group_id')::uuid AND status='unposted') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the refused group reverse changed the job or its invoices'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
