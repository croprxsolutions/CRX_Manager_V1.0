-- ============================================================================
-- SMOKE TEST (rolled back by design) for
-- 20261110100000_bind_money_inventory_replay_receipts_batch4c.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-replay-binding-batch4c-real-schema.mjs, never
-- against the live database. duplicate_quote, create_delivery_with_items and
-- create_followup_delivery draw customer-visible quote and delivery numbers from non-transactional
-- sequences that a rollback does not return; the container prover reports which sequences this
-- chain moves. The chain also plants [SMOKE] customers, products, orders, purchase orders,
-- deliveries, cycle counts and blend tickets.
--
-- Rule under test: the twelve batch 4c functions (submit/cancel/delete_purchase_order,
-- duplicate_quote, edit/reassign/confirm_delivery, batch_reschedule_deliveries,
-- create_delivery_with_items, create_followup_delivery, cancel_cycle_count,
-- reverse_blend_ticket_approval) replay a stored idempotency receipt only to the person who wrote
-- it, and only for the exact same request. For each: a key reused for a different target is refused
-- (IDEMPOTENCY_INTENT_MISMATCH) and changes nothing; a second admin presenting the key is refused
-- (IDEMPOTENCY_ACTOR_MISMATCH); a caller without the role is refused before any stored result is
-- returned; an exact retry still returns the original answer; a call with no key is refused
-- (IDEMPOTENCY_KEY_REQUIRED, 22023). Every fresh receipt is bound with a 64-hex fingerprint.
--
-- Fail-first: before the migration step a fails (submit_purchase_order hands PO 1's receipt back
-- as success for PO 2).
--
-- HOW TO RUN: inside a transaction that rolls back. It ALWAYS ends with RAISE EXCEPTION
-- 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL. The two pg_temp helpers
-- below vanish with the session.
-- ============================================================================
CREATE OR REPLACE FUNCTION pg_temp.b4c_as(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
END $fn$;

-- Run p_sql; it must raise an error whose text is LIKE p_expected (and, if given, SQLSTATE p_state).
-- A call that succeeds fails the chain with p_label. The block's savepoint undoes anything it did.
CREATE OR REPLACE FUNCTION pg_temp.b4c_refused(p_label text, p_sql text, p_expected text, p_state text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE v jsonb;
BEGIN
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE p_expected AND (p_state IS NULL OR SQLSTATE = p_state) THEN RETURN; END IF;
    RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal (%): % %', p_label, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'SMOKE_FAIL: %: %', p_label, v;
END $fn$;

-- Run p_sql (an exact retry); it must return p_first.
CREATE OR REPLACE FUNCTION pg_temp.b4c_replays(p_fn text, p_sql text, p_first jsonb) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE v jsonb;
BEGIN
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact % retry was refused: %', p_fn, SQLERRM;
  END;
  IF v IS DISTINCT FROM p_first THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact % retry did not replay: % vs %', p_fn, v, p_first;
  END IF;
END $fn$;

DO $smoke$
DECLARE
  v_pricing jsonb;
  v_admin uuid;
  v_admin_b uuid;
  v_driver uuid;
  v_low uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_key text;
  v_keys text[] := ARRAY[]::text[];
  v_customer uuid;
  v_product uuid;
  v_order uuid;
  v_oi uuid[] := ARRAY[]::uuid[];
  v_po uuid[] := ARRAY[]::uuid[];
  v_quote uuid[] := ARRAY[]::uuid[];
  v_del uuid[] := ARRAY[]::uuid[];
  v_cc uuid[] := ARRAY[]::uuid[];
  v_bt uuid[] := ARRAY[]::uuid[];
  v_date date := current_date + 7;
  v_id uuid;
  v_i int;
  v_res jsonb;
  v_n int;
  -- One call, as SQL text: fn(args) with the performer and key appended where the signature takes them.
  v_sql text;
BEGIN
  -- --------------------------------------------------------------------------------------------
  -- 0. Two real admins, a driver and an applicator; fixtures.
  -- --------------------------------------------------------------------------------------------
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_admin_b FROM public.profiles
   WHERE role = 'admin' AND is_active AND id IS DISTINCT FROM v_admin ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_driver FROM public.profiles WHERE role = 'driver' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_low FROM public.profiles WHERE role = 'applicator' AND is_active ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_admin_b IS NULL OR v_driver IS NULL OR v_low IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two active admins, one active driver and one active applicator are required';
  END IF;
  PERFORM pg_temp.b4c_as(v_admin);
  v_prefix := 'smk-rb4c-' || v_suffix || '-';

  INSERT INTO public.customers (farm_name, account_number, assigned_tier)
  VALUES ('[SMOKE] Replay 4c Farm ' || v_suffix, '[SMOKE]-RB4C-' || v_suffix, 1)
  RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name, unit_size, product_form)
  VALUES ('[SMOKE] RB4C product ' || v_suffix, 'GL', 'liquid')
  RETURNING id INTO v_product;
  -- Order lines need the product's governed cost basis (the below-cost line trigger).
  v_pricing := public.preview_product_cost_basis_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', (SELECT pricing_version FROM public.products WHERE id = v_product),
      'pricing_mode', 'price_driven', 'new_cost', '1.00',
      'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00',
      'change_reason', '[SMOKE] RB4C cost fixture', 'price_source', '[SMOKE] RB4C',
      'basis_type', 'manual_override', 'basis_source', 'product_page',
      'basis_reason', '[SMOKE] RB4C cost fixture', 'basis_selection', false)),
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
  INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
  VALUES ('[SMOKE] RB4C-' || v_suffix, v_customer, 'confirmed', false)
  RETURNING id INTO v_order;
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, unit_size, total_units_needed,
                                    quantity_remaining, price_per_unit, cost_per_unit, sort_order)
    VALUES (v_order, v_product, '[SMOKE] RB4C line ' || v_i, 'GL', 10, 10, 10, 1, v_i)
    RETURNING id INTO v_id;
    v_oi := v_oi || v_id;
  END LOOP;
  -- Purchase orders 1-2 (submit), 3-4 (cancel), 5-6 (delete), all drafts with no bills or receipts.
  FOR v_i IN 1..6 LOOP
    INSERT INTO public.purchase_orders (po_number, vendor, status, created_by)
    VALUES ('[SMOKE] RB4C-PO-' || v_i || '-' || v_suffix, '[SMOKE] RB4C vendor', 'draft', v_admin)
    RETURNING id INTO v_id;
    v_po := v_po || v_id;
  END LOOP;
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status)
    VALUES ('[SMOKE] RB4C-Q-' || v_i || '-' || v_suffix, v_customer, v_admin, 'draft')
    RETURNING id INTO v_id;
    v_quote := v_quote || v_id;
  END LOOP;
  -- Scheduled deliveries 1-2 (edit), 3-4 (reassign), 5-6 (reschedule), 7-8 (confirm, assigned to
  -- the driver), 9-10 (follow-up originals, completed with a pending remainder each).
  FOR v_i IN 1..10 LOOP
    -- A completed fixture row carries the per-row completion marker (as complete_delivery sets it).
    v_id := gen_random_uuid();
    PERFORM set_config('crx.delivery_completion_evidence', CASE WHEN v_i >= 9 THEN v_id::text ELSE '' END, true);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver,
                                   signed_by)
    VALUES (v_id, '[SMOKE] RB4C-D-' || v_i || '-' || v_suffix, v_order, v_customer, v_admin,
            CASE WHEN v_i >= 9 THEN 'completed' ELSE 'scheduled' END, current_date + 3,
            CASE WHEN v_i IN (7, 8) THEN v_driver END,
            CASE WHEN v_i >= 9 THEN '[SMOKE] RB4C signer' END);
    v_del := v_del || v_id;
  END LOOP;
  PERFORM set_config('crx.delivery_completion_evidence', '', true);
  FOR v_i IN 9..10 LOOP
    INSERT INTO public.delivery_remainders (original_delivery_id, order_id, order_item_id, customer_id, product_id,
                                            quantity_remaining, unit_size, status)
    VALUES (v_del[v_i], v_order, v_oi[v_i - 8], v_customer, v_product, 1, 'GL', 'pending');
  END LOOP;
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.cycle_counts (count_number, status, initiated_by)
    VALUES ('[SMOKE] RB4C-CC-' || v_i || '-' || v_suffix, 'in_progress', v_admin)
    RETURNING id INTO v_id;
    v_cc := v_cc || v_id;
    INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, review_status, reviewed_by, reviewed_at)
    VALUES ('[SMOKE] RB4C-BT-' || v_i || '-' || v_suffix, v_admin, v_customer, 'approved', v_admin, now())
    RETURNING id INTO v_id;
    v_bt := v_bt || v_id;
  END LOOP;

  -- --------------------------------------------------------------------------------------------
  -- a. submit_purchase_order (fail-first step).
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'submit'; v_keys := v_keys || v_key;
  v_res := public.submit_purchase_order(v_po[1], v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'submitted' THEN RAISE EXCEPTION 'SMOKE_FAIL: submit_purchase_order did not submit PO 1: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('submit_purchase_order replayed PO 1''s receipt as success for PO 2',
    format('SELECT public.submit_purchase_order(%L, %L, %L)', v_po[2], v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT status FROM public.purchase_orders WHERE id = v_po[2]) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused submit_purchase_order changed PO 2';
  END IF;
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('submit_purchase_order replayed admin A''s receipt to admin B',
    format('SELECT public.submit_purchase_order(%L, %L, %L)', v_po[1], v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('submit_purchase_order answered an applicator',
    format('SELECT public.submit_purchase_order(%L, %L, %L)', v_po[1], v_low, v_key), 'INSUFFICIENT_ROLE');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('submit_purchase_order', format('SELECT public.submit_purchase_order(%L, %L, %L)', v_po[1], v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('submit_purchase_order ran without an idempotency key',
    format('SELECT public.submit_purchase_order(%L, %L, NULL)', v_po[2], v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- b. cancel_purchase_order: the reason is part of the request.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'cancel-po'; v_keys := v_keys || v_key;
  v_res := public.cancel_purchase_order(v_po[3], 'Cancelled', v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'cancelled' THEN RAISE EXCEPTION 'SMOKE_FAIL: cancel_purchase_order did not cancel PO 3: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('cancel_purchase_order replayed PO 3''s receipt as success for PO 4',
    format('SELECT public.cancel_purchase_order(%L, %L, %L, %L)', v_po[4], 'Cancelled', v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT status FROM public.purchase_orders WHERE id = v_po[4]) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused cancel_purchase_order changed PO 4';
  END IF;
  PERFORM pg_temp.b4c_refused('cancel_purchase_order replayed a receipt for a different reason',
    format('SELECT public.cancel_purchase_order(%L, %L, %L, %L)', v_po[3], '[SMOKE] other reason', v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('cancel_purchase_order replayed admin A''s receipt to admin B',
    format('SELECT public.cancel_purchase_order(%L, %L, %L, %L)', v_po[3], 'Cancelled', v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('cancel_purchase_order answered an applicator',
    format('SELECT public.cancel_purchase_order(%L, %L, %L, %L)', v_po[3], 'Cancelled', v_low, v_key), 'INSUFFICIENT_ROLE: only admins or sales reps%');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('cancel_purchase_order', format('SELECT public.cancel_purchase_order(%L, %L, %L, %L)', v_po[3], 'Cancelled', v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('cancel_purchase_order ran without an idempotency key',
    format('SELECT public.cancel_purchase_order(%L, %L, %L, NULL)', v_po[4], 'Cancelled', v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- c. delete_purchase_order: its result names no PO, so only the binding keeps PO 6 safe.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'delete-po'; v_keys := v_keys || v_key;
  v_res := public.delete_purchase_order(v_po[5], v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'deleted' THEN RAISE EXCEPTION 'SMOKE_FAIL: delete_purchase_order did not delete PO 5: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('delete_purchase_order replayed PO 5''s receipt as success for PO 6',
    format('SELECT public.delete_purchase_order(%L, %L, %L)', v_po[6], v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF NOT EXISTS (SELECT 1 FROM public.purchase_orders WHERE id = v_po[6]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused delete_purchase_order removed PO 6';
  END IF;
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('delete_purchase_order replayed admin A''s receipt to admin B',
    format('SELECT public.delete_purchase_order(%L, %L, %L)', v_po[5], v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('delete_purchase_order answered an applicator',
    format('SELECT public.delete_purchase_order(%L, %L, %L)', v_po[5], v_low, v_key), 'Only admins can delete purchase orders');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('delete_purchase_order', format('SELECT public.delete_purchase_order(%L, %L, %L)', v_po[5], v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('delete_purchase_order ran without an idempotency key',
    format('SELECT public.delete_purchase_order(%L, %L, NULL)', v_po[6], v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- d. duplicate_quote: a retry that now carries a below-cost reason is the same request.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'dup'; v_keys := v_keys || v_key;
  v_res := public.duplicate_quote(v_quote[1], v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'duplicated' THEN RAISE EXCEPTION 'SMOKE_FAIL: duplicate_quote did not copy quote 1: %', v_res; END IF;
  v_n := (SELECT count(*) FROM public.quotes WHERE customer_id = v_customer);
  PERFORM pg_temp.b4c_refused('duplicate_quote replayed quote 1''s receipt as success for quote 2',
    format('SELECT public.duplicate_quote(%L, %L, %L)', v_quote[2], v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT count(*) FROM public.quotes WHERE customer_id = v_customer) <> v_n THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused duplicate_quote created a quote';
  END IF;
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('duplicate_quote replayed admin A''s receipt to admin B',
    format('SELECT public.duplicate_quote(%L, %L, %L)', v_quote[1], v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('duplicate_quote answered an applicator',
    format('SELECT public.duplicate_quote(%L, %L, %L)', v_quote[1], v_low, v_key), 'INSUFFICIENT_ROLE%');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('duplicate_quote', format('SELECT public.duplicate_quote(%L, %L, %L)', v_quote[1], v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_replays('duplicate_quote (with an approved reason)',
    format('SELECT public.duplicate_quote(%L, %L, %L, %L)', v_quote[1], v_admin, v_key, '[SMOKE] approved'), v_res);
  PERFORM pg_temp.b4c_refused('duplicate_quote ran without an idempotency key',
    format('SELECT public.duplicate_quote(%L, %L, NULL)', v_quote[2], v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- e. edit_delivery: every argument is part of the request.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'edit'; v_keys := v_keys || v_key;
  v_sql := 'SELECT public.edit_delivery(%L, p_delivery_notes => %L, p_performed_by => %L, p_idempotency_key => %L)';
  v_res := public.edit_delivery(v_del[1], p_delivery_notes => '[SMOKE] note', p_performed_by => v_admin, p_idempotency_key => v_key);
  IF v_res->>'status' IS DISTINCT FROM 'updated' THEN RAISE EXCEPTION 'SMOKE_FAIL: edit_delivery did not edit delivery 1: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('edit_delivery replayed delivery 1''s receipt as success for delivery 2',
    format(v_sql, v_del[2], '[SMOKE] note', v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT delivery_notes FROM public.deliveries WHERE id = v_del[2]) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused edit_delivery changed delivery 2';
  END IF;
  PERFORM pg_temp.b4c_refused('edit_delivery replayed a receipt for a different note',
    format(v_sql, v_del[1], '[SMOKE] other note', v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('edit_delivery replayed admin A''s receipt to admin B',
    format(v_sql, v_del[1], '[SMOKE] note', v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('edit_delivery answered an applicator',
    format(v_sql, v_del[1], '[SMOKE] note', v_low, v_key), 'INSUFFICIENT_ROLE');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('edit_delivery', format(v_sql, v_del[1], '[SMOKE] note', v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('edit_delivery ran without an idempotency key',
    format('SELECT public.edit_delivery(%L, p_delivery_notes => %L, p_performed_by => %L)', v_del[2], '[SMOKE] note', v_admin),
    'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- f. reassign_delivery.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'reassign'; v_keys := v_keys || v_key;
  v_sql := 'SELECT public.reassign_delivery(%L, %L, %L, %L)';
  v_res := public.reassign_delivery(v_del[3], v_driver, v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'reassigned' THEN RAISE EXCEPTION 'SMOKE_FAIL: reassign_delivery did not reassign delivery 3: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('reassign_delivery replayed delivery 3''s receipt as success for delivery 4',
    format(v_sql, v_del[4], v_driver, v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT assigned_driver FROM public.deliveries WHERE id = v_del[4]) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused reassign_delivery changed delivery 4';
  END IF;
  PERFORM pg_temp.b4c_refused('reassign_delivery replayed a receipt for a different driver',
    format(v_sql, v_del[3], v_admin_b, v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('reassign_delivery replayed admin A''s receipt to admin B',
    format(v_sql, v_del[3], v_driver, v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('reassign_delivery answered an applicator',
    format(v_sql, v_del[3], v_driver, v_low, v_key), 'Not authorized to reassign deliveries');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('reassign_delivery', format(v_sql, v_del[3], v_driver, v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('reassign_delivery ran without an idempotency key',
    format('SELECT public.reassign_delivery(%L, %L, %L)', v_del[4], v_driver, v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- g. batch_reschedule_deliveries: the delivery list and date are the request.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'reschedule'; v_keys := v_keys || v_key;
  v_sql := 'SELECT public.batch_reschedule_deliveries(%L::uuid[], %L::date, %L, %L)';
  v_res := public.batch_reschedule_deliveries(ARRAY[v_del[5]], v_date, v_admin, v_key);
  IF (v_res->>'count')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: batch_reschedule_deliveries did not move delivery 5: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('batch_reschedule_deliveries replayed delivery 5''s receipt as success for delivery 6',
    format(v_sql, ARRAY[v_del[6]], v_date, v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT scheduled_date FROM public.deliveries WHERE id = v_del[6]) IS DISTINCT FROM current_date + 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused batch_reschedule_deliveries changed delivery 6';
  END IF;
  PERFORM pg_temp.b4c_refused('batch_reschedule_deliveries replayed a receipt for a different date',
    format(v_sql, ARRAY[v_del[5]], v_date + 1, v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('batch_reschedule_deliveries replayed admin A''s receipt to admin B',
    format(v_sql, ARRAY[v_del[5]], v_date, v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('batch_reschedule_deliveries answered an applicator',
    format(v_sql, ARRAY[v_del[5]], v_date, v_low, v_key), 'Not authorized to reschedule deliveries');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('batch_reschedule_deliveries', format(v_sql, ARRAY[v_del[5]], v_date, v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('batch_reschedule_deliveries ran without an idempotency key',
    format('SELECT public.batch_reschedule_deliveries(%L::uuid[], %L::date, %L)', ARRAY[v_del[6]], v_date, v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- h. confirm_delivery, by the assigned driver. Its role check sits in the body, so another
  --    person's call is refused by the binding before anything is returned.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'confirm'; v_keys := v_keys || v_key;
  v_sql := 'SELECT public.confirm_delivery(%L, %L, %L)';
  PERFORM pg_temp.b4c_as(v_driver);
  v_res := public.confirm_delivery(v_del[7], v_driver, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'SMOKE_FAIL: confirm_delivery did not start delivery 7: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('confirm_delivery replayed delivery 7''s receipt as success for delivery 8',
    format(v_sql, v_del[8], v_driver, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT status FROM public.deliveries WHERE id = v_del[8]) IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused confirm_delivery changed delivery 8';
  END IF;
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('confirm_delivery replayed the driver''s receipt to admin B',
    format(v_sql, v_del[7], v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('confirm_delivery answered an applicator',
    format(v_sql, v_del[7], v_low, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_driver);
  PERFORM pg_temp.b4c_replays('confirm_delivery', format(v_sql, v_del[7], v_driver, v_key), v_res);
  PERFORM pg_temp.b4c_refused('confirm_delivery ran without an idempotency key',
    format('SELECT public.confirm_delivery(%L, %L)', v_del[8], v_driver), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');
  PERFORM pg_temp.b4c_as(v_admin);

  -- --------------------------------------------------------------------------------------------
  -- i. create_delivery_with_items: the items are the request.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'create-delivery'; v_keys := v_keys || v_key;
  v_sql := 'SELECT public.create_delivery_with_items(%L, %L, %L::date, %L::jsonb, p_idempotency_key => %L)';
  v_res := public.create_delivery_with_items(v_order, v_customer, v_date,
    jsonb_build_array(jsonb_build_object('order_item_id', v_oi[1], 'product_id', v_product, 'quantity', 1, 'unit_size', 'GL')),
    p_idempotency_key => v_key);
  IF v_res->>'delivery_id' IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: create_delivery_with_items did not create: %', v_res; END IF;
  v_n := (SELECT count(*) FROM public.deliveries WHERE order_id = v_order);
  PERFORM pg_temp.b4c_refused('create_delivery_with_items replayed line 1''s receipt as success for line 2',
    format(v_sql, v_order, v_customer, v_date,
      jsonb_build_array(jsonb_build_object('order_item_id', v_oi[2], 'product_id', v_product, 'quantity', 1, 'unit_size', 'GL')), v_key),
    'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT count(*) FROM public.deliveries WHERE order_id = v_order) <> v_n THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused create_delivery_with_items created a delivery';
  END IF;
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('create_delivery_with_items replayed admin A''s receipt to admin B',
    format(v_sql, v_order, v_customer, v_date,
      jsonb_build_array(jsonb_build_object('order_item_id', v_oi[1], 'product_id', v_product, 'quantity', 1, 'unit_size', 'GL')), v_key),
    'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('create_delivery_with_items answered an applicator',
    format(v_sql, v_order, v_customer, v_date,
      jsonb_build_array(jsonb_build_object('order_item_id', v_oi[1], 'product_id', v_product, 'quantity', 1, 'unit_size', 'GL')), v_key),
    'FORBIDDEN');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('create_delivery_with_items', format(v_sql, v_order, v_customer, v_date,
      jsonb_build_array(jsonb_build_object('order_item_id', v_oi[1], 'product_id', v_product, 'quantity', 1, 'unit_size', 'GL')), v_key), v_res);
  PERFORM pg_temp.b4c_refused('create_delivery_with_items ran without an idempotency key',
    format('SELECT public.create_delivery_with_items(%L, %L, %L::date, %L::jsonb)', v_order, v_customer, v_date,
      jsonb_build_array(jsonb_build_object('order_item_id', v_oi[2], 'product_id', v_product, 'quantity', 1, 'unit_size', 'GL'))),
    'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- j. create_followup_delivery.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'followup'; v_keys := v_keys || v_key;
  v_sql := 'SELECT public.create_followup_delivery(%L, %L::date, %L, %L)';
  v_res := public.create_followup_delivery(v_del[9], v_date, v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN RAISE EXCEPTION 'SMOKE_FAIL: create_followup_delivery did not create: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('create_followup_delivery replayed delivery 9''s receipt as success for delivery 10',
    format(v_sql, v_del[10], v_date, v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF EXISTS (SELECT 1 FROM public.delivery_remainders WHERE original_delivery_id = v_del[10] AND status IS DISTINCT FROM 'pending') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused create_followup_delivery changed delivery 10''s remainder';
  END IF;
  PERFORM pg_temp.b4c_refused('create_followup_delivery replayed a receipt for a different date',
    format(v_sql, v_del[9], v_date + 1, v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('create_followup_delivery replayed admin A''s receipt to admin B',
    format(v_sql, v_del[9], v_date, v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('create_followup_delivery answered an applicator',
    format(v_sql, v_del[9], v_date, v_low, v_key), 'INSUFFICIENT_ROLE');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('create_followup_delivery', format(v_sql, v_del[9], v_date, v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('create_followup_delivery ran without an idempotency key',
    format('SELECT public.create_followup_delivery(%L, %L::date, %L)', v_del[10], v_date, v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- k. cancel_cycle_count.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'cancel-count'; v_keys := v_keys || v_key;
  v_sql := 'SELECT public.cancel_cycle_count(%L, %L, %L)';
  v_res := public.cancel_cycle_count(v_cc[1], v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'cancelled' THEN RAISE EXCEPTION 'SMOKE_FAIL: cancel_cycle_count did not cancel count 1: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('cancel_cycle_count replayed count 1''s receipt as success for count 2',
    format(v_sql, v_cc[2], v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT status FROM public.cycle_counts WHERE id = v_cc[2]) IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused cancel_cycle_count changed count 2';
  END IF;
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('cancel_cycle_count replayed admin A''s receipt to admin B',
    format(v_sql, v_cc[1], v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('cancel_cycle_count answered an applicator',
    format(v_sql, v_cc[1], v_low, v_key), 'Admin access required to cancel a cycle count');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('cancel_cycle_count', format(v_sql, v_cc[1], v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('cancel_cycle_count ran without an idempotency key',
    format('SELECT public.cancel_cycle_count(%L, %L)', v_cc[2], v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- l. reverse_blend_ticket_approval: the reason is part of the request.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'reverse-blend'; v_keys := v_keys || v_key;
  v_sql := 'SELECT public.reverse_blend_ticket_approval(%L, %L, %L, %L)';
  v_res := public.reverse_blend_ticket_approval(v_bt[1], '[SMOKE] wrong ticket', v_admin, v_key);
  IF (v_res->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'SMOKE_FAIL: reverse_blend_ticket_approval did not reverse ticket 1: %', v_res; END IF;
  PERFORM pg_temp.b4c_refused('reverse_blend_ticket_approval replayed ticket 1''s receipt as success for ticket 2',
    format(v_sql, v_bt[2], '[SMOKE] wrong ticket', v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  IF (SELECT review_status FROM public.blend_tickets WHERE id = v_bt[2]) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused reverse_blend_ticket_approval changed ticket 2';
  END IF;
  PERFORM pg_temp.b4c_refused('reverse_blend_ticket_approval replayed a receipt for a different reason',
    format(v_sql, v_bt[1], '[SMOKE] other reason', v_admin, v_key), 'IDEMPOTENCY_INTENT_MISMATCH%');
  PERFORM pg_temp.b4c_as(v_admin_b);
  PERFORM pg_temp.b4c_refused('reverse_blend_ticket_approval replayed admin A''s receipt to admin B',
    format(v_sql, v_bt[1], '[SMOKE] wrong ticket', v_admin_b, v_key), 'IDEMPOTENCY_ACTOR_MISMATCH');
  PERFORM pg_temp.b4c_as(v_low);
  PERFORM pg_temp.b4c_refused('reverse_blend_ticket_approval answered an applicator',
    format(v_sql, v_bt[1], '[SMOKE] wrong ticket', v_low, v_key), 'INSUFFICIENT_ROLE');
  PERFORM pg_temp.b4c_as(v_admin);
  PERFORM pg_temp.b4c_replays('reverse_blend_ticket_approval', format(v_sql, v_bt[1], '[SMOKE] wrong ticket', v_admin, v_key), v_res);
  PERFORM pg_temp.b4c_refused('reverse_blend_ticket_approval ran without an idempotency key',
    format('SELECT public.reverse_blend_ticket_approval(%L, %L, %L)', v_bt[2], '[SMOKE] wrong ticket', v_admin), 'IDEMPOTENCY_KEY_REQUIRED%', '22023');

  -- --------------------------------------------------------------------------------------------
  -- m. Every fresh receipt is bound to its caller with a 64-hex fingerprint.
  -- --------------------------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.idempotency_keys
   WHERE idempotency_key = ANY (v_keys)
     AND request_actor_id = CASE WHEN idempotency_key = v_prefix || 'confirm' THEN v_driver ELSE v_admin END
     AND request_fingerprint ~ '^[0-9a-f]{64}$';
  IF v_n <> 12 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % of 12 fresh receipts are bound to the caller', v_n;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
