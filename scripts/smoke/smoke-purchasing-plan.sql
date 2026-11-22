-- ============================================================================
-- ROLLED-BACK smoke: the read-only Purchasing buy plan (bookings Phase A, PR 1b)
-- ----------------------------------------------------------------------------
-- REQUIRES 20270127110000_booking_timing_purchasing_plan and 20270207140000 (#1989 redesign: P10, P12, P22-P33
-- rewritten to its rules; docs/plans/2026-11-21-booking-reservations-CONTRACT.md). Proof cases of
-- docs/plans/2026-11-17-bookings-phase-a-CONTRACT.md (v4) and plan v3, against
-- get_purchasing_plan(12). Dates are relative to today (Chicago) so the chain never ages.
--   P9   on hand 100, Firm 80 at +100, an open order of 50 (no delivery: needed today),
--        Firm 80 at +131: order 30 by +86, order 80 by +117, suggested 110
--   P9b  an order line is dated by its earliest scheduled, undelivered delivery
--   P10  Firm 100 at +100, a PO of 100 due +126, Likely 100 at +130: the late PO covers the Firm line (flagged),
--        nothing to buy; the Likely 100 is could-add
--   P11  on hand -10 and nothing else: order 10 now
--   P23  a booking line saved in lb on a Gal product: Check units, not counted; its booking's hold is not read
--   P24  Firm 100 at +100 and a PO of only 10 due +126: the PO is late cover, buy 90
--   P12  a late PO counts today (flagged), an undated PO is late cover (20270207140000), a
--        draft PO shows as drafted; the product is not complete
--   P13  booking 100, order draw 60, job draw 40: 0 + 60 + 40 = 100; after the order is
--        cancelled (draw returned) 60 + 40; after the job completes, what is still owed
--   P14  order draws come off the LATEST-needed line first (drawn, section unknown);
--        draws of 150 against 100 booked put 50 in Over-drawn; an unknown draw of 100 on product 25
--        (Maybe 100 at +30, Firm 100 at +150) comes off the Maybe line, so Firm 100 stays committed
--   P15  draft, closed_short, accepted-with-cancelled-order: nothing; accepted never ordered counts
--   P16  review list from 14 days before the window end (timed and untimed)
--   P17  Firm with no date (its booking also has a dated +60 line of 9, drawn 9 by an order: the
--        draw comes off the dated line, so the undated one stays listed), a job line in a foreign unit: each in its
--        bucket, not complete, no suggestion
--   P18  an order line counts only its quantity_remaining; a delivery covering only part of it
--        does not move its need date (it stays today)
--   P20  job lines in qt and Gal convert; a '2.5 GL' line goes to Check units on a Gal product (also
--        when the product is sized 2.5 GL: its stock unit is Gal, a product must have a sold unit)
--   P21  a job's draw comes off its own (August) section: March still needs 100
--   P22  a counted booking's holds are never read (any product); a non-counted draft's hold of 20 is shelf-only
--        (10 on hand: 10 held, 10 unbacked, nothing to buy); an expired manual hold (7) does not count
--   P25  an active job whose line cannot be converted draws nothing from its booking (Firm 20 stays);
--        a counted booking's hold beside a set-aside line is not read: Firm 30 stays;
--        an 'infinity' needed-by date counts as no date (P17) and does not fail the plan
--   P26  (#1989 redesign) a booking's own holds are never read; its lines are the reservation, orders and Firm
--        first, then Maybe; a manual hold still takes the shelf; an active job's hold is not read either; a
--        booking line of 0 needs nothing
--   P28  Taha's cases on #1989: a draft Planned booking's Firm 500 at +45 with 13 on hand is bought (487) for +45,
--        never "order now"; a sent booking with Firm 100 at +45 and Maybe 100 at +120, 100 drawn by an order,
--        13 on hand: the draw takes the less sure Maybe line (the safe guess; Mason, 2026-11-19), so 87 Firm to
--        buy; an order naming the Maybe line leaves the Firm line listed first needed
--   P29  draws ignore line position: tied sections (product 43) still lose the Maybe line first; 100 drawn
--        against Firm 100 + Maybe 50 leaves Firm 50 (product 44)
--   P30  (#1989 redesign: Firm always first) 0 on hand, Maybe 100 held, PO 100 at +10, another booking's Firm 100
--        at +20: the PO covers the Firm line, nothing to buy; a Firm 100 at +1 with a PO of 100 at +10: late
--        cover, flagged, nothing to buy (product 46)
--   P31  holds and their expiry are not read: Firm 50 takes the latest PO by its date, the Maybe lines share the
--        earlier PO (product 47)
--   P32  a closed booking's hold reserves the shelf only: no PO claim, no buy, the rest unbacked (product 48)
--   P33  an active job's hold is not read; its unconvertible line reserves nothing (product 49)
--   P34  a draw against a line set aside for its unit is not over-drawn (product 50)
--   P35  a job's draw beyond its own section is listed as drawn, section unknown (product 51)
--   P27  a window crossing New Year ends next year; an invalid start month-day falls back the whole window
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
  v_d date;
  v_n int := 0;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Purchasing Farm ' || v_suffix) RETURNING id INTO v_customer;
  -- Products 1..51, all stocked in Gal (product 20 is sized 2.5 GL, but its stock unit is Gal: a product must have a sold unit); every product is inserted before any is priced
  -- (pricing sets a transaction-wide mode).
  FOR v_i IN 1..51 LOOP
    INSERT INTO products (product_name, unit_size, inventory_unit, product_form)
    VALUES ('[SMOKE] Purchasing ' || lpad(v_i::text, 2, '0') || ' ' || v_suffix,
            (ARRAY['Gal', '2.5 GL'])[(v_i = 20)::int + 1], 'Gal', 'liquid')
    RETURNING id INTO v_pid;
    v_p := v_p || v_pid;
  END LOOP;
  FOR v_i IN 1..51 LOOP
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
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0),
          jsonb_build_object('client_key', '_kf', 'product_id', v_p[26], 'sort_order', 2,
          'calc_mode', 'units_direct', 'total_units_needed', 20, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0),
          jsonb_build_object('client_key', '_kg', 'product_id', v_p[27], 'sort_order', 3,
          'calc_mode', 'units_direct', 'total_units_needed', 30, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P14 late', 'sort_order', 1,
        'needed_by_date', v_t + 150, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[8], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0),
          jsonb_build_object('client_key', '_kd', 'product_id', v_p[25], 'sort_order', 1,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0),
          jsonb_build_object('client_key', '_kh', 'product_id', v_p[27], 'sort_order', 2,
          'calc_mode', 'units_direct', 'total_units_needed', 10, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'lb', 'acres', 0))),
      jsonb_build_object('client_key', '_c', 'section_name', 'P14 maybe', 'sort_order', 2,
        'needed_by_date', v_t + 30, 'confidence', 'maybe',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ke', 'product_id', v_p[25], 'sort_order', 0,
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
  UPDATE quote_sections SET needed_by_date = 'infinity', timing = 'in_season' WHERE id = (v_res->'section_ids'->>'_s')::uuid;
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES ((v_res->>'quote_id')::uuid, v_p[15], 9);
  INSERT INTO jobs (job_number, customer_id, status, job_date, created_by)
  VALUES ('SMK-PP17A-' || v_suffix, v_customer, 'scheduled', v_t + 20, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[16], 12, 'lb', 1);

  -- P20: job lines as Schedule Job labels them. Product 18 (Gal): 8 qt + 3 Gal = 5 Gal.
  -- Product 20 (sized 2.5 GL, stocked in Gal) and product 21 (Gal), each with a
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

  -- P26 (20270206130000, held stock never reads as free): one booking.
  --   _a Maybe at +60: product 28 (100), 29 (100), 30 (100), 33 (20); _b Firm at +400: product 31 (100);
  --   _c Firm, no date: product 32 (50); _d pre_plant, Likely, needed Dec 31 this year: product 34 (5);
  --   _e Firm at +30: product 35 (40), 37 (50), 38 (0); _f Maybe at +10: product 37 (50).
  -- On hand: 28 100, 29 none, 30 60, 31 100, 32 50, 33 30, 35 100, 36 100, 37 50.
  -- Open orders needed today: 28 100, 31 100, 35 60, 36 100. Product 36: an active job at +5 of 100 (no booking).
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP26-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P26 maybe', 'sort_order', 0,
        'needed_by_date', v_t + 60, 'confidence', 'maybe',
        'items', (SELECT jsonb_agg(jsonb_build_object('client_key', '_ka' || x.i, 'product_id', v_p[x.i], 'sort_order', x.i,
                    'calc_mode', 'units_direct', 'total_units_needed', x.q, 'price_override', 20, 'price_per_unit', 20,
                    'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))
                    FROM (VALUES (28, 100), (29, 100), (30, 100), (33, 20)) x(i, q))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P26 firm later', 'sort_order', 1,
        'needed_by_date', v_t + 400, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[31], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_c', 'section_name', 'P26 firm undated', 'sort_order', 2,
        'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kc', 'product_id', v_p[32], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 50, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_d', 'section_name', 'P26 window', 'sort_order', 3,
        'needed_by_date', make_date(extract(year FROM v_t)::int, 12, 31), 'timing', 'pre_plant', 'confidence', 'likely',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kd', 'product_id', v_p[34], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 5, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_e', 'section_name', 'P26 firm soon', 'sort_order', 4,
        'needed_by_date', v_t + 30, 'confidence', 'firm',
        'items', (SELECT jsonb_agg(jsonb_build_object('client_key', '_ke' || x.i, 'product_id', v_p[x.i], 'sort_order', x.i,
                    'calc_mode', 'units_direct', 'total_units_needed', x.q, 'price_override', 20, 'price_per_unit', 20,
                    'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))
                    FROM (VALUES (35, 40), (37, 50), (38, 0)) x(i, q))),
      jsonb_build_object('client_key', '_f', 'section_name', 'P26 maybe sooner', 'sort_order', 5,
        'needed_by_date', v_t + 10, 'confidence', 'maybe',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kf', 'product_id', v_p[37], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 50, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp26-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P26', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  SELECT v_p[x.i], 'Main Warehouse', x.q, 0, 0
    FROM (VALUES (28, 100), (30, 60), (31, 100), (32, 50), (33, 30), (35, 100), (36, 100), (37, 50), (38, 60)) x(i, q);
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
  VALUES ('SMK-PP26-' || v_suffix, v_customer, v_t, 'confirmed', v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_p[28], '[SMOKE] P26a', 'Gal', 20, 6, 100, 2000, 0, 100),
         (v_order, v_p[31], '[SMOKE] P26d', 'Gal', 20, 6, 100, 2000, 0, 100),
         (v_order, v_p[35], '[SMOKE] P26g', 'Gal', 20, 6, 60, 1200, 0, 60),
         (v_order, v_p[36], '[SMOKE] P26h', 'Gal', 20, 6, 100, 2000, 0, 100);
  PERFORM set_config('app.crx_below_cost_operation', '', true);

  -- P28 (Taha on #1989): products 39 and 41 on a draft booking (Firm 500 and Firm 50 at +45); product 40 on a sent booking
  -- (Firm 100 at +45, Maybe 100 at +120). 13 on hand of each.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP28D-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P28 draft firm', 'sort_order', 0,
        'needed_by_date', v_t + 45, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[39], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 500, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0),
          jsonb_build_object('client_key', '_kb', 'product_id', v_p[41], 'sort_order', 1,
          'calc_mode', 'units_direct', 'total_units_needed', 50, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp28d-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P28D', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  -- A draft booking's program holds exist only while it is planned (_sync_planned_holds); its holds are inserted below.
  UPDATE quotes SET is_planned = true WHERE id = (v_res->>'quote_id')::uuid;
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP28-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P28 jan firm', 'sort_order', 0,
        'needed_by_date', v_t + 45, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[40], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P28 mar maybe', 'sort_order', 1,
        'needed_by_date', v_t + 120, 'confidence', 'maybe',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[40], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp28-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P28', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  -- Product 42: Firm 100 at +7 listed first, Maybe 100 at +60 second; no stock.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP28S-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P28 firm first', 'sort_order', 0,
        'needed_by_date', v_t + 7, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[42], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P28 maybe second', 'sort_order', 1,
        'needed_by_date', v_t + 60, 'confidence', 'maybe',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[42], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp28s-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P28S', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  -- P29T, product 43: both sections at position 0; Firm 100 at +150 is line position 1, Maybe 100 at +30 position 0.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP29T-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P29T a', 'sort_order', 0,
        'needed_by_date', v_t + 150, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[43], 'sort_order', 1,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P29T b', 'sort_order', 0,
        'needed_by_date', v_t + 30, 'confidence', 'maybe',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[43], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp29t-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P29T', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  -- P30, product 45: booking P30M Maybe 100 at +60 (held in full below); booking P30F Firm 100 at +20; no stock.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP30M-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(jsonb_build_object('client_key', '_a', 'section_name', 'P30', 'sort_order', 0,
      'needed_by_date', v_t + 60, 'confidence', 'maybe',
      'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[45], 'sort_order', 0,
        'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
        'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp30m-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P30M', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP30F-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(jsonb_build_object('client_key', '_a', 'section_name', 'P30', 'sort_order', 0,
      'needed_by_date', v_t + 20, 'confidence', 'firm',
      'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[45], 'sort_order', 0,
        'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
        'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp30f-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P30F', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMK-PP30-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_t + 10, v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_p[45], 100, 0, 6, 'Gal');
  -- P30E, product 46: Firm 100 at +1, held in full below; PO of 100 at +10; no stock.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP30E-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(jsonb_build_object('client_key', '_a', 'section_name', 'P30E', 'sort_order', 0,
      'needed_by_date', v_t + 1, 'confidence', 'firm',
      'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[46], 'sort_order', 0,
        'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
        'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp30e-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P30E', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMK-PP30E-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_t + 10, v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_p[46], 100, 0, 6, 'Gal');
  -- P29X, product 44: Firm 100 at +30 listed first, Maybe 50 at +60 second.
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] PP29X-' || v_suffix, 'customer_id', v_customer, 'status', 'draft',
      'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
    jsonb_build_array(
      jsonb_build_object('client_key', '_a', 'section_name', 'P29X a', 'sort_order', 0,
        'needed_by_date', v_t + 30, 'confidence', 'firm',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[44], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
      jsonb_build_object('client_key', '_b', 'section_name', 'P29X b', 'sort_order', 1,
        'needed_by_date', v_t + 60, 'confidence', 'maybe',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[44], 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', 50, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0)))),
    v_admin, 'smk-pp29x-' || v_suffix);
  INSERT INTO smk_pp_bookings VALUES ('P29X', (v_res->>'quote_id')::uuid, v_res->'section_ids');
  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p[39], 'Main Warehouse', 13, 0, 0), (v_p[40], 'Main Warehouse', 13, 0, 0);

  -- Send every booking except P15's draft (a sent quote needs its sent version), then set P15's statuses.
  FOR v_q IN SELECT quote_id FROM smk_pp_bookings WHERE tag NOT IN ('P15-1', 'P28D') LOOP
    PERFORM create_quote_version(v_q, v_admin, 'presented', 'smk-pp-ver-' || v_q || '-' || v_suffix,
      (SELECT row_version FROM quotes WHERE id = v_q));
  END LOOP;
  UPDATE quotes SET status = 'sent'
   WHERE id IN (SELECT quote_id FROM smk_pp_bookings WHERE tag NOT IN ('P15-1', 'P28D'));
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
  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p[22], 'Main Warehouse', 10, 0, 0), (v_p[23], 'Main Warehouse', 8, 0, 0);
  -- source_id set: the standalone-insert guard (20260908130000) refuses an unsourced manual hold outside its RPC.
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[22], v_customer, 7, 'manual', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P15-1'), v_admin, true, v_t - 1);

  -- P26 holds: each booked product held in full; a manual hold of 30 takes all of product 33's stock.
  SELECT quote_id INTO v_q FROM smk_pp_bookings WHERE tag = 'P26';
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active)
  SELECT v_p[x.i], v_customer, x.q, 'crop_program', v_q, v_admin, true
    FROM (VALUES (28, 100), (29, 100), (30, 100), (31, 100), (32, 50), (33, 20), (35, 100), (37, 50), (38, 100)) x(i, q);
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active)
  VALUES (v_p[33], v_customer, 30, 'manual', v_q, v_admin, true),
  -- A legacy hold whose quantity is not finite is ignored (P26g still buys exactly 60).
         (v_p[35], v_customer, 'Infinity'::numeric, 'crop_program', v_q, v_admin, true);
  -- Product 36: an active job of 100 at +5 with its job hold of 100.
  INSERT INTO jobs (job_number, customer_id, status, job_date, created_by)
  VALUES ('SMK-PP26H-' || v_suffix, v_customer, 'scheduled', v_t + 5, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[36], 100, 'Gal', 1);
  DELETE FROM inventory_holds WHERE source_id = v_job;
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active)
  VALUES (v_p[36], v_customer, 100, 'job', v_job, v_admin, true);

  -- P28 draw and holds: 100 drawn (section unknown) from the P28 booking; each booking's hold expires at its line's
  -- need date + 14 days, as _sync_planned_holds sets it.
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  VALUES ((SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P28'), v_p[40], 100);
  -- P28S: a delivered booking-draw order whose line names the Maybe line.
  SELECT quote_id, (section_ids->>'_b')::uuid INTO v_q, v_s2 FROM smk_pp_bookings WHERE tag = 'P28S';
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id, quote_id, booking_draw)
  VALUES ('SMK-PP28S-' || v_suffix, v_customer, v_t, 'confirmed', v_admin, v_q, true) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, quote_item_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_p[42], (SELECT qi.id FROM quote_items qi WHERE qi.quote_id = v_q AND qi.section_id = v_s2),
          '[SMOKE] P28S', 'Gal', 20, 6, 100, 2000, 100, 0);
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES (v_q, v_p[42], 100);
  -- P29T: 100 drawn with no recorded line.
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  VALUES ((SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P29T'), v_p[43], 100);
  -- P30: the Maybe booking's hold of 100 (nothing on the shelf).
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[45], v_customer, 100, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P30M'), v_admin, true,
          v_t + 74);
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[46], v_customer, 100, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P30E'), v_admin, true,
          v_t + 15);
  -- P29X: a delivered order of 100 naming the Maybe line of 50.
  SELECT quote_id, (section_ids->>'_b')::uuid INTO v_q, v_s2 FROM smk_pp_bookings WHERE tag = 'P29X';
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id, quote_id, booking_draw)
  VALUES ('SMK-PP29X-' || v_suffix, v_customer, v_t, 'confirmed', v_admin, v_q, true) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO order_items (order_id, product_id, quote_item_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_p[44], (SELECT qi.id FROM quote_items qi WHERE qi.quote_id = v_q AND qi.section_id = v_s2),
          '[SMOKE] P29X', 'Gal', 20, 6, 100, 2000, 100, 0);
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES (v_q, v_p[44], 100);
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[39], v_customer, 500, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P28D'), v_admin, true,
          v_t + 59),
         (v_p[40], v_customer, 100, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P28'), v_admin, true,
          v_t + 134),
  -- An 'infinity' need date gives an infinite expiry: that hold's rest counts today (product 41, no stock).
         (v_p[41], v_customer, 50, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P28D'), v_admin, true,
          'infinity'::date);

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
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES (v_q, v_p[8], 60), (v_q, v_p[9], 150), (v_q, v_p[25], 100);
  -- P25: an active job on this booking with product 26 in '2.5 GL' (stock Gal: not convertible), drawing 20;
  -- a crop-program hold of 20 on product 27 (one Gal line of 30, one set-aside lb line of 10).
  INSERT INTO jobs (job_number, customer_id, status, job_date, quote_id, created_by)
  VALUES ('SMK-PP25-' || v_suffix, v_customer, 'scheduled', v_t + 20, v_q, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[26], 20, '2.5 GL', 1);
  INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn) VALUES (v_job, v_q, v_p[26], 20);
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active)
  VALUES (v_p[27], v_customer, 20, 'crop_program', v_q, v_admin, true);

  -- P21 draws: a job from the late section (+150) drawing 100.
  SELECT quote_id, (section_ids->>'_b')::uuid INTO v_q, v_s2 FROM smk_pp_bookings WHERE tag = 'P21';
  INSERT INTO jobs (job_number, customer_id, status, job_date, quote_id, quote_section_id, created_by)
  VALUES ('SMK-PP21-' || v_suffix, v_customer, 'scheduled', v_t + 150, v_q, v_s2, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[19], 100, 'Gal', 1);
  INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn) VALUES (v_job, v_q, v_p[19], 100);

  -- P31-P35 (the Nov 20 Sol review of #1989; Mason kept "holds take incoming stock first", 2026-11-21).
  -- P31, product 47 (no stock): bookings P31A and P31B, each Maybe 50 at +60 and fully held; A's hold expires
  -- at +5, B's at +74. POs of 50 at +10 and +30. Booking P31F: Firm 50 at +40.
  -- P34, product 50: booking P34 with a Gal line of 30 and a set-aside lb line of 10, drawn 35 by an order.
  -- P35, product 51: booking P35, Firm 5 at +20 (section _a) and Firm 100 at +60 (section _b); a job on _a draws 12.
  FOR v_i IN 1..5 LOOP
    v_res := save_quote(NULL, jsonb_build_object(
        'quote_number', '[SMOKE] PP' || (ARRAY['31A', '31B', '31F', '34', '35'])[v_i] || '-' || v_suffix,
        'customer_id', v_customer, 'status', 'draft',
        'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true),
      CASE v_i
        WHEN 4 THEN jsonb_build_array(jsonb_build_object('client_key', '_a', 'section_name', 'P34', 'sort_order', 0,
            'needed_by_date', v_t + 30, 'confidence', 'firm',
            'items', jsonb_build_array(
              jsonb_build_object('client_key', '_ka', 'product_id', v_p[50], 'sort_order', 0, 'calc_mode', 'units_direct',
                'total_units_needed', 30, 'price_override', 20, 'price_per_unit', 20, 'current_cost', 6, 'unit_size', 'Gal', 'acres', 0),
              jsonb_build_object('client_key', '_kb', 'product_id', v_p[50], 'sort_order', 1, 'calc_mode', 'units_direct',
                'total_units_needed', 10, 'price_override', 20, 'price_per_unit', 20, 'current_cost', 6, 'unit_size', 'lb', 'acres', 0))))
        WHEN 5 THEN jsonb_build_array(
          jsonb_build_object('client_key', '_a', 'section_name', 'P35 a', 'sort_order', 0,
            'needed_by_date', v_t + 20, 'confidence', 'firm',
            'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[51], 'sort_order', 0,
              'calc_mode', 'units_direct', 'total_units_needed', 5, 'price_override', 20, 'price_per_unit', 20,
              'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))),
          jsonb_build_object('client_key', '_b', 'section_name', 'P35 b', 'sort_order', 1,
            'needed_by_date', v_t + 60, 'confidence', 'firm',
            'items', jsonb_build_array(jsonb_build_object('client_key', '_kb', 'product_id', v_p[51], 'sort_order', 0,
              'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_override', 20, 'price_per_unit', 20,
              'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))))
        ELSE jsonb_build_array(jsonb_build_object('client_key', '_a', 'section_name', 'P31', 'sort_order', 0,
            'needed_by_date', v_t + (ARRAY[60, 60, 40])[v_i], 'confidence', (ARRAY['maybe', 'maybe', 'firm'])[v_i],
            'items', jsonb_build_array(jsonb_build_object('client_key', '_ka', 'product_id', v_p[47], 'sort_order', 0,
              'calc_mode', 'units_direct', 'total_units_needed', 50, 'price_override', 20, 'price_per_unit', 20,
              'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))))
      END,
      v_admin, 'smk-pp3x' || v_i || '-' || v_suffix);
    INSERT INTO smk_pp_bookings VALUES ('P' || (ARRAY['31A', '31B', '31F', '34', '35'])[v_i], (v_res->>'quote_id')::uuid, v_res->'section_ids');
  END LOOP;
  FOR v_q IN SELECT quote_id FROM smk_pp_bookings WHERE tag IN ('P31A', 'P31B', 'P31F', 'P34', 'P35') LOOP
    PERFORM create_quote_version(v_q, v_admin, 'presented', 'smk-pp-ver-' || v_q || '-' || v_suffix,
      (SELECT row_version FROM quotes WHERE id = v_q));
  END LOOP;
  UPDATE quotes SET status = 'sent' WHERE id IN (SELECT quote_id FROM smk_pp_bookings WHERE tag IN ('P31A', 'P31B', 'P31F', 'P34', 'P35'));
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[47], v_customer, 50, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P31A'), v_admin, true, v_t + 5),
         (v_p[47], v_customer, 50, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P31B'), v_admin, true, v_t + 74);
  FOR v_i IN 1..2 LOOP
    INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
    VALUES ('SMK-PP31-' || v_i || '-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_t + (ARRAY[10, 30])[v_i], v_admin) RETURNING id INTO v_po;
    INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
    VALUES (v_po, v_p[47], 50, 0, 6, 'Gal');
  END LOOP;
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  VALUES ((SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P34'), v_p[50], 35);
  SELECT quote_id, (section_ids->>'_a')::uuid INTO v_q, v_s1 FROM smk_pp_bookings WHERE tag = 'P35';
  INSERT INTO jobs (job_number, customer_id, status, job_date, quote_id, quote_section_id, created_by)
  VALUES ('SMK-PP35-' || v_suffix, v_customer, 'scheduled', v_t + 20, v_q, v_s1, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[51], 12, 'Gal', 1);
  INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn) VALUES (v_job, v_q, v_p[51], 12);
  DELETE FROM inventory_holds WHERE source_id = v_job;
  -- P32, product 48: 5 on hand, PO of 30 at +10; a hold of 20 on the closed booking P15-2: it reserves 5 on
  -- the shelf and never claims the PO or buys.
  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p[48], 'Main Warehouse', 5, 0, 0), (v_p[49], 'Main Warehouse', 10, 0, 0);
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[48], v_customer, 20, 'crop_program', (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P15-2'), v_admin, true, v_t + 60);
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMK-PP32-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_t + 10, v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_p[48], 30, 0, 6, 'Gal');
  -- P33, product 49: 10 on hand; an active job at +5 with a '2.5 GL' line of 10 (stock Gal: not convertible) and
  -- its job hold of 10; another job at +3 needs 10 Gal (no hold). The held 10 is not free: buy 10.
  INSERT INTO jobs (job_number, customer_id, status, job_date, created_by)
  VALUES ('SMK-PP33H-' || v_suffix, v_customer, 'scheduled', v_t + 5, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[49], 10, '2.5 GL', 1);
  DELETE FROM inventory_holds WHERE source_id = v_job;
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active)
  VALUES (v_p[49], v_customer, 10, 'job', v_job, v_admin, true);
  INSERT INTO jobs (job_number, customer_id, status, job_date, created_by)
  VALUES ('SMK-PP33O-' || v_suffix, v_customer, 'scheduled', v_t + 3, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_job, v_p[49], 10, 'Gal', 1);
  DELETE FROM inventory_holds WHERE source_id = v_job;

  -- ------------------------------------------------------------------ the plan
  v_plan := get_purchasing_plan(12);
  IF (v_plan->>'today')::date <> v_t OR (v_plan->>'lead_days')::int <> 14 OR (v_plan->>'months_ahead')::int <> 12 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: header %', v_plan - 'products' - 'review' - 'firm_needs_date' - 'drawn_section_unknown';
  END IF;

  -- P9
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[1];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 110 OR (v_x->>'on_hand')::numeric <> 100 OR (v_x->>'committed')::numeric <> 210
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
  IF v_x IS NULL OR jsonb_array_length(v_x->'rows') <> 1 OR (v_x->'rows'->0->>'need_date')::date <> v_t + 20
     OR (v_x->'suggestions'->0->>'need_date')::date <> v_t + 20 OR (v_x->'suggestions'->0->>'quantity')::numeric <> 10
     OR (v_x->'suggestions'->0->>'order_by')::date <> v_t + 6 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P9b) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P18
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[3];
  IF v_x IS NULL OR (v_x->>'committed')::numeric <> 4 OR (v_x->'rows'->0->>'need_date')::date <> v_t THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P18) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P10
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[4];
  -- 20270207140000 (answer 4): the PO arriving at +126 is late cover for the Firm 100, never a second buy;
  -- the Likely 100 then has nothing left and is could-add.
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR (v_x->>'could_add')::numeric <> 100 OR (v_x->>'incoming')::numeric <> 100
     OR jsonb_array_length(v_x->'suggestions') <> 0 OR NOT (v_x->>'has_late_cover')::boolean THEN
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

  -- P12: late 20 counts today; the undated 30 is late cover for the rest of the Firm 50 at +30.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[6];
  -- 20270207140000: the undated PO 30 now counts as late cover (after every dated PO), so nothing is bought.
  IF v_x IS NULL OR (v_x->>'incoming')::numeric <> 50 OR (v_x->>'drafted')::numeric <> 7 OR (v_x->>'suggested')::numeric <> 0
     OR (SELECT trim_scale((c->>'on_time')::numeric) || '/' || trim_scale((c->>'late')::numeric) FROM jsonb_array_elements(v_x->'coverage') c
          WHERE c->>'group' = 'committed') <> '20/30'
     OR NOT (v_x->>'not_complete')::boolean
     OR NOT (v_x->'reasons' ? 'late_po') OR NOT (v_x->'reasons' ? 'undated_po')
     OR jsonb_array_length(v_x->'purchase_orders') <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P12) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P13 active: booking 0 + order 60 + job 40.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[7];
  IF v_x IS NULL OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking') <> 0
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'order') <> 60
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'job') <> 40
     OR (v_x->>'committed')::numeric <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P13 active) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P14: the late line (+150) loses the 60 first; the early line keeps 100.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[8];
  IF v_x IS NULL OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r
       WHERE r->>'kind' = 'booking' AND (r->>'raw_date')::date = v_t + 60) <> 100
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r
          WHERE r->>'kind' = 'booking' AND (r->>'raw_date')::date = v_t + 150 AND (r->>'estimated')::boolean) <> 40
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'drawn_section_unknown') d
                     WHERE (d->>'product_id')::uuid = v_p[8] AND (d->>'quantity')::numeric = 60) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P14) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[9];
  IF v_x IS NULL OR (v_x->>'over_drawn')::numeric IS DISTINCT FROM 50 OR NOT (v_x->'reasons' ? 'over_drawn')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P14 over-drawn) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[25];
  IF v_x IS NULL OR (v_x->>'committed')::numeric IS DISTINCT FROM 100
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r
          WHERE r->>'kind' = 'booking' AND (r->>'raw_date')::date = v_t + 150) IS DISTINCT FROM 100
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r
                 WHERE r->>'kind' = 'booking' AND (r->>'raw_date')::date = v_t + 30) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P14 confidence) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[26];
  IF v_x IS NULL OR (v_x->>'committed')::numeric IS DISTINCT FROM 20 OR NOT (v_x->'reasons' ? 'check_units') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P25 unconvertible job draw) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[27];
  IF v_x IS NULL OR (v_x->>'committed')::numeric IS DISTINCT FROM 30 OR NOT (v_x->'reasons' ? 'check_units')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P25 hold beside a set-aside line) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P22: product 22. A counted booking's own holds are ignored with no exception (#1989 redesign): the accepted
  -- booking's hold of 5 is not read. The draft (not Planned) booking does not count, so its hold of 20 is shelf-only:
  -- it takes the 10 on the shelf, 10 is unbacked, nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[22];
  IF v_x IS NULL OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') <> 20
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold' AND r->>'class' <> 'shelf_hold')
     OR (v_x->>'hold_unbacked')::numeric <> 10 OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shelf_hold') IS DISTINCT FROM 10
     OR (v_x->>'committed')::numeric <> 0 OR (v_x->>'suggested')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P22) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P15: only the accepted-never-ordered booking counts.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[10];
  IF v_x IS NULL OR jsonb_array_length(v_x->'rows') <> 1 OR (v_x->'rows'->0->>'quantity')::numeric <> 7
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

  -- P23: the booking's line in another unit is under Check units and reserves nothing; its own hold is ignored.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[23];
  IF v_x IS NULL OR NOT (v_x->'reasons' ? 'check_units') OR (v_x->>'committed')::numeric <> 0 OR (v_x->>'suggested')::numeric <> 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'bucket' = 'check_units' AND (r->>'quantity')::numeric = 50)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P23 booking line in another unit) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P24: a PO of 10 arriving after the Firm 100's date is late cover (flagged), never bought twice: buy 90.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[24];
  IF v_x IS NULL OR jsonb_array_length(v_x->'suggestions') <> 1 OR (v_x->'suggestions'->0->>'quantity')::numeric <> 90
     OR v_x->'suggestions'->0 ? 'later_po' OR NOT (v_x->>'has_late_cover')::boolean OR (SELECT (c->>'late')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P24 small later PO) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P17
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[15];
  IF v_x IS NULL OR NOT (v_x->'reasons' ? 'needs_date') OR jsonb_array_length(v_x->'suggestions') <> 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'firm_needs_date') f
                     WHERE (f->>'product_id')::uuid = v_p[15] AND (f->>'quantity')::numeric = 9
                       AND f->>'customer_name' = '[SMOKE] Purchasing Farm ' || v_suffix) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P17 firm no date) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[16];
  IF v_x IS NULL OR NOT (v_x->'reasons' ? 'check_units') OR jsonb_array_length(v_x->'suggestions') <> 0
     OR v_x->'rows'->0->>'bucket' <> 'check_units' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P17 foreign unit) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P20
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[18];
  IF v_x IS NULL OR (v_x->'reasons' ? 'check_units') OR (v_x->>'committed')::numeric <> 5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P20 qt and Gal) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[20];
  IF v_x IS NULL OR NOT (v_x->'reasons' ? 'check_units') OR (v_x->>'committed')::numeric <> 0 OR v_x->>'stock_unit' <> 'Gal' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P20 jug-sized product stocked in Gal) %', v_x;
  END IF;
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[21];
  IF v_x IS NULL OR NOT (v_x->'reasons' ? 'check_units') OR (v_x->>'committed')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P20 foreign jug unit) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P21: the early section still needs 100; the late section is covered by its own job.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[19];
  IF v_x IS NULL OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r
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
  IF v_x IS NULL OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking') <> 60
     OR (v_x->>'committed')::numeric <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P13 order cancelled) %', v_x;
  END IF;
  -- The job completes. The engine keeps a completed job's draw at what it actually applied
  -- (none recorded here), so what is still owed is the booking less that kept draw.
  UPDATE jobs SET status = 'in_progress' WHERE job_number = 'SMK-PP13-' || v_suffix;
  UPDATE jobs SET status = 'completed' WHERE job_number = 'SMK-PP13-' || v_suffix;
  v_plan := get_purchasing_plan(12);
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[7];
  IF v_x IS NULL OR (v_x->>'committed')::numeric <> 100 - COALESCE((SELECT SUM(quantity_drawn) FROM job_product_draws
                                                      WHERE quote_id = (SELECT quote_id FROM smk_pp_bookings WHERE tag = 'P13')
                                                        AND product_id = v_p[7]), 0)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'job') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P13 job completed) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P26 (rewritten for the #1989 redesign): the booking's own holds are never read; its lines are the reservation,
  -- Firm (and orders, jobs) first, then Likely, then Maybe.
  SELECT quote_id INTO v_q FROM smk_pp_bookings WHERE tag = 'P26';
  -- a: 100 on hand, a Maybe 100 and an order of 100 today: the order takes the shelf first; Maybe shown; nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[28];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR (v_x->>'committed')::numeric <> 100 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 100 OR (SELECT (c->>'not_covered')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shown') IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26a order before Maybe) %', v_x;
  END IF;
  -- b: nothing on the shelf: the Maybe 100 stays shown, nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[29];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR (v_x->>'could_add')::numeric <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'class' = 'shown'
                     AND (r->>'quantity')::numeric = 100) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26b unbacked hold) %', v_x;
  END IF;
  -- c: 60 on the shelf for the Maybe 100: 60 on time, 40 not covered, nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[30];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shown') IS DISTINCT FROM 60 OR (SELECT (c->>'not_covered')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shown') IS DISTINCT FROM 40 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26c part-covered Maybe) %', v_x;
  END IF;
  -- d: a Firm line beyond the horizon: the order of 100 today takes the shelf; nothing to buy in the horizon.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[31];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR NOT (v_x->'reasons' ? 'later') OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26d later Firm) %', v_x;
  END IF;
  -- e: an undated Firm line is listed under Firm needs a date; nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[32];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'firm_needs_date') f
                     WHERE (f->>'product_id')::uuid = v_p[32] AND (f->>'quantity')::numeric = 50) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26e undated Firm) % %', v_x, v_plan->'firm_needs_date';
  END IF;
  -- f: a manual hold already takes all 30 on hand: the Maybe 20 is shown, not covered.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[33];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') <> 30
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'class' = 'shown'
                     AND (r->>'quantity')::numeric = 20) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26f manual hold first) %', v_x;
  END IF;
  -- g: a hold of 100 beside a Firm line of only 40: the hold is not read; Firm 40 and the order of 60 share the 100.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[35];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26g hold larger than its lines) %', v_x;
  END IF;
  -- h: the active job's hold is not read: the order today takes the shelf, the job's 100 is bought for its date.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[36];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 100 OR (v_x->'suggestions'->0->>'need_date')::date <> v_t + 5 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'job' AND (r->>'quantity')::numeric = 100) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26h job hold) %', v_x;
  END IF;
  -- i: 50 on the shelf for one booking's Firm 50 (+30) and Maybe 50 (+10): Firm first; nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[37];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 50 OR (SELECT (c->>'not_covered')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shown') IS DISTINCT FROM 50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26i Firm before Maybe) %', v_x;
  END IF;
  -- j: a booking line of 0 needs nothing, and its booking's hold is not read: the product is not listed.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[38];
  IF v_x IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P26j zero booking line) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P28 (Taha on #1989; rewritten for the redesign). 39: the draft Planned booking's Firm 500 at +45 with 13 on the
  -- shelf: 13 on time, buy 487 for +45, never today. The booking's hold is not read.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[39];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 487 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'suggestions') g
                 WHERE (g->>'need_date')::date < v_t + 45 OR (g->>'order_now')::boolean)
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 13 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P28 draft booking never buys now) %', v_x;
  END IF;
  -- 40: the draw of 100 takes the less sure Maybe line; the Firm 100 takes the 13 on the shelf; buy the other 87.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[40];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 87 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r
          WHERE r->>'kind' = 'booking' AND r->>'class' = 'committed' AND r->>'confidence' = 'firm') <> 100
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 13
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'confidence' = 'maybe') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P28 draw off the less sure line) %', v_x;
  END IF;
  -- 41: a hold with an infinite expiry is not read: the Firm 50 is bought for its own +45 date.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[41];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 50 OR (v_x->'suggestions'->0->>'need_date')::date <> v_t + 45 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P28 infinite hold expiry) %', v_x;
  END IF;
  -- 42: the draw comes off the Maybe line, so the Firm 100 at +7 is still needed: buy 100, not 0.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[42];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 100
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r
          WHERE r->>'kind' = 'booking' AND r->>'confidence' = 'firm' AND NOT (r->>'estimated')::boolean) <> 100
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'confidence' = 'maybe') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P28 Firm line listed first stays needed) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P29. 43: tied sections, the Maybe line still takes the draw.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[43];
  IF v_x IS NULL
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r
          WHERE r->>'kind' = 'booking' AND r->>'confidence' = 'firm' AND (r->>'raw_date')::date = v_t + 150) <> 100
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'confidence' = 'maybe') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P29 tied sections) %', v_x;
  END IF;
  -- 44: 100 drawn of 150 booked: the Maybe 50 goes first, then 50 of the Firm line (estimated); nothing over-drawn.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[44];
  IF v_x IS NULL OR COALESCE((v_x->>'over_drawn')::numeric, 0) <> 0
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r
          WHERE r->>'kind' = 'booking' AND r->>'confidence' = 'firm' AND (r->>'estimated')::boolean) <> 50
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'confidence' = 'maybe') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P29 draw past a line) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P30 (rewritten for the redesign: Firm always first). 45: the PO's 100 at +10 covers the Firm 100 at +20 on time;
  -- the Maybe 100 (its hold not read) is shown, not covered; nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[45];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR (v_x->>'committed')::numeric <> 100 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 100 OR (SELECT (c->>'not_covered')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shown') IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P30 Firm takes incoming stock first) %', v_x;
  END IF;
  -- 46: the Firm line is needed at +1, before the PO lands at +10: the PO is late cover, flagged, never bought twice.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[46];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR NOT (v_x->>'has_late_cover')::boolean
     OR (SELECT (c->>'late')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 100 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P30 a late PO is cover, not a second buy) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P31: holds and their expiry are not read. Firm 50 at +40 takes the latest PO by its date (+30); the two Maybe 50s
  -- share the +10 PO's 50; nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[47];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 50
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shown') IS DISTINCT FROM 50 OR (SELECT (c->>'not_covered')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shown') IS DISTINCT FROM 50
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'coverage') c, jsonb_array_elements(c->'pos') o
                     WHERE c->>'group' = 'committed' AND o->>'po_number' = 'SMK-PP31-2-' || v_suffix) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P31 Firm takes the latest PO by its date) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P32: the closed booking's hold is shelf-only: it takes the 5 on the shelf, 15 unbacked; the +10 PO of 30 stays free;
  -- nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[48];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR (v_x->>'committed')::numeric <> 0
     OR (SELECT COALESCE(SUM((r->>'quantity')::numeric), 0) FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') <> 20 OR (v_x->>'hold_unbacked')::numeric <> 15 OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'shelf_hold') IS DISTINCT FROM 5
     OR (v_x->>'incoming')::numeric <> 30 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P32 a closed booking''s hold reserves the shelf only) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P33: the active job's hold is not read; its unconvertible line is under Check units and reserves nothing (contract
  -- known limit). The other job's 10 at +3 takes the 10 on the shelf; nothing to buy.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[49];
  IF v_x IS NULL OR (v_x->>'suggested')::numeric <> 0 OR NOT (v_x->'reasons' ? 'check_units') OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold')
     OR (SELECT (c->>'on_time')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P33 a job hold on an unconvertible line is not read) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- P34: 35 drawn against Gal 30 + set-aside lb 10 is not over-drawn; the lb line is under Check units.
  SELECT e INTO v_x FROM jsonb_array_elements(v_plan->'products') e WHERE (e->>'product_id')::uuid = v_p[50];
  IF v_x IS NULL OR (v_x->'reasons' ? 'over_drawn') OR (v_x->>'over_drawn')::numeric <> 0 OR NOT (v_x->'reasons' ? 'check_units') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P34 a draw against a set-aside line is not over-drawn) %', v_x;
  END IF;
  -- P35: the job draws 12 from its 5 section; the 7 beyond it is listed as drawn, section unknown.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'drawn_section_unknown') d
                  WHERE (d->>'product_id')::uuid = v_p[51] AND (d->>'quantity')::numeric = 7) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P35 a job draw beyond its section is listed) %', v_plan->'drawn_section_unknown';
  END IF;
  v_n := v_n + 1;

  -- P27 (20270206130000, #1977 MEDs): the P26 window section (pre_plant, needed Dec 31 this year).
  -- A window crossing New Year (start 12-31, end today) ends next year, so it is not yet on the review list
  -- (the old rule ended it today). Skipped on Dec 31 (the window then does not cross) and Feb 29 (not a month-day).
  SELECT (section_ids->>'_d')::uuid INTO v_s1 FROM smk_pp_bookings WHERE tag = 'P26';
  IF to_char(v_t, 'MM-DD') NOT IN ('12-31', '02-29') THEN
    UPDATE app_settings SET setting_value = jsonb_set(setting_value::jsonb, '{pre_plant}',
        jsonb_build_object('start', '12-31', 'end', to_char(v_t, 'MM-DD')))::text
     WHERE setting_key = 'booking_timing_windows';
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(get_purchasing_plan(12)->'review') r WHERE (r->>'section_id')::uuid = v_s1) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (P27 window crossing New Year) %', get_purchasing_plan(12)->'review';
    END IF;
  END IF;
  -- An invalid start month-day: the whole window falls back to the default (end 05-15), not the configured end.
  IF to_char(v_t, 'MM-DD') NOT IN ('05-15', '02-29') THEN
    UPDATE app_settings SET setting_value = jsonb_set(setting_value::jsonb, '{pre_plant}',
        jsonb_build_object('start', '02-30', 'end', to_char(v_t, 'MM-DD')))::text
     WHERE setting_key = 'booking_timing_windows';
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(get_purchasing_plan(12)->'review') r
                WHERE (r->>'section_id')::uuid = v_s1 AND (r->>'window_end')::date <> make_date(extract(year FROM v_t)::int, 5, 15)) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (P27 invalid start) %', get_purchasing_plan(12)->'review';
    END IF;
  END IF;
  -- Extreme finite needed-by dates under a window crossing New Year: the plan still answers (Sol, #1980 r1).
  UPDATE app_settings SET setting_value = jsonb_set(setting_value::jsonb, '{pre_plant}',
      jsonb_build_object('start', '11-01', 'end', '02-15'))::text
   WHERE setting_key = 'booking_timing_windows';
  FOREACH v_d IN ARRAY ARRAY['0001-12-31 BC'::date, '5874897-12-31'::date] LOOP
    UPDATE quote_sections SET needed_by_date = v_d WHERE id = v_s1;
    v_err := NULL;
    BEGIN
      PERFORM get_purchasing_plan(12);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NOT NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (P27 extreme date %) %', v_d, v_err;
    END IF;
  END LOOP;
  UPDATE quote_sections SET needed_by_date = make_date(extract(year FROM v_t)::int, 12, 31) WHERE id = v_s1;
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
