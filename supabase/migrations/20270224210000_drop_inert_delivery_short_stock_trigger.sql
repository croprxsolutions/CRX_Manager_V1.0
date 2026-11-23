-- #2225 (found by the /security-review of #2224). Drops the ledger trigger trg_mark_delivery_aggregate_short_stock
-- and its function _mark_delivery_aggregate_short_stock (both from 20260716191000). The trigger flagged a delivered
-- inventory_transactions row for review only when two transaction-local settings named that delivery and product.
-- Their only setter was complete_delivery's outer wrapper, and 20270213100000_single_short_stock_warning (#2135)
-- removed that, so the trigger has changed no row since. The completion body (#1942, 20270203120000) writes the same
-- '[SHORT STOCK — review required]' note and requires_review itself. No row changes; stock and the ledger are untouched.
--
-- idempotency-body-check: exempt -- no RPC is created or changed; this only drops a private trigger function.
-- caller-analysis: _mark_delivery_aggregate_short_stock :: trigger function only (EXECUTE revoked from every API role
--   in 20260716191000); its one caller is the trigger dropped here. No function body reads or sets its two settings
--   once #2135 is applied (the preflight checks every function).
--
-- ROLLBACK: scripts/smoke/drop-inert-delivery-short-stock-trigger-reverse.sql (proven by
--   scripts/smoke/prove-drop-inert-delivery-short-stock-trigger-real-schema.mjs).

CREATE TEMP TABLE drop_short_stock_trigger_2225_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.drop_short_stock_trigger_2225_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.drop_short_stock_trigger_2225_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._mark_delivery_aggregate_short_stock()'))
     IS DISTINCT FROM 'c0b201d309650463f192fdf26eedc292' THEN
    RAISE EXCEPTION 'DROP_SHORT_STOCK_TRIGGER_BASELINE_DRIFT: _mark_delivery_aggregate_short_stock is missing or not the 20260716191000 body';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_mark_delivery_aggregate_short_stock' AND tgrelid = 'public.inventory_transactions'::regclass
      AND tgfoid = 'public._mark_delivery_aggregate_short_stock()'::regprocedure AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'DROP_SHORT_STOCK_TRIGGER_BASELINE_DRIFT: trg_mark_delivery_aggregate_short_stock is not on inventory_transactions';
  END IF;
  -- #2135 must be live: if any other function still sets the trigger's settings, the trigger is not inert.
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid <> 'public._mark_delivery_aggregate_short_stock()'::regprocedure
      AND prosrc LIKE '%delivery\_aggregate\_short\_%'
  ) THEN
    RAISE EXCEPTION 'DROP_SHORT_STOCK_TRIGGER_BASELINE_DRIFT: a function still uses the trigger''s settings (apply 20270213100000 first)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid = 'public._mark_delivery_aggregate_short_stock()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION 'DROP_SHORT_STOCK_TRIGGER_BASELINE_DRIFT: another trigger uses _mark_delivery_aggregate_short_stock';
  END IF;
END;
$preflight$;

DROP TRIGGER trg_mark_delivery_aggregate_short_stock ON public.inventory_transactions;
DROP FUNCTION public._mark_delivery_aggregate_short_stock();

DO $postflight$
BEGIN
  IF to_regprocedure('public._mark_delivery_aggregate_short_stock()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_mark_delivery_aggregate_short_stock') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the trigger or its function is still there';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: inert short-stock ledger trigger dropped';
END;
$postflight$;
