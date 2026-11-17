-- Rollback for 20270113130000_one_open_count_per_stock_row.sql (KI-160 part). Run as one transaction.
-- Removes the two guards and the one-open-count-per-warehouse index; no data changes. After it, two open counts can
-- again correct one stock row twice (KI-160), so only use it to back out a fault in the guards themselves.
-- Proven by scripts/smoke/prove-one-open-count-real-schema.mjs (case R).
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TRIGGER trg_cycle_count_item_one_open_row ON public.cycle_count_items;
DROP TRIGGER trg_cycle_count_no_reopen ON public.cycle_counts;
DROP FUNCTION public._cycle_count_item_one_open_row();
DROP FUNCTION public._cycle_count_no_reopen();
DROP INDEX public.cycle_counts_one_open_per_warehouse;
GRANT UPDATE ON public.cycle_counts TO authenticated;
GRANT UPDATE ON public.cycle_count_items TO authenticated;
GRANT INSERT ON public.cycle_count_items TO authenticated;
GRANT DELETE ON public.cycle_counts TO authenticated;
GRANT DELETE ON public.cycle_count_items TO authenticated;
COMMIT;
