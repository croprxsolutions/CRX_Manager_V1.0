-- ============================================================================
-- ROLLED-BACK smoke: the sales tax checkbox taxes a chemical sale per payer, to the cent
-- ----------------------------------------------------------------------------
-- Migration 20261231120000_sales_tax_checkbox (billing plan M4a, scenario B10).
--   A  A taxed sale for a 3% customer, with $45.00 freight: tax = round((products - discount + freight) x 6.25%),
--      half up, on its own "Sales tax 6.25%" line; the total is the lines' sum
--   B  A sale is untaxed by default: no tax line
--   C  Re-saving the draft as the screen sends it (tax and discount lines included) never taxes twice
--   D  A hand edit of the tax line, moving it above the products, and deleting it, are put right at commit
--   E  Bill Split 50/50, taxed, one payer at 3% and one with none: each payer's tax on its own share; the group posts
--   F  Unticking the box takes tax off the sale's drafts and leaves posted invoices alone; ticking puts it back;
--      a rep can tick their own sale, not another rep's; a replay repeats its answer; a reused key with the
--      other value is refused; the anonymous role can't call it
--   G  The Settings rate moves from 6.25 to 7: an existing draft keeps 6.25 on a re-save; a new draft takes 7
--   H  A Settings rate that is not a plain percentage is refused
--   J  A sales tax line on a misc-charge invoice is refused (only a chemical sale has one)
--   K  A taxed draft whose tax line is stale can't be posted before its commit point
--   L  E's posted group, unposted after the box is unticked, keeps its posted tax
--   T  A taxed draft switched to misc charge loses its tax line and rate; switched back, it is taxed again
--   R  Returns of a taxed, 3% sale (two lines, one in two parts) credit its posted total, tax included, to the cent
--
-- Tax is written at commit (the standing discount's deferred trigger). This file runs as ONE statement, so each
-- step ends with SET CONSTRAINTS ALL IMMEDIATE / DEFERRED: the commit point of that call in the app.
--
-- HOW TO RUN: execute this whole file as ONE statement (psql -c, or Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture is rolled back.
-- Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_rep2 uuid;
  v_customer uuid;
  v_payer2 uuid;
  v_product public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_order_e uuid;
  v_delivery uuid;
  v_invoice uuid;
  v_invoice2 uuid;
  v_group uuid;
  v_p bigint;
  v_d bigint;
  v_t bigint;
  v_t2 bigint;
  v_e1 bigint;
  v_e2 bigint;
  v_header jsonb;
  v_lines jsonb;
  v_res jsonb;
  v_fails text := '';
  v_case text;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep2 FROM profiles WHERE role = 'sales_rep' AND is_active = true AND id <> v_rep ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_payer2 FROM customers WHERE is_active = true AND id <> v_customer ORDER BY created_at, id LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_customer IS NULL OR v_payer2 IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and sales rep, two active customers and an active product with a cost';
  END IF;

  -- A sale: order, lines (price over cost, quantity), optional 50/50 payer, a full delivery, its draft(s).
  EXECUTE $f$
    CREATE FUNCTION pg_temp.smk_sale(p_admin uuid, p_rep uuid, p_product uuid, p_cost numeric, p_customer uuid,
                                     p_payer2 uuid, p_tax boolean, p_tag text, p_lines jsonb) RETURNS uuid
    LANGUAGE plpgsql AS $b$
    DECLARE v_order uuid; v_delivery uuid;
    BEGIN
      INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
        VALUES ('SMK-TAX-' || p_tag, p_customer, CURRENT_DATE, 'confirmed', p_rep) RETURNING id INTO v_order;
      PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
      INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
        total_units_needed, total_price, quantity_delivered, quantity_remaining)
        SELECT v_order, p_product, '[SMOKE] Sales tax ' || n, 'gal', p_cost + (x ->> 'over')::numeric, p_cost,
               (x ->> 'q')::numeric, (p_cost + (x ->> 'over')::numeric) * (x ->> 'q')::numeric, 0, (x ->> 'q')::numeric
          FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS l(x, n);
      PERFORM set_config('app.crx_below_cost_operation', '', true);
      IF p_payer2 IS NOT NULL THEN
        INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)
          VALUES (v_order, p_customer, '[SMOKE] main', 50, 0, true, 1), (v_order, p_payer2, '[SMOKE] payer 2', 50, 0, false, 2);
      END IF;
      IF p_tax THEN
        PERFORM set_order_sales_tax(v_order, true, 'smk-tax-on-' || p_tag);
      END IF;
      INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
        VALUES ('SMK-TAX-' || p_tag, v_order, p_customer, 'scheduled', CURRENT_DATE, p_admin) RETURNING id INTO v_delivery;
      INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
        SELECT v_delivery, oi.id, oi.product_id, oi.total_units_needed, 'gal' FROM order_items oi WHERE oi.order_id = v_order;
      PERFORM confirm_delivery(v_delivery, p_admin, 'smk-tax-confirm-' || p_tag);
      PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', p_admin, NULL, NULL, NULL,
        'smk-tax-complete-' || p_tag, NULL, 'no_proof', 'Rolled-back smoke; sales tax');
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      IF NOT EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo') THEN
        PERFORM create_invoice_for_unbilled_delivery(v_delivery, p_admin, 'smk-tax-invoice-' || p_tag);
        SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      END IF;
      RETURN v_order;
    END $b$;
    -- The invoice as the screen sends it to save_invoice.
    CREATE FUNCTION pg_temp.smk_header(p_invoice uuid) RETURNS jsonb LANGUAGE sql AS $b$
      SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type, 'status', i.status,
               'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date, 'payment_terms', i.payment_terms,
               'header_notes', i.header_notes, 'footer_notes', i.footer_notes)
        FROM invoices i WHERE i.id = p_invoice $b$;
    CREATE FUNCTION pg_temp.smk_lines(p_invoice uuid) RETURNS jsonb LANGUAGE sql AS $b$
      SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
               'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
               'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
               'unit_size', it.unit_size, 'notes', it.notes, 'charge_type', it.charge_type, 'vendor', it.vendor) ORDER BY it.sort_order)
        FROM invoice_items it WHERE it.invoice_id = p_invoice $b$;
    CREATE FUNCTION pg_temp.smk_as(p_user uuid) RETURNS void LANGUAGE sql AS $b$
      SELECT set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
             set_config('request.jwt.claim.sub', p_user::text, true) $b$;
  $f$;

  PERFORM pg_temp.smk_as(v_admin);
  UPDATE customers SET standing_discount_pct = 3 WHERE id = v_customer;
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_payer2;
  IF (SELECT setting_value FROM app_settings WHERE setting_key = 'sales_tax_rate') IS DISTINCT FROM '6.25' THEN
    v_fails := v_fails || ' (A) the Settings rate is not 6.25;';
  END IF;

  -- A: taxed, 3%, then $45.00 freight.
  v_order := pg_temp.smk_sale(v_admin, v_admin, v_product.id, v_product.current_cost, v_customer, NULL, true,
                              'a-' || v_suffix, '[{"over": 1.37, "q": 100}]');
  SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
  BEGIN
    PERFORM save_invoice(pg_temp.smk_header(v_invoice), pg_temp.smk_lines(v_invoice) || jsonb_build_array(jsonb_build_object(
      'description', 'Freight', 'quantity', 1, 'unit_price_cents', 4500, 'extended_cents', 4500, 'cost_cents', 0,
      'sort_order', 20, 'charge_type', 'freight')), 'smk-tax-freight-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (A) the freight save was refused: ' || SQLERRM || ';';
  END;
  v_p := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND product_id IS NOT NULL AND charge_type IS NULL);
  v_d := round(v_p * 3 / 100.0);
  v_t := round((v_p - v_d + 4500) * 6.25 / 100.0);
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_p - v_d + 4500 + v_t
     OR (SELECT count(*) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax'
           AND extended_cents = v_t AND unit_price_cents = v_t AND description = 'Sales tax 6.25%') <> 1
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice)
        IS DISTINCT FROM (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice) THEN
    v_fails := v_fails || format(' (A) total %s cents, want %s (products %s less %s, freight 4500, tax %s);',
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), v_p - v_d + 4500 + v_t, v_p, v_d, v_t);
  END IF;

  -- C: saved again with the computed lines included.
  BEGIN
    PERFORM save_invoice(pg_temp.smk_header(v_invoice), pg_temp.smk_lines(v_invoice), 'smk-tax-resave-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (C) the re-save was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_p - v_d + 4500 + v_t
     OR (SELECT count(*) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax') <> 1 THEN
    v_fails := v_fails || format(' (C) after a re-save %s cents, %s tax lines;',
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice),
      (SELECT count(*) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax'));
  END IF;

  -- D: a hand edit, then a delete, of the tax line.
  UPDATE invoice_items SET unit_price_cents = 1, extended_cents = 1 WHERE invoice_id = v_invoice AND charge_type = 'sales_tax';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  UPDATE invoice_items SET sort_order = 0 WHERE invoice_id = v_invoice AND charge_type = 'sales_tax';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT sort_order FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax')
     IS DISTINCT FROM (SELECT max(sort_order) FROM invoice_items WHERE invoice_id = v_invoice) THEN
    v_fails := v_fails || ' (D) a tax line moved above the products stayed there;';
  END IF;
  DELETE FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax';
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_p - v_d + 4500 + v_t
     OR (SELECT count(*) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax' AND extended_cents = v_t) <> 1 THEN
    v_fails := v_fails || ' (D) a hand edit or delete of the tax line was not put right at commit;';
  END IF;

  -- K: the tax line made stale (the rate record removed) and posted before the commit point.
  BEGIN
    DELETE FROM invoice_sales_tax_rates WHERE invoice_id = v_invoice;
    PERFORM post_invoice(v_invoice, _invoice_post_version(v_invoice), 'smk-tax-stale-' || v_suffix);
    v_fails := v_fails || ' (K) a stale tax line was posted;';
    RAISE EXCEPTION 'smk_undo';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SALES_TAX_STALE%' AND SQLERRM <> 'smk_undo' THEN
      v_fails := v_fails || ' (K) refused with the wrong error: ' || SQLERRM || ';';
    END IF;
  END;

  -- B: untaxed by default.
  v_order := pg_temp.smk_sale(v_admin, v_admin, v_product.id, v_product.current_cost, v_payer2, NULL, false,
                              'b-' || v_suffix, '[{"over": 1.37, "q": 10}]');
  SELECT id INTO v_invoice2 FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
  IF (SELECT sales_tax FROM orders WHERE id = v_order) IS NOT FALSE
     OR EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice2 AND charge_type = 'sales_tax')
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2)
        IS DISTINCT FROM (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice2 AND product_id IS NOT NULL) THEN
    v_fails := v_fails || ' (B) an untaxed sale carries tax;';
  END IF;

  -- E: Bill Split 50/50, taxed; main customer 3%, payer 2 none.
  v_order_e := pg_temp.smk_sale(v_admin, v_admin, v_product.id, v_product.current_cost, v_customer, v_payer2, true,
                                'e-' || v_suffix, '[{"over": 1.37, "q": 100}, {"over": 2.11, "q": 7}]');
  SELECT id, invoice_group_id INTO v_invoice, v_group FROM invoices
   WHERE order_id = v_order_e AND customer_id = v_customer AND status NOT IN ('voided', 'cancelled');
  SELECT id INTO v_invoice2 FROM invoices WHERE order_id = v_order_e AND customer_id = v_payer2 AND status NOT IN ('voided', 'cancelled');
  v_p := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND product_id IS NOT NULL AND charge_type IS NULL);
  v_d := round(v_p * 3 / 100.0);
  v_t := round((v_p - v_d) * 6.25 / 100.0);
  v_e1 := v_p - v_d + v_t;
  v_t2 := round((SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice2 AND product_id IS NOT NULL) * 6.25 / 100.0);
  v_e2 := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice2 AND product_id IS NOT NULL) + v_t2;
  IF v_group IS NULL OR v_invoice2 IS NULL
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_e1
     OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2) IS DISTINCT FROM v_e2
     OR (SELECT extended_cents FROM invoice_items WHERE invoice_id = v_invoice2 AND charge_type = 'sales_tax') IS DISTINCT FROM v_t2 THEN
    v_fails := v_fails || format(' (E) payers drafted %s and %s cents, want %s and %s;',
      (SELECT total_amount_cents FROM invoices WHERE id = v_invoice), (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2), v_e1, v_e2);
  END IF;
  BEGIN
    PERFORM save_invoice(pg_temp.smk_header(v_invoice), pg_temp.smk_lines(v_invoice), 'smk-tax-e-resave-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    PERFORM post_invoice_group(v_group, v_admin,
      (SELECT jsonb_object_agg(id, _invoice_post_version(id)) FROM invoices
        WHERE invoice_group_id = v_group AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL),
      'smk-tax-e-post-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (E) the payer re-save or the group post was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT count(*) FROM invoices WHERE id IN (v_invoice, v_invoice2) AND status = 'posted') <> 2 THEN
    v_fails := v_fails || ' (E) the taxed split group did not post;';
  END IF;

  -- F: the box on a sale with drafts and a sale already posted (E).
  v_order := pg_temp.smk_sale(v_admin, v_admin, v_product.id, v_product.current_cost, v_customer, v_payer2, true,
                              'f-' || v_suffix, '[{"over": 1.37, "q": 40}]');
  BEGIN
    v_res := set_order_sales_tax(v_order, false, 'smk-tax-f-off-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (v_res ->> 'drafts_updated')::int <> 2
       OR EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                   WHERE i.order_id = v_order AND ii.charge_type = 'sales_tax')
       OR (SELECT sales_tax FROM orders WHERE id = v_order) IS NOT FALSE THEN
      v_fails := v_fails || ' (F) unticking left tax on the drafts: ' || v_res::text || ';';
    END IF;
    IF set_order_sales_tax(v_order, false, 'smk-tax-f-off-' || v_suffix) IS DISTINCT FROM v_res THEN
      v_fails := v_fails || ' (F) a replay gave another answer;';
    END IF;
    PERFORM set_order_sales_tax(v_order, true, 'smk-tax-f-on-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (SELECT count(*) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
         WHERE i.order_id = v_order AND ii.charge_type = 'sales_tax') <> 2 THEN
      v_fails := v_fails || ' (F) ticking did not tax both payer drafts;';
    END IF;
    -- The split group still posts after the change (its fingerprint covers the tax).
    SELECT invoice_group_id INTO v_group FROM invoices WHERE order_id = v_order AND invoice_group_id IS NOT NULL LIMIT 1;
    PERFORM post_invoice_group(v_group, v_admin,
      (SELECT jsonb_object_agg(id, _invoice_post_version(id)) FROM invoices
        WHERE invoice_group_id = v_group AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL),
      'smk-tax-f-post-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    -- E is posted: unticking it changes no invoice.
    v_res := set_order_sales_tax(v_order_e, false, 'smk-tax-e-off-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (v_res ->> 'drafts_updated')::int <> 0
       OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_e1
       OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2) IS DISTINCT FROM v_e2 THEN
      v_fails := v_fails || ' (F) unticking a posted sale changed it: ' || v_res::text || ';';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) the box failed: ' || SQLERRM || ';';
  END;
  BEGIN
    PERFORM set_order_sales_tax(v_order, false, 'smk-tax-f-on-' || v_suffix);
    v_fails := v_fails || ' (F) a reused key with the other value was accepted;';
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  -- A rep: their own sale yes, another rep's (the admin's) no.
  PERFORM pg_temp.smk_as(v_rep);
  BEGIN
    PERFORM set_order_sales_tax(v_order, false, 'smk-tax-f-rep-' || v_suffix);
    v_fails := v_fails || ' (F) a rep changed another rep''s sale;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SALES_TAX_NOT_ALLOWED%' THEN
      v_fails := v_fails || ' (F) a rep refused with the wrong error: ' || SQLERRM || ';';
    END IF;
  END;
  PERFORM pg_temp.smk_as(v_admin);
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES ('SMK-TAX-REP-' || v_suffix, v_payer2, CURRENT_DATE, 'confirmed', v_rep) RETURNING id INTO v_order;
  PERFORM pg_temp.smk_as(v_rep);
  BEGIN
    PERFORM set_order_sales_tax(v_order, true, 'smk-tax-f-own-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) a rep could not tick their own sale: ' || SQLERRM || ';';
  END;
  PERFORM pg_temp.smk_as(v_admin);
  IF has_function_privilege('anon', 'public.set_order_sales_tax(uuid, boolean, text)', 'EXECUTE') THEN
    v_fails := v_fails || ' (F) the anonymous role can call set_order_sales_tax;';
  END IF;
  IF has_column_privilege('authenticated', 'public.orders', 'sales_tax', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.invoice_sales_tax_rates', 'INSERT,UPDATE,DELETE') THEN
    v_fails := v_fails || ' (F) the box or the rate record can be written directly;';
  END IF;

  -- L: E (posted, now unticked) unposted: its tax stays as posted.
  BEGIN
    PERFORM unpost_invoice_group((SELECT invoice_group_id FROM invoices WHERE id = v_invoice), v_admin, 'smk-tax-l-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) IS DISTINCT FROM v_e1
       OR (SELECT total_amount_cents FROM invoices WHERE id = v_invoice2) IS DISTINCT FROM v_e2 THEN
      v_fails := v_fails || ' (L) unposting changed the posted tax;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (L) unpost failed: ' || SQLERRM || ';';
  END;

  -- G: the Settings rate moves to 7.
  SELECT id INTO v_invoice FROM invoices
   WHERE order_id = (SELECT id FROM orders WHERE order_number = 'SMK-TAX-a-' || v_suffix) AND invoice_type <> 'credit_memo';
  UPDATE app_settings SET setting_value = '7' WHERE setting_key = 'sales_tax_rate';
  PERFORM save_invoice(pg_temp.smk_header(v_invoice), pg_temp.smk_lines(v_invoice), 'smk-tax-g-resave-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax' AND description = 'Sales tax 6.25%') THEN
    v_fails := v_fails || ' (G) an existing draft took the new Settings rate;';
  END IF;
  v_order := pg_temp.smk_sale(v_admin, v_admin, v_product.id, v_product.current_cost, v_payer2, NULL, true,
                              'g-' || v_suffix, '[{"over": 1.37, "q": 10}]');
  SELECT id INTO v_invoice2 FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
  v_p := (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice2 AND product_id IS NOT NULL);
  IF (SELECT extended_cents FROM invoice_items WHERE invoice_id = v_invoice2 AND charge_type = 'sales_tax' AND description = 'Sales tax 7%')
     IS DISTINCT FROM round(v_p * 7 / 100.0)::bigint THEN
    v_fails := v_fails || ' (G) a new draft did not take the new Settings rate;';
  END IF;
  UPDATE app_settings SET setting_value = '6.25' WHERE setting_key = 'sales_tax_rate';

  -- H: a rate that isn't a plain percentage.
  FOREACH v_case IN ARRAY ARRAY['6.25%', '', 'abc', '100', '-1', '6.2555', '{"rate": 6.25}'] LOOP
    BEGIN
      UPDATE app_settings SET setting_value = v_case WHERE setting_key = 'sales_tax_rate';
      v_fails := v_fails || format(' (H) the Settings rate %L was accepted;', v_case);
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- J: a sales tax line on a misc-charge invoice.
  BEGIN
    INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
      VALUES ('SMK-TAX-J-' || v_suffix, v_payer2, 'misc_charge', 'draft', CURRENT_DATE, 100, v_admin) RETURNING id INTO v_invoice;
    INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, charge_type)
      VALUES (v_invoice, 'Sales tax 6.25%', 1, 100, 100, 0, 1, 'sales_tax');
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    v_fails := v_fails || ' (J) a sales tax line on a misc charge was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SALES_TAX_LINE_SCOPE%' THEN
      v_fails := v_fails || ' (J) refused with the wrong error: ' || SQLERRM || ';';
    END IF;
  END;

  -- T: G's new draft (taxed at 7%, Settings now back at 6.25) switched to misc charge and back, as the editor sends it.
  BEGIN
    PERFORM save_invoice(pg_temp.smk_header(v_invoice2) || '{"invoice_type": "misc_charge"}',
      (SELECT jsonb_agg(x) FROM jsonb_array_elements(pg_temp.smk_lines(v_invoice2)) x WHERE x ->> 'charge_type' IS NULL
                                                                                     OR x ->> 'charge_type' NOT IN ('sales_tax', 'standing_discount')),
      'smk-tax-t-misc-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice2 AND charge_type = 'sales_tax')
       OR EXISTS (SELECT 1 FROM invoice_sales_tax_rates WHERE invoice_id = v_invoice2) THEN
      v_fails := v_fails || ' (T) a draft switched to misc charge kept its tax;';
    END IF;
    PERFORM save_invoice(pg_temp.smk_header(v_invoice2) || '{"invoice_type": "chemical_sale"}', pg_temp.smk_lines(v_invoice2),
      'smk-tax-t-back-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice2 AND charge_type = 'sales_tax' AND description = 'Sales tax 6.25%') THEN
      v_fails := v_fails || ' (T) switched back to a chemical sale, the draft was not taxed at the Settings rate;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (T) the type switch failed: ' || SQLERRM || ';';
  END;

  -- R: returns of a taxed, 3% sale credit its posted total.
  BEGIN
    v_order := pg_temp.smk_sale(v_admin, v_admin, v_product.id, v_product.current_cost, v_customer, NULL, true,
                                'r-' || v_suffix, '[{"over": 1.37, "q": 10}, {"over": 2.11, "q": 7}]');
    SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
    PERFORM post_invoice(v_invoice, _invoice_post_version(v_invoice), 'smk-tax-r-post-' || v_suffix);
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax') THEN
      RAISE EXCEPTION 'the posted sale has no tax line';
    END IF;
    FOR v_lines IN SELECT r FROM (VALUES
        (jsonb_build_array(jsonb_build_object('n', 1, 'q', 3))),
        (jsonb_build_array(jsonb_build_object('n', 1, 'q', 7), jsonb_build_object('n', 2, 'q', 7)))) v(r)
    LOOP
      v_header := create_return(jsonb_build_object('customer_id', v_customer, 'order_id', v_order, 'reason', 'damaged'),
        (SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'quantity', (x ->> 'q')::numeric,
                  'condition', 'unopened', 'restock', false))
           FROM jsonb_array_elements(v_lines) x
           JOIN (SELECT id, row_number() OVER (ORDER BY total_units_needed DESC) AS n FROM order_items WHERE order_id = v_order) oi
             ON oi.n = (x ->> 'n')::int),
        'smk-tax-r-ret-' || md5(v_lines::text) || v_suffix);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      v_invoice2 := (v_header ->> 'return_id')::uuid;
      PERFORM approve_return(v_invoice2, v_admin, 'smk-tax-r-ap-' || v_invoice2);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      PERFORM receive_return(v_invoice2, v_admin, 'smk-tax-r-rc-' || v_invoice2);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      PERFORM issue_return_credit(v_invoice2, v_admin, 'smk-tax-r-ic-' || v_invoice2);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    END LOOP;
    IF (SELECT abs(sum(total_amount_cents)) FROM invoices
         WHERE order_id = v_order AND invoice_type = 'credit_memo' AND deleted_at IS NULL)
       IS DISTINCT FROM (SELECT total_amount_cents FROM invoices WHERE id = v_invoice) THEN
      v_fails := v_fails || format(' (R) the returns credited %s cents, want the posted sale''s %s (tax included);',
        (SELECT abs(sum(total_amount_cents)) FROM invoices WHERE order_id = v_order AND invoice_type = 'credit_memo' AND deleted_at IS NULL),
        (SELECT total_amount_cents FROM invoices WHERE id = v_invoice));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (R) the return of a taxed sale failed: ' || SQLERRM || ';';
  END;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL sales tax:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK sales tax: off by default, on its own line after the discount, per payer, to the cent, re-saves and hand edits put right, the box follows drafts only, posted and unposted amounts never move, only a chemical sale carries the line, returns credit the tax';
END
$smoke$;
