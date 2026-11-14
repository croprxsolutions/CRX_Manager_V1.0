-- ============================================================================
-- ROLLED-BACK smoke: re-saving a draft invoice keeps the cents its line was given (S16b)
-- ----------------------------------------------------------------------------
-- Migration 20261106130000_invoice_resave_keeps_line_cents. A rep books 5 gal of product P at a
-- manual $7.33 ($36.65) and draws it into an order; an admin delivers it in two halves, so the
-- two draft invoices are $18.33 + $18.32 (the second carries the remainder).
--   A  Saving the second draft again with only a note changed keeps $18.32: the two still total
--      $36.65 (it was re-rounded to $18.33 = 2.5 x $7.33 before this migration)
--   B  Saving it with the quantity changed to 2 gal re-prices it: 2 x $7.33 = $14.66
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- quote, order, delivery, invoice and ledger row is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_c1 uuid;
  v_p uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_line jsonb;
  v_res jsonb;
  v_price_res jsonb;
  v_q uuid;
  v_order uuid;
  v_del uuid;
  v_inv1 uuid;
  v_inv2 uuid;
  v_items jsonb;
  v_half jsonb;
  v_n int := 0;
  v_fails text := '';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and an active sales rep';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Resave Cents Farm ' || v_suffix) RETURNING id INTO v_c1;
  INSERT INTO products (product_name, unit_size, product_form) VALUES ('[SMOKE] Resave Cents P ' || v_suffix, 'gal', 'liquid') RETURNING id INTO v_p;
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke resave cents fixture setup')),
    v_admin, 'smk-resave-price-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-resave-price-apply-' || v_suffix);

  -- The rep books 5 gal at a manual $7.33, sends it and draws it all into an order.
  v_line := jsonb_build_object('id', null, 'client_key', '_k1', 'product_id', v_p, 'sort_order', 0,
    'notes', null, 'calc_mode', 'units_direct', 'total_units_needed', 5, 'price_override', 7.33,
    'price_per_unit', 7.33, 'current_cost', 6, 'unit_size', 'gal', 'acres', 0);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] RESAVE-' || v_suffix, 'customer_id', v_c1,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(v_line))),
    v_rep, 'smk-resave-save-' || v_suffix);
  v_q := (v_res->>'quote_id')::uuid;
  PERFORM create_quote_version(v_q, v_rep, 'presented', 'smk-resave-v1-' || v_suffix, (v_res->>'row_version')::bigint);
  v_res := draw_down_quote(v_q, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 5)),
    v_rep, 'smk-resave-draw-' || v_suffix, NULL);
  v_order := (v_res->>'order_id')::uuid;

  -- The admin delivers it in two halves of 2.5 gal.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  FOREACH v_half IN ARRAY ARRAY['2.5', 'null']::jsonb[]
  LOOP
    v_n := v_n + 1;
    SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'product_id', oi.product_id,
             'quantity', oi.quantity_remaining, 'unit_size', oi.unit_size))
      INTO v_items FROM order_items oi WHERE oi.order_id = v_order AND oi.quantity_remaining > 0;
    v_res := create_delivery_with_items(v_order, v_c1, CURRENT_DATE, v_items, NULL, NULL, NULL, NULL,
      'smk-resave-schedule-' || v_n || '-' || v_suffix);
    v_del := COALESCE((v_res->>'delivery_id')::uuid, (v_res->>'id')::uuid);
    PERFORM confirm_delivery(v_del, v_admin, 'smk-resave-arrive-' || v_n || '-' || v_suffix);
    PERFORM complete_delivery(v_del, 'No proof — recorded by office', v_admin,
      CASE WHEN v_half = 'null'::jsonb THEN NULL
           ELSE (SELECT jsonb_object_agg(di.id::text, 2.5) FROM delivery_items di WHERE di.delivery_id = v_del) END,
      NULL, NULL, 'smk-resave-complete-' || v_n || '-' || v_suffix, NULL, 'no_proof', 'Rollback smoke, no signature');
    IF v_n = 1 THEN
      SELECT id INTO v_inv1 FROM invoices WHERE delivery_id = v_del AND status <> 'void' ORDER BY created_at DESC LIMIT 1;
    ELSE
      SELECT id INTO v_inv2 FROM invoices WHERE delivery_id = v_del AND status <> 'void' ORDER BY created_at DESC LIMIT 1;
    END IF;
  END LOOP;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv1) + (SELECT total_amount_cents FROM invoices WHERE id = v_inv2) IS DISTINCT FROM 3665 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the two half invoices do not total 3665 cents before any re-save';
  END IF;

  -- --------------------------------------------------------------------
  -- A: a note-only re-save of the second draft keeps its cents.
  -- --------------------------------------------------------------------
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes) ORDER BY it.sort_order)
    INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv2;
  PERFORM save_invoice((SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type,
      'status', i.status, 'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date,
      'payment_terms', i.payment_terms, 'header_notes', 'edited note', 'footer_notes', i.footer_notes)
      FROM invoices i WHERE i.id = v_inv2), v_items, 'smk-resave-note-' || v_suffix);
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv1) + (SELECT total_amount_cents FROM invoices WHERE id = v_inv2) IS DISTINCT FROM 3665 THEN
    v_fails := v_fails || format(' (A) after a note-only re-save the halves total %s cents, not 3665;',
      (SELECT total_amount_cents FROM invoices WHERE id = v_inv1) + (SELECT total_amount_cents FROM invoices WHERE id = v_inv2));
  END IF;
  IF (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_inv2)
     IS DISTINCT FROM (SELECT total_amount_cents FROM invoices WHERE id = v_inv2) THEN
    v_fails := v_fails || ' (A) the second invoice total is not the sum of its lines;';
  END IF;

  -- --------------------------------------------------------------------
  -- B: a quantity change is re-priced.
  -- --------------------------------------------------------------------
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', 2, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes) ORDER BY it.sort_order)
    INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv2;
  PERFORM save_invoice((SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type,
      'status', i.status, 'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date,
      'payment_terms', i.payment_terms, 'header_notes', 'edited note', 'footer_notes', i.footer_notes)
      FROM invoices i WHERE i.id = v_inv2), v_items, 'smk-resave-qty-' || v_suffix);
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv2) IS DISTINCT FROM 1466 THEN
    v_fails := v_fails || format(' (B) 2 gal at $7.33 saved as %s cents, not 1466;', (SELECT total_amount_cents FROM invoices WHERE id = v_inv2));
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL invoice resave cents:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK invoice resave cents: a note-only re-save kept $18.32 ($36.65 total); 2 gal re-priced to $14.66';
END
$smoke$;
