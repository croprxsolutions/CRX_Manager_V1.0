-- ============================================================================
-- ROLLED-BACK smoke: a Bill Split sale bills one invoice per payer, to the cent
-- ----------------------------------------------------------------------------
-- Migration 20261215110000_chem_sale_bill_split_invoices (billing plan M2).
--   A  Card 60/40 on line 1, line 2's own shares 100% to the main customer: a delivery drafts two
--      invoices in one group, base-1 and base-2, CS- numbers, each line adds up exactly
--   B  A three-way split: the leftover cents go to the main customer
--   C  The card and the line shares refuse changes after the first delivery (BILL_SPLIT_FROZEN), and so does
--      deleting a line that has its own shares
--   C2 A frozen share can't leave its sale by moving to an open one; a card can't total over 100%
--   D  A direct write to a payer's line is refused, and save_invoice can't bill past the delivery
--   E  Re-saving a payer's draft keeps its cents; a freight charge goes on one payer's draft
--   F  A one-customer chemical-sale or misc-charge invoice on this sale is refused (ORDER_HAS_BILL_SPLIT),
--      also with a made-up group id, and a plain draft can't be given one later; a credit memo can't be
--      retyped as a sale (INVOICE_TYPE_IMMUTABLE), while a draft still switches chemical sale / misc charge
--   G  The group posts at its reviewed versions, and the second payer can return their share
--   H  Void the delivery on a fresh sale: both drafts cancel and the card reopens
--   I  Under 100%: the rest stays with the main customer
--   J  Create Invoice on a delivery with no invoice drafts per payer
--   K  No card: one plain CS- invoice, as before
--   L  A one-customer draft on the sale refuses a new payer (BILL_SPLIT_HAS_DRAFT) until it is gone
--   M  A payer draft's product lines follow the split: quantity, price and removal are refused
--      (BILL_SPLIT_LINES_LOCKED) and a charge still saves
--   N  Cost: each payer's cost is the sum of its own lines (Option 1), a charge re-save keeps it, and a
--      change to a product line's cost or description is refused (BILL_SPLIT_LINES_LOCKED)
--   O  A share too small for a hundredth of quantity still gets its exact cents
--   P  A line share and a card row record when they changed
--   Q  A price-later (rush) sale drafts nothing at delivery; once priced, Create Invoice drafts per payer
--   R  One payer's draft can't be deleted or voided alone; the whole group can, and Create Invoice redrafts
--   S  A delivery too small to share leaves no invoice, a lasting record and a flag for the screen
--   T  A field split can't take over a frozen Bill Split, by a new allocation or by moving one
--   U  Create Invoice on a delivery with nothing to bill is refused, not a success with no invoice
--   V  Row security as authenticated and anon, including a soft-deleted order
--   W  Two deliveries under one frozen card add up to the sale
--   X  Replaying complete_delivery and Create Invoice with their keys drafts nothing new
--   Y  A rush sale waiting for prices drafts nothing at completion, can still be priced, then Create Invoice drafts it
--   Z  One payer's posted invoice can't be unposted alone (GROUP_UNPOST_REQUIRED); the group call unposts every payer
--      An unposted payer invoice takes header edits and charges; its product lines stay locked; the group re-posts
--   AA A line bills in the order line's unit, so every payer can return it
--   AB A three-decimal delivery (2.125) bills like a plain sale: each payer to 4 places, exact cents (Mason, 2026-11-09)
--   AK A restricted-use line finer than an invoice line holds (5 places) refuses, so the register misses nothing
--   AC A line finer than an invoice line holds but worth cents refuses, so no billed money is dropped
--   AD A payer's quantity is whole hundredths when the delivery allows, so it returns in full; the main customer takes the rest
--   AE A payer draft's unit follows the split; re-saving a tote line as read still works
--   AF A card plus a field allocation, part delivered, then the allocation removed: Create Invoice drafts per payer
--   AG A payer's invoice takes its season from its date, as a plain delivery invoice does
--   AH An inactive customer can't become a payer, on the card or on a line
--   AI A line with its own shares can't move to another sale (ORDER_ITEM_SHARES_LINE_MOVE)
--   AN A one-customer draft with a group id but no split record still blocks a payer
--   AO A delivery that drafts its payers clears the split flag
--   AM A posted invoice keeps its type; only a draft switches between chemical sale and misc charge
--   AL A line delivered past its planned quantity splits its capped total by percentage
--   AJ A payer's share under 0.01 of a unit bills (0.0099 of 0.01 at 99%), exact to the cent, with no Fix Delivery
--   AP Create Invoice in a closed month refuses, so nothing is dated into a closed month (Mason, 2026-11-09)
--   AQ Create Invoice on a Bill Split delivery is dated the day it runs, as a plain sale's is (Mason, 2026-11-09)
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- order, delivery and invoice is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_main uuid;
  v_d2 uuid;
  v_payer2 uuid;
  v_payer3 uuid;
  v_p1 public.products%ROWTYPE;
  v_p2 public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_o uuid;
  v_l1 uuid;
  v_l2 uuid;
  v_d uuid;
  v_inv uuid;
  v_inv2 uuid;
  v_group uuid;
  v_n int := 0;
  v_cents bigint;
  v_header jsonb;
  v_lines jsonb;
  v_versions jsonb;
  v_fails text := '';
  v_r jsonb;
  v_rup boolean;
  v_err text;
  v_rep uuid;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_main FROM customers WHERE is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_payer2 FROM customers WHERE is_active = true AND id <> v_main ORDER BY created_at LIMIT 1;
  SELECT id INTO v_payer3 FROM customers WHERE is_active = true AND id NOT IN (v_main, v_payer2) ORDER BY created_at LIMIT 1;
  SELECT * INTO v_p1 FROM products WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2) ORDER BY created_at LIMIT 1;
  SELECT * INTO v_p2 FROM products WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2) AND id <> v_p1.id ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_payer3 IS NULL OR v_p2.id IS NULL
     OR (SELECT count(*) FROM customers WHERE is_active = true) < 3 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, three active customers and two active products with a cost';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- A two-line sale, 10 units each, $7.33 above cost, with a scheduled delivery of everything.
  CREATE TEMP TABLE smk_sale (o uuid, l1 uuid, l2 uuid, d uuid) ON COMMIT DROP;
  CREATE FUNCTION pg_temp.smk_new_sale(p_tag text, p_confirm boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $f$
  DECLARE
    v_cust uuid := (SELECT id FROM customers WHERE is_active = true ORDER BY created_at LIMIT 1);
    v_a uuid := (SELECT id FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1);
    p1 public.products%ROWTYPE; p2 public.products%ROWTYPE; o uuid; l1 uuid; l2 uuid; d uuid;
  BEGIN
    SELECT * INTO p1 FROM products WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2) ORDER BY created_at LIMIT 1;
    SELECT * INTO p2 FROM products WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2) AND id <> p1.id ORDER BY created_at LIMIT 1;
    INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
      VALUES ('SMK-SPL-' || p_tag, v_cust, CURRENT_DATE, 'confirmed', v_a) RETURNING id INTO o;
    PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit, total_units_needed, total_price, quantity_delivered, quantity_remaining)
      VALUES (o, p1.id, '[SMOKE] Split 1', 'gal', p1.current_cost + 7.33, p1.current_cost, 10, (p1.current_cost + 7.33) * 10, 0, 10) RETURNING id INTO l1;
    INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit, total_units_needed, total_price, quantity_delivered, quantity_remaining)
      VALUES (o, p2.id, '[SMOKE] Split 2', 'gal', p2.current_cost + 7.33, p2.current_cost, 10, (p2.current_cost + 7.33) * 10, 0, 10) RETURNING id INTO l2;
    PERFORM set_config('app.crx_below_cost_operation', '', true);
    INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
      VALUES ('SMK-SPL-' || p_tag, o, v_cust, 'scheduled', CURRENT_DATE, v_a) RETURNING id INTO d;
    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES (d, l1, p1.id, 10, 'gal'), (d, l2, p2.id, 10, 'gal');
    IF p_confirm THEN PERFORM confirm_delivery(d, v_a, 'smk-spl-confirm-' || p_tag); END IF;
    DELETE FROM smk_sale; INSERT INTO smk_sale VALUES (o, l1, l2, d);
  END $f$;
  CREATE FUNCTION pg_temp.smk_card(p_o uuid, p_c uuid, p_pct numeric) RETURNS void LANGUAGE sql AS $f$
    INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents)
      SELECT p_o, p_c, c.farm_name, p_pct, 0 FROM customers c WHERE c.id = p_c;
  $f$;
  CREATE FUNCTION pg_temp.smk_done(p_d uuid, p_tag text) RETURNS void LANGUAGE sql AS $f$
    SELECT complete_delivery(p_d, 'No proof — recorded by office', (SELECT created_by FROM deliveries WHERE id = p_d), NULL, NULL, NULL,
      'smk-spl-done-' || p_tag, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  $f$;

  -- A + C + D + E + F + G on one sale.
  PERFORM pg_temp.smk_new_sale('a' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_main, 60);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage) VALUES (v_l2, v_main, 100);
  PERFORM pg_temp.smk_done(v_d, 'a' || v_suffix);

  SELECT count(*), min(invoice_group_id::text)::uuid INTO v_n, v_group FROM invoices WHERE delivery_id = v_d AND status = 'draft';
  IF v_n <> 2 OR v_group IS NULL
     OR EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d AND invoice_type <> 'chemical_sale')
     OR (SELECT count(DISTINCT regexp_replace(invoice_number, '-[0-9]+$', '')) FROM invoices WHERE delivery_id = v_d) <> 1
     OR (SELECT invoice_number FROM invoices WHERE delivery_id = v_d AND customer_id = v_main) !~ '^CS-[0-9]{4}-[0-9]+-1$'
     OR (SELECT invoice_number FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2) !~ '^CS-[0-9]{4}-[0-9]+-2$' THEN
    v_fails := v_fails || format(' (A) %s drafts, numbers %s;', v_n, (SELECT string_agg(invoice_number, ',') FROM invoices WHERE delivery_id = v_d));
  END IF;
  IF (SELECT sum(ii.extended_cents) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = v_d AND ii.order_item_id = v_l1)
       IS DISTINCT FROM (SELECT round(total_price * 100)::bigint FROM order_items WHERE id = v_l1)
     OR (SELECT sum(ii.quantity) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = v_d AND ii.order_item_id = v_l1) <> 10
     OR EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = v_d AND i.customer_id = v_payer2 AND ii.order_item_id = v_l2)
     OR (SELECT sum(total_amount_cents) FROM invoices WHERE delivery_id = v_d)
          IS DISTINCT FROM (SELECT round(sum(total_price) * 100)::bigint FROM order_items WHERE order_id = v_o) THEN
    v_fails := v_fails || ' (A) the lines do not add up to the sale;';
  END IF;
  v_inv := (SELECT id FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2);
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv) IS DISTINCT FROM floor((SELECT total_price * 100 FROM order_items WHERE id = v_l1) * 0.4)::bigint THEN
    v_fails := v_fails || ' (A) payer 2 is not 40% of line 1;';
  END IF;

  BEGIN
    UPDATE order_shares SET split_percentage = 50 WHERE order_id = v_o AND customer_id = v_main;
    IF FOUND THEN v_fails := v_fails || ' (C) the card changed after delivery;'; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_FROZEN:%' THEN v_fails := v_fails || ' (C) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    DELETE FROM order_item_shares WHERE order_item_id = v_l2;
    IF FOUND THEN v_fails := v_fails || ' (C) a line share changed after delivery;'; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_FROZEN:%' THEN v_fails := v_fails || ' (C) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    DELETE FROM order_items WHERE id = v_l2;
    IF FOUND THEN v_fails := v_fails || ' (C) a line with its own shares was deleted after delivery;'; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_FROZEN:%' THEN v_fails := v_fails || ' (C) wrong refusal on a line delete: ' || SQLERRM || ';'; END IF;
  END;

  PERFORM pg_temp.smk_new_sale('c' || v_suffix);
  BEGIN
    UPDATE order_shares SET order_id = (SELECT o FROM smk_sale) WHERE order_id = v_o AND customer_id = v_payer2;
    v_fails := v_fails || ' (C2) a frozen card row moved to an open sale;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_SHARES_ORDER_IMMUTABLE:%' THEN v_fails := v_fails || ' (C2) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    UPDATE order_item_shares SET order_item_id = (SELECT l1 FROM smk_sale) WHERE order_item_id = v_l2;
    v_fails := v_fails || ' (C2) a frozen line share moved to an open sale;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_ITEM_SHARES_LINE_IMMUTABLE:%' THEN v_fails := v_fails || ' (C2) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    PERFORM pg_temp.smk_card((SELECT o FROM smk_sale), v_main, 50.005);
    PERFORM pg_temp.smk_card((SELECT o FROM smk_sale), v_payer2, 50.005);
    v_fails := v_fails || ' (C2) a card totalling 100.01% was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_SHARES_OVER_100:%' THEN v_fails := v_fails || ' (C2) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  BEGIN
    UPDATE invoice_items SET quantity = quantity + 0.0001 WHERE invoice_id = v_inv;
    v_fails := v_fails || ' (D) a direct line write was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SPLIT_INVOICE_PROVENANCE_IMMUTABLE:%' THEN
      v_fails := v_fails || ' (D) wrong refusal: ' || SQLERRM || ';';
    END IF;
  END;

  v_cents := (SELECT total_amount_cents FROM invoices WHERE id = v_inv);
  SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
           'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
           'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
    INTO v_header FROM invoices i WHERE i.id = v_inv;
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
    INTO v_lines FROM invoice_items it WHERE it.invoice_id = v_inv;
  BEGIN
    PERFORM save_invoice(v_header, v_lines, 'smk-spl-resave-' || v_suffix);
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv) IS DISTINCT FROM v_cents THEN
      v_fails := v_fails || format(' (E) re-save moved %s to %s;', v_cents, (SELECT total_amount_cents FROM invoices WHERE id = v_inv));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (E) re-saving a payer draft was refused: ' || SQLERRM || ';';
  END;

  BEGIN
    PERFORM save_invoice(v_header, (SELECT jsonb_agg(l || jsonb_build_object('quantity', (l->>'quantity')::numeric + 0.0001)) FROM jsonb_array_elements(v_lines) l),
      'smk-spl-over-' || v_suffix);
    v_fails := v_fails || ' (D) save_invoice billed past the delivery;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' AND SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%' THEN
      v_fails := v_fails || ' (D) wrong refusal from save_invoice: ' || SQLERRM || ';';
    END IF;
  END;

  -- M: the product lines follow the split. Sol's 60/40 re-saved as 50/50 starts by moving one payer down.
  BEGIN
    PERFORM save_invoice(v_header, (SELECT jsonb_agg(l || jsonb_build_object('quantity', (l->>'quantity')::numeric - 1,
        'extended_cents', (l->>'extended_cents')::bigint - (l->>'unit_price_cents')::bigint)) FROM jsonb_array_elements(v_lines) l),
      'smk-spl-m1-' || v_suffix);
    v_fails := v_fails || ' (M) a payer draft moved off its share (quantity);';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_LINES_LOCKED:%' THEN v_fails := v_fails || ' (M) wrong refusal on quantity: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    PERFORM save_invoice(v_header, (SELECT jsonb_agg(l || jsonb_build_object('unit_price_cents', (l->>'unit_price_cents')::bigint - 1,
        'extended_cents', (l->>'extended_cents')::bigint - (l->>'quantity')::numeric)) FROM jsonb_array_elements(v_lines) l),
      'smk-spl-m2-' || v_suffix);
    v_fails := v_fails || ' (M) a payer draft moved off its share (price);';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_LINES_LOCKED:%' THEN v_fails := v_fails || ' (M) wrong refusal on price: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    PERFORM save_invoice(v_header, (SELECT jsonb_agg(l || jsonb_build_object('description', 'Something else')) FROM jsonb_array_elements(v_lines) l),
      'smk-spl-m5-' || v_suffix);
    v_fails := v_fails || ' (M) a billed product line was re-described;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_LINES_LOCKED:%' THEN v_fails := v_fails || ' (M) wrong refusal on description: ' || SQLERRM || ';'; END IF;
  END;

  -- The screen sends quantity x price, which can differ from the payer's share: the draft keeps its own cents.
  BEGIN
    PERFORM save_invoice(v_header, (SELECT jsonb_agg(l || jsonb_build_object('extended_cents', (l->>'extended_cents')::bigint - 1)) FROM jsonb_array_elements(v_lines) l),
      'smk-spl-m4-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (M) a save sending quantity x price cents was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv) IS DISTINCT FROM v_cents THEN
    v_fails := v_fails || ' (M) a save moved the draft off its cents;';
  END IF;
  BEGIN
    PERFORM save_invoice(v_header, '[]'::jsonb, 'smk-spl-m3-' || v_suffix);
    v_fails := v_fails || ' (M) a payer draft dropped its product line;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_LINES_LOCKED:%' AND SQLERRM NOT LIKE 'GENERATED_INVOICE_LINEAGE_LINE_REQUIRED:%' THEN
      v_fails := v_fails || ' (M) wrong refusal on removal: ' || SQLERRM || ';';
    END IF;
  END;

  BEGIN
    PERFORM save_invoice(v_header, v_lines || jsonb_build_array(jsonb_build_object('description', 'Freight', 'quantity', 1,
      'unit_price_cents', 4500, 'extended_cents', 4500, 'cost_cents', 0, 'sort_order', 9, 'charge_type', 'freight')),
      'smk-spl-freight-' || v_suffix);
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv) IS DISTINCT FROM v_cents + 4500 THEN
      v_fails := v_fails || format(' (E) freight left the payer at %s, want %s;', (SELECT total_amount_cents FROM invoices WHERE id = v_inv), v_cents + 4500);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (E) a freight charge on a payer draft was refused: ' || SQLERRM || ';';
  END;

  BEGIN
    INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, status, invoice_date, total_amount_cents, total_cost_cents, created_by)
      VALUES ('SMK-SPL-F' || v_suffix, 'chemical_sale', v_o, v_main, 'draft', CURRENT_DATE, 0, 0, v_admin);
    v_fails := v_fails || ' (F) a one-customer invoice was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_HAS_BILL_SPLIT:%' THEN v_fails := v_fails || ' (F) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, status, invoice_date, total_amount_cents, total_cost_cents, created_by)
      VALUES ('SMK-SPL-F2' || v_suffix, 'misc_charge', v_o, v_main, 'draft', CURRENT_DATE, 0, 0, v_admin);
    v_fails := v_fails || ' (F) a one-customer misc-charge invoice was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_HAS_BILL_SPLIT:%' THEN v_fails := v_fails || ' (F) wrong refusal on misc charge: ' || SQLERRM || ';'; END IF;
  END;
  -- On a sale with no delivery yet, so no other guard stands in front of this one.
  PERFORM pg_temp.smk_new_sale('f3' || v_suffix);
  PERFORM pg_temp.smk_card((SELECT o FROM smk_sale), v_payer2, 40);
  BEGIN
    INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, status, invoice_date, total_amount_cents, total_cost_cents, created_by, invoice_group_id)
      VALUES ('SMK-SPL-F3' || v_suffix, 'chemical_sale', (SELECT o FROM smk_sale), v_main, 'draft', CURRENT_DATE, 0, 0, v_admin, gen_random_uuid());
    v_fails := v_fails || ' (F) a one-customer invoice with a made-up group was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_HAS_BILL_SPLIT:%' THEN v_fails := v_fails || ' (F) wrong refusal on a made-up group: ' || SQLERRM || ';'; END IF;
  END;
  -- A plain draft on a sale with no card yet can't be given a group id afterwards.
  PERFORM pg_temp.smk_new_sale('f4' || v_suffix);
  BEGIN
    INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, status, invoice_date, total_amount_cents, total_cost_cents, created_by)
      VALUES ('SMK-SPL-F4' || v_suffix, 'chemical_sale', (SELECT o FROM smk_sale), v_main, 'draft', CURRENT_DATE, 0, 0, v_admin);
    BEGIN
      UPDATE invoices SET invoice_group_id = gen_random_uuid() WHERE invoice_number = 'SMK-SPL-F4' || v_suffix;
      v_fails := v_fails || ' (F) a plain draft was given a made-up group;';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'INVOICE_GROUP_ASSIGN_REQUIRES_SPLIT:%' THEN v_fails := v_fails || ' (F) wrong refusal on a group assign: ' || SQLERRM || ';'; END IF;
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) a plain draft on a sale with no card was refused: ' || SQLERRM || ';';
  END;
  BEGIN
    UPDATE invoices SET invoice_type = 'misc_charge' WHERE invoice_number = 'SMK-SPL-F4' || v_suffix;
    UPDATE invoices SET invoice_type = 'chemical_sale' WHERE invoice_number = 'SMK-SPL-F4' || v_suffix;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) a draft could not switch chemical sale / misc charge: ' || SQLERRM || ';';
  END;
  BEGIN
    INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, status, invoice_date, total_amount_cents, total_cost_cents, created_by)
      VALUES ('SMK-SPL-F5' || v_suffix, 'credit_memo', (SELECT o FROM smk_sale), v_main, 'draft', CURRENT_DATE, 0, 0, v_admin);
    BEGIN
      UPDATE invoices SET invoice_type = 'chemical_sale' WHERE invoice_number = 'SMK-SPL-F5' || v_suffix;
      v_fails := v_fails || ' (F) a credit memo was retyped as a sale;';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'INVOICE_TYPE_IMMUTABLE:%' THEN v_fails := v_fails || ' (F) wrong refusal on a retype: ' || SQLERRM || ';'; END IF;
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) setup: a draft credit memo was refused: ' || SQLERRM || ';';
  END;

  SELECT jsonb_object_agg(id, _invoice_post_version(id)) INTO v_versions FROM invoices WHERE invoice_group_id = v_group;
  BEGIN
    PERFORM post_invoice_group(v_group, v_admin, v_versions, 'smk-spl-post-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (G) the group post was refused: ' || SQLERRM || ';';
  END;
  IF EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'posted') THEN
    v_fails := v_fails || ' (G) a payer invoice did not post;';
  END IF;
  -- A lost-response retry of the earlier save replays its answer after the group posts (Sol, 6 Nov).
  BEGIN
    IF save_invoice(v_header, v_lines, 'smk-spl-resave-' || v_suffix) IS DISTINCT FROM v_inv THEN
      v_fails := v_fails || ' (G) a save retry after posting returned another invoice;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (G) a save retry after posting was refused: ' || SQLERRM || ';';
  END;
  IF NOT _return_customer_is_split_payer((SELECT order_id FROM invoices WHERE id = v_inv), v_payer2) THEN
    v_fails := v_fails || ' (G) the second payer is not a split payer for returns;';
  END IF;

  -- B: shares unevenly three ways. Each other payer pays exactly their percentage of the line, rounded down
  -- to the cent, on 3.33 of the 10 units (whole hundredths, so it can be returned in full); the main customer takes the rest.
  PERFORM pg_temp.smk_new_sale('b' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_main, 33.3334);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 33.3333);
  PERFORM pg_temp.smk_card(v_o, v_payer3, 33.3333);
  PERFORM pg_temp.smk_done(v_d, 'b' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d) <> 3
     OR (SELECT sum(total_amount_cents) FROM invoices WHERE delivery_id = v_d)
          IS DISTINCT FROM (SELECT round(sum(total_price) * 100)::bigint FROM order_items WHERE order_id = v_o)
     OR (SELECT total_amount_cents FROM invoices WHERE delivery_id = v_d AND customer_id = v_main)
          < (SELECT total_amount_cents FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2)
     OR EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                 WHERE i.delivery_id = v_d AND i.customer_id = v_payer2
                   AND (ii.extended_cents <> floor((SELECT total_price * 100 FROM order_items WHERE id = ii.order_item_id) * 33.3333 / 100)
                        OR ii.quantity <> 3.33)) THEN
    v_fails := v_fails || ' (B) three-way shares are wrong;';
  END IF;

  -- H: void the delivery, then the card can change again.
  PERFORM pg_temp.smk_new_sale('h' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_main, 50);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 50);
  PERFORM pg_temp.smk_done(v_d, 'h' || v_suffix);
  BEGIN
    PERFORM void_delivery(v_d, 'Rolled-back smoke; bill split', v_admin, 'smk-spl-void-' || v_suffix);
    IF EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d AND status NOT IN ('cancelled', 'voided') AND deleted_at IS NULL) THEN
      v_fails := v_fails || format(' (H) drafts stayed active after the void: %s;', (SELECT string_agg(invoice_number || ':' || status, ',') FROM invoices WHERE delivery_id = v_d));
    END IF;
    UPDATE order_shares SET split_percentage = 40 WHERE order_id = v_o AND customer_id = v_payer2;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (H) ' || SQLERRM || ';';
  END;

  -- I: a card of 25% to payer 2 only: the rest stays with the main customer.
  PERFORM pg_temp.smk_new_sale('i' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 25);
  PERFORM pg_temp.smk_done(v_d, 'i' || v_suffix);
  IF (SELECT sum(ii.quantity) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = v_d AND i.customer_id = v_main) <> 15
     OR (SELECT sum(ii.quantity) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = v_d AND i.customer_id = v_payer2) <> 5 THEN
    v_fails := v_fails || ' (I) under 100% did not leave the rest with the main customer;';
  END IF;

  -- J: void the group, then Create Invoice on the delivery drafts per payer again.
  BEGIN
    PERFORM void_invoice_group((SELECT invoice_group_id FROM invoices WHERE delivery_id = v_d LIMIT 1), 'Rolled-back smoke; bill split', 'smk-spl-vg-' || v_suffix);
    PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-again-' || v_suffix);
    IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d AND status = 'draft') <> 2 THEN
      v_fails := v_fails || format(' (J) Create Invoice left %s;', (SELECT string_agg(invoice_number || ':' || status, ',') FROM invoices WHERE delivery_id = v_d));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (J) ' || SQLERRM || ';';
  END;

  -- K: no card: one plain invoice.
  PERFORM pg_temp.smk_new_sale('j' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_done(v_d, 'j' || v_suffix);
  v_inv2 := (SELECT id FROM invoices WHERE delivery_id = v_d);
  IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d) <> 1
     OR (SELECT invoice_group_id FROM invoices WHERE id = v_inv2) IS NOT NULL
     OR (SELECT invoice_number FROM invoices WHERE id = v_inv2) !~ '^CS-[0-9]{4}-[0-9]+$' THEN
    v_fails := v_fails || ' (K) a sale with no card did not bill as one plain invoice;';
  END IF;

  -- L: a one-customer draft already on the sale. A payer added now would never be billed.
  PERFORM pg_temp.smk_new_sale('l' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, status, invoice_date, total_amount_cents, total_cost_cents, created_by)
    VALUES ('SMK-SPL-L' || v_suffix, 'chemical_sale', v_o, v_main, 'draft', CURRENT_DATE, 0, 0, v_admin) RETURNING id INTO v_inv2;
  BEGIN
    PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
    v_fails := v_fails || ' (L) a payer joined a sale with a one-customer draft;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_HAS_DRAFT:%' THEN v_fails := v_fails || ' (L) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage) VALUES (v_l1, v_payer2, 40);
    v_fails := v_fails || ' (L) a line share joined a sale with a one-customer draft;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_HAS_DRAFT:%' THEN v_fails := v_fails || ' (L) wrong refusal on a line share: ' || SQLERRM || ';'; END IF;
  END;
  UPDATE invoices SET status = 'cancelled' WHERE id = v_inv2;
  BEGIN
    PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (L) the card stayed shut once the draft was cancelled: ' || SQLERRM || ';';
  END;

  -- N: 10 units at 5 cents, 15% to payer 2: 1.5 units cost 7.5 -> 8, 8.5 units cost 42.5 -> 43. Each payer's
  -- cost is its own lines, like every invoice and the month-end report; summed it tops the line's 50 by 1.
  PERFORM pg_temp.smk_new_sale('n' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  UPDATE order_items SET cost_per_unit = 0.05 WHERE id IN (v_l1, v_l2);
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 15);
  PERFORM pg_temp.smk_done(v_d, 'n' || v_suffix);
  IF EXISTS (SELECT 1 FROM invoices i WHERE i.delivery_id = v_d AND i.total_cost_cents IS DISTINCT FROM
              (SELECT COALESCE(sum(ROUND(ii.cost_cents * ii.quantity)::bigint), 0) FROM invoice_items ii WHERE ii.invoice_id = i.id)) THEN
    v_fails := v_fails || ' (N) a payer cost is not the sum of its own lines;';
  END IF;
  IF (SELECT total_cost_cents FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2) IS DISTINCT FROM 16::bigint
     OR (SELECT total_cost_cents FROM invoices WHERE delivery_id = v_d AND customer_id = v_main) IS DISTINCT FROM 86::bigint THEN
    v_fails := v_fails || format(' (N) payer costs %s / %s, want 16 / 86;',
      (SELECT total_cost_cents FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2),
      (SELECT total_cost_cents FROM invoices WHERE delivery_id = v_d AND customer_id = v_main));
  END IF;
  v_inv := (SELECT id FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2);
  v_cents := (SELECT total_cost_cents FROM invoices WHERE id = v_inv);
  SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
           'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
           'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
    INTO v_header FROM invoices i WHERE i.id = v_inv;
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
    INTO v_lines FROM invoice_items it WHERE it.invoice_id = v_inv;
  PERFORM save_invoice(v_header, v_lines || jsonb_build_array(jsonb_build_object('description', 'Freight', 'quantity', 1,
    'unit_price_cents', 4500, 'extended_cents', 4500, 'cost_cents', 0, 'sort_order', 9, 'charge_type', 'freight')),
    'smk-spl-n-' || v_suffix);
  IF (SELECT total_cost_cents FROM invoices WHERE id = v_inv) IS DISTINCT FROM v_cents THEN
    v_fails := v_fails || format(' (N) a charge re-save moved the payer cost %s to %s;', v_cents, (SELECT total_cost_cents FROM invoices WHERE id = v_inv));
  END IF;
  -- A cost edit on an order line is put back by the save (20261106140000) or refused; either way it can't land.
  BEGIN
    PERFORM save_invoice(v_header, jsonb_set(v_lines, '{0,cost_cents}', to_jsonb((v_lines #>> '{0,cost_cents}')::bigint + 1)),
      'smk-spl-n2-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_LINES_LOCKED:%' THEN v_fails := v_fails || ' (N) wrong refusal on a cost change: ' || SQLERRM || ';'; END IF;
  END;
  IF (SELECT cost_cents FROM invoice_items WHERE id = (v_lines #>> '{0,id}')::uuid) IS DISTINCT FROM (v_lines #>> '{0,cost_cents}')::bigint
     OR (SELECT total_cost_cents FROM invoices WHERE id = v_inv) IS DISTINCT FROM v_cents THEN
    v_fails := v_fails || ' (N) a save changed a payer product line''s cost;';
  END IF;
  BEGIN
    PERFORM save_invoice(v_header, jsonb_set(v_lines, '{0,description}', to_jsonb('[SMOKE] renamed'::text)),
      'smk-spl-n3-' || v_suffix);
    v_fails := v_fails || ' (N) a save re-described a payer product line;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_LINES_LOCKED:%' THEN v_fails := v_fails || ' (N) wrong refusal on a description change: ' || SQLERRM || ';'; END IF;
  END;

  -- O and P: a 0.001% share of one $1,000 unit rounds to no quantity but keeps its exact cent (Mason, 2026-11-06).
  PERFORM pg_temp.smk_new_sale('o' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage, updated_at) VALUES (v_l1, v_payer2, 0.001, '2000-01-01');
  IF (SELECT updated_at FROM order_item_shares WHERE order_item_id = v_l1) < '2020-01-01' THEN
    v_fails := v_fails || ' (O) a new line share kept a client-sent updated_at;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM _bill_split_line_shares(v_l1, 100000, 10000) x WHERE x.customer_id = v_payer2 AND x.units = 0 AND x.cents = 1)
     OR (SELECT sum(x.cents) FROM _bill_split_line_shares(v_l1, 100000, 10000) x) <> 100000
     OR (SELECT sum(x.units) FROM _bill_split_line_shares(v_l1, 100000, 10000) x) <> 10000 THEN
    v_fails := v_fails || ' (O) a share with no quantity lost its exact cents, or the line stopped adding up;';
  END IF;
  UPDATE order_item_shares SET split_percentage = 1 WHERE order_item_id = v_l1;
  IF (SELECT updated_at FROM order_item_shares WHERE order_item_id = v_l1) < '2020-01-01' THEN
    v_fails := v_fails || ' (P) changing a line share did not record when;';
  END IF;
  INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, updated_at)
    SELECT v_o, v_payer3, c.farm_name, 5, 0, '2000-01-01' FROM customers c WHERE c.id = v_payer3;
  UPDATE order_shares SET split_percentage = 6 WHERE order_id = v_o AND customer_id = v_payer3;
  IF (SELECT updated_at FROM order_shares WHERE order_id = v_o AND customer_id = v_payer3) < '2020-01-01' THEN
    v_fails := v_fails || ' (P) changing a card row did not record when;';
  END IF;

  -- R: the group stands or falls together.
  PERFORM pg_temp.smk_new_sale('r' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  PERFORM pg_temp.smk_done(v_d, 'r' || v_suffix);
  v_inv := (SELECT id FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2);
  BEGIN
    PERFORM delete_invoices(ARRAY[v_inv], v_admin, 'smk-spl-r1-' || v_suffix);
    v_fails := v_fails || ' (R) one payer''s draft was deleted alone;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_GROUP_DELETE_PARTIAL:%' THEN v_fails := v_fails || ' (R) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    PERFORM void_invoice(v_inv, 'Rolled-back smoke; bill split', 'smk-spl-r2-' || v_suffix);
    v_fails := v_fails || ' (R) one payer''s draft was voided alone;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SPLIT_INVOICE_GROUP_VOID_REQUIRED:%' THEN v_fails := v_fails || ' (R) wrong refusal on a void: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    PERFORM delete_invoices((SELECT array_agg(id) FROM invoices WHERE delivery_id = v_d), v_admin, 'smk-spl-r3-' || v_suffix);
    IF EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d AND deleted_at IS NULL) THEN
      v_fails := v_fails || ' (R) deleting the whole group left a draft;';
    END IF;
    PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-r4-' || v_suffix);
    IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d AND deleted_at IS NULL AND status = 'draft') <> 2 THEN
      v_fails := v_fails || ' (R) Create Invoice did not redraft both payers;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (R) deleting the whole group or redrafting was refused: ' || SQLERRM || ';';
  END;

  -- S: a delivery too small to share. The driver still completes; the office is told, durably.
  PERFORM pg_temp.smk_new_sale('s' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  v_r := complete_delivery(v_d, 'No proof — recorded by office', v_admin,
    (SELECT jsonb_object_agg(di.id::text, 0.00004) FROM delivery_items di WHERE di.delivery_id = v_d),
    NULL, NULL, 'smk-spl-s-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  IF EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d) THEN
    v_fails := v_fails || ' (S) a delivery too small to share still drafted an invoice;';
  END IF;
  IF COALESCE((v_r->>'bill_split_failed')::boolean, false) IS NOT TRUE THEN
    v_fails := v_fails || ' (S) the screen is not told the split failed;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM activity_feed WHERE event_type = 'bill_split_invoices_failed' AND related_entity_id = v_o) THEN
    v_fails := v_fails || ' (S) no lasting record of the failed split;';
  END IF;
  BEGIN
    PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-s2-' || v_suffix);
    v_fails := v_fails || ' (S) Create Invoice billed a delivery too small to share;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_QUANTITY_TOO_FINE:%' THEN v_fails := v_fails || ' (S) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  -- T: after the first delivery a field split can't take the rest of the sale away from the frozen card.
  PERFORM pg_temp.smk_new_sale('t' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  PERFORM pg_temp.smk_done(v_d, 't' || v_suffix);
  INSERT INTO fields (customer_id, field_name, total_acres) VALUES (v_main, '[SMOKE] Split T ' || v_suffix, 10) RETURNING id INTO v_inv2;
  BEGIN
    INSERT INTO order_item_field_allocations (order_item_id, field_id, acres) VALUES (v_l1, v_inv2, 5);
    v_fails := v_fails || ' (T) a field split took over a frozen bill split;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_FROZEN:%' AND SQLERRM NOT LIKE 'ORDER_ALLOCATION_INVOICE_CONFLICT:%' THEN
      v_fails := v_fails || ' (T) wrong refusal: ' || SQLERRM || ';';
    END IF;
  END;
  v_l2 := v_l1;
  PERFORM pg_temp.smk_new_sale('t2' || v_suffix);
  SELECT o, l1, d INTO v_o, v_l1, v_d FROM smk_sale;
  INSERT INTO order_item_field_allocations (order_item_id, field_id, acres) VALUES (v_l1, v_inv2, 5);
  BEGIN
    UPDATE order_item_field_allocations SET order_item_id = v_l2 WHERE order_item_id = v_l1;
    v_fails := v_fails || ' (T) moving an allocation took over a frozen bill split;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_FROZEN:%' AND SQLERRM NOT LIKE 'ORDER_ALLOCATION_INVOICE_CONFLICT:%' THEN
      v_fails := v_fails || ' (T) wrong refusal on a move: ' || SQLERRM || ';';
    END IF;
  END;
  -- Nor can a line with a field allocation move onto the frozen sale (Sol, 6 Nov).
  BEGIN
    UPDATE order_items SET order_id = (SELECT order_id FROM order_items WHERE id = v_l2) WHERE id = v_l1;
    v_fails := v_fails || ' (T) a field-allocated line moved onto a frozen bill split;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_FROZEN:%' THEN v_fails := v_fails || ' (T) wrong refusal on a line move: ' || SQLERRM || ';'; END IF;
  END;

  -- U: a completion with no quantity drafts nothing, and Create Invoice says so.
  PERFORM pg_temp.smk_new_sale('u' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  v_err := NULL;
  BEGIN
    PERFORM complete_delivery(v_d, 'No proof — recorded by office', v_admin,
      (SELECT jsonb_object_agg(di.id::text, 0) FROM delivery_items di WHERE di.delivery_id = v_d),
      NULL, NULL, 'smk-spl-u-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN
    v_fails := v_fails || ' (U) a completion with no quantity was refused: ' || v_err || ';';
  ELSE
    IF EXISTS (SELECT 1 FROM activity_feed WHERE event_type = 'split_invoices_auto_created' AND related_entity_id = v_o) THEN
      v_fails := v_fails || ' (U) a record says invoices were drafted when none were;';
    END IF;
    IF (SELECT status FROM deliveries WHERE id = v_d) = 'completed' THEN
      BEGIN
        v_r := create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-u2-' || v_suffix);
        v_fails := v_fails || ' (U) Create Invoice reported success with no invoice;';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'BILL_SPLIT_NOTHING_TO_BILL:%' THEN v_fails := v_fails || ' (U) wrong refusal: ' || SQLERRM || ';'; END IF;
      END;
    END IF;
  END IF;

  -- W: two deliveries under one frozen card.
  PERFORM pg_temp.smk_new_sale('w' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  PERFORM complete_delivery(v_d, 'No proof — recorded by office', v_admin,
    (SELECT jsonb_object_agg(di.id::text, 3.33) FROM delivery_items di WHERE di.delivery_id = v_d),
    NULL, NULL, 'smk-spl-w1-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-SPL-W2' || v_suffix, v_o, v_main, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_inv2;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    SELECT v_inv2, oi.id, oi.product_id, oi.total_units_needed - 3.33, 'gal' FROM order_items oi WHERE oi.order_id = v_o;
  PERFORM confirm_delivery(v_inv2, v_admin, 'smk-spl-w2c-' || v_suffix);
  PERFORM pg_temp.smk_done(v_inv2, 'w2' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE order_id = v_o AND deleted_at IS NULL) <> 4
     OR (SELECT sum(total_amount_cents) FROM invoices WHERE order_id = v_o AND deleted_at IS NULL)
          IS DISTINCT FROM (SELECT round(sum(total_price) * 100)::bigint FROM order_items WHERE order_id = v_o)
     OR (SELECT sum(ii.quantity) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.order_id = v_o AND ii.order_item_id = v_l1) <> 10 THEN
    v_fails := v_fails || format(' (W) two deliveries did not add up: %s;',
      (SELECT string_agg(invoice_number || '=' || total_amount_cents, ',') FROM invoices WHERE order_id = v_o));
  END IF;

  -- X: replays draft nothing new.
  PERFORM pg_temp.smk_new_sale('x' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  PERFORM pg_temp.smk_done(v_d, 'x' || v_suffix);
  v_n := (SELECT count(*) FROM invoices WHERE delivery_id = v_d);
  PERFORM pg_temp.smk_done(v_d, 'x' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d) <> v_n THEN
    v_fails := v_fails || ' (X) a complete_delivery replay drafted again;';
  END IF;
  PERFORM void_invoice_group((SELECT invoice_group_id FROM invoices WHERE delivery_id = v_d LIMIT 1), 'Rolled-back smoke; bill split', 'smk-spl-xv-' || v_suffix);
  v_r := create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-xc-' || v_suffix);
  IF jsonb_array_length(v_r->'invoice_numbers') IS DISTINCT FROM jsonb_array_length(v_r->'invoice_ids') THEN
    v_fails := v_fails || ' (X) Create Invoice did not name every payer''s invoice;';
  END IF;
  v_n := (SELECT count(*) FROM invoices WHERE delivery_id = v_d);
  IF create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-xc-' || v_suffix) IS DISTINCT FROM v_r
     OR (SELECT count(*) FROM invoices WHERE delivery_id = v_d) <> v_n THEN
    v_fails := v_fails || ' (X) a Create Invoice replay drafted again or answered differently;';
  END IF;

  -- Q: a line still waiting for its price. price_order couldn't sweep a governed split, so none is drafted.
  PERFORM pg_temp.smk_new_sale('q' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  UPDATE order_items SET pricing_pending = true WHERE id = v_l1;
  PERFORM pg_temp.smk_done(v_d, 'q' || v_suffix);
  IF (SELECT status FROM deliveries WHERE id = v_d) IS DISTINCT FROM 'completed'
     OR EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d)
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE related_entity_id = v_o AND message LIKE '%PRICING_INCOMPLETE%') THEN
    v_fails := v_fails || ' (Q) an unpriced sale drafted payer invoices, or the delivery or the notice is missing;';
  END IF;
  UPDATE order_items SET pricing_pending = false WHERE id = v_l1;
  PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-q-' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d AND status = 'draft') <> 2 THEN
    v_fails := v_fails || ' (Q) Create Invoice after pricing did not draft per payer;';
  END IF;

  -- Y: a rush sale's prices arrive after the delivery. Pricing must still work, and then the split drafts.
  PERFORM pg_temp.smk_new_sale('y' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  UPDATE orders SET pricing_status = 'needs_pricing' WHERE id = v_o;
  UPDATE order_items SET pricing_pending = true WHERE order_id = v_o;
  v_r := complete_delivery(v_d, 'No proof — recorded by office', v_admin, NULL, NULL, NULL, 'smk-spl-y-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  IF EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d) OR COALESCE((v_r->>'bill_split_failed')::boolean, false) IS NOT TRUE THEN
    v_fails := v_fails || ' (Y) an unpriced sale drafted, or the screen was not told;';
  END IF;
  BEGIN
    PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-y2-' || v_suffix);
    v_fails := v_fails || ' (Y) Create Invoice drafted an unpriced sale;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'PRICING_INCOMPLETE:%' THEN v_fails := v_fails || ' (Y) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    PERFORM price_order(v_o, (SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'price', oi.price_per_unit)) FROM order_items oi WHERE oi.order_id = v_o),
      v_admin, 'smk-spl-y3-' || v_suffix);
    PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-y4-' || v_suffix);
    IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d AND status = 'draft') <> 2
       OR (SELECT sum(total_amount_cents) FROM invoices WHERE delivery_id = v_d)
            IS DISTINCT FROM (SELECT round(sum(total_price) * 100)::bigint FROM order_items WHERE order_id = v_o) THEN
      v_fails := v_fails || ' (Y) the split did not draft to the cent once priced;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (Y) pricing or drafting after it was refused: ' || SQLERRM || ';';
  END;

  -- Z: one payer's posted invoice can't leave the group alone; the group call unposts every payer.
  PERFORM pg_temp.smk_new_sale('z' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  PERFORM pg_temp.smk_done(v_d, 'z' || v_suffix);
  SELECT invoice_group_id INTO v_group FROM invoices WHERE delivery_id = v_d LIMIT 1;
  SELECT jsonb_object_agg(id, _invoice_post_version(id)) INTO v_versions FROM invoices WHERE invoice_group_id = v_group;
  PERFORM post_invoice_group(v_group, v_admin, v_versions, 'smk-spl-z-post-' || v_suffix);
  SELECT id INTO v_inv FROM invoices WHERE invoice_group_id = v_group AND customer_id = v_payer2;
  BEGIN
    PERFORM unpost_invoice(v_inv, v_admin, 'smk-spl-z-one-' || v_suffix);
    v_fails := v_fails || ' (Z) one payer unposted out of a posted group;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'GROUP_UNPOST_REQUIRED%' THEN v_fails := v_fails || ' (Z) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  IF EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'posted') THEN
    v_fails := v_fails || ' (Z) the group is no longer fully posted;';
  ELSE
    PERFORM unpost_invoice_group(v_group, v_admin, 'smk-spl-z-all-' || v_suffix);
    IF EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'unposted') THEN
      v_fails := v_fails || ' (Z) the group call did not unpost every payer;';
    END IF;
    -- An unposted payer invoice takes header edits and charges like a draft; its product lines stay locked.
    SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
             'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
             'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
      INTO v_header FROM invoices i WHERE i.id = v_inv;
    SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
             'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
             'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
             'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
      INTO v_lines FROM invoice_items it WHERE it.invoice_id = v_inv;
    v_cents := (SELECT total_amount_cents FROM invoices WHERE id = v_inv);
    BEGIN
      PERFORM save_invoice(v_header || jsonb_build_object('header_notes', 'corrected'),
        v_lines || jsonb_build_array(jsonb_build_object('charge_type', 'freight', 'description', 'Freight', 'quantity', 1,
          'unit_price_cents', 4500, 'extended_cents', 4500, 'sort_order', 99, 'unit_size', 'each')),
        'smk-spl-z-edit-' || v_suffix);
      IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv) IS DISTINCT FROM v_cents + 4500 THEN
        v_fails := v_fails || ' (Z) a charge on an unposted payer invoice did not bill;';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || ' (Z) an unposted payer invoice refused an edit: ' || SQLERRM || ';';
    END;
    BEGIN
      PERFORM save_invoice(v_header, (SELECT jsonb_agg(l || jsonb_build_object('quantity', (l->>'quantity')::numeric - 1,
          'extended_cents', (((l->>'quantity')::numeric - 1) * (l->>'unit_price_cents')::bigint)::bigint))
        FROM jsonb_array_elements(v_lines) l), 'smk-spl-z-lock-' || v_suffix);
      v_fails := v_fails || ' (Z) an unposted payer invoice changed a product line;';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'BILL_SPLIT_LINES_LOCKED%' THEN v_fails := v_fails || ' (Z) wrong line refusal: ' || SQLERRM || ';'; END IF;
    END;
    SELECT jsonb_object_agg(id, _invoice_post_version(id)) INTO v_versions FROM invoices WHERE invoice_group_id = v_group;
    PERFORM post_invoice_group(v_group, v_admin, v_versions, 'smk-spl-z-repost-' || v_suffix);
  END IF;

  -- AA: a line bills in the order line's unit, so every payer can return it: no unit on the line, and a
  -- delivery row that names another unit.
  PERFORM pg_temp.smk_new_sale('aa' || v_suffix, false);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  UPDATE order_items SET unit_size = NULL WHERE id = v_l1;
  UPDATE delivery_items SET unit_size = NULL WHERE delivery_id = v_d AND order_item_id = v_l1;
  UPDATE delivery_items SET unit_size = 'bag' WHERE delivery_id = v_d AND order_item_id = v_l2;
  PERFORM confirm_delivery(v_d, v_admin, 'smk-spl-confirm-aa' || v_suffix);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  PERFORM pg_temp.smk_done(v_d, 'aa' || v_suffix);
  SELECT invoice_group_id INTO v_group FROM invoices WHERE delivery_id = v_d LIMIT 1;
  SELECT jsonb_object_agg(id, _invoice_post_version(id)) INTO v_versions FROM invoices WHERE invoice_group_id = v_group;
  PERFORM post_invoice_group(v_group, v_admin, v_versions, 'smk-spl-aa-post-' || v_suffix);
  IF (SELECT billed_qty FROM _return_customer_line_share(v_o, v_l1, v_payer2, NULL)) IS DISTINCT FROM 4
     OR (SELECT billed_qty FROM _return_customer_line_share(v_o, v_l1, v_main, NULL)) IS DISTINCT FROM 6
     OR (SELECT billed_qty FROM _return_customer_line_share(v_o, v_l2, v_payer2, NULL)) IS DISTINCT FROM 4 THEN
    v_fails := v_fails || ' (AA) a payer cannot return a line because of its unit;';
  END IF;

  -- AB: a three-decimal delivery (2.125) bills like a plain sale (Mason, 2026-11-09): the real amount stays,
  -- the payer gets 40% to 4 places (0.85), the main customer the rest (1.275), and the cents add up exactly.
  PERFORM pg_temp.smk_new_sale('ab' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  v_r := complete_delivery(v_d, 'No proof — recorded by office', v_admin,
    (SELECT jsonb_object_agg(di.id::text, CASE WHEN di.order_item_id = v_l1 THEN 2.125 ELSE 5 END) FROM delivery_items di WHERE di.delivery_id = v_d),
    NULL, NULL, 'smk-spl-ab-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  IF COALESCE((v_r->>'bill_split_failed')::boolean, false)
     OR (SELECT quantity_delivered FROM delivery_items WHERE delivery_id = v_d AND order_item_id = v_l1) <> 2.125
     OR (SELECT count(*) FROM invoices WHERE delivery_id = v_d AND status = 'draft') <> 2
     OR (SELECT ii.quantity FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
          WHERE i.delivery_id = v_d AND i.customer_id = v_payer2 AND ii.order_item_id = v_l1) IS DISTINCT FROM 0.85
     OR (SELECT ii.quantity FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
          WHERE i.delivery_id = v_d AND i.customer_id = v_main AND ii.order_item_id = v_l1) IS DISTINCT FROM 1.275
     OR (SELECT sum(ii.extended_cents) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
          WHERE i.delivery_id = v_d AND ii.order_item_id = v_l1)
          IS DISTINCT FROM (SELECT round(price_per_unit * 2.125 * 100)::bigint FROM order_items WHERE id = v_l1)
     OR (SELECT ii.extended_cents FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
          WHERE i.delivery_id = v_d AND i.customer_id = v_payer2 AND ii.order_item_id = v_l1)
          IS DISTINCT FROM (SELECT floor(round(price_per_unit * 2.125 * 100) * 40 / 100.0)::bigint FROM order_items WHERE id = v_l1) THEN
    v_fails := v_fails || ' (AB) a 2.125 delivery did not bill like a plain sale: ' || v_r::text || ';';
  END IF;

  -- AK: the same tiny line on a restricted-use product refuses, since the register reads invoice lines
  -- (Mason, 2026-11-06). The delivery still completes and the office is told.
  PERFORM pg_temp.smk_new_sale('ak' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  SELECT p.is_rup INTO v_rup FROM products p JOIN order_items oi ON oi.product_id = p.id WHERE oi.id = v_l1;
  UPDATE products SET is_rup = true WHERE id = (SELECT product_id FROM order_items WHERE id = v_l1);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  v_r := complete_delivery(v_d, 'No proof — recorded by office', v_admin,
    (SELECT jsonb_object_agg(di.id::text, CASE WHEN di.order_item_id = v_l1 THEN 0.00001 ELSE 5 END) FROM delivery_items di WHERE di.delivery_id = v_d),
    NULL, NULL, 'smk-spl-ak-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  IF COALESCE((v_r->>'bill_split_failed')::boolean, false) IS NOT TRUE
     OR (SELECT status FROM deliveries WHERE id = v_d) IS DISTINCT FROM 'completed'
     OR EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d) THEN
    v_fails := v_fails || ' (AK) a restricted-use line finer than an invoice line holds was left off the invoices: ' || v_r::text || ';';
  END IF;
  UPDATE products SET is_rup = v_rup WHERE id = (SELECT product_id FROM order_items WHERE id = v_l1);

  -- AC: a line too small for an invoice line but worth cents still refuses, so no billed money is dropped.
  PERFORM pg_temp.smk_new_sale('ac' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  UPDATE order_items SET price_per_unit = 1000000, total_price = 10000000 WHERE id = v_l1;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  v_r := complete_delivery(v_d, 'No proof — recorded by office', v_admin,
    (SELECT jsonb_object_agg(di.id::text, CASE WHEN di.order_item_id = v_l1 THEN 0.00004 ELSE 5 END) FROM delivery_items di WHERE di.delivery_id = v_d),
    NULL, NULL, 'smk-spl-ac-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  IF COALESCE((v_r->>'bill_split_failed')::boolean, false) IS NOT TRUE
     OR EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d) THEN
    v_fails := v_fails || ' (AC) a line worth cents was dropped from the billing;';
  END IF;

  -- AD: a payer's quantity is whole hundredths when the delivery allows (3.33 of 10 at 33.33%), so it can be returned
  -- in full; only a share under 0.01 falls back to 4 places (AJ). The main customer takes the rest.
  PERFORM pg_temp.smk_new_sale('ad' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 33.33);
  PERFORM pg_temp.smk_done(v_d, 'ad' || v_suffix);
  IF EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
              WHERE i.delivery_id = v_d AND ii.quantity <> CASE WHEN i.customer_id = v_payer2 THEN 3.33 ELSE 6.67 END)
     OR (SELECT sum(total_amount_cents) FROM invoices WHERE delivery_id = v_d)
          IS DISTINCT FROM (SELECT round(sum(total_price) * 100)::bigint FROM order_items WHERE order_id = v_o) THEN
    v_fails := v_fails || ' (AD) a payer''s quantity is not whole hundredths, or the line no longer adds up;';
  END IF;

  -- AJ: a payer's share under 0.01 of a unit now bills (Mason, 2026-11-09): 99% of 0.01 is 0.0099, the main
  -- customer gets 0.0001, each line's cents add up, and nobody has to change the delivered amount.
  PERFORM pg_temp.smk_new_sale('aj' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 99);
  v_r := complete_delivery(v_d, 'No proof — recorded by office', v_admin,
    (SELECT jsonb_object_agg(di.id::text, 0.01) FROM delivery_items di WHERE di.delivery_id = v_d),
    NULL, NULL, 'smk-spl-aj-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  IF COALESCE((v_r->>'bill_split_failed')::boolean, false)
     OR EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                 WHERE i.delivery_id = v_d AND ii.charge_type IS NULL
                   AND ii.quantity <> CASE WHEN i.customer_id = v_payer2 THEN 0.0099 ELSE 0.0001 END)
     -- Each line bills 0.01 of its price, the payer exactly 99% of it rounded down, the main customer the rest.
     OR EXISTS (SELECT 1 FROM order_items oi
                 WHERE oi.order_id = v_o
                   AND ((SELECT sum(ii.extended_cents) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                          WHERE i.delivery_id = v_d AND ii.order_item_id = oi.id)
                          IS DISTINCT FROM round(oi.price_per_unit * 0.01 * 100)::bigint
                     OR (SELECT ii.extended_cents FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                          WHERE i.delivery_id = v_d AND ii.order_item_id = oi.id AND i.customer_id = v_payer2)
                          IS DISTINCT FROM floor(round(oi.price_per_unit * 0.01 * 100) * 99 / 100.0)::bigint)) THEN
    v_fails := v_fails || ' (AJ) a share under 0.01 of a unit did not bill to the cent: ' || v_r::text || ';';
  END IF;

  -- AP: nothing is dated into a closed month. Completion already refuses a closed date, so the risk is Create
  -- Invoice after the month it runs in was closed: it refuses and drafts nothing.
  PERFORM pg_temp.smk_new_sale('ap' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  UPDATE order_items SET pricing_pending = true WHERE id = v_l1;
  PERFORM pg_temp.smk_done(v_d, 'ap' || v_suffix);
  UPDATE order_items SET pricing_pending = false WHERE id = v_l1;
  INSERT INTO accounting_periods (period_start, period_end, status, closed_at, notes)
  VALUES (date_trunc('month', (now() AT TIME ZONE 'America/Chicago')::date)::date,
          (date_trunc('month', (now() AT TIME ZONE 'America/Chicago')::date) + interval '1 month - 1 day')::date,
          'closed', now(), 'Rolled-back smoke; bill split AP');
  BEGIN
    PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-ap2-' || v_suffix);
    v_fails := v_fails || ' (AP) Create Invoice dated the payers into a closed month;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%falls in closed accounting period%' THEN v_fails := v_fails || ' (AP) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  IF EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d) THEN
    v_fails := v_fails || ' (AP) a payer invoice was left in a closed month;';
  END IF;
  DELETE FROM accounting_periods WHERE notes = 'Rolled-back smoke; bill split AP';

  -- AQ: Create Invoice on a Bill Split delivery is dated the day it runs, as a plain sale's is (Mason, 2026-11-09),
  -- not the delivery day: a rush sale billed after pricing lands in the month it was billed.
  PERFORM pg_temp.smk_new_sale('aq' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  UPDATE order_items SET pricing_pending = true WHERE id = v_l1;
  PERFORM complete_delivery(v_d, 'No proof — recorded by office', v_admin, NULL, NULL, NULL, 'smk-spl-aq-' || v_suffix,
    now() - interval '40 days', 'no_proof', 'Rolled-back smoke; bill split');
  UPDATE order_items SET pricing_pending = false WHERE id = v_l1;
  PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-aq2-' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d AND status = 'draft') <> 2
     OR EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d
                 AND (invoice_date <> (now() AT TIME ZONE 'America/Chicago')::date
                      OR season IS DISTINCT FROM compute_season((now() AT TIME ZONE 'America/Chicago')::date))) THEN
    v_fails := v_fails || ' (AQ) Create Invoice dated the payers by the delivery, not the day it ran;';
  END IF;

  -- AE: a payer draft's unit and tote follow the split too, and re-saving a tote line as read still works.
  PERFORM pg_temp.smk_new_sale('ae' || v_suffix, false);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  UPDATE delivery_items SET tote_number = 'T-1' WHERE delivery_id = v_d AND order_item_id = v_l1;
  PERFORM confirm_delivery(v_d, v_admin, 'smk-spl-confirm-ae' || v_suffix);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  PERFORM pg_temp.smk_done(v_d, 'ae' || v_suffix);
  SELECT id INTO v_inv FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2;
  SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
           'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
           'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
    INTO v_header FROM invoices i WHERE i.id = v_inv;
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
    INTO v_lines FROM invoice_items it WHERE it.invoice_id = v_inv;
  BEGIN
    PERFORM save_invoice(v_header, v_lines, 'smk-spl-ae1-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (AE) re-saving a draft as read was refused: ' || SQLERRM || ';';
  END;
  BEGIN
    PERFORM save_invoice(v_header, (SELECT jsonb_agg(l || jsonb_build_object('unit_size', 'bag')) FROM jsonb_array_elements(v_lines) l),
      'smk-spl-ae2-' || v_suffix);
    v_fails := v_fails || ' (AE) a payer draft''s unit changed;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'GENERATED_INVOICE_LINEAGE_IDENTITY_IMMUTABLE%' THEN v_fails := v_fails || ' (AE) wrong refusal on unit: ' || SQLERRM || ';'; END IF;
  END;

  -- AF: a card plus a field allocation, delivered in two parts, then the allocation removed: Create Invoice drafts
  -- per payer, and the order keeps its billing flag until the second delivery is billed too.
  PERFORM pg_temp.smk_new_sale('af' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  INSERT INTO fields (customer_id, field_name, total_acres) VALUES (v_main, '[SMOKE] Split AF ' || v_suffix, 10) RETURNING id INTO v_inv2;
  INSERT INTO order_item_field_allocations (order_item_id, field_id, acres) VALUES (v_l1, v_inv2, 5);
  PERFORM complete_delivery(v_d, 'No proof — recorded by office', v_admin,
    (SELECT jsonb_object_agg(di.id::text, 5) FROM delivery_items di WHERE di.delivery_id = v_d),
    NULL, NULL, 'smk-spl-af-done-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; bill split');
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-SPL-af2' || v_suffix, v_o, v_main, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_d2;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    SELECT v_d2, oi.id, oi.product_id, 2, 'gal' FROM order_items oi WHERE oi.order_id = v_o;  -- still partial, so no automatic split
  PERFORM confirm_delivery(v_d2, v_admin, 'smk-spl-af2-confirm-' || v_suffix);
  PERFORM pg_temp.smk_done(v_d2, 'af2' || v_suffix);
  DELETE FROM order_item_field_allocations WHERE order_item_id = v_l1;
  -- The payers' invoices take the delivery's date, not the day Create Invoice runs.
  UPDATE deliveries SET completed_at = completed_at - interval '3 days' WHERE id = v_d;
  BEGIN
    PERFORM create_invoice_for_unbilled_delivery(v_d, v_admin, 'smk-spl-af-' || v_suffix);
    IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d) <> 2
       OR NOT (SELECT needs_split_billing FROM orders WHERE id = v_o) THEN
      v_fails := v_fails || ' (AF) Create Invoice did not draft per payer, or cleared the flag with a delivery still unbilled;';
    END IF;
    -- Dated the day Create Invoice runs, as a plain Create Invoice is (Mason, 2026-11-09).
    IF EXISTS (SELECT 1 FROM invoices i
                WHERE i.delivery_id = v_d AND i.invoice_date <> (now() AT TIME ZONE 'America/Chicago')::date) THEN
      v_fails := v_fails || ' (AF) a backfilled payer invoice is not dated the day Create Invoice ran;';
    END IF;
    PERFORM create_invoice_for_unbilled_delivery(v_d2, v_admin, 'smk-spl-af2-' || v_suffix);
    IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d2) <> 2
       OR (SELECT needs_split_billing FROM orders WHERE id = v_o) THEN
      v_fails := v_fails || ' (AF) billing the last delivery did not draft per payer and clear the flag;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (AF) the delivery has no billing path: ' || SQLERRM || ';';
  END;

  -- AG: a payer's invoice takes its season from its date, as a plain delivery invoice does.
  PERFORM pg_temp.smk_new_sale('ag' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  UPDATE orders SET season = compute_season(CURRENT_DATE) - 1 WHERE id = v_o;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  PERFORM pg_temp.smk_done(v_d, 'ag' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d) <> 2
     OR EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_d AND season IS DISTINCT FROM compute_season(invoice_date)) THEN
    v_fails := v_fails || ' (AG) a payer invoice took the order''s season, not its date''s;';
  END IF;

  -- AH: an inactive customer can't become a payer, on the card or on a line.
  PERFORM pg_temp.smk_new_sale('ah' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  INSERT INTO customers (farm_name, is_active) VALUES ('SMK-SPL-AH' || v_suffix, false) RETURNING id INTO v_inv2;
  BEGIN
    PERFORM pg_temp.smk_card(v_o, v_inv2, 40);
    v_fails := v_fails || ' (AH) the card took an inactive customer;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_CUSTOMER_INACTIVE:%' THEN v_fails := v_fails || ' (AH) wrong refusal on the card: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage) VALUES (v_l1, v_inv2, 100);
    v_fails := v_fails || ' (AH) a line share took an inactive customer;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_CUSTOMER_INACTIVE:%' THEN v_fails := v_fails || ' (AH) wrong refusal on a line: ' || SQLERRM || ';'; END IF;
  END;

  -- AI: a line with its own shares can't move to another sale.
  PERFORM pg_temp.smk_new_sale('ai' || v_suffix);
  SELECT o, l1 INTO v_o, v_l1 FROM smk_sale;
  INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage) VALUES (v_l1, v_payer2, 30);
  PERFORM pg_temp.smk_new_sale('ai2' || v_suffix);
  BEGIN
    UPDATE order_items SET order_id = (SELECT o FROM smk_sale) WHERE id = v_l1;
    v_fails := v_fails || ' (AI) a line with its own shares moved to another sale;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_ITEM_SHARES_LINE_MOVE:%' THEN v_fails := v_fails || ' (AI) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  -- V: row security, last, because it changes role. The card and line shares of a soft-deleted order are hidden.
  PERFORM pg_temp.smk_new_sale('v' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage) VALUES (v_l1, v_payer2, 30);
  v_rep := (SELECT id FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1);
  IF v_rep IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: an active sales rep is required for the row-security step'; END IF;
  IF v_rep IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT EXISTS (SELECT 1 FROM order_item_shares WHERE order_item_id = v_l1)
       OR NOT EXISTS (SELECT 1 FROM order_shares WHERE order_id = v_o) THEN
      v_fails := v_fails || ' (V) a rep cannot read the split on a sale;';
    END IF;
    UPDATE order_item_shares SET split_percentage = 31 WHERE order_item_id = v_l1;
    IF NOT FOUND THEN v_fails := v_fails || ' (V) a rep cannot change a line share;'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  END IF;
  IF has_table_privilege('authenticated', 'public.order_item_shares', 'TRUNCATE') THEN
    v_fails := v_fails || ' (V) authenticated can truncate line shares;';
  END IF;
  IF has_table_privilege('authenticated', 'public.order_shares', 'TRUNCATE') THEN
    v_fails := v_fails || ' (V) authenticated can truncate the card;';
  END IF;
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM 1 FROM order_item_shares LIMIT 1;
    v_fails := v_fails || ' (V) anon can read line shares;';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
  -- An order with nothing delivered, cancelled so it may be soft-deleted.
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-SPL-VD' || v_suffix, v_main, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_o;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit, total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_o, v_p1.id, '[SMOKE] Split V', 'gal', v_p1.current_cost + 7.33, v_p1.current_cost, 1, v_p1.current_cost + 7.33, 0, 1) RETURNING id INTO v_l1;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage) VALUES (v_l1, v_payer2, 30);
  UPDATE orders SET status = 'cancelled' WHERE id = v_o;
  UPDATE orders SET deleted_at = now() WHERE id = v_o;
  SET LOCAL ROLE authenticated;
  IF EXISTS (SELECT 1 FROM order_item_shares WHERE order_item_id = v_l1) OR EXISTS (SELECT 1 FROM order_shares WHERE order_id = v_o) THEN
    v_fails := v_fails || ' (V) a soft-deleted order''s split is still readable;';
  END IF;
  BEGIN
    INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage) VALUES (v_l1, v_payer3, 5);
    v_fails := v_fails || ' (V) a line share was added on a soft-deleted order;';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  -- AL: a line delivered past its planned quantity bills at its capped total, so its unit price no longer
  -- multiplies. The payers split those cents by percentage; nobody pays the full rate for the main customer's free units.
  PERFORM pg_temp.smk_new_sale('ovp' || v_suffix, false);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 50);
  UPDATE order_items SET total_units_needed = total_units_needed * 0.8, total_price = ROUND(total_price * 0.8, 2) WHERE id = v_l1;
  PERFORM confirm_delivery(v_d, v_admin, 'smk-spl-confirm-ovp' || v_suffix);
  PERFORM pg_temp.smk_done(v_d, 'ovp' || v_suffix);
  IF (SELECT max(ii.extended_cents) - min(ii.extended_cents) FROM invoice_items ii WHERE ii.order_item_id = v_l1) > 1
     OR (SELECT sum(ii.extended_cents) FROM invoice_items ii WHERE ii.order_item_id = v_l1)
        IS DISTINCT FROM (SELECT ROUND(oi.total_price * 100)::bigint FROM order_items oi WHERE oi.id = v_l1) THEN
    v_fails := v_fails || ' (AL) a line past its planned quantity did not split its capped total by percentage;';
  END IF;
  -- Just past plan the payer still pays exactly their percentage of the line's cents, rounded down (Mason, 2026-11-06:
  -- exact cents), even where that tops their quantity times price.
  PERFORM pg_temp.smk_new_sale('ovq' || v_suffix, false);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 33.33);
  v_cents := (SELECT ROUND(oi.price_per_unit * 100)::bigint FROM order_items oi WHERE oi.id = v_l1);
  IF (SELECT s.cents FROM _bill_split_line_shares(v_l1, v_cents, 10100) s WHERE s.customer_id = v_payer2)
     IS DISTINCT FROM floor(v_cents * 33.33 / 100)::bigint THEN
    v_fails := v_fails || ' (AL) a payer just past plan did not pay exactly their percentage;';
  END IF;

  -- AM: only a draft switches between chemical sale and misc charge; a posted invoice keeps its type.
  PERFORM pg_temp.smk_new_sale('typ' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_done(v_d, 'typ' || v_suffix);
  SELECT id INTO v_inv FROM invoices WHERE delivery_id = v_d;
  PERFORM post_invoice(v_inv, _invoice_post_version(v_inv), 'smk-spl-typ-post-' || v_suffix);
  BEGIN
    UPDATE invoices SET invoice_type = 'misc_charge' WHERE id = v_inv;
    v_fails := v_fails || ' (AM) a posted invoice changed type;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_TYPE_IMMUTABLE%' THEN v_fails := v_fails || ' (AM) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  -- AN: a one-customer draft with a group id but no split record still blocks a payer: only the split writer's
  -- invoices stand as a group.
  PERFORM pg_temp.smk_new_sale('fgp' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, status, invoice_date, total_amount_cents, total_cost_cents, created_by, invoice_group_id)
    VALUES ('SMK-SPL-AN' || v_suffix, 'chemical_sale', v_o, v_main, 'draft', CURRENT_DATE, 0, 0, v_admin, gen_random_uuid());
  BEGIN
    PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
    v_fails := v_fails || ' (AN) a payer was added past a one-customer draft with a made-up group id;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BILL_SPLIT_HAS_DRAFT%' THEN v_fails := v_fails || ' (AN) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  -- AO: a delivery that drafts its payers clears a flag an earlier field split left, and Create Invoice names every payer's invoice.
  PERFORM pg_temp.smk_new_sale('flg' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_payer2, 40);
  UPDATE orders SET needs_split_billing = true WHERE id = v_o;
  PERFORM pg_temp.smk_done(v_d, 'flg' || v_suffix);
  IF (SELECT needs_split_billing FROM orders WHERE id = v_o) THEN
    v_fails := v_fails || ' (AO) the split flag stayed after every delivery was billed;';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL chem sale bill split:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK chem sale bill split: one invoice per payer to the cent, main customer takes the rest, frozen at delivery, group posts, void reopens the card';
END
$smoke$;
