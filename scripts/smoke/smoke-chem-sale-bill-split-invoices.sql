-- ============================================================================
-- ROLLED-BACK smoke: a Bill Split sale bills one invoice per payer, to the cent
-- ----------------------------------------------------------------------------
-- Migration 20261114210000_chem_sale_bill_split_invoices (billing plan M2).
--   A  Card 60/40 on line 1, line 2's own shares 100% to the main customer: a delivery drafts two
--      invoices in one group, base-1 and base-2, CS- numbers, each line adds up exactly
--   B  A three-way split: the leftover cents go to the main customer
--   C  The card and the line shares refuse changes after the first delivery (BILL_SPLIT_FROZEN)
--   C2 A frozen share can't leave its sale by moving to an open one; a card can't total over 100%
--   D  A direct write to a payer's line is refused, and save_invoice can't bill past the delivery
--   E  Re-saving a payer's draft keeps its cents; a freight charge goes on one payer's draft
--   F  A one-customer chemical-sale invoice on this sale is refused (ORDER_HAS_BILL_SPLIT)
--   G  The group posts at its reviewed versions, and the second payer can return their share
--   H  Void the delivery on a fresh sale: both drafts cancel and the card reopens
--   I  Under 100%: the rest stays with the main customer
--   J  Create Invoice on a delivery with no invoice drafts per payer
--   K  No card: one plain CS- invoice, as before
--   L  A one-customer draft on the sale refuses a new payer (BILL_SPLIT_HAS_DRAFT) until it is gone
--   M  A payer draft's product lines follow the split: quantity, price and removal are refused
--      (BILL_SPLIT_LINES_LOCKED) and a charge still saves
--   N  Cost: the payers' costs add up exactly to the line's cost, and a re-save keeps them
--   O  A share too small for one unit of quantity gets no cents either
--   P  A line share records when its percentage changed
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- order, delivery and invoice is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_main uuid;
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
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_main FROM customers WHERE is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_payer2 FROM customers WHERE is_active = true AND id <> v_main ORDER BY created_at LIMIT 1;
  SELECT id INTO v_payer3 FROM customers WHERE is_active = true AND id NOT IN (v_main, v_payer2) ORDER BY created_at LIMIT 1;
  SELECT * INTO v_p1 FROM products WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2) ORDER BY created_at LIMIT 1;
  SELECT * INTO v_p2 FROM products WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2) AND id <> v_p1.id ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_payer3 IS NULL OR v_p2.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, three active customers and two active products with a cost';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- A two-line sale, 10 units each, $7.33 above cost, with a scheduled delivery of everything.
  CREATE TEMP TABLE smk_sale (o uuid, l1 uuid, l2 uuid, d uuid) ON COMMIT DROP;
  CREATE FUNCTION pg_temp.smk_new_sale(p_tag text) RETURNS void LANGUAGE plpgsql AS $f$
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
    PERFORM confirm_delivery(d, v_a, 'smk-spl-confirm-' || p_tag);
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

  SELECT jsonb_object_agg(id, _invoice_post_version(id)) INTO v_versions FROM invoices WHERE invoice_group_id = v_group;
  BEGIN
    PERFORM post_invoice_group(v_group, v_admin, v_versions, 'smk-spl-post-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (G) the group post was refused: ' || SQLERRM || ';';
  END;
  IF EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'posted') THEN
    v_fails := v_fails || ' (G) a payer invoice did not post;';
  END IF;
  IF NOT _return_customer_is_split_payer((SELECT order_id FROM invoices WHERE id = v_inv), v_payer2) THEN
    v_fails := v_fails || ' (G) the second payer is not a split payer for returns;';
  END IF;

  -- B: shares unevenly three ways. The main customer takes the rest of each line.
  PERFORM pg_temp.smk_new_sale('b' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM pg_temp.smk_card(v_o, v_main, 33.333334);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 33.333333);
  PERFORM pg_temp.smk_card(v_o, v_payer3, 33.333333);
  PERFORM pg_temp.smk_done(v_d, 'b' || v_suffix);
  IF (SELECT count(*) FROM invoices WHERE delivery_id = v_d) <> 3
     OR (SELECT sum(total_amount_cents) FROM invoices WHERE delivery_id = v_d)
          IS DISTINCT FROM (SELECT round(sum(total_price) * 100)::bigint FROM order_items WHERE order_id = v_o)
     OR (SELECT total_amount_cents FROM invoices WHERE delivery_id = v_d AND customer_id = v_main)
          < (SELECT total_amount_cents FROM invoices WHERE delivery_id = v_d AND customer_id = v_payer2)
     OR EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                 WHERE i.delivery_id = v_d AND i.customer_id = v_payer2
                   AND ii.extended_cents <> floor((SELECT total_price * 100 FROM order_items WHERE id = ii.order_item_id) * 33.333333 / 100)) THEN
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

  -- N: Sol's half-cent case: 10 units at $0.015 cost 15 cents; 50/50 rounds each payer's 7.5 up to 8.
  PERFORM pg_temp.smk_new_sale('n' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  UPDATE order_items SET cost_per_unit = 0.015 WHERE id = v_l1;
  UPDATE order_items SET cost_per_unit = 0.015 WHERE id = v_l2;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM pg_temp.smk_card(v_o, v_payer2, 50);
  PERFORM pg_temp.smk_done(v_d, 'n' || v_suffix);
  IF (SELECT sum(total_cost_cents) FROM invoices WHERE delivery_id = v_d) IS DISTINCT FROM 30::bigint THEN
    v_fails := v_fails || format(' (N) payer costs total %s, want 30;', (SELECT sum(total_cost_cents) FROM invoices WHERE delivery_id = v_d));
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
    v_fails := v_fails || format(' (N) a re-save moved the payer cost %s to %s;', v_cents, (SELECT total_cost_cents FROM invoices WHERE id = v_inv));
  END IF;

  -- O and P: a 0.001% share of one $1,000 unit rounds to no quantity, so it gets no cents.
  PERFORM pg_temp.smk_new_sale('o' || v_suffix);
  SELECT o, l1, l2, d INTO v_o, v_l1, v_l2, v_d FROM smk_sale;
  INSERT INTO order_item_shares (order_item_id, customer_id, split_percentage, updated_at) VALUES (v_l1, v_payer2, 0.001, '2000-01-01');
  IF EXISTS (SELECT 1 FROM _bill_split_line_shares(v_l1, 100000, 10000) x WHERE x.customer_id = v_payer2 AND (x.units <> 0 OR x.cents <> 0))
     OR (SELECT sum(x.cents) FROM _bill_split_line_shares(v_l1, 100000, 10000) x) <> 100000
     OR (SELECT sum(x.units) FROM _bill_split_line_shares(v_l1, 100000, 10000) x) <> 10000 THEN
    v_fails := v_fails || ' (O) a share with no quantity got cents, or the line stopped adding up;';
  END IF;
  UPDATE order_item_shares SET split_percentage = 1 WHERE order_item_id = v_l1;
  IF (SELECT updated_at FROM order_item_shares WHERE order_item_id = v_l1) < '2020-01-01' THEN
    v_fails := v_fails || ' (P) changing a line share did not record when;';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL chem sale bill split:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK chem sale bill split: one invoice per payer to the cent, main customer takes the rest, frozen at delivery, group posts, void reopens the card';
END
$smoke$;
