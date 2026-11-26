-- ============================================================================
-- ROLLED-BACK smoke: a return still credits after the sale's sales-tax box changes (issue #2066)
-- ----------------------------------------------------------------------------
-- Migration 20270311100000_return_tax_change_credit. Mason's rule (22 Nov): when tax changed after the return was
-- made, its credit re-prices to the taxed share, and is never more than the customer was charged on the posted
-- invoice, tax included.
--   A  Untaxed sale, return of 4 of 10 made and received at the order price; the box is ticked and the draft posts
--      taxed. The credit goes through at 4/10 of the posted total (tax included), not the order price, and the
--      return of the other 6 credits the rest: the two credits add up to the posted total, never more.
--   B  Same, but the box is ticked and the draft posts before the return is received: receive and credit both go
--      through at the taxed share, and the re-price is in the financial audit log.
--   C  Control: no tax change. The return credits the order price, as before.
--   D  Two returns of 4 made before the box is ticked: crediting one is refused while the other still carries the old
--      price (RETURN_REPRICE_OTHER_RETURN_PENDING) and nothing of the other changes; once the other is cancelled the
--      first credits 4/10 of the posted total.
--   E  A discount set on the draft after the whole sale was returned and received: the credit is the discounted
--      posted total, not refused because the stored order price is above what was billed.
--   F  create_return records how it priced each line: 'order_price' before the box is ticked, 'billed_share' after,
--      and a re-priced line keeps 'order_price' (its origin), so it re-prices again if more taxed lots post.
--   H  The first invoice posts untaxed, the box is ticked while the second is a draft, the return is received, then
--      the second posts: the credit is 4/10 of both posted invoices (only a POSTED tax or discount line re-prices).
--   G  While a return made before the tick is open, a newer return is refused (RETURN_OLDER_RETURN_AT_ORDER_PRICE);
--      once the older one is credited at its taxed share, the newer one is made and credits; each 4/10, together 8/10.
--   I  Mason's rule (26 Nov: unbilled units can be credited while the taxed lot is still a draft). 5 posted untaxed,
--      the box ticked, 5 more on a taxed draft; a return of 8 is received and credited while that lot is a draft. The
--      credit is 8/10 of both lots (the draft's tax included), its tax is in the ledger, the draft then posts, and the
--      return of the last 2 credits the rest: together exactly what was charged, and the ledger refunds all the tax.
--   J  Units on no invoice at all stay refused once the sale has tax (RETURN_UNITS_NOT_INVOICED).
--   K  Same as I with the first lot posted TAXED: the return of 8 credits 8/10 of both lots, then the last 2 the rest.
--   L  Tax-on comes from the order's box (Taha, 26 Nov): with the box ticked and the line on no live invoice at all,
--      a return made at the order price is refused (RETURN_UNITS_NOT_INVOICED), not credited at the order price.
--   M  A line from before this change ('unrecorded') keeps staging's refusal while a taxed draft holds the line:
--      5 posted untaxed, 5 on a taxed draft, an unrecorded return of 8 is refused (RETURN_SPLIT_SHARE_REPRICED).
--
-- Tax is written at commit (deferred triggers). This file runs as ONE statement, so each step ends with
-- SET CONSTRAINTS ALL IMMEDIATE / DEFERRED: the commit point of that call in the app.
--
-- HOW TO RUN: execute this whole file as ONE statement (psql -c, or Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture is rolled back.
-- Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_product public.products%ROWTYPE;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_order uuid;
  v_invoice uuid;
  v_item uuid;
  v_ret uuid;
  v_ret2 uuid;
  v_posted bigint;
  v_credit bigint;
  v_credit2 bigint;
  v_fails text := '';
BEGIN
  IF to_regclass('public.billing_m4_switch') IS NOT NULL THEN UPDATE public.billing_m4_switch SET enabled = true; END IF;
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM customers WHERE is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT * INTO v_product FROM products
   WHERE is_active = true AND current_cost > 0 AND current_cost = round(current_cost, 2)
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_customer IS NULL OR v_product.id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: needs an active admin, an active customer and an active product with a cost';
  END IF;

  EXECUTE $f$
    -- An untaxed sale of 10 at cost + $1.37, delivered, with its untaxed draft.
    CREATE FUNCTION pg_temp.rtx_sale(p_admin uuid, p_product uuid, p_cost numeric, p_customer uuid, p_tag text)
    RETURNS uuid LANGUAGE plpgsql AS $b$
    DECLARE v_order uuid; v_delivery uuid;
    BEGIN
      INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
        VALUES ('SMK-RTX-' || p_tag, p_customer, CURRENT_DATE, 'confirmed', p_admin) RETURNING id INTO v_order;
      PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
      INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
        total_units_needed, total_price, quantity_delivered, quantity_remaining)
        VALUES (v_order, p_product, '[SMOKE] Return tax', 'gal', p_cost + 1.37, p_cost, 10, (p_cost + 1.37) * 10, 0, 10);
      PERFORM set_config('app.crx_below_cost_operation', '', true);
      INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
        VALUES ('SMK-RTX-' || p_tag, v_order, p_customer, 'scheduled', CURRENT_DATE, p_admin) RETURNING id INTO v_delivery;
      INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
        SELECT v_delivery, oi.id, oi.product_id, oi.total_units_needed, 'gal' FROM order_items oi WHERE oi.order_id = v_order;
      PERFORM confirm_delivery(v_delivery, p_admin, 'smk-rtx-confirm-' || p_tag);
      PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', p_admin, NULL, NULL, NULL,
        'smk-rtx-complete-' || p_tag, NULL, 'no_proof', 'Rolled-back smoke; return tax change');
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      IF NOT EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo') THEN
        PERFORM create_invoice_for_unbilled_delivery(v_delivery, p_admin, 'smk-rtx-invoice-' || p_tag);
        SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      END IF;
      RETURN v_order;
    END $b$;
    -- A return of p_qty of the sale's one line, approved.
    CREATE FUNCTION pg_temp.rtx_return(p_admin uuid, p_customer uuid, p_order uuid, p_qty numeric, p_tag text)
    RETURNS uuid LANGUAGE plpgsql AS $b$
    DECLARE v_ret uuid;
    BEGIN
      v_ret := (create_return(jsonb_build_object('customer_id', p_customer, 'order_id', p_order, 'reason', 'damaged'),
        (SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'quantity', p_qty, 'condition', 'unopened', 'restock', false))
           FROM order_items oi WHERE oi.order_id = p_order),
        'smk-rtx-ret-' || p_tag) ->> 'return_id')::uuid;
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      PERFORM approve_return(v_ret, p_admin, 'smk-rtx-ap-' || p_tag);
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      RETURN v_ret;
    END $b$;
    -- Deliver p_qty more of the sale's line; its invoice is a draft.
    CREATE FUNCTION pg_temp.rtx_deliver(p_admin uuid, p_order uuid, p_customer uuid, p_qty numeric, p_tag text)
    RETURNS uuid LANGUAGE plpgsql AS $b$
    DECLARE v_delivery uuid;
    BEGIN
      INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
        VALUES ('SMK-RTX-' || p_tag, p_order, p_customer, 'scheduled', CURRENT_DATE, p_admin) RETURNING id INTO v_delivery;
      INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
        SELECT v_delivery, oi.id, oi.product_id, p_qty, 'gal' FROM order_items oi WHERE oi.order_id = p_order;
      PERFORM confirm_delivery(v_delivery, p_admin, 'smk-rtx-confirm-' || p_tag);
      PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', p_admin, NULL, NULL, NULL,
        'smk-rtx-complete-' || p_tag, NULL, 'no_proof', 'Rolled-back smoke; return tax change');
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      IF NOT EXISTS (SELECT 1 FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo') THEN
        PERFORM create_invoice_for_unbilled_delivery(v_delivery, p_admin, 'smk-rtx-invoice-' || p_tag);
        SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      END IF;
      RETURN (SELECT id FROM invoices WHERE delivery_id = v_delivery AND invoice_type <> 'credit_memo');
    END $b$;
    -- An order of 10 at cost + $1.37, nothing delivered yet.
    CREATE FUNCTION pg_temp.rtx_order(p_admin uuid, p_product uuid, p_cost numeric, p_customer uuid, p_tag text)
    RETURNS uuid LANGUAGE plpgsql AS $b$
    DECLARE v_order uuid;
    BEGIN
      INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
        VALUES ('SMK-RTX-' || p_tag, p_customer, CURRENT_DATE, 'confirmed', p_admin) RETURNING id INTO v_order;
      PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
      INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
        total_units_needed, total_price, quantity_delivered, quantity_remaining)
        VALUES (v_order, p_product, '[SMOKE] Return tax two lots', 'gal', p_cost + 1.37, p_cost, 10, (p_cost + 1.37) * 10, 0, 10);
      PERFORM set_config('app.crx_below_cost_operation', '', true);
      RETURN v_order;
    END $b$;
    -- The tax the ledger froze for a return's credit (negative: a refund).
    CREATE FUNCTION pg_temp.rtx_ledger(p_ret uuid) RETURNS bigint LANGUAGE sql AS $b$
      SELECT sum(c.tax_cents)::bigint FROM credit_memo_sales_tax c JOIN returns r ON r.credit_invoice_id = c.invoice_id
       WHERE r.id = p_ret $b$;
    CREATE FUNCTION pg_temp.rtx_tax(p_invoices uuid[]) RETURNS bigint LANGUAGE sql AS $b$
      SELECT coalesce(sum(extended_cents), 0)::bigint FROM invoice_items
       WHERE invoice_id = ANY (p_invoices) AND charge_type = 'sales_tax' $b$;
    CREATE FUNCTION pg_temp.rtx_step(p_call text) RETURNS void LANGUAGE plpgsql AS $b$
    BEGIN
      EXECUTE p_call;
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    END $b$;
    CREATE FUNCTION pg_temp.rtx_credit(p_ret uuid) RETURNS bigint LANGUAGE sql AS $b$
      SELECT abs(i.total_amount_cents) FROM returns r JOIN invoices i ON i.id = r.credit_invoice_id WHERE r.id = p_ret $b$;
  $f$;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  -- No standing discount, so before the box is ticked the line is priced at the order price (not a share).
  UPDATE customers SET standing_discount_pct = 0 WHERE id = v_customer;

  -- A: ticked after the return is received.
  BEGIN
    v_order := pg_temp.rtx_sale(v_admin, v_product.id, v_product.current_cost, v_customer, 'a-' || v_suffix);
    SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'a-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-a-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-a-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-a-' || v_suffix));
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax') THEN
      RAISE EXCEPTION 'the posted sale has no tax line';
    END IF;
    v_posted := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-a-' || v_suffix));
      v_credit := pg_temp.rtx_credit(v_ret);
      IF v_credit IS DISTINCT FROM round(v_posted * 4 / 10.0)::bigint THEN
        v_fails := v_fails || format(' (A) the credit after the box was ticked is %s cents, want 4/10 of the posted %s (tax included);', v_credit, v_posted);
      END IF;
      -- #2091: the ledger records the tax inside this credit, as a refund (negative), at the sale's rate
      IF (SELECT sum(c.tax_cents) FROM credit_memo_sales_tax c JOIN returns r ON r.credit_invoice_id = c.invoice_id WHERE r.id = v_ret)
         IS DISTINCT FROM round(-v_credit * (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'sales_tax')::numeric / v_posted)::bigint THEN
        v_fails := v_fails || ' (A) the tax ledger does not record the credit''s tax as a refund at the sale''s rate;';
      END IF;
      v_ret2 := pg_temp.rtx_return(v_admin, v_customer, v_order, 6, 'a2-' || v_suffix);
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret2, v_admin, 'smk-rtx-rc-a2-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret2, v_admin, 'smk-rtx-ic-a2-' || v_suffix));
      v_credit2 := pg_temp.rtx_credit(v_ret2);
      IF v_credit + v_credit2 IS DISTINCT FROM v_posted THEN
        v_fails := v_fails || format(' (A) the two credits add up to %s cents, want the posted %s, never more;', v_credit + v_credit2, v_posted);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || ' (A) the credit after the box was ticked failed: ' || SQLERRM || ';';
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (A) setup failed: ' || SQLERRM || ';';
  END;

  -- B: ticked (and posted) after the return is made, before it is received.
  BEGIN
    v_order := pg_temp.rtx_sale(v_admin, v_product.id, v_product.current_cost, v_customer, 'b-' || v_suffix);
    SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'b-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-b-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-b-' || v_suffix));
    v_posted := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-b-' || v_suffix));
      IF (SELECT extended_cents FROM return_items WHERE return_id = v_ret) IS DISTINCT FROM round(v_posted * 4 / 10.0)::bigint
         OR NOT EXISTS (SELECT 1 FROM financial_audit_log WHERE entity_type = 'return' AND entity_id = v_ret
                         AND operation_type = 'return_received' AND description LIKE 'Return re-priced%') THEN
        v_fails := v_fails || ' (B) receiving did not re-price the return to the taxed share, with an audit row;';
      END IF;
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-b-' || v_suffix));
      v_credit := pg_temp.rtx_credit(v_ret);
      IF v_credit IS DISTINCT FROM round(v_posted * 4 / 10.0)::bigint THEN
        v_fails := v_fails || format(' (B) the credit is %s cents, want 4/10 of the posted %s (tax included);', v_credit, v_posted);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM financial_audit_log
                      WHERE entity_type = 'return' AND entity_id = v_ret AND description LIKE 'Return re-priced%') THEN
        v_fails := v_fails || ' (B) the re-price is not in the financial audit log;';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || ' (B) receiving or crediting after the box was ticked failed: ' || SQLERRM || ';';
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (B) setup failed: ' || SQLERRM || ';';
  END;

  -- C: control, no tax change: the order price.
  BEGIN
    v_order := pg_temp.rtx_sale(v_admin, v_product.id, v_product.current_cost, v_customer, 'c-' || v_suffix);
    SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-c-' || v_suffix));
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'c-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-c-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-c-' || v_suffix));
    IF pg_temp.rtx_credit(v_ret) IS DISTINCT FROM round(4 * (v_product.current_cost + 1.37) * 100)::bigint THEN
      v_fails := v_fails || format(' (C) the untaxed return credits %s cents, want the order price;', pg_temp.rtx_credit(v_ret));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (C) the untaxed return failed: ' || SQLERRM || ';';
  END;

  -- D: two returns made before the box is ticked.
  BEGIN
    v_order := pg_temp.rtx_sale(v_admin, v_product.id, v_product.current_cost, v_customer, 'd-' || v_suffix);
    SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'd1-' || v_suffix);
    v_ret2 := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'd2-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-d-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-d-' || v_suffix));
    v_posted := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
    v_credit2 := (SELECT extended_cents FROM return_items WHERE return_id = v_ret2);
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-d1-' || v_suffix));
      v_fails := v_fails || ' (D) receiving one return while another still carries the old price was not refused;';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'RETURN_REPRICE_OTHER_RETURN_PENDING%' THEN
        v_fails := v_fails || ' (D) the refusal is not RETURN_REPRICE_OTHER_RETURN_PENDING: ' || SQLERRM || ';';
      END IF;
    END;
    IF (SELECT extended_cents FROM return_items WHERE return_id = v_ret2) IS DISTINCT FROM v_credit2 THEN
      v_fails := v_fails || ' (D) the other return''s price changed;';
    END IF;
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT cancel_return(%L, %L, %L, %L)', v_ret2, 'Recreate at the taxed price', v_admin, 'smk-rtx-cx-d2-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-d1b-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-d1-' || v_suffix));
      IF pg_temp.rtx_credit(v_ret) IS DISTINCT FROM round(v_posted * 4 / 10.0)::bigint THEN
        v_fails := v_fails || format(' (D) after the other was cancelled the credit is %s cents, want 4/10 of the posted %s;', pg_temp.rtx_credit(v_ret), v_posted);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || ' (D) crediting after the other return was cancelled failed: ' || SQLERRM || ';';
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (D) setup failed: ' || SQLERRM || ';';
  END;

  -- E: a discount set after the whole sale was returned and received.
  BEGIN
    v_order := pg_temp.rtx_sale(v_admin, v_product.id, v_product.current_cost, v_customer, 'e-' || v_suffix);
    SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 10, 'e-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-e-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT set_invoice_standing_discount(%L, 10, %L)', v_invoice, 'smk-rtx-disc-e-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-e-' || v_suffix));
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_invoice AND charge_type = 'standing_discount') THEN
      RAISE EXCEPTION 'the posted sale has no discount line';
    END IF;
    v_posted := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-e-' || v_suffix));
      IF pg_temp.rtx_credit(v_ret) IS DISTINCT FROM v_posted THEN
        v_fails := v_fails || format(' (E) the whole return credits %s cents, want the discounted posted %s;', pg_temp.rtx_credit(v_ret), v_posted);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || ' (E) crediting after a discount was set failed: ' || SQLERRM || ';';
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (E) setup failed: ' || SQLERRM || ';';
  END;

  -- F and G: how each line was priced; a newer return waits while an older order-price one is open.
  BEGIN
    v_order := pg_temp.rtx_sale(v_admin, v_product.id, v_product.current_cost, v_customer, 'g-' || v_suffix);
    SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'g1-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-g-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-g-' || v_suffix));
    v_posted := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
    IF (SELECT priced_from FROM return_items WHERE return_id = v_ret) IS DISTINCT FROM 'order_price' THEN
      v_fails := v_fails || ' (F) create_return did not record order_price before the tick;';
    END IF;
    BEGIN
      v_ret2 := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'g2-' || v_suffix);
      v_fails := v_fails || ' (G) a newer return was made while an older order-price return was open;';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'RETURN_OLDER_RETURN_AT_ORDER_PRICE%' THEN
        v_fails := v_fails || ' (G) the newer return was refused with the wrong code: ' || SQLERRM || ';';
      END IF;
    END;
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-g1-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-g1-' || v_suffix));
      IF (SELECT priced_from FROM return_items WHERE return_id = v_ret) IS DISTINCT FROM 'order_price' THEN
        v_fails := v_fails || ' (F) the re-priced line lost its order_price origin;';
      END IF;
      v_ret2 := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'g3-' || v_suffix);
      IF (SELECT priced_from FROM return_items WHERE return_id = v_ret2) IS DISTINCT FROM 'billed_share' THEN
        v_fails := v_fails || ' (F) create_return did not record billed_share after the tick;';
      END IF;
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret2, v_admin, 'smk-rtx-rc-g3-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret2, v_admin, 'smk-rtx-ic-g3-' || v_suffix));
      IF abs(pg_temp.rtx_credit(v_ret) - v_posted * 4 / 10.0) > 1 OR abs(pg_temp.rtx_credit(v_ret2) - v_posted * 4 / 10.0) > 1
         OR pg_temp.rtx_credit(v_ret) + pg_temp.rtx_credit(v_ret2) IS DISTINCT FROM round(v_posted * 8 / 10.0)::bigint THEN
        v_fails := v_fails || format(' (G) the two credits are %s and %s cents, want each 4/10 and together 8/10 of the posted %s;',
          pg_temp.rtx_credit(v_ret), pg_temp.rtx_credit(v_ret2), v_posted);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || ' (G) crediting the older return, then a newer one, failed: ' || SQLERRM || ';';
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (F/G) failed: ' || SQLERRM || ';';
  END;

  -- H: the first invoice posts untaxed; the box is ticked while the second is a draft; the return is received
  --    before the second posts. Only a POSTED tax line re-prices, so it is credited at the taxed share of both.
  DECLARE
    v_inv2 uuid;
  BEGIN
    INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
      VALUES ('SMK-RTX-h-' || v_suffix, v_customer, CURRENT_DATE, 'confirmed', v_admin) RETURNING id INTO v_order;
    PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
      total_units_needed, total_price, quantity_delivered, quantity_remaining)
      VALUES (v_order, v_product.id, '[SMOKE] Return tax two lots', 'gal', v_product.current_cost + 1.37, v_product.current_cost,
              10, (v_product.current_cost + 1.37) * 10, 0, 10);
    PERFORM set_config('app.crx_below_cost_operation', '', true);
    v_invoice := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'h1-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-h1-' || v_suffix));
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 4, 'h-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-h-' || v_suffix));
    v_inv2 := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'h2-' || v_suffix);
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_inv2 AND charge_type = 'sales_tax') THEN
      RAISE EXCEPTION 'the second (draft) invoice has no tax line';
    END IF;
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-h-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_inv2, v_inv2, 'smk-rtx-post-h2-' || v_suffix));
      v_posted := (SELECT sum(total_amount_cents) FROM invoices WHERE id IN (v_invoice, v_inv2));
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-h-' || v_suffix));
      IF pg_temp.rtx_credit(v_ret) IS DISTINCT FROM round(v_posted * 4 / 10.0)::bigint THEN
        v_fails := v_fails || format(' (H) the credit is %s cents, want 4/10 of both posted invoices %s;', pg_temp.rtx_credit(v_ret), v_posted);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || ' (H) crediting after a draft tax line, then its posting, failed: ' || SQLERRM || ';';
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (H) setup failed: ' || SQLERRM || ';';
  END;

  -- I and K: Mason's rule. A return of 8 is credited while 5 of its units are on a taxed draft (I: the first lot
  --    posted untaxed; K: posted taxed). The draft then posts and the last 2 are returned.
  DECLARE
    v_inv2 uuid;
    v_case text;
    v_total bigint;
    v_tax bigint;
  BEGIN
    FOREACH v_case IN ARRAY ARRAY['I', 'K'] LOOP
      BEGIN
        v_order := pg_temp.rtx_order(v_admin, v_product.id, v_product.current_cost, v_customer, lower(v_case) || '-' || v_suffix);
        v_invoice := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, lower(v_case) || '1-' || v_suffix);
        IF v_case = 'I' THEN
          PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-i1-' || v_suffix));
          PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-i-' || v_suffix));
          v_inv2 := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'i2-' || v_suffix);
        ELSE
          v_inv2 := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'k2-' || v_suffix);
        END IF;
        BEGIN
          v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 8, lower(v_case) || 'r1-' || v_suffix);
          IF v_case = 'K' THEN
            PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-k-' || v_suffix));
            PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-k1-' || v_suffix));
            IF pg_temp.rtx_tax(ARRAY[v_invoice]) <= 0 THEN RAISE EXCEPTION 'the first lot posted without tax'; END IF;
          END IF;
          IF pg_temp.rtx_tax(ARRAY[v_inv2]) <= 0
             OR (SELECT status FROM invoices WHERE id = v_inv2) NOT IN ('draft', 'unposted') THEN
            RAISE EXCEPTION 'the second lot is not a taxed draft';
          END IF;
          IF (SELECT priced_from FROM return_items WHERE return_id = v_ret) IS DISTINCT FROM 'order_price' THEN
            v_fails := v_fails || format(' (%s) the return of 8 was not priced at the order price;', v_case);
          END IF;
          -- both lots as they stand: the posted one and the taxed draft (one product line each, plus tax)
          v_total := (SELECT sum(total_amount_cents) FROM invoices WHERE id IN (v_invoice, v_inv2));
          v_tax := pg_temp.rtx_tax(ARRAY[v_invoice, v_inv2]);
          PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-' || lower(v_case) || '-' || v_suffix));
          PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-' || lower(v_case) || '-' || v_suffix));
          v_credit := pg_temp.rtx_credit(v_ret);
          IF v_credit IS DISTINCT FROM round(v_total * 8 / 10.0)::bigint THEN
            v_fails := v_fails || format(' (%s) the credit of 8 is %s cents, want 8/10 of both lots %s (the draft''s tax included);', v_case, v_credit, v_total);
          END IF;
          IF pg_temp.rtx_ledger(v_ret) IS DISTINCT FROM round(-v_credit * v_tax::numeric / v_total)::bigint THEN
            v_fails := v_fails || format(' (%s) the ledger froze %s cents tax for the credit, want %s (8/10 of both lots'' tax, as a refund);',
              v_case, pg_temp.rtx_ledger(v_ret), round(-v_credit * v_tax::numeric / v_total)::bigint);
          END IF;
          -- the draft still bills its 5 units
          PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_inv2, v_inv2, 'smk-rtx-post-' || lower(v_case) || '2-' || v_suffix));
          IF (SELECT sum(total_amount_cents) FROM invoices WHERE id IN (v_invoice, v_inv2)) IS DISTINCT FROM v_total THEN
            v_fails := v_fails || format(' (%s) posting the draft changed what was charged;', v_case);
          END IF;
          v_ret2 := pg_temp.rtx_return(v_admin, v_customer, v_order, 2, lower(v_case) || 'r2-' || v_suffix);
          PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret2, v_admin, 'smk-rtx-rc-' || lower(v_case) || '2-' || v_suffix));
          PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret2, v_admin, 'smk-rtx-ic-' || lower(v_case) || '2-' || v_suffix));
          v_credit2 := pg_temp.rtx_credit(v_ret2);
          IF v_credit + v_credit2 IS DISTINCT FROM v_total THEN
            v_fails := v_fails || format(' (%s) the two credits add up to %s cents, want exactly what was charged, %s;', v_case, v_credit + v_credit2, v_total);
          END IF;
          IF pg_temp.rtx_ledger(v_ret) + pg_temp.rtx_ledger(v_ret2) IS DISTINCT FROM -v_tax THEN
            v_fails := v_fails || format(' (%s) the ledger refunds %s cents tax in all, want all %s collected;', v_case,
              -(pg_temp.rtx_ledger(v_ret) + pg_temp.rtx_ledger(v_ret2)), v_tax);
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_fails := v_fails || format(' (%s) crediting units on a taxed draft failed: %s;', v_case, SQLERRM);
        END;
      EXCEPTION WHEN OTHERS THEN
        v_fails := v_fails || format(' (%s) setup failed: %s;', v_case, SQLERRM);
      END;
    END LOOP;
  END;

  -- J: units on no invoice at all stay refused once the sale has tax.
  DECLARE
    v_inv2 uuid;
  BEGIN
    v_order := pg_temp.rtx_order(v_admin, v_product.id, v_product.current_cost, v_customer, 'j-' || v_suffix);
    v_invoice := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'j1-' || v_suffix);
    v_inv2 := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'j2-' || v_suffix);
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 8, 'j-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-j-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-j1-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT delete_invoices(ARRAY[%L]::uuid[], %L, %L)', v_inv2, v_admin, 'smk-rtx-del-j2-' || v_suffix));
    IF EXISTS (SELECT 1 FROM invoices WHERE id = v_inv2 AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'the second draft was not deleted';
    END IF;
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-j-' || v_suffix));
      v_fails := v_fails || ' (J) a return of units on no invoice was received on a taxed sale;';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'RETURN_UNITS_NOT_INVOICED%' THEN
        v_fails := v_fails || ' (J) the refusal is not RETURN_UNITS_NOT_INVOICED: ' || SQLERRM || ';';
      END IF;
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (J) setup failed: ' || SQLERRM || ';';
  END;

  -- L: the order's tax box, no live invoice of the line at all.
  BEGIN
    v_order := pg_temp.rtx_order(v_admin, v_product.id, v_product.current_cost, v_customer, 'l-' || v_suffix);
    v_invoice := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'l1-' || v_suffix);
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 5, 'l-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-l-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT delete_invoices(ARRAY[%L]::uuid[], %L, %L)', v_invoice, v_admin, 'smk-rtx-del-l1-' || v_suffix));
    IF EXISTS (SELECT 1 FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
                WHERE i.order_id = v_order AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled')) THEN
      RAISE EXCEPTION 'a live invoice still holds the line';
    END IF;
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-l-' || v_suffix));
      v_fails := v_fails || ' (L) a return of units on no invoice was received on a sale with the tax box ticked;';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'RETURN_UNITS_NOT_INVOICED%' THEN
        v_fails := v_fails || ' (L) the refusal is not RETURN_UNITS_NOT_INVOICED: ' || SQLERRM || ';';
      END IF;
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (L) setup failed: ' || SQLERRM || ';';
  END;

  -- M: a line from before this change, while a taxed draft holds the line.
  DECLARE
    v_inv2 uuid;
  BEGIN
    v_order := pg_temp.rtx_order(v_admin, v_product.id, v_product.current_cost, v_customer, 'm-' || v_suffix);
    v_invoice := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'm1-' || v_suffix);
    v_inv2 := pg_temp.rtx_deliver(v_admin, v_order, v_customer, 5, 'm2-' || v_suffix);
    v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 8, 'm-' || v_suffix);
    PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-m1-' || v_suffix));
    PERFORM pg_temp.rtx_step(format('SELECT set_order_sales_tax(%L, true, %L)', v_order, 'smk-rtx-tax-m-' || v_suffix));
    IF pg_temp.rtx_tax(ARRAY[v_inv2]) <= 0 THEN RAISE EXCEPTION 'the second lot is not a taxed draft'; END IF;
    BEGIN
      -- as a line that existed when the migration applied
      EXECUTE format('UPDATE return_items SET priced_from = %L WHERE return_id = %L', 'unrecorded', v_ret);
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-m-' || v_suffix));
      v_fails := v_fails || ' (M) an unrecorded return of units on a taxed draft was received;';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'RETURN_SPLIT_SHARE_REPRICED%' THEN
        v_fails := v_fails || ' (M) the refusal is not RETURN_SPLIT_SHARE_REPRICED: ' || SQLERRM || ';';
      END IF;
    END;
  EXCEPTION WHEN OTHERS THEN
    v_fails := v_fails || ' (M) setup failed: ' || SQLERRM || ';';
  END;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL return tax change:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK return tax change: a return credits the taxed share after the box is ticked, before or after it is received, never more than the posted total; another return still at the old price is refused, never changed; a newer return waits for an older order-price one; a later discount credits the discounted total; create_return records how it priced each line; an untaxed return keeps the order price; units on a taxed draft credit at that lot''s price and the ledger records their tax; units on no invoice stay refused, the order''s tax box included; a line from before this change keeps today''s refusal';
END
$smoke$;
