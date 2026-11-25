-- ROLLBACK TEXT for 20270307120000_booking_close_guard_applied_and_short.sql (not a migration; a rollback ships as its own
-- reviewed migration). Re-creates _enforce_booking_live_job_rules() exactly as 20270129150000 left it. Used by
-- scripts/smoke/prove-booking-close-guard-real-schema.mjs to show the gaps come back.

CREATE OR REPLACE FUNCTION public._enforce_booking_live_job_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job record;
BEGIN
  -- Sol HIGH r1, r4: every check below reads jobs. At REPEATABLE READ or SERIALIZABLE it would read the transaction's
  -- first snapshot and could miss a job scheduled, or reopened, meanwhile by a session that only locked this booking.
  -- The app always runs READ COMMITTED, where the checks see it once the booking row lock is granted.
  IF ((OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
      OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_short'))
      OR NEW.customer_id IS DISTINCT FROM OLD.customer_id)
     AND current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'BOOKING_NEEDS_READ_COMMITTED: change booking % in a READ COMMITTED transaction, so a spray job scheduled or reopened meanwhile is seen.',
      NEW.quote_number
      USING ERRCODE = 'P0001';
  END IF;
  -- PR-D1 (#1990 Sol 4): a soft delete skipped this trigger (it fired on status and customer_id only), so a
  -- booking could be deleted with a spray job still scheduled or in progress from it. Refused while one comes
  -- from the booking or one of its sections; a completed or cancelled job does not block.
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    SELECT j.job_number INTO v_job
    FROM public.jobs j
    WHERE (j.quote_id = NEW.id
           OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = NEW.id))
      AND j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')
    ORDER BY j.job_number, j.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'BOOKING_HAS_JOB: spray job % was made from this booking, so the booking cannot be deleted. Cancel or complete the job first.',
        v_job.job_number
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- Sol HIGH (#1959): closing short releases the booking's holds. The existing rule (20261105160000) refuses
  -- it only for scheduled/in-progress jobs linked by quote_id; a job linked through a section counts too.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'closed_short' THEN
    SELECT j.job_number INTO v_job
    FROM public.jobs j
    WHERE (j.quote_id = NEW.id
           OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = NEW.id))
      AND j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')
    ORDER BY j.job_number, j.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'BOOKING_HAS_JOB: spray job % was made from this booking, so the booking cannot be closed short. Cancel or complete the job first.',
        v_job.job_number
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NOT ((NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('accepted', 'declined', 'expired', 'cancelled'))
          OR NEW.customer_id IS DISTINCT FROM OLD.customer_id) THEN
    RETURN NEW;
  END IF;
  SELECT j.job_number, j.status INTO v_job
  FROM public.jobs j
  WHERE (j.quote_id = NEW.id
         OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = NEW.id))
    AND j.deleted_at IS NULL AND j.status <> 'cancelled'
  ORDER BY j.job_number, j.id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  -- Mason 2026-11-18 ("Let it close"): a booking whose every booked product is fully drawn onto orders
  -- may close as accepted even with a live job; draw_down_quote does this on its last draw (the same
  -- per-product test as 20261029110000, but a booking with nothing booked does not count as drawn).
  IF NEW.status = 'accepted' AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
     AND EXISTS (SELECT 1 FROM public.quote_items qi WHERE qi.quote_id = NEW.id
                 GROUP BY qi.product_id HAVING SUM(COALESCE(qi.total_units_needed, 0)) > 0)
     AND NOT EXISTS (
       SELECT 1
       FROM (SELECT qi.product_id, SUM(COALESCE(qi.total_units_needed, 0)) AS booked
             FROM public.quote_items qi WHERE qi.quote_id = NEW.id GROUP BY qi.product_id) b
       LEFT JOIN public.quote_product_draws d ON d.quote_id = NEW.id AND d.product_id = b.product_id
       WHERE b.booked > 0 AND COALESCE(d.quantity_drawn, 0) < b.booked) THEN
    RETURN NEW;
  END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'BOOKING_HAS_JOB: job % was scheduled from this booking, so its customer cannot change. Cancel the job first, or start a new booking.',
      v_job.job_number
      USING ERRCODE = 'P0001';
  ELSIF v_job.status IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'BOOKING_HAS_JOB: spray job % was made from this booking, so the booking cannot be marked %. Cancel the job first.',
      v_job.job_number, NEW.status
      USING ERRCODE = 'P0001';
  ELSE
    RAISE EXCEPTION 'BOOKING_HAS_JOB: spray job % was made from this booking and is %, so the booking cannot be marked %. Ask an admin.',
      v_job.job_number, v_job.status, NEW.status
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

ALTER FUNCTION public._enforce_booking_live_job_rules() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._enforce_booking_live_job_rules() FROM PUBLIC, anon, authenticated, service_role;
