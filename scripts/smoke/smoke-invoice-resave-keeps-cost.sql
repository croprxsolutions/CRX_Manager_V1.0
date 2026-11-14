-- ============================================================================
-- ROLLED-BACK smoke: re-saving a draft invoice keeps the cost it was invoiced at (#13)
-- ----------------------------------------------------------------------------
-- Migration 20261106140000_invoice_resave_keeps_cost. A rep books 5 gal of product P (cost 6.00)
-- at a manual $7.33, draws it and an admin delivers it in full, so a $36.65 draft invoice exists.
-- Then P's cost rises to $8.00 (above the invoiced price) through the governed pricing path.
--   A  Saving the draft again with only a note changed is accepted, and the line keeps its
--      invoiced cost ($6.00) and total ($36.65) (it was refused BELOW_COST_REASON_REQUIRED)
--   B  Saving it with the price lowered to $5.00 (below the $6.00 order-time cost) is still
--      refused by the below-cost check
--   C  Sending the saved line twice is refused below cost (the invoiced cost is kept once)
--   D  Lowering the line to 3 gal keeps its cost; raising it to 4 gal later is refused below cost
--   E  Repricing the line to $9.00 is accepted; lowering it back to $7.33 is refused below cost
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
  v_inv2 uuid;
  v_items jsonb;
  v_hdr jsonb;
  v_fails text := '';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and an active sales rep';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Resave Cost Farm ' || v_suffix) RETURNING id INTO v_c1;
  INSERT INTO products (product_name, unit_size, product_form) VALUES ('[SMOKE] Resave Cost P ' || v_suffix, 'gal', 'liquid') RETURNING id INTO v_p;
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke resave cents fixture setup')),
    v_admin, 'smk-rescost-price-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-rescost-price-apply-' || v_suffix);

  -- The rep books 5 gal at a manual $7.33, sends it and draws it all into an order.
  v_line := jsonb_build_object('id', null, 'client_key', '_k1', 'product_id', v_p, 'sort_order', 0,
    'notes', null, 'calc_mode', 'units_direct', 'total_units_needed', 5, 'price_override', 7.33,
    'price_per_unit', 7.33, 'current_cost', 6, 'unit_size', 'gal', 'acres', 0);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] RESCOST-' || v_suffix, 'customer_id', v_c1,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(v_line))),
    v_rep, 'smk-rescost-save-' || v_suffix);
  v_q := (v_res->>'quote_id')::uuid;
  PERFORM create_quote_version(v_q, v_rep, 'presented', 'smk-rescost-v1-' || v_suffix, (v_res->>'row_version')::bigint);
  v_res := draw_down_quote(v_q, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 5)),
    v_rep, 'smk-rescost-draw-' || v_suffix, NULL);
  v_order := (v_res->>'order_id')::uuid;

  -- The admin delivers it in full.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'product_id', oi.product_id,
           'quantity', oi.quantity_remaining, 'unit_size', oi.unit_size))
    INTO v_items FROM order_items oi WHERE oi.order_id = v_order AND oi.quantity_remaining > 0;
  v_res := create_delivery_with_items(v_order, v_c1, CURRENT_DATE, v_items, NULL, NULL, NULL, NULL,
    'smk-rescost-schedule-' || v_suffix);
  v_del := COALESCE((v_res->>'delivery_id')::uuid, (v_res->>'id')::uuid);
  PERFORM confirm_delivery(v_del, v_admin, 'smk-rescost-arrive-' || v_suffix);
  PERFORM complete_delivery(v_del, 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    'smk-rescost-complete-' || v_suffix, NULL, 'no_proof', 'Rollback smoke, no signature');
  SELECT id INTO v_inv2 FROM invoices WHERE delivery_id = v_del AND status <> 'void' ORDER BY created_at DESC LIMIT 1;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv2) IS DISTINCT FROM 3665
     OR (SELECT cost_cents FROM invoice_items WHERE invoice_id = v_inv2 LIMIT 1) IS DISTINCT FROM 600 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the draft invoice is not $36.65 at a $6.00 cost';
  END IF;

  -- P's cost rises to $8.00, above the $7.33 invoiced price.
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '8.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke resave cost rise')),
    v_admin, 'smk-rescost-rise-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-rescost-rise-apply-' || v_suffix);

  -- --------------------------------------------------------------------
  -- A: a note-only re-save after the cost rise is accepted and keeps the invoiced cost and total.
  -- --------------------------------------------------------------------
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents,
           'extended_cents', it.extended_cents, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes) ORDER BY it.sort_order)
    INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv2;
  BEGIN
    PERFORM save_invoice((SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type,
        'status', i.status, 'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date,
        'payment_terms', i.payment_terms, 'header_notes', 'edited note', 'footer_notes', i.footer_notes)
        FROM invoices i WHERE i.id = v_inv2), v_items, 'smk-rescost-note-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (A) the note-only re-save was refused: ' || left(SQLERRM, 80) || ';';
  END;
  IF (SELECT total_amount_cents FROM invoices WHERE id = v_inv2) IS DISTINCT FROM 3665
     OR (SELECT cost_cents FROM invoice_items WHERE invoice_id = v_inv2 LIMIT 1) IS DISTINCT FROM 600 THEN
    v_fails := v_fails || ' (A) the note-only re-save changed the total or the invoiced cost;';
  END IF;

  -- --------------------------------------------------------------------
  -- B: lowering the price below the order-time cost on a re-save is still refused.
  -- --------------------------------------------------------------------
  SELECT jsonb_agg(jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id,
           'description', it.description, 'quantity', it.quantity, 'unit_price_cents', 500,
           'extended_cents', NULL, 'cost_cents', it.cost_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size, 'notes', it.notes) ORDER BY it.sort_order)
    INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv2;
  BEGIN
    PERFORM save_invoice((SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type,
        'status', i.status, 'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date,
        'payment_terms', i.payment_terms, 'header_notes', 'edited note', 'footer_notes', i.footer_notes)
        FROM invoices i WHERE i.id = v_inv2), v_items, 'smk-rescost-below-' || v_suffix);
    v_fails := v_fails || ' (B) a $5.00 price under the $6.00 cost was accepted on a re-save;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST%' THEN
      v_fails := v_fails || ' (B) refused with the wrong error: ' || left(SQLERRM, 80) || ';';
    END IF;
  END;

  SELECT jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type,
      'status', i.status, 'season', i.season, 'salesman_id', i.salesman_id, 'invoice_date', i.invoice_date,
      'payment_terms', i.payment_terms, 'header_notes', 'edited note', 'footer_notes', i.footer_notes)
    INTO v_hdr FROM invoices i WHERE i.id = v_inv2;

  -- --------------------------------------------------------------------
  -- C: sending the saved line twice does not keep the invoiced cost on both copies (the wrapper
  --    refuses the duplicate first; the below-cost check would refuse the second copy).
  -- --------------------------------------------------------------------
  SELECT jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id, 'description', it.description,
           'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size)
    INTO v_line FROM invoice_items it WHERE it.invoice_id = v_inv2 LIMIT 1;
  BEGIN
    PERFORM save_invoice(v_hdr, jsonb_build_array(v_line, v_line), 'smk-rescost-twice-' || v_suffix);
    v_fails := v_fails || ' (C) the same saved line sent twice kept the invoiced cost on both;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST%' AND SQLERRM NOT LIKE 'GENERATED_INVOICE_LINE_ID_DUPLICATE%' THEN
      v_fails := v_fails || ' (C) refused with the wrong error: ' || left(SQLERRM, 80) || ';';
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- D: a line lowered to 3 gal keeps its cost; raising it back to 4 gal on a later re-save does not.
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM save_invoice(v_hdr, jsonb_build_array(v_line || '{"quantity": 3}'), 'smk-rescost-lower-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (D) lowering the quantity to 3 was refused: ' || left(SQLERRM, 80) || ';';
  END;
  SELECT jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id, 'description', it.description,
           'quantity', 4, 'unit_price_cents', it.unit_price_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size)
    INTO v_line FROM invoice_items it WHERE it.invoice_id = v_inv2 LIMIT 1;
  IF (SELECT cost_cents FROM invoice_items WHERE invoice_id = v_inv2 LIMIT 1) IS DISTINCT FROM 600 THEN
    v_fails := v_fails || ' (D) the 3 gal line did not keep the $6.00 invoiced cost;';
  END IF;
  BEGIN
    PERFORM save_invoice(v_hdr, jsonb_build_array(v_line), 'smk-rescost-raise-' || v_suffix);
    v_fails := v_fails || ' (D) raising the line from 3 to 4 gal kept the invoiced cost;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST%' THEN
      v_fails := v_fails || ' (D) refused with the wrong error: ' || left(SQLERRM, 80) || ';';
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- E: a line repriced to $9.00 (above today's $8.00 cost) is accepted; lowering it back to the
  --    $7.33 order price, below today's cost, is refused below cost.
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM save_invoice(v_hdr, jsonb_build_array(v_line || '{"quantity": 3, "unit_price_cents": 900}'),
      'smk-rescost-up-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (E) repricing to $9.00 was refused: ' || left(SQLERRM, 80) || ';';
  END;
  SELECT jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id, 'description', it.description,
           'quantity', it.quantity, 'unit_price_cents', 733, 'sort_order', it.sort_order,
           'unit_size', it.unit_size)
    INTO v_line FROM invoice_items it WHERE it.invoice_id = v_inv2 LIMIT 1;
  BEGIN
    PERFORM save_invoice(v_hdr, jsonb_build_array(v_line), 'smk-rescost-down-' || v_suffix);
    v_fails := v_fails || ' (E) lowering $9.00 back to $7.33 under the $8.00 cost skipped the check;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST%' THEN
      v_fails := v_fails || ' (E) refused with the wrong error: ' || left(SQLERRM, 80) || ';';
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- F: the line kept at $9.00 (3 gal). P's cost then rises to $10.00, above $9.00. A note-only
  --    re-save keeps the $9.00 line and its invoiced cost; repricing it to $9.50 is refused.
  -- --------------------------------------------------------------------
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '10.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke resave second cost rise')),
    v_admin, 'smk-rescost-rise2-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-rescost-rise2-apply-' || v_suffix);
  SELECT jsonb_build_object('id', it.id, 'order_item_id', it.order_item_id, 'product_id', it.product_id, 'description', it.description,
           'quantity', it.quantity, 'unit_price_cents', it.unit_price_cents, 'sort_order', it.sort_order,
           'unit_size', it.unit_size)
    INTO v_line FROM invoice_items it WHERE it.invoice_id = v_inv2 LIMIT 1;
  IF (v_line->>'unit_price_cents')::bigint IS DISTINCT FROM 900 THEN
    v_fails := v_fails || ' (F) setup: the line is not at $9.00 after E;';
  END IF;
  BEGIN
    PERFORM save_invoice(v_hdr, jsonb_build_array(v_line), 'smk-rescost-note2-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) the note-only re-save of the $9.00 line was refused: ' || left(SQLERRM, 80) || ';';
  END;
  IF (SELECT cost_cents FROM invoice_items WHERE invoice_id = v_inv2 LIMIT 1) IS DISTINCT FROM 600
     OR (SELECT unit_price_cents FROM invoice_items WHERE invoice_id = v_inv2 LIMIT 1) IS DISTINCT FROM 900 THEN
    v_fails := v_fails || ' (F) the note-only re-save changed the $9.00 line or its invoiced cost;';
  END IF;
  BEGIN
    PERFORM save_invoice(v_hdr, jsonb_build_array(v_line || '{"unit_price_cents": 950}'), 'smk-rescost-950-' || v_suffix);
    v_fails := v_fails || ' (F) repricing to $9.50 under the $10.00 cost skipped the check;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST%' THEN
      v_fails := v_fails || ' (F) refused with the wrong error: ' || left(SQLERRM, 80) || ';';
    END IF;
  END;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL invoice resave cost:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK invoice resave cost: after a cost rise above price, a note-only re-save kept $6.00 cost and $36.65; a $5.00 price, a line sent twice, a line raised from 3 to 4 gal and a $9.00 line lowered back to $7.33 were each still refused below cost; after a second rise to $10.00 a note-only re-save kept the $9.00 line, and $9.50 was refused';
END
$smoke$;
