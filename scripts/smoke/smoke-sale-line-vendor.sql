-- ============================================================================
-- ROLLED-BACK smoke: an order line carries a vendor through to its invoice
-- ----------------------------------------------------------------------------
-- Migration 20261112130000_sale_line_vendor (billing plan M3).
--   A  A new order line is filled from the product's preferred vendor
--   B  A line created with a vendor keeps it
--   C  A line's vendor changed on the sale reaches its invoice, and the product isn't touched
--   D  An older line with no vendor invoices with the product's preferred vendor
--   E  Re-saving a draft without sending the vendor keeps it; a save that sends one changes it
--   F  A product with no preferred vendor, if any, leaves the line blank with no error
--   G  Only the vendor column is open to UPDATE
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- order, delivery and invoice is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_p public.products%ROWTYPE;
  v_blank public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_preferred text;
  v_o uuid;
  v_l1 uuid;
  v_l2 uuid;
  v_l3 uuid;
  v_d uuid;
  v_inv uuid;
  v_header jsonb;
  v_lines jsonb;
  v_fails text := '';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at LIMIT 1;
  SELECT * INTO v_p FROM products WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
     AND NULLIF(btrim(vendor), '') IS NOT NULL ORDER BY created_at LIMIT 1;
  -- Optional: every active product may have a preferred vendor, and F then has nothing to check.
  SELECT * INTO v_blank FROM products WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
     AND NULLIF(btrim(vendor), '') IS NULL ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_customer IS NULL OR v_p.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, an active customer and an active product with a cost and a preferred vendor';
  END IF;
  v_preferred := v_p.vendor;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-VND-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_o;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit, total_units_needed, total_price, quantity_delivered, quantity_remaining, sort_order)
    VALUES (v_o, v_p.id, '[SMOKE] Filled', 'gal', v_p.current_cost + 1, v_p.current_cost, 5, (v_p.current_cost + 1) * 5, 0, 5, 1) RETURNING id INTO v_l1;
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit, total_units_needed, total_price, quantity_delivered, quantity_remaining, sort_order, vendor)
    VALUES (v_o, v_p.id, '[SMOKE] Named', 'gal', v_p.current_cost + 1, v_p.current_cost, 5, (v_p.current_cost + 1) * 5, 0, 5, 2, '[SMOKE] Named Supply') RETURNING id INTO v_l2;
  IF v_blank.id IS NOT NULL THEN
    INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit, total_units_needed, total_price, quantity_delivered, quantity_remaining, sort_order)
      VALUES (v_o, v_blank.id, '[SMOKE] No preferred', 'gal', v_blank.current_cost + 1, v_blank.current_cost, 5, (v_blank.current_cost + 1) * 5, 0, 5, 3) RETURNING id INTO v_l3;
  END IF;
  PERFORM set_config('app.crx_below_cost_operation', '', true);

  IF (SELECT vendor FROM order_items WHERE id = v_l1) IS DISTINCT FROM v_preferred THEN
    v_fails := v_fails || ' (A) a new line was not filled from the preferred vendor;';
  END IF;
  IF (SELECT vendor FROM order_items WHERE id = v_l2) IS DISTINCT FROM '[SMOKE] Named Supply' THEN
    v_fails := v_fails || ' (B) a named vendor was overwritten;';
  END IF;
  IF v_l3 IS NOT NULL AND (SELECT vendor FROM order_items WHERE id = v_l3) IS NOT NULL THEN
    v_fails := v_fails || ' (F) a product with no preferred vendor filled something;';
  END IF;

  -- C on line 2, D on line 1 (as if it predates this migration).
  UPDATE order_items SET vendor = '[SMOKE] Changed Supply' WHERE id = v_l2;
  UPDATE order_items SET vendor = NULL WHERE id = v_l1;

  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-VND-' || v_suffix, v_o, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_d;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_d, v_l1, v_p.id, 5, 'gal'), (v_d, v_l2, v_p.id, 5, 'gal');
  IF v_l3 IS NOT NULL THEN
    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size) VALUES (v_d, v_l3, v_blank.id, 5, 'gal');
  END IF;
  PERFORM confirm_delivery(v_d, v_admin, 'smk-vnd-confirm-' || v_suffix);
  PERFORM complete_delivery(v_d, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-vnd-done-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; sale line vendor');
  v_inv := (SELECT id FROM invoices WHERE delivery_id = v_d AND invoice_type <> 'credit_memo');

  IF (SELECT vendor FROM invoice_items WHERE invoice_id = v_inv AND order_item_id = v_l2) IS DISTINCT FROM '[SMOKE] Changed Supply' THEN
    v_fails := v_fails || ' (C) the changed vendor did not reach the invoice;';
  END IF;
  IF (SELECT vendor FROM products WHERE id = v_p.id) IS DISTINCT FROM v_preferred THEN
    v_fails := v_fails || ' (C) changing a sale line touched the product;';
  END IF;
  IF (SELECT vendor FROM invoice_items WHERE invoice_id = v_inv AND order_item_id = v_l1) IS DISTINCT FROM v_preferred THEN
    v_fails := v_fails || ' (D) an older line did not fall back to the preferred vendor;';
  END IF;
  IF v_l3 IS NOT NULL AND (SELECT vendor FROM invoice_items WHERE invoice_id = v_inv AND order_item_id = v_l3) IS NOT NULL THEN
    v_fails := v_fails || ' (F) a line with no vendor invoiced with one;';
  END IF;

  -- E: the screen's save, first without the vendor, then with one set on the invoice line.
  SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
           'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
           'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
    INTO v_header FROM invoices i WHERE i.id = v_inv;
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size) ORDER BY it.sort_order)
    INTO v_lines FROM invoice_items it WHERE it.invoice_id = v_inv;
  BEGIN
    PERFORM save_invoice(v_header, v_lines, 'smk-vnd-resave-' || v_suffix);
    IF (SELECT vendor FROM invoice_items WHERE invoice_id = v_inv AND order_item_id = v_l2) IS DISTINCT FROM '[SMOKE] Changed Supply' THEN
      v_fails := v_fails || format(' (E) a re-save without the vendor left %s;', (SELECT vendor FROM invoice_items WHERE invoice_id = v_inv AND order_item_id = v_l2));
    END IF;
    SELECT jsonb_agg(l || CASE WHEN (l->>'order_item_id')::uuid = v_l2 THEN jsonb_build_object('vendor', '[SMOKE] Invoice Supply') ELSE '{}'::jsonb END)
      INTO v_lines FROM jsonb_array_elements(v_lines) l;
    PERFORM save_invoice(v_header, v_lines, 'smk-vnd-resave2-' || v_suffix);
    IF (SELECT vendor FROM invoice_items WHERE invoice_id = v_inv AND order_item_id = v_l2) IS DISTINCT FROM '[SMOKE] Invoice Supply' THEN
      v_fails := v_fails || ' (E) a vendor set on the invoice line did not stay;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (E) ' || SQLERRM || ';';
  END;

  IF NOT has_column_privilege('authenticated', 'public.order_items', 'vendor', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.order_items', 'price_per_unit', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.order_items', 'product_id', 'UPDATE') THEN
    v_fails := v_fails || ' (G) the column grants are not exactly the vendor column;';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL sale line vendor:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK sale line vendor: filled from the preferred vendor, changed on the sale, carried to the invoice, kept through a re-save';
END
$smoke$;
