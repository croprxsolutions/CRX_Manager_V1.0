-- #2237 (follow-up to #1989, Mason 2026-11-22): the database refuses a quantity that is not a real number (NaN,
-- Infinity, -Infinity) and a job or delivery date outside 2000-01-01..2099-12-31 (the window Mason set for the
-- purchasing plan) in the field, stock and order tables the plan reads. The plan's skip-and-flag guards stay as a
-- second line of defence. Same "x > '-Infinity' AND x < 'Infinity'" form as the money columns: PostgreSQL sorts NaN
-- above Infinity, so "< 'Infinity'" also refuses NaN. A CHECK binds every writer, replica mode included.
-- No row changes: the preflight refuses to apply (naming each table, column and count) if any row already breaks a rule.
-- Out of scope (Taha's lanes until 2026-12-15): quote_items, quote_sections, quote_product_draws, job_product_draws,
-- inventory_holds, purchase_orders, purchase_order_items. Production had 0 such values in each on 2026-11-23.
--
-- idempotency-body-check: exempt -- no RPC is created or changed; constraints only.
--
-- ROLLBACK: scripts/smoke/refuse-impossible-quantities-and-dates-reverse.sql (proven by
--   scripts/smoke/prove-refuse-impossible-quantities-and-dates-real-schema.mjs).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE refuse_impossible_2237_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  r record;
  v_n bigint;
  v_bad text := '';
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.refuse_impossible_2237_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.refuse_impossible_2237_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname IN ('job_chemicals_quantity_finite_chk', 'jobs_job_date_window_chk',
                      'inventory_quantity_available_finite_chk', 'inventory_quantity_prebooked_finite_chk',
                      'inventory_quantity_on_order_finite_chk', 'order_items_quantity_remaining_finite_chk',
                      'order_items_total_units_needed_finite_chk', 'order_items_quantity_delivered_finite_chk',
                      'deliveries_scheduled_date_window_chk', 'delivery_items_quantity_finite_chk',
                      'delivery_items_quantity_delivered_finite_chk')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: already applied (a #2237 constraint exists)';
  END IF;
  -- Lock every table first so no writer can add a bad row between the count below and the constraints. Completions
  -- take deliveries (or jobs) before the others, as this order does, so they wait rather than deadlock; a writer that
  -- takes these tables in another order may be aborted by deadlock detection and retried. Each wait is capped by
  -- lock_timeout; the locks are held until commit, so apply at a quiet time.
  LOCK TABLE public.deliveries, public.delivery_items, public.order_items, public.jobs, public.job_chemicals,
    public.inventory IN ACCESS EXCLUSIVE MODE;
  -- Count rows that would break each rule; refuse rather than fix them silently (fixing needs Mason).
  FOR r IN
    SELECT * FROM (VALUES
      ('job_chemicals', 'quantity', 'n'), ('jobs', 'job_date', 'd'),
      ('inventory', 'quantity_available', 'n'), ('inventory', 'quantity_prebooked', 'n'),
      ('inventory', 'quantity_on_order', 'n'), ('order_items', 'quantity_remaining', 'n'),
      ('order_items', 'total_units_needed', 'n'), ('order_items', 'quantity_delivered', 'n'),
      ('deliveries', 'scheduled_date', 'd'), ('delivery_items', 'quantity', 'n'),
      ('delivery_items', 'quantity_delivered', 'n')
    ) AS t(tbl, col, kind)
  LOOP
    EXECUTE format(
      CASE r.kind
        WHEN 'n' THEN 'SELECT count(*) FROM public.%1$I WHERE NOT (%2$I > ''-Infinity''::numeric AND %2$I < ''Infinity''::numeric)'
        ELSE 'SELECT count(*) FROM public.%1$I WHERE NOT (%2$I BETWEEN DATE ''2000-01-01'' AND DATE ''2099-12-31'')'
      END, r.tbl, r.col) INTO v_n;
    IF v_n > 0 THEN
      v_bad := v_bad || format(' %s.%s=%s', r.tbl, r.col, v_n);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'IMPOSSIBLE_VALUES_PRESENT: rows already break the new rules (table.column=count):%. Fix them first; nothing was changed.', v_bad;
  END IF;
END;
$preflight$;

ALTER TABLE public.job_chemicals
  ADD CONSTRAINT job_chemicals_quantity_finite_chk
    CHECK (quantity > '-Infinity'::numeric AND quantity < 'Infinity'::numeric);

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_job_date_window_chk
    CHECK (job_date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31');

ALTER TABLE public.inventory
  ADD CONSTRAINT inventory_quantity_available_finite_chk
    CHECK (quantity_available > '-Infinity'::numeric AND quantity_available < 'Infinity'::numeric),
  ADD CONSTRAINT inventory_quantity_prebooked_finite_chk
    CHECK (quantity_prebooked > '-Infinity'::numeric AND quantity_prebooked < 'Infinity'::numeric),
  ADD CONSTRAINT inventory_quantity_on_order_finite_chk
    CHECK (quantity_on_order > '-Infinity'::numeric AND quantity_on_order < 'Infinity'::numeric);

ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_quantity_remaining_finite_chk
    CHECK (quantity_remaining > '-Infinity'::numeric AND quantity_remaining < 'Infinity'::numeric),
  ADD CONSTRAINT order_items_total_units_needed_finite_chk
    CHECK (total_units_needed > '-Infinity'::numeric AND total_units_needed < 'Infinity'::numeric),
  ADD CONSTRAINT order_items_quantity_delivered_finite_chk
    CHECK (quantity_delivered > '-Infinity'::numeric AND quantity_delivered < 'Infinity'::numeric);

ALTER TABLE public.deliveries
  ADD CONSTRAINT deliveries_scheduled_date_window_chk
    CHECK (scheduled_date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31');

-- quantity_delivered may be NULL (not yet delivered); a CHECK passes NULL.
ALTER TABLE public.delivery_items
  ADD CONSTRAINT delivery_items_quantity_finite_chk
    CHECK (quantity > '-Infinity'::numeric AND quantity < 'Infinity'::numeric),
  ADD CONSTRAINT delivery_items_quantity_delivered_finite_chk
    CHECK (quantity_delivered > '-Infinity'::numeric AND quantity_delivered < 'Infinity'::numeric);

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND contype = 'c' AND convalidated
        AND conname IN ('job_chemicals_quantity_finite_chk', 'jobs_job_date_window_chk',
                        'inventory_quantity_available_finite_chk', 'inventory_quantity_prebooked_finite_chk',
                        'inventory_quantity_on_order_finite_chk', 'order_items_quantity_remaining_finite_chk',
                        'order_items_total_units_needed_finite_chk', 'order_items_quantity_delivered_finite_chk',
                        'deliveries_scheduled_date_window_chk', 'delivery_items_quantity_finite_chk',
                        'delivery_items_quantity_delivered_finite_chk')) <> 11 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not all 11 #2237 constraints are present and validated';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: 11 constraints refuse NaN/infinite quantities and dates outside 2000-2099';
END;
$postflight$;
