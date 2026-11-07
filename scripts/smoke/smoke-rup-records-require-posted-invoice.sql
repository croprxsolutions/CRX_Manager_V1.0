-- ============================================================================
-- SMOKE TEST (rolled back by design): generate_rup_sales_records requires a
-- posted invoice (KI-05, migration 20261110140000).
-- ----------------------------------------------------------------------------
-- Run AFTER the migration is applied; before it, S1 FAILs (the draft is let
-- through).
--   S0  the live body carries RUP_INVOICE_NOT_POSTED; grants unchanged.
--   S1  an active admin, AS ROLE authenticated, calls it on the [SMOKE]
--       draft invoice (left by complete_delivery) with one RUP line -> RUP_INVOICE_NOT_POSTED,
--       and no register row or idempotency receipt is written.
--   S1b the same admin's direct INSERT into rup_sales_records for the draft
--       is refused by the table trigger with RUP_INVOICE_NOT_POSTED.
--   S2  post_invoice AS ROLE authenticated (the real path) posts the same
--       invoice and writes exactly 1 compliant register row.
--   S3  a direct call on the now-posted invoice returns 0 (dedup), proving a
--       posted invoice is let through.
-- Execute the whole file as ONE statement as postgres. Error text
-- SMOKE_PASS_ROLLBACK = PASS (nothing persisted); any other error = FAIL.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_pricing  jsonb;
  v_line     uuid;
  v_delivery uuid;
  v_ditem    uuid;
  v_order    uuid;
  v_invoice  uuid;
  v_version  text;
  v_lic_num  text;
  v_n        int;
  v_status   text;
  v_grants   text;
  v_row      record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM accounting_periods
    WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: CURRENT_DATE falls in a CLOSED accounting period - post_invoice cannot run today';
  END IF;

  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- S0. Migration present; grants unchanged.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.generate_rup_sales_records(uuid,text)'::regprocedure
      AND prosrc LIKE '%RUP_INVOICE_NOT_POSTED%'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S0 generate_rup_sales_records has no RUP_INVOICE_NOT_POSTED check - migration 20261110140000 not applied';
  END IF;
  SELECT string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text)
  INTO v_grants
  FROM pg_proc p, aclexplode(p.proacl) a
  WHERE p.oid = 'public.generate_rup_sales_records(uuid,text)'::regprocedure;
  IF v_grants IS DISTINCT FROM 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S0 grants changed: %', v_grants;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.rup_sales_records'::regclass
      AND tgname = 'trg_rup_sales_record_posted_invoice' AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S0 the rup_sales_records posted-invoice trigger is missing or disabled';
  END IF;

  -- Fixtures, built the real way: a [SMOKE] RUP product priced through the governed path, an order
  -- and an in-progress delivery, then complete_delivery, which leaves the real draft invoice.
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] RUP Posted Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO products (product_name, unit_size, is_rup, epa_registration, signal_word, product_form)
  VALUES ('[SMOKE] RUP Product ' || v_suffix, 'GL', true, '999999-99999', 'Warning', 'liquid')
  RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, 'smoke-rupp-pricing-preview-' || v_suffix);
  PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint',
    v_admin, 'smoke-rupp-pricing-apply-' || v_suffix);
  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 0, 'GL');

  v_lic_num := 'SMK-LIC-' || v_suffix;
  -- issued_date is required for 'compliant': a license with no issue date on file is a warning (KI-18 batch 1).
  INSERT INTO applicator_licenses (customer_id, license_number, license_type, holder_name, issued_date, expiry_date, is_active)
  VALUES (v_customer, v_lic_num, 'private', '[SMOKE] Holder ' || v_suffix, CURRENT_DATE - 30, CURRENT_DATE + 365, true);

  INSERT INTO orders (order_number, customer_id, status, booking_draw, salesman_id)
  VALUES ('[SMOKE] RUPP-' || v_suffix, v_customer, 'confirmed', false, v_admin)
  RETURNING id INTO v_order;
  INSERT INTO order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_product, '[SMOKE] RUP Product ' || v_suffix, 10, 6, 10, 100, 40, 40, 0, 10)
  RETURNING id INTO v_line;
  INSERT INTO deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('[SMOKE] RUPP-DEL-' || v_suffix, v_order, v_customer, CURRENT_DATE, 'scheduled', v_admin)
  RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery, v_line, v_product, 10, 0, 'GL')
  RETURNING id INTO v_ditem;
  UPDATE deliveries SET status = 'in_progress' WHERE id = v_delivery;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.complete_delivery(v_delivery, 'No proof — recorded by office', v_admin,
      jsonb_build_object(v_ditem, 10), NULL, NULL, 'smoke-rupp-complete-' || v_suffix, NULL, 'no_proof', '[SMOKE] no signature');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_SETUP: complete_delivery failed: % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;
  SELECT id INTO v_invoice FROM invoices WHERE delivery_id = v_delivery AND deleted_at IS NULL AND status = 'draft';
  IF v_invoice IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: complete_delivery left no draft invoice';
  END IF;
  IF (SELECT count(*) FROM rup_sales_records WHERE invoice_id = v_invoice) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: completing the delivery wrote register rows for the draft';
  END IF;

  -- S1. Draft refused by name, nothing written.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.generate_rup_sales_records(v_invoice, 'smoke-rupp-draft-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: S1 draft invoice was let through (expected RUP_INVOICE_NOT_POSTED)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RUP_INVOICE_NOT_POSTED: invoice % is draft%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: S1 expected RUP_INVOICE_NOT_POSTED for the draft, got % (%)', SQLERRM, SQLSTATE;
    END IF;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM rup_sales_records WHERE invoice_id = v_invoice;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S1 % register row(s) written for the draft', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM idempotency_keys WHERE idempotency_key = 'smoke-rupp-draft-' || v_suffix;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S1 the refused call left an idempotency receipt';
  END IF;

  -- S1b. A direct insert (the admin-only rup_sales_insert policy) for the draft is refused by the table trigger.
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.rup_sales_records (invoice_id, order_id, customer_id, product_id, sale_date, product_name,
      quantity, unit, unit_price_cents, total_cents, buyer_name, buyer_certification_number, compliance_status,
      season, created_by)
    VALUES (v_invoice, v_order, v_customer, v_product, CURRENT_DATE, '[SMOKE] RUP Product ' || v_suffix,
      10, 'gal', 500, 5000, '[SMOKE] RUP Posted Farm ' || v_suffix, v_lic_num, 'compliant',
      EXTRACT(YEAR FROM CURRENT_DATE)::int, v_admin);
    RAISE EXCEPTION 'SMOKE_FAIL: S1b a direct insert for the draft was let through';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RUP_INVOICE_NOT_POSTED: invoice % is draft%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: S1b expected RUP_INVOICE_NOT_POSTED for a direct insert, got % (%)', SQLERRM, SQLSTATE;
    END IF;
  END;
  RESET ROLE;

  -- S2. The real posting path still writes the row.
  v_version := public._invoice_post_version(v_invoice);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.post_invoice(v_invoice, v_version, 'smoke-rupp-post-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S2 post_invoice failed: % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;
  SELECT status INTO v_status FROM invoices WHERE id = v_invoice;
  IF v_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S2 invoice status = %, expected posted', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM rup_sales_records WHERE invoice_id = v_invoice;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S2 expected exactly 1 register row after posting, found %', v_n;
  END IF;
  SELECT created_by, compliance_status, buyer_certification_number INTO v_row
  FROM rup_sales_records WHERE invoice_id = v_invoice AND product_id = v_product;
  IF v_row.created_by IS DISTINCT FROM v_admin
     OR v_row.compliance_status IS DISTINCT FROM 'compliant'
     OR v_row.buyer_certification_number IS DISTINCT FROM v_lic_num THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S2 register row wrong (created_by=%, compliance=%, cert=%)',
      v_row.created_by, v_row.compliance_status, v_row.buyer_certification_number;
  END IF;

  -- S3. A posted invoice is let through (dedup returns 0).
  BEGIN
    SET LOCAL ROLE authenticated;
    v_n := public.generate_rup_sales_records(v_invoice, NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S3 direct call on the posted invoice failed: % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S3 re-run on the posted invoice inserted % row(s), expected 0', v_n;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
