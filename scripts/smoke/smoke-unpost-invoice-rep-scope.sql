-- ============================================================================
-- ROLLED-BACK smoke: a rep unposts only invoices under their own name
-- ----------------------------------------------------------------------------
-- Migration 20261123140000_unpost_invoice_rep_scope (Mason, 2026-11-06: the same rule as posting).
--   A  A rep unposts an invoice where they are the salesperson
--   B  A rep is refused on another person's invoice (INVOICE_SCOPE_DENIED); it stays posted, no audit row
--   C  No salesperson: the creator can, another rep can't
--   D  An admin unposts anyone's invoice
--   E  A group with one member under someone else's name is refused whole; the group stays posted
--   F  A group all under the rep's name unposts; an admin unposts any group
--   G  One member of a group still goes through the group call (GROUP_UNPOST_REQUIRED)
--   H  A retry with the same key gets its saved result after the invoice is reassigned
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with RAISE EXCEPTION
-- 'SMOKE_PASS_ROLLBACK ...', so every fixture is rolled back. Any other error text is a failure.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_rep2 uuid;
  v_cust uuid;
  v_sfx text := substr(gen_random_uuid()::text, 1, 8);
  v_inv uuid;
  v_group uuid;
  v_fails text := '';
  v_audit int;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM profiles WHERE role = 'sales_rep' AND is_active ORDER BY id LIMIT 1;
  SELECT id INTO v_rep2 FROM profiles WHERE role = 'sales_rep' AND is_active AND id <> v_rep ORDER BY id LIMIT 1;
  IF v_admin IS NULL OR v_rep2 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin and two active reps';
  END IF;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] UNPOST SCOPE ' || v_sfx) RETURNING id INTO v_cust;

  CREATE FUNCTION pg_temp.smk_as(p uuid) RETURNS void LANGUAGE sql AS $f$
    SELECT set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated')::text, true),
           set_config('request.jwt.claim.sub', p::text, true);
  $f$;
  -- A posted field invoice. Posted as admin, so the rep rule on posting isn't what's under test.
  CREATE FUNCTION pg_temp.smk_posted(p_tag text, p_cust uuid, p_salesman uuid, p_creator uuid, p_group uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $f$
  DECLARE v uuid;
  BEGIN
    INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, salesman_id, invoice_group_id)
      VALUES ('[SMOKE] UPS-' || p_tag, p_cust, 'field_application', 'draft', CURRENT_DATE, 12300, p_creator, p_salesman, p_group)
      RETURNING id INTO v;
    IF p_group IS NULL THEN
      PERFORM post_invoice(v, public._invoice_post_version(v), '[SMOKE] ups-post-' || p_tag);
    END IF;
    RETURN v;
  END $f$;
  PERFORM pg_temp.smk_as(v_admin);

  -- A
  v_inv := pg_temp.smk_posted('a' || v_sfx, v_cust, v_rep, v_admin);
  PERFORM pg_temp.smk_as(v_rep);
  BEGIN
    PERFORM unpost_invoice(v_inv, v_rep, '[SMOKE] ups-a-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (A) a rep was refused on their own invoice: ' || SQLERRM || ';';
  END;
  IF (SELECT status FROM invoices WHERE id = v_inv) <> 'unposted' THEN
    v_fails := v_fails || ' (A) their own invoice did not unpost;';
  END IF;

  -- B
  PERFORM pg_temp.smk_as(v_admin);
  v_inv := pg_temp.smk_posted('b' || v_sfx, v_cust, v_rep2, v_admin);
  PERFORM pg_temp.smk_as(v_rep);
  BEGIN
    PERFORM unpost_invoice(v_inv, v_rep, '[SMOKE] ups-b-' || v_sfx);
    v_fails := v_fails || ' (B) a rep unposted another rep''s invoice;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_SCOPE_DENIED%' THEN v_fails := v_fails || ' (B) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  SELECT count(*) INTO v_audit FROM financial_audit_log WHERE entity_id = v_inv AND operation_type = 'invoice_unposted';
  IF (SELECT status FROM invoices WHERE id = v_inv) <> 'posted' OR v_audit <> 0 THEN
    v_fails := v_fails || ' (B) the refused call left a change;';
  END IF;

  -- C
  PERFORM pg_temp.smk_as(v_admin);
  v_inv := pg_temp.smk_posted('c1' || v_sfx, v_cust, NULL, v_rep);
  PERFORM pg_temp.smk_as(v_rep2);
  BEGIN
    PERFORM unpost_invoice(v_inv, v_rep2, '[SMOKE] ups-c2-' || v_sfx);
    v_fails := v_fails || ' (C) a rep unposted an invoice another rep created;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_SCOPE_DENIED%' THEN v_fails := v_fails || ' (C) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  PERFORM pg_temp.smk_as(v_rep);
  BEGIN
    PERFORM unpost_invoice(v_inv, v_rep, '[SMOKE] ups-c1-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (C) the creator was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT status FROM invoices WHERE id = v_inv) <> 'unposted' THEN
    v_fails := v_fails || ' (C) the creator''s invoice did not unpost;';
  END IF;

  -- D
  PERFORM pg_temp.smk_as(v_admin);
  v_inv := pg_temp.smk_posted('d' || v_sfx, v_cust, v_rep2, v_rep2);
  BEGIN
    PERFORM unpost_invoice(v_inv, v_admin, '[SMOKE] ups-d-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (D) an admin was refused: ' || SQLERRM || ';';
  END;
  IF (SELECT status FROM invoices WHERE id = v_inv) <> 'unposted' THEN
    v_fails := v_fails || ' (D) the admin''s unpost did not happen;';
  END IF;

  -- E and G: one member under another rep's name.
  v_group := gen_random_uuid();
  v_inv := pg_temp.smk_posted('e1' || v_sfx, v_cust, v_rep, v_admin, v_group);
  PERFORM pg_temp.smk_posted('e2' || v_sfx, v_cust, v_rep2, v_admin, v_group);
  PERFORM post_invoice_group(v_group, v_admin,
    (SELECT jsonb_object_agg(id, public._invoice_post_version(id)) FROM invoices WHERE invoice_group_id = v_group),
    '[SMOKE] ups-e-post-' || v_sfx);
  PERFORM pg_temp.smk_as(v_rep);
  BEGIN
    PERFORM unpost_invoice_group(v_group, v_rep, '[SMOKE] ups-e-' || v_sfx);
    v_fails := v_fails || ' (E) a rep unposted a group with another rep''s member;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVOICE_SCOPE_DENIED%' THEN v_fails := v_fails || ' (E) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;
  IF EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'posted') THEN
    v_fails := v_fails || ' (E) the refused call changed the group;';
  END IF;
  BEGIN
    PERFORM unpost_invoice(v_inv, v_rep, '[SMOKE] ups-g-' || v_sfx);
    v_fails := v_fails || ' (G) one member left a group;';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'GROUP_UNPOST_REQUIRED%' THEN v_fails := v_fails || ' (G) wrong refusal: ' || SQLERRM || ';'; END IF;
  END;

  -- F: an admin unposts that group; a rep unposts a group all under their name.
  PERFORM pg_temp.smk_as(v_admin);
  BEGIN
    PERFORM unpost_invoice_group(v_group, v_admin, '[SMOKE] ups-f-admin-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) an admin was refused on a group: ' || SQLERRM || ';';
  END;
  v_group := gen_random_uuid();
  PERFORM pg_temp.smk_posted('f1' || v_sfx, v_cust, v_rep, v_admin, v_group);
  PERFORM pg_temp.smk_posted('f2' || v_sfx, v_cust, NULL, v_rep, v_group);
  PERFORM post_invoice_group(v_group, v_admin,
    (SELECT jsonb_object_agg(id, public._invoice_post_version(id)) FROM invoices WHERE invoice_group_id = v_group),
    '[SMOKE] ups-f-post-' || v_sfx);
  PERFORM pg_temp.smk_as(v_rep);
  BEGIN
    PERFORM unpost_invoice_group(v_group, v_rep, '[SMOKE] ups-f-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F) a rep was refused on their own group: ' || SQLERRM || ';';
  END;
  IF EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'unposted') THEN
    v_fails := v_fails || ' (F) their own group did not unpost;';
  END IF;

  -- H: a rep's retry with the same key gets its saved result, even if the invoice has since been reassigned.
  PERFORM pg_temp.smk_as(v_admin);
  v_inv := pg_temp.smk_posted('h' || v_sfx, v_cust, v_rep, v_admin);
  PERFORM pg_temp.smk_as(v_rep);
  PERFORM unpost_invoice(v_inv, v_rep, '[SMOKE] ups-h-' || v_sfx);
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE invoices SET salesman_id = v_rep2 WHERE id = v_inv;
  PERFORM set_config('app.admin_override', 'false', true);
  BEGIN
    PERFORM unpost_invoice(v_inv, v_rep, '[SMOKE] ups-h-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (H) a retry was refused after the invoice moved: ' || SQLERRM || ';';
  END;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL unpost rep scope:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK unpost rep scope: a rep unposts only their own invoices and groups, an admin any';
END
$smoke$;
