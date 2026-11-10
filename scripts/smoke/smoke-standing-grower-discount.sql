-- ============================================================================
-- ROLLED-BACK smoke: a standing grower discount comes off product lines, per payer, to the cent
-- ----------------------------------------------------------------------------
-- Migration 20261231110000_standing_grower_discount (billing plan M4b).
--   A  A 3% customer's delivery invoice drafts at products less 3% (rounded half up to the cent)
--   B  A $45.00 freight charge is not discounted
--   C  Re-saving the draft as the screen sends it (its discount line included) never discounts twice
--   D  A hand edit of the discount line, and deleting it, are put right at commit
--   E  A sales rep can't set a standing discount (STANDING_DISCOUNT_ADMIN_ONLY); an admin can
--   F  A customer's new rate does not change their existing draft (each invoice keeps the rate it was drafted at);
--      the draft posts as drafted, and the posted invoice never changes
--   G  Bill Split 50/50, one payer at 3% and one with none: each payer's own discount on their own
--      share; a payer's re-save keeps it, and the group posts (its fingerprint covers the discount)
--   H  A customer with no discount: one line, the product total, nothing added
--   J  A sales rep's misc-charge draft with a negative 'standing_discount' line is refused (only a chemical sale has one)
--   K  A discounted draft switched to misc charge loses its discount line at commit
--   L  A customer's rate changes while they have an open Bill Split payer draft: the customer save succeeds
--   M  A posted Bill Split group unposts after a payer's rate changes, and its amounts stay as posted
--   N  The office's rate moved from 3% to 3.01%: the line's label follows even when the cents don't change
--   O  The discount's own audit entry: an 'invoice_updated' record with the change in total, so the trail adds up
--   P  A rate change keeps every field of the draft's lines (rate per acre, acres, price source)
--   Q  A new empty chemical-sale draft records its customer's rate at commit
--   R  A field application draft whose total is not the sum of its lines: editing a line never changes its total
--   S  A chemical sale drafted and posted in one transaction still records its rate (0%), so unposting after the
--      customer moves to 5% keeps the posted amount
--   I  The office changes a sale's rate on its draft (set_invoice_standing_discount, admin only): 1.5%, then 0
--      (no line), then back to the customer's rate; a rep is refused, a posted invoice is refused, a direct
--      write of the rate table is refused, a replay repeats its first answer and a reused key with another rate is refused, and a split payer's draft takes its own rate and its group still posts
--
-- The discount is written at commit (a deferred constraint trigger). This file runs as ONE statement,
-- so each step ends with SET CONSTRAINTS ALL IMMEDIATE / DEFERRED: the commit point of that call in the app.
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- order, delivery and invoice is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_customer uuid;
  v_payer2 uuid;
  v_product public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_line uuid;
  v_delivery uuid;
  v_invoice uuid;
  v_invoice2 uuid;
  v_group uuid;
  v_product_cents bigint;
  v_off bigint;
  v_header jsonb;
  v_lines jsonb;
  v_fails text := '';
  v_case text;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_payer2 FROM customers WHERE is_active = true AND id <> v_customer ORDER BY created_at, id LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_customer IS NULL OR v_payer2 IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and sales rep, two active customers and an active product with a cost';
  END IF;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE customers SET standing_discount_pct = 3 WHERE id = v_customer;
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_payer2;

  -- A: a 100-unit line at $1.37 over cost, delivered in full, as the M1 smoke builds it.
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-DSC-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Standing discount', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
      100, (v_product.current_cost + 1.37) * 100, 0, 100) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-DSC-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 100, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-dsc-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-dsc-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; standing discount');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT id INTO v_invoice FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo';
  IF v_invoice IS NULL THEN
    v_invoice := create_invoice_for_unbilled_delivery(v_delivery, v_admin, 'smk-dsc-invoice-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  END IF;
  v_product_cents := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND product_id IS NOT NULL);
  v_off := round(v_product_cents * 3 / 100.0);
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents - v_off
     OR (SELECT count(*) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount'
           AND extended_cents = -v_off AND description = 'Standing discount 3%') <> 1 THEN
    v_fails := v_fails || format(' (A) drafted at %s cents, want %s (products %s less %s);',
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), v_product_cents - v_off, v_product_cents, v_off);
  END IF;

  -- B: freight, saved as the invoice screen sends it.
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
      'unit_price_cents', 4500, 'extended_cents', 4500, 'cost_cents', 0, 'sort_order', 20, 'charge_type', 'freight')),
      'smk-dsc-freight-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (B) the freight save was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents - v_off + 4500 THEN
    v_fails := v_fails || format(' (B) with freight %s cents, want %s;', (SELECT total_amount_cents FROM invoices WHERE id = v_invoice),
      v_product_cents - v_off + 4500);
  END IF;

  -- C: the same lines saved again, the discount line included.
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
    INTO v_lines FROM invoice_items it WHERE it.invoice_id = v_invoice;
  BEGIN
    PERFORM save_invoice(v_header, v_lines, 'smk-dsc-resave-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (C) the re-save was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents - v_off + 4500
     OR (SELECT count(*) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount') <> 1 THEN
    v_fails := v_fails || format(' (C) after a re-save %s cents and %s discount lines, want %s and 1;',
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice),
      (SELECT count(*) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount'), v_product_cents - v_off + 4500);
  END IF;

  -- D: the line edited by hand, then deleted, as owner (below every grant): commit puts it right each time.
  FOREACH v_case IN ARRAY ARRAY['edit', 'delete'] LOOP
    BEGIN
      IF v_case = 'edit' THEN
        UPDATE invoice_items SET unit_price_cents = -1, extended_cents = -1
         WHERE invoice_id = v_invoice AND charge_type = 'standing_discount';
      ELSE
        DELETE FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount';
      END IF;
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    EXCEPTION WHEN OTHERS THEN
      NULL;   -- a refusal also keeps it right
    END;
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents - v_off + 4500
       OR (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount')
          IS DISTINCT FROM -v_off THEN
      v_fails := v_fails || format(' (D) after a hand %s the invoice is %s cents, want %s;', v_case,
        (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), v_product_cents - v_off + 4500);
    END IF;
  END LOOP;

  -- E: a rep is refused; F: an admin's change reaches the open draft.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    UPDATE customers SET standing_discount_pct = 5 WHERE id = v_customer;
    v_fails := v_fails || ' (E) a sales rep set a standing discount;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'STANDING_DISCOUNT_ADMIN_ONLY:%' THEN
      v_fails := v_fails || ' (E) wrong refusal: ' || SQLERRM || ';';
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE customers SET standing_discount_pct = 2 WHERE id = v_customer;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice)
     IS DISTINCT FROM v_product_cents - v_off + 4500 THEN
    v_fails := v_fails || format(' (F) the draft moved to %s cents when the customer moved to 2%%, want it kept at its 3%% (%s);',
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), v_product_cents - v_off + 4500);
  END IF;
  BEGIN
    PERFORM post_invoice(v_invoice, _invoice_post_version(v_invoice), 'smk-dsc-post-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) posting was refused: ' || SQLERRM || ';';
  END;
  UPDATE customers SET standing_discount_pct = 3 WHERE id = v_customer;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT status FROM invoices WHERE id = v_invoice) IS DISTINCT FROM 'posted'
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice)
        IS DISTINCT FROM v_product_cents - v_off + 4500 THEN
    v_fails := v_fails || format(' (F) the posted invoice is %s at %s cents, want posted and unchanged;',
      (SELECT status FROM invoices WHERE id = v_invoice), (SELECT total_amount_cents FROM invoices WHERE id = v_invoice));
  END IF;

  -- G: Bill Split 50/50, the main customer at 3%, payer 2 with none.
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-DSG-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Split discount', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
      100, (v_product.current_cost + 1.37) * 100, 0, 100) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)
    VALUES (v_order, v_customer, '[SMOKE] main', 50, 0, true, 1), (v_order, v_payer2, '[SMOKE] payer 2', 50, 0, false, 2);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-DSG-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 100, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-dsg-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-dsg-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; split standing discount');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT id, invoice_group_id INTO v_invoice, v_group FROM invoices
   WHERE order_id = v_order AND customer_id = v_customer AND status NOT IN ('voided', 'cancelled');
  SELECT id INTO v_invoice2 FROM invoices WHERE order_id = v_order AND customer_id = v_payer2 AND status NOT IN ('voided', 'cancelled');
  v_product_cents := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND product_id IS NOT NULL);
  v_off := round(v_product_cents * 3 / 100.0);
  IF v_group IS NULL OR v_invoice2 IS NULL
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents - v_off
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2)
        IS DISTINCT FROM (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice2 AND product_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice2 AND charge_type = 'standing_discount') THEN
    v_fails := v_fails || format(' (G) payers drafted %s and %s cents, want %s (3%% off %s) and the undiscounted share;',
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2),
      v_product_cents - v_off, v_product_cents);
  END IF;
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
    PERFORM save_invoice(v_header, v_lines, 'smk-dsg-resave-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    PERFORM post_invoice_group(v_group, v_admin,
      (SELECT jsonb_object_agg(id, _invoice_post_version(id)) FROM invoices
        WHERE invoice_group_id = v_group AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL),
      'smk-dsg-post-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (G) the payer re-save or the group post was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT count(*) FROM invoices WHERE id IN (v_invoice, v_invoice2) AND status = 'posted') <> 2
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents - v_off THEN
    v_fails := v_fails || format(' (G) after re-save and group post: %s posted, payer 1 at %s cents (want 2 posted, %s);',
      (SELECT count(*) FROM invoices WHERE id IN (v_invoice, v_invoice2) AND status = 'posted'),
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), v_product_cents - v_off);
  END IF;

  -- H: no discount, no line.
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-DSN-' || v_suffix, v_payer2, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] No discount', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
      10, (v_product.current_cost + 1.37) * 10, 0, 10) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-DSN-' || v_suffix, v_order, v_payer2, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 10, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-dsn-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-dsn-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; no standing discount');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT id INTO v_invoice FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo';
  IF v_invoice IS NULL
     OR (SELECT count(*) FROM invoice_items WHERE invoice_id = v_invoice) <> 1
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice)
        IS DISTINCT FROM (SELECT extended_cents FROM invoice_items WHERE invoice_id = v_invoice) THEN
    v_fails := v_fails || ' (H) a customer with no discount did not get one plain line at the product total;';
  END IF;

  -- I: the office's rate on one sale. v_invoice is H's draft (payer 2, no customer rate).
  BEGIN
    PERFORM set_invoice_standing_discount(v_invoice, 1.5, 'smk-dsi-15-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    v_product_cents := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND product_id IS NOT NULL);
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents - round(v_product_cents * 1.5 / 100.0) THEN
      v_fails := v_fails || format(' (I) at 1.5%% the draft is %s cents, want %s;', (SELECT total_amount_cents FROM invoices WHERE id = v_invoice),
        v_product_cents - round(v_product_cents * 1.5 / 100.0));
    END IF;
    PERFORM set_invoice_standing_discount(v_invoice, 0, 'smk-dsi-0-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents
       OR EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount') THEN
      v_fails := v_fails || ' (I) a 0% rate on the sale still took a discount;';
    END IF;
    UPDATE customers SET standing_discount_pct = 2 WHERE id = v_payer2;
    PERFORM set_invoice_standing_discount(v_invoice, NULL, 'smk-dsi-null-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_product_cents - round(v_product_cents * 2 / 100.0) THEN
      v_fails := v_fails || ' (I) clearing the sale''s rate did not go back to the customer''s 2%;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (I) setting the sale''s rate failed: ' || SQLERRM || ';';
  END;
  -- A direct write of a sale's rate, as a signed-in admin through the API role: no write grant, refused.
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO invoice_standing_discount_rates (invoice_id, rate_pct, set_by) VALUES (v_invoice, 9, v_admin);
    v_fails := v_fails || ' (I) a direct write of the sale''s rate was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN v_fails := v_fails || ' (I) wrong refusal of a direct write: ' || SQLERRM || ';'; END IF;
  END;
  RESET ROLE;
  -- Replay: the same key and rate returns the first answer and changes nothing; the same key with another rate is refused.
  BEGIN
    PERFORM set_invoice_standing_discount(v_invoice, 2.5, 'smk-dsi-replay-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    v_off := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
    IF (set_invoice_standing_discount(v_invoice, 2.5, 'smk-dsi-replay-' || v_suffix) ->> 'total_amount_cents')::bigint IS DISTINCT FROM v_off THEN
      v_fails := v_fails || ' (I) a replay did not return the first answer;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (I) the replay failed: ' || SQLERRM || ';';
  END;
  BEGIN
    PERFORM set_invoice_standing_discount(v_invoice, 4, 'smk-dsi-replay-' || v_suffix);
    v_fails := v_fails || ' (I) a reused key with a different rate was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN v_fails := v_fails || ' (I) wrong refusal for a reused key: ' || SQLERRM || ';'; END IF;
  END;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    PERFORM set_invoice_standing_discount(v_invoice, 5, 'smk-dsi-rep-' || v_suffix);
    v_fails := v_fails || ' (I) a sales rep set a sale''s rate;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'STANDING_DISCOUNT_ADMIN_ONLY:%' THEN v_fails := v_fails || ' (I) wrong refusal for a rep: ' || SQLERRM || ';'; END IF;
  END;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  -- G's posted group: refused on a posted invoice.
  BEGIN
    PERFORM set_invoice_standing_discount(v_invoice2, 1, 'smk-dsi-posted-' || v_suffix);
    v_fails := v_fails || ' (I) a posted invoice took a new rate;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_NOT_DRAFT:%' THEN v_fails := v_fails || ' (I) wrong refusal for a posted invoice: ' || SQLERRM || ';'; END IF;
  END;

  -- I (split): a fresh Bill Split 50/50; payer 2's draft gets the office's 1% (their customer rate is 2%),
  -- payer 1 keeps their 3%, and the group posts at those amounts.
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-DSO-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Split override', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
      100, (v_product.current_cost + 1.37) * 100, 0, 100) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)
    VALUES (v_order, v_customer, '[SMOKE] main', 50, 0, true, 1), (v_order, v_payer2, '[SMOKE] payer 2', 50, 0, false, 2);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-DSO-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 100, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-dso-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-dso-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; split override');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT id, invoice_group_id INTO v_invoice, v_group FROM invoices
   WHERE order_id = v_order AND customer_id = v_customer AND status NOT IN ('voided', 'cancelled');
  SELECT id INTO v_invoice2 FROM invoices WHERE order_id = v_order AND customer_id = v_payer2 AND status NOT IN ('voided', 'cancelled');
  BEGIN
    PERFORM set_invoice_standing_discount(v_invoice2, 1, 'smk-dso-rate-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    PERFORM post_invoice_group(v_group, v_admin,
      (SELECT jsonb_object_agg(id, _invoice_post_version(id)) FROM invoices
        WHERE invoice_group_id = v_group AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL),
      'smk-dso-post-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (I split) the payer''s rate or the group post was refused: ' || SQLERRM || ';';
  END;
  v_product_cents := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice2 AND product_id IS NOT NULL);
  v_off := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND product_id IS NOT NULL);
  IF (SELECT count(*) FROM invoices WHERE id IN (v_invoice, v_invoice2) AND status = 'posted') <> 2
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2) IS DISTINCT FROM v_product_cents - round(v_product_cents * 1 / 100.0)
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_off - round(v_off * 3 / 100.0) THEN
    v_fails := v_fails || format(' (I split) %s posted; payer 2 at %s cents (want %s at 1%%), payer 1 at %s (want %s at 3%%);',
      (SELECT count(*) FROM invoices WHERE id IN (v_invoice, v_invoice2) AND status = 'posted'),
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2), v_product_cents - round(v_product_cents * 1 / 100.0),
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), v_off - round(v_off * 3 / 100.0));
  END IF;

  -- J: a rep's misc-charge draft with a negative 'standing_discount' line.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    PERFORM save_invoice(jsonb_build_object('customer_id', v_payer2, 'invoice_type', 'misc_charge', 'status', 'draft', 'salesman_id', v_rep),
      jsonb_build_array(jsonb_build_object('description', 'Freight', 'quantity', 1, 'unit_price_cents', 1000, 'extended_cents', 1000, 'cost_cents', 0, 'sort_order', 1, 'charge_type', 'freight'),
                        jsonb_build_object('description', 'Standing discount 90%', 'quantity', 1, 'unit_price_cents', -900, 'extended_cents', -900, 'cost_cents', 0, 'sort_order', 2, 'charge_type', 'standing_discount')),
      'smk-dsj-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    v_fails := v_fails || ' (J) a misc-charge draft took a standing discount line;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'STANDING_DISCOUNT_LINE_SCOPE:%' THEN v_fails := v_fails || ' (J) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- K: a fresh 3% draft switched to misc charge (as owner: the type switch path) loses its discount line.
  UPDATE customers SET standing_discount_pct = 3 WHERE id = v_customer;
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-DSK-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Type switch', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
      10, (v_product.current_cost + 1.37) * 10, 0, 10) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-DSK-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 10, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-dsk-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-dsk-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; type switch');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT id INTO v_invoice FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo';
  UPDATE invoices SET invoice_type = 'misc_charge' WHERE id = v_invoice;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount')
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice)
        IS DISTINCT FROM (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice) THEN
    v_fails := v_fails || ' (K) a draft switched to misc charge kept its standing discount line;';
  END IF;

  -- L, M: a fresh Bill Split 50/50 (main 3%, payer 2 none). L: payer 2's rate changes while the drafts are open.
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_payer2;
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-DSL-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Rate change on split', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
      100, (v_product.current_cost + 1.37) * 100, 0, 100) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)
    VALUES (v_order, v_customer, '[SMOKE] main', 50, 0, true, 1), (v_order, v_payer2, '[SMOKE] payer 2', 50, 0, false, 2);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-DSL-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 100, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-dsl-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-dsl-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; rate change on split');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT id, invoice_group_id INTO v_invoice, v_group FROM invoices
   WHERE order_id = v_order AND customer_id = v_customer AND status NOT IN ('voided', 'cancelled');
  SELECT id INTO v_invoice2 FROM invoices WHERE order_id = v_order AND customer_id = v_payer2 AND status NOT IN ('voided', 'cancelled');
  v_off := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2);
  BEGIN
    UPDATE customers SET standing_discount_pct = 4 WHERE id = v_payer2;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (L) a customer''s rate change failed while they had an open split draft: ' || SQLERRM || ';';
  END;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2) IS DISTINCT FROM v_off THEN
    v_fails := v_fails || ' (L) the open split draft changed with the customer''s rate;';
  END IF;
  -- M: post the group, change payer 2's rate again, unpost the group: it unposts at its posted amounts.
  BEGIN
    PERFORM post_invoice_group(v_group, v_admin,
      (SELECT jsonb_object_agg(id, _invoice_post_version(id)) FROM invoices
        WHERE invoice_group_id = v_group AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL),
      'smk-dsm-post-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    UPDATE customers SET standing_discount_pct = 7 WHERE id = v_payer2;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    PERFORM unpost_invoice_group(v_group, v_admin, 'smk-dsm-unpost-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (M) post, rate change, unpost failed: ' || SQLERRM || ';';
  END;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2) IS DISTINCT FROM v_off THEN
    v_fails := v_fails || format(' (M) the unposted payer invoice moved to %s cents, want it kept at %s;',
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2), v_off);
  END IF;

  -- N: the office moves the main customer's draft (K's invoice is misc now; use a fresh chemical draft: the group's
  -- main payer, now unposted) from 3% to 3.01%: the label follows.
  BEGIN
    PERFORM set_invoice_standing_discount(v_invoice, 3.01, 'smk-dsn-301-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (N) setting 3.01% failed: ' || SQLERRM || ';';
  END;
  IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount'
                   AND description = 'Standing discount 3.01%') THEN
    v_fails := v_fails || format(' (N) the label is %s, want Standing discount 3.01%%;',
      COALESCE((SELECT description FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount'), 'missing'));
  END IF;

  -- O: the group's main payer (v_invoice) was discounted at drafting; its trail has the discount's own entry.
  IF NOT EXISTS (SELECT 1 FROM financial_audit_log WHERE entity_id = v_invoice AND operation_type = 'invoice_updated'
                   AND description LIKE 'Standing discount%' AND total_impact_cents < 0) THEN
    v_fails := v_fails || ' (O) no audit entry records the standing discount''s change to the total;';
  END IF;

  -- P: line fields survive the office's rate change (set as owner on a fresh 3% delivery draft's product line).
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-DSP-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product.id, '[SMOKE] Fields kept', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
      10, (v_product.current_cost + 1.37) * 10, 0, 10) RETURNING id INTO v_line;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-DSP-' || v_suffix, v_order, v_customer, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_delivery, v_line, v_product.id, 10, 'gal');
  PERFORM confirm_delivery(v_delivery, v_admin, 'smk-dsp-confirm-' || v_suffix);
  PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-dsp-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; fields kept');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  SELECT id INTO v_invoice FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo';
  BEGIN
    UPDATE invoice_items SET rate_per_acre = 1.5, acres = 10, rate_unit = 'gal/ac', notes = '[SMOKE] keep me'
     WHERE invoice_id = v_invoice AND product_id IS NOT NULL;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    PERFORM set_invoice_standing_discount(v_invoice, 1, 'smk-dsp-rate-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (P) setting up or changing the rate failed: ' || SQLERRM || ';';
  END;
  IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND product_id IS NOT NULL
                   AND rate_per_acre = 1.5 AND acres = 10 AND rate_unit = 'gal/ac' AND notes = '[SMOKE] keep me') THEN
    v_fails := v_fails || ' (P) the rate change dropped fields from the draft''s product line;';
  END IF;

  -- Q: an empty chemical-sale draft (inserted directly on a fresh order: the app's paths always draft with lines) records
  -- its customer's 3% at commit.
  BEGIN
    INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
      VALUES ('SMK-DSQ-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
    INSERT INTO invoices (order_id, customer_id, invoice_type, status, invoice_date, salesman_id, created_by, total_amount_cents)
      VALUES (v_order, v_customer, 'chemical_sale', 'draft', CURRENT_DATE, v_admin, v_admin, 0) RETURNING id INTO v_invoice;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_invoice) IS DISTINCT FROM 3 THEN
      v_fails := v_fails || format(' (Q) the new empty draft recorded rate %s, want 3;',
        (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_invoice));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (Q) creating an empty chemical-sale draft failed: ' || SQLERRM || ';';
  END;

  -- R: a field application draft with a header total of 5000 cents and one 3000-cent line (as owner).
  BEGIN
    SET LOCAL session_replication_role = replica;   -- fixture only: a field app draft shaped as its writer leaves it
    INSERT INTO invoices (customer_id, invoice_type, status, invoice_date, salesman_id, created_by, total_amount_cents)
      VALUES (v_customer, 'field_application', 'draft', CURRENT_DATE, v_admin, v_admin, 5000) RETURNING id INTO v_invoice;
    INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order)
      VALUES (v_invoice, '[SMOKE] application', 1, 3000, 3000, 0, 1);
    SET LOCAL session_replication_role = origin;
    UPDATE invoice_items SET notes = '[SMOKE] touched' WHERE invoice_id = v_invoice;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM 5000 THEN
      v_fails := v_fails || format(' (R) a field application draft''s total moved to %s, want 5000;', (SELECT total_amount_cents FROM invoices WHERE id = v_invoice));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (R) the field application check failed: ' || SQLERRM || ';';
  END;

  -- S: payer 2 at 0%: a delivery draft posted before any commit point, then 5%, then unposted.
  BEGIN
    UPDATE customers SET standing_discount_pct = 0 WHERE id = v_payer2;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
      VALUES ('SMK-DSS-' || v_suffix, v_payer2, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
    PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
      total_units_needed, total_price, quantity_delivered, quantity_remaining)
      VALUES (v_order, v_product.id, '[SMOKE] Same-transaction post', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
        10, (v_product.current_cost + 1.37) * 10, 0, 10) RETURNING id INTO v_line;
    PERFORM set_config('app.crx_below_cost_operation', '', true);
    INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
      VALUES ('SMK-DSS-' || v_suffix, v_order, v_payer2, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_delivery;
    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES (v_delivery, v_line, v_product.id, 10, 'gal');
    PERFORM confirm_delivery(v_delivery, v_admin, 'smk-dss-confirm-' || v_suffix);
    PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
      'smk-dss-complete-' || v_suffix, NULL, 'no_proof', 'Rolled-back smoke; same-transaction post');
    SELECT id INTO v_invoice FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo';
    PERFORM post_invoice(v_invoice, _invoice_post_version(v_invoice), 'smk-dss-post-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    v_off := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
    UPDATE customers SET standing_discount_pct = 5 WHERE id = v_payer2;
    PERFORM unpost_invoice(v_invoice, v_admin, 'smk-dss-unpost-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_off THEN
      v_fails := v_fails || format(' (S) unposting moved the total from %s to %s;', v_off, (SELECT total_amount_cents FROM invoices WHERE id = v_invoice));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (S) the same-transaction post check failed: ' || SQLERRM || ';';
  END;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL standing grower discount:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK standing grower discount: off product lines only, per payer, to the cent, re-saves and hand edits put right, admin only, each invoice keeps its drafted rate, posted and unposted amounts never move, only a chemical sale carries the line, the split group posts';
END
$smoke$;
