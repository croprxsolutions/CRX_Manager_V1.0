-- Rollback for 20270218100000_f05_order_line_quantity_guard.sql (F05), proven by
-- scripts/smoke/prove-f05-order-line-quantity-guard-real-schema.mjs.
-- Removes the three refusal triggers and their helpers, all or nothing. The forward migration wrote no data, so nothing
-- else changes. To use it live, copy it into a new migration through the gates (without the BEGIN / COMMIT lines), so
-- the migration ledger records the removal; never run it by hand against a live database.
-- Removing it re-opens F05: more scheduled or delivered than ordered on a line, and order cuts below what is
-- scheduled. Pause scheduling extra loads, order quantity cuts, and completing loads on the lines the forward
-- migration's preflight listed while it is off.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Same table order as completion and the forward migration (Sol r2), so dropping the triggers cannot deadlock with it.
LOCK TABLE public.deliveries, public.delivery_items, public.order_items IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS zz_delivery_line_within_order ON public.delivery_items;
DROP TRIGGER IF EXISTS zz_delivery_reopen_within_order ON public.deliveries;
DROP TRIGGER IF EXISTS zz_order_line_within_deliveries ON public.order_items;
DROP FUNCTION IF EXISTS public._delivery_line_within_order();
DROP FUNCTION IF EXISTS public._delivery_reopen_within_order();
DROP FUNCTION IF EXISTS public._order_line_within_deliveries();
DROP FUNCTION IF EXISTS public._assert_order_line_fits(uuid, numeric, uuid, uuid);
DROP FUNCTION IF EXISTS public._order_line_open_loads(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._order_line_committed(uuid, uuid, uuid);
COMMIT;
