-- ============================================================================
-- ROLLED-BACK smoke: a delivery invoice takes typed charge lines; every product rule stays
-- ----------------------------------------------------------------------------
-- Migration 20261107140000_delivery_invoice_charge_lines (billing plan M1).
--   A  A $45.00 freight charge on a completed delivery's invoice is accepted
--   B  A line with no product and no charge type is still refused
--   C  One more stored quantity tick on the delivered product is still refused
--   D  The invoice posts at product + $45.00, to the cent
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- order, delivery and invoice is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_product public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_line uuid;
  v_delivery uuid;
  v_invoice uuid;
  v_product_cents bigint;
  v_header jsonb;
  v_lines jsonb;
  v_fails text := '';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_customer IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, an active customer and an active product with a cost';
  END IF;

  -- Fixtures as the admin: a 10-unit order line priced $1.00 above cost, delivered in full.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-CHG-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Charge lines', 'gal', v_product.current_cost + 1, v_product.current_cost,
      10, (v_product.current_cost + 1) * 10, 0, 10) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-CHG-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 10, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-chg-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-chg-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; delivery invoice charge lines');
  SELECT id INTO v_invoice FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo';
  IF v_invoice IS NULL THEN
    v_invoice := create_invoice_for_unbilled_delivery(v_delivery, v_admin, 'smk-chg-invoice-' || v_suffix);
  END IF;
  v_product_cents := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
  -- The header and lines exactly as the invoice screen sends them back to save_invoice.
  SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
           'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
           'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
    INTO v_header FROM invoices i WHERE i.id = v_invoice;
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
    INTO v_lines FROM invoice_items it WHERE it.invoice_id = v_invoice;

  BEGIN
    PERFORM save_invoice(v_header, v_lines || jsonb_build_array(jsonb_build_object('description', 'Freight', 'quantity', 1,
      'unit_price_cents', 4500, 'extended_cents', 4500, 'cost_cents', 0, 'sort_order', 9, 'charge_type', 'freight')),
      'smk-chg-freight-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (A) the freight charge was refused: ' || SQLERRM || ';';
  END;

  BEGIN
    PERFORM save_invoice(v_header, v_lines || jsonb_build_array(jsonb_build_object('description', 'Untyped', 'quantity', 1,
      'unit_price_cents', 4500, 'extended_cents', 4500, 'cost_cents', 0, 'sort_order', 9)),
      'smk-chg-untyped-' || v_suffix);
    v_fails := v_fails || ' (B) an untyped no-product line was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' AND SQLERRM NOT LIKE 'ORDER_INVOICE_%' THEN
      v_fails := v_fails || ' (B) wrong refusal: ' || SQLERRM || ';';
    END IF;
  END;

  BEGIN
    UPDATE invoice_items SET quantity = quantity + 0.0001 WHERE invoice_id = v_invoice AND product_id IS NOT NULL;
    v_fails := v_fails || ' (C) a quantity above the delivery was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' AND SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%' THEN
      v_fails := v_fails || ' (C) wrong refusal: ' || SQLERRM || ';';
    END IF;
  END;

  BEGIN
    PERFORM post_invoice(v_invoice, _invoice_post_version(v_invoice), 'smk-chg-post-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (D) posting was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT status FROM invoices WHERE id = v_invoice) IS DISTINCT FROM 'posted'
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents + 4500 THEN
    v_fails := v_fails || format(' (D) invoice is %s at %s cents, want posted at %s;',
      (SELECT status FROM invoices WHERE id = v_invoice), (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), v_product_cents + 4500);
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL delivery invoice charge lines:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK delivery invoice charge lines: freight charge accepted and posted at product + $45.00, untyped line and extra quantity still refused';
END
$smoke$;
