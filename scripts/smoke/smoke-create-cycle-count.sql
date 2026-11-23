-- Rolled-back chain for create_cycle_count (KI-160, 20270209160000): one call saves the count and a line per stock row
-- at the location (expected = on-hand); a replay returns the same count; a second start at the location is refused.
DO $smoke$
DECLARE
  v_admin uuid;
  v_product uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_loc text;
  r jsonb;
  r2 jsonb;
  v_lines int;
  v_msg text;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_loc := '[SMOKE] Count WH ' || v_suffix;

  INSERT INTO products (product_name, product_form, inventory_unit)
  VALUES ('[SMOKE] Count Create ' || v_suffix, 'liquid', 'Gal') RETURNING id INTO v_product;
  INSERT INTO inventory (product_id, location, quantity_available) VALUES (v_product, v_loc, 42);

  r := create_cycle_count(v_loc, 'smoke', v_admin, 'smk-cc-create-' || v_suffix);
  SELECT count(*) INTO v_lines FROM cycle_count_items
   WHERE cycle_count_id = (r->>'cycle_count_id')::uuid AND expected_qty = 42 AND product_id = v_product;
  IF (r->>'line_count')::int <> 1 OR v_lines <> 1
     OR NOT EXISTS (SELECT 1 FROM cycle_counts WHERE id = (r->>'cycle_count_id')::uuid AND status = 'in_progress') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create produced %', r;
  END IF;

  r2 := create_cycle_count(v_loc, 'smoke', v_admin, 'smk-cc-create-' || v_suffix);
  IF r2 IS DISTINCT FROM r THEN RAISE EXCEPTION 'SMOKE_FAIL: replay returned % not %', r2, r; END IF;

  BEGIN
    PERFORM create_cycle_count(v_loc, NULL, v_admin, 'smk-cc-create2-' || v_suffix);
    v_msg := 'NOT REFUSED';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg NOT LIKE 'COUNT_ALREADY_OPEN:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: second start gave %', v_msg; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
