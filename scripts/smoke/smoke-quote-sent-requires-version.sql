-- ============================================================================
-- ROLLED-BACK smoke: a draft becomes sent or revised only with a sent version on record
-- ----------------------------------------------------------------------------
-- Migration 20261105160000_quote_sent_requires_version. Product P at cost 6.00 (tier 1 7.50).
--   A  save_quote cannot mark a draft sent; the draft stays a draft
--   B  the owning rep cannot mark a draft sent or revised by changing its status
--   C  a new quote starts as a draft: the rep cannot insert one at another status, and can
--      still insert a draft (so the refusal is the status rule, not row security or grants)
--   D  the admin override does not mark a draft sent either
--   F  a never-sent quote that was cancelled cannot be reopened to sent, even by the admin override
--   G  a privileged (definer-rights) insert past draft with no version is refused at commit; the
--      check is forced early with SET CONSTRAINTS, since this chain never commits
--   E  the real send still works: it records V1 and marks the quote sent; revise, re-send,
--      rewind, convert and reopen (accepted -> sent) all still work
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- quote, order and ledger row is rolled back. Any other error text is a failure.
-- A, B, C, D, F and G report together, so one run before the migration shows each of them.
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
  v_letter text;
  v_id uuid;
  v_v1 uuid;
  v_rv bigint;
  v_rows integer;
  v_status text;
  v_new_status text;
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

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Sent Version Farm ' || v_suffix) RETURNING id INTO v_c1;
  INSERT INTO products (product_name, unit_size, product_form) VALUES ('[SMOKE] Sent Version P ' || v_suffix, 'gal', 'liquid') RETURNING id INTO v_p;
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke sent version fixture setup')),
    v_admin, 'smk-sentver-price-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-sentver-price-apply-' || v_suffix);

  v_line := jsonb_build_object('id', null, 'client_key', '_k1', 'product_id', v_p, 'sort_order', 0,
    'notes', null, 'calc_mode', 'units_direct', 'total_units_needed', 10, 'price_override', null,
    'price_per_unit', 7.5, 'current_cost', 6, 'unit_size', 'gal', 'acres', 0);
  v_sections := jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0,
    'items', jsonb_build_array(v_line)));

  -- Every quote saved as a draft at 7.50; the rep owns B.
  FOREACH v_letter IN ARRAY ARRAY['A','B','D','E','F']
  LOOP
    v_res := save_quote(NULL, jsonb_build_object(
        'quote_number', '[SMOKE] SENTVER-' || v_letter || '-' || v_suffix, 'customer_id', v_c1,
        'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
      v_sections, v_admin, 'smk-sentver-save-' || v_letter || '-' || v_suffix);
    v_quotes := v_quotes || jsonb_build_object(v_letter, v_res->>'quote_id');
    v_lines := v_lines || jsonb_build_object(v_letter, v_res->'item_ids'->>'_k1');
  END LOOP;

  -- --------------------------------------------------------------------
  -- A: save_quote cannot mark a draft sent.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'A')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM save_quote(v_id, jsonb_build_object(
        'quote_number', '[SMOKE] SENTVER-A-' || v_suffix, 'customer_id', v_c1, 'status', 'sent', 'tier', 1,
        'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
      jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'A')),
      v_admin, 'smk-sentver-save-A2-' || v_suffix);
    v_fails := v_fails || '(A) save_quote marked a draft sent with no version; ';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'QUOTE_SEND_REQUIRED%' THEN v_fails := v_fails || '(A) save: ' || v_err || '; '; END IF;
  END;
  IF (SELECT status FROM quotes WHERE id = v_id) <> 'draft' THEN
    v_fails := v_fails || '(A) the draft is no longer a draft; ';
  END IF;

  -- --------------------------------------------------------------------
  -- B: the owning rep, as a PostgREST session. Row security lets this rep through (a permitted
  -- column saves), so a refusal here is the status rule. set_config inside each block so a
  -- refusal also puts the role back.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'B')::uuid;
  UPDATE quotes SET created_by = v_rep WHERE id = v_id;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);

  PERFORM set_config('role', 'authenticated', true);
  UPDATE quotes SET header_notes = 'smoke' WHERE id = v_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('role', 'none', true);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (B) the owning rep could not save a permitted column, so this rep proves nothing';
  END IF;

  FOREACH v_new_status IN ARRAY ARRAY['sent', 'revised']
  LOOP
    BEGIN
      PERFORM set_config('role', 'authenticated', true);
      UPDATE quotes SET status = v_new_status WHERE id = v_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      PERFORM set_config('role', 'none', true);
      IF v_rows > 0 THEN
        v_fails := v_fails || '(B) the owning rep marked a draft ' || v_new_status || ' with no version; ';
        -- Put the draft back for the next status (only reached when the rule is missing).
        PERFORM set_config('app.admin_override', 'true', true);
        UPDATE quotes SET status = 'draft' WHERE id = v_id;
        PERFORM set_config('app.admin_override', 'false', true);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      PERFORM set_config('role', 'none', true);
      IF v_err NOT LIKE 'QUOTE_SEND_REQUIRED%' AND v_err NOT LIKE 'Invalid quote status transition%' THEN
        v_fails := v_fails || '(B) ' || v_new_status || ': ' || v_err || '; ';
      END IF;
    END;
  END LOOP;

  -- --------------------------------------------------------------------
  -- C: a new quote starts as a draft.
  -- --------------------------------------------------------------------
  FOREACH v_new_status IN ARRAY ARRAY['sent', 'revised', 'accepted']
  LOOP
    BEGIN
      PERFORM set_config('role', 'authenticated', true);
      INSERT INTO quotes (quote_number, customer_id, created_by, tier, status)
      VALUES ('[SMOKE] SENTVER-C-' || v_new_status || '-' || v_suffix, v_c1, v_rep, 1, v_new_status);
      PERFORM set_config('role', 'none', true);
      v_fails := v_fails || '(C) the rep inserted a quote at ' || v_new_status || '; ';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      PERFORM set_config('role', 'none', true);
      IF v_err NOT LIKE 'QUOTE_SEND_REQUIRED%' THEN
        v_fails := v_fails || '(C) ' || v_new_status || ': ' || v_err || '; ';
      END IF;
    END;
  END LOOP;
  PERFORM set_config('role', 'authenticated', true);
  INSERT INTO quotes (quote_number, customer_id, created_by, tier, status)
  VALUES ('[SMOKE] SENTVER-C-draft-' || v_suffix, v_c1, v_rep, 1, 'draft');
  PERFORM set_config('role', 'none', true);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- --------------------------------------------------------------------
  -- D: the admin override does not mark a draft sent.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'D')::uuid;
  BEGIN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE quotes SET status = 'sent' WHERE id = v_id;
    PERFORM set_config('app.admin_override', 'false', true);
    v_fails := v_fails || '(D) the admin override marked a draft sent with no version; ';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    PERFORM set_config('app.admin_override', 'false', true);
    IF v_err NOT LIKE 'QUOTE_SEND_REQUIRED%' THEN v_fails := v_fails || '(D) ' || v_err || '; '; END IF;
  END;
  IF (SELECT status FROM quotes WHERE id = v_id) <> 'draft' THEN
    v_fails := v_fails || '(D) the draft is no longer a draft; ';
  END IF;

  -- --------------------------------------------------------------------
  -- F: a cancelled quote that was never sent cannot be reopened to sent (the admin Reopen).
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'F')::uuid;
  UPDATE quotes SET status = 'cancelled' WHERE id = v_id;
  BEGIN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE quotes SET status = 'sent' WHERE id = v_id;
    PERFORM set_config('app.admin_override', 'false', true);
    v_fails := v_fails || '(F) reopening a never-sent cancelled quote marked it sent; ';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    PERFORM set_config('app.admin_override', 'false', true);
    IF v_err NOT LIKE 'QUOTE_SEND_REQUIRED%' THEN v_fails := v_fails || '(F) ' || v_err || '; '; END IF;
  END;
  -- revised too: the override skips the edge table, so only the version rule refuses this one.
  BEGIN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE quotes SET status = 'revised' WHERE id = v_id;
    PERFORM set_config('app.admin_override', 'false', true);
    v_fails := v_fails || '(F) reopening a never-sent cancelled quote marked it revised; ';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    PERFORM set_config('app.admin_override', 'false', true);
    IF v_err NOT LIKE 'QUOTE_SEND_REQUIRED%' THEN v_fails := v_fails || '(F) ' || v_err || '; '; END IF;
  END;
  IF (SELECT status FROM quotes WHERE id = v_id) <> 'cancelled' THEN
    v_fails := v_fails || '(F) the cancelled quote is no longer cancelled; ';
  END IF;

  -- --------------------------------------------------------------------
  -- G: a privileged insert past draft with no version cannot commit.
  -- --------------------------------------------------------------------
  FOREACH v_new_status IN ARRAY ARRAY['sent', 'accepted']
  LOOP
    BEGIN
      INSERT INTO quotes (quote_number, customer_id, created_by, tier, status)
      VALUES ('[SMOKE] SENTVER-G-' || v_new_status || '-' || v_suffix, v_c1, v_admin, 1, v_new_status);
      EXECUTE 'SET CONSTRAINTS public.enforce_quote_insert_version IMMEDIATE';
      v_fails := v_fails || '(G) a privileged insert at ' || v_new_status || ' with no version would commit; ';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err NOT LIKE 'QUOTE_SEND_REQUIRED%' THEN
        v_fails := v_fails || '(G) ' || v_new_status || ': ' || v_err || '; ';
      END IF;
    END;
  END LOOP;
  BEGIN
    EXECUTE 'SET CONSTRAINTS public.enforce_quote_insert_version DEFERRED';
  EXCEPTION WHEN OTHERS THEN NULL;  -- before the migration the trigger does not exist
  END;

  -- --------------------------------------------------------------------
  -- E: the real send and everything after it still work.
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'E')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := create_quote_version(v_id, v_admin, 'presented', 'smk-sentver-v1-E-' || v_suffix, v_rv);
  v_v1 := (v_res->>'version_id')::uuid;
  SELECT status INTO v_status FROM quotes WHERE id = v_id;
  IF v_status <> 'sent' OR NOT EXISTS (SELECT 1 FROM quote_versions WHERE id = v_v1 AND quote_id = v_id) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) the send did not record V1 and mark the quote sent: %', v_status;
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] SENTVER-E-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_set(jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'E')),
      '{0,items,0,total_units_needed}', '12'::jsonb),
    v_admin, 'smk-sentver-save-E2-' || v_suffix);
  IF (SELECT status FROM quotes WHERE id = v_id) <> 'revised' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) the revision did not mark the quote revised';
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM create_quote_version(v_id, v_admin, 'emailed', 'smk-sentver-v2-E-' || v_suffix, v_rv);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM restore_quote_version(v_id, v_v1, v_admin, 'smk-sentver-rewind-E-' || v_suffix, v_rv, NULL);
  IF (SELECT status FROM quotes WHERE id = v_id) <> 'revised' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) the rewind did not mark the quote revised';
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-sentver-conv-E-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 7.50
     OR (SELECT status FROM quotes WHERE id = v_id) <> 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) the rewound quote did not convert at 7.50: %', v_res;
  END IF;
  -- What an order void leaves behind: the booking reopened from accepted to sent (20261021030000).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET status = 'sent' WHERE id = v_id;
  PERFORM set_config('app.admin_override', 'false', true);
  IF (SELECT status FROM quotes WHERE id = v_id) <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) the booking did not reopen';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: %', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: sent-requires-version chain (A-G) passed';
END
$smoke$;
