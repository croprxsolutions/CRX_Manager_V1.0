-- Written 2026-11-04. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261107030000_job_reservation_whole_hundredths.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-100, follow-up to S02 20261106110000): a Partial Order must be in whole hundredths, but a
--   spray job that reserves product from a booking drew an unrounded unit conversion from it. 1 fl oz
--   from a 10 gal booking drew 0.0078125 gal and left 9.9921875 gal, which no Partial Order can take,
--   so the booking could never close. _sync_quote_job_reservations (the only writer of
--   job_product_draws) now keeps the booking's job draws in whole hundredths. Each active job, in
--   FIFO order, draws the step it alone adds to the booking's completed and invoiced job demand
--   rounded to 0.01 (half up, as save_quote rounds a booking), measured from the larger of that
--   rounded demand and the kept draws, capped at its own demand rounded up and at the open booking
--   balance. No job counts an active sibling's demand, so a sibling cancelled later leaves no
--   borrowed rounding in a kept draw; and a completed job's shortfall (it outran an older, smaller
--   booking) is never caught up, by one job or by many small ones each rounding up. Active siblings
--   may briefly over-reserve together; complete_job's status update re-syncs every sibling in the
--   same transaction, so each completion adds exactly its rounding step to the kept draws and many
--   small jobs never drift from what was really applied. A job's inventory hold is at least its draw
--   (a draw rounded up would otherwise leave the shed holding less than the booking gave up). The preflight refuses if any job
--   already has a draw finer than 0.01 (a kept one is never rebuilt; an active one would wait for
--   its next sync).
--
-- NOT CHANGED: a hold whose demand is above its draw (still the full demand); the FIFO order and
--   the cap at the open booking balance; the kept draws of completed or invoiced jobs; every caller;
--   owner, SECURITY DEFINER, search_path and grants. No table, column, grant or row is added,
--   changed or deleted; a job's draw is rebuilt only when it or its booking next syncs (live had no
--   job draws on 2026-11-04).
--
-- KNOWN LIMIT: complete_job finishes one job per call. A direct status write that completes several
--   sibling jobs in one statement (bypassing complete_job) syncs only after all of them, so each
--   keeps its own step and the kept draws can sit up to about 0.005 per such job off the rounded
--   total, either way (two 0.004 gal jobs keep 0 for 0.008 applied). The fix for that path is to stop
--   direct status writes on jobs, not this sync.
--
-- ROLLBACK (its own reviewed migration): re-emit _sync_quote_job_reservations from its
--   20260710120000 body.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE job_draw_hundredths_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF to_regclass('pg_temp.job_draw_hundredths_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.job_draw_hundredths_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'JOB_DRAW_HUNDREDTHS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- The re-emitted function, pinned to its current body (20260710120000), owner, mode, search_path
  -- and EXECUTE grants. It has exactly one overload.
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._sync_quote_job_reservations(uuid,uuid)');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_sync_quote_job_reservations') <> 1
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '04ee0476248f3619d20df7a4e5e9a760'
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres', 'service_role'] THEN
    RAISE EXCEPTION 'PREFLIGHT_SYNC_QUOTE_JOB_RESERVATIONS_DRIFT: _sync_quote_job_reservations differs from its pinned body, owner, mode, search_path or grants';
  END IF;
  -- An unrounded draw would still strand its booking: a completed or invoiced job keeps its draw
  -- (the sync never rebuilds it), and an active one waits for its next sync. None existed on
  -- 2026-11-04; refuse rather than guess a fix.
  IF EXISTS (
    SELECT 1 FROM public.job_product_draws WHERE scale(trim_scale(quantity_drawn)) > 2
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_KEPT_JOB_DRAW_NOT_HUNDREDTHS: a job has a draw finer than 0.01; reconcile it before applying';
  END IF;
END
$preflight$;

-- _sync_quote_job_reservations: the 20260710120000 body, with the booking's job draws in whole hundredths.
CREATE OR REPLACE FUNCTION public._sync_quote_job_reservations(p_quote_id uuid, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_quote quotes%ROWTYPE;
  v_planned_open boolean := false;
  v_actor uuid;
  v_row RECORD;
  v_prev_product uuid;
  v_booking numeric;
  v_order_drawn numeric;
  v_consumed_drawn numeric;
  v_crop_pool numeric := 0;
  v_completed_demand numeric := 0; -- JOB_DRAW_HUNDREDTHS
  v_draw numeric;
  v_hold numeric;
BEGIN
  v_actor := COALESCE(p_actor, auth.uid());

  -- Lock the parent quote (same rule the per-job engine used: 'accepted' still
  -- counts as open; only declined/expired/cancelled do not). This lock also
  -- serializes concurrent job syncs on the same quote AND the save_quote unplan
  -- guard (both take the quote FOR UPDATE first).
  SELECT * INTO v_quote FROM quotes
  WHERE id = p_quote_id AND deleted_at IS NULL
  FOR UPDATE;
  -- LAYER2<<< 'closed_by_application' (a booking fulfilled by us applying it) is
  -- a terminal, NOT-open booking too — exclude it so a stray later job event
  -- can't re-draw against the closed booking's balance. (owner 2026-07-03)
  -- U5<<< 'closed_short' (a booking the customer abandoned) is likewise terminal
  -- and NOT-open — exclude it so a stray later job event can't re-draw. (#1)
  v_planned_open := FOUND
    AND v_quote.is_planned
    AND v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short');
  -- >>>U5 >>>LAYER2

  -- Clean slate for this quote's job reservations:
  --   * drop every 'job' hold for jobs on this quote (the loop re-adds one per
  --     ACTIVE job);
  --   * drop draws for every NON-consumed job (ACTIVE -> rebuilt below;
  --     cancelled / soft-deleted-while-active -> stay gone). KEEP completed /
  --     invoiced job draws: that chemical was physically applied (complete_job
  --     already deducted the stock), so its draw permanently consumes the booking.
  DELETE FROM inventory_holds
   WHERE hold_type = 'job'
     AND source_id IN (SELECT id FROM jobs WHERE quote_id = p_quote_id);

  DELETE FROM job_product_draws jpd
   USING jobs j
   WHERE jpd.job_id = j.id
     AND jpd.quote_id = p_quote_id
     AND j.status NOT IN ('completed', 'invoiced');

  -- Coordinated allocation across ACTIVE sibling jobs, product by product.
  -- crop_pool = booking - order_drawn - consumed_job_drawn = the booking balance
  -- still open to draw. Active jobs draw from it FIFO (by job creation) so their
  -- DRAWS never exceed the booking (no double-BILL, and a cancelled sibling frees
  -- crop the next re-sync re-draws — push-gate #2). But the job HOLD is the FULL
  -- application demand: chemical-sale (order) stock is a SEPARATE channel — delivered
  -- to the customer, not available for us to apply — so it must NOT offset the shed
  -- reservation (owner 2026-07-03, push-gate #A). The drawn portion shrinks the crop
  -- hold (net-zero within the booking); demand beyond the drawable booking is real
  -- extra shed need. For a lone job this yields hold = demand (draw + undrawn excess).
  v_prev_product := NULL;
  FOR v_row IN
    SELECT j.id AS job_id, j.customer_id, j.job_number, j.created_by, j.created_at,
           jc.product_id,
           -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
           SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS demand
    FROM jobs j
    JOIN job_chemicals jc ON jc.job_id = j.id
    JOIN products p ON p.id = jc.product_id
    WHERE j.quote_id = p_quote_id
      AND j.deleted_at IS NULL
      AND j.status IN ('scheduled', 'in_progress')
      AND jc.product_id IS NOT NULL
      -- U4<<< a grower-supplied line demands nothing from our shed — it must not
      -- draw the booking nor add a 'job' hold. (#102)
      AND jc.customer_supplied = false
      -- >>>U4
    GROUP BY j.id, j.customer_id, j.job_number, j.created_by, j.created_at, jc.product_id
    HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) > 0
    ORDER BY jc.product_id, j.created_at NULLS LAST, j.id
  LOOP
    IF v_row.product_id IS DISTINCT FROM v_prev_product THEN
      -- New product: lock its inventory row (serialize concurrent same-product
      -- reserves; lock order quote -> inventory matches draw_down_quote), then
      -- (re)compute the drawable crop pool.
      PERFORM 1 FROM inventory
      WHERE product_id = v_row.product_id AND location = 'Main Warehouse'
      FOR UPDATE;

      IF v_planned_open THEN
        SELECT COALESCE(SUM(qi.total_units_needed), 0) INTO v_booking
        FROM quote_items qi
        WHERE qi.quote_id = p_quote_id AND qi.product_id = v_row.product_id;

        SELECT COALESCE(quantity_drawn, 0) INTO v_order_drawn
        FROM quote_product_draws
        WHERE quote_id = p_quote_id AND product_id = v_row.product_id;
        v_order_drawn := COALESCE(v_order_drawn, 0);

        -- After the DELETE above, the only job_product_draws rows left for this
        -- quote+product belong to completed/invoiced (consumed) jobs -- their
        -- chemical was applied, so it permanently consumes the booking.
        SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_consumed_drawn
        FROM job_product_draws
        WHERE quote_id = p_quote_id AND product_id = v_row.product_id;

        v_crop_pool := GREATEST(v_booking - v_order_drawn - v_consumed_drawn, 0);
        -- JOB_DRAW_HUNDREDTHS<<< (20261107030000, KI-100) A booking and its Partial Orders are in whole
        -- hundredths (20261106110000), so the booking's job draws are too: an unrounded unit conversion
        -- (1 fl oz = 0.0078125 gal) would leave a remainder no Partial Order can take. Each active job
        -- draws against the booking's completed and invoiced job demand only, rounded to 0.01, so many
        -- small jobs never keep more (or less) than half a hundredth off what was applied.
        SELECT COALESCE(SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)), 0)
          INTO v_completed_demand
          FROM jobs j
          JOIN job_chemicals jc ON jc.job_id = j.id
          JOIN products p ON p.id = jc.product_id
         WHERE j.quote_id = p_quote_id
           AND jc.product_id = v_row.product_id
           AND jc.customer_supplied = false
           AND j.status IN ('completed', 'invoiced');
        v_crop_pool := ROUND(FLOOR(v_crop_pool * 100) / 100, 2);
        -- >>>JOB_DRAW_HUNDREDTHS
      ELSE
        v_crop_pool := 0;
      END IF;

      v_prev_product := v_row.product_id;
    END IF;

    -- Draw from the open booking balance (for billing / no double-bill), FIFO.
    -- JOB_DRAW_HUNDREDTHS<<< Each active job draws the step it alone would add to the booking's rounded
    -- completed demand: ROUND(completed demand + its own demand) less the larger of ROUND(completed
    -- demand) and the kept draws. It never counts an active sibling, so a sibling cancelled later leaves
    -- no borrowed rounding behind. A completed job's shortfall (kept draws below the rounded completed
    -- demand, e.g. it outran an older, smaller booking) is never caught up, by one job or by many small
    -- ones each rounding up; kept draws above it are absorbed by later steps. Active siblings may
    -- briefly over-reserve together; each completion re-syncs the rest (complete_job's status update
    -- fires _sync_job_holds in the same transaction), so the kept draws move by ROUND(completed demand).
    -- Never more than the job's own demand rounded up.
    v_draw := LEAST(GREATEST(ROUND(v_completed_demand + v_row.demand, 2) - GREATEST(ROUND(v_completed_demand, 2), v_consumed_drawn), 0), ROUND(CEIL(v_row.demand * 100) / 100, 2), v_crop_pool);
    -- >>>JOB_DRAW_HUNDREDTHS
    v_crop_pool := v_crop_pool - v_draw;
    -- Hold the FULL application demand in the shed (channels don't offset, #A).
    -- JOB_DRAW_HUNDREDTHS<<< A draw rounded up takes more from the booking hold than the demand; hold
    -- at least the draw so the shed never holds less than the booking gave up.
    v_hold := GREATEST(v_row.demand, v_draw);
    -- >>>JOB_DRAW_HUNDREDTHS

    IF v_draw > 0 THEN
      INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn)
      VALUES (v_row.job_id, p_quote_id, v_row.product_id, v_draw)
      ON CONFLICT (job_id, product_id)
      DO UPDATE SET quantity_drawn = EXCLUDED.quantity_drawn,
                    quote_id       = EXCLUDED.quote_id,
                    updated_at     = now();
    END IF;

    -- status-enum-check: exempt (writes the 'job' hold_type added by A1 20260702170000)
    IF v_hold > 0 THEN
      INSERT INTO inventory_holds (
        product_id, customer_id, quantity, hold_type, source_id,
        notes, created_by, expires_at, is_active
      ) VALUES (
        v_row.product_id, v_row.customer_id, v_hold, 'job', v_row.job_id,
        'Job reservation for ' || COALESCE(v_row.job_number, v_row.job_id::text),
        COALESCE(v_actor, v_row.created_by), NULL, true
      );
    END IF;
  END LOOP;

  -- Resync the parent quote's crop_program holds to reflect the new job draws
  -- (A2 made _sync_planned_holds job-draw-aware). Self-guards on a missing /
  -- deleted quote, so calling it unconditionally is safe.
  PERFORM _sync_planned_holds(p_quote_id, v_actor);
END;
$function$
;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._sync_quote_job_reservations(uuid,uuid)');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_sync_quote_job_reservations') <> 1
     OR position('v_draw := LEAST(GREATEST(ROUND(v_completed_demand + v_row.demand, 2) - GREATEST(ROUND(v_completed_demand, 2), v_consumed_drawn), 0), ROUND(CEIL(v_row.demand * 100) / 100, 2), v_crop_pool);' IN p.prosrc) = 0
     OR position('INTO v_completed_demand' IN p.prosrc) = 0
     OR position('v_hold := GREATEST(v_row.demand, v_draw);' IN p.prosrc) = 0
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres', 'service_role'] THEN
    RAISE EXCEPTION 'POSTFLIGHT: _sync_quote_job_reservations lost its change, owner, mode, search_path or grants';
  END IF;
END
$postflight$;
