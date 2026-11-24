-- ============================================================================
-- ROLLED-BACK smoke: a sale's commission is worked out on its profit AFTER the standing discount, never on sales tax
-- ----------------------------------------------------------------------------
-- Migration 20270304100000_commission_after_standing_discount (M4; Mason 2026-11-09: "commission on the profit after
-- discounts"). Commission splits a sale's profit between its recipients (percentages total 100), so the base moves
-- from orders.total_profit to total_profit + the sale's standing discount lines (_order_standing_discount_20270109,
-- the same figure the P&L already uses).
--   A  $1,000 sale, $600 cost, 10% standing discount, 7% tax, 60/40: base $300.00 → $180.00 / $120.00. Tax $63.00 is
--      on the invoice and nowhere in the base. Unticking tax changes nothing.
--   B  Odd cents, 3-way 33.33/33.33/33.34: rows add up to the base exactly
--   C  Bill Split 50/50, payer 1 at 10%, payer 2 at 0%: only payer 1's $50.00 comes off → $350.00
--   D  Half delivered and invoiced (discount on that half only: $350.00), then Cancel Remaining: $150.00
--   E  Fix Delivery (the discounted draft is voided): the restored rows are back on the undiscounted $400.00
--   F  Rep A's row in a payout batch, then the office raises the discount to 20%: rep A stays $180.00, rep B's pending
--      row moves alone ($200.00 × 40% = $80.00)
--   G  No discount: commission rows and the commission history ledger are exactly as today
--   H  A 150-line sale: changing its discount settles at commit in under 4 s (the API's statement timeout is 8 s;
--      attack run 2026-11-25 measured 21 s on the first draft), on the right base
--   I  A discounted sale's split moved from 60/40 to 70/30 by hand: $210.00 / $90.00 on $300.00; then 70.01/29.99: $210.03 / $89.97
--   J  An undiscounted sale's split moved from 60/40 to 70/30 by hand: $280.00 / $120.00 on $400.00 (G stays untouched)
--   Every sale above: the commission base = total_profit + _order_standing_discount_20270109 (the P&L's figure)
--
-- CONTAINER / LOCAL ONLY: completing deliveries draws invoice numbers; the tax rate and discounts are set inside the
-- rolled-back transaction.
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...',
-- so every fixture is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep1 uuid;
  v_rep2 uuid;
  v_customer uuid;
  v_payer2 uuid;
  v_product uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_inv uuid;
  v_delivery uuid;
  v_got text;
  v_ledger_before bigint;
  v_started timestamptz;
  v_ms numeric;
  v_res jsonb;
  v_fails text := '';
BEGIN
  IF to_regclass('public.billing_m4_switch') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs the M4 switch (20270117140000)';
  END IF;
  UPDATE public.billing_m4_switch SET enabled = true;
  UPDATE public.app_settings SET setting_value = '7' WHERE setting_key = 'sales_tax_rate';
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep1 FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_rep2 FROM profiles WHERE role = 'sales_rep' AND is_active = true AND id <> v_rep1 ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_payer2 FROM customers WHERE is_active = true AND id <> v_customer ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_product FROM products WHERE is_active = true AND current_cost > 0 AND current_cost <= 6 AND inventory_unit = 'Gal' ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_rep1 IS NULL OR v_rep2 IS NULL OR v_payer2 IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, two active reps, two active customers and a product';
  END IF;
  -- Fixture: a $6.00/gal cost so the sales read $1,000 / $600, through the app's governed pricing path (as the local
  -- seed prices products), rolled back with everything else.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_res := preview_product_cost_basis_changes('products_inline', NULL,
    (SELECT jsonb_build_array(jsonb_build_object(
       'product_id', p.id, 'row_version', p.pricing_version, 'pricing_mode', 'price_driven',
       'new_cost', '6.00', 'tier1_price', '10.50', 'tier2_price', '10.25', 'tier3_price', '10.00',
       'change_reason', 'Rolled-back smoke', 'basis_type', 'manual_override', 'basis_reason', 'Rolled-back smoke',
       'basis_source', 'products_inline', 'basis_selection', false, 'price_source', 'Rolled-back smoke'))
       FROM products p WHERE p.id = v_product), v_admin, 'smk-cad-price-preview-' || v_suffix);
  IF (v_res ->> 'apply_allowed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the $6 test cost was not allowed: %', left(v_res::text, 500);
  END IF;
  PERFORM approve_pricing_change_set((v_res ->> 'change_set_id')::uuid, v_res ->> 'request_fingerprint',
    COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', w.product_id, 'warning_codes', to_jsonb(w.warning_codes),
                                'reason', 'Rolled-back smoke'))
                FROM pricing_change_set_warnings w WHERE w.change_set_id = (v_res ->> 'change_set_id')::uuid), '[]'::jsonb),
    NULL, v_admin, 'smk-cad-price-approve-' || v_suffix);
  PERFORM apply_product_cost_basis_change_set((v_res ->> 'change_set_id')::uuid, v_res ->> 'request_fingerprint', v_admin,
    'smk-cad-price-apply-' || v_suffix);
  IF (SELECT current_cost FROM products WHERE id = v_product) <> 6 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the test product does not cost $6.00';
  END IF;
  UPDATE customers SET standing_discount_pct = 10 WHERE id = v_customer;
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_payer2;

  EXECUTE $f$
    -- A sale of 100 gal at p_price with cost p_cost, its commission minted the way every sale creator mints it
    -- (_insert_commissions_for_order on orders.total_profit), optionally a 50/50 payer and the tax box.
    CREATE FUNCTION pg_temp.smk_sale(p_admin uuid, p_product uuid, p_customer uuid, p_payer2 uuid, p_price numeric,
                                     p_cost numeric, p_tax boolean, p_split jsonb, p_tag text) RETURNS uuid
    LANGUAGE plpgsql AS $b$
    DECLARE v_order uuid;
    BEGIN
      -- The app's own path (create_direct_order): reserves the stock and mints the commission from the customer's split
      -- on orders.total_profit, as every sale creator does.
      UPDATE customers SET default_commission_split = p_split WHERE id = p_customer;
      v_order := (create_direct_order(p_customer, CURRENT_DATE, '[SMOKE] CAD ' || p_tag, NULL,
        jsonb_build_array(jsonb_build_object('product_id', p_product, 'product_name', '[SMOKE] Commission after discount',
          'quantity', 100, 'price_per_unit', p_price, 'unit_cost', p_cost, 'unit_size', 'Gal')),
        p_admin, 'smk-cad-order-' || p_tag) ->> 'order_id')::uuid;
      IF p_payer2 IS NOT NULL THEN
        INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)
          VALUES (v_order, p_customer, '[SMOKE] main', 50, 0, true, 1), (v_order, p_payer2, '[SMOKE] payer 2', 50, 0, false, 2);
      END IF;
      IF p_tax THEN
        PERFORM set_order_sales_tax(v_order, true, 'smk-cad-tax-' || p_tag);
      END IF;
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      RETURN v_order;
    END $b$;
    -- Deliver p_qty of the 100 gal and draft its invoice(s). Returns the delivery.
    CREATE FUNCTION pg_temp.smk_deliver(p_admin uuid, p_order uuid, p_qty numeric, p_tag text) RETURNS uuid
    LANGUAGE plpgsql AS $b$
    DECLARE v_delivery uuid;
    BEGIN
      INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
        SELECT 'SMK-CAD-' || p_tag, p_order, o.customer_id, 'scheduled', CURRENT_DATE, p_admin FROM orders o WHERE o.id = p_order
        RETURNING id INTO v_delivery;
      INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
        SELECT v_delivery, oi.id, oi.product_id, p_qty, 'Gal' FROM order_items oi WHERE oi.order_id = p_order;
      PERFORM confirm_delivery(v_delivery, p_admin, 'smk-cad-confirm-' || p_tag);
      PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', p_admin, NULL, NULL, NULL,
        'smk-cad-complete-' || p_tag, NULL, 'no_proof', 'Rolled-back smoke; commission after discount');
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      IF NOT EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo') THEN
        PERFORM create_invoice_for_unbilled_delivery(v_delivery, p_admin, 'smk-cad-invoice-' || p_tag);
        SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      END IF;
      RETURN v_delivery;
    END $b$;
    -- The sale's live commission rows, in split order: 'amount/amount/...|order_profit'.
    CREATE FUNCTION pg_temp.smk_rows(p_order uuid) RETURNS text LANGUAGE sql AS $b$
      SELECT string_agg(to_char(commission_amount, 'FM999990.00'), '/' ORDER BY split_percentage DESC, recipient)
             || '|' || to_char(max(order_profit), 'FM999990.00')
        FROM commissions WHERE order_id = p_order AND deleted_at IS NULL AND status <> 'cancelled' $b$;
    CREATE FUNCTION pg_temp.smk_as(p_user uuid) RETURNS void LANGUAGE sql AS $b$
      SELECT set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
             set_config('request.jwt.claim.sub', p_user::text, true) $b$;
  $f$;
  PERFORM pg_temp.smk_as(v_admin);

  -- A: $1,000 / $600 / 10% off / 7% tax / 60-40.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, true,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 60),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 40))), 'a-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (A) the sale did not mint 240/160 on $400 profit: %', pg_temp.smk_rows(v_order);
  END IF;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'a-' || v_suffix);
  SELECT id INTO v_inv FROM invoices WHERE order_id = v_order AND status = 'draft' AND invoice_type = 'chemical_sale';
  v_got := (SELECT string_agg(charge_type || ':' || extended_cents, ',' ORDER BY charge_type) FROM invoice_items
             WHERE invoice_id = v_inv AND charge_type IN ('standing_discount', 'sales_tax'));
  IF v_got IS DISTINCT FROM 'sales_tax:6300,standing_discount:-10000' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (A) the draft is not $1,000 less $100 plus $63 tax: %', v_got;
  END IF;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
    v_fails := v_fails || ' (A) commission is not 180/120 on $300 after the discount: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  PERFORM set_order_sales_tax(v_order, false, 'smk-cad-a-off-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_inv AND charge_type = 'standing_discount')
     OR EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_inv AND charge_type = 'sales_tax') THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (A) unticking did not drop the tax line alone';
  END IF;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
    v_fails := v_fails || ' (A) unticking tax moved commission: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- B: $1,001 / $600, 10% off ($100.10) → $300.90, 3-way.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 33.34),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 33.33),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_admin), 'recipient_user_id', v_admin, 'percentage', 33.33))), 'b-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'b-' || v_suffix);
  IF (SELECT sum(commission_amount) FROM commissions WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled') IS DISTINCT FROM 300.90
     OR (SELECT max(order_profit) FROM commissions WHERE order_id = v_order) IS DISTINCT FROM 300.90 THEN
    v_fails := v_fails || ' (B) the 3-way rows do not add up to $300.90: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- C: Bill Split 50/50, only payer 1 has a discount.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, v_payer2, 10, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 100))), 'c-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'c-' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE order_id = v_order AND status = 'draft') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (C) the Bill Split did not draft two payers';
  END IF;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '350.00|350.00' THEN
    v_fails := v_fails || ' (C) the Bill Split base is not $400 less payer 1''s $50: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- D: half delivered ($500 invoiced, $50 off) → $350; Cancel Remaining → profit $200 less $50 → $150.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 60),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 40))), 'd-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'd-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '210.00/140.00|350.00' THEN
    v_fails := v_fails || ' (D) half invoiced: not 210/140 on $350: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  PERFORM cancel_order(v_order, v_admin, 'smk-cad-d-cancel-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT status FROM orders WHERE id = v_order) <> 'fulfilled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (D) Cancel Remaining did not close the sale';
  END IF;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '90.00/60.00|150.00' THEN
    v_fails := v_fails || ' (D) after Cancel Remaining: not 90/60 on $150: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- E: Fix Delivery voids the discounted draft; the restored rows go back to $400.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 60),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 40))), 'e-' || v_suffix);
  v_delivery := pg_temp.smk_deliver(v_admin, v_order, 100, 'e-' || v_suffix);
  v_res := preview_fix_delivery(v_delivery);
  PERFORM fix_delivery(v_delivery, 'Rolled-back smoke: wrong quantity', v_res ->> 'plan_token', 'smk-cad-e-fix-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF EXISTS (SELECT 1 FROM invoices WHERE order_id = v_order AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (E) Fix Delivery left a live invoice';
  END IF;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (E) after Fix Delivery: not 240/160 on $400: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- F: rep A batched, then 20% off: rep A stays 180.00, rep B = 200 × 40% = 80.00.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 60),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 40))), 'f-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'f-' || v_suffix);
  SELECT id INTO v_inv FROM invoices WHERE order_id = v_order AND status = 'draft' AND invoice_type = 'chemical_sale';
  PERFORM create_commission_payment(
    ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND recipient_user_id = v_rep1 AND status = 'pending'),
    'check', 'SMK-CAD-F', CURRENT_DATE, 'Rolled-back smoke', v_admin, 'smk-cad-f-pay-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_invoice_standing_discount(v_inv, 20, 'smk-cad-f-20-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT extended_cents FROM invoice_items WHERE invoice_id = v_inv AND charge_type = 'standing_discount') IS DISTINCT FROM -20000 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (F) the office discount did not become $200';
  END IF;
  v_got := (SELECT string_agg(to_char(commission_amount, 'FM999990.00') || '@' || to_char(order_profit, 'FM999990.00'), '/'
                              ORDER BY split_percentage DESC)
              FROM commissions WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
  IF v_got IS DISTINCT FROM '180.00@300.00/80.00@200.00' THEN
    v_fails := v_fails || ' (F) batched row moved or pending row not on $200: ' || COALESCE(v_got, 'none') || ';';
  END IF;

  -- G: no discount: rows as minted, no extra history.
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_customer;
  v_ledger_before := (SELECT count(*) FROM commission_earned_state_ledger);
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, true,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 33.34),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 33.33),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_admin), 'recipient_user_id', v_admin, 'percentage', 33.33))), 'g-' || v_suffix);
  v_got := pg_temp.smk_rows(v_order);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'g-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM v_got OR v_got IS DISTINCT FROM '133.69/133.66/133.65|401.00' THEN
    v_fails := v_fails || ' (G) an undiscounted sale''s commission moved: ' || COALESCE(v_got, 'none') || ' → ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  IF (SELECT count(*) FROM commission_earned_state_ledger) - v_ledger_before <> 3 THEN
    v_fails := v_fails || ' (G) an undiscounted sale wrote extra commission history: '
      || ((SELECT count(*) FROM commission_earned_state_ledger) - v_ledger_before) || ' rows;';
  END IF;

  -- H: 150 lines of 10 gal at $10 / $6 ($15,000 sale, $6,000 profit), delivered at 10%, then 20% off: base $3,000.
  UPDATE customers SET standing_discount_pct = 10, default_commission_split = jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 60),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 40)))
   WHERE id = v_customer;
  v_order := (create_direct_order(v_customer, CURRENT_DATE, '[SMOKE] CAD h-' || v_suffix, NULL,
    (SELECT jsonb_agg(jsonb_build_object('product_id', v_product, 'product_name', '[SMOKE] Commission line ' || g,
       'quantity', 10, 'price_per_unit', 10, 'unit_cost', 6, 'unit_size', 'Gal')) FROM generate_series(1, 150) g),
    v_admin, 'smk-cad-order-h-' || v_suffix) ->> 'order_id')::uuid;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 10, 'h-' || v_suffix);
  SELECT id INTO v_inv FROM invoices WHERE order_id = v_order AND status = 'draft' AND invoice_type = 'chemical_sale';
  PERFORM set_invoice_standing_discount(v_inv, 20, 'smk-cad-h-20-' || v_suffix);
  v_started := clock_timestamp();
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_ms := extract(epoch FROM clock_timestamp() - v_started) * 1000;
  IF v_ms > 4000 THEN
    v_fails := v_fails || ' (H) a 150-line discount change took ' || round(v_ms) || ' ms at commit;';
  END IF;
  RAISE NOTICE 'SMOKE (H): a 150-line discount change settled in % ms', round(v_ms);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '1800.00/1200.00|3000.00' THEN
    v_fails := v_fails || ' (H) the 150-line sale is not 1800/1200 on $3,000: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- I: the split moved on a discounted sale.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 60),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 40))), 'i-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'i-' || v_suffix);
  UPDATE commissions SET split_percentage = CASE WHEN recipient_user_id = v_rep1 THEN 70 ELSE 30 END
   WHERE order_id = v_order AND status = 'pending';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '210.00/90.00|300.00' THEN
    v_fails := v_fails || ' (I) a changed split on a discounted sale did not move: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  -- I2: a one-cent split change (70/30 → 70.01/29.99 on $300 moves $0.03) is not lost in any tolerance (Luna MED).
  UPDATE commissions SET split_percentage = CASE WHEN recipient_user_id = v_rep1 THEN 70.01 ELSE 29.99 END
   WHERE order_id = v_order AND status = 'pending';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '210.03/89.97|300.00' THEN
    v_fails := v_fails || ' (I) a one-cent split change did not move: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- J: the split moved on an undiscounted sale (no customer discount; tax only).
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_customer;
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, true,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 60),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 40))), 'j-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'j-' || v_suffix);
  UPDATE commissions SET split_percentage = CASE WHEN recipient_user_id = v_rep1 THEN 70 ELSE 30 END
   WHERE order_id = v_order AND status = 'pending';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '280.00/120.00|400.00' THEN
    v_fails := v_fails || ' (J) a changed split on an undiscounted sale did not move: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- Every sale: the stored base is the P&L's profit after discount.
  v_got := (SELECT string_agg(o.order_name || ' ' || c.order_profit || ' vs ' || (o.total_profit + _order_standing_discount_20270109(o.id)), '; ')
              FROM orders o JOIN commissions c ON c.order_id = o.id AND c.status = 'pending' AND c.deleted_at IS NULL
             WHERE o.order_name LIKE '[SMOKE] CAD %' AND o.order_name NOT LIKE '[SMOKE] CAD f-%'
               AND c.order_profit IS DISTINCT FROM o.total_profit + _order_standing_discount_20270109(o.id));
  IF v_got IS NOT NULL THEN
    v_fails := v_fails || ' (base) a commission base differs from the P&L profit after discount: ' || v_got || ';';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: commission is on the profit after the standing discount, never on tax (A-J)';
END
$smoke$;
