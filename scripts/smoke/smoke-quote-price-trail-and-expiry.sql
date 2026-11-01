-- ============================================================================
-- ROLLED-BACK smoke: a price trail row vouches only for the send it followed, and the browser
-- cannot write a quote's expiry
-- ----------------------------------------------------------------------------
-- Migration 20261101100000_quote_price_trail_and_expiry_grant. Product P at cost 6.00 (tier 1 7.50).
--   A  send V1 at 7.50, raise to 9.00 with the tick, send V2, rewind to V1, send V3 at 7.50, rewind
--      to V2 (9.00), Convert: refused, because the only trail row is older than V3
--   B  a raise with the tick after the last send converts at 9.00, and its row names that send
--   C  a second raise after a re-send converts at the new price
--   D  rewinding to the last sent version converts at that version's price
--   E  an unticked raise is refused and writes no row
--   F  a line saved without its id that changes price is recorded and converts; a raise on such a
--      line still needs the tick
--   G  an owning rep cannot set expires_at directly (update or insert); a permitted column still
--      saves, so the refusal is the column grant and not row security
--   H  a send still sets the expiry, and a past date picked for it is still refused
--   I  sent 9.00 then 7.50, rewind to 9.00, save 8.50 with no tick: Convert refused
--   J  a ticked raise to 12.00, then a cut to 11.00 with no tick: converts at 11.00
--   L  sent 9.00, cut to 8.00 and sent, 9.00 sent again by rewind, rewind to 8.00: Convert refused,
--      because the only row for 8.00 is older than the last send
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- quote, order and ledger row is rolled back. Any other error text is a failure.
-- A and G report together, so one run before the migration shows both gaps.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_c1 uuid;
  v_p uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_line jsonb;
  v_sections jsonb;
  v_res jsonb;
  v_price_res jsonb;
  v_err text;
  v_fails text := '';
  v_quotes jsonb := '{}'::jsonb;   -- letter -> quote id
  v_lines jsonb := '{}'::jsonb;    -- letter -> line id
  v_versions jsonb := '{}'::jsonb; -- letter -> V1 id
  v_letter text;
  v_id uuid;
  v_line_id text;
  v_v2 uuid;
  v_v3 uuid;
  v_v1 uuid;
  v_rv bigint;
  v_rows integer;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles
  WHERE role = 'sales_rep' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and an active sales rep';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Price Trail Farm ' || v_suffix) RETURNING id INTO v_c1;
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] Trail P ' || v_suffix, 'gal') RETURNING id INTO v_p;
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke price trail fixture setup')),
    v_admin, 'smk-trail-price-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-trail-price-apply-' || v_suffix);

  v_line := jsonb_build_object('id', null, 'client_key', '_k1', 'product_id', v_p, 'sort_order', 0,
    'notes', null, 'calc_mode', 'units_direct', 'total_units_needed', 10, 'price_override', null,
    'price_per_unit', 7.5, 'current_cost', 6, 'unit_size', 'gal', 'acres', 0);
  v_sections := jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0,
    'items', jsonb_build_array(v_line)));

  -- Every quote saved and presented (V1) at 7.50.
  FOREACH v_letter IN ARRAY ARRAY['A','B','C','D','E','F','G','J','K']
  LOOP
    v_res := save_quote(NULL, jsonb_build_object(
        'quote_number', '[SMOKE] TRAIL-' || v_letter || '-' || v_suffix, 'customer_id', v_c1,
        'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
      v_sections, v_admin, 'smk-trail-save-' || v_letter || '-' || v_suffix);
    v_id := (v_res->>'quote_id')::uuid;
    v_quotes := v_quotes || jsonb_build_object(v_letter, v_id);
    v_lines := v_lines || jsonb_build_object(v_letter, v_res->'item_ids'->>'_k1');
    v_res := create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v1-' || v_letter || '-' || v_suffix,
      (v_res->>'row_version')::bigint);
    v_versions := v_versions || jsonb_build_object(v_letter, v_res->>'version_id');
  END LOOP;

  -- --------------------------------------------------------------------
  -- A: the restore chain. The trail row for 9.00 predates V3, which sent 7.50.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'A')::uuid;
  v_line_id := v_lines->>'A';
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-A-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_line_id, 'price_override', 9.00, 'grower_confirmed', true)))),
    v_admin, 'smk-trail-raise-A-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_v2 := (create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v2-A-' || v_suffix, v_rv)->>'version_id')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM restore_quote_version(v_id, (v_versions->>'A')::uuid, v_admin, 'smk-trail-rewind1-A-' || v_suffix, v_rv, NULL);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_v3 := (create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v3-A-' || v_suffix, v_rv)->>'version_id')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM restore_quote_version(v_id, v_v2, v_admin, 'smk-trail-rewind2-A-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM quote_items WHERE quote_id = v_id) IS DISTINCT FROM 9.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (A) rewind to V2 did not put 9.00 back';
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-A-' || v_suffix, v_rv, NULL);
    v_fails := v_fails || format('(A) Convert billed %s when V3 sent 7.50, with no trail row after V3; ',
      (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (A) convert: %', v_err; END IF;
  END;

  -- --------------------------------------------------------------------
  -- B: a ticked raise after the last send converts, and its row names that send.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'B')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-B-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_lines->>'B', 'price_override', 9.00, 'grower_confirmed', true)))),
    v_admin, 'smk-trail-raise-B-' || v_suffix);
  IF v_fails = '' AND (SELECT to_jsonb(c)->>'sent_version' FROM quote_price_changes c WHERE c.quote_id = v_id) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (B) the trail row does not name V1';
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-B-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 9.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (B) did not convert at 9.00';
  END IF;

  -- --------------------------------------------------------------------
  -- C: raise, re-send, raise again: the newest row is the one that counts.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'C')::uuid;
  v_line_id := v_lines->>'C';
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-C-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_line_id, 'price_override', 9.00, 'grower_confirmed', true)))),
    v_admin, 'smk-trail-raise1-C-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v2-C-' || v_suffix, v_rv);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-C-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_line_id, 'price_override', 10.00, 'grower_confirmed', true)))),
    v_admin, 'smk-trail-raise2-C-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-C-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 10.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C) did not convert at 10.00';
  END IF;

  -- --------------------------------------------------------------------
  -- D: raise, rewind to the last sent version: 7.50 is the sent price.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'D')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-D-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_lines->>'D', 'price_override', 9.00, 'grower_confirmed', true)))),
    v_admin, 'smk-trail-raise-D-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM restore_quote_version(v_id, (v_versions->>'D')::uuid, v_admin, 'smk-trail-rewind-D-' || v_suffix, v_rv, NULL);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-D-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (D) did not convert at 7.50';
  END IF;

  -- --------------------------------------------------------------------
  -- E: no tick, no raise, no row.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'E')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM save_quote(v_id, jsonb_build_object(
        'quote_number', '[SMOKE] TRAIL-E-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
        'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
      jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
        v_line || jsonb_build_object('id', v_lines->>'E', 'price_override', 9.00)))),
      v_admin, 'smk-trail-raise-E-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: (E) an unticked raise was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (E) save: %', v_err; END IF;
  END;
  IF EXISTS (SELECT 1 FROM quote_price_changes WHERE quote_id = v_id) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) a refused raise left a row';
  END IF;

  -- --------------------------------------------------------------------
  -- F: a line saved without its id (matched by product) is recorded and passes the check.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'F')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-F-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('price_override', 7.00)))),
    v_admin, 'smk-trail-idless-F-' || v_suffix);
  IF (SELECT count(*) FROM quote_price_changes WHERE quote_id = v_id AND new_price_cents = 700) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (F) the id-less price change was not recorded';
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-F-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 7.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (F) did not convert at 7.00';
  END IF;

  -- A fallback-matched raise needs the tick too.
  v_id := (v_quotes->>'K')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM save_quote(v_id, jsonb_build_object(
        'quote_number', '[SMOKE] TRAIL-K-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
        'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
      jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
        v_line || jsonb_build_object('price_override', 9.00)))),
      v_admin, 'smk-trail-idless-K-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: (F) an unticked id-less raise was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (F) save: %', v_err; END IF;
  END;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-K-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('price_override', 9.00, 'grower_confirmed', true)))),
    v_admin, 'smk-trail-idless-K2-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-K-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 9.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (F) a ticked id-less raise did not convert at 9.00';
  END IF;

  -- --------------------------------------------------------------------
  -- G: an owning rep, as a PostgREST session. Row security lets this rep through, so a refusal
  -- here is the column grant. set_config inside each block so a refusal also puts the role back.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'G')::uuid;
  UPDATE quotes SET created_by = v_rep WHERE id = v_id;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);

  PERFORM set_config('role', 'authenticated', true);
  UPDATE quotes SET header_notes = 'smoke' WHERE id = v_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('role', 'none', true);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (G) the owning rep could not save a permitted column, so this rep proves nothing';
  END IF;

  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    UPDATE quotes SET expires_at = DATE '2099-12-31' WHERE id = v_id;
    PERFORM set_config('role', 'none', true);
    v_fails := v_fails || '(G) the owning rep set expires_at directly to 2099-12-31; ';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    INSERT INTO quotes (quote_number, customer_id, created_by, tier, status, expires_at)
    VALUES ('[SMOKE] TRAIL-G2-' || v_suffix, v_c1, v_rep, 1, 'draft', DATE '2099-12-31');
    PERFORM set_config('role', 'none', true);
    v_fails := v_fails || '(G) the rep inserted a quote with its own expires_at; ';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- --------------------------------------------------------------------
  -- H: the send still sets the expiry and still refuses a past pick.
  -- --------------------------------------------------------------------
  IF (SELECT expires_at FROM quotes WHERE id = (v_quotes->>'B')::uuid)
     IS DISTINCT FROM season_end_date(compute_season(v_today)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (H) a send did not set season end';
  END IF;
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-H-' || v_suffix, 'customer_id', v_c1, 'status', 'draft', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'chosen_expiry_date', v_today + 5),
    v_sections, v_admin, 'smk-trail-save-H-' || v_suffix);
  v_id := (v_res->>'quote_id')::uuid;
  PERFORM create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v1-H-' || v_suffix, (v_res->>'row_version')::bigint);
  IF (SELECT expires_at FROM quotes WHERE id = v_id) IS DISTINCT FROM v_today + 5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (H) the send did not set the picked date';
  END IF;
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-H2-' || v_suffix, 'customer_id', v_c1, 'status', 'draft', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'chosen_expiry_date', v_today - 1),
    v_sections, v_admin, 'smk-trail-save-H2-' || v_suffix);
  BEGIN
    PERFORM create_quote_version((v_res->>'quote_id')::uuid, v_admin, 'presented', 'smk-trail-v1-H2-' || v_suffix,
      (v_res->>'row_version')::bigint);
    RAISE EXCEPTION 'SMOKE_FAIL: (H) a past pick was sent';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'QUOTE_EXPIRY_IN_PAST%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (H) send: %', v_err; END IF;
  END;

  -- --------------------------------------------------------------------
  -- I: 8.50 is below the rewound price but above the last sent 7.50, and nobody ticked.
  -- --------------------------------------------------------------------
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-I-' || v_suffix, 'customer_id', v_c1, 'status', 'draft', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('price_override', 9.00)))),
    v_admin, 'smk-trail-save-I-' || v_suffix);
  v_id := (v_res->>'quote_id')::uuid;
  v_line_id := v_res->'item_ids'->>'_k1';
  v_v2 := (create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v1-I-' || v_suffix,
    (v_res->>'row_version')::bigint)->>'version_id')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-I-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_line_id, 'price_override', 7.50)))),
    v_admin, 'smk-trail-lower-I-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v2-I-' || v_suffix, v_rv);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM restore_quote_version(v_id, v_v2, v_admin, 'smk-trail-rewind-I-' || v_suffix, v_rv, NULL);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-I-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_line_id, 'price_override', 8.50)))),
    v_admin, 'smk-trail-cut-I-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-I-' || v_suffix, v_rv, NULL);
    v_fails := v_fails || '(I) Convert billed above the last sent price with no tick since that send; ';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (I) convert: %', v_err; END IF;
  END;

  -- --------------------------------------------------------------------
  -- L: a row from before the last send vouches for nothing, a lower price included.
  -- --------------------------------------------------------------------
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-L-' || v_suffix, 'customer_id', v_c1, 'status', 'draft', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('price_override', 9.00)))),
    v_admin, 'smk-trail-save-L-' || v_suffix);
  v_id := (v_res->>'quote_id')::uuid;
  v_line_id := v_res->'item_ids'->>'_k1';
  v_v1 := (create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v1-L-' || v_suffix,
    (v_res->>'row_version')::bigint)->>'version_id')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-L-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_line_id, 'price_override', 8.00)))),
    v_admin, 'smk-trail-cut-L-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_v2 := (create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v2-L-' || v_suffix, v_rv)->>'version_id')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM restore_quote_version(v_id, v_v1, v_admin, 'smk-trail-rewind1-L-' || v_suffix, v_rv, NULL);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM create_quote_version(v_id, v_admin, 'presented', 'smk-trail-v3-L-' || v_suffix, v_rv);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM restore_quote_version(v_id, v_v2, v_admin, 'smk-trail-rewind2-L-' || v_suffix, v_rv, NULL);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-L-' || v_suffix, v_rv, NULL);
    v_fails := v_fails || '(L) Convert accepted a row from before the last send; ';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (L) convert: %', v_err; END IF;
  END;

  -- --------------------------------------------------------------------
  -- J: the grower agreed to 12.00, so 11.00 needs no second tick.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'J')::uuid;
  v_line_id := v_lines->>'J';
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-J-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_line_id, 'price_override', 12.00, 'grower_confirmed', true)))),
    v_admin, 'smk-trail-raise-J-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] TRAIL-J-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_line_id, 'price_override', 11.00)))),
    v_admin, 'smk-trail-cut-J-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-trail-conv-J-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 11.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (J) did not convert at 11.00';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: %', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: price trail and expiry chain (A-L) passed';
END
$smoke$;
