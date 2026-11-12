-- ============================================================================
-- ROLLED-BACK smoke: a Partial Order quantity is in whole hundredths, so a booking always closes (S02)
-- ----------------------------------------------------------------------------
-- Migration 20261106110000_draw_quantity_whole_hundredths. A rep books product P (cost 6.00,
-- tier 1 7.50) for 10 gal and sends it.
--   A  A draw of 3.333 gal is refused BOOKING_QUANTITY_PRECISION and writes no order or draw
--   B  Draws of 3.33 + 3.33 + 3.34 close the booking: nothing left, booking accepted, and the
--      three orders add up to the booking total exactly
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- quote, order and ledger row is rolled back. Any other error text is a failure.
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
  v_qty numeric;
  v_i int := 0;
  v_fails text := '';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and an active sales rep';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Draw Step Farm ' || v_suffix) RETURNING id INTO v_c1;
  INSERT INTO products (product_name, unit_size, product_form) VALUES ('[SMOKE] Draw Step P ' || v_suffix, 'gal', 'liquid') RETURNING id INTO v_p;
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke draw step fixture setup')),
    v_admin, 'smk-drawstep-price-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-drawstep-price-apply-' || v_suffix);

  v_line := jsonb_build_object('id', null, 'client_key', '_k1', 'product_id', v_p, 'sort_order', 0,
    'notes', null, 'calc_mode', 'units_direct', 'total_units_needed', 10, 'price_override', null,
    'price_per_unit', 7.5, 'current_cost', 6, 'unit_size', 'gal', 'acres', 0);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] DRAWSTEP-' || v_suffix, 'customer_id', v_c1,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(v_line))),
    v_rep, 'smk-drawstep-save-' || v_suffix);
  v_q := (v_res->>'quote_id')::uuid;
  PERFORM create_quote_version(v_q, v_rep, 'presented', 'smk-drawstep-v1-' || v_suffix, (v_res->>'row_version')::bigint);

  -- --------------------------------------------------------------------
  -- A: 3.333 gal is refused and writes nothing.
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM draw_down_quote(v_q, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 3.333)),
      v_rep, 'smk-drawstep-fine-' || v_suffix, NULL);
    v_fails := v_fails || ' (A) a draw of 3.333 was accepted;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BOOKING_QUANTITY_PRECISION:%' THEN
      v_fails := v_fails || ' (A) refused with the wrong error: ' || SQLERRM || ';';
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM orders WHERE quote_id = v_q)
     OR EXISTS (SELECT 1 FROM quote_product_draws WHERE quote_id = v_q AND quantity_drawn > 0) THEN
    v_fails := v_fails || ' (A) the refused draw left an order or a draw;';
  END IF;

  -- --------------------------------------------------------------------
  -- B: 3.33 + 3.33 + 3.34 closes the booking at its total exactly.
  -- --------------------------------------------------------------------
  BEGIN
    FOREACH v_qty IN ARRAY ARRAY[3.33, 3.33, 3.34]::numeric[]
    LOOP
      v_i := v_i + 1;
      PERFORM draw_down_quote(v_q, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', v_qty)),
        v_rep, 'smk-drawstep-draw-' || v_i || '-' || v_suffix, NULL);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (B) a hundredths draw was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT COALESCE(sum(quantity_drawn), 0) FROM quote_product_draws WHERE quote_id = v_q) IS DISTINCT FROM 10
     OR (SELECT status FROM quotes WHERE id = v_q) IS DISTINCT FROM 'accepted' THEN
    v_fails := v_fails || ' (B) the booking did not close with nothing left;';
  END IF;
  IF (SELECT COALESCE(sum(total_price), 0) FROM orders WHERE quote_id = v_q AND status <> 'cancelled')
     IS DISTINCT FROM (SELECT total_price FROM quotes WHERE id = v_q) THEN
    v_fails := v_fails || ' (B) the orders do not add up to the booking total;';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL draw quantity step:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK draw quantity step: 3.333 refused with nothing written; 3.33 + 3.33 + 3.34 closed the booking at its total';
END
$smoke$;
