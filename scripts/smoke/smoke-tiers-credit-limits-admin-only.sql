-- ============================================================================
-- ROLLED-BACK smoke: price tiers and credit limits are admin-only; a booking's tier and planned
-- flag change only through save_quote
-- ----------------------------------------------------------------------------
-- Migration 20261109110000_tiers_credit_limits_admin_only.
--   A  A rep's direct update of a customer's tier is refused TIER_ADMIN_ONLY
--   B  A rep's save_customer that changes the credit limit is refused CREDIT_LIMIT_ADMIN_ONLY
--   C  A rep's save_customer that re-sends the unchanged tier and limit is accepted
--   D  A rep's new customer on the Settings Default Tier with no limit is accepted; with a limit, refused
--   E  An admin changes the tier and the credit limit
--   F  A direct API update of a booking's tier is refused QUOTE_TIER_PLANNED_VIA_SAVE_QUOTE, even
--      for an admin; a direct update that doesn't touch tier or the planned flag still works
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- customer and quote is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_c1 uuid;
  v_q uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_default int;
  v_tier int;
  v_fails text := '';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and an active sales rep';
  END IF;
  SELECT CASE WHEN setting_value IN ('2', '3') THEN setting_value::int ELSE 1 END INTO v_default
    FROM app_settings WHERE setting_key = 'default_tier';
  v_default := COALESCE(v_default, 1);
  v_tier := v_default % 3 + 1;   -- any tier other than the default

  -- Fixtures as the admin: a customer on the default tier with a $1,000 limit, and a draft booking.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO customers (farm_name, assigned_tier, credit_limit_cents, assigned_sales_rep)
    VALUES ('[SMOKE] Tier Farm ' || v_suffix, v_default, 100000, v_rep) RETURNING id INTO v_c1;
  INSERT INTO quotes (quote_number, customer_id, status, tier, created_by)
    VALUES ('SMK-TIER-' || v_suffix, v_c1, 'draft', v_default, v_admin) RETURNING id INTO v_q;

  -- As the rep, through the API role.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    UPDATE customers SET assigned_tier = v_tier WHERE id = v_c1;
    v_fails := v_fails || ' (A) a rep changed a tier directly;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'TIER_ADMIN_ONLY%' THEN v_fails := v_fails || ' (A) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  BEGIN
    PERFORM save_customer(v_c1, jsonb_build_object('farm_name', '[SMOKE] Tier Farm ' || v_suffix,
      'credit_limit_cents', 250000, 'row_version_expected', (SELECT row_version FROM customers WHERE id = v_c1)),
      '[]'::jsonb, v_rep, 'smk-tier-b-' || v_suffix);
    v_fails := v_fails || ' (B) a rep changed a credit limit through save_customer;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CREDIT_LIMIT_ADMIN_ONLY%' THEN v_fails := v_fails || ' (B) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  BEGIN
    PERFORM save_customer(v_c1, jsonb_build_object('farm_name', '[SMOKE] Tier Farm ' || v_suffix || ' edited',
      'assigned_tier', v_default, 'credit_limit_cents', 100000,
      'row_version_expected', (SELECT row_version FROM customers WHERE id = v_c1)),
      '[]'::jsonb, v_rep, 'smk-tier-c-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (C) an unchanged tier and limit were refused: ' || SQLERRM || ';';
  END;

  BEGIN
    PERFORM save_customer(NULL, jsonb_build_object('farm_name', '[SMOKE] Rep New Farm ' || v_suffix, 'assigned_sales_rep', v_rep,
      'assigned_tier', v_default), '[]'::jsonb, v_rep, 'smk-tier-d1-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (D) a default-tier new customer was refused: ' || SQLERRM || ';';
  END;
  BEGIN
    PERFORM save_customer(NULL, jsonb_build_object('farm_name', '[SMOKE] Rep Limit Farm ' || v_suffix, 'assigned_sales_rep', v_rep,
      'credit_limit_cents', 500000), '[]'::jsonb, v_rep, 'smk-tier-d2-' || v_suffix);
    v_fails := v_fails || ' (D) a rep created a customer with a credit limit;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CREDIT_LIMIT_ADMIN_ONLY%' THEN v_fails := v_fails || ' (D) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  -- As the admin.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    UPDATE customers SET assigned_tier = v_tier, credit_limit_cents = 250000 WHERE id = v_c1;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (E) the admin was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT assigned_tier FROM customers WHERE id = v_c1) IS DISTINCT FROM v_tier
     OR (SELECT credit_limit_cents FROM customers WHERE id = v_c1) IS DISTINCT FROM 250000 THEN
    v_fails := v_fails || ' (E) the admin''s tier or limit did not save;';
  END IF;

  BEGIN
    UPDATE quotes SET tier = v_tier WHERE id = v_q;
    v_fails := v_fails || ' (F) a booking tier changed directly;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'QUOTE_TIER_PLANNED_VIA_SAVE_QUOTE%' THEN v_fails := v_fails || ' (F) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  BEGIN
    UPDATE quotes SET header_notes = 'smoke note' WHERE id = v_q;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) a direct update without tier or planned flag was refused: ' || SQLERRM || ';';
  END;
  RESET ROLE;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL tiers and credit limits admin-only:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK tiers and credit limits admin-only: rep refused on tier and limit (direct, save_customer, create), unchanged re-save and default-tier create accepted, admin changed both, booking tier only through save_quote';
END
$smoke$;
