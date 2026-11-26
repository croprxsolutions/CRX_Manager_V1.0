-- Rollback for 20270311000000_whole_item_quantities.sql: drops the three triggers and the function. No data changes.
BEGIN;
DO $guard$
BEGIN
  IF to_regprocedure('public._enforce_whole_item_quantity()') IS NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_REVERSE: the whole-item rule is not installed';
  END IF;
END;
$guard$;
DROP TRIGGER a3_whole_item_quantity ON public.quote_items;
DROP TRIGGER a3_whole_item_quantity ON public.order_items;
DROP TRIGGER a3_whole_item_quantity ON public.delivery_items;
DROP FUNCTION public._enforce_whole_item_quantity();
COMMIT;
