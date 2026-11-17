-- ============================================================================
-- ROLLED-BACK smoke: a chemical-sale draft can't post with tax that doesn't follow its sale's tax box
-- ----------------------------------------------------------------------------
-- Migration 20270124140000_draft_tax_follows_box_on_post (Sol HIGH on staging, 17 Nov).
--   A  Bill Split 50/50, untaxed; payer 2's draft can't be re-saved (a product line with no quantity). Ticking the
--      box taxes payer 1, keeps payer 2 untaxed (drafts_kept); the group post is refused (SALES_TAX_BOX_MISMATCH)
--      and nothing posts. Unticking again: the group posts.
--   B  The same, taxed first: unticking keeps payer 2 taxed; the group post is refused
--   C  The M4 switch off: a sale ticked earlier drafts an untaxed invoice (20270117140000), which posts
--   D  The same draft once the switch is back on: refused; unticking and ticking the box taxes it, and it posts
--
-- CONTAINER / LOCAL ONLY: the fixture replaces the lock test (_invoice_resave_locked_20270109) inside its own
-- rolled-back transaction, and completing deliveries draws invoice numbers.
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...',
-- so every fixture is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_payer2 uuid;
  v_product public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_inv1 uuid;
  v_inv2 uuid;
  v_group uuid;
  v_res jsonb;
  v_err text;
  v_fails text := '';
BEGIN
  IF to_regclass('public.billing_m4_switch') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs the M4 switch (20270117140000)';
  END IF;
  UPDATE public.billing_m4_switch SET enabled = true;
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_payer2 FROM customers WHERE is_active = true AND id <> v_customer ORDER BY created_at, id LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_customer IS NULL OR v_payer2 IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, two active customers and an active product with a cost';
  END IF;

  -- A sale (as smoke-sales-tax.sql's): optional 50/50 payer, the box, a full delivery, its draft(s). p_switch_on is the
  -- M4 switch while it drafts.
  EXECUTE $f$
    CREATE FUNCTION pg_temp.smk_sale(p_admin uuid, p_product uuid, p_cost numeric, p_customer uuid,
                                     p_payer2 uuid, p_tax boolean, p_switch_on boolean, p_tag text) RETURNS uuid
    LANGUAGE plpgsql AS $b$
    DECLARE v_order uuid; v_delivery uuid;
    BEGIN
      INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
        VALUES ('SMK-TBX-' || p_tag, p_customer, CURRENT_DATE, 'confirmed', p_admin) RETURNING id INTO v_order;
      PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
      INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
        total_units_needed, total_price, quantity_delivered, quantity_remaining)
        VALUES (v_order, p_product, '[SMOKE] Tax box', 'gal', p_cost + 1.37, p_cost, 100, (p_cost + 1.37) * 100, 0, 100);
      PERFORM set_config('app.crx_below_cost_operation', '', true);
      IF p_payer2 IS NOT NULL THEN
        INSERT INTO order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)
          VALUES (v_order, p_customer, '[SMOKE] main', 50, 0, true, 1), (v_order, p_payer2, '[SMOKE] payer 2', 50, 0, false, 2);
      END IF;
      IF p_tax THEN
        PERFORM set_order_sales_tax(v_order, true, 'smk-tbx-on-' || p_tag);
      END IF;
      UPDATE public.billing_m4_switch SET enabled = p_switch_on;
      INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
        VALUES ('SMK-TBX-' || p_tag, v_order, p_customer, 'scheduled', CURRENT_DATE, p_admin) RETURNING id INTO v_delivery;
      INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
        SELECT v_delivery, oi.id, oi.product_id, oi.total_units_needed, 'gal' FROM order_items oi WHERE oi.order_id = v_order;
      PERFORM confirm_delivery(v_delivery, p_admin, 'smk-tbx-confirm-' || p_tag);
      PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', p_admin, NULL, NULL, NULL,
        'smk-tbx-complete-' || p_tag, NULL, 'no_proof', 'Rolled-back smoke; tax box');
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      IF NOT EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo') THEN
        PERFORM create_invoice_for_unbilled_delivery(v_delivery, p_admin, 'smk-tbx-invoice-' || p_tag);
        SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      END IF;
      UPDATE public.billing_m4_switch SET enabled = true;
      RETURN v_order;
    END $b$;
    -- Lock a payer's draft as set_order_sales_tax sees it: the save path can't re-save it. Fixture: the lock test,
    -- replaced inside this rolled-back transaction, names the invoices listed in smk.locked (the real locks need a
    -- no-quantity Bill Split line or a field split, which the app's split never drafts and the guards refuse to write).
    CREATE FUNCTION pg_temp.smk_lock(p_invoice uuid) RETURNS void LANGUAGE plpgsql AS $b$
    BEGIN
      PERFORM set_config('smk.locked', COALESCE(current_setting('smk.locked', true), '') || p_invoice::text || ',', true);
      CREATE OR REPLACE FUNCTION public._invoice_resave_locked_20270109(p_invoice_id uuid)
       RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
      AS $l$ SELECT CASE WHEN strpos(COALESCE(current_setting('smk.locked', true), ''), p_invoice_id::text) > 0
                         THEN 'smoke: this draft can''t be re-saved' END $l$;
      IF public._invoice_resave_locked_20270109(p_invoice) IS NULL THEN
        RAISE EXCEPTION 'SMOKE_SETUP: the fixture did not lock the payer''s draft';
      END IF;
    END $b$;
    CREATE FUNCTION pg_temp.smk_post_group(p_group uuid, p_admin uuid, p_key text) RETURNS text LANGUAGE plpgsql AS $b$
    BEGIN
      PERFORM post_invoice_group(p_group, p_admin,
        (SELECT jsonb_object_agg(id, _invoice_post_version(id)) FROM invoices
          WHERE invoice_group_id = p_group AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL), p_key);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RETURN SQLERRM;
    END $b$;
    CREATE FUNCTION pg_temp.smk_post(p_invoice uuid, p_key text) RETURNS text LANGUAGE plpgsql AS $b$
    BEGIN
      PERFORM post_invoice(p_invoice, _invoice_post_version(p_invoice), p_key);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RETURN SQLERRM;
    END $b$;
    CREATE FUNCTION pg_temp.smk_as(p_user uuid) RETURNS void LANGUAGE sql AS $b$
      SELECT set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true),
             set_config('request.jwt.claim.sub', p_user::text, true) $b$;
  $f$;
  PERFORM pg_temp.smk_as(v_admin);

  -- A: untaxed Bill Split; payer 2 locked; ticked.
  v_order := pg_temp.smk_sale(v_admin, v_product.id, v_product.current_cost, v_customer, v_payer2, false, true, 'a-' || v_suffix);
  SELECT id, invoice_group_id INTO v_inv1, v_group FROM invoices WHERE order_id = v_order AND customer_id = v_customer AND status = 'draft';
  SELECT id INTO v_inv2 FROM invoices WHERE order_id = v_order AND customer_id = v_payer2 AND status = 'draft';
  IF v_group IS NULL OR v_inv2 IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: (A) the Bill Split did not draft two payers'; END IF;
  PERFORM pg_temp.smk_lock(v_inv2);
  v_res := set_order_sales_tax(v_order, true, 'smk-tbx-a-on-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF NOT (v_res -> 'drafts_kept') @> to_jsonb(ARRAY[v_inv2])
     OR NOT EXISTS (SELECT 1 FROM invoice_sales_tax_rates WHERE invoice_id = v_inv1)
     OR EXISTS (SELECT 1 FROM invoice_sales_tax_rates WHERE invoice_id = v_inv2) THEN
    v_fails := v_fails || ' (A) ticking did not tax payer 1 and keep payer 2: ' || v_res::text || ';';
  END IF;
  v_err := pg_temp.smk_post_group(v_group, v_admin, 'smk-tbx-a-post-' || v_suffix);
  IF v_err IS NULL OR v_err NOT LIKE 'SALES_TAX_BOX_MISMATCH:%' THEN
    v_fails := v_fails || ' (A) the group with an untaxed payer on a ticked sale was not refused: ' || COALESCE(v_err, 'it posted') || ';';
  END IF;
  IF EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'draft') THEN
    v_fails := v_fails || ' (A) a payer posted after the refusal;';
  END IF;
  -- Unticked again, both drafts are untaxed and the group posts.
  PERFORM set_order_sales_tax(v_order, false, 'smk-tbx-a-off-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_err := pg_temp.smk_post_group(v_group, v_admin, 'smk-tbx-a-post2-' || v_suffix);
  IF v_err IS NOT NULL OR EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'posted') THEN
    v_fails := v_fails || ' (A) the group whose tax follows the box did not post: ' || COALESCE(v_err, 'a payer is not posted') || ';';
  END IF;

  -- B: taxed Bill Split; payer 2 locked; unticked.
  v_order := pg_temp.smk_sale(v_admin, v_product.id, v_product.current_cost, v_customer, v_payer2, true, true, 'b-' || v_suffix);
  SELECT id, invoice_group_id INTO v_inv1, v_group FROM invoices WHERE order_id = v_order AND customer_id = v_customer AND status = 'draft';
  SELECT id INTO v_inv2 FROM invoices WHERE order_id = v_order AND customer_id = v_payer2 AND status = 'draft';
  PERFORM pg_temp.smk_lock(v_inv2);
  v_res := set_order_sales_tax(v_order, false, 'smk-tbx-b-off-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  IF NOT (v_res -> 'drafts_kept') @> to_jsonb(ARRAY[v_inv2])
     OR NOT EXISTS (SELECT 1 FROM invoice_sales_tax_rates WHERE invoice_id = v_inv2) THEN
    v_fails := v_fails || ' (B) unticking did not keep payer 2 taxed: ' || v_res::text || ';';
  END IF;
  v_err := pg_temp.smk_post_group(v_group, v_admin, 'smk-tbx-b-post-' || v_suffix);
  IF v_err IS NULL OR v_err NOT LIKE 'SALES_TAX_BOX_MISMATCH:%' THEN
    v_fails := v_fails || ' (B) the group with a taxed payer on an unticked sale was not refused: ' || COALESCE(v_err, 'it posted') || ';';
  END IF;
  IF EXISTS (SELECT 1 FROM invoices WHERE invoice_group_id = v_group AND status <> 'draft') THEN
    v_fails := v_fails || ' (B) a payer posted after the refusal;';
  END IF;

  -- C: ticked while on, drafted while the switch is off: untaxed by design, and it posts.
  v_order := pg_temp.smk_sale(v_admin, v_product.id, v_product.current_cost, v_customer, NULL, true, false, 'c-' || v_suffix);
  SELECT id INTO v_inv1 FROM invoices WHERE order_id = v_order AND status = 'draft';
  IF EXISTS (SELECT 1 FROM invoice_sales_tax_rates WHERE invoice_id = v_inv1) THEN
    v_fails := v_fails || ' (C) a draft made while the switch was off was taxed;';
  END IF;
  UPDATE public.billing_m4_switch SET enabled = false;
  v_err := pg_temp.smk_post(v_inv1, 'smk-tbx-c-post-' || v_suffix);
  IF v_err IS NOT NULL OR (SELECT status FROM invoices WHERE id = v_inv1) <> 'posted' THEN
    v_fails := v_fails || ' (C) an untaxed draft with the switch off did not post: ' || COALESCE(v_err, 'not posted') || ';';
  END IF;
  UPDATE public.billing_m4_switch SET enabled = true;

  -- D: the same kind of draft once the switch is on: refused; untick and tick, and it posts taxed.
  v_order := pg_temp.smk_sale(v_admin, v_product.id, v_product.current_cost, v_customer, NULL, true, false, 'd-' || v_suffix);
  SELECT id INTO v_inv1 FROM invoices WHERE order_id = v_order AND status = 'draft';
  v_err := pg_temp.smk_post(v_inv1, 'smk-tbx-d-post-' || v_suffix);
  IF v_err IS NULL OR v_err NOT LIKE 'SALES_TAX_BOX_MISMATCH:%' THEN
    v_fails := v_fails || ' (D) an untaxed draft on a ticked sale with the switch on was not refused: ' || COALESCE(v_err, 'it posted') || ';';
  END IF;
  PERFORM set_order_sales_tax(v_order, false, 'smk-tbx-d-off-' || v_suffix);
  PERFORM set_order_sales_tax(v_order, true, 'smk-tbx-d-on-' || v_suffix);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  v_err := pg_temp.smk_post(v_inv1, 'smk-tbx-d-post2-' || v_suffix);
  IF v_err IS NOT NULL OR (SELECT status FROM invoices WHERE id = v_inv1) <> 'posted'
     OR NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_inv1 AND charge_type = 'sales_tax') THEN
    v_fails := v_fails || ' (D) re-ticked, the draft did not post taxed: ' || COALESCE(v_err, 'no tax line') || ';';
  END IF;

  -- E: a mismatched draft can't go draft -> unposted either (a legal step that would skip the posting check).
  v_order := pg_temp.smk_sale(v_admin, v_product.id, v_product.current_cost, v_customer, NULL, true, false, 'e-' || v_suffix);
  SELECT id INTO v_inv1 FROM invoices WHERE order_id = v_order AND status = 'draft';
  BEGIN
    UPDATE invoices SET status = 'unposted' WHERE id = v_inv1;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'SALES_TAX_BOX_MISMATCH:%' OR (SELECT status FROM invoices WHERE id = v_inv1) <> 'draft' THEN
    v_fails := v_fails || ' (E) an untaxed draft on a ticked sale moved to unposted: ' || COALESCE(v_err, 'it moved') || ';';
  END IF;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: a draft whose tax doesn''t follow its sale''s box can''t post (A-E)';
END
$smoke$;
