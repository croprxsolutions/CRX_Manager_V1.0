-- #1957 (Taha's LOW on #1952): the PRODUCT_UNIT_HAS_HISTORY refusal named its records with a fallback that repeated
-- the sentence. The record list covers only order, delivery, PO, return and receipt rows, so a product whose only
-- history is a stock movement or an active hold read "...stock movements or holds (stock movements or holds)."
--
-- WHAT: re-emits public._refuse_stock_unit_change_with_history() as release #1990 left it (20270129160000, which added
-- the READ COMMITTED check; kept unchanged here) with one change: when no order,
-- delivery, PO, return or receipt row exists, the brackets say which of the two it found: "stock movements",
-- "an active hold", or "stock movements and an active hold". The decision (which history refuses), the trigger,
-- the lock trigger and the grants are unchanged. Wording only; screens cannot reach it (they cannot change a stock
-- unit on a saved product).
--
-- ROLLBACK: scripts/smoke/stock-unit-history-wording-reverse.sql (proven by the units-batch prover).

DO $preflight$
BEGIN
  -- Pins the body release #1990 created (20270129160000, CR stripped), so this replaces exactly that body.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._refuse_stock_unit_change_with_history()')) IS DISTINCT FROM '20f02f8606621be4bc042d7787c34cdb' THEN
    RAISE EXCEPTION 'PREFLIGHT_UNITS_DRIFT: _refuse_stock_unit_change_with_history is missing, changed, or already re-emitted';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._refuse_stock_unit_change_with_history()
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
  -- #1990 Sol: under REPEATABLE READ or SERIALIZABLE the checks below read the transaction's first snapshot, so a
  -- line committed since (it held this row FOR SHARE, then let go) is invisible and the unit would change under it.
  -- READ COMMITTED re-reads after the row lock, so only it may change a stock unit.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'PRODUCT_UNIT_CHANGE_NEEDS_READ_COMMITTED: change a stock unit in a READ COMMITTED transaction (this one is %), so the history check sees every committed line.',
      current_setting('transaction_isolation') USING ERRCODE = 'serialization_failure';
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
    -- No listed record: the history is stock movements, an active hold, or both; say which.
    v_what := COALESCE(v_what, concat_ws(' and ',
      CASE WHEN EXISTS (SELECT 1 FROM public.inventory_transactions WHERE product_id = NEW.id) THEN 'stock movements' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.inventory_holds WHERE product_id = NEW.id AND is_active) THEN 'an active hold' END));
    RAISE EXCEPTION 'PRODUCT_UNIT_HAS_HISTORY: this product''s stock unit cannot change to "%" because it already has orders, purchases, deliveries, returns, stock movements or holds (%). Set up a new product for the new unit.',
      btrim(COALESCE(NULLIF(btrim(NEW.inventory_unit), ''), NEW.unit_size)), v_what
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._refuse_stock_unit_change_with_history() FROM PUBLIC, anon, authenticated, service_role;
