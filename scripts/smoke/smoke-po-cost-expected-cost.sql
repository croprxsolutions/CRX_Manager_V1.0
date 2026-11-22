-- Rolled-back chain for set_purchase_order_item_costs' expected cost (KI-197, 20270214100000): with the cost the admin
-- saw, a correction saves; from a stale screen it is refused with PO_COST_CHANGED_SINCE_LOADED and nothing changes.
DO $smoke$
DECLARE
  v_admin uuid;
  v_product uuid;
  v_po uuid;
  v_line uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  r jsonb;
  v_msg text;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  INSERT INTO products (product_name, product_form, inventory_unit)
  VALUES ('[SMOKE] PO Cost ' || v_suffix, 'liquid', 'Gal') RETURNING id INTO v_product;
  INSERT INTO purchase_orders (po_number, vendor, status, created_by)
  VALUES ('[SMOKE]-PO-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_admin) RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, product_name)
  VALUES (v_po, v_product, 3, 10.00, 0, '[SMOKE] PO Cost ' || v_suffix) RETURNING id INTO v_line;

  r := set_purchase_order_item_costs(v_po,
    jsonb_build_array(jsonb_build_object('id', v_line, 'unit_cost_cents', 1100, 'expected_unit_cost_cents', 1000)),
    NULL, v_admin, 'smk-po-exp-1-' || v_suffix);
  IF (r->>'lines_changed')::int <> 1 OR (SELECT unit_cost_cents FROM purchase_order_items WHERE id = v_line) <> 1100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: matching expected gave %', r;
  END IF;

  BEGIN
    PERFORM set_purchase_order_item_costs(v_po,
      jsonb_build_array(jsonb_build_object('id', v_line, 'unit_cost_cents', 1200, 'expected_unit_cost_cents', 1000)),
      NULL, v_admin, 'smk-po-exp-2-' || v_suffix);
    v_msg := 'NOT REFUSED';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg NOT LIKE 'PO_COST_CHANGED_SINCE_LOADED:%'
     OR (SELECT unit_cost_cents FROM purchase_order_items WHERE id = v_line) <> 1100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stale save gave %', v_msg;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
