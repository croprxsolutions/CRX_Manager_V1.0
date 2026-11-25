-- ============================================================================
-- ROLLED-BACK smoke: a sale's commission settles on its profit AFTER the standing discount when its chemical-sale
-- invoices are posted, voided or unposted; never on sales tax; drafts never move it
-- ----------------------------------------------------------------------------
-- Migration 20270307220000_commission_settles_on_posting (M4; Mason 2026-11-09: "commission on the profit after
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
--   I  An invoice inserted straight into posted is refused, and so is a line added to a posted one; with that lock
--      lifted (a later M6 writer), the added lines settle: $180.00 / $120.00 on $300.00 (Sol posting r5 HIGH 4)
--   K  The 60% row cancelled, soft-deleted or moved away, then the invoice posted: the 40% row is 40% of $300.00
--      (Sol HIGH 2)
--   L  Legacy rows already on $300 (unmarked), posted then unposted: back on $400 (Sol posting r4 MED 5)
--   M  $330.93 split 50/50 ($165.47 / $165.46), the $165.47 row batched, settled again on the same base: no cent
--      moves (Sol MED 10)
--   N  A NaN total_price on a half-posted sale: the settle leaves the rows as they are (Sol posting r4 MED 7)
--   O  A posted invoice unposted: back to $400.00
--   P  Half posted, then the invoice's header order cleared (a legacy NULL-header invoice): the rows stay on the
--      rule's $300.00, never the whole-discount $350.00 (Sol posting r5 HIGH 3)
--   Q  50/25/25 on $300.90, a frozen row and a pending one tie after a payout void: never over $300.90 (r4 MED 6)
--   R  Half posted at 10% on a legacy blank-header invoice, the other half posted at 0% on a normal one: fully billed,
--      $210.00 / $140.00 on $350.00, not the scaled-up $300.00 (Sol posting r6 H1)
--   S  Both rows batched (one payout each), the second half posted at 20%, the payouts voided: the rows come back on
--      $250.00
--   T  A chemical-sale invoice can't be born posted through save_invoice (it would skip the posting trigger)
--   U  $300.90 at 50/25/25, both 25% rows rounded up to $75.23 (one batched), the 50% row moved: the set stays
--      $300.90, never $300.91 (Sol posting r6 H2)
--   V  Half posted, both rows batched, the rest posted, the payouts voided one at a time: the rows add up to the base
--      (each invoice rounds its own 7%: $330.92) and differ by at most a cent
--   W  Half posted, the lower-id row batched, the rest posted, its payout voided: the pair adds up to the base
--   X  Posted (rows marked as settled), both rows batched, unposted, both payouts voided: back on $400.00
--   Y  Two half invoices posted, Fix Delivery on the first, the second unposted: the restored rows go back on $400.00
--   Z  $330.93 posted, the $165.47 row batched, unposted and posted again: the pair still totals $330.93
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
  v_ok boolean;
  v_new uuid;
  v_cols text;
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
    -- The candidate's base, or NULL before it exists (the prover runs this file before the migration too).
    CREATE FUNCTION pg_temp.smk_base(p_order uuid) RETURNS numeric LANGUAGE plpgsql AS $b$
    DECLARE v numeric;
    BEGIN
      IF to_regprocedure('public._order_commission_base_20270306(uuid)') IS NULL THEN RETURN NULL; END IF;
      EXECUTE 'SELECT public._order_commission_base_20270306($1)' INTO v USING p_order;
      RETURN v;
    END $b$;
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

  -- V: half posted at 7% (rows on the part-billed base), both rows batched (one payout each), the rest posted
  -- ($330.93), the payouts voided one at a time, higher id first: the rows add up to $330.93 (Sol posting r1 H1).
  UPDATE customers SET standing_discount_pct = 7 WHERE id = v_customer;
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false, pg_temp.smk_split(v_rep1, 50, v_rep2, 50), 'v-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'v1-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'v1-' || v_suffix);
  SELECT id INTO v_pay FROM commissions WHERE order_id = v_order ORDER BY id DESC LIMIT 1;  -- the higher id
  v_pay2 := create_commission_payment(ARRAY[v_pay], 'check', 'SMK-CAD-V1', (now() AT TIME ZONE 'America/Chicago')::date,
    'Rolled-back smoke', v_admin, 'smk-cad-v-pay1-' || v_suffix);
  v_order2 := create_commission_payment(ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND id <> v_pay),
    'check', 'SMK-CAD-V2', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-v-pay2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'v2-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'v2-' || v_suffix);
  PERFORM void_commission_payment(v_pay2, 'Rolled-back smoke', v_admin, 'smk-cad-v-void1-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM void_commission_payment(v_order2, 'Rolled-back smoke', v_admin, 'smk-cad-v-void2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  -- Each invoice rounds its own 7%, so the base is the sale's actual posted discount (two invoices: $330.92).
  v_got := (SELECT string_agg(to_char(commission_amount, 'FM999990.00'), '/' ORDER BY commission_amount DESC)
                   || ' of ' || to_char(pg_temp.smk_base(v_order), 'FM999990.00')
              FROM commissions WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled'
            HAVING sum(commission_amount) = pg_temp.smk_base(v_order)
               AND max(commission_amount) - min(commission_amount) <= 0.01);
  IF v_got IS NULL THEN
    v_fails := v_fails || ' (V) two payouts voided in turn: rows do not add up to the base: '
      || (SELECT string_agg(to_char(commission_amount, 'FM999990.00'), '/') FROM commissions WHERE order_id = v_order AND status <> 'cancelled')
      || ' vs ' || COALESCE(pg_temp.smk_base(v_order)::text, 'no base') || ';';
  END IF;

  -- W: half posted at 7%, only the lower-id row batched, the rest posted, the payout voided: the pair totals $330.93.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false, pg_temp.smk_split(v_rep1, 50, v_rep2, 50), 'w-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'w1-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'w1-' || v_suffix);
  v_pay := create_commission_payment(ARRAY(SELECT id FROM commissions WHERE order_id = v_order ORDER BY id LIMIT 1),
    'check', 'SMK-CAD-W', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-w-pay-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'w2-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'w2-' || v_suffix);
  PERFORM void_commission_payment(v_pay, 'Rolled-back smoke', v_admin, 'smk-cad-w-void-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT sum(commission_amount) FROM commissions WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled')
     IS DISTINCT FROM pg_temp.smk_base(v_order) THEN
    v_fails := v_fails || ' (W) one payout voided after the rest posted: rows total '
      || (SELECT sum(commission_amount) FROM commissions WHERE order_id = v_order AND status <> 'cancelled')
      || ', not the base ' || COALESCE(pg_temp.smk_base(v_order)::text, 'no base') || ';';
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
  -- The rows carry the settle's mark, not a surviving discount line, as evidence (Sol posting r2 H3).
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.commissions'::regclass AND attname = 'discount_settled_at') THEN
    v_fails := v_fails || ' (X) the settled rows are not marked (no column);';
  ELSE
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM commissions WHERE order_id = $1 AND discount_settled_at IS NOT NULL)' INTO v_ok USING v_order;
    IF NOT v_ok THEN
      v_fails := v_fails || ' (X) the settled rows are not marked;';
    END IF;
  END IF;
  PERFORM void_commission_payment(v_pay, 'Rolled-back smoke', v_admin, 'smk-cad-x-void1-' || v_suffix);
  PERFORM void_commission_payment(v_pay2, 'Rolled-back smoke', v_admin, 'smk-cad-x-void2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (X) unposted then payouts voided: rows not back on $400: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- Y: two half invoices at 10%, both posted ($300); Fix Delivery on the first (rows cancelled, restored at $300 with
  -- their mark); then the second unposted: the restored rows go back on $400 (Sol posting r3 H1).
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'y-' || v_suffix);
  v_delivery := pg_temp.smk_deliver(v_admin, v_order, 50, 'y1-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'y1-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'y2-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM pg_temp.smk_post(v_inv, 'y2-' || v_suffix);
  v_res := preview_fix_delivery(v_delivery);
  PERFORM fix_delivery(v_delivery, 'Rolled-back smoke: wrong quantity', v_res ->> 'plan_token', 'smk-cad-y-fix-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM unpost_invoice(v_inv, v_admin, 'smk-cad-y-unpost-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (Y) Fix Delivery''s restored rows did not go back on $400 after the unpost: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- Z: $330.93 split 50/50 posted, the $165.47 row batched, the invoice unposted and posted again: the pair still totals
  -- the base, not a cent over (Sol posting r3 MED 9).
  UPDATE customers SET standing_discount_pct = 7 WHERE id = v_customer;
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false, pg_temp.smk_split(v_rep1, 50, v_rep2, 50), 'z-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'z-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM pg_temp.smk_post(v_inv, 'z1-' || v_suffix);
  IF NOT EXISTS (SELECT 1 FROM commissions WHERE order_id = v_order AND commission_amount = 165.47) THEN
    v_fails := v_fails || ' (Z) unpost and repost: $330.93 did not split 165.47/165.46 first;';
  ELSE
    v_pay := create_commission_payment(ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND commission_amount = 165.47),
      'check', 'SMK-CAD-Z', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-z-pay-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    PERFORM unpost_invoice(v_inv, v_admin, 'smk-cad-z-unpost-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    PERFORM pg_temp.smk_post(v_inv, 'z2-' || v_suffix);
    v_got := (SELECT to_char(sum(commission_amount), 'FM999990.00') FROM commissions
               WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
    IF v_got IS DISTINCT FROM '330.93' THEN
      v_fails := v_fails || ' (Z) unpost and repost with a frozen row: rows total ' || COALESCE(v_got, 'none') || ', not 330.93;';
    END IF;
  END IF;
  UPDATE customers SET standing_discount_pct = 10 WHERE id = v_customer;

  -- L: legacy rows already on the discounted base ($180 / $120 on $300, unmarked, as a backfilled sale has them), the
  -- invoice posted, then unposted: the rows go back on $400 (Sol posting r4 MED 5).
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'l-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'l-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  UPDATE commissions SET order_profit = 300, commission_amount = split_percentage * 3
   WHERE order_id = v_order AND deleted_at IS NULL AND status = 'pending';
  PERFORM pg_temp.smk_post(v_inv, 'l-' || v_suffix);
  PERFORM unpost_invoice(v_inv, v_admin, 'smk-cad-l-unpost-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '240.00/160.00|400.00' THEN
    v_fails := v_fails || ' (L) legacy rows already on $300 did not go back on $400 after the unpost: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- Q: $1,001 / $600, 50/25/25. Half posted at 20% ($200.80), the lower-id 25% row batched, the rest posted at 0%
  -- ($300.90: the 25% row left pending rounds its own $75.225 up), the 50% row batched, the first payout voided: the
  -- set never goes over $300.90 (Sol posting r4 MED 6).
  UPDATE customers SET standing_discount_pct = 20 WHERE id = v_customer;
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 50),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 25),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_admin), 'recipient_user_id', v_admin, 'percentage', 25))), 'q-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'q1-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'q1-' || v_suffix);
  v_pay := create_commission_payment(
    ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND split_percentage = 25 ORDER BY id LIMIT 1),
    'check', 'SMK-CAD-Q1', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-q-pay1-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_customer;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'q2-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'q2-' || v_suffix);
  PERFORM create_commission_payment(ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND split_percentage = 50),
    'check', 'SMK-CAD-Q2', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-q-pay2-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM void_commission_payment(v_pay, 'Rolled-back smoke', v_admin, 'smk-cad-q-void-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_got := (SELECT to_char(sum(commission_amount), 'FM999990.00') FROM commissions
             WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
  IF v_got IS DISTINCT FROM '300.90' THEN
    v_fails := v_fails || ' (Q) a frozen row and a pending one tied: rows total ' || COALESCE(v_got, 'none') || ', not 300.90;';
  END IF;
  UPDATE customers SET standing_discount_pct = 10 WHERE id = v_customer;

  -- N: half posted ($180 / $120 on $300), then a legacy NaN total_price: the settle leaves the sale as it is, never the
  -- unscaled discount ($350) (Sol posting r4 MED 7). The live finite check is dropped inside this rolled-back run.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'n-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'n-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'n-' || v_suffix);
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_total_price_finite;
  UPDATE orders SET total_price = 'NaN' WHERE id = v_order;
  IF to_regprocedure('public._settle_order_commission_20270306(uuid)') IS NULL THEN
    v_fails := v_fails || ' (N) no settle helper;';
  ELSE
    PERFORM public._settle_order_commission_20270306(v_order);
    IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
      v_fails := v_fails || ' (N) a NaN total_price moved the rows: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
    END IF;
  END IF;

  -- I: a counted invoice can't gain lines today: an invoice inserted straight into posted is refused
  -- (trg_invoice_draft_insert, credit memos aside) and so is a line added to a posted one (INVOICE_POSTED_LOCKED). With
  -- that lock lifted, as a later edit-a-posted-invoice writer (M6) might, the added lines settle the sale: $180 / $120
  -- on $300 (Sol posting r5 HIGH 4). Built as a copy of a draft the app made, the draft removed first so the copy's
  -- lines stay within the delivered amount.
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'i-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'i-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  v_new := gen_random_uuid();
  CREATE TEMP TABLE smk_cad_i_hdr ON COMMIT DROP AS SELECT * FROM invoices WHERE id = v_inv;
  CREATE TEMP TABLE smk_cad_i_lines ON COMMIT DROP AS SELECT * FROM invoice_items WHERE invoice_id = v_inv;
  DELETE FROM invoice_items WHERE invoice_id = v_inv;
  DELETE FROM invoices WHERE id = v_inv;
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'invoices' AND is_generated = 'NEVER'
     AND column_name NOT IN ('id', 'status', 'invoice_number');
  BEGIN
    EXECUTE format('INSERT INTO invoices (id, status, invoice_number, %1$s) SELECT $1, %2$L, %3$L, %1$s FROM smk_cad_i_hdr',
                   v_cols, 'posted', 'SMK-CAD-I-' || v_suffix) USING v_new;
    v_fails := v_fails || ' (I) a chemical-sale invoice was inserted already posted;';
  EXCEPTION WHEN raise_exception THEN
    NULL;  -- refused, as expected
  END;
  EXECUTE format('INSERT INTO invoices (id, status, invoice_number, %1$s) SELECT $1, %2$L, %3$L, %1$s FROM smk_cad_i_hdr',
                 v_cols, 'draft', 'SMK-CAD-I-' || v_suffix) USING v_new;
  UPDATE invoices SET status = 'posted', posted_at = now() WHERE id = v_new;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'invoice_items' AND is_generated = 'NEVER'
     AND column_name NOT IN ('id', 'invoice_id');
  BEGIN
    EXECUTE format('INSERT INTO invoice_items (invoice_id, %1$s) SELECT $1, %1$s FROM smk_cad_i_lines', v_cols) USING v_new;
    v_fails := v_fails || ' (I) lines were added to a posted invoice with its lock on;';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- INVOICE_POSTED_LOCKED, as expected
  END;
  ALTER TABLE invoice_items DISABLE TRIGGER trg_refuse_posted_invoice_child_write;
  EXECUTE format('INSERT INTO invoice_items (invoice_id, %1$s) SELECT $1, %1$s FROM smk_cad_i_lines', v_cols) USING v_new;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  ALTER TABLE invoice_items ENABLE TRIGGER trg_refuse_posted_invoice_child_write;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
    v_fails := v_fails || ' (I) lines added to a posted invoice did not settle on $300: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- P: half posted ($180 / $120 on $300), then the invoice's header order cleared, as a legacy invoice has it: billed by
  -- header counts 0, and the rows stay on the rule's $300, never the whole-discount $350 (Sol posting r5 HIGH 3).
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'p-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'p-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM pg_temp.smk_post(v_inv, 'p-' || v_suffix);
  -- Only a legacy invoice can have no order on its header today (INVOICE_ORDER_IMMUTABLE and lineage guards), so the
  -- header is cleared with the invoice triggers off in this rolled-back step, then the sale settled directly.
  ALTER TABLE invoices DISABLE TRIGGER USER;
  UPDATE invoices SET order_id = NULL WHERE id = v_inv;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  ALTER TABLE invoices ENABLE TRIGGER USER;
  IF to_regprocedure('public._settle_order_commission_20270306(uuid)') IS NULL THEN
    v_fails := v_fails || ' (P) a NULL-header invoice: no settle helper;';
  ELSE
    PERFORM public._settle_order_commission_20270306(v_order);
    IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '180.00/120.00|300.00' THEN
      v_fails := v_fails || ' (P) a NULL-header invoice put the rows off the rule''s $300: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
    END IF;
  END IF;

  -- R: half posted at 10% ($50 off) on an invoice whose header order is then cleared (a legacy blank-header invoice),
  -- the other half posted at 0% on a normal invoice: the sale is fully billed, so $210 / $140 on $350, not the
  -- discount scaled up to $300 by counting only the headed half as billed (Sol posting r6 H1).
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10, 6, false, pg_temp.smk_split(v_rep1, 60, v_rep2, 40), 'r-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'r1-' || v_suffix);
  v_inv := pg_temp.smk_draft(v_order);
  PERFORM pg_temp.smk_post(v_inv, 'r1-' || v_suffix);
  ALTER TABLE invoices DISABLE TRIGGER USER;
  UPDATE invoices SET order_id = NULL WHERE id = v_inv;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  ALTER TABLE invoices ENABLE TRIGGER USER;
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_customer;
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 50, 'r2-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'r2-' || v_suffix);
  UPDATE customers SET standing_discount_pct = 10 WHERE id = v_customer;
  IF pg_temp.smk_rows(v_order) IS DISTINCT FROM '210.00/140.00|350.00' THEN
    v_fails := v_fails || ' (R) a blank-header invoice mixed with a headed one: not 210/140 on $350: ' || COALESCE(pg_temp.smk_rows(v_order), 'none') || ';';
  END IF;

  -- U: $1,001 / $600 at 10% posted whole: $300.90 at 50/25/25 ($150.45 / $75.23 / $75.22). The $75.22 row is then
  -- rounded up to $75.23 as the edit paths round each row on its own, one 25% row is batched, and the 50% row is put
  -- back on an older base: settling it again leaves $150.44 for it, so the set stays $300.90 (Sol posting r6 H2).
  v_order := pg_temp.smk_sale(v_admin, v_product, v_customer, NULL, 10.01, 6, false,
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep1), 'recipient_user_id', v_rep1, 'percentage', 50),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_rep2), 'recipient_user_id', v_rep2, 'percentage', 25),
      jsonb_build_object('recipient', (SELECT full_name FROM profiles WHERE id = v_admin), 'recipient_user_id', v_admin, 'percentage', 25))), 'u-' || v_suffix);
  PERFORM pg_temp.smk_deliver(v_admin, v_order, 100, 'u-' || v_suffix);
  PERFORM pg_temp.smk_post(pg_temp.smk_draft(v_order), 'u-' || v_suffix);
  UPDATE commissions SET commission_amount = 75.23
   WHERE order_id = v_order AND split_percentage = 25 AND deleted_at IS NULL AND status = 'pending';
  PERFORM create_commission_payment(
    ARRAY(SELECT id FROM commissions WHERE order_id = v_order AND split_percentage = 25 AND deleted_at IS NULL ORDER BY id LIMIT 1),
    'check', 'SMK-CAD-U', (now() AT TIME ZONE 'America/Chicago')::date, 'Rolled-back smoke', v_admin, 'smk-cad-u-pay-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  UPDATE commissions SET order_profit = 401, commission_amount = 200.50
   WHERE order_id = v_order AND split_percentage = 50 AND deleted_at IS NULL;
  IF to_regprocedure('public._settle_order_commission_20270306(uuid)') IS NULL THEN
    v_fails := v_fails || ' (U) a pool below the moving floors: no settle helper;';
  ELSE
    PERFORM public._settle_order_commission_20270306(v_order);
    v_got := (SELECT to_char(sum(commission_amount), 'FM999990.00') FROM commissions
               WHERE order_id = v_order AND deleted_at IS NULL AND status <> 'cancelled');
    IF v_got IS DISTINCT FROM '300.90' THEN
      v_fails := v_fails || ' (U) a pool below the moving floors: rows total ' || COALESCE(v_got, 'none') || ', not 300.90;';
    END IF;
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
               AND o.order_name !~ '\[SMOKE\] CAD (d|f|s|c|e|o|t|g|k2|v|w|x|y|z|l|q|n|p|r|u)-'  -- part-posted, unposted or none; k2 holds k3's moved row
               AND c.order_profit IS DISTINCT FROM o.total_profit + _order_standing_discount_20270109(o.id));
  IF v_got IS NOT NULL THEN
    v_fails := v_fails || ' (base) a commission base differs from the P&L profit after discount: ' || v_got || ';';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: commission settles on posting, on the profit after the standing discount, never on tax (A-Z)';
END
$smoke$;
