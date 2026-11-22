-- Rollback for 20270209100000_f05_order_line_quantity_guard.sql (F05).
-- Removes the three refusal triggers and their helpers. The forward migration wrote no data, so nothing else changes.
-- Removing it re-opens the F05 race (two loads for the same units); pause Follow-up scheduling while it is off.
DROP TRIGGER IF EXISTS zz_delivery_line_within_order ON public.delivery_items;
DROP TRIGGER IF EXISTS zz_delivery_reopen_within_order ON public.deliveries;
DROP TRIGGER IF EXISTS zz_order_line_within_deliveries ON public.order_items;
DROP FUNCTION IF EXISTS public._delivery_line_within_order();
DROP FUNCTION IF EXISTS public._delivery_reopen_within_order();
DROP FUNCTION IF EXISTS public._order_line_within_deliveries();
DROP FUNCTION IF EXISTS public._assert_order_line_fits(uuid, numeric, uuid, uuid);
DROP FUNCTION IF EXISTS public._order_line_open_loads(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._order_line_committed(uuid, uuid, uuid);
