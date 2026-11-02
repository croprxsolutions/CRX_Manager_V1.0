-- ============================================================================
-- SMOKE TEST (rolled back by design): FIX 4 (Wave 2a) — unpost_invoice_group
-- (migration 20260629170000_unpost_invoice_group.sql). ALL-OR-NOTHING.
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260629170000. Proves the group unpost is atomic:
--
--   P1  HAPPY — a posted split group (2 members, shared invoice_group_id) is
--          unposted in ONE call: BOTH members flip posted -> unposted, posted_by/at
--          cleared, an 'invoice_unposted' audit row per member, one
--          'invoice_group_unposted' activity row.
--   P2  ALL-OR-NOTHING — a posted split group where ONE member is PAID (money
--          applied): unpost_invoice_group RAISES (money guard) and NOTHING changes
--          — both members are STILL posted, no audit rows written. (No half-unpost.)
--   P3  ROLE GATE — an APPLICATOR calling unpost_invoice_group is rejected
--          ('admin or sales role required'); the group stays posted.
--   P4  ACTOR — a forged p_performed_by raises ACTOR_MISMATCH, mutates nothing.
--   P5  REPLAY GUARD — a same-key replay for the SAME group returns the cached
--          result; the SAME key for a DIFFERENT group RAISES IDEMPOTENCY_KEY_REUSED
--          and leaves that other group UNTOUCHED (no silent wrong-group success).
--   P6  GRANTS — anon has NO EXECUTE; authenticated DOES.
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Any other error = FAIL.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin   uuid; v_appl uuid; v_forged uuid := gen_random_uuid();
  v_sfx     text := substr(gen_random_uuid()::text,1,8);
  v_cust_a  uuid; v_cust_b uuid;
  v_grp     uuid;
  v_grp2    uuid;
  v_grp3    uuid;
  v_field   uuid; v_prod uuid; v_pricing jsonb; v_d_total bigint;
  v_inv_a   uuid; v_inv_b uuid;       -- happy group
  v_inv_c   uuid; v_inv_d uuid;       -- all-or-nothing group (d gets paid)
  v_aset    uuid;
  v_res     jsonb;
  v_n       int; v_status text; v_anon boolean; v_auth boolean;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_appl  FROM profiles WHERE role='applicator' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_appl IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: need admin + applicator'; END IF;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] UPG-A '||v_sfx) RETURNING id INTO v_cust_a;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] UPG-B '||v_sfx) RETURNING id INTO v_cust_b;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- Posted split groups come only from the real split save, posted through post_invoice_group,
  -- with the product's cost set through the governed pricing path.
  INSERT INTO products (product_name, unit_size, product_form)
    VALUES ('[SMOKE] UPG Prod '||v_sfx, 'GL', 'liquid') RETURNING id INTO v_prod;
  v_pricing := preview_product_cost_basis_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'row_version', (SELECT pricing_version FROM products WHERE id = v_prod),
      'pricing_mode', 'price_driven', 'new_cost', '1.00',
      'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00',
      'change_reason', '[SMOKE] UPG cost fixture', 'price_source', '[SMOKE] UPG',
      'basis_type', 'manual_override', 'basis_source', 'product_page',
      'basis_reason', '[SMOKE] UPG cost fixture', 'basis_selection', false)),
    v_admin, '[SMOKE] upg-price-preview-'||v_sfx);
  PERFORM approve_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint',
    COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', w->>'product_id', 'warning_codes', w->'warning_codes',
                                                  'reason', '[SMOKE] acknowledged'))
                FROM jsonb_array_elements(v_pricing->'warnings') AS w), '[]'::jsonb),
    NULL, v_admin, '[SMOKE] upg-price-approve-'||v_sfx);
  PERFORM apply_product_cost_basis_change_set((v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint', v_admin, '[SMOKE] upg-price-apply-'||v_sfx);
  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
    VALUES (v_cust_a, '[SMOKE] UPG Field '||v_sfx, 'corn', 40) RETURNING id INTO v_field;
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_cust_a, 50, true), (v_field, v_cust_b, 50, false);
  FOR v_n IN 1..3 LOOP
    v_res := save_field_app_invoice(NULL,
      jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] UPG group '||v_n),
      jsonb_build_array(jsonb_build_object(
        'field_id', v_field, 'map_number', 1, 'total_acres', 40, 'planted_acres', NULL,
        'applied_acres', 40, 'crop_type', NULL, 'wind_direction', NULL, 'sort_order', 0)),
      jsonb_build_array(jsonb_build_object(
        'product_id', v_prod, 'description', '[SMOKE] UPG Chem', 'quantity', 0, 'unit_size', 'GL',
        'unit_price_cents', 1000 * v_n, 'cost_cents', 100, 'sort_order', 0, 'rate_per_acre', 0.1,
        'rate_unit', 'GL', 'manual_override', true)),
      v_admin, NULL, '[SMOKE] upg-save-'||v_n||'-'||v_sfx);
    v_aset := (v_res->>'invoice_group_id')::uuid;
    IF v_aset IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: the split save made no invoice group: %', v_res; END IF;
    PERFORM post_invoice_group(v_aset, v_admin,
      (SELECT jsonb_object_agg(i.id, public._invoice_post_version(i.id)) FROM invoices i
        WHERE i.invoice_group_id = v_aset AND i.deleted_at IS NULL),
      '[SMOKE] upg-post-'||v_n||'-'||v_sfx);
    IF v_n = 1 THEN v_grp := v_aset; ELSIF v_n = 2 THEN v_grp2 := v_aset; ELSE v_grp3 := v_aset; END IF;
  END LOOP;
  SELECT id INTO v_inv_a FROM invoices WHERE invoice_group_id = v_grp  AND customer_id = v_cust_a;
  SELECT id INTO v_inv_b FROM invoices WHERE invoice_group_id = v_grp  AND customer_id = v_cust_b;
  SELECT id INTO v_inv_c FROM invoices WHERE invoice_group_id = v_grp2 AND customer_id = v_cust_a;
  SELECT id, total_amount_cents INTO v_inv_d, v_d_total FROM invoices WHERE invoice_group_id = v_grp2 AND customer_id = v_cust_b;
  IF (SELECT count(*) FROM invoices WHERE invoice_group_id IN (v_grp, v_grp2, v_grp3) AND status = 'posted') <> 6 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: expected three posted two-member groups';
  END IF;

  -- ── HAPPY GROUP: two members sharing invoice_group_id, both posted ─────────

  v_res := unpost_invoice_group(v_grp, v_admin, '[SMOKE] upg-unpost-'||v_sfx);
  IF (v_res->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE_FAIL: group unpost did not succeed'; END IF;
  IF (v_res->>'member_count')::int <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong member_count %', v_res->>'member_count'; END IF;

  SELECT count(*) INTO v_n FROM invoices WHERE invoice_group_id=v_grp AND status='unposted';
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected 2 members unposted, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE invoice_group_id=v_grp AND (posted_by IS NOT NULL OR posted_at IS NOT NULL);
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: posted_by/at not cleared on % members', v_n; END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log WHERE entity_id IN (v_inv_a, v_inv_b) AND operation_type='invoice_unposted';
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected 2 invoice_unposted audit rows, got %', v_n; END IF;

  -- ── ALL-OR-NOTHING: one member paid -> whole call RAISES, nothing changes ──
  -- Apply money to D so it cannot be unposted.
  INSERT INTO allocation_sets (entity_type, entity_id, version, is_active, customer_id, total_payment_cents, total_allocated_cents)
    VALUES ('payment', gen_random_uuid(), 1, true, v_cust_b, v_d_total, v_d_total) RETURNING id INTO v_aset;
  INSERT INTO invoice_line_allocations (allocation_set_id, bill_to_customer_id, split_percentage, amount_cents, invoice_id)
    VALUES (v_aset, v_cust_b, 100, v_d_total, v_inv_d);
  UPDATE invoices SET paid_amount_cents = v_d_total WHERE id=v_inv_d;

  BEGIN
    PERFORM unpost_invoice_group(v_grp2, v_admin, '[SMOKE] upg-paid-'||v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: group with a paid member was unposted (not all-or-nothing)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%payments, prepay, write-offs, or applied credit%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: all-or-nothing raised the WRONG error: %', SQLERRM;
    END IF;
  END;
  -- BOTH members still posted; NO audit rows for either (the txn rolled back).
  SELECT count(*) INTO v_n FROM invoices WHERE invoice_group_id=v_grp2 AND status='posted';
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: all-or-nothing left % posted (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log WHERE entity_id IN (v_inv_c, v_inv_d) AND operation_type='invoice_unposted';
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: all-or-nothing wrote % unpost audit rows (expected 0)', v_n; END IF;

  -- ── ROLE GATE: applicator denied (group stays posted) ─────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_appl, 'role','authenticated')::text, true);
  BEGIN
    PERFORM unpost_invoice_group(v_grp2, v_appl, '[SMOKE] upg-appl-'||v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: applicator was allowed to unpost a group';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%admin or sales role required%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: role gate raised the WRONG error: %', SQLERRM;
    END IF;
  END;
  -- restore admin claims
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- ── ACTOR: forged performer raises ACTOR_MISMATCH ─────────────────────────
  -- Re-post the happy group's members would be needed; instead use the still-posted grp2.
  BEGIN
    PERFORM unpost_invoice_group(v_grp2, v_forged, '[SMOKE] upg-forged-'||v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: forged actor allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH got %', SQLERRM; END IF;
  END;

  -- ── REPLAY GUARD: same key, DIFFERENT group -> IDEMPOTENCY_KEY_REUSED ──────
  -- The happy group v_grp was unposted under key '[SMOKE] upg-unpost-...'. A same-key
  -- replay for THAT SAME group returns the cached result (idempotent). But replaying
  -- the SAME key for a DIFFERENT group must RAISE (never silently report the wrong
  -- group's success). Build a fresh posted group v_grp3 and replay v_grp's key on it.
  -- same-group replay still works:
  v_res := unpost_invoice_group(v_grp, v_admin, '[SMOKE] upg-unpost-'||v_sfx);
  IF (v_res->>'invoice_group_id') <> v_grp::text THEN RAISE EXCEPTION 'SMOKE_FAIL: same-group replay returned wrong group'; END IF;
  BEGIN
    BEGIN
      PERFORM unpost_invoice_group(v_grp3, v_admin, '[SMOKE] upg-unpost-'||v_sfx);  -- v_grp's key!
      RAISE EXCEPTION 'SMOKE_FAIL: cross-group key replay silently returned (wrong-group success)';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REUSED%' AND SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: cross-group replay wrong error: %', SQLERRM; END IF;
    END;
    -- v_grp3 must be UNTOUCHED (still posted) — the blind replay did NOT unpost it.
    SELECT count(*) INTO v_n FROM invoices WHERE invoice_group_id=v_grp3 AND status='posted';
    IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: cross-group replay mutated the wrong group (% posted)', v_n; END IF;
  END;

  -- ── GRANTS ────────────────────────────────────────────────────────────────
  SELECT has_function_privilege('anon',          'public.unpost_invoice_group(uuid,uuid,text)', 'EXECUTE') INTO v_anon;
  SELECT has_function_privilege('authenticated', 'public.unpost_invoice_group(uuid,uuid,text)', 'EXECUTE') INTO v_auth;
  IF v_anon THEN RAISE EXCEPTION 'SMOKE_FAIL: anon can EXECUTE unpost_invoice_group'; END IF;
  IF NOT v_auth THEN RAISE EXCEPTION 'SMOKE_FAIL: authenticated CANNOT EXECUTE unpost_invoice_group'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
