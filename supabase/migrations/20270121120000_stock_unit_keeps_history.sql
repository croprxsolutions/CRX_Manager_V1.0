-- KI-136 follow-up (Sol HIGH on 20270121110000:248): once a product has history, its stock unit is fixed.
--
-- WHY: a1_product_unit_keeps_open_lines checks only OPEN lines and stock. History reopens: receive_return restocks a
-- pending return only when its source unit (the order line's unit, 'ea' when blank, or the return line's own unit)
-- matches the stock row's unit, so after a change it raises RETURN_CREDIT_INVENTORY_UNIT_MISMATCH and the return can
-- neither restock nor credit; reverse_receiving_record lowers a received (or closed-short) PO line, which the line rule
-- re-checks (LINE_UNIT_NOT_STOCK_UNIT) or, on a blank line, fills with the new unit while subtracting the old quantity;
-- a return raised later from a delivered order line, or a voided completed delivery, puts back quantities counted in
-- the old unit.
--
-- WHAT: one more BEFORE UPDATE trigger on products, a2_product_unit_keeps_history (after a1_..., which still refuses
-- open lines, stock, an unknown unit and clearing). When the stock unit changes other than in case or outer spaces, it
-- refuses PRODUCT_UNIT_HAS_HISTORY if the product has ANY order, delivery, purchase-order or return line, receiving
-- record, stock transaction or active hold, whatever its unit or status (blank units included: a blank line is read as the stock unit, or as 'ea' by
-- returns). A product sold, bought, delivered or returned in one unit keeps it; another unit is a new product. This is
-- the rule screens already have (the setup guard refuses any stock-unit change on a saved product); this makes it hold
-- for a reviewed data correction too, which must disable it explicitly, as 20270121100000 does its guards.
-- The decision uses EXISTS; the message names up to 5 records separately.
-- Serialized: order, delivery and PO lines already read the product FOR SHARE (a1_line_unit_is_stock_unit), and a
-- receipt raises its PO line; a2_history_row_locks_product does the same for return lines and holds, so a unit change waits for
-- an uncommitted line and then sees it, and a line written after the change waits and then meets the new unit. Stock
-- transactions move stock rows, which a1 already locks.
--
-- ROLLBACK: scripts/smoke/stock-unit-history-guard-reverse.sql (proven by the units-batch prover).

DO $preflight$
BEGIN
  IF to_regprocedure('public._refuse_stock_unit_change_with_open_lines()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                     AND tgname = 'a1_product_unit_keeps_open_lines' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PREFLIGHT_UNITS_DRIFT: 20270121110000 (the unit rules) must be applied first';
  END IF;
  IF to_regprocedure('public._refuse_stock_unit_change_with_history()') IS NOT NULL
     OR to_regprocedure('public._history_row_locks_product()') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_UNITS_DRIFT: _refuse_stock_unit_change_with_history already exists';
  END IF;
END;
$preflight$;

CREATE FUNCTION public._refuse_stock_unit_change_with_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_new text := lower(COALESCE(NULLIF(btrim(NEW.inventory_unit), ''), NULLIF(btrim(NEW.unit_size), '')));
  v_old text := lower(COALESCE(NULLIF(btrim(OLD.inventory_unit), ''), NULLIF(btrim(OLD.unit_size), '')));
  v_what text;
BEGIN
  -- Clearing is a1's to refuse; a case or outer-space change keeps every comparison (receive_return lowers and trims).
  IF v_new IS NULL OR v_new IS NOT DISTINCT FROM v_old THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_items WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.delivery_items WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.purchase_order_items WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.receiving_records WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.return_items WHERE product_id = NEW.id)
     -- Every other stock movement (jobs, blend tickets, adjustments, counts) writes a transaction; a hold keeps a quantity.
     OR EXISTS (SELECT 1 FROM public.inventory_transactions WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.inventory_holds WHERE product_id = NEW.id AND is_active) THEN
    SELECT string_agg(x, ', ') INTO v_what FROM (
      SELECT x FROM (
        SELECT 'order ' || COALESCE(o.order_number, l.order_id::text) AS x
          FROM public.order_items l LEFT JOIN public.orders o ON o.id = l.order_id WHERE l.product_id = NEW.id
        UNION
        SELECT 'delivery ' || COALESCE(d.delivery_number, l.delivery_id::text)
          FROM public.delivery_items l LEFT JOIN public.deliveries d ON d.id = l.delivery_id WHERE l.product_id = NEW.id
        UNION
        SELECT 'PO ' || COALESCE(po.po_number, l.purchase_order_id::text)
          FROM public.purchase_order_items l LEFT JOIN public.purchase_orders po ON po.id = l.purchase_order_id WHERE l.product_id = NEW.id
        UNION
        SELECT 'return ' || COALESCE(r.return_number, ri.return_id::text)
          FROM public.return_items ri LEFT JOIN public.returns r ON r.id = ri.return_id WHERE ri.product_id = NEW.id
        UNION
        SELECT 'PO ' || COALESCE(po.po_number, rr.purchase_order_id::text)
          FROM public.receiving_records rr LEFT JOIN public.purchase_orders po ON po.id = rr.purchase_order_id WHERE rr.product_id = NEW.id
      ) a ORDER BY x LIMIT 5
    ) s;
    RAISE EXCEPTION 'PRODUCT_UNIT_HAS_HISTORY: this product''s stock unit cannot change to "%" because it already has orders, purchases, deliveries, returns, stock movements or holds (%). Set up a new product for the new unit.',
      btrim(COALESCE(NULLIF(btrim(NEW.inventory_unit), ''), NEW.unit_size)), COALESCE(v_what, 'stock movements or holds')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._refuse_stock_unit_change_with_history() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER a2_product_unit_keeps_history
  BEFORE UPDATE OF inventory_unit, unit_size ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._refuse_stock_unit_change_with_history();

CREATE FUNCTION public._history_row_locks_product()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  -- The stock unit cannot change before this return line or hold commits (see a2_product_unit_keeps_history).
  PERFORM 1 FROM public.products WHERE id = NEW.product_id FOR SHARE;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._history_row_locks_product() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER a2_history_row_locks_product
  BEFORE INSERT OR UPDATE OF product_id ON public.return_items
  FOR EACH ROW EXECUTE FUNCTION public._history_row_locks_product();
CREATE TRIGGER a2_history_row_locks_product
  BEFORE INSERT OR UPDATE OF product_id, is_active ON public.inventory_holds
  FOR EACH ROW EXECUTE FUNCTION public._history_row_locks_product();
