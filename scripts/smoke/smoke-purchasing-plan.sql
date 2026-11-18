-- ============================================================================
-- ROLLED-BACK smoke: the read-only Purchasing buy plan (bookings Phase A, PR 1b)
-- ----------------------------------------------------------------------------
-- REQUIRES 20270125173000_booking_timing_purchasing_plan. Proof cases of
-- docs/plans/2026-11-17-bookings-phase-a-CONTRACT.md (v4) and plan v3, against
-- get_purchasing_plan(12). Dates are relative to today (Chicago) so the chain never ages.
--   P9   on hand 100, Firm 80 at +100, an open order of 50 (no delivery: needed today),
--        Firm 80 at +131: order 30 by +86, order 80 by +117, suggested 110
--   P9b  an order line is dated by its earliest scheduled, undelivered delivery
--   P10  Firm 100 at +100, a PO of 100 due +126, Likely 100 at +130: one suggestion of
--        100, with no "expedite the later PO" alternative; could add 0
--   P11  on hand -10 and nothing else: order 10 now
--   P23  a booking line saved in lb on a Gal product: Check units, not counted; it does not cover its
--        booking's crop-program hold (20), which counts
--   P24  Firm 100 at +100 and a PO of only 10 due +126: buy 100, no PO offered instead
--   P12  a late PO counts today (flagged), an undated PO is listed not counted, a
--        draft PO shows as drafted; the product is not complete
--   P13  booking 100, order draw 60, job draw 40: 0 + 60 + 40 = 100; after the order is
--        cancelled (draw returned) 60 + 40; after the job completes, what is still owed
--   P14  order draws come off the LATEST-needed line first (drawn, section unknown);
--        draws of 150 against 100 booked put 50 in Over-drawn
--   P15  draft, closed_short, accepted-with-cancelled-order: nothing; accepted never ordered counts
--   P16  review list from 14 days before the window end (timed and untimed)
--   P17  Firm with no date (its booking also has a dated +60 line of 9, drawn 9 by an order: the
--        draw comes off the dated line, so the undated one stays listed), a job line in a foreign unit: each in its
--        bucket, not complete, no suggestion
--   P18  an order line counts only its quantity_remaining; a delivery covering only part of it
--        does not move its need date (it stays today)
--   P20  job lines in qt and Gal convert; a '2.5 GL' line counts on a product stocked by that
--        jug and goes to Check units on a Gal product
--   P21  a job's draw comes off its own (August) section: March still needs 100
--   P22  a draft booking's crop-program hold (20) counts now; a counted booking's hold on a product it books (10) does not;
--        its hold on a product it does not book (5 of product 22) does; an expired manual hold (7) does not
--   P8   an applicator and a caller with no user are refused
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so nothing persists. Any other error is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_applicator uuid := gen_random_uuid();
  v_customer uuid;
  v_t date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_p uuid[] := ARRAY[]::uuid[];
  v_pid uuid;
  v_i int;
  v_price_res jsonb;
  v_res jsonb;
  v_q uuid;
  v_q2 uuid;
  v_sec jsonb;
  v_s1 uuid;
  v_s2 uuid;
  v_order uuid;
  v_line uuid;
  v_job uuid;
  v_po uuid;
  v_plan jsonb;
  v_x jsonb;
  v_err text;
  v_n int := 0;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Purchasing Farm ' || v_suffix) RETURNING id INTO v_customer;
  -- Products 1..24, all stocked in Gal except 20 (stocked by the 2.5 GL jug); every product is inserted before any is priced
  -- (pricing sets a transaction-wide mode).
  FOR v_i IN 1..24 LOOP
    INSERT INTO products (product_name, unit_size, inventory_unit, product_form)
    VALUES ('[SMOKE] Purchasing ' || lpad(v_i::text, 2, '0') || ' ' || v_suffix,
            (ARRAY['Gal', '2.5 GL'])[(v_i = 20)::int + 1], (ARRAY['Gal', NULL])[(v_i = 20)::int + 1], 'liquid')
    RETURNING id INTO v_pid;
    v_p := v_p || v_pid;
  END LOOP;
  FOR v_i IN 1..24 LOOP
    v_price_res := preview_product_pricing_changes('product_page', NULL,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_p[v_i], 'row_version', (SELECT pricing_version FROM products WHERE id = v_p[v_i]),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke purchasing fixture setup')),
      v_admin, 'smk-pp-price-preview-' || v_i || '-' || v_suffix);
    PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
      v_admin, 'smk-pp-price-apply-' || v_i || '-' || v_suffix);
  END LOOP;

  -- A sent booking from (section, product index, qty, needed_by, timing, confidence) tuples.
  -- Built by save_quote (marked) and then sent.
  CREATE TEMP TABLE smk_pp_bookings (tag text PRIMARY KEY, quote_id uuid, section_ids jsonb) ON COMMIT DROP;

  -- ------------------------------------------------------------------ fixtures
  -- Helper pattern: v_sec is the sections array; one save per booking.
  -- P9: product 1. Two Firm bookings and an order.
  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p[1], 'Main Warehouse', 100, 0, 0);
  FOR v_i IN 1..2 LOOP
    v_res := save_quote(NULL, jsonb_build_object(
        'quote_number', '[SMOKE] PP9-' || v_i || '-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
        'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
      jsonb_build_array(jsonb_build_object('client_key', '_s', 'section_name', 'P9 ' || v_i, 'sort_order', 0,
        'needed_by_date', CASE v_i WHEN 1 THEN v_t + 100 ELSE v_t + 131 END, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_k', 'product_id', v_p[1], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 80, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
      v_admin, 'smk-pp9-' || v_i || '-' || v_suffix);
    INSERT INTO smk_pp_bookings VALUES ('P9-' || v_i, (v_res->>'quote_id')::uuid, v_res->'section_ids');
  END LOOP;
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
  VALUES ('SMK-PP9-' || v_suffix, v_customer, v_t, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_p[1], '[SMOKE] P9', 'Gal', 20, 6, 50, 1000, 0, 50);
  -- P9b: product 2. An order line with a cancelled delivery at +3 and scheduled ones at +20 and +40.
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
  VALUES ('SMK-PP9B-' || v_suffix, v_customer, v_t, 'confirmed', v_admin) RETURNING id INTO v_order;
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_p[2], '[SMOKE] P9b', 'Gal', 20, 6, 10, 200, 0, 10) RETURNING id INTO v_line;
  FOR v_i IN 1..3 LOOP
    INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    VALUES ('SMK-PP9B-' || v_i || '-' || v_suffix, v_order, v_customer, 'scheduled',
            v_t + (ARRAY[3, 20, 40])[v_i], v_admin)
    RETURNING id INTO v_job;  -- (a delivery id; v_job is reused as scratch)
    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES (v_job, v_line, v_p[2], 10, 'Gal');
    IF v_i = 1 THEN
      UPDATE deliveries SET status = 'cancelled' WHERE id = v_job;
    END IF;
  END LOOP;
  -- P18: product 3. Ordered 10, 6 delivered: demand is the 4 remaining.
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_p[3], '[SMOKE] P18', 'Gal', 20, 6, 10, 200, 6, 4) RETURNING id INTO v_line;
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
  VALUES ('SMK-PP18-' || v_suffix, v_order, v_customer, 'scheduled', v_t + 30, v_admin) RETURNING id INTO v_job;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
  VALUES (v_job, v_line, v_p[3], 2, 'Gal');
  PERFORM set_config('app.crx_below_cost_operation', '', true);

  -- P10: product 4. Firm 100 at +100 and Likely 100 at +130 (two sections, one booking); PO 100 due +126.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP10-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P10 firm', 'sort_order', 0,
        'needed_by_date', v_t + 100, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[4], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P10 likely', 'sort_order', 1,
        'needed_by_date', v_t + 130, 'confidence', 'likely',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[4], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp10-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P10', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMK-PP10-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_t + 126, v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_p[4], 100, 0, 6, 'Gal');

  -- P23: product 23, a line in lb (the stock unit is Gal). P24: product 24, Firm 100 at +100; PO of 10 due +126.
  FOR v_i IN 23..24 LOOP
    v_res := save_quote(NULL, jsonb_build_object(
        'quote_number', '[SMOKE] PP' || v_i || '-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
        'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
      jsonb_build_array(jsonb_build_object('client_key', '_s', 'section_name', 'P' || v_i, 'sort_order', 0,
          'needed_by_date', v_t + 100, 'confidence', 'firm',
          'items', jsonb_build_array(jsonb_build_object('client_key', '_k', 'product_id', v_p[v_i], 'sort_order', 0,
            'calc_mode', 'units_direct', 'total_units_needed', (ARRAY[50, 100])[v_i - 22],
            'price_override', 20, 'price_per_unit', 20, 'current_cost', 6,
            'unit_size', (ARRAY['lb', 'Gal'])[v_i - 22], 'acres', 0)))),
      v_admin, 'smk-pp' || v_i || '-' || v_suffix);
    INSERT INTO smk_pp_bookings VALUES ('P' || v_i, (v_res->>'quote_id')::uuid, v_res->'section_ids');
  END LOOP;
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMK-PP24-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_t + 126, v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_p[24], 10, 0, 6, 'Gal');

  -- P11: product 5. On hand -10 and nothing else.
  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p[5], 'Main Warehouse', -10, 0, 0);

  -- P12: product 6. Late PO 20 (-5), undated PO 30, draft PO 7; Firm 50 at +30.
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMK-PP12L-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_t - 5, v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_p[6], 20, 0, 6, 'Gal');
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMK-PP12U-' || v_suffix, '[SMOKE] Vendor', 'submitted', NULL, v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_p[6], 30, 0, 6, 'Gal');
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMK-PP12D-' || v_suffix, '[SMOKE] Vendor', 'draft', v_t + 10, v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_p[6], 7, 0, 6, 'Gal');
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP12-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(jsonb_build_object('client_key', '_s', 'section_name', 'P12', 'sort_order', 0,
      'needed_by_date', v_t + 30, 'confidence', 'firm',
      'items', jsonb_build_array(jsonb_build_object('client_key', '_k', 'product_id', v_p[6], 'sort_order', 0,
        'calc_mode', 'units_direct', 'total_units_needed', 50, 'price_override', 20, 'price_per_unit', 20,
        'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp12-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P12', (v_res->>'quote_id')::uuid, v_res->'section_ids');

  -- P13: product 7. Booking 100 Firm at +60; order draw 60 (an open order line of 60); a job
  -- from the section draws 40 (scheduled at +50, 40 gal).
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP13-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(jsonb_build_object('client_key', '_s', 'section_name', 'P13', 'sort_order', 0,
      'needed_by_date', v_t + 60, 'confidence', 'firm',
      'items', jsonb_build_array(jsonb_build_object('client_key', '_k', 'product_id', v_p[7], 'sort_order', 0,
        'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
        'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp13-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P13', (v_res->>'quote_id')::uuid, v_res->'section_ids');

  -- P14: product 8. One booking, an early line (+60, sort 0) and a late line (+150, sort 1), 100 each.
  -- Over-draw: product 9, 100 booked.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP14-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P14 early', 'sort_order', 0,
        'needed_by_date', v_t + 60, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[8], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0),
          jsonb_build_object('client_key', '_kc', 'product_id', v_p[9], 'sort_order', 1,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P14 late', 'sort_order', 1,
        'needed_by_date', v_t + 150, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[8], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp14-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P14', (v_res->>'quote_id')::uuid, v_res->'section_ids');

  -- P15: product 10. Four bookings of 7: draft, closed_short, accepted with a cancelled order,
  -- accepted never ordered. Only the last counts.
  FOR v_i IN 1..4 LOOP
    v_res := save_quote(NULL, jsonb_build_object(
        'quote_number', '[SMOKE] PP15-' || v_i || '-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
        'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
      jsonb_build_array(jsonb_build_object('client_key', '_s', 'section_name', 'P15 ' || v_i, 'sort_order', 0,
        'needed_by_date', v_t + 30, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_k', 'product_id', v_p[10], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 7, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
      v_admin, 'smk-pp15-' || v_i || '-' || v_suffix);
    INSERT INTO smk_pp_bookings VALUES ('P15-' || v_i, (v_res->>'quote_id')::uuid, v_res->'section_ids');
  END LOOP;

  -- P16: products 11-14. Review-list boundary: window end = today + 14 is listed, + 15 is not,
  -- for a timed section (windows moved to make the end land there) and an untimed one.
  UPDATE app_settings SET setting_value = jsonb_build_object(
      'pre_plant', jsonb_build_object('start', '03-01', 'end', '05-15'),
      'in_season', jsonb_build_object('start', '01-01', 'end', to_char(v_t + 15, 'MM-DD')),
      'late_summer', jsonb_build_object('start', '01-01', 'end', to_char(v_t + 14, 'MM-DD')))::text
   WHERE setting_key = 'booking_timing_windows';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_SETUP: booking_timing_windows setting missing';
  END IF;
  v_sec := '[]'::jsonb;
  FOR v_i IN 1..4 LOOP
    v_sec := v_sec || jsonb_build_array(jsonb_build_object('client_key', '_s' || v_i, 'section_name', 'P16 ' || v_i,
      'sort_order', v_i, 'needed_by_date', v_t + (ARRAY[14, 15, 14, 15])[v_i],
      'timing', (ARRAY['late_summer', 'in_season', NULL, NULL])[v_i], 'confidence', 'likely',
      'items', jsonb_build_array(jsonb_build_object('client_key', '_k' || v_i, 'product_id', v_p[10 + v_i], 'sort_order', 0,
        'calc_mode', 'units_direct', 'total_units_needed', 5, 'price_override', 20, 'price_per_unit', 20,
        'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))));
  END LOOP;
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP16-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    v_sec, v_admin, 'smk-pp16-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P16', (v_res->>'quote_id')::uuid, v_res->'section_ids');

  -- P17: product 15 Firm with no date; product 16 a job line in pounds (lb). (An undated job cannot exist: jobs.job_date is NOT NULL.)
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP17-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(jsonb_build_object('client_key', '_s', 'section_name', 'P17', 'sort_order', 0,
      'confidence', 'firm',
      'items', jsonb_build_array(jsonb_build_object('client_key', '_k', 'product_id', v_p[15], 'sort_order', 0,
        'calc_mode', 'units_direct', 'total_units_needed', 9, 'price_override', 20, 'price_per_unit', 20,
        'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_t', 'section_name', 'P17 dated', 'sort_order', 1,
      'needed_by_date', v_t + 60, 'confidence', 'firm',
      'items', jsonb_build_array(jsonb_build_object('client_key', '_kt', 'product_id', v_p[15], 'sort_order', 0,
        'calc_mode', 'units_direct', 'total_units_needed', 9, 'price_override', 20, 'price_per_unit', 20,
        'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp17-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P17', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES ((v_res->>'quote_id')::uuid, v_p[15], 9);
  INSERT INTO jobs (job_number, customer_id, status, job_date, created_by)
  VALUES ('SMK-PP17A-' || v_suffix, v_customer, 'scheduled', v_t + 20, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[16], 12, 'lb', 1);

  -- P20: job lines as Schedule Job labels them. Product 18 (Gal): 8 qt + 3 Gal = 5 Gal.
  -- Product 20 (stocked by the 2.5 GL jug): 5 x '2.5 GL' = 5 jugs. Product 21 (Gal) with a
  -- '2.5 GL' line cannot be converted, so it goes to Check units.
  INSERT INTO jobs (job_number, customer_id, status, job_date, created_by)
  VALUES ('SMK-PP20-' || v_suffix, v_customer, 'scheduled', v_t + 20, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order)
  VALUES (v_job, v_p[18], 8, 'qt', 1), (v_job, v_p[18], 3, 'Gal', 2),
         (v_job, v_p[20], 5, '2.5 GL', 3), (v_job, v_p[21], 4, '2.5 GL', 4);

  -- P21: product 19. Firm 100 early (+60) and 100 late (+150); a job from the late section draws 100.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP21-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P21 early', 'sort_order', 0,
        'needed_by_date', v_t + 60, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[19], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P21 late', 'sort_order', 1,
        'needed_by_date', v_t + 150, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[19], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp21-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P21', (v_res->>'quote_id')::uuid, v_res->'section_ids');

  -- Send every booking except P15's draft (a sent quote needs its sent version), then set P15's statuses.
  FOR v_q IN SELECT quote_id FROM smk_pp_bookings WHERE tag <> 'P15-1' LOOP
    PERFORM create_quote_version(v_q, v_admin, 'presented', 'smk-pp-ver-' || v_q || '-' || v_suffix,
      (SELECT row_version FROM quotes WHERE id = v_q));
  END LOOP;
  UPDATE quotes SET status = 'sent'
   WHERE id IN (SELECT quote_id FROM smk_pp_bookings WHERE tag <> 'P15-1');
  UPDATE quotes SET status = 'closed_short' WHERE id = (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P15-2');
  UPDATE quotes SET status = 'accepted' WHERE id IN (SELECT quote_id FROM smk_pp_bookings WHERE tag IN ('P15-3', 'P15-4'));
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id, quote_id)
  VALUES ('SMK-PP15-' || v_suffix, v_customer, v_t, 'cancelled', v_admin,
          (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P15-3'));
  -- P22 holds: product 22 on the draft booking and on the accepted-never-ordered booking (which books only
  -- product 10, so its product 22 hold counts); product 10 on that booking (its own line; does not count).
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active)
  VALUES (v_p[22], v_customer, 20, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P15-1'), v_admin, true),
         (v_p[22], v_customer, 5, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P15-4'), v_admin, true),
         (v_p[10], v_customer, 4, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P15-4'), v_admin, true),
         (v_p[23], v_customer, 20, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P23'), v_admin, true);
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, created_by, is_active, expires_at)
  VALUES (v_p[22], v_customer, 7, 'manual', v_admin, true, v_t - 1);

  -- P13 draws: an order of 60 from the booking, and a job from its section drawing 40.
  SELECT quote_id, (section_ids->>'_s')::uuid INTO v_q, v_s1 FROM smk_pp_bookings WHERE tag = 'P13';
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id, quote_id)
  VALUES ('SMK-PP13-' || v_suffix, v_customer, v_t, 'confirmed', v_admin, v_q) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_p[7], '[SMOKE] P13', 'Gal', 20, 6, 60, 1200, 0, 60);
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES (v_q, v_p[7], 60);
  INSERT INTO jobs (job_number, customer_id, status, job_date, quote_id, quote_section_id, created_by)
  VALUES ('SMK-PP13-' || v_suffix, v_customer, 'scheduled', v_t + 50, v_q, v_s1, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[7], 40, 'Gal', 1);
  INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn) VALUES (v_job, v_q, v_p[7], 40);

  -- P14 draws: 60 from the order side on product 8; 150 on product 9.
  SELECT quote_id INTO v_q FROM smk_pp_bookings WHERE tag = 'P14';
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES (v_q, v_p[8], 60), (v_q, v_p[9], 150);

  -- P21 draws: a job from the late section (+150) drawing 100.
  SELECT quote_id, (section_ids->>'_b')::uuid INTO v_q, v_s2 FROM smk_pp_bookings WHERE tag = 'P21';
  INSERT INTO jobs (job_number, customer_id, status, job_date, quote_id, quote_section_id, created_by)
  VALUES ('SMK-PP21-' || v_suffix, v_customer, 'scheduled', v_t + 150, v_q, v_s2, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[19], 100, 'Gal', 1);
  INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn) VALUES (v_job, v_q, v_p[19], 100);

  -- ------------------------------------------------------------------ the plan
  v_plan := get_purchasing_plan(12);
  IF (v_plan->>'today')::date <> v_t OR (v_plan->>'lead_days')::int <> 14 OR (v_plan->>'months_ahead')::int <> 12 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: header %', v_plan - 'products' - 'review' - 'firm_needs_date' - 'drawn_section_unknown';
  END IF;

  -- P9
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[1];
  IF (v_x->>'suggested')::numeric <> 110 OR (v_x->>'on_hand')::numeric <> 100 OR (v_x->>'committed')::numeric <> 210
     OR jsonb_array_length(v_x->'suggestions') <> 2
     OR (v_x->'suggestions'->0->>'need_date')::date <> v_t + 100 OR (v_x->'suggestions'->0->>'quantity')::numeric <> 30
     OR (v_x->'suggestions'->0->>'order_by')::date <> v_t + 86
     OR (v_x->'suggestions'->1->>'need_date')::date <> v_t + 131 OR (v_x->'suggestions'->1->>'quantity')::numeric <> 80
     OR (v_x->'suggestions'->1->>'order_by')::date <> v_t + 117
     OR (v_x->>'not_complete')::boolean THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P9) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P9b: dated by the +20 delivery (the cancelled +3 one is ignored).
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[2];
  IF jsonb_array_length(v_x->'rows') <> 1 OR (v_x->'rows'->0->>'need_date')::date <> v_t + 20
     OR (v_x->'suggestions'->0->>'need_date')::date <> v_t + 20 OR (v_x->'suggestions'->0->>'quantity')::numeric <> 10
     OR (v_x->'suggestions'->0->>'order_by')::date <> v_t + 6 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P9b) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P18
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[3];
  IF (v_x->>'committed')::numeric <> 4 OR (v_x->'rows'->0->>'need_date')::date <> v_t THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P18) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P10
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[4];
  IF (v_x->>'suggested')::numeric <> 100 OR (v_x->>'could_add')::numeric <> 0 OR (v_x->>'incoming')::numeric <> 100
     OR jsonb_array_length(v_x->'suggestions') <> 1
     OR (v_x->'suggestions'->0->>'need_date')::date <> v_t + 100 OR (v_x->'suggestions'->0->>'quantity')::numeric <> 100
     OR v_x->'suggestions'->0 ? 'later_po' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P10) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P11
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[5];
  IF v_x IS NULL OR jsonb_array_length(v_x->'suggestions') <> 1
     OR (v_x->'suggestions'->0->>'need_date')::date <> v_t OR (v_x->'suggestions'->0->>'quantity')::numeric <> 10
     OR NOT (v_x->'suggestions'->0->>'order_now')::boolean THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P11) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P12: late 20 counts today; firm 50 at +30 leaves 30 short.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[6];
  IF (v_x->>'incoming')::numeric <> 20 OR (v_x->>'drafted')::numeric <> 7 OR (v_x->>'suggested')::numeric <> 30
     OR NOT (v_x->>'not_complete')::boolean
     OR NOT (v_x->'reasons' ? 'late_po') OR NOT (v_x->'reasons' ? 'undated_po')
     OR jsonb_array_length(v_x->'purchase_orders') <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P12) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P13 active: booking 0 + order 60 + job 40.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[7];
  IF (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking') <> 0
     OR (SELECT SUM((r->>'quantity')::numeric) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'order') <> 60
     OR (SELECT SUM((r->>'quantity')::numeric) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'job') <> 40
     OR (v_x->>'committed')::numeric <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P13 active) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P14: the late line (+150) loses the 60 first; the early line keeps 100.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[8];
  IF (SELECT SUM((r->>'quantity')::numeric) FROM jsonb_array_elements(v_x->'rows') r
       WHERE r->>'kind' = 'booking' AND (r->>'raw_date')::date = v_t + 60) <> 100
     OR (SELECT SUM((r->>'quantity')::numeric) FROM jsonb_array_elements(v_x->'rows') r
          WHERE r->>'kind' = 'booking' AND (r->>'raw_date')::date = v_t + 150 AND (r->>'estimated')::boolean) <> 40
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'drawn_section_unknown') d
                     WHERE (d->>'product_id')::uuid = v_p[8] AND (d->>'quantity')::numeric = 60) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P14) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[9];
  IF (v_x->>'over_drawn')::numeric <> 50 OR NOT (v_x->'reasons' ? 'over_drawn')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P14 over-drawn) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P22: product 22. The draft booking's hold and the counted booking's hold on a product it does not book.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[22];
  IF (SELECT SUM((r->>'quantity')::numeric) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') <> 25
     OR (v_x->>'committed')::numeric <> 25 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P22) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P15: only the accepted-never-ordered booking counts.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[10];
  IF jsonb_array_length(v_x->'rows') <> 1 OR (v_x->'rows'->0->>'quantity')::numeric <> 7
     OR (v_x->'rows'->0->>'quote_id')::uuid <> (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P15-4') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P15) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P16: products 11 (timed, end +14) and 13 (untimed, +14) listed; 12 and 14 (+15) not.
  SELECT quote_id INTO v_q FROM smk_pp_bookings WHERE tag = 'P16';
  IF (SELECT array_agg(p->>'product_id' ORDER BY p->>'product_id')
        FROM jsonb_array_elements(v_plan->'review') r, jsonb_array_elements(r->'products') p
       WHERE (r->>'quote_id')::uuid = v_q)
     IS DISTINCT FROM (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(ARRAY[v_p[11], v_p[13]]) x)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'review') r
                     WHERE (r->>'quote_id')::uuid = v_q AND r->>'timing' = 'late_summer' AND (r->>'window_end')::date = v_t + 14) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P16) %', (SELECT jsonb_agg(r) FROM jsonb_array_elements(v_plan->'review') r WHERE (r->>'quote_id')::uuid = v_q);
  END IF;
  v_n := v_n + 1;

  -- P23
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[23];
  IF NOT (v_x->'reasons' ? 'check_units') OR (v_x->>'committed')::numeric <> 20
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'bucket' = 'check_units' AND (r->>'quantity')::numeric = 50)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold' AND (r->>'quantity')::numeric = 20) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P23 booking line in another unit) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P24
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[24];
  IF jsonb_array_length(v_x->'suggestions') <> 1 OR (v_x->'suggestions'->0->>'quantity')::numeric <> 100
     OR v_x->'suggestions'->0 ? 'later_po' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P24 small later PO) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P17
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[15];
  IF NOT (v_x->'reasons' ? 'needs_date') OR jsonb_array_length(v_x->'suggestions') <> 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'firm_needs_date') f
                     WHERE (f->>'product_id')::uuid = v_p[15] AND (f->>'quantity')::numeric = 9
                       AND f->>'customer_name' = '[SMOKE] Purchasing Farm ' || v_suffix) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P17 firm no date) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[16];
  IF NOT (v_x->'reasons' ? 'check_units') OR jsonb_array_length(v_x->'suggestions') <> 0
     OR v_x->'rows'->0->>'bucket' <> 'check_units' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P17 foreign unit) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P20
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[18];
  IF (v_x->'reasons' ? 'check_units') OR (v_x->>'committed')::numeric <> 5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P20 qt and Gal) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[20];
  IF (v_x->'reasons' ? 'check_units') OR (v_x->>'committed')::numeric <> 5 OR v_x->>'stock_unit' <> '2.5 GL' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P20 jug product) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[21];
  IF NOT (v_x->'reasons' ? 'check_units') OR (v_x->>'committed')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P20 foreign jug unit) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P21: the early section still needs 100; the late section is covered by its own job.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[19];
  IF (SELECT SUM((r->>'quantity')::numeric) FROM jsonb_array_elements(v_x->'rows') r
       WHERE r->>'kind' = 'booking' AND (r->>'raw_date')::date = v_t + 60 AND NOT (r->>'estimated')::boolean) <> 100
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND (r->>'raw_date')::date = v_t + 150)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'drawn_section_unknown') d WHERE (d->>'product_id')::uuid = v_p[19]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P21) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P13 transitions. The order is cancelled and its draw returned: booking 60 + job 40.
  UPDATE orders SET status = 'cancelled' WHERE order_number = 'SMK-PP13-' || v_suffix;
  UPDATE quote_product_draws SET quantity_drawn = 0
   WHERE quote_id = (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P13') AND product_id = v_p[7];
  v_plan := get_purchasing_plan(12);
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[7];
  IF (SELECT SUM((r->>'quantity')::numeric) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking') <> 60
     OR (v_x->>'committed')::numeric <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P13 order cancelled) %', v_x;
  END IF;
  -- The job completes. The engine keeps a completed job's draw at what it actually applied
  -- (none recorded here), so what is still owed is the booking less that kept draw.
  UPDATE jobs SET status = 'in_progress' WHERE job_number = 'SMK-PP13-' || v_suffix;
  UPDATE jobs SET status = 'completed' WHERE job_number = 'SMK-PP13-' || v_suffix;
  v_plan := get_purchasing_plan(12);
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[7];
  IF (v_x->>'committed')::numeric <> 100 - COALESCE((SELECT SUM(quantity_drawn) FROM job_product_draws
                                                      WHERE quote_id = (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P13')
                                                        AND product_id = v_p[7]), 0)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'job') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P13 job completed) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P8: an applicator, and a caller with no user, are refused.
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_applicator, 'smoke-pp-applicator-' || v_suffix || '@example.invalid',
          '{"full_name":"[SMOKE] PP Applicator","role":"applicator"}'::jsonb);
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_applicator AND role = 'applicator') THEN
    RAISE EXCEPTION 'SMOKE_SETUP: signup trigger did not create the applicator profile';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_applicator::text, true);
  v_err := NULL;
  BEGIN
    PERFORM get_purchasing_plan(6);
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P8) an applicator read the purchasing plan';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_err := NULL;
  BEGIN
    PERFORM get_purchasing_plan(6);
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P8) a caller with no user read the purchasing plan';
  END IF;
  v_n := v_n + 1;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK purchasing plan: % proof groups held', v_n;
END;
$smoke$;
