-- Sol round 1 on release #2189 (finding 7, HIGH): the profit reports' commission share
-- (_report_commission_cents_20270203, 20270206110000) divides by orders.total_price and treats any total that is not
-- below 1e15 as unusable, which books the FULL commission on the first partial invoice. The only check on that column,
-- orders_total_price_non_negative (total_price >= 0), lets NaN, Infinity and huge finite totals through (in PostgreSQL
-- NaN and Infinity sort above every number). This makes those values impossible instead, so every order has a usable
-- booked total; it also keeps the report's (total_price * 100)::bigint order sum from overflowing.
--
-- Adds one CHECK: orders.total_price < 1e15, the report's own limit (false for NaN, Infinity and totals of
-- $1,000,000,000,000,000 or more; -Infinity was already refused by the non-negative check). total_price is NOT NULL.
-- Checked 2026-11-21, read-only: live 69 orders and staging 12, none NaN or infinite (and none with part cents).
-- Added NOT VALID, then validated in the same transaction: an existing bad row would refuse the whole file, changing
-- nothing. No row, function, grant or policy changes.
--
-- Rollback: ALTER TABLE public.orders DROP CONSTRAINT orders_total_price_finite; (its own reviewed migration).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE orders_total_price_finite_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.orders_total_price_finite_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.orders_total_price_finite_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_total_price_finite') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: orders_total_price_finite already exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_total_price_non_negative'
                   AND convalidated AND pg_get_constraintdef(oid) = 'CHECK ((total_price >= (0)::numeric))') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: orders_total_price_non_negative is missing or changed, so -Infinity might not be refused';
  END IF;
END
$preflight$;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_total_price_finite CHECK (total_price < 1e15) NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_total_price_finite;
