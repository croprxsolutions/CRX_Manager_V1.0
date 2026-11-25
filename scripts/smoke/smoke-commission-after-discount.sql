-- ============================================================================
-- ROLLED-BACK smoke: a sale's commission settles on its profit AFTER the standing discount when its chemical-sale
-- invoices are posted, voided or unposted; never on sales tax; drafts never move it
-- ----------------------------------------------------------------------------
-- Migration 20270306100000_commission_settles_on_posting (M4; Mason 2026-11-09: "commission on the profit after
-- discounts"; re-planned 2026-11-25 after the commit-time design drew HIGHs in five review rounds). Base =
-- total_profit + D × booked ÷ billed over the sale's POSTED chemical-sale invoices (D their standing-discount cents,
-- billed their product cents, booked orders.total_price); when billed ≥ booked, total_profit + D (Taha, rule "b").
--   A  $1,000 sale, $600 cost, 10% off, 7% tax, 60/40: the draft leaves $240.00 / $160.00 on $400.00; posting puts
--      $180.00 / $120.00 on $300.00 (tax $63.00 on the invoice, never in the base). Tax box off: the same
--   B  Odd cents, 3-way: $100.32 / $100.29 / $100.29 on $300.90 (each recipient)
--   C  Bill Split 50/50, payer 1 at 10%, payer 2 at 0%, posted as one group: only payer 1's $50.00 comes off → $350.00
--   D  Before any invoice $400.00; half invoiced as a draft: still $400.00; posted: $300.00, and the P&L's billed
--      share earns $150.00 (Sol HIGH 1); Cancel Remaining: $90.00 / $60.00 on $150.00
--   E  Fix Delivery on a posted invoice (voids it, restores the commission): the rows are back on $400.00
--   F  Half posted ($300), rep A's row batched, the second half posted at 20%: rep A stays $180.00, rep B is its own
--      40% of $250.00 = $100.00
--   G  No discount: rows as minted, no extra history (the posting writes nothing)
--   H  A 150-line invoice at 20% posts in under 4 s (API statement timeout 8 s): $1,800.00 / $1,200.00 on $3,000.00
--   K  The 60% row cancelled, soft-deleted or moved away, then the invoice posted: the 40% row is 40% of $300.00
--      (Sol HIGH 2)
--   M  $330.93 split 50/50 ($165.47 / $165.46), the $165.47 row batched, settled again on the same base: no cent
--      moves (Sol MED 10)
--   O  A posted invoice unposted: back to $400.00
--   S  Both rows batched (one payout each), the second half posted at 20%, the payouts voided: the rows come back on
--      $250.00
--   T  A chemical-sale invoice can't be born posted through save_invoice (it would skip the posting trigger)
--   V  Both rows batched before the discount, then the payouts voided one at a time: still $165.47 / $165.46 = $330.93
--   W  Only the lower-id row batched before the discount, its payout voided after posting: the pair totals $330.93
--   X  Posted, both rows batched, unposted, both payouts voided: back on $400.00
--
-- CONTAINER / LOCAL ONLY: completing deliveries and posting draw invoice numbers; the tax rate and discounts are set
-- inside the rolled-back transaction.
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
  v_order2 uuid;
  v_pay uuid;
  v_pay2 uuid;
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
      v_order := (create_direct_order(p_customer, (now() AT TIME ZONE 'America/Chicago')::date, '[SMOKE] CAD ' || p_tag, NULL,
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
        SELECT 'SMK-CAD-' || p_tag, p_order, o.customer_id, 'scheduled', (now() AT TIME ZONE 'America/Chicago')::date, p_admin FROM orders o WHERE o.id = p_order
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
    -- Post a draft the way the screen does (with the version it loaded).
    CREATE FUNCTION pg_temp.smk_post(p_inv uuid, p_tag text) RETURNS void LANGUAGE plpgsql AS $b$
    BEGIN
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      PERFORM post_invoice(p_inv, public._invoice_post_version(p_inv), 'smk-cad-post-' || p_tag);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    END $b$;
    -- The sale's newest draft chemical-sale invoice.
    CREATE FUNCTION pg_temp.smk_draft(p_order uuid) RETURNS uuid LANGUAGE sql AS $b$
      SELECT id FROM invoices WHERE order_id = p_order AND status = 'draft' AND invoice_type = 'chemical_sale'
       ORDER BY created_at DESC, id LIMIT 1 $b$;
    CREATE FUNCTION pg_temp.smk_split(p1 uuid, pct1 numeric, p2 uuid, pct2 numeric) RETURNS jsonb LANGUAGE sql AS $b$
      SELECT jsonb_build_object('splits', jsonb_agg(x)) FROM (
        SELECT jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = p1), 'recipient_user_id', p1, 'percentage', pct1) x
        UNION ALL
        SELECT jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = p2), 'recipient_user_id', p2, 'percentage', pct2)
         WHERE p2 IS NOT NULL) s $b$;
    -- What the P&L earns on the sale today: its billed share of the rows (_report_billed_part_cents_20270203) over the
    -- posted invoices.
    CREATE FUNCTION pg_temp.smk_earned(p_order uuid) RETURNS numeric LANGUAGE sql AS $b$
      SELECT public._report_billed_part_cents_20270203(sum(c.commission_amount) * 100,
               (SELECT sum(b.extended_cents) FROM invoice_items b JOIN order_items oi ON oi.id = b.order_item_id
                  JOIN invoices i ON i.id = b.invoice_id
                 WHERE oi.order_id = p_order AND b.charge_type IS NULL AND b.product_id IS NOT NULL
                   AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL),
               (SELECT round(total_price * 100) FROM orders WHERE id = p_order))
        FROM commissions c WHERE c.order_id = p_order AND c.deleted_at IS NULL AND c.status <> 'cancelled' $b$;
  $f$;
  PERFORM pg_temp.smk_as(v_admin);

  -- A: the draft leaves the rows; posting settles them. Tax on, then a second sale with tax off.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, true, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'a-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'a-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  v_got := (SELECT string_agg(charge_type || ':' || extended_cents, ',' ORDER BY charge_type) FROM invoice_items
             WHERE invoice_id = v_inv AND charge_type IN ('standing_discount', 'sales_tax'));
  IF v_got IS DISTINCT FROM 'sales_tax:6300,standing_discount:-10000' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (A) the draft is not $1,000 less $100 plus $63 tax: %', v_got;
  END IF;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (A) a draft moved commission: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  PERFORM pg_temp.smk_post(v_inv, 'a-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
    v_fails := v_fails || ' (A) posting did not put commission on $300 after the discount: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'a2-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'a2-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'a2-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
    v_fails := v_fails || ' (A) with the tax box off, not 180/120 on $300: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- B: $1,001 / $600, 10% off ($100.10) → $300.90, 3-way, each recipient.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 33.34),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 33.33),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_admin), 'recipient_user_id', v_admin, 'percentage', 33.33))), 'b-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'b-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'b-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '100.32/100.29/100.29|300.90' THEN
    v_fails := v_fails || ' (B) the 3-way rows are not 100.32/100.29/100.29 on $300.90: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- C: Bill Split 50/50, only payer 1 has a discount.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, v_payer2, 10, 6, false, pg_temp.smk_split(v_rep1, 100, NULL, NULL), 'c-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'c-' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE order_id = v_order AND status = 'draft') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (C) the Bill Split did not draft two payers';
  END IF;
  -- A Bill Split posts as one group.
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_inv := (SELECT invoice_group_id FROM invoices WHERE order_id = v_order AND status = 'draft' LIMIT 1);
  PERFORM post_invoice_group(v_inv, v_admin,
    (SELECT jsonb_object_agg(id, public._invoice_post_version(id)) FROM invoices WHERE invoice_group_id = v_inv AND deleted_at IS NULL),
    'smk-cad-c-post-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '350.00|350.00' THEN
    v_fails := v_fails || ' (C) both payers posted: not $400 less payer 1''s $50: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- D: part-invoiced.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'd-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (D) before any invoice: not 240/160 on $400: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'd-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (D) the half-invoice draft moved commission: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'd-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
    v_fails := v_fails || ' (D) half posted: not 180/120 on $300: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  IF pg_temp.smk_earned(v_order) IS DISTINCT FROM 15000 THEN
    v_fails := v_fails || ' (D) half posted: the P&L earns ' || COALESCE(pg_temp.smk_earned(v_order)::text, 'none') || ' cents, not 15000;';
  END IF;
  PERFORM cancel_order(v_order, v_admin, 'smk-cad-d-cancel-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT status FROM orders WHERE id = v_order) <> 'fulfilled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: (D) Cancel Remaining did not close the sale';
  END IF;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '90.00/60.00|150.00' THEN
    v_fails := v_fails || ' (D) after Cancel Remaining: not 90/60 on $150: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- E: posted, then Fix Delivery (it voids the posted invoice and restores the commission): back to $400.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'e-' || v_suffix);
  v_delivery := pg_temp.smk_deliver(v_admin, v_order, 100, 'e-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM pg_temp.smk_post(v_inv, 'e-' || v_suffix);
  v_res := preview_fix_delivery(v_delivery);
  PERFORM fix_delivery(v_delivery, 'Rolled-back smoke: wrong quantity', v_res ->> 'plan_token', 'smk-cad-e-fix-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (E) after void + Fix Delivery: not 240/160 on $400: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- F: half posted, rep A batched, the second half posted at 20%.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'f-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'f1-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'f1-' || v_suffix);
  PERFORM create_commission_payment(
    ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND recipient_user_id = v_rep1 AND status = 'pending'),
    'check', 'SMK-CAD-F', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-f-pay-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'f2-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM set_invoice_standing_discount(v_inv, 20, 'smk-cad-f-20-' || v_suffix);
  PERFORM pg_temp.smk_post(v_inv, 'f2-' || v_suffix);
  v_got := (SELECT string_agg(to_char(commission_amount, 'FM999990.00') || '@' || to_char(order_profit, 'FM999990.00'), '/'
                              ORDER BY split_percentage DESC)
              FROM commissions WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
  IF v_got IS DISTINCT FROM '180.00@300.00/100.00@250.00' THEN
    v_fails := v_fails || ' (F) batched row moved or pending row not 40% of $250: ' || COALESCE(v_got, 'none') || ';';
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
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'g-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM v_got OR v_got IS DISTINCT FROM '133.69/133.66/133.65|401.00' THEN
    v_fails := v_fails || ' (G) an undiscounted sale''s commission moved: ' || COALESCE(v_got, 'none') || ' → ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  IF (SELECT count(*) FROM commission_earned_state_ledger) - v_ledger_before <> 3 THEN
    v_fails := v_fails || ' (G) an undiscounted sale wrote extra commission history: '
      || ((SELECT count(*) FROM commission_earned_state_ledger) - v_ledger_before) || ' rows;';
  END IF;

  -- H: 150 lines of 10 gal at $10 / $6 ($15,000, $6,000 profit), delivered, 20% off, posted: base $3,000.
  UPDATE customers SET standing_discount_pct = 10, default_commission_split = pg_temp.smk_split(v_rep1, 60, v_rep2, 40) WHERE id = v_customer;
  v_order := (create_direct_order(v_customer, (now() AT TIME ZONE 'America/Chicago')::date, '[SMOKE] CAD h-' || v_suffix, NULL,
    (SELECT jsonb_agg(jsonb_build_object('product_id', v_product, 'product_name', '[SMOKE] Commission line ' || g,
       'quantity', 10, 'price_per_unit', 10, 'unit_cost', 6, 'unit_size', 'Gal')) FROM generate_series(1, 150) g),
    v_admin, 'smk-cad-order-h-' || v_suffix) ->> 'order_id')::uuid;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 10, 'h-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM set_invoice_standing_discount(v_inv, 20, 'smk-cad-h-20-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_started := clock_timestamp();
  PERFORM post_invoice(v_inv, public._invoice_post_version(v_inv), 'smk-cad-post-h-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_ms := extract(epoch FROM clock_timestamp() - v_started) * 1000;
  IF v_ms > 4000 THEN
    v_fails := v_fails || ' (H) posting a 150-line invoice took ' || round(v_ms) || ' ms;';
  END IF;
  RAISE NOTICE 'SMOKE (H): a 150-line discounted invoice posted in % ms', round(v_ms);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '1800.00/1200.00|3000.00' THEN
    v_fails := v_fails || ' (H) the 150-line sale is not 1800/1200 on $3,000: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- K: the 60% row leaves three ways before posting; the 40% row is 40% of the base.
  v_order2 := NULL;
  FOR i IN 1..3 LOOP
    v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'k' || i || '-' || v_suffix);
    PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'k' || i || '-' || v_suffix);
    IF i = 1 THEN
      UPDATE commissions SET status = 'cancelled' WHERE order_id = v_order AND recipient_user_id = v_rep1;
    ELSIF i = 2 THEN
      UPDATE commissions SET deleted_at = now() WHERE order_id = v_order AND recipient_user_id = v_rep1;
    ELSE
      UPDATE commissions SET order_id = v_order2 WHERE order_id = v_order AND recipient_user_id = v_rep1;
    END IF;
    PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'k' || i || '-' || v_suffix);
    IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '120.00|300.00' THEN
      v_fails := v_fails || ' (K' || i || ') the 40% row is not 40% of $300: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
    END IF;
    v_order2 := v_order;
  END LOOP;

  -- M: $1,001.00 sale, $600.00 cost, 7% off ($70.07) → $330.93 split 50/50; batch the $165.47 row; settle again.
  UPDATE customers SET standing_discount_pct = 7 WHERE id = v_customer;
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false, pg_temp.smk_split(v_rep1, 50, v_rep2, 50), 'm-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'm-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'm-' || v_suffix);
  v_got := (SELECT string_agg(to_char(commission_amount, 'FM999990.00'), '/' ORDER BY commission_amount DESC)
              FROM commissions WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
  IF v_got IS DISTINCT FROM '165.47/165.46' THEN
    v_fails := v_fails || ' (M) $330.93 did not split 165.47/165.46: ' || COALESCE(v_got, 'none') || ';';
  ELSE
    PERFORM create_commission_payment(
      ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND commission_amount = 165.47 AND status = 'pending'),
      'check', 'SMK-CAD-M', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-m-pay-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF NOT EXISTS (SELECT 1 FROM commission_payment_items cpi JOIN commissions c ON c.id = cpi.commission_id
                    WHERE c.order_id = v_order AND c.commission_amount = 165.47) THEN
      RAISE EXCEPTION 'SMOKE_SETUP: (M) the $165.47 row is not in a batch';
    END IF;
    IF to_regprocedure('public._settle_order_commission_20270306(uuid)') IS NULL THEN
      v_fails := v_fails || ' (M) no settle helper;';
    ELSE
      PERFORM public._settle_order_commission_20270306(v_order);
    END IF;
    v_got := (SELECT string_agg(to_char(commission_amount, 'FM999990.00'), '/' ORDER BY commission_amount DESC)
                FROM commissions WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
    IF v_got IS DISTINCT FROM '165.47/165.46' THEN
      v_fails := v_fails || ' (M) settling an unchanged base after a batch moved a cent: ' || COALESCE(v_got, 'none') || ';';
    END IF;
  END IF;
  UPDATE customers SET standing_discount_pct = 10 WHERE id = v_customer;

  -- O: posted, then unposted: back to $400.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'o-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'o-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM pg_temp.smk_post(v_inv, 'o-' || v_suffix);
  PERFORM unpost_invoice(v_inv, v_admin, 'smk-cad-o-unpost-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (O) unposting did not put commission back on $400: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- S: both rows batched on $300, the second half posted at 20% ($250), the payout voided: rows back on $250.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 's-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 's1-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 's1-' || v_suffix);
  v_pay := create_commission_payment(
    ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND status = 'pending' AND recipient_user_id = v_rep1),
    'check', 'SMK-CAD-S1', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-s-pay1-' || v_suffix);
  v_pay2 := create_commission_payment(
    ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND status = 'pending' AND recipient_user_id = v_rep2),
    'check', 'SMK-CAD-S2', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-s-pay2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 's2-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM set_invoice_standing_discount(v_inv, 20, 'smk-cad-s-20-' || v_suffix);
  PERFORM pg_temp.smk_post(v_inv, 's2-' || v_suffix);
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
    v_fails := v_fails || ' (S) batched rows moved: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;
  PERFORM void_commission_payment(v_pay, 'Rolled-back smoke', v_admin, 'smk-cad-s-void1-' || v_suffix);
  PERFORM void_commission_payment(v_pay2, 'Rolled-back smoke', v_admin, 'smk-cad-s-void2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '150.00/100.00|250.00' THEN
    v_fails := v_fails || ' (S) after the payout void, the rows are not on $250: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- V: both rows batched on $401 (one payout each, no discount yet), then posted at 7% ($330.93), then the payouts
  -- voided one at a time, higher id first: the rows still add up to $330.93 (Sol r1 H1).
  UPDATE customers SET standing_discount_pct = 7 WHERE id = v_customer;
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false, pg_temp.smk_split(v_rep1, 50, v_rep2, 50), 'v-' || v_suffix);
  SELECT id INTO v_pay FROM commissions WHERE order_id = v_order ORDER BY id DESC LIMIT 1;  -- the higher id
  v_pay2 := create_commission_payment(ARRAY[v_pay], 'check', 'SMK-CAD-V1', (now() AT TIME ZONE 'America/Chicago')::date,
    'Rolled-back smoke', v_admin, 'smk-cad-v-pay1-' || v_suffix);
  v_order2 := create_commission_payment(ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND id <> v_pay),
    'check', 'SMK-CAD-V2', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-v-pay2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'v-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'v-' || v_suffix);
  PERFORM void_commission_payment(v_pay2, 'Rolled-back smoke', v_admin, 'smk-cad-v-void1-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM void_commission_payment(v_order2, 'Rolled-back smoke', v_admin, 'smk-cad-v-void2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_got := (SELECT string_agg(to_char(commission_amount, 'FM999990.00'), '/' ORDER BY commission_amount DESC) || '|'
                   || to_char(sum(commission_amount), 'FM999990.00')
              FROM commissions WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
  IF v_got IS DISTINCT FROM '165.47/165.46|330.93' THEN
    v_fails := v_fails || ' (V) two payouts voided in turn: rows are ' || COALESCE(v_got, 'none') || ', not 165.47/165.46 = 330.93;';
  END IF;
  UPDATE customers SET standing_discount_pct = 10 WHERE id = v_customer;

  -- W: only the lower-id row batched before the discount, posted at 7% ($330.93), the payout voided: the pair still
  -- totals $330.93 (independent review MED-1).
  UPDATE customers SET standing_discount_pct = 7 WHERE id = v_customer;
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false, pg_temp.smk_split(v_rep1, 50, v_rep2, 50), 'w-' || v_suffix);
  v_pay := create_commission_payment(ARRAY(SELECT id FROM commissions WHERE order_id = v_order ORDER BY id LIMIT 1),
    'check', 'SMK-CAD-W', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-w-pay-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'w-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'w-' || v_suffix);
  PERFORM void_commission_payment(v_pay, 'Rolled-back smoke', v_admin, 'smk-cad-w-void-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_got := (SELECT to_char(sum(commission_amount), 'FM999990.00') FROM commissions
             WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
  IF v_got IS DISTINCT FROM '330.93' THEN
    v_fails := v_fails || ' (W) one payout voided after the discount: rows total ' || COALESCE(v_got, 'none') || ', not 330.93;';
  END IF;
  UPDATE customers SET standing_discount_pct = 10 WHERE id = v_customer;

  -- X: posted ($300), both rows batched (one payout each), the invoice unposted, then both payouts voided: the rows go
  -- back on $400 (attack run F1).
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'x-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'x-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM pg_temp.smk_post(v_inv, 'x-' || v_suffix);
  v_pay := create_commission_payment(ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND recipient_user_id = v_rep1),
    'check', 'SMK-CAD-X1', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-x-pay1-' || v_suffix);
  v_pay2 := create_commission_payment(ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND recipient_user_id = v_rep2),
    'check', 'SMK-CAD-X2', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-x-pay2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM unpost_invoice(v_inv, v_admin, 'smk-cad-x-unpost-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM void_commission_payment(v_pay, 'Rolled-back smoke', v_admin, 'smk-cad-x-void1-' || v_suffix);
  PERFORM void_commission_payment(v_pay2, 'Rolled-back smoke', v_admin, 'smk-cad-x-void2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (X) unposted then payouts voided: rows not back on $400: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- T: a chemical-sale invoice can't be born posted through save_invoice.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 't-' || v_suffix);
  BEGIN
    PERFORM save_invoice(jsonb_build_object('order_id', v_order, 'customer_id', v_customer, 'invoice_type', 'chemical_sale',
      'status', 'posted', 'invoice_date', ((now() AT TIME ZONE 'America/Chicago')::date)::text),
      (SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'product_id', oi.product_id, 'description', oi.product_name,
                'quantity', 10, 'unit_price_cents', 1000, 'extended_cents', 10000, 'cost_cents', 600, 'unit_size', 'Gal'))
         FROM order_items oi WHERE oi.order_id = v_order),
      'smk-cad-t-' || v_suffix);
    IF EXISTS (SELECT 1 FROM invoices WHERE order_id = v_order AND status = 'posted') THEN
      v_fails := v_fails || ' (T) save_invoice created a posted chemical sale;';
    END IF;
  EXCEPTION WHEN raise_exception OR check_violation OR insufficient_privilege THEN
    NULL;  -- refused: the posting trigger is the only way in
  END;

  -- Every fully posted discounted sale: the stored base is the P&L's profit after discount.
  v_got := (SELECT string_agg(o.order_name || ' ' || c.order_profit || ' vs ' || (o.total_profit + _order_standing_discount_20270109(o.id)), '; ')
              FROM orders o JOIN commissions c ON c.order_id = o.id AND c.status = 'pending' AND c.deleted_at IS NULL
             WHERE o.order_name LIKE '[SMOKE] CAD %-' || v_suffix
               AND o.order_name !~ '\[SMOKE\] CAD (d|f|s|c|e|o|t|g|k2|v|w|x)-'  -- part-posted, unposted or none; k2 holds k3's moved row
               AND c.order_profit IS DISTINCT FROM o.total_profit + _order_standing_discount_20270109(o.id));
  IF v_got IS NOT NULL THEN
    v_fails := v_fails || ' (base) a commission base differs from the P&L profit after discount: ' || v_got || ';';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: commission settles on posting, on the profit after the standing discount, never on tax (A-X)';
END
$smoke$;
