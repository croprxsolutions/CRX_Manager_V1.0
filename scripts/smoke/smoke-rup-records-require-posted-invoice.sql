-- ============================================================================
-- SMOKE TEST (rolled back by design): generate_rup_sales_records requires a
-- posted invoice (KI-05, migration 20261108140000).
-- ----------------------------------------------------------------------------
-- Run AFTER the migration is applied; before it, S1 FAILs (the draft is let
-- through).
--   S0  the live body carries RUP_INVOICE_NOT_POSTED; grants unchanged.
--   S1  an active admin, AS ROLE authenticated, calls it on a [SMOKE] draft
--       chemical_sale invoice with one RUP line -> RUP_INVOICE_NOT_POSTED,
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
    RAISE EXCEPTION 'SMOKE_FAIL: S0 generate_rup_sales_records has no RUP_INVOICE_NOT_POSTED check - migration 20261108140000 not applied';
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

  -- Fixtures: a draft chemical_sale invoice with one RUP line and a valid licence.
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] RUP Posted Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO products (product_name, is_rup, epa_registration, signal_word)
  VALUES ('[SMOKE] RUP Product ' || v_suffix, true, '999999-99999', 'Warning')
  RETURNING id INTO v_product;

  v_lic_num := 'SMK-LIC-' || v_suffix;
  INSERT INTO applicator_licenses (customer_id, license_number, license_type, holder_name, expiry_date, is_active)
  VALUES (v_customer, v_lic_num, 'private', '[SMOKE] Holder ' || v_suffix, CURRENT_DATE + 365, true);

  INSERT INTO orders (order_number, customer_id, salesman_id)
  VALUES ('SMK-RUPP-' || v_suffix, v_customer, v_admin)
  RETURNING id INTO v_order;

  INSERT INTO invoices (invoice_number, order_id, customer_id, invoice_type,
    status, total_amount_cents, invoice_date, created_by)
  VALUES ('SMK-RUPP-INV-' || v_suffix, v_order, v_customer, 'chemical_sale',
    'draft', 5000, CURRENT_DATE, v_admin)
  RETURNING id INTO v_invoice;

  INSERT INTO invoice_items (invoice_id, product_id, description, quantity,
    unit_size, unit_price_cents, extended_cents)
  VALUES (v_invoice, v_product, '[SMOKE] RUP line ' || v_suffix, 10,
    'gal', 500, 5000);

  -- S1. Draft refused by name, nothing written.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.generate_rup_sales_records(v_invoice, 'smoke-rupp-draft-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: S1 draft invoice was let through (expected RUP_INVOICE_NOT_POSTED)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RUP_INVOICE_NOT_POSTED: invoice SMK-RUPP-INV-% is draft%' THEN
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
    IF SQLERRM NOT LIKE 'RUP_INVOICE_NOT_POSTED: invoice SMK-RUPP-INV-% is draft%' THEN
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
