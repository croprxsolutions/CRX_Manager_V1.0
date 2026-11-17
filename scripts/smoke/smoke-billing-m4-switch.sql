-- ============================================================================
-- ROLLED-BACK smoke: while the M4 switch is off, the database refuses what would start charging tax or a discount
-- ----------------------------------------------------------------------------
-- Migration 20270117140000_billing_m4_db_switch.
--   A  Switch off: ticking a sale's sales tax is refused (admin, through set_order_sales_tax); unticking works
--   B  Switch off: a customer's standing discount above 0 is refused; 0 works
--   C  Switch off: a sale's own discount above 0 is refused (set_invoice_standing_discount); 0 and "the customer's
--      rate" work
--   D  An active user can read the switch; nobody can change it through the app; the anonymous role can't read it
--   E  Switch on: ticking tax, a customer discount and a sale's own discount all work
--   F  A sale ticked and a customer discounted while ON, then the switch OFF: a NEW draft has no tax and no discount
--      (the drafted rate is recorded as 0); the earlier draft keeps both
--
-- HOW TO RUN: execute this whole file as ONE statement (psql -c, or Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture is rolled back.
-- Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_product public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_delivery uuid;
  v_invoice uuid;
  v_fails text := '';
  v_err text;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_customer IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, an active customer and an active product with a cost';
  END IF;
  IF to_regclass('public.billing_m4_switch') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL billing M4 switch: billing_m4_switch is missing (20270117140000 not applied)';
  END IF;

  EXECUTE $f$
    CREATE FUNCTION pg_temp.smk_as(p_user uuid) RETURNS void LANGUAGE sql AS $b$
      SELECT set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
             set_config('request.jwt.claim.sub', p_user::text, true) $b$;
  $f$;

  -- A sale with one delivered line and its draft invoice, untaxed, no discount.
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_customer;
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-M4SW-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] M4 switch', 'gal', v_product.current_cost + 1, v_product.current_cost,
            10, (v_product.current_cost + 1) * 10, 0, 10);
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-M4SW-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    SELECT v_delivery, oi.id, oi.product_id, oi.total_units_needed, 'gal' FROM order_items oi WHERE oi.order_id = v_order;
  PERFORM pg_temp.smk_as(v_admin);
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-m4sw-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-m4sw-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; M4 switch');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo') THEN
    PERFORM create_invoice_for_unbilled_delivery(v_delivery, v_admin, 'smk-m4sw-invoice-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  END IF;
  SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type = 'chemical_sale' AND status = 'draft';
  IF v_invoice IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the delivery left no chemical-sale draft';
  END IF;

  UPDATE billing_m4_switch SET enabled = false;

  -- A
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    PERFORM set_order_sales_tax(v_order, true, 'smk-m4sw-a1-' || v_suffix);
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BILLING_M4_OFF%' THEN
    v_fails := v_fails || ' (A) ticking tax while off was not refused: ' || COALESCE(v_err, 'it worked') || ';';
  END IF;
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    PERFORM set_order_sales_tax(v_order, false, 'smk-m4sw-a2-' || v_suffix);
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_fails := v_fails || ' (A) unticking while off was refused: ' || v_err || ';'; END IF;

  -- B
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    UPDATE customers SET standing_discount_pct = 5 WHERE id = v_customer;
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BILLING_M4_OFF%' THEN
    v_fails := v_fails || ' (B) a customer discount of 5 while off was not refused: ' || COALESCE(v_err, 'it worked') || ';';
  END IF;
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    UPDATE customers SET standing_discount_pct = 0 WHERE id = v_customer;
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_fails := v_fails || ' (B) a customer discount of 0 was refused: ' || v_err || ';'; END IF;

  -- C
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    PERFORM set_invoice_standing_discount(v_invoice, 5, 'smk-m4sw-c1-' || v_suffix);
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BILLING_M4_OFF%' THEN
    v_fails := v_fails || ' (C) a sale discount of 5 while off was not refused: ' || COALESCE(v_err, 'it worked') || ';';
  END IF;
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    PERFORM set_invoice_standing_discount(v_invoice, 0, 'smk-m4sw-c2-' || v_suffix);
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_fails := v_fails || ' (C) a sale discount of 0 was refused: ' || v_err || ';'; END IF;
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    PERFORM set_invoice_standing_discount(v_invoice, NULL, 'smk-m4sw-c3-' || v_suffix);
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_fails := v_fails || ' (C) "the customer''s rate" was refused: ' || v_err || ';'; END IF;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;

  -- D
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    IF (SELECT count(*) FROM billing_m4_switch) <> 1 THEN RAISE EXCEPTION 'the row is hidden'; END IF;
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_fails := v_fails || ' (D) an active user could not read the switch: ' || v_err || ';'; END IF;
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    UPDATE billing_m4_switch SET enabled = true;
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR (SELECT enabled FROM billing_m4_switch) THEN
    v_fails := v_fails || ' (D) the signed-in admin could turn the switch on;';
  END IF;
  IF has_table_privilege('anon', 'public.billing_m4_switch', 'SELECT') THEN
    v_fails := v_fails || ' (D) the anonymous role can read the switch;';
  END IF;

  -- E
  UPDATE billing_m4_switch SET enabled = true;
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    PERFORM set_order_sales_tax(v_order, true, 'smk-m4sw-e1-' || v_suffix);
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_fails := v_fails || ' (E) ticking tax while on was refused: ' || v_err || ';'; END IF;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    UPDATE customers SET standing_discount_pct = 5 WHERE id = v_customer;
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_fails := v_fails || ' (E) a customer discount while on was refused: ' || v_err || ';'; END IF;
  BEGIN  -- as the signed-in admin; v_err is NULL when it worked, else the error
    SET LOCAL ROLE authenticated;
    PERFORM set_invoice_standing_discount(v_invoice, 4, 'smk-m4sw-e3-' || v_suffix);
    RESET ROLE; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_fails := v_fails || ' (E) a sale discount while on was refused: ' || v_err || ';'; END IF;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;

  -- F: still ON here; the sale is ticked and the customer is at 5%. A second delivery while OFF drafts plain.
  DECLARE v_line uuid; v_del2 uuid; v_inv2 uuid; v_kept bigint;
  BEGIN
    v_kept := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
    INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
      total_units_needed, total_price, quantity_delivered, quantity_remaining)
      VALUES (v_order, v_product.id, '[SMOKE] M4 switch F', 'gal', v_product.current_cost + 1, v_product.current_cost,
              4, (v_product.current_cost + 1) * 4, 0, 4) RETURNING id INTO v_line;
    UPDATE billing_m4_switch SET enabled = false;
    INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
      VALUES ('SMK-M4SW-F-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_del2;
    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES (v_del2, v_line, v_product.id, 4, 'gal');
    PERFORM confirm_delivery(v_del2, v_admin, 'smk-m4sw-f-confirm-' || v_suffix);
    PERFORM complete_delivery(v_del2, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
      'smk-m4sw-f-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; M4 switch F');
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_del2 AND invoice_type <> 'credit_memo') THEN
      PERFORM create_invoice_for_unbilled_delivery(v_del2, v_admin, 'smk-m4sw-f-invoice-' || v_suffix);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    END IF;
    SELECT id INTO v_inv2 FROM invoices WHERE delivery_id = v_del2 AND invoice_type = 'chemical_sale';
    IF v_inv2 IS NULL
       OR EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_inv2 AND charge_type IN ('sales_tax', 'standing_discount'))
       OR EXISTS (SELECT 1 FROM invoice_sales_tax_rates WHERE invoice_id = v_inv2)
       OR (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_inv2) IS DISTINCT FROM 0 THEN
      v_fails := v_fails || ' (F) a new draft made while OFF took tax or a discount;';
    END IF;
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_kept
       OR NOT EXISTS (SELECT 1 FROM invoice_sales_tax_rates WHERE invoice_id = v_invoice)
       OR (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_invoice) IS DISTINCT FROM 4
       OR NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax')
       OR NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount') THEN
      v_fails := v_fails || ' (F) the earlier draft changed when the switch went off;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) failed: ' || SQLERRM || ';';
  END;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL billing M4 switch:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK billing M4 switch: while off, ticking tax and any discount above 0 are refused and turning them off works; the app can read the switch but not change it; while on, all three work; a new draft made while off has no tax or discount, whatever its sale and customer hold';
END
$smoke$;
