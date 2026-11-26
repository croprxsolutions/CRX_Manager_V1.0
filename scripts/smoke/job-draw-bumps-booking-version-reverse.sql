-- Rollback for 20270309040000_job_draw_bumps_booking_version.sql: re-emits the 20261107070000 body of
-- _sync_quote_job_reservations (md5 2e62bad29abc2ba33cb0e2f06a2d4a64), so job draws stop moving the
-- booking's version. Ship it as its own reviewed migration if needed. Owner, mode, search_path and
-- grants are unchanged by CREATE OR REPLACE and checked after.

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._sync_quote_job_reservations(uuid,uuid)');
  IF NOT FOUND
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM 'dceb55c5ff8556ac974a97a7e85d11b1' THEN
    RAISE EXCEPTION 'JOB_DRAW_VERSION_REVERSE_PREFLIGHT: _sync_quote_job_reservations is not the 20270309040000 body (md5 dceb55c5ff8556ac974a97a7e85d11b1)';
  END IF;
END
$preflight$;

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
  v_completing uuid; -- JOB_DRAW_HUNDREDTHS
  v_pending uuid[]; -- JOB_DRAW_HUNDREDTHS
  v_own_drawn numeric; -- JOB_DRAW_HUNDREDTHS
  v_pending_drawn numeric; -- JOB_DRAW_HUNDREDTHS
  v_pending_demand numeric; -- JOB_DRAW_HUNDREDTHS
  v_counted_drawn numeric := 0; -- JOB_DRAW_HUNDREDTHS
  v_draw numeric;
  v_hold numeric;
BEGIN
  v_actor := COALESCE(p_actor, auth.uid());
  -- JOB_DRAW_HUNDREDTHS<<< A signed-in caller can only act as itself; every caller passes auth.uid(),
  -- and system calls (no auth.uid()) keep their explicit actor (RLS reviewer, 2026-11-05).
  IF p_actor IS NOT NULL AND auth.uid() IS NOT NULL AND p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;
  -- The job whose completion fired this sync, if any, and the jobs completed by
  -- the same statement whose own completion sync has not run yet. Only the jobs triggers set them
  -- (transaction-local; each completion clears its own entries after its sync).
  v_completing := NULLIF(current_setting('crx.job_completing', true), '')::uuid;
  v_pending := string_to_array(NULLIF(current_setting('crx.jobs_completing_pending', true), ''), ',')::uuid[];
  -- >>>JOB_DRAW_HUNDREDTHS

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
           (j.id IS NOT DISTINCT FROM v_completing) AS completing, -- JOB_DRAW_HUNDREDTHS
           -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
           SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS demand
    FROM jobs j
    JOIN job_chemicals jc ON jc.job_id = j.id
    JOIN products p ON p.id = jc.product_id
    WHERE j.quote_id = p_quote_id
      AND j.deleted_at IS NULL
      -- JOB_DRAW_HUNDREDTHS<<< plus the job completing now, rebuilt first for its product (below)
      AND (j.status IN ('scheduled', 'in_progress')
           OR (j.id IS NOT DISTINCT FROM v_completing AND j.status = 'completed'))
      -- >>>JOB_DRAW_HUNDREDTHS
      AND jc.product_id IS NOT NULL
      -- U4<<< a grower-supplied line demands nothing from our shed — it must not
      -- draw the booking nor add a 'job' hold. (#102)
      AND jc.customer_supplied = false
      -- >>>U4
    GROUP BY j.id, j.customer_id, j.job_number, j.created_by, j.created_at, jc.product_id
    HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) > 0
    ORDER BY jc.product_id, (j.id IS NOT DISTINCT FROM v_completing) DESC, j.created_at NULLS LAST, j.id
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
        -- JOB_DRAW_HUNDREDTHS<<< (20261107070000, KI-100) A booking and its Partial Orders are in whole
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
        -- Each kept draw counts at most its job's current demand rounded up, so a completed job
        -- edited down later never hides later jobs' demand (Sol HIGH and Codex P2, 2026-11-05).
        SELECT COALESCE(SUM(LEAST(d.quantity_drawn, ROUND(CEIL(COALESCE(jd.demand, 0) * 100) / 100, 2))), 0)
          INTO v_counted_drawn
          FROM job_product_draws d
          LEFT JOIN LATERAL (
            SELECT SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS demand
              FROM job_chemicals jc
              JOIN products p ON p.id = jc.product_id
             WHERE jc.job_id = d.job_id AND jc.product_id = d.product_id AND jc.customer_supplied = false
          ) jd ON true
         WHERE d.quote_id = p_quote_id AND d.product_id = v_row.product_id
           AND NOT (d.job_id = ANY (ARRAY[]::uuid[]));
        v_crop_pool := ROUND(FLOOR(v_crop_pool * 100) / 100, 2);
        -- >>>JOB_DRAW_HUNDREDTHS
      ELSE
        v_crop_pool := 0;
      END IF;

      v_prev_product := v_row.product_id;
    END IF;

    -- JOB_DRAW_HUNDREDTHS<<< The job completing now keeps a draw rebuilt as its own standalone step:
    -- what it alone adds to the other completed jobs' rounded demand, against the booking less the
    -- order and the other kept draws. Active siblings' provisional draws (deleted above) never starve
    -- it, so a later job completing first keeps its real step, not the 0 FIFO left it while active.
    -- Jobs completed by the same statement and not yet rebuilt are left out of that base (their
    -- provisional draws too); each is rebuilt by its own row in turn, so one statement completing
    -- several jobs keeps what completing them one at a time would.
    IF v_row.completing THEN
      IF v_planned_open THEN
        SELECT COALESCE(SUM(quantity_drawn) FILTER (WHERE job_id = v_row.job_id), 0),
               COALESCE(SUM(quantity_drawn) FILTER (WHERE job_id <> v_row.job_id AND job_id = ANY (COALESCE(v_pending, ARRAY[]::uuid[]))), 0)
          INTO v_own_drawn, v_pending_drawn
          FROM job_product_draws
         WHERE quote_id = p_quote_id AND product_id = v_row.product_id;
        SELECT COALESCE(SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)), 0)
          INTO v_pending_demand
          FROM jobs j
          JOIN job_chemicals jc ON jc.job_id = j.id
          JOIN products p ON p.id = jc.product_id
         WHERE j.quote_id = p_quote_id
           AND jc.product_id = v_row.product_id
           AND jc.customer_supplied = false
           AND j.status IN ('completed', 'invoiced')
           AND j.id <> v_row.job_id
           AND j.id = ANY (COALESCE(v_pending, ARRAY[]::uuid[]));
        v_completed_demand := v_completed_demand - v_row.demand - v_pending_demand;
        v_consumed_drawn := v_consumed_drawn - v_own_drawn - v_pending_drawn;
        -- Each kept draw counts at most its job's current demand rounded up, so a completed job
        -- edited down later never hides later jobs' demand (Sol HIGH and Codex P2, 2026-11-05).
        SELECT COALESCE(SUM(LEAST(d.quantity_drawn, ROUND(CEIL(COALESCE(jd.demand, 0) * 100) / 100, 2))), 0)
          INTO v_counted_drawn
          FROM job_product_draws d
          LEFT JOIN LATERAL (
            SELECT SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS demand
              FROM job_chemicals jc
              JOIN products p ON p.id = jc.product_id
             WHERE jc.job_id = d.job_id AND jc.product_id = d.product_id AND jc.customer_supplied = false
          ) jd ON true
         WHERE d.quote_id = p_quote_id AND d.product_id = v_row.product_id
           AND NOT (d.job_id = ANY (v_row.job_id || COALESCE(v_pending, ARRAY[]::uuid[])));
        -- The first kept job draw on a booking is at least 0.01, so the booking guards that look for a
        -- positive job draw (convert, delete, close) still see product already applied (Sol, 2026-11-05).
        v_draw := LEAST(GREATEST(ROUND(v_completed_demand + v_row.demand, 2) - GREATEST(ROUND(v_completed_demand, 2), v_counted_drawn),
                                 CASE WHEN v_consumed_drawn = 0 AND v_row.demand > 0 THEN 0.01 ELSE 0 END),
                        ROUND(CEIL(v_row.demand * 100) / 100, 2),
                        ROUND(FLOOR(GREATEST(v_booking - v_order_drawn - v_consumed_drawn, 0) * 100) / 100, 2));
        DELETE FROM job_product_draws WHERE job_id = v_row.job_id AND product_id = v_row.product_id;
        IF v_draw > 0 THEN
          INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn)
          VALUES (v_row.job_id, p_quote_id, v_row.product_id, v_draw);
        END IF;
        v_completed_demand := v_completed_demand + v_row.demand + v_pending_demand;
        v_consumed_drawn := v_consumed_drawn + v_draw + v_pending_drawn;
        -- Each kept draw counts at most its job's current demand rounded up, so a completed job
        -- edited down later never hides later jobs' demand (Sol HIGH and Codex P2, 2026-11-05).
        SELECT COALESCE(SUM(LEAST(d.quantity_drawn, ROUND(CEIL(COALESCE(jd.demand, 0) * 100) / 100, 2))), 0)
          INTO v_counted_drawn
          FROM job_product_draws d
          LEFT JOIN LATERAL (
            SELECT SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS demand
              FROM job_chemicals jc
              JOIN products p ON p.id = jc.product_id
             WHERE jc.job_id = d.job_id AND jc.product_id = d.product_id AND jc.customer_supplied = false
          ) jd ON true
         WHERE d.quote_id = p_quote_id AND d.product_id = v_row.product_id
           AND NOT (d.job_id = ANY (ARRAY[]::uuid[]));
        v_crop_pool := ROUND(FLOOR(GREATEST(v_booking - v_order_drawn - v_consumed_drawn, 0) * 100) / 100, 2);
      END IF;
      CONTINUE; -- a completed job holds no shed stock
    END IF;
    -- >>>JOB_DRAW_HUNDREDTHS

    -- Draw from the open booking balance (for billing / no double-bill), FIFO.
    -- JOB_DRAW_HUNDREDTHS<<< Each active job draws the step it alone would add to the booking's rounded
    -- completed demand: ROUND(completed demand + its own demand) less the larger of ROUND(completed
    -- demand) and the kept draws. It never counts an active sibling, so a sibling cancelled later leaves
    -- no borrowed rounding behind. A completed job's shortfall (kept draws below the rounded completed
    -- demand, e.g. it outran an older, smaller booking) is never caught up, by one job or by many small
    -- ones each rounding up; kept draws above it are absorbed by later steps, but each kept draw counts
    -- at most its job's current demand rounded up (v_counted_drawn), so a completed job edited down
    -- later never hides later jobs' demand (Sol HIGH and Codex P2, 2026-11-05). Active siblings may
    -- briefly over-reserve together; each completion re-syncs the rest (complete_job's status update
    -- fires _sync_job_holds in the same transaction), so the kept draws move by ROUND(completed demand).
    -- Never more than the job's own demand rounded up. An active job with any demand draws at least
    -- 0.01 while the booking has it: every booking guard (convert, delete, close, rollover) treats a
    -- positive job draw as the sign an active job is using the booking, so it must never round to
    -- nothing. Its completion rebuild (above) has no such floor, so the kept draws still track ROUND.
    v_draw := LEAST(GREATEST(ROUND(v_completed_demand + v_row.demand, 2) - GREATEST(ROUND(v_completed_demand, 2), v_counted_drawn), 0.01), ROUND(CEIL(v_row.demand * 100) / 100, 2), v_crop_pool);
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
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '2e62bad29abc2ba33cb0e2f06a2d4a64'
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres', 'service_role'] THEN
    RAISE EXCEPTION 'POSTFLIGHT: _sync_quote_job_reservations is not back to its 20261107070000 body, owner, mode, search_path or grants';
  END IF;
END
$postflight$;
