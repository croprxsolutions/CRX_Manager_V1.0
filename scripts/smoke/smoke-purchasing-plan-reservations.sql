-- ============================================================================
-- ROLLED-BACK smoke: booking reservations in the Purchasing buy plan (#1989 redesign)
-- ----------------------------------------------------------------------------
-- REQUIRES 20270207140000_purchasing_plan_booking_reservations. Proof cases C1-C19 of
-- docs/plans/2026-11-21-booking-reservations-CONTRACT.md (v4, per-product build), against
-- get_purchasing_plan(12). Dates are relative to today (Chicago) so the chain never ages. One product per case.
-- Each product's 'coverage' lists its demand groups (shelf_hold, deficit, committed, could_add, shown) with
-- booked = on_time + late + not_covered, and the POs each group took.
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so nothing persists. Any other error is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_t date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_p uuid[] := ARRAY[]::uuid[];
  v_pid uuid;
  v_i int;
  v_q uuid;
  v_q2 uuid;
  v_plan jsonb;
  v_plan2 jsonb;
  v_x jsonb;
  v_n int := 0;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Reservations Farm ' || v_suffix) RETURNING id INTO v_customer;
  FOR v_i IN 1..30 LOOP
    INSERT INTO products (product_name, unit_size, inventory_unit, product_form)
    VALUES ('[SMOKE] Reservations ' || lpad(v_i::text, 2, '0') || ' ' || v_suffix, 'Gal', 'Gal', 'liquid')
    RETURNING id INTO v_pid;
    v_p := v_p || v_pid;
  END LOOP;
  -- Every product is inserted before any is priced (pricing sets a transaction-wide mode).
  FOR v_i IN 1..30 LOOP
    v_x := preview_product_pricing_changes('product_page', NULL,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_p[v_i], 'row_version', (SELECT pricing_version FROM products WHERE id = v_p[v_i]),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke reservations fixture setup')),
      v_admin, 'smk-rs-price-preview-' || v_i || '-' || v_suffix);
    PERFORM apply_product_pricing_change_set((v_x->>'change_set_id')::uuid, v_x->>'request_fingerprint',
      v_admin, 'smk-rs-price-apply-' || v_i || '-' || v_suffix);
  END LOOP;

  -- Helpers (session-temporary, dropped with the rollback).
  -- A booking of one product: one section per (qty, need date offset, confidence); status as given.
  CREATE FUNCTION pg_temp.bk(p_product uuid, p_customer uuid, p_admin uuid, p_tag text, p_status text, p_lines jsonb)
  RETURNS uuid LANGUAGE plpgsql AS $f$
  DECLARE v_sec jsonb := '[]'::jsonb; v_l jsonb; v_i int := 0; v_res jsonb; v_q uuid;
  BEGIN
    FOR v_l IN SELECT e FROM jsonb_array_elements(p_lines) e LOOP
      v_i := v_i + 1;
      v_sec := v_sec || jsonb_build_array(jsonb_build_object('client_key', '_s' || v_i, 'section_name', p_tag || ' ' || v_i,
        'sort_order', v_i, 'needed_by_date', CASE WHEN v_l ? 'd' THEN (now() AT TIME ZONE 'America/Chicago')::date + (v_l->>'d')::int END,
        'confidence', v_l->>'c',
        'items', jsonb_build_array(jsonb_build_object('client_key', '_k' || v_i, 'product_id', p_product, 'sort_order', 0,
          'calc_mode', 'units_direct', 'total_units_needed', (v_l->>'q')::numeric, 'price_override', 20, 'price_per_unit', 20,
          'current_cost', 6, 'unit_size', 'Gal', 'acres', 0))));
    END LOOP;
    v_res := save_quote(NULL, jsonb_build_object('quote_number', '[SMOKE] RS-' || p_tag || '-' || substr(md5(random()::text), 1, 8),
        'customer_id', p_customer, 'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb,
        'section_ids_v1', true),
      v_sec, p_admin, 'smk-rs-' || p_tag || '-' || substr(md5(random()::text), 1, 8));
    v_q := (v_res->>'quote_id')::uuid;
    -- The plan reads every line's own date and confidence, never a booking's holds: start each with none.
    DELETE FROM inventory_holds WHERE source_id = v_q;
    IF p_status = 'planned_draft' THEN UPDATE quotes SET is_planned = true WHERE id = v_q;
    ELSIF p_status <> 'draft' THEN
      -- A sent quote needs its sent version.
      PERFORM create_quote_version(v_q, p_admin, 'presented', 'smk-rs-ver-' || v_q, (SELECT row_version FROM quotes WHERE id = v_q));
      UPDATE quotes SET status = 'sent' WHERE id = v_q;
      IF p_status <> 'sent' THEN UPDATE quotes SET status = p_status WHERE id = v_q; END IF;
    END IF;
    RETURN v_q;
  END $f$;
  CREATE FUNCTION pg_temp.po(p_product uuid, p_admin uuid, p_number text, p_qty numeric, p_days int)
  RETURNS void LANGUAGE plpgsql AS $f$
  DECLARE v_po uuid;
  BEGIN
    INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
    VALUES (p_number, '[SMOKE] Vendor', 'submitted',
            CASE WHEN p_days IS NOT NULL THEN (now() AT TIME ZONE 'America/Chicago')::date + p_days END, p_admin)
    RETURNING id INTO v_po;
    INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
    VALUES (v_po, p_product, p_qty, 0, 6, 'Gal');
  END $f$;
  CREATE FUNCTION pg_temp.ord(p_product uuid, p_customer uuid, p_admin uuid, p_number text, p_qty numeric)
  RETURNS void LANGUAGE plpgsql AS $f$
  DECLARE v_order uuid;
  BEGIN
    INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
    VALUES (p_number, p_customer, (now() AT TIME ZONE 'America/Chicago')::date, 'confirmed', p_admin) RETURNING id INTO v_order;
    PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
      total_units_needed, total_price, quantity_delivered, quantity_remaining)
    VALUES (v_order, p_product, '[SMOKE] RS', 'Gal', 20, 6, p_qty, p_qty * 20, 0, p_qty);
    PERFORM set_config('app.crx_below_cost_operation', '', true);
  END $f$;
  CREATE FUNCTION pg_temp.shelf(p_product uuid, p_qty numeric) RETURNS void LANGUAGE sql AS $f$
    INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
    VALUES (p_product, 'Main Warehouse', p_qty, 0, 0)
    ON CONFLICT (product_id, location) DO UPDATE SET quantity_available = EXCLUDED.quantity_available;
  $f$;
  CREATE FUNCTION pg_temp.prod(p_plan jsonb, p_product uuid) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT e FROM jsonb_array_elements(p_plan->'products') e WHERE (e->>'product_id')::uuid = p_product;
  $f$;
  -- One group's numbers as 'booked/on_time/late/not_covered' (absent group: '-').
  CREATE FUNCTION pg_temp.g(p_prod jsonb, p_group text) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE((SELECT trim_scale((c->>'booked')::numeric)::text || '/' || trim_scale((c->>'on_time')::numeric)::text || '/'
                            || trim_scale((c->>'late')::numeric)::text || '/' || trim_scale((c->>'not_covered')::numeric)::text
                       FROM jsonb_array_elements(p_prod->'coverage') c WHERE c->>'group' = p_group), '-');
  $f$;
  CREATE FUNCTION pg_temp.pos(p_prod jsonb, p_group text) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(string_agg(split_part(p->>'po_number', '-', 2) || ':' || trim_scale((p->>'qty')::numeric)::text
                               || CASE WHEN (p->>'late')::boolean THEN 'L' ELSE '' END
                               || CASE WHEN (p->>'po_undated')::boolean THEN 'U' ELSE '' END, ',' ORDER BY ord), '')
      FROM jsonb_array_elements(p_prod->'coverage') c, jsonb_array_elements(c->'pos') WITH ORDINALITY x(p, ord)
     WHERE c->>'group' = p_group;
  $f$;

  -- ------------------------------------------------------------------ fixtures
  -- C1: Firm 100 at +20, shelf 40, PO 60 at +7.        C2: the same with the PO at +30.
  PERFORM pg_temp.shelf(v_p[1], 40); PERFORM pg_temp.bk(v_p[1], v_customer, v_admin, 'C1', 'sent', '[{"q":100,"d":20,"c":"firm"}]');
  PERFORM pg_temp.po(v_p[1], v_admin, 'SMKRS-C1A-' || v_suffix, 60, 7);
  PERFORM pg_temp.shelf(v_p[2], 40); PERFORM pg_temp.bk(v_p[2], v_customer, v_admin, 'C2', 'sent', '[{"q":100,"d":20,"c":"firm"}]');
  PERFORM pg_temp.po(v_p[2], v_admin, 'SMKRS-C2A-' || v_suffix, 60, 30);
  -- C3: shelf 100, a Maybe booking of 100 at +10 (created first), an order of 100 today.
  PERFORM pg_temp.shelf(v_p[3], 100); PERFORM pg_temp.bk(v_p[3], v_customer, v_admin, 'C3', 'sent', '[{"q":100,"d":10,"c":"maybe"}]');
  PERFORM pg_temp.ord(v_p[3], v_customer, v_admin, 'SMKRS-C3-' || v_suffix, 100);
  -- C4: Firm A 100 at +30, Maybe B 100 at +10, shelf 100, PO 100 at +20.
  PERFORM pg_temp.shelf(v_p[4], 100);
  PERFORM pg_temp.bk(v_p[4], v_customer, v_admin, 'C4A', 'sent', '[{"q":100,"d":30,"c":"firm"}]');
  PERFORM pg_temp.bk(v_p[4], v_customer, v_admin, 'C4B', 'sent', '[{"q":100,"d":10,"c":"maybe"}]');
  PERFORM pg_temp.po(v_p[4], v_admin, 'SMKRS-C4A-' || v_suffix, 100, 20);
  -- C5: shelf 0, a PO cut to 40 at +10, Firm X 60 at +20, Maybe Y 40 at +15.
  PERFORM pg_temp.bk(v_p[5], v_customer, v_admin, 'C5X', 'sent', '[{"q":60,"d":20,"c":"firm"}]');
  PERFORM pg_temp.bk(v_p[5], v_customer, v_admin, 'C5Y', 'sent', '[{"q":40,"d":15,"c":"maybe"}]');
  PERFORM pg_temp.po(v_p[5], v_admin, 'SMKRS-C5A-' || v_suffix, 40, 10);
  -- C6: one booking, Firm 40 at +30 and Maybe 60 at +90; shelf 40, PO 60 at +60.
  PERFORM pg_temp.shelf(v_p[6], 40);
  PERFORM pg_temp.bk(v_p[6], v_customer, v_admin, 'C6', 'sent', '[{"q":40,"d":30,"c":"firm"},{"q":60,"d":90,"c":"maybe"}]');
  PERFORM pg_temp.po(v_p[6], v_admin, 'SMKRS-C6A-' || v_suffix, 60, 60);
  -- C7: Firm 10 at +1 and Firm 10 at +9, PO 10 at +5.
  PERFORM pg_temp.bk(v_p[7], v_customer, v_admin, 'C7', 'sent', '[{"q":10,"d":1,"c":"firm"},{"q":10,"d":9,"c":"firm"}]');
  PERFORM pg_temp.po(v_p[7], v_admin, 'SMKRS-C7A-' || v_suffix, 10, 5);
  -- C8: shelf -5 alone (product 8); shelf -5 with a PO of 5 today and an order of 5 today (product 9).
  PERFORM pg_temp.shelf(v_p[8], -5);
  PERFORM pg_temp.shelf(v_p[9], -5); PERFORM pg_temp.po(v_p[9], v_admin, 'SMKRS-C8A-' || v_suffix, 5, 0);
  PERFORM pg_temp.ord(v_p[9], v_customer, v_admin, 'SMKRS-C8-' || v_suffix, 5);
  -- C9: a Firm line of 10.5 at +10; shelf 2, PO 3 at +1, PO 4 at +60.
  PERFORM pg_temp.shelf(v_p[10], 2); PERFORM pg_temp.bk(v_p[10], v_customer, v_admin, 'C9', 'sent', '[{"q":10.5,"d":10,"c":"firm"}]');
  PERFORM pg_temp.po(v_p[10], v_admin, 'SMKRS-C9A-' || v_suffix, 3, 1);
  PERFORM pg_temp.po(v_p[10], v_admin, 'SMKRS-C9B-' || v_suffix, 4, 60);
  -- C10: a Firm line needed 20 days ago (product 11) and one needed 13 days ago (product 12), shelf 20 each.
  PERFORM pg_temp.shelf(v_p[11], 20); PERFORM pg_temp.shelf(v_p[12], 20);
  v_q := pg_temp.bk(v_p[11], v_customer, v_admin, 'C10A', 'sent', '[{"q":20,"d":1,"c":"firm"}]');
  UPDATE quote_sections SET needed_by_date = v_t - 20 WHERE quote_id = v_q;
  v_q := pg_temp.bk(v_p[12], v_customer, v_admin, 'C10B', 'sent', '[{"q":20,"d":1,"c":"firm"}]');
  UPDATE quote_sections SET needed_by_date = v_t - 13 WHERE quote_id = v_q;
  -- C11: a draft Planned booking, Maybe 500 at +30, with its own active crop hold of 500; shelf 13; an order of 13 today.
  PERFORM pg_temp.shelf(v_p[13], 13);
  v_q := pg_temp.bk(v_p[13], v_customer, v_admin, 'C11', 'planned_draft', '[{"q":500,"d":30,"c":"maybe"}]');
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[13], v_customer, 500, 'crop_program', v_q, v_admin, true, v_t + 44);
  PERFORM pg_temp.ord(v_p[13], v_customer, v_admin, 'SMKRS-C11-' || v_suffix, 13);
  -- C11 (soft-deleted): a draft Planned Firm 500 at +30 with its hold of 500, then soft-deleted (product 20).
  v_q := pg_temp.bk(v_p[20], v_customer, v_admin, 'C11D', 'planned_draft', '[{"q":500,"d":30,"c":"firm"}]');
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[20], v_customer, 500, 'crop_program', v_q, v_admin, true, v_t + 44);
  UPDATE quotes SET deleted_at = now() WHERE id = v_q;
  -- C12: a closed booking's active hold of 10; shelf 0; PO 20 today (product 14).
  v_q2 := pg_temp.bk(v_p[14], v_customer, v_admin, 'C12', 'closed_short', '[{"q":10,"d":30,"c":"firm"}]');
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[14], v_customer, 10, 'crop_program', v_q2, v_admin, true, v_t + 44);
  PERFORM pg_temp.po(v_p[14], v_admin, 'SMKRS-C12A-' || v_suffix, 20, 0);
  -- C13: two shelf-only holds of 10 (a closed booking's, created 2 and 1 days ago), an order of 10 today, shelf 10.
  PERFORM pg_temp.shelf(v_p[15], 10);
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at, created_at)
  VALUES (v_p[15], v_customer, 10, 'crop_program', v_q2, v_admin, true, v_t + 44, now() - interval '2 days'),
         (v_p[15], v_customer, 10, 'crop_program', v_q2, v_admin, true, v_t + 44, now() - interval '1 day');
  PERFORM pg_temp.ord(v_p[15], v_customer, v_admin, 'SMKRS-C13-' || v_suffix, 10);
  -- C14: a Firm 10 on the 1-month horizon's last day, its PO of 10 the next day.
  PERFORM pg_temp.bk(v_p[16], v_customer, v_admin, 'C14', 'sent',
    jsonb_build_array(jsonb_build_object('q', 10, 'c', 'firm',
      'd', ((date_trunc('month', v_t) + interval '1 month' - interval '1 day')::date - v_t))));
  PERFORM pg_temp.po(v_p[16], v_admin, 'SMKRS-C14A-' || v_suffix, 10,
    ((date_trunc('month', v_t) + interval '1 month')::date - v_t));
  -- C17: a draft Planned Maybe holding 10, shelf 10, an order of 10 today.
  PERFORM pg_temp.shelf(v_p[17], 10);
  v_q := pg_temp.bk(v_p[17], v_customer, v_admin, 'C17', 'planned_draft', '[{"q":10,"d":30,"c":"maybe"}]');
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[17], v_customer, 10, 'crop_program', v_q, v_admin, true, v_t + 44);
  PERFORM pg_temp.ord(v_p[17], v_customer, v_admin, 'SMKRS-C17-' || v_suffix, 10);
  -- C18: shelf 10, POs 100 and 101 of 10 each today, a Firm 10 today.
  PERFORM pg_temp.shelf(v_p[18], 10);
  PERFORM pg_temp.po(v_p[18], v_admin, 'SMKRS-C18A100-' || v_suffix, 10, 0);
  PERFORM pg_temp.po(v_p[18], v_admin, 'SMKRS-C18B101-' || v_suffix, 10, 0);
  PERFORM pg_temp.bk(v_p[18], v_customer, v_admin, 'C18', 'sent', '[{"q":10,"d":0,"c":"firm"}]');
  -- C19: an order of 10 today whose only supply is an undated PO of 10.
  PERFORM pg_temp.po(v_p[19], v_admin, 'SMKRS-C19A-' || v_suffix, 10, NULL);
  PERFORM pg_temp.ord(v_p[19], v_customer, v_admin, 'SMKRS-C19-' || v_suffix, 10);

  -- ------------------------------------------------------------------ the plan
  v_plan := get_purchasing_plan(12);

  v_x := pg_temp.prod(v_plan, v_p[1]);
  IF pg_temp.g(v_x, 'committed') <> '100/100/0/0' OR (v_x->>'suggested')::numeric <> 0 OR pg_temp.pos(v_x, 'committed') <> 'C1A:60'
     OR (v_x->>'has_late_cover')::boolean THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C1 shelf and an on-time PO cover Firm) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[2]);
  IF pg_temp.g(v_x, 'committed') <> '100/40/60/0' OR (v_x->>'suggested')::numeric <> 0 OR pg_temp.pos(v_x, 'committed') <> 'C2A:60L'
     OR NOT (v_x->>'has_late_cover')::boolean OR jsonb_array_length(v_x->'suggestions') <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C2 a late PO is cover, never a second buy) %', v_x;
  END IF;
  v_n := v_n + 2;

  v_x := pg_temp.prod(v_plan, v_p[3]);
  IF pg_temp.g(v_x, 'committed') <> '100/100/0/0' OR pg_temp.g(v_x, 'shown') <> '100/0/0/100' OR (v_x->>'suggested')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C3 an order beats an earlier Maybe) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[4]);
  IF pg_temp.g(v_x, 'committed') <> '100/100/0/0' OR pg_temp.pos(v_x, 'committed') <> 'C4A:100'
     OR pg_temp.g(v_x, 'shown') <> '100/100/0/0' OR pg_temp.pos(v_x, 'shown') <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C4 Firm takes the latest on-time supply, Maybe the shelf) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[5]);
  IF pg_temp.g(v_x, 'committed') <> '60/40/0/20' OR pg_temp.g(v_x, 'shown') <> '40/0/0/40' OR (v_x->>'suggested')::numeric <> 20 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C5 a cut PO goes to Firm first) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[6]);
  IF pg_temp.g(v_x, 'committed') <> '40/40/0/0' OR pg_temp.pos(v_x, 'committed') <> ''
     OR pg_temp.g(v_x, 'shown') <> '60/60/0/0' OR pg_temp.pos(v_x, 'shown') <> 'C6A:60' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C6 each line claims on its own) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[7]);
  IF pg_temp.g(v_x, 'committed') <> '20/0/10/10' OR jsonb_array_length(v_x->'suggestions') <> 1
     OR (v_x->'suggestions'->0->>'need_date')::date <> v_t + 9 OR (v_x->'suggestions'->0->>'quantity')::numeric <> 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C7 the earlier need takes the PO late; the later one is bought) %', v_x;
  END IF;
  v_n := v_n + 5;

  v_x := pg_temp.prod(v_plan, v_p[8]);
  IF pg_temp.g(v_x, 'deficit') <> '5/0/0/5' OR (v_x->>'suggested')::numeric <> 5
     OR (v_x->'suggestions'->0->>'need_date')::date <> v_t OR NOT (v_x->'suggestions'->0->>'order_now')::boolean THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C8 a stock deficit is bought) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[9]);
  IF pg_temp.g(v_x, 'deficit') <> '5/5/0/0' OR pg_temp.g(v_x, 'committed') <> '5/0/0/5' OR (v_x->>'suggested')::numeric <> 5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C8 the deficit takes the PO before an order) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[10]);
  IF pg_temp.g(v_x, 'committed') <> '10.5/5/4/1.5' OR (v_x->>'suggested')::numeric <> 1.5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C9 a partial line: on time, late and not covered) %', v_x;
  END IF;
  v_n := v_n + 2;

  -- C10: the follow-up flag from 14 days past the need date; the line keeps its cover.
  v_x := pg_temp.prod(v_plan, v_p[11]);
  IF NOT (v_x->>'has_followup')::boolean OR NOT (v_x->'rows'->0->>'overdue_followup')::boolean
     OR pg_temp.g(v_x, 'committed') <> '20/20/0/0' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C10 overdue 20 days: follow up) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[12]);
  IF (v_x->>'has_followup')::boolean OR (v_x->'rows'->0->>'overdue_followup')::boolean OR pg_temp.g(v_x, 'committed') <> '20/20/0/0' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C10 overdue 13 days: no follow-up yet) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- C11: a draft Planned Maybe of 500 with its own hold of 500 is shown, not bought, and its hold is never read.
  v_x := pg_temp.prod(v_plan, v_p[13]);
  IF pg_temp.g(v_x, 'committed') <> '13/13/0/0' OR pg_temp.g(v_x, 'shown') <> '500/0/0/500' OR (v_x->>'suggested')::numeric <> 0
     OR pg_temp.g(v_x, 'shelf_hold') <> '-' OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'hold') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C11 draft Planned Maybe) %', v_x;
  END IF;
  -- C12: a closed booking's hold takes the shelf only (none here): no PO, no buy.
  v_x := pg_temp.prod(v_plan, v_p[14]);
  IF pg_temp.g(v_x, 'shelf_hold') <> '10/0/0/10' OR pg_temp.pos(v_x, 'shelf_hold') <> '' OR (v_x->>'hold_unbacked')::numeric <> 10
     OR (v_x->>'suggested')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C12 a stale hold never takes a PO) %', v_x;
  END IF;
  -- C13: the older shelf-only hold takes the shelf; the order is bought.
  v_x := pg_temp.prod(v_plan, v_p[15]);
  IF pg_temp.g(v_x, 'shelf_hold') <> '20/10/0/10' OR (v_x->>'hold_unbacked')::numeric <> 10
     OR pg_temp.g(v_x, 'committed') <> '10/0/0/10' OR (v_x->>'suggested')::numeric <> 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C13 shelf-only holds take the shelf first) %', v_x;
  END IF;
  v_n := v_n + 3;

  -- C14: the horizon never changes the allocation.
  v_x := pg_temp.prod(v_plan, v_p[16]);
  v_plan2 := get_purchasing_plan(1);
  IF pg_temp.g(v_x, 'committed') <> '10/0/10/0' OR pg_temp.g(pg_temp.prod(v_plan2, v_p[16]), 'committed') <> '10/0/10/0'
     OR (v_x->>'suggested')::numeric <> 0 OR (pg_temp.prod(v_plan2, v_p[16])->>'suggested')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C14 the same late cover under 1 and 12 months) % %', v_x, pg_temp.prod(v_plan2, v_p[16]);
  END IF;
  v_n := v_n + 1;

  v_x := pg_temp.prod(v_plan, v_p[17]);
  IF (v_x->>'suggested')::numeric <> 0 OR pg_temp.g(v_x, 'committed') <> '10/10/0/0' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C17 a draft Maybe holding stock) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[18]);
  IF pg_temp.g(v_x, 'committed') <> '10/10/0/0' OR pg_temp.pos(v_x, 'committed') <> ''
     OR (SELECT (c->>'from_shelf')::numeric FROM jsonb_array_elements(v_x->'coverage') c WHERE c->>'group' = 'committed') <> 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C18 the shelf beats a PO arriving today) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan, v_p[19]);
  IF pg_temp.g(v_x, 'committed') <> '10/0/10/0' OR pg_temp.pos(v_x, 'committed') <> 'C19A:10LU' OR (v_x->>'suggested')::numeric <> 0
     OR (v_x->>'incoming')::numeric <> 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C19 an undated PO is late cover) %', v_x;
  END IF;
  v_n := v_n + 3;

  -- C15: conservation over every product in the plan, and the same JSON after the rows move on disk.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'products') pr, jsonb_array_elements(pr->'coverage') c
              WHERE (c->>'on_time')::numeric + (c->>'late')::numeric + (c->>'not_covered')::numeric <> (c->>'booked')::numeric
                 OR (c->>'group' = 'shelf_hold' AND jsonb_array_length(c->'pos') > 0)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C15 on time + late + not covered = booked; no PO for shelf-only holds)';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT pr->>'product_id' AS product_id, p->>'po_id' AS po_id, SUM((p->>'qty')::numeric) AS awarded
                              FROM jsonb_array_elements(v_plan->'products') pr, jsonb_array_elements(pr->'coverage') c,
                                   jsonb_array_elements(c->'pos') p GROUP BY 1, 2) a
              WHERE a.awarded > (SELECT SUM(poi.quantity_ordered - COALESCE(poi.quantity_received, 0)) FROM purchase_order_items poi
                                  WHERE poi.purchase_order_id = a.po_id::uuid AND poi.product_id = a.product_id::uuid)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C15 a PO awarded more than it brings)';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'products') pr
              WHERE COALESCE((SELECT SUM((c->>'from_shelf')::numeric) FROM jsonb_array_elements(pr->'coverage') c), 0)
                    > GREATEST((pr->>'on_hand')::numeric, 0)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C15 the shelf awarded more than is on hand)';
  END IF;
  -- Each supply entry (one per PO line) gives at most its own quantity: two lines of 5 on one PO, a need of 12.
  v_x := _purchasing_allocate('[{"d":"2030-01-01","q":5,"shelf":false},{"d":"2030-01-01","q":5,"shelf":false}]'::jsonb,
                              '[{"r":3,"d":"2030-01-02","q":12}]'::jsonb);
  IF (v_x->0->>'on_time')::numeric <> 10 OR (v_x->0->>'nc')::numeric <> 2
     OR (SELECT array_agg((a->>'k')::int || ':' || (a->>'q')::numeric ORDER BY (a->>'k')::int) FROM jsonb_array_elements(v_x->0->'aw') a)
        IS DISTINCT FROM ARRAY['1:5', '2:5'] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C15 a PO line awarded more than it brings) %', v_x;
  END IF;
  -- SQL has no input order but the order rows are read in: rewrite every source row (each moves to a new place
  -- on disk), then the plan must be byte-identical; the plan itself orders by ids, never by read order.
  UPDATE purchase_order_items SET quantity_ordered = quantity_ordered WHERE product_id = ANY (v_p);
  UPDATE inventory_holds SET quantity = quantity WHERE product_id = ANY (v_p);
  UPDATE order_items SET quantity_remaining = quantity_remaining WHERE product_id = ANY (v_p);
  UPDATE inventory SET quantity_available = quantity_available WHERE product_id = ANY (v_p);
  IF get_purchasing_plan(12) IS DISTINCT FROM v_plan THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C15 the plan changed when its rows moved on disk)';
  END IF;
  v_n := v_n + 1;

  -- ------------------------------------------------------------------ transitions
  -- C11 continued: sent, then the hold's expiry passed while the booking stays open: unchanged.
  v_q := (SELECT source_id FROM inventory_holds WHERE product_id = v_p[13] LIMIT 1);
  PERFORM create_quote_version(v_q, v_admin, 'presented', 'smk-rs-ver-c11-' || v_suffix, (SELECT row_version FROM quotes WHERE id = v_q));
  UPDATE quotes SET status = 'sent' WHERE id = v_q;
  IF pg_temp.g(pg_temp.prod(get_purchasing_plan(12), v_p[13]), 'shown') <> '500/0/0/500' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C11 sent) %', pg_temp.prod(get_purchasing_plan(12), v_p[13]);
  END IF;
  UPDATE inventory_holds SET expires_at = v_t - 1 WHERE source_id = v_q;
  v_x := pg_temp.prod(get_purchasing_plan(12), v_p[13]);
  IF pg_temp.g(v_x, 'shown') <> '500/0/0/500' OR (v_x->>'suggested')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C11 hold expired, booking open) %', v_x;
  END IF;
  -- As Likely: could add 500. As Firm: buy 500 at +30.
  UPDATE quote_sections SET confidence = 'likely' WHERE quote_id = v_q;
  v_x := pg_temp.prod(get_purchasing_plan(12), v_p[13]);
  IF (v_x->>'could_add')::numeric <> 500 OR (v_x->>'suggested')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C11 as Likely) %', v_x;
  END IF;
  UPDATE quote_sections SET confidence = 'firm' WHERE quote_id = v_q;
  v_x := pg_temp.prod(get_purchasing_plan(12), v_p[13]);
  IF (v_x->>'suggested')::numeric <> 500 OR (v_x->'suggestions'->0->>'need_date')::date <> v_t + 30 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C11 as Firm) %', v_x;
  END IF;
  -- A soft-deleted draft Planned booking (product 20, its hold of 500 kept active) gives nothing to buy.
  v_x := pg_temp.prod(v_plan, v_p[20]);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking') OR (v_x->>'suggested')::numeric <> 0
     OR pg_temp.g(v_x, 'committed') <> '-' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C11 soft-deleted draft) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- C12 continued: with 10 on the shelf and an order of 10 today, the hold takes the shelf and the order the PO.
  PERFORM pg_temp.shelf(v_p[14], 10);
  PERFORM pg_temp.ord(v_p[14], v_customer, v_admin, 'SMKRS-C12-' || v_suffix, 10);
  v_x := pg_temp.prod(get_purchasing_plan(12), v_p[14]);
  IF pg_temp.g(v_x, 'shelf_hold') <> '10/10/0/0' OR pg_temp.g(v_x, 'committed') <> '10/10/0/0'
     OR pg_temp.pos(v_x, 'committed') <> 'C12A:10' OR (v_x->>'suggested')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C12 a stale hold on the shelf, the order on the PO) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- C17 continued: the draft is cancelled (a draft's only close) with its hold left active: the hold becomes shelf-only and the order is bought.
  v_q := (SELECT source_id FROM inventory_holds WHERE product_id = v_p[17] LIMIT 1);
  UPDATE quotes SET status = 'cancelled' WHERE id = v_q;
  -- Cancelling releases the hold; a hold left behind (e.g. a release that failed) is put back.
  UPDATE inventory_holds SET is_active = true, expires_at = v_t + 44 WHERE source_id = v_q AND product_id = v_p[17];
  v_x := pg_temp.prod(get_purchasing_plan(12), v_p[17]);
  IF (v_x->>'suggested')::numeric <> 10 OR pg_temp.g(v_x, 'shelf_hold') <> '10/10/0/0' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C17 closed draft, hold still active) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- An undated Firm line saved in a unit that does not match stock: listed under both Check units and Firm needs
  -- a date, with no need date on its row (product 13, the C11 booking now Firm).
  v_q := (SELECT source_id FROM inventory_holds WHERE product_id = v_p[13] LIMIT 1);
  UPDATE quote_items SET unit_size = 'lb' WHERE quote_id = v_q AND product_id = v_p[13];
  UPDATE quote_sections SET needed_by_date = NULL WHERE quote_id = v_q;
  v_plan2 := get_purchasing_plan(12);
  v_x := pg_temp.prod(v_plan2, v_p[13]);
  IF NOT (v_x->'reasons' ? 'check_units') OR (v_x->>'suggested')::numeric <> 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r
                     WHERE r->>'bucket' = 'check_units' AND r->>'need_date' IS NULL AND (r->>'quantity')::numeric = 500)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'firm_needs_date') f
                     WHERE (f->>'product_id')::uuid = v_p[13] AND (f->>'quantity')::numeric = 500) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C20 undated Firm line in another unit) % %', v_x, v_plan2->'firm_needs_date';
  END IF;
  v_n := v_n + 1;

  -- C21: values PostgreSQL stores but that are not real stock never count as cover. Product 7 has 10 to buy (C7).
  -- Added: a NaN shelf balance, open POs dated infinity and -infinity, and a PO line whose remaining quantity is NaN.
  -- Coverage, buying and months are unchanged.
  v_x := pg_temp.prod(get_purchasing_plan(12), v_p[7]);
  PERFORM pg_temp.shelf(v_p[7], 'NaN');
  PERFORM pg_temp.po(v_p[7], v_admin, 'SMKRS-C21B-' || v_suffix, 10, 0);
  UPDATE purchase_orders SET expected_delivery_date = 'infinity' WHERE po_number = 'SMKRS-C21B-' || v_suffix;
  PERFORM pg_temp.po(v_p[7], v_admin, 'SMKRS-C21C-' || v_suffix, 10, 0);
  UPDATE purchase_orders SET expected_delivery_date = '-infinity' WHERE po_number = 'SMKRS-C21C-' || v_suffix;
  PERFORM pg_temp.po(v_p[7], v_admin, 'SMKRS-C21D-' || v_suffix, 10, 2);
  UPDATE purchase_order_items SET quantity_ordered = 'NaN'
   WHERE purchase_order_id = (SELECT id FROM purchase_orders WHERE po_number = 'SMKRS-C21D-' || v_suffix);
  v_plan2 := get_purchasing_plan(12);
  IF pg_temp.prod(v_plan2, v_p[7]) IS NULL
     OR pg_temp.prod(v_plan2, v_p[7])->'coverage' IS DISTINCT FROM v_x->'coverage'
     OR pg_temp.prod(v_plan2, v_p[7])->'suggestions' IS DISTINCT FROM v_x->'suggestions'
     OR pg_temp.prod(v_plan2, v_p[7])->'months' IS DISTINCT FROM v_x->'months'
     OR (pg_temp.prod(v_plan2, v_p[7])->>'suggested')::numeric <> 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C21 non-finite stock, PO dates and PO quantities are not cover) % %', v_x, pg_temp.prod(v_plan2, v_p[7]);
  END IF;
  -- A PO dated in year 300000 is an impossible date (outside 2000-2099): the plan still reads (no crash), the PO is
  -- skipped (still 10 to buy), and every bad record above is listed under check_data (Mason, 2026-11-22).
  PERFORM pg_temp.po(v_p[7], v_admin, 'SMKRS-C21A-' || v_suffix, 10, 0);
  UPDATE purchase_orders SET expected_delivery_date = '300000-01-01' WHERE po_number = 'SMKRS-C21A-' || v_suffix;
  v_plan2 := get_purchasing_plan(12);
  IF pg_temp.prod(v_plan2, v_p[7]) IS NULL OR (pg_temp.prod(v_plan2, v_p[7])->>'suggested')::numeric <> 10
     OR pg_temp.prod(v_plan2, v_p[7])->'coverage' IS DISTINCT FROM v_x->'coverage'
     OR pg_temp.prod(v_plan2, v_p[7])->'months' IS DISTINCT FROM v_x->'months'
     OR NOT (pg_temp.prod(v_plan2, v_p[7])->'reasons' ? 'check_data')
     OR (SELECT count(*) FROM jsonb_array_elements(v_plan2->'check_data') c
          WHERE (c->>'product_id')::uuid = v_p[7] AND c->>'kind' = 'po_line') <> 4
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[7] AND c->>'kind' = 'stock') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C21 a PO dated year 300000) % %', pg_temp.prod(v_plan2, v_p[7]), v_plan2->'check_data';
  END IF;
  -- The allocator itself: a NaN or infinite supply is no cover, and a NaN need takes nothing from the next one.
  v_x := _purchasing_allocate('[{"d":null,"q":"NaN","shelf":true},{"d":null,"q":"Infinity","shelf":false},{"d":null,"q":5,"shelf":false}]',
                              '[{"r":3,"d":"2030-01-01","q":"NaN"},{"r":3,"d":"2030-01-01","q":12}]');
  IF (v_x->1->>'late')::numeric <> 5 OR (v_x->1->>'nc')::numeric <> 7 OR (v_x->1->>'on_time')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C21 the allocator skips non-finite values) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- C22: Sol round 10. Impossible values on needs are skipped and flagged too.
  -- A: a draft Planned Firm booking dated at the minimum date the database stores: no crash, no date, flagged.
  v_q := pg_temp.bk(v_p[21], v_customer, v_admin, 'C22A', 'planned_draft', '[{"q":10,"d":30,"c":"firm"}]');
  UPDATE quote_sections SET needed_by_date = '4714-11-24 BC' WHERE quote_id = v_q;
  -- B: 10 on the shelf, an order line whose remaining quantity is NaN, a Firm 10 at +5 and a Maybe 10 at +1:
  -- the Firm line keeps the shelf (the NaN order is skipped), the Maybe is not covered.
  PERFORM pg_temp.shelf(v_p[22], 10);
  PERFORM pg_temp.ord(v_p[22], v_customer, v_admin, 'SMKRS-C22B-' || v_suffix, 10);
  UPDATE order_items SET quantity_remaining = 'NaN'
   WHERE order_id = (SELECT id FROM orders WHERE order_number = 'SMKRS-C22B-' || v_suffix);
  PERFORM pg_temp.bk(v_p[22], v_customer, v_admin, 'C22BF', 'sent', '[{"q":10,"d":5,"c":"firm"}]');
  PERFORM pg_temp.bk(v_p[22], v_customer, v_admin, 'C22BM', 'sent', '[{"q":10,"d":1,"c":"maybe"}]');
  -- C: 10 on the shelf, an order of 10 whose only delivery is scheduled at 'infinity', a Firm 10 at +5:
  -- the order counts as due today and takes the shelf; the Firm line is bought.
  PERFORM pg_temp.shelf(v_p[23], 10);
  PERFORM pg_temp.ord(v_p[23], v_customer, v_admin, 'SMKRS-C22C-' || v_suffix, 10);
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
  SELECT 'SMKRS-C22C-D-' || v_suffix, o.id, v_customer, 'scheduled', 'infinity', v_admin
    FROM orders o WHERE o.order_number = 'SMKRS-C22C-' || v_suffix RETURNING id INTO v_q2;
  INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
  SELECT v_q2, oi.id, v_p[23], 10, 'Gal' FROM order_items oi JOIN orders o ON o.id = oi.order_id
   WHERE o.order_number = 'SMKRS-C22C-' || v_suffix;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM pg_temp.bk(v_p[23], v_customer, v_admin, 'C22C', 'sent', '[{"q":10,"d":5,"c":"firm"}]');
  v_plan2 := get_purchasing_plan(12);
  v_x := pg_temp.prod(v_plan2, v_p[21]);
  IF v_x IS NULL OR NOT (v_x->'reasons' ? 'check_data')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r WHERE r->>'kind' = 'booking' AND r->>'need_date' IS NULL)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[21] AND c->>'kind' = 'booking_line') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C22A a booking dated at the minimum date) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan2, v_p[22]);
  IF pg_temp.g(v_x, 'committed') <> '10/10/0/0' OR pg_temp.g(v_x, 'shown') <> '10/0/0/10'
     OR (v_x->>'suggested')::numeric <> 0 OR NOT (v_x->'reasons' ? 'check_data')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[22] AND c->>'kind' = 'order_line') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C22B a NaN order line) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan2, v_p[23]);
  IF pg_temp.g(v_x, 'committed') <> '20/10/0/10' OR (v_x->>'suggested')::numeric <> 10
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r
                     WHERE r->>'kind' = 'order' AND (r->>'need_date')::date = v_t)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[23] AND c->>'kind' = 'delivery') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C22C a delivery scheduled at infinity) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- C23: Sol round 11. Every value the plan reads follows the same rule.
  -- A: Firm 100 at +30 (no supply); its active job's line is NaN with 60 drawn. The job is skipped, so is its draw: buy 100.
  v_q := pg_temp.bk(v_p[24], v_customer, v_admin, 'C23A', 'sent', '[{"q":100,"d":30,"c":"firm"}]');
  INSERT INTO jobs (job_number, customer_id, status, job_date, quote_id, created_by)
  VALUES ('SMKRS-C23A-' || v_suffix, v_customer, 'scheduled', v_t + 20, v_q, v_admin) RETURNING id INTO v_pid;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order) VALUES (v_pid, v_p[24], 'NaN', 'Gal', 1);
  DELETE FROM inventory_holds WHERE source_id = v_pid;
  INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn) VALUES (v_pid, v_q, v_p[24], 60);
  -- B: an accepted Firm 100 whose only order is soft-deleted and whose only draw is NaN: still counted (buy 100), flagged.
  v_q := pg_temp.bk(v_p[25], v_customer, v_admin, 'C23B', 'accepted', '[{"q":100,"d":30,"c":"firm"}]');
  INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id, quote_id, deleted_at)
  VALUES ('SMKRS-C23B-' || v_suffix, v_customer, v_t, 'confirmed', v_admin, v_q, now());
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES (v_q, v_p[25], 'NaN');
  -- C: a manual hold of 100 expiring in year 300000, no stock: the expiry counts as none, so the hold is bought (flagged).
  INSERT INTO inventory_holds (product_id, customer_id, quantity, hold_type, source_id, created_by, is_active, expires_at)
  VALUES (v_p[26], v_customer, 100, 'manual', v_q, v_admin, true, '300000-01-01');
  -- D: an order of 10 with one delivery at 'infinity' and one at +30 (10 each): the bad delivery is left out
  -- (flagged) and the good one still dates the order at +30.
  PERFORM pg_temp.shelf(v_p[27], 10);
  PERFORM pg_temp.ord(v_p[27], v_customer, v_admin, 'SMKRS-C23D-' || v_suffix, 10);
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  FOR v_i IN 1..2 LOOP
    INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    SELECT 'SMKRS-C23D-' || v_i || '-' || v_suffix, o.id, v_customer, 'scheduled',
           CASE v_i WHEN 1 THEN 'infinity'::date ELSE v_t + 30 END, v_admin
      FROM orders o WHERE o.order_number = 'SMKRS-C23D-' || v_suffix RETURNING id INTO v_q2;
    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    SELECT v_q2, oi.id, v_p[27], 10, 'Gal' FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.order_number = 'SMKRS-C23D-' || v_suffix;
  END LOOP;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM pg_temp.bk(v_p[27], v_customer, v_admin, 'C23D', 'sent', '[{"q":10,"d":5,"c":"firm"}]');
  -- E: a draft PO dated 2100: flagged.
  INSERT INTO purchase_orders (po_number, vendor, status, expected_delivery_date, created_by)
  VALUES ('SMKRS-C23E-' || v_suffix, '[SMOKE] Vendor', 'draft', '2100-01-01', v_admin) RETURNING id INTO v_q2;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_q2, v_p[28], 10, 0, 6, 'Gal');
  v_plan2 := get_purchasing_plan(12);
  v_x := pg_temp.prod(v_plan2, v_p[24]);
  IF (v_x->>'suggested')::numeric IS DISTINCT FROM 100
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[24] AND c->>'kind' = 'job_line') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C23A a NaN job line keeps its draw) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan2, v_p[25]);
  IF (v_x->>'suggested')::numeric IS DISTINCT FROM 100
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[25] AND c->>'kind' = 'draw') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C23B a NaN draw converts a booking) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan2, v_p[26]);
  IF (v_x->>'suggested')::numeric IS DISTINCT FROM 100
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[26] AND c->>'kind' = 'hold') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C23C a hold expiring in year 300000) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan2, v_p[27]);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r
                  WHERE r->>'kind' = 'order' AND (r->>'need_date')::date = v_t + 30)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[27] AND c->>'kind' = 'delivery') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C23D a bad delivery is left out, the good one dates the order) %', v_x;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                  WHERE (c->>'product_id')::uuid = v_p[28] AND c->>'kind' = 'po_line') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C23E a draft PO dated 2100 is flagged) %', v_plan2->'check_data';
  END IF;
  v_n := v_n + 1;

  -- C24: Sol round 12. Only the bad piece is left out.
  -- A: Firm 100 at +30 (no supply); its active job has a valid 60 line (60 drawn) and a NaN line. Booking 40 + job 60: buy 100.
  v_q := pg_temp.bk(v_p[29], v_customer, v_admin, 'C24A', 'sent', '[{"q":100,"d":30,"c":"firm"}]');
  INSERT INTO jobs (job_number, customer_id, status, job_date, quote_id, created_by)
  VALUES ('SMKRS-C24A-' || v_suffix, v_customer, 'scheduled', v_t + 20, v_q, v_admin) RETURNING id INTO v_pid;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, sort_order)
  VALUES (v_pid, v_p[29], 60, 'Gal', 1), (v_pid, v_p[29], 'NaN', 'Gal', 2);
  DELETE FROM inventory_holds WHERE source_id = v_pid;
  INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn) VALUES (v_pid, v_q, v_p[29], 60);
  -- B: an order of 10 with a valid delivery of 10 at +60 and another delivery whose quantity is NaN at +90:
  -- the order stays dated +60, so a one-month plan buys nothing now.
  PERFORM pg_temp.ord(v_p[30], v_customer, v_admin, 'SMKRS-C24B-' || v_suffix, 10);
  PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
  FOR v_i IN 1..2 LOOP
    INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
    SELECT 'SMKRS-C24B-' || v_i || '-' || v_suffix, o.id, v_customer, 'scheduled', v_t + 30 * (v_i + 1), v_admin
      FROM orders o WHERE o.order_number = 'SMKRS-C24B-' || v_suffix RETURNING id INTO v_q2;
    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    SELECT v_q2, oi.id, v_p[30], CASE v_i WHEN 1 THEN 10 ELSE 'NaN'::numeric END, 'Gal'
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.order_number = 'SMKRS-C24B-' || v_suffix;
  END LOOP;
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  v_plan2 := get_purchasing_plan(1);
  v_x := pg_temp.prod(get_purchasing_plan(12), v_p[29]);
  IF (v_x->>'suggested')::numeric IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C24A a job with one bad line keeps its valid draw) %', v_x;
  END IF;
  v_x := pg_temp.prod(v_plan2, v_p[30]);
  IF (v_x->>'suggested')::numeric IS DISTINCT FROM 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_x->'rows') r
                     WHERE r->>'kind' = 'order' AND (r->>'need_date')::date = v_t + 60)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan2->'check_data') c
                     WHERE (c->>'product_id')::uuid = v_p[30] AND c->>'kind' = 'delivery') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C24B a NaN delivery keeps the good delivery date) %', v_x;
  END IF;
  v_n := v_n + 1;

  -- The allocator is not callable by clients.
  IF has_function_privilege('authenticated', 'public._purchasing_allocate(jsonb, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._purchasing_allocate(jsonb, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: _purchasing_allocate is callable by clients';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: % booking-reservation groups passed', v_n;
END;
$smoke$;
