-- ============================================================================
-- ROLLED-BACK smoke: a return credit's tax lands in the tax ledger at the sale's rate (issue #2091)
-- ----------------------------------------------------------------------------
-- Migration 20270308040000_credit_tax_ledger_timing (covering chain; the timing race itself needs two sessions and is
-- in scripts/smoke/prove-credit-tax-ledger-timing-real-schema.mjs).
--   A  A taxed sale of 10 posts; a return of 4 is credited: credit_memo_sales_tax records the credit's tax as a refund
--      (negative), round(credit x sale tax / sale total)
--   B  The other 6 are returned and credited: the two credits' ledger rows add up to exactly the sale's tax, refunded
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
  v_ret uuid;
  v_n int;
  v_qty numeric;
  v_total bigint;
  v_tax bigint;
  v_credit bigint;
  v_ledger bigint;
  v_fails text := '';
BEGIN
  IF to_regclass('public.billing_m4_switch') IS NOT NULL THEN UPDATE public.billing_m4_switch SET enabled = true; END IF;
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_customer IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, an active customer and an active product with a cost';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_customer;

  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-CTL-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Credit tax ledger', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
            10, (v_product.current_cost + 1.37) * 10, 0, 10);
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM set_order_sales_tax(v_order, true, 'smk-ctl-tax-' || v_suffix);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-CTL-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    SELECT v_delivery, oi.id, oi.product_id, 10, 'gal' FROM order_items oi WHERE oi.order_id = v_order;
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-ctl-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-ctl-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; credit tax ledger');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
  PERFORM post_invoice(v_invoice, _invoice_post_version(v_invoice), 'smk-ctl-post-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_total := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
  v_tax := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax');
  IF coalesce(v_tax, 0) <= 0 THEN RAISE EXCEPTION 'SMOKE_SETUP: the posted sale has no tax'; END IF;

  FOR v_n, v_qty IN SELECT * FROM (VALUES (1, 4::numeric), (2, 6::numeric)) v LOOP
    BEGIN
      v_ret := (create_return(jsonb_build_object('customer_id', v_customer, 'order_id', v_order, 'reason', 'damaged'),
        (SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'quantity', v_qty, 'condition', 'unopened', 'restock', false))
           FROM order_items oi WHERE oi.order_id = v_order), 'smk-ctl-ret-' || v_n || v_suffix) ->> 'return_id')::uuid;
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      PERFORM approve_return(v_ret, v_admin, 'smk-ctl-ap-' || v_n || v_suffix);
      PERFORM receive_return(v_ret, v_admin, 'smk-ctl-rc-' || v_n || v_suffix);
      PERFORM issue_return_credit(v_ret, v_admin, 'smk-ctl-ic-' || v_n || v_suffix);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      SELECT -i.total_amount_cents, (SELECT sum(c.tax_cents) FROM credit_memo_sales_tax c WHERE c.invoice_id = i.id)
        INTO v_credit, v_ledger
        FROM returns r JOIN invoices i ON i.id = r.credit_invoice_id WHERE r.id = v_ret;
      IF v_n = 1 AND v_ledger IS DISTINCT FROM round(-v_credit * v_tax::numeric / v_total)::bigint THEN
        v_fails := v_fails || format(' (A) the 4-unit credit of %s cents froze %s cents tax, want %s;', v_credit, v_ledger,
          round(-v_credit * v_tax::numeric / v_total));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || format(' (%s) the return credit failed: %s;', CASE v_n WHEN 1 THEN 'A' ELSE 'B' END, SQLERRM);
    END;
  END LOOP;
  IF (SELECT sum(c.tax_cents) FROM credit_memo_sales_tax c JOIN invoices i ON i.id = c.invoice_id
       WHERE i.order_id = v_order AND i.invoice_type = 'credit_memo') IS DISTINCT FROM -v_tax THEN
    v_fails := v_fails || format(' (B) the two credits refund %s cents tax in the ledger, want exactly %s;',
      (SELECT -sum(c.tax_cents) FROM credit_memo_sales_tax c JOIN invoices i ON i.id = c.invoice_id
        WHERE i.order_id = v_order AND i.invoice_type = 'credit_memo'), v_tax);
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL credit tax ledger:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK credit tax ledger: a return credit''s tax is frozen as a refund at the sale''s rate, and a whole return refunds exactly the sale''s tax';
END
$smoke$;
