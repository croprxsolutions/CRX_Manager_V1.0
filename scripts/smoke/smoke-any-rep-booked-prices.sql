-- ============================================================================
-- ROLLED-BACK smoke: any rep may change booked prices on any booking (Mason, 2026-10-30)
-- ----------------------------------------------------------------------------
-- Migration 20261104130000_any_rep_changes_booked_prices. Rep A books product P (cost 6.00,
-- tier 1 7.50) for 10 gal and sends it. Rep B is another active sales rep.
--   A  Rep B revises Rep A's sent booking and lowers the line to 7.00: saved, the booking stays
--      Rep A's, the trail row names Rep B, and Rep B's draw bills 7.00 with no re-send
--   B  Rep B raises a line to 8.00: refused without the tick, saved with it (Rep B confirmed)
--   C  Rep B changes the quantity, quantity and price together, a note, the commission split, or
--      declines: each refused QUOTE_PRICE_ONLY_FOR_OTHER_REPS, nothing changes
--   D  Rep B on Rep A's draft: NOT_QUOTE_OWNER, also with the price-only setting already set
--   E  Rep A (the booking's rep) still changes the quantity
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- quote, order and ledger row is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep_a uuid;
  v_rep_b uuid;
  v_c1 uuid;
  v_p uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_line jsonb;
  v_res jsonb;
  v_price_res jsonb;
  v_err text;
  v_fails text := '';
  v_quotes jsonb := '{}'::jsonb;   -- letter -> quote id
  v_lines jsonb := '{}'::jsonb;    -- letter -> line id
  v_letter text;
  v_id uuid;
  v_draft uuid;
  v_rv bigint;
  v_case record;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep_a FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep_b FROM profiles WHERE role = 'sales_rep' AND is_active = true AND id <> v_rep_a ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep_a IS NULL OR v_rep_b IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and two active sales reps';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Any Rep Prices Farm ' || v_suffix) RETURNING id INTO v_c1;
  INSERT INTO products (product_name, unit_size, product_form) VALUES ('[SMOKE] Any Rep P ' || v_suffix, 'gal', 'liquid') RETURNING id INTO v_p;
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke any-rep prices fixture setup')),
    v_admin, 'smk-anyrep-price-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-anyrep-price-apply-' || v_suffix);

  v_line := jsonb_build_object('id', null, 'client_key', '_k1', 'product_id', v_p, 'sort_order', 0,
    'notes', null, 'calc_mode', 'units_direct', 'total_units_needed', 10, 'price_override', null,
    'price_per_unit', 7.5, 'current_cost', 6, 'unit_size', 'gal', 'acres', 0);

  -- Rep A books and sends A, B, C and E; D stays a draft.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  FOREACH v_letter IN ARRAY ARRAY['A','B','C','D','E']
  LOOP
    v_res := save_quote(NULL, jsonb_build_object(
        'quote_number', '[SMOKE] ANYREP-' || v_letter || '-' || v_suffix, 'customer_id', v_c1,
        'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
      jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(v_line))),
      v_rep_a, 'smk-anyrep-save-' || v_letter || '-' || v_suffix);
    v_id := (v_res->>'quote_id')::uuid;
    v_quotes := v_quotes || jsonb_build_object(v_letter, v_id);
    v_lines := v_lines || jsonb_build_object(v_letter, v_res->'item_ids'->>'_k1');
    IF v_letter <> 'D' THEN
      PERFORM create_quote_version(v_id, v_rep_a, 'presented', 'smk-anyrep-v1-' || v_letter || '-' || v_suffix,
        (v_res->>'row_version')::bigint);
    END IF;
  END LOOP;

  -- Everything below is Rep B unless stated.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_b::text, true);

  -- --------------------------------------------------------------------
  -- A: Rep B revises and lowers to 7.00; the draw bills 7.00 with no re-send.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'A')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM save_quote(v_id, jsonb_build_object(
        'quote_number', '[SMOKE] ANYREP-A-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
        'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
      jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
        v_line || jsonb_build_object('id', v_lines->>'A', 'price_override', 7.00, 'price_per_unit', 7.00)))),
      v_rep_b, 'smk-anyrep-lower-A-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (A) Rep B''s price cut was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT price_per_unit FROM quote_items WHERE quote_id = v_id) IS DISTINCT FROM 7.00
     OR (SELECT status FROM quotes WHERE id = v_id) IS DISTINCT FROM 'revised'
     OR (SELECT created_by FROM quotes WHERE id = v_id) IS DISTINCT FROM v_rep_a THEN
    v_fails := v_fails || ' (A) the booking is not revised at 7.00 and still Rep A''s;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM quote_price_changes WHERE quote_id = v_id AND changed_by = v_rep_b
                  AND old_price_cents = 750 AND new_price_cents = 700 AND grower_confirmed_by IS NULL) THEN
    v_fails := v_fails || ' (A) the trail row does not name Rep B for 7.50 -> 7.00;';
  END IF;
  BEGIN
    v_res := draw_down_quote(v_id, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 5)),
      v_rep_b, 'smk-anyrep-draw-A-' || v_suffix, NULL);
    IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 7.00 THEN
      v_fails := v_fails || ' (A) the draw did not bill 7.00;';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (A) the draw was refused: ' || SQLERRM || ';';
  END;

  -- --------------------------------------------------------------------
  -- B: a raise needs the tick, from Rep B as from the booking's rep.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'B')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_err := NULL;
  BEGIN
    PERFORM save_quote(v_id, jsonb_build_object(
        'quote_number', '[SMOKE] ANYREP-B-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
        'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
      jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
        v_line || jsonb_build_object('id', v_lines->>'B', 'price_override', 8.00, 'price_per_unit', 8.00)))),
      v_rep_b, 'smk-anyrep-raise-B-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE 'QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION%' THEN
    v_fails := v_fails || ' (B) an unticked raise by Rep B was not refused for the tick: ' || COALESCE(v_err, 'saved') || ';';
  END IF;
  BEGIN
    PERFORM save_quote(v_id, jsonb_build_object(
        'quote_number', '[SMOKE] ANYREP-B-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
        'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
      jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
        v_line || jsonb_build_object('id', v_lines->>'B', 'price_override', 8.00, 'price_per_unit', 8.00, 'grower_confirmed', true)))),
      v_rep_b, 'smk-anyrep-raise-tick-B-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (B) a ticked raise by Rep B was refused: ' || SQLERRM || ';';
  END;
  IF NOT EXISTS (SELECT 1 FROM quote_price_changes WHERE quote_id = v_id AND changed_by = v_rep_b
                  AND grower_confirmed_by = v_rep_b AND new_price_cents = 800) THEN
    v_fails := v_fails || ' (B) the ticked raise is not recorded as Rep B''s;';
  END IF;

  -- --------------------------------------------------------------------
  -- C: anything other than a price is refused, and nothing changes.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'C')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  FOR v_case IN
    SELECT * FROM (VALUES
      ('quantity', 'revised', '{}'::jsonb, jsonb_build_object('total_units_needed', 9)),
      ('quantity and price', 'revised', '{}'::jsonb, jsonb_build_object('total_units_needed', 9, 'price_override', 7.00, 'price_per_unit', 7.00)),
      ('note', 'revised', '{"header_notes": "Rep B note"}'::jsonb, '{}'::jsonb),
      ('commission split', 'revised', jsonb_build_object('commission_split', jsonb_build_object('splits', jsonb_build_array(
         jsonb_build_object('recipient_user_id', v_rep_b, 'recipient', (SELECT full_name FROM profiles WHERE id = v_rep_b), 'percentage', 100)))), '{}'::jsonb),
      ('decline', 'declined', '{}'::jsonb, '{}'::jsonb)
    ) AS c(label, status, quote_patch, line_patch)
  LOOP
    v_err := NULL;
    BEGIN
      PERFORM save_quote(v_id, jsonb_build_object(
          'quote_number', '[SMOKE] ANYREP-C-' || v_suffix, 'customer_id', v_c1, 'status', v_case.status, 'tier', 1,
          'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv) || v_case.quote_patch,
        jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
          v_line || jsonb_build_object('id', v_lines->>'C') || v_case.line_patch))),
        v_rep_b, 'smk-anyrep-other-C-' || replace(v_case.label, ' ', '-') || '-' || v_suffix);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    IF v_err IS NULL OR v_err NOT LIKE 'QUOTE_PRICE_ONLY_FOR_OTHER_REPS:%' THEN
      v_fails := v_fails || ' (C) Rep B''s ' || v_case.label || ' change was not refused as price-only: ' || COALESCE(v_err, 'saved') || ';';
    END IF;
  END LOOP;
  IF (SELECT total_units_needed FROM quote_items WHERE quote_id = v_id) IS DISTINCT FROM 10
     OR (SELECT price_per_unit FROM quote_items WHERE quote_id = v_id) IS DISTINCT FROM 7.50
     OR (SELECT status FROM quotes WHERE id = v_id) IS DISTINCT FROM 'sent'
     OR (SELECT header_notes FROM quotes WHERE id = v_id) IS NOT NULL
     OR (SELECT row_version FROM quotes WHERE id = v_id) IS DISTINCT FROM v_rv
     OR EXISTS (SELECT 1 FROM quote_price_changes WHERE quote_id = v_id) THEN
    v_fails := v_fails || ' (C) a refused save changed the booking;';
  END IF;

  -- --------------------------------------------------------------------
  -- D: another rep's draft stays owner-only, whatever the session already holds.
  -- --------------------------------------------------------------------
  v_draft := (v_quotes->>'D')::uuid;
  FOREACH v_letter IN ARRAY ARRAY['plain', 'preset']
  LOOP
    IF v_letter = 'preset' THEN
      PERFORM set_config('crx.price_only_quote_save', v_draft::text, true);
    END IF;
    SELECT row_version INTO v_rv FROM quotes WHERE id = v_draft;
    v_err := NULL;
    BEGIN
      PERFORM save_quote(v_draft, jsonb_build_object(
          'quote_number', '[SMOKE] ANYREP-D-' || v_suffix, 'customer_id', v_c1, 'status', 'draft', 'tier', 1,
          'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
        jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
          v_line || jsonb_build_object('id', v_lines->>'D', 'price_override', 7.00, 'price_per_unit', 7.00)))),
        v_rep_b, 'smk-anyrep-draft-D-' || v_letter || '-' || v_suffix);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    IF v_err IS DISTINCT FROM 'NOT_QUOTE_OWNER' THEN
      v_fails := v_fails || ' (D) Rep B on Rep A''s draft (' || v_letter || ') was not refused NOT_QUOTE_OWNER: ' || COALESCE(v_err, 'saved') || ';';
    END IF;
  END LOOP;
  PERFORM set_config('crx.price_only_quote_save', '', true);

  -- --------------------------------------------------------------------
  -- E: the booking's own rep is unchanged.
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  v_id := (v_quotes->>'E')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM save_quote(v_id, jsonb_build_object(
        'quote_number', '[SMOKE] ANYREP-E-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
        'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv, 'header_notes', 'Rep A note'),
      jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
        v_line || jsonb_build_object('id', v_lines->>'E', 'total_units_needed', 12)))),
      v_rep_a, 'smk-anyrep-owner-E-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (E) the booking''s rep could not change the quantity: ' || SQLERRM || ';';
  END;
  IF (SELECT total_units_needed FROM quote_items WHERE quote_id = v_id) IS DISTINCT FROM 12 THEN
    v_fails := v_fails || ' (E) the owner''s quantity change did not save;';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK (any rep changes booked prices; everything else on another rep''s booking stays refused)';
END
$smoke$;
