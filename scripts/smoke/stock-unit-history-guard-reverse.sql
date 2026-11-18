-- Rollback for supabase/migrations/20270121120000_stock_unit_keeps_history.sql (proven by
-- scripts/smoke/prove-units-batch-real-schema.mjs). Run this BEFORE units-batch-rules-reverse.sql.
-- Removes the history check on a product's stock-unit change; the open-lines and stock checks stay.
-- To use it live, copy it into a new migration through the gates (without the BEGIN / COMMIT lines).
BEGIN;

DROP TRIGGER a2_product_unit_keeps_history ON public.products;
DROP FUNCTION public._refuse_stock_unit_change_with_history();
DROP TRIGGER a2_history_row_locks_product ON public.return_items;
DROP TRIGGER a2_history_row_locks_product ON public.inventory_holds;
DROP FUNCTION public._history_row_locks_product();

COMMIT;
