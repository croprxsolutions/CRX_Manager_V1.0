-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261103130000_bind_order_replay_receipts_batch4b.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-order-replay-binding-batch4b-real-schema.mjs,
-- never against the live database. The fixtures create rush orders, which draw customer-visible
-- order numbers from a non-transactional sequence that a rollback does not return; the container
-- prover reports which sequences this chain moves. The chain also plants [SMOKE] customers,
-- products, orders and inventory rows.
--
-- Rule under test: price_order, update_order_items and mark_inventory_row_verified replay a stored
-- idempotency receipt only to the person who wrote it, and only for the exact same request. A key
-- reused for a different order or inventory row, or with different prices or lines, is refused
-- (IDEMPOTENCY_INTENT_MISMATCH) and changes nothing; a different admin presenting the key is refused
-- (IDEMPOTENCY_ACTOR_MISMATCH); an exact retry still returns the original answer, also when it now
-- carries an approved below-cost reason; a call with no key is refused (IDEMPOTENCY_KEY_REQUIRED,
-- 22023); price_order and mark_inventory_row_verified check the caller's role before any stored
-- result is returned. Every fresh receipt is bound to the actor with a 64-hex fingerprint.
--
-- Fail-first: before the migration step a fails (price_order hands order 1's receipt back as success
-- for order 2).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
--
-- Auth: auth.uid() reads request.jwt.claims, set with set_config(..., true) to two REAL active admin
-- profiles and one REAL active applicator found at run time (SMOKE_SETUP if any is missing). Fixture
-- INSERTs run as the table owner; the RPCs under test enforce their own role checks.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_admin_b uuid;
  v_applicator uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_key text;
  v_customer uuid;
  v_shell uuid;
  v_product uuid;
  v_pricing jsonb;
  v_rush uuid[] := ARRAY[]::uuid[];
  v_line uuid[] := ARRAY[]::uuid[];
  v_order uuid[] := ARRAY[]::uuid[];
  v_inv uuid[] := ARRAY[]::uuid[];
  v_items jsonb;
  v_reasoned jsonb;
  v_ver bigint;
  v_ver_after bigint;
  v_id uuid;
  v_i int;
  v_res jsonb;
  v_res2 jsonb;
  v_n int;
BEGIN
  -- --------------------------------------------------------------------------------------------
  -- 0. Two real admins and an applicator, fixtures.
  -- --------------------------------------------------------------------------------------------
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_admin_b FROM public.profiles
   WHERE role = 'admin' AND is_active = true AND id IS DISTINCT FROM v_admin ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_applicator FROM public.profiles
   WHERE role = 'applicator' AND is_active = true ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_admin_b IS NULL OR v_applicator IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two active admin profiles and one active applicator are required';
  END IF;
  -- Only request.jwt.claims is set (and switched below): live's auth.uid() reads it when claim.sub is unset.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_prefix := 'smk-orb4b-' || v_suffix || '-';

  INSERT INTO public.customers (farm_name, account_number, assigned_tier)
  VALUES ('[SMOKE] Order Replay Farm ' || v_suffix, '[SMOKE]-ORB4B-' || v_suffix, 1)
  RETURNING id INTO v_customer;
  -- A cost-free shell for inventory row 1.
  INSERT INTO public.products (product_name, unit_size, is_active)
  VALUES ('[SMOKE] ORB4B shell ' || v_suffix, 'gal', true)
  RETURNING id INTO v_shell;
  -- An order line for a catalog product needs a governed positive cost: preview -> approve -> apply.
  INSERT INTO public.products (product_name, unit_size, product_form)
  VALUES ('[SMOKE] ORB4B Product ' || v_suffix, 'GL', 'liquid')
  RETURNING id INTO v_product;
  v_pricing := public.preview_product_cost_basis_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', (SELECT pricing_version FROM public.products WHERE id = v_product),
      'pricing_mode', 'price_driven', 'new_cost', '1.00',
      'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00',
      'change_reason', '[SMOKE] ORB4B cost fixture', 'price_source', '[SMOKE] ORB4B',
      'basis_type', 'manual_override', 'basis_source', 'product_page',
      'basis_reason', '[SMOKE] ORB4B cost fixture', 'basis_selection', false)),
    v_admin, v_prefix || 'price-preview');
  IF (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed cost preview refused: %', v_pricing;
  END IF;
  PERFORM public.approve_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint',
    COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', w->>'product_id', 'warning_codes', w->'warning_codes',
                                                  'reason', '[SMOKE] acknowledged'))
                FROM jsonb_array_elements(v_pricing->'warnings') AS w), '[]'::jsonb),
    NULL, v_admin, v_prefix || 'price-approve');
  PERFORM public.apply_product_cost_basis_change_set((v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint', v_admin, v_prefix || 'price-apply');

  -- Two rush orders waiting for prices (a); pricing needs the product's governed cost basis.
  FOR v_i IN 1..2 LOOP
    v_res := public.create_rush_order(v_customer, jsonb_build_array(jsonb_build_object('product_id', v_product, 'qty', 1)),
      '[SMOKE] ORB4B rush ' || v_i, NULL, v_admin, v_prefix || 'rush-' || v_i);
    IF v_res->>'status' IS DISTINCT FROM 'created' THEN
      RAISE EXCEPTION 'SMOKE_SETUP: create_rush_order % did not create: %', v_i, v_res;
    END IF;
    v_rush := v_rush || (v_res->>'order_id')::uuid;
    SELECT id INTO v_id FROM public.order_items WHERE order_id = (v_res->>'order_id')::uuid AND pricing_pending;
    IF v_id IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: rush order % has no line waiting for a price', v_i; END IF;
    v_line := v_line || v_id;
  END LOOP;
  -- Two confirmed orders to edit (b).
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
    VALUES ('[SMOKE] ORB4B-' || v_i || '-' || v_suffix, v_customer, 'confirmed', false)
    RETURNING id INTO v_id;
    v_order := v_order || v_id;
  END LOOP;
  -- Two inventory rows flagged manufactured-at-delivery (c), at a [SMOKE] location of their own.
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.inventory (product_id, location, quantity_available, manufactured_at_delivery)
    VALUES (CASE v_i WHEN 1 THEN v_shell ELSE v_product END, '[SMOKE] ORB4B ' || v_suffix, 0, true)
    RETURNING id INTO v_id;
    v_inv := v_inv || v_id;
  END LOOP;

  -- --------------------------------------------------------------------------------------------
  -- a. price_order: the same key for a DIFFERENT order is refused; order 2 stays unpriced.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'price';
  v_items := jsonb_build_array(jsonb_build_object('order_item_id', v_line[1], 'price', 4));
  v_res := public.price_order(v_rush[1], v_items, v_admin, v_key);
  IF v_res->>'pricing_status' IS DISTINCT FROM 'priced' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: price_order did not price order 1: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.price_order(v_rush[2], jsonb_build_array(jsonb_build_object('order_item_id', v_line[2], 'price', 4)), v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: price_order replayed order 1''s receipt as success for order 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong price_order refusal for order 2: %', SQLERRM;
    END IF;
  END;
  IF (SELECT pricing_status FROM public.orders WHERE id = v_rush[2]) IS DISTINCT FROM 'needs_pricing' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused price_order changed order 2';
  END IF;
  BEGIN
    v_res2 := public.price_order(v_rush[1], jsonb_build_array(jsonb_build_object('order_item_id', v_line[1], 'price', 5)), v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: price_order replayed a receipt for edited prices: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong price_order refusal for edited prices: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  BEGIN
    v_res2 := public.price_order(v_rush[1], v_items, v_admin_b, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: price_order replayed admin A''s receipt to admin B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'IDEMPOTENCY_ACTOR_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong admin B price_order refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  BEGIN
    v_res2 := public.price_order(v_rush[1], v_items, v_applicator, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: price_order answered an applicator: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'INSUFFICIENT_ROLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong applicator price_order refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    v_res2 := public.price_order(v_rush[1], v_items, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact price_order retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact price_order retry did not replay: % vs %', v_res2, v_res;
  END IF;
  -- The screen re-sends an approved below-cost reason on each line; it is not a different request.
  v_reasoned := jsonb_build_array(jsonb_build_object('order_item_id', v_line[1], 'price', 4, 'below_cost_reason', '[SMOKE] approved'));
  BEGIN
    v_res2 := public.price_order(v_rush[1], v_reasoned, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the price_order retry with the approved reason was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the price_order retry with the approved reason did not replay: % vs %', v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.price_order(v_rush[2], jsonb_build_array(jsonb_build_object('order_item_id', v_line[2], 'price', 4)), v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: price_order ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLSTATE <> '22023' OR SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless price_order refusal: % %', SQLSTATE, SQLERRM;
    END IF;
  END;
  -- Order 2 still prices under its own key.
  v_res2 := public.price_order(v_rush[2], jsonb_build_array(jsonb_build_object('order_item_id', v_line[2], 'price', 4)), v_admin, v_prefix || 'price-2');
  IF v_res2->>'pricing_status' IS DISTINCT FROM 'priced' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: price_order did not price order 2 under its own key: %', v_res2;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- b. update_order_items: the same key for a DIFFERENT order or lines is refused; order 2 unchanged.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'edit';
  v_items := jsonb_build_array(jsonb_build_object('product_id', v_product, 'product_name', '[SMOKE] ORB4B line',
    'unit_size', 'GL', 'cost_per_unit', 1, 'price_per_unit', 10, 'total_units_needed', 2));
  v_ver := (SELECT row_version FROM public.orders WHERE id = v_order[1]);
  v_res := public.update_order_items(v_order[1], v_items, v_admin, v_key, v_ver);
  v_ver_after := (SELECT row_version FROM public.orders WHERE id = v_order[1]);
  IF (v_res->>'success')::boolean IS DISTINCT FROM true OR (v_res->>'order_id')::uuid IS DISTINCT FROM v_order[1] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: update_order_items did not edit order 1: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.update_order_items(v_order[2], v_items, v_admin, v_key,
      (SELECT row_version FROM public.orders WHERE id = v_order[2]));
    RAISE EXCEPTION 'SMOKE_FAIL: update_order_items replayed order 1''s receipt as success for order 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong update_order_items refusal for order 2: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_order[2]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused update_order_items changed order 2';
  END IF;
  BEGIN
    v_res2 := public.update_order_items(v_order[1],
      jsonb_set(v_items, '{0,total_units_needed}', '3'::jsonb), v_admin, v_key, v_ver);
    RAISE EXCEPTION 'SMOKE_FAIL: update_order_items replayed a receipt for edited lines: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong update_order_items refusal for edited lines: %', SQLERRM;
    END IF;
  END;
  -- Every retry sends the version the FIRST call expected, as the screen does.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  BEGIN
    v_res2 := public.update_order_items(v_order[1], v_items, v_admin_b, v_key, v_ver);
    RAISE EXCEPTION 'SMOKE_FAIL: update_order_items replayed admin A''s receipt to admin B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'IDEMPOTENCY_ACTOR_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong admin B update_order_items refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    v_res2 := public.update_order_items(v_order[1], v_items, v_admin, v_key, v_ver);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact update_order_items retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact update_order_items retry did not replay: % vs %', v_res2, v_res;
  END IF;
  v_reasoned := jsonb_set(v_items, '{0,below_cost_reason}', '"[SMOKE] approved"'::jsonb);
  BEGIN
    v_res2 := public.update_order_items(v_order[1], v_reasoned, v_admin, v_key, v_ver);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the update_order_items retry with the approved reason was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the update_order_items retry with the approved reason did not replay: % vs %', v_res2, v_res;
  END IF;
  IF (SELECT row_version FROM public.orders WHERE id = v_order[1]) IS DISTINCT FROM v_ver_after THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an update_order_items replay edited order 1 again';
  END IF;
  BEGIN
    v_res2 := public.update_order_items(v_order[2], v_items, v_admin, NULL,
      (SELECT row_version FROM public.orders WHERE id = v_order[2]));
    RAISE EXCEPTION 'SMOKE_FAIL: update_order_items ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLSTATE <> '22023' OR SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless update_order_items refusal: % %', SQLSTATE, SQLERRM;
    END IF;
  END;
  BEGIN
    v_res2 := public.update_order_items(v_order[2], v_items, v_admin, v_prefix || 'edit-noversion', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: update_order_items ran without an expected version: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'ORDER_EXPECTED_VERSION_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong versionless update_order_items refusal: %', SQLERRM;
    END IF;
  END;
  -- Order 2 still edits under its own key.
  v_res2 := public.update_order_items(v_order[2], v_items, v_admin, v_prefix || 'edit-2',
    (SELECT row_version FROM public.orders WHERE id = v_order[2]));
  IF (v_res2->>'order_id')::uuid IS DISTINCT FROM v_order[2]
     OR NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_order[2]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: update_order_items did not edit order 2 under its own key: %', v_res2;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- c. mark_inventory_row_verified: the same key for a DIFFERENT row is refused; row 2 stays flagged.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'verify';
  v_res := public.mark_inventory_row_verified(v_inv[1], v_admin, v_key);
  IF (v_res->>'cleared')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: mark_inventory_row_verified did not clear row 1: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.mark_inventory_row_verified(v_inv[2], v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: mark_inventory_row_verified replayed row 1''s receipt as success for row 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong mark_inventory_row_verified refusal for row 2: %', SQLERRM;
    END IF;
  END;
  IF (SELECT manufactured_at_delivery FROM public.inventory WHERE id = v_inv[2]) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused mark_inventory_row_verified changed row 2';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  BEGIN
    v_res2 := public.mark_inventory_row_verified(v_inv[1], v_admin_b, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: mark_inventory_row_verified replayed admin A''s receipt to admin B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'IDEMPOTENCY_ACTOR_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong admin B mark_inventory_row_verified refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  BEGIN
    v_res2 := public.mark_inventory_row_verified(v_inv[1], NULL, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: mark_inventory_row_verified answered an applicator: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'INSUFFICIENT_ROLE: admin required' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong applicator mark_inventory_row_verified refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    v_res2 := public.mark_inventory_row_verified(v_inv[1], v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact mark_inventory_row_verified retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact mark_inventory_row_verified retry did not replay: % vs %', v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.mark_inventory_row_verified(v_inv[2], v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: mark_inventory_row_verified ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLSTATE <> '22023' OR SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless mark_inventory_row_verified refusal: % %', SQLSTATE, SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- d. Every fresh receipt is bound to admin A with a 64-hex fingerprint.
  -- --------------------------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.idempotency_keys
   WHERE idempotency_key IN (v_prefix || 'price', v_prefix || 'price-2', v_prefix || 'edit', v_prefix || 'edit-2', v_prefix || 'verify')
     AND request_actor_id = v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$';
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % of 5 fresh receipts are bound to the caller', v_n;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
