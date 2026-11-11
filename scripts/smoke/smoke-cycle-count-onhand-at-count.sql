-- Rolled-back chain for KI-134 (20270101134000): a count line is compared with on hand when it is SAVED,
-- so stock that moves between creating the count and counting the shelf is not applied twice.
DO $smoke$
DECLARE
  v_admin uuid;
  v_product uuid;
  v_inventory uuid;
  v_count uuid;
  v_item uuid;
  v_result jsonb;
  v_qty numeric;
  v_expected numeric;
  v_variance numeric;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO products (product_name)
  VALUES ('[SMOKE] Count On Hand ' || v_suffix) RETURNING id INTO v_product;
  INSERT INTO inventory (product_id, location, quantity_available)
  VALUES (v_product, 'Main Warehouse', 100) RETURNING id INTO v_inventory;

  -- 1. Stock arrives during the count: created at 100, +10, shelf 110 -> 110 (was 120).
  INSERT INTO cycle_counts (count_number, warehouse, initiated_by)
  VALUES ('SMK-CC-OH1-' || v_suffix, 'Main Warehouse', v_admin) RETURNING id INTO v_count;
  INSERT INTO cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
  VALUES (v_count, v_product, v_inventory, 100) RETURNING id INTO v_item;
  PERFORM adjust_inventory(v_inventory, 10, '[SMOKE] stock in during the count', v_admin, 'smk-cc-oh-in-' || v_suffix);
  v_result := update_cycle_count_item(v_item, 110, NULL, v_admin, 'smk-cc-oh-save1-' || v_suffix);
  IF (v_result->>'expected_qty')::numeric IS DISTINCT FROM 110 OR (v_result->>'variance')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save 1 returned %', v_result;
  END IF;
  PERFORM complete_cycle_count(v_count, v_admin, 'smk-cc-oh-done1-' || v_suffix,
    (SELECT item_revision FROM cycle_counts WHERE id = v_count));
  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory;
  IF v_qty IS DISTINCT FROM 110 THEN RAISE EXCEPTION 'SMOKE_FAIL: stock in during count ended at % (want 110)', v_qty; END IF;

  -- 2. Stock leaves during the count, real shrink: created at 110, -10, shelf 97 -> 97 (variance -3).
  INSERT INTO cycle_counts (count_number, warehouse, initiated_by)
  VALUES ('SMK-CC-OH2-' || v_suffix, 'Main Warehouse', v_admin) RETURNING id INTO v_count;
  INSERT INTO cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
  VALUES (v_count, v_product, v_inventory, 110) RETURNING id INTO v_item;
  PERFORM adjust_inventory(v_inventory, -10, '[SMOKE] stock out during the count', v_admin, 'smk-cc-oh-out-' || v_suffix);
  PERFORM update_cycle_count_item(v_item, 97, NULL, v_admin, 'smk-cc-oh-save2-' || v_suffix);
  SELECT expected_qty, variance INTO v_expected, v_variance FROM cycle_count_items WHERE id = v_item;
  IF v_expected IS DISTINCT FROM 100 OR v_variance IS DISTINCT FROM -3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save 2 stored expected % variance % (want 100, -3)', v_expected, v_variance;
  END IF;
  PERFORM complete_cycle_count(v_count, v_admin, 'smk-cc-oh-done2-' || v_suffix,
    (SELECT item_revision FROM cycle_counts WHERE id = v_count));
  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory;
  IF v_qty IS DISTINCT FROM 97 THEN RAISE EXCEPTION 'SMOKE_FAIL: stock out during count ended at % (want 97)', v_qty; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
