-- ============================================================================
-- ROLLED-BACK smoke: sales reports show each payer's share of a Bill Split sale
-- ----------------------------------------------------------------------------
-- Migration 20261229150000_sales_reports_per_payer.
--   A  Read every report as an admin (the live totals and every existing row, fingerprinted)
--   B  A rep sells a Bill Split, main customer 60 / payer 2 40, delivered and billed per payer
--   C  Sales Detail: one row per payer, payer 2 has exactly 40% of the line (rounded down), the main
--      customer the rest; each row shows that payer's own invoice; existing rows are unchanged
--   D  Totals: detail, every summary grouping and the dashboard headline grew by exactly the line
--   E  "By customer" and the customer filter credit payer 2 with their share
--   F  A rep gets the same rows with cost, profit and margin empty; nobody may call the helper
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- order, delivery and invoice is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_main uuid;
  v_payer2 uuid;
  v_product public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_order_number text;
  v_line uuid;
  v_delivery uuid;
  v_line_cents bigint;
  v_p2_cents bigint;
  v_rows_before text;
  v_rows_after text;
  v_detail_before numeric;
  v_detail_after numeric;
  v_dash_before numeric;
  v_dash_after numeric;
  v_by text;
  v_sum_before numeric;
  v_sum_after numeric;
  v_n int;
  v_fails text := '';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_main FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_payer2 FROM customers WHERE is_active = true AND id <> v_main ORDER BY created_at, id LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_main IS NULL OR v_payer2 IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, a sales rep, two customers and a product with a cost';
  END IF;
  IF to_regprocedure('public._sales_line_payers(uuid)') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: 20261229150000 is not applied';
  END IF;

  -- A: the reports as they stand.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT md5(coalesce(string_agg(r::text, ',' ORDER BY r::text), '')), coalesce(sum(r.total_price), 0)
    INTO v_rows_before, v_detail_before FROM get_sales_detail_report() r;
  v_dash_before := (financial_dashboard_summary() ->> 'total_revenue')::numeric;
  CREATE TEMP TABLE smk_srpp_sum ON COMMIT DROP AS
    SELECT g.grp, (SELECT coalesce(sum(s.total_revenue), 0) FROM get_sales_summary_report(p_group_by => g.grp) s) AS total
      FROM unnest(ARRAY['product', 'customer', 'sales_rep', 'month', 'category']) AS g(grp);

  -- B: a rep's Bill Split, 60 / 40, delivered as the admin.
  v_order_number := 'SMK-SRPP-' || v_suffix;
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES (v_order_number, v_main, CURRENT_DATE, 'confirmed', v_rep) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Payer report', 'gal', v_product.current_cost + 1.01, v_product.current_cost,
      7, (v_product.current_cost + 1.01) * 7, 0, 7) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)
    VALUES (v_order, v_main, '[SMOKE] main', 60, 0, true, 1), (v_order, v_payer2, '[SMOKE] payer 2', 40, 0, false, 2);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES (v_order_number, v_order, v_main, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 7, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-srpp-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-srpp-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; sales reports per payer');
  SELECT (round(total_price, 2) * 100)::bigint INTO v_line_cents FROM order_items WHERE id = v_line;
  v_p2_cents := floor(v_line_cents * 40 / 100.0);

  -- C: one row per payer, adding up to the line; each payer's own invoice; existing rows unchanged.
  SELECT count(*) INTO v_n FROM get_sales_detail_report() r
   WHERE r.order_number = v_order_number
     AND ((r.customer_id = v_payer2 AND r.total_price * 100 = v_p2_cents)
       OR (r.customer_id = v_main AND r.total_price * 100 = v_line_cents - v_p2_cents))
     AND r.invoice_number = (SELECT i.invoice_number FROM invoices i
                              WHERE i.order_id = v_order AND i.customer_id = r.customer_id
                                AND i.status NOT IN ('voided', 'cancelled') AND i.deleted_at IS NULL);
  IF v_n <> 2 THEN
    v_fails := v_fails || format(' (C) expected the main customer and payer 2 rows with their own invoices, got %s;', v_n);
  END IF;
  SELECT md5(coalesce(string_agg(r::text, ',' ORDER BY r::text), '')), coalesce(sum(r.total_price), 0)
    INTO v_rows_after, v_detail_after FROM get_sales_detail_report() r WHERE r.order_number <> v_order_number;
  IF v_rows_after IS DISTINCT FROM v_rows_before THEN
    v_fails := v_fails || ' (C) rows of other sales changed;';
  END IF;

  -- D: every total grew by exactly the line.
  SELECT coalesce(sum(r.total_price), 0) INTO v_detail_after FROM get_sales_detail_report() r;
  IF (v_detail_after - v_detail_before) * 100 <> v_line_cents THEN
    v_fails := v_fails || format(' (D) detail total moved by %s, the line is %s cents;', v_detail_after - v_detail_before, v_line_cents);
  END IF;
  FOR v_by, v_sum_before IN SELECT grp, total FROM smk_srpp_sum LOOP
    SELECT coalesce(sum(s.total_revenue), 0) INTO v_sum_after FROM get_sales_summary_report(p_group_by => v_by) s;
    IF (v_sum_after - v_sum_before) * 100 <> v_line_cents THEN
      v_fails := v_fails || format(' (D) summary by %s moved by %s;', v_by, v_sum_after - v_sum_before);
    END IF;
  END LOOP;
  v_dash_after := (financial_dashboard_summary() ->> 'total_revenue')::numeric;
  IF (v_dash_after - v_dash_before) * 100 <> v_line_cents THEN
    v_fails := v_fails || ' (D) dashboard headline moved by other than the line;';
  END IF;

  -- E: payer 2 is credited their share.
  SELECT count(*) INTO v_n FROM get_sales_detail_report(p_customer_ids => ARRAY[v_payer2]) r
   WHERE r.order_number = v_order_number AND r.total_price * 100 = v_p2_cents;
  IF v_n <> 1 THEN
    v_fails := v_fails || ' (E) the customer filter did not find payer 2''s share;';
  END IF;
  SELECT count(*) INTO v_n FROM get_sales_summary_report(p_group_by => 'customer', p_customer_ids => ARRAY[v_payer2]) s
   WHERE s.group_id = v_payer2 AND s.order_count >= 1;
  IF v_n <> 1 THEN
    v_fails := v_fails || ' (E) "by customer" did not credit payer 2;';
  END IF;

  -- F: a rep sees the shares without cost; nobody may call the helper.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  SELECT count(*) INTO v_n FROM get_sales_detail_report() r
   WHERE r.order_number = v_order_number AND r.cost IS NULL AND r.profit IS NULL AND r.margin_pct IS NULL;
  IF v_n <> 2 THEN
    v_fails := v_fails || format(' (F) the rep got %s cost-free payer rows, expected 2;', v_n);
  END IF;
  IF has_function_privilege('anon', 'public._sales_line_payers(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sales_line_payers(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._sales_line_payers(uuid)', 'EXECUTE') THEN
    v_fails := v_fails || ' (F) an API role may call _sales_line_payers;';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL sales reports per payer:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK sales reports per payer: a 60/40 Bill Split shows each payer their share and own invoice; every total moved by exactly the line; other rows unchanged; a rep sees no cost';
END
$smoke$;
