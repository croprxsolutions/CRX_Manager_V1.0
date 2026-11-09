-- ============================================================================
-- ROLLED-BACK smoke: every payer of a Bill Split sale, for anyone who may read one of its invoices
-- ----------------------------------------------------------------------------
-- Migration 20261221110000_bill_split_payers_read (#1534; Sol HIGH on a6aaa21f2).
--   A  Rep 1 sells a Bill Split 50/50; an admin moves payer 2's draft to rep 2 (save_invoice)
--   B  Rep 1's direct read of the group now sees only payer 1 (the gap this closes)
--   C  get_bill_split_payers on payer 1's invoice, as rep 1: both payers, adding up to the sale
--   D  As rep 2, on payer 2's invoice: both payers; on payer 1's invoice (not theirs): INVOICE_NOT_VISIBLE
--   E  A driver: INVOICE_NOT_VISIBLE; anon: no EXECUTE
--   F  An invoice with no split group: no rows
--   G  A payer invoice with no sales rep (an office sale): a driver and another rep are still refused, and a
--      call with no signed-in claims at all is refused (a NULL in the check must never let a caller through)
--   H  Rep 2 deactivated: refused on their own invoice, though their token still names them
--   I  A plain (not Bill Split) invoice in the caller's reach: no rows, never another group's payers
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- order, delivery and invoice is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep1 uuid;
  v_rep2 uuid;
  v_driver uuid;
  v_main uuid;
  v_payer2 uuid;
  v_product public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_line uuid;
  v_delivery uuid;
  v_inv1 uuid;
  v_inv2 uuid;
  v_plain uuid;
  v_header jsonb;
  v_items jsonb;
  v_n int;
  v_sum bigint;
  v_expected bigint;
  v_fails text := '';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep1 FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_rep2 FROM profiles WHERE role = 'sales_rep' AND is_active = true AND id <> v_rep1 ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_driver FROM profiles WHERE role = 'driver' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_main FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_payer2 FROM customers WHERE is_active = true AND id <> v_main ORDER BY created_at, id LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep1 IS NULL OR v_rep2 IS NULL OR v_driver IS NULL OR v_main IS NULL OR v_payer2 IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, two sales reps, a driver, two customers and a product with a cost';
  END IF;

  -- A: rep 1's Bill Split 50/50, delivered as the admin.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-BSP-' || v_suffix, v_main, CURRENT_DATE, 'confirmed', v_rep1) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Payers read', 'gal', v_product.current_cost + 1, v_product.current_cost,
      10, (v_product.current_cost + 1) * 10, 0, 10) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)
    VALUES (v_order, v_main, '[SMOKE] main', 50, 0, true, 1), (v_order, v_payer2, '[SMOKE] payer 2', 50, 0, false, 2);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-BSP-' || v_suffix, v_order, v_main, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 10, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-bsp-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-bsp-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; Bill Split payers read');
  SELECT id INTO v_inv1 FROM invoices WHERE order_id = v_order AND customer_id = v_main AND status NOT IN ('voided', 'cancelled');
  SELECT id INTO v_inv2 FROM invoices WHERE order_id = v_order AND customer_id = v_payer2 AND status NOT IN ('voided', 'cancelled');
  IF v_inv1 IS NULL OR v_inv2 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL bill split payers read: (A) the delivery did not draft two payer invoices';
  END IF;
  -- The admin moves payer 2's draft to rep 2, through save_invoice as the invoice screen does.
  SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
           'season', i.season, 'salesman_id', v_rep2, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
           'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
    INTO v_header FROM invoices i WHERE i.id = v_inv2;
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
    INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv2;
  PERFORM save_invoice(v_header, v_items, 'smk-bsp-reassign-' || v_suffix);
  IF (SELECT salesman_id FROM invoices WHERE id = v_inv2) IS DISTINCT FROM v_rep2 THEN
    v_fails := v_fails || ' (A) payer 2''s draft was not moved to rep 2;';
  END IF;
  v_expected := (SELECT sum(total_amount_cents) FROM invoices WHERE id IN (v_inv1, v_inv2));   -- read as owner, before any role switch

  -- B, C: rep 1.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep1, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep1::text, true);
  SET LOCAL ROLE authenticated;
  v_n := (SELECT count(*) FROM invoices WHERE invoice_group_id = (SELECT invoice_group_id FROM invoices WHERE id = v_inv1));
  IF v_n <> 1 THEN
    v_fails := v_fails || format(' (B) rep 1''s direct group read saw %s invoices, want 1 (the gap this closes);', v_n);
  END IF;
  SELECT count(*), sum(p.total_amount_cents) INTO v_n, v_sum FROM (SELECT * FROM get_bill_split_payers(v_inv1)) p
   HAVING sum(p.total_amount_cents) IS NOT NULL;
  IF v_n IS DISTINCT FROM 2 OR v_sum IS DISTINCT FROM v_expected THEN
    v_fails := v_fails || format(' (C) rep 1 got %s payers totalling %s, want 2 totalling %s;', v_n, v_sum, v_expected);
  END IF;
  RESET ROLE;

  -- D: rep 2.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep2, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep2::text, true);
  SET LOCAL ROLE authenticated;
  IF (SELECT count(*) FROM get_bill_split_payers(v_inv2)) <> 2 THEN
    v_fails := v_fails || ' (D) rep 2 did not get both payers on their own invoice;';
  END IF;
  BEGIN
    PERFORM count(*) FROM get_bill_split_payers(v_inv1);
    v_fails := v_fails || ' (D) rep 2 read payers through an invoice that is not theirs;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_NOT_VISIBLE:%' THEN v_fails := v_fails || ' (D) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  RESET ROLE;

  -- E: a driver, then anon.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM count(*) FROM get_bill_split_payers(v_inv1);
    v_fails := v_fails || ' (E) a driver read the payers;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_NOT_VISIBLE:%' THEN v_fails := v_fails || ' (E) wrong refusal for a driver: ' || SQLERRM || ';'; END IF;
  END;
  RESET ROLE;
  IF has_function_privilege('anon', 'public.get_bill_split_payers(uuid)', 'EXECUTE') THEN
    v_fails := v_fails || ' (E) anon can EXECUTE get_bill_split_payers;';
  END IF;

  -- F: a plain invoice (no group).
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT id INTO v_plain FROM invoices WHERE invoice_group_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
  IF v_plain IS NOT NULL AND (SELECT count(*) FROM get_bill_split_payers(v_plain)) <> 0 THEN
    v_fails := v_fails || ' (F) an invoice with no split group returned payers;';
  END IF;

  -- G: payer 1's draft with no sales rep, saved by the admin as the invoice screen does.
  SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
           'season', i.season, 'salesman_id', NULL, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
           'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
    INTO v_header FROM invoices i WHERE i.id = v_inv1;
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
    INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv1;
  PERFORM save_invoice(v_header, v_items, 'smk-bsp-norep-' || v_suffix);
  IF (SELECT salesman_id FROM invoices WHERE id = v_inv1) IS NOT NULL THEN
    v_fails := v_fails || ' (G) payer 1''s draft still has a sales rep;';
  END IF;
  FOREACH v_plain IN ARRAY ARRAY[v_driver, v_rep2] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_plain::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM count(*) FROM get_bill_split_payers(v_inv1);
      v_fails := v_fails || format(' (G) %s read the payers of an invoice with no sales rep;', CASE WHEN v_plain = v_driver THEN 'a driver' ELSE 'another rep' END);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'INVOICE_NOT_VISIBLE:%' THEN v_fails := v_fails || ' (G) wrong refusal: ' || SQLERRM || ';'; END IF;
    END;
    RESET ROLE;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM count(*) FROM get_bill_split_payers(v_inv1);
    v_fails := v_fails || ' (G) a call with no claims read the payers;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_NOT_VISIBLE:%' THEN v_fails := v_fails || ' (G) wrong refusal with no claims: ' || SQLERRM || ';'; END IF;
  END;
  RESET ROLE;

  -- H: rep 2 deactivated (as owner; rolled back with everything else).
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE profiles SET is_active = false WHERE id = v_rep2;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep2, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep2::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM count(*) FROM get_bill_split_payers(v_inv2);
    v_fails := v_fails || ' (H) a deactivated rep read the payers;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_NOT_VISIBLE:%' THEN v_fails := v_fails || ' (H) wrong refusal for a deactivated rep: ' || SQLERRM || ';'; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE profiles SET is_active = true WHERE id = v_rep2;

  -- I: the admin on a non-Bill-Split invoice that has a group (a field split's, if this database has one).
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT id INTO v_plain FROM invoices
   WHERE invoice_group_id IS NOT NULL AND delivery_id IS NULL AND deleted_at IS NULL AND status NOT IN ('voided', 'cancelled')
   ORDER BY created_at DESC LIMIT 1;
  IF v_plain IS NOT NULL AND (SELECT count(*) FROM get_bill_split_payers(v_plain)) <> 0 THEN
    v_fails := v_fails || ' (I) a grouped invoice that is not a Bill Split returned payers;';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL bill split payers read:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK bill split payers read: a rep whose payer was moved to another rep still gets every payer; a user who cannot read the invoice, a driver and anon get none';
END
$smoke$;
