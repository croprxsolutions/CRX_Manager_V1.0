-- ============================================================================
-- ROLLED-BACK smoke: booking sections keep timing and confidence (bookings Phase A, PR 1b)
-- ----------------------------------------------------------------------------
-- REQUIRES 20270125173000_booking_timing_purchasing_plan. Through the real save_quote:
--   1  a marked save writes timing and confidence per section
--   P7 a marked save that omits timing keeps the saved value; one that sends it as null
--      clears it; a new section that omits both starts unset
--   P5 an old (unmarked) save of a booking with timing or confidence set is refused
--      PLANNING_RELOAD_REQUIRED and changes nothing; an old save of a booking with none set
--      still works
--   C  a value outside the lists is refused by the column check
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so nothing persists. Any other error is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_product uuid;
  v_price_res jsonb;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_line jsonb;
  v_payload jsonb;
  v_res jsonb;
  v_q uuid;
  v_q2 uuid;
  v_s1 uuid;
  v_s2 uuid;
  v_version bigint;
  v_err text;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Planning Farm ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO products (product_name, unit_size, inventory_unit, product_form)
  VALUES ('[SMOKE] Planning Product ' || v_suffix, 'Gal', 'Gal', 'liquid') RETURNING id INTO v_product;
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', (SELECT pricing_version FROM products WHERE id = v_product),
      'pricing_mode', 'margin_driven', 'new_cost', '6.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke planning fixture setup')),
    v_admin, 'smk-plan-price-preview-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
    v_admin, 'smk-plan-price-apply-' || v_suffix);
  v_line := jsonb_build_object('client_key', '_k1', 'product_id', v_product, 'sort_order', 0,
    'calc_mode', 'units_direct', 'total_units_needed', 10, 'price_override', 20, 'price_per_unit', 20,
    'current_cost', 6, 'unit_size', 'Gal', 'acres', 0);

  -- 1. Marked save with timing and confidence on S1; S2 has none (no product: one product per quote).
  v_payload := jsonb_build_object('quote_number', '[SMOKE] PLAN-' || v_suffix, 'customer_id', v_customer,
    'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true);
  v_res := save_quote(NULL, v_payload, jsonb_build_array(
    jsonb_build_object('client_key', '_s1', 'section_name', 'North', 'sort_order', 0,
      'timing', 'pre_plant', 'confidence', 'firm', 'items', jsonb_build_array(v_line)),
    jsonb_build_object('client_key', '_s2', 'section_name', 'South', 'sort_order', 1, 'items', '[]'::jsonb)),
    v_admin, 'smk-plan-1-' || v_suffix);
  v_q := (v_res->>'quote_id')::uuid;
  v_s1 := (v_res->'section_ids'->>'_s1')::uuid;
  v_s2 := (v_res->'section_ids'->>'_s2')::uuid;
  v_version := (v_res->>'row_version')::bigint;
  IF (SELECT timing || '/' || confidence FROM quote_sections WHERE id = v_s1) IS DISTINCT FROM 'pre_plant/firm'
     OR (SELECT timing IS NULL AND confidence IS NULL FROM quote_sections WHERE id = v_s2) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) planning fields not written';
  END IF;

  -- P7. Omit timing: kept. Send it as null: cleared (confidence omitted both times: kept).
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version);
  v_res := save_quote(v_q, v_payload, jsonb_build_array(
    jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North', 'sort_order', 0,
      'items', jsonb_build_array(v_line)),
    jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 1,
      'confidence', 'maybe', 'items', '[]'::jsonb)),
    v_admin, 'smk-plan-p7a-' || v_suffix);
  v_version := (v_res->>'row_version')::bigint;
  IF (SELECT timing || '/' || confidence FROM quote_sections WHERE id = v_s1) IS DISTINCT FROM 'pre_plant/firm'
     OR (SELECT confidence FROM quote_sections WHERE id = v_s2) IS DISTINCT FROM 'maybe' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P7) an omitted key did not keep its value';
  END IF;
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version);
  v_res := save_quote(v_q, v_payload, jsonb_build_array(
    jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North', 'sort_order', 0,
      'timing', NULL, 'items', jsonb_build_array(v_line)),
    jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 1, 'items', '[]'::jsonb),
    jsonb_build_object('client_key', '_s3', 'section_name', 'West', 'sort_order', 2, 'items', '[]'::jsonb)),
    v_admin, 'smk-plan-p7b-' || v_suffix);
  v_version := (v_res->>'row_version')::bigint;
  IF (SELECT timing IS NULL AND confidence = 'firm' FROM quote_sections WHERE id = v_s1) IS NOT TRUE
     OR (SELECT timing IS NULL AND confidence IS NULL FROM quote_sections
          WHERE id = (v_res->'section_ids'->>'_s3')::uuid) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P7) a null did not clear, or a new section did not start unset';
  END IF;

  -- P5. An old screen (no marker) cannot wipe planning data.
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version);
  v_err := NULL;
  BEGIN
    PERFORM save_quote(v_q, v_payload - 'section_ids_v1', jsonb_build_array(
      jsonb_build_object('section_name', 'North', 'sort_order', 0, 'items', jsonb_build_array(v_line))),
      v_admin, 'smk-plan-p5-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'PLANNING_RELOAD_REQUIRED:%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P5) expected PLANNING_RELOAD_REQUIRED, got %', COALESCE(v_err, 'success');
  END IF;
  IF (SELECT row_version FROM quotes WHERE id = v_q) IS DISTINCT FROM v_version
     OR (SELECT count(*) FROM quote_sections WHERE quote_id = v_q) <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P5) a refused save changed the booking';
  END IF;
  -- A booking with nothing set still saves from an old screen.
  v_res := save_quote(NULL, jsonb_build_object('quote_number', '[SMOKE] PLAN2-' || v_suffix, 'customer_id', v_customer,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
    jsonb_build_array(jsonb_build_object('section_name', 'East', 'sort_order', 0, 'items', jsonb_build_array(v_line))),
    v_admin, 'smk-plan-old1-' || v_suffix);
  v_q2 := (v_res->>'quote_id')::uuid;
  v_res := save_quote(v_q2, jsonb_build_object('quote_number', '[SMOKE] PLAN2-' || v_suffix, 'customer_id', v_customer,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb,
      'row_version_expected', (v_res->>'row_version')::bigint),
    jsonb_build_array(jsonb_build_object('section_name', 'East', 'sort_order', 0, 'items', jsonb_build_array(v_line))),
    v_admin, 'smk-plan-old2-' || v_suffix);
  IF v_res->>'status' IS DISTINCT FROM 'saved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P5) an old save of an unplanned booking failed: %', v_res;
  END IF;

  -- C. Values outside the lists are refused.
  v_err := NULL;
  BEGIN
    PERFORM save_quote(v_q, v_payload, jsonb_build_array(
      jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North', 'sort_order', 0,
        'timing', 'winter', 'items', jsonb_build_array(v_line))),
      v_admin, 'smk-plan-c-' || v_suffix);
  EXCEPTION WHEN check_violation THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C) a timing outside the list was saved';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK planning fields written, kept when omitted, cleared by null; old screen refused PLANNING_RELOAD_REQUIRED; bad value refused';
END;
$smoke$;
