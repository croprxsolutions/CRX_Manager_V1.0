-- REVERSE of 20270226213000_refuse_impossible_quantities_and_dates (#2237). Apply as its own reviewed migration,
-- one transaction. Drops exactly the 11 CHECK constraints that migration added, and only if each is still the
-- exact definition it installed on the right table (otherwise it refuses and changes nothing). No row changes.
-- Proven by scripts/smoke/prove-refuse-impossible-quantities-and-dates-real-schema.mjs.

SET LOCAL lock_timeout = '5s';
-- The expected definitions below are rendered in ISO dates (Sol r1).
SET LOCAL datestyle = 'ISO, MDY';

CREATE TEMP TABLE refuse_impossible_2237_reverse_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

-- Under autocommit the marker is already gone here: refuse before anything else runs.
DO $tx$
BEGIN
  IF to_regclass('pg_temp.refuse_impossible_2237_reverse_tx') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: run this file as one transaction (psql -1 or the apply script)';
  END IF;
END;
$tx$;

CREATE TEMP TABLE refuse_impossible_2237_reverse_expected (tbl text, conname text, def text) ON COMMIT DROP;
INSERT INTO pg_temp.refuse_impossible_2237_reverse_expected VALUES
  ('job_chemicals', 'job_chemicals_quantity_finite_chk', 'CHECK (((quantity > ''-Infinity''::numeric) AND (quantity < ''Infinity''::numeric)))'),
  ('jobs', 'jobs_job_date_window_chk', 'CHECK (((job_date >= ''2000-01-01''::date) AND (job_date <= ''2099-12-31''::date)))'),
  ('inventory', 'inventory_quantity_available_finite_chk', 'CHECK (((quantity_available > ''-Infinity''::numeric) AND (quantity_available < ''Infinity''::numeric)))'),
  ('inventory', 'inventory_quantity_prebooked_finite_chk', 'CHECK (((quantity_prebooked > ''-Infinity''::numeric) AND (quantity_prebooked < ''Infinity''::numeric)))'),
  ('inventory', 'inventory_quantity_on_order_finite_chk', 'CHECK (((quantity_on_order > ''-Infinity''::numeric) AND (quantity_on_order < ''Infinity''::numeric)))'),
  ('order_items', 'order_items_quantity_remaining_finite_chk', 'CHECK (((quantity_remaining > ''-Infinity''::numeric) AND (quantity_remaining < ''Infinity''::numeric)))'),
  ('order_items', 'order_items_total_units_needed_finite_chk', 'CHECK (((total_units_needed > ''-Infinity''::numeric) AND (total_units_needed < ''Infinity''::numeric)))'),
  ('order_items', 'order_items_quantity_delivered_finite_chk', 'CHECK (((quantity_delivered > ''-Infinity''::numeric) AND (quantity_delivered < ''Infinity''::numeric)))'),
  ('deliveries', 'deliveries_scheduled_date_window_chk', 'CHECK (((scheduled_date >= ''2000-01-01''::date) AND (scheduled_date <= ''2099-12-31''::date)))'),
  ('delivery_items', 'delivery_items_quantity_finite_chk', 'CHECK (((quantity > ''-Infinity''::numeric) AND (quantity < ''Infinity''::numeric)))'),
  ('delivery_items', 'delivery_items_quantity_delivered_finite_chk', 'CHECK (((quantity_delivered > ''-Infinity''::numeric) AND (quantity_delivered < ''Infinity''::numeric)))');

DO $preflight$
DECLARE
  r record;
BEGIN
  IF to_regclass('pg_temp.refuse_impossible_2237_reverse_tx') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.refuse_impossible_2237_reverse_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  -- NOWAIT: refuse at once if any table is in use, so the rollback never waits and cannot deadlock a live edit (Sol r1).
  LOCK TABLE public.deliveries, public.delivery_items, public.order_items, public.jobs, public.job_chemicals,
    public.inventory IN ACCESS EXCLUSIVE MODE NOWAIT;
  FOR r IN SELECT * FROM pg_temp.refuse_impossible_2237_reverse_expected LOOP
    IF (SELECT count(*) FROM pg_constraint c
        WHERE c.conrelid = format('public.%I', r.tbl)::regclass AND c.conname = r.conname AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) = r.def) <> 1 THEN
      RAISE EXCEPTION 'ROLLBACK_REFUSED: %.% is missing or not the definition 20270226213000 installed', r.tbl, r.conname;
    END IF;
  END LOOP;
END;
$preflight$;

ALTER TABLE public.job_chemicals DROP CONSTRAINT job_chemicals_quantity_finite_chk;
ALTER TABLE public.jobs DROP CONSTRAINT jobs_job_date_window_chk;
ALTER TABLE public.inventory
  DROP CONSTRAINT inventory_quantity_available_finite_chk,
  DROP CONSTRAINT inventory_quantity_prebooked_finite_chk,
  DROP CONSTRAINT inventory_quantity_on_order_finite_chk;
ALTER TABLE public.order_items
  DROP CONSTRAINT order_items_quantity_remaining_finite_chk,
  DROP CONSTRAINT order_items_total_units_needed_finite_chk,
  DROP CONSTRAINT order_items_quantity_delivered_finite_chk;
ALTER TABLE public.deliveries DROP CONSTRAINT deliveries_scheduled_date_window_chk;
ALTER TABLE public.delivery_items
  DROP CONSTRAINT delivery_items_quantity_finite_chk,
  DROP CONSTRAINT delivery_items_quantity_delivered_finite_chk;

DO $postflight$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_temp.refuse_impossible_2237_reverse_expected e ON e.conname = c.conname
             WHERE c.connamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a #2237 constraint is still there';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: the 11 #2237 constraints are removed';
END;
$postflight$;
