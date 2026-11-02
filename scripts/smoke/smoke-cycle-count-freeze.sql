-- CONTAINER ONLY (plants [SMOKE] products and inventory): run through
-- scripts/smoke/prove-cycle-count-freeze-real-schema.mjs, never against the live database.
-- Covers 20261102234500: an open cycle count freezes on-hand stock of its rows; completion applies
-- the counted quantity once; the freeze lifts on complete and cancel; a stale snapshot is refused.
-- Always ends in SMOKE_PASS_ROLLBACK (= PASS) or SMOKE_FAIL.
DO $smoke$
DECLARE
  v_admin uuid;
  p1 uuid; p2 uuid; i1 uuid; i2 uuid; i3 uuid;
  r jsonb; v_cc uuid; v_cc2 uuid; v_item uuid; v_rev bigint;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: setup needs one active admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.products (product_name, is_active) VALUES ('[SMOKE] freeze A', true) RETURNING id INTO p1;
  INSERT INTO public.products (product_name, is_active) VALUES ('[SMOKE] freeze B', true) RETURNING id INTO p2;
  INSERT INTO public.inventory (product_id, location, quantity_available) VALUES (p1, 'Main Warehouse', 10) RETURNING id INTO i1;
  INSERT INTO public.inventory (product_id, location, quantity_available) VALUES (p2, 'Main Warehouse', 4.125) RETURNING id INTO i2;
  INSERT INTO public.inventory (product_id, location, quantity_available) VALUES (p1, '[SMOKE] Overflow', 3) RETURNING id INTO i3;

  -- (a) one call starts the count and snapshots every Main Warehouse row.
  r := public.create_cycle_count('Main Warehouse', NULL, 'smoke-freeze-a');
  v_cc := (r ->> 'cycle_count_id')::uuid;
  IF (r ->> 'item_count')::int IS DISTINCT FROM 2
     OR (SELECT expected_qty FROM public.cycle_count_items WHERE cycle_count_id = v_cc AND inventory_id = i1) IS DISTINCT FROM 10::numeric
     OR (SELECT status FROM public.cycle_counts WHERE id = v_cc) IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) create_cycle_count did not snapshot the warehouse: %', r;
  END IF;

  -- (b) the same key replays the same count; a second open count for the warehouse is refused.
  IF (public.create_cycle_count('Main Warehouse', NULL, 'smoke-freeze-a') ->> 'cycle_count_id')::uuid IS DISTINCT FROM v_cc THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) a replay did not return the first count';
  END IF;
  BEGIN
    PERFORM public.create_cycle_count('Main Warehouse', NULL, 'smoke-freeze-b');
    RAISE EXCEPTION 'SMOKE_FAIL: (b) a second open count was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_ALREADY_OPEN: cycle count CC-%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (b) %', SQLERRM; END IF;
  END;
  BEGIN
    INSERT INTO public.cycle_counts (count_number, warehouse, status, initiated_by)
      VALUES ('CC-SMOKE-DUP', 'Main Warehouse', 'in_progress', v_admin);
    RAISE EXCEPTION 'SMOKE_FAIL: (b) a direct second open count was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.cycle_counts (count_number, warehouse, status, initiated_by)
      VALUES ('CC-SMOKE-DUP2', 'main warehouse ', 'in_progress', v_admin);
    RAISE EXCEPTION 'SMOKE_FAIL: (b) a second open count with different spacing and case was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- (b2) direct writes cannot close the open count or drop or change its lines.
  BEGIN
    INSERT INTO public.cycle_counts (count_number, warehouse, status, initiated_by)
      VALUES ('CC-SMOKE-DONE', '[SMOKE] Nowhere', 'completed', v_admin);
    RAISE EXCEPTION 'SMOKE_FAIL: (b2) a count was inserted already completed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_STATUS_LOCKED: a cycle count must start in progress%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (b2) %', SQLERRM; END IF;
  END;
  BEGIN
    INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
      VALUES (v_cc, p1, i3, 3);
    RAISE EXCEPTION 'SMOKE_FAIL: (b2) another warehouse''s row was added to the count';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_LINE_LOCKED: a cycle count line must be a stock row%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (b2) %', SQLERRM; END IF;
  END;
  BEGIN
    UPDATE public.cycle_counts SET status = 'completed' WHERE id = v_cc;
    RAISE EXCEPTION 'SMOKE_FAIL: (b2) an open count was marked completed directly';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_STATUS_LOCKED: cycle count CC-% can only be completed with Complete Count%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (b2) %', SQLERRM; END IF;
  END;
  BEGIN
    UPDATE public.cycle_counts SET warehouse = '[SMOKE] Elsewhere' WHERE id = v_cc;
    RAISE EXCEPTION 'SMOKE_FAIL: (b2) the warehouse of an open count changed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_STATUS_LOCKED: the warehouse of cycle count CC-% cannot change%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (b2) %', SQLERRM; END IF;
  END;
  SELECT id INTO v_item FROM public.cycle_count_items WHERE cycle_count_id = v_cc AND inventory_id = i1;
  BEGIN
    DELETE FROM public.cycle_count_items WHERE id = v_item;
    RAISE EXCEPTION 'SMOKE_FAIL: (b2) a line of an open count was deleted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_LINE_LOCKED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (b2) %', SQLERRM; END IF;
  END;
  BEGIN
    UPDATE public.cycle_count_items SET expected_qty = expected_qty + 1 WHERE id = v_item;
    RAISE EXCEPTION 'SMOKE_FAIL: (b2) the expected quantity of an open count line changed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_LINE_LOCKED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (b2) %', SQLERRM; END IF;
  END;

  -- (c) counted rows are frozen, through an RPC and through a direct write.
  BEGIN
    PERFORM public.adjust_inventory(i1, 5, 'smoke during count', v_admin, 'smoke-freeze-adj1');
    RAISE EXCEPTION 'SMOKE_FAIL: (c) an adjustment during the count was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVENTORY_FROZEN_FOR_CYCLE_COUNT: [SMOKE] freeze A at Main Warehouse is being counted in cycle count CC-%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (c) %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE public.inventory SET product_id = p1 WHERE id = i2;
    RAISE EXCEPTION 'SMOKE_FAIL: (c) a counted row changed product during the count';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVENTORY_FROZEN_FOR_CYCLE_COUNT:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (c) %', SQLERRM; END IF;
  END;
  BEGIN
    UPDATE public.inventory SET quantity_available = quantity_available - 1 WHERE id = i2;
    RAISE EXCEPTION 'SMOKE_FAIL: (c) a direct stock write during the count was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVENTORY_FROZEN_FOR_CYCLE_COUNT: [SMOKE] freeze B at Main Warehouse%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (c) %', SQLERRM; END IF;
  END;
  BEGIN
    INSERT INTO public.inventory (product_id, location, quantity_available) VALUES (p1, 'Main Warehouse', 1)
      ON CONFLICT (product_id, location) DO UPDATE SET quantity_available = public.inventory.quantity_available + 1;
    RAISE EXCEPTION 'SMOKE_FAIL: (c) an upsert of stock during the count was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVENTORY_FROZEN_FOR_CYCLE_COUNT:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (c) %', SQLERRM; END IF;
  END;
  -- Booking (prebooked only) and the same product at another location keep working.
  UPDATE public.inventory SET quantity_prebooked = quantity_prebooked + 1 WHERE id = i1;
  PERFORM public.adjust_inventory(i3, 1, 'smoke other location', v_admin, 'smoke-freeze-adj-loc');
  IF (SELECT quantity_available FROM public.inventory WHERE id = i3) IS DISTINCT FROM 4::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) the other location did not move';
  END IF;

  -- (d) completion sets stock to the counted quantity, once.
  SELECT id INTO v_item FROM public.cycle_count_items WHERE cycle_count_id = v_cc AND inventory_id = i1;
  PERFORM public.update_cycle_count_item(v_item, 8, NULL, v_admin, 'smoke-freeze-item1');
  -- B holds 4.125 on hand, snapshotted as 4.13 (numeric(10,2)); counted as 4.13 it must still complete.
  PERFORM public.update_cycle_count_item(
    (SELECT id FROM public.cycle_count_items WHERE cycle_count_id = v_cc AND inventory_id = i2), 4.13, NULL, v_admin, 'smoke-freeze-item1b');
  SELECT item_revision INTO v_rev FROM public.cycle_counts WHERE id = v_cc;
  PERFORM public.complete_cycle_count(v_cc, v_admin, 'smoke-freeze-complete1', v_rev);
  IF (SELECT quantity_available FROM public.inventory WHERE id = i1) IS DISTINCT FROM 8::numeric
     OR (SELECT quantity_available FROM public.inventory WHERE id = i2) IS DISTINCT FROM 4.125::numeric
     OR (SELECT status FROM public.cycle_counts WHERE id = v_cc) IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) completion math is wrong: A=%, B=%, status=%',
      (SELECT quantity_available FROM public.inventory WHERE id = i1),
      (SELECT quantity_available FROM public.inventory WHERE id = i2),
      (SELECT status FROM public.cycle_counts WHERE id = v_cc);
  END IF;
  IF (SELECT count(*) FROM public.inventory_transactions
       WHERE product_id = p1 AND transaction_type = 'adjusted' AND quantity = -2 AND notes LIKE 'Cycle count CC-%') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) the count wrote no single -2 adjustment';
  END IF;
  IF COALESCE(current_setting('crx.cycle_count_applying', true), '') <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) the completion exemption outlived the completion';
  END IF;

  BEGIN
    DELETE FROM public.cycle_count_items WHERE cycle_count_id = v_cc AND inventory_id = i1;
    RAISE EXCEPTION 'SMOKE_FAIL: (d) a line of a completed count was deleted before reversal';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_NOT_IN_PROGRESS%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (d) %', SQLERRM; END IF;
  END;
  BEGIN
    UPDATE public.cycle_counts SET status = 'cancelled' WHERE id = v_cc;
    RAISE EXCEPTION 'SMOKE_FAIL: (d) a completed count was cancelled directly without undoing it';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_STATUS_LOCKED: cycle count CC-% can only be cancelled after completion with Reverse Count%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (d) %', SQLERRM; END IF;
  END;

  -- (e) the freeze lifts on completion.
  PERFORM public.adjust_inventory(i1, 5, 'smoke after count', v_admin, 'smoke-freeze-adj2');

  -- (f) reversing the completed count is refused while another count holds the row, and
  -- allowed once that count is cancelled (which also lifts its freeze).
  r := public.create_cycle_count('Main Warehouse', 'second', 'smoke-freeze-c');
  v_cc2 := (r ->> 'cycle_count_id')::uuid;
  IF (SELECT expected_qty FROM public.cycle_count_items WHERE cycle_count_id = v_cc2 AND inventory_id = i1) IS DISTINCT FROM 13::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (f) the second count snapshot is wrong';
  END IF;
  BEGIN
    PERFORM public.reverse_completed_cycle_count(v_cc, v_admin, 'smoke-freeze-rev1');
    RAISE EXCEPTION 'SMOKE_FAIL: (f) a reversal during another open count was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVENTORY_FROZEN_FOR_CYCLE_COUNT:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (f) %', SQLERRM; END IF;
  END;
  PERFORM public.cancel_cycle_count(v_cc2, v_admin, 'smoke-freeze-cancel1');
  PERFORM public.adjust_inventory(i1, -1, 'smoke after cancel', v_admin, 'smoke-freeze-adj3');
  PERFORM public.reverse_completed_cycle_count(v_cc, v_admin, 'smoke-freeze-rev2');
  IF (SELECT quantity_available FROM public.inventory WHERE id = i1) IS DISTINCT FROM 14::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (f) the reversal did not undo exactly the -2 adjustment';
  END IF;

  -- (g) a count started the old three-step way, with a stale snapshot, cannot complete.
  INSERT INTO public.cycle_counts (count_number, warehouse, status, initiated_by)
    VALUES ('CC-SMOKE-OLD', 'Main Warehouse', 'in_progress', v_admin) RETURNING id INTO v_cc2;
  INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
    VALUES (v_cc2, p1, i1, 10) RETURNING id INTO v_item;
  BEGIN
    UPDATE public.cycle_count_items SET product_id = p2 WHERE id = v_item;
    RAISE EXCEPTION 'SMOKE_FAIL: (g) the product of an open count line changed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_LINE_LOCKED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (g) %', SQLERRM; END IF;
  END;
  BEGIN
    UPDATE public.cycle_count_items SET cycle_count_id = v_cc2 WHERE cycle_count_id = v_cc AND inventory_id = i2;
    RAISE EXCEPTION 'SMOKE_FAIL: (g) a closed count line was moved into an open count';
  EXCEPTION WHEN OTHERS THEN
    -- the older reparent trigger (CYCLE_COUNT_ITEM_REPARENT_FORBIDDEN) may refuse first
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_LINE_LOCKED:%' AND SQLERRM NOT LIKE 'CYCLE_COUNT_ITEM_REPARENT_FORBIDDEN%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (g) %', SQLERRM; END IF;
  END;
  PERFORM public.update_cycle_count_item(v_item, 14, NULL, v_admin, 'smoke-freeze-item2');
  SELECT item_revision INTO v_rev FROM public.cycle_counts WHERE id = v_cc2;
  BEGIN
    PERFORM public.complete_cycle_count(v_cc2, v_admin, 'smoke-freeze-complete2', v_rev);
    RAISE EXCEPTION 'SMOKE_FAIL: (g) a stale count completed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_STOCK_MOVED: stock for [SMOKE] freeze A changed after cycle count CC-SMOKE-OLD started (expected 10, now 14)%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (g) %', SQLERRM;
    END IF;
  END;
  IF (SELECT quantity_available FROM public.inventory WHERE id = i1) IS DISTINCT FROM 14::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (g) the refused completion moved stock';
  END IF;
  PERFORM public.cancel_cycle_count(v_cc2, v_admin, 'smoke-freeze-cancel2');
  BEGIN
    UPDATE public.cycle_counts SET status = 'completed' WHERE id = v_cc2;
    RAISE EXCEPTION 'SMOKE_FAIL: (g) a cancelled count was reopened as completed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_STATUS_LOCKED: cycle count CC-SMOKE-OLD is cancelled%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (g) %', SQLERRM; END IF;
  END;

  -- (h) refusals before any work.
  BEGIN
    PERFORM public.create_cycle_count('Main Warehouse', NULL, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (h) a start without a key was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (h) %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM public.create_cycle_count('[SMOKE] Nowhere', NULL, 'smoke-freeze-d');
    RAISE EXCEPTION 'SMOKE_FAIL: (h) a start with no inventory was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CYCLE_COUNT_NO_INVENTORY:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (h) %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', (current_setting('request.jwt.claims')::jsonb ->> 'sub'), true);
  BEGIN
    PERFORM public.create_cycle_count('Main Warehouse', NULL, 'smoke-freeze-e');
    RAISE EXCEPTION 'SMOKE_FAIL: (h) a non-admin started a count';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'NOT_AUTHORIZED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (h) %', SQLERRM; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
