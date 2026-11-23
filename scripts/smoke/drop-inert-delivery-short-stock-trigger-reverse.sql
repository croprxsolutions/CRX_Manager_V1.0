-- Reverse of 20270224210000_drop_inert_delivery_short_stock_trigger.sql: re-creates _mark_delivery_aggregate_short_stock
-- (the 20260716191000 body, byte for byte), its grants and comment, and trg_mark_delivery_aggregate_short_stock.
-- Run as one transaction (psql -1). Proven by scripts/smoke/prove-drop-inert-delivery-short-stock-trigger-real-schema.mjs.

DO $reverse_preflight$
BEGIN
  IF to_regprocedure('public._mark_delivery_aggregate_short_stock()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_mark_delivery_aggregate_short_stock') THEN
    RAISE EXCEPTION 'DROP_SHORT_STOCK_TRIGGER_REVERSE_DRIFT: the trigger or its function already exists';
  END IF;
END;
$reverse_preflight$;

CREATE FUNCTION public._mark_delivery_aggregate_short_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_delivery_id text := current_setting(
    'app.delivery_aggregate_short_delivery_id',
    true
  );
  v_product_ids text := current_setting(
    'app.delivery_aggregate_short_product_ids',
    true
  );
BEGIN
  IF NEW.transaction_type = 'delivered'
     AND NEW.delivery_id IS NOT NULL
     AND NEW.product_id IS NOT NULL
     AND v_delivery_id IS NOT NULL
     AND v_product_ids IS NOT NULL
     AND NEW.delivery_id::text = v_delivery_id
     AND NEW.product_id = ANY(string_to_array(v_product_ids, ',')::uuid[]) THEN
    NEW.requires_review := true;
    IF COALESCE(NEW.notes, '') NOT LIKE '%[SHORT STOCK — review required]%' THEN
      NEW.notes := COALESCE(NEW.notes, '') || ' [SHORT STOCK — review required]';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._mark_delivery_aggregate_short_stock()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_mark_delivery_aggregate_short_stock
BEFORE INSERT ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION public._mark_delivery_aggregate_short_stock();

COMMENT ON FUNCTION public._mark_delivery_aggregate_short_stock()
  IS 'Marks newly inserted delivered ledger rows for transaction-local aggregate short-stock products without mutating the append-only ledger later.';
