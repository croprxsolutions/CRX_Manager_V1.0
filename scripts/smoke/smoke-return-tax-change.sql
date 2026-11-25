-- ============================================================================
-- ROLLED-BACK smoke: a return still credits after the sale's sales-tax box changes (issue #2066)
-- ----------------------------------------------------------------------------
-- Migration 20270306110000_return_tax_change_credit. Mason's rule (22 Nov): when tax changed after the return was
-- made, its credit re-prices to the taxed share, and is never more than the customer was charged on the posted
-- invoice, tax included.
--   A  Untaxed sale, return of 4 of 10 made and received at the order price; the box is ticked and the draft posts
--      taxed. The credit goes through at 4/10 of the posted total (tax included), not the order price, and the
--      return of the other 6 credits the rest: the two credits add up to the posted total, never more.
--   B  Same, but the box is ticked and the draft posts before the return is received: receive and credit both go
--      through at the taxed share, and the re-price is in the financial audit log.
--   C  Control: no tax change. The return credits the order price, as before.
--   D  Two returns of 4 made before the box is ticked: each credits its own 4 units' taxed share (within a cent of
--      each other), not one taking the other's tax; with the last 2 the three credits add up to the posted total.
--   E  A discount set on the draft after the whole sale was returned and received: the credit is the discounted
--      posted total, not refused because the stored order price is above what was billed.
--   F  Two returns of 5 made before a 20% discount: the first credited while the other still carries the old price
--      gets half the discounted total, not what the other's old price leaves; together they credit the posted total.
--   G  Five returns of 1 before a 1% discount, credited last-made first: each about a fifth, together the posted total.
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
    BEGIN
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-d1-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-d1-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret2, v_admin, 'smk-rtx-rc-d2-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret2, v_admin, 'smk-rtx-ic-d2-' || v_suffix));
      v_credit := pg_temp.rtx_credit(v_ret);
      v_credit2 := pg_temp.rtx_credit(v_ret2);
      IF abs(v_credit - round(v_posted * 4 / 10.0)) > 1 OR abs(v_credit2 - round(v_posted * 4 / 10.0)) > 1
         OR abs(v_credit + v_credit2 - round(v_posted * 8 / 10.0)) > 1 THEN
        v_fails := v_fails || format(' (D) the two returns of 4 credit %s and %s cents, want each about 4/10 of the posted %s;', v_credit, v_credit2, v_posted);
      END IF;
      v_ret := pg_temp.rtx_return(v_admin, v_customer, v_order, 2, 'd3-' || v_suffix);
      PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-rc-d3-' || v_suffix));
      PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_ret, v_admin, 'smk-rtx-ic-d3-' || v_suffix));
      IF v_credit + v_credit2 + pg_temp.rtx_credit(v_ret) IS DISTINCT FROM v_posted THEN
        v_fails := v_fails || format(' (D) the three credits add up to %s cents, want the posted %s;', v_credit + v_credit2 + pg_temp.rtx_credit(v_ret), v_posted);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fails := v_fails || ' (D) crediting two returns made before the box was ticked failed: ' || SQLERRM || ';';
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

  -- F and G: several returns made before a discount, credited one at a time.
  DECLARE
    v_case text;
    v_qtys numeric[];
    v_rets uuid[];
    v_sum bigint;
    v_n int;
  BEGIN
    FOR v_case, v_qtys IN SELECT * FROM (VALUES ('f', ARRAY[5, 5]::numeric[]), ('g', ARRAY[1, 1, 1, 1, 1]::numeric[])) v LOOP
      BEGIN
        v_order := pg_temp.rtx_sale(v_admin, v_product.id, v_product.current_cost, v_customer, v_case || '-' || v_suffix);
        SELECT id INTO v_invoice FROM invoices WHERE order_id = v_order AND invoice_type <> 'credit_memo';
        v_rets := ARRAY[]::uuid[];
        FOR v_n IN 1 .. array_length(v_qtys, 1) LOOP
          v_rets := v_rets || pg_temp.rtx_return(v_admin, v_customer, v_order, v_qtys[v_n], v_case || v_n || '-' || v_suffix);
        END LOOP;
        PERFORM pg_temp.rtx_step(format('SELECT set_invoice_standing_discount(%L, %s, %L)', v_invoice,
          CASE v_case WHEN 'f' THEN 20 ELSE 1 END, 'smk-rtx-disc-' || v_case || '-' || v_suffix));
        PERFORM pg_temp.rtx_step(format('SELECT post_invoice(%L, _invoice_post_version(%L), %L)', v_invoice, v_invoice, 'smk-rtx-post-' || v_case || '-' || v_suffix));
        v_posted := (SELECT total_amount_cents FROM invoices WHERE id = v_invoice);
        v_sum := 0;
        FOR v_n IN REVERSE array_length(v_qtys, 1) .. 1 LOOP
          PERFORM pg_temp.rtx_step(format('SELECT receive_return(%L, %L, %L)', v_rets[v_n], v_admin, 'smk-rtx-rc-' || v_case || v_n || '-' || v_suffix));
          PERFORM pg_temp.rtx_step(format('SELECT issue_return_credit(%L, %L, %L)', v_rets[v_n], v_admin, 'smk-rtx-ic-' || v_case || v_n || '-' || v_suffix));
          IF abs(pg_temp.rtx_credit(v_rets[v_n]) - v_posted * v_qtys[v_n] / 10.0) > 1 THEN
            v_fails := v_fails || format(' (%s) return %s of %s credits %s cents, want about %s of the posted %s;', upper(v_case), v_n,
              v_qtys[v_n], pg_temp.rtx_credit(v_rets[v_n]), round(v_posted * v_qtys[v_n] / 10.0, 1), v_posted);
          END IF;
          v_sum := v_sum + pg_temp.rtx_credit(v_rets[v_n]);
        END LOOP;
        IF v_sum IS DISTINCT FROM round(v_posted * (SELECT sum(q) FROM unnest(v_qtys) q) / 10.0)::bigint THEN
          v_fails := v_fails || format(' (%s) the returns credit %s cents in all, want %s of the posted %s;', upper(v_case), v_sum,
            round(v_posted * (SELECT sum(q) FROM unnest(v_qtys) q) / 10.0), v_posted);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_fails := v_fails || format(' (%s) crediting returns made before a discount failed: %s;', upper(v_case), SQLERRM);
      END;
    END LOOP;
  END;

  IF v_fails <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL return tax change:%', v_fails;
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK return tax change: a return credits the taxed share after the box is ticked, before or after it is received, never more than the posted total, each return its own units'' share; a later discount credits the discounted total; an untaxed return keeps the order price';
END
$smoke$;
