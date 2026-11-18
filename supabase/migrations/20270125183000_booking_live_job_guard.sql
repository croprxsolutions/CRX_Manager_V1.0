-- Bookings Phase A follow-up (#1959): the live-job booking rules hold for every write path.
--
-- WHY: save_quote refuses to mark a booking accepted, declined or expired, or to change its customer,
--   while a live spray job comes from it (rules g and i, 20270125110000; Mason 2026-11-17). Three paths
--   skip save_quote: the booking screen's Decline/Cancel buttons (a direct UPDATE under RLS),
--   convert_quote_to_order (marks a sent booking accepted) and the nightly auto_expire_quotes. Mason
--   accepted Sol's findings on #1947 on the condition this database guard follows.
--
-- WHAT:
--   1. _enforce_booking_live_job_rules(), a BEFORE UPDATE OF status, customer_id row trigger on quotes.
--      While a live job exists (on the quote or one of its sections; not cancelled, not deleted) it refuses
--      BOOKING_HAS_JOB when status changes to accepted, declined, expired or cancelled, or customer_id
--      changes. One exception (Mason 2026-11-18): accepted goes through once every booked product is fully
--      drawn onto orders, which is how draw_down_quote closes a booking on its last draw. It also refuses
--      closed_short while a scheduled or in-progress job comes from the booking or a section (closing short
--      releases the holds; the 20261105160000 rule checked quote_id only). SECURITY DEFINER so a caller whose RLS hides the job is still refused. Job scheduling locks
--      the quote row FOR UPDATE first (_create_job_from_quote_section_replay_impl_20261015) and refuses a
--      booking already in those statuses, so the two serialize on the quote row.
--   1b. _enforce_job_live_on_open_booking(), a BEFORE INSERT OR UPDATE OF quote_id, quote_section_id, status,
--      deleted_at row trigger on jobs: a job cannot become live (inserted, re-linked, or un-deleted) on a booking
--      that is accepted, declined, expired, cancelled, closed_by_application or closed_short (BOOKING_CLOSED; the
--      same statuses the scheduler already refuses). An already-live job keeps moving through its own statuses,
--      but its booking and section link is fixed: to move it, cancel it and schedule a new one (Mason, 2026-11-18).
--   1c. _enforce_section_with_live_job_stays(), a BEFORE INSERT OR UPDATE OF quote_id row trigger on quote_sections:
--      a section that a live job comes from cannot move to another booking (BOOKING_HAS_JOB), including by being
--      deleted and re-inserted under the same id on another booking (the section FK is deferred).
--   2. auto_expire_quotes skips a booking with a live job (the trigger would otherwise fail the whole nightly
--      batch) and its rep gets the existing "Booking past its date" alert once per expiry date.
--   Every other line of auto_expire_quotes is its 20261029100000 body (pinned below).
--
-- NOT CHANGED: save_quote (its rules g and i still run first, same message); get_purchasing_plan; grants;
--   rows already accepted/declined/expired/cancelled with a live job stay as they are (the trigger fires only
--   on a change). No row changes.
--
-- ROLLBACK (its own reviewed migration; stores no data, but reopens the bypasses and lets the nightly expiry
--   close bookings with a live job again): drop triggers quotes_booking_live_job_rules,
--   jobs_live_on_open_booking and quote_sections_live_job_stays and their functions; re-run the 20261029100000 body of auto_expire_quotes after
--   checking it is still this file's body.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'auto_expire_quotes') <> 1
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.auto_expire_quotes()'))
        IS DISTINCT FROM 'd3c9808de0aa40256834f29b95473a88' THEN
    RAISE EXCEPTION 'PREFLIGHT_AUTO_EXPIRE_DRIFT: auto_expire_quotes is not the reviewed 20261029100000 body';
  END IF;
  IF to_regprocedure('public._enforce_booking_live_job_rules()') IS NOT NULL
     OR to_regprocedure('public._enforce_job_live_on_open_booking()') IS NOT NULL
     OR to_regprocedure('public._enforce_section_with_live_job_stays()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quote_sections'::regclass AND tgname = 'quote_sections_live_job_stays')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_booking_live_job_rules')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'jobs_live_on_open_booking') THEN
    RAISE EXCEPTION 'PREFLIGHT_LIVE_JOB_GUARD_EXISTS: the booking live-job guard already exists; re-read live first';
  END IF;
END
$preflight$;

-- 1. The guard.
CREATE FUNCTION public._enforce_booking_live_job_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job record;
BEGIN
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

CREATE TRIGGER quotes_booking_live_job_rules
  BEFORE UPDATE OF status, customer_id ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_booking_live_job_rules();

-- 1b. The other direction: a job cannot become live on a closed booking (a direct insert, re-link,
--     or un-delete under RLS would otherwise skip the scheduler's own status check). Same statuses the
--     scheduler (_create_job_from_quote_section_replay_impl_20261015) refuses. The booking row is locked
--     FOR SHARE, so this and a booking status change serialize on that row; the section row too, so a
--     section moving to a closed booking meanwhile is caught. A live job's booking/section link is frozen.
CREATE FUNCTION public._enforce_job_live_on_open_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_quote_id uuid;
  v_section_quote_id uuid;
  v_quote record;
BEGIN
  -- Mason 2026-11-18 ("A"): a job's booking links are fixed once set, whatever its status, so a job cannot be
  -- cancelled, re-pointed and revived on another booking. Nothing in the app changes them; both FKs are NO ACTION.
  IF TG_OP = 'UPDATE' AND (OLD.quote_id IS NOT NULL OR OLD.quote_section_id IS NOT NULL)
     AND (NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.quote_section_id IS DISTINCT FROM OLD.quote_section_id) THEN
    RAISE EXCEPTION 'BOOKING_HAS_JOB: spray job % stays linked to the booking it was scheduled from. To move it, cancel it and schedule a new one.',
      NEW.job_number
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND OLD.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- The section's booking, read unlocked here, is re-checked under a section lock after the booking locks
  -- below (booking first, then section: the order save_quote locks in).
  IF NEW.quote_section_id IS NOT NULL THEN
    SELECT qs.quote_id INTO v_section_quote_id FROM public.quote_sections qs WHERE qs.id = NEW.quote_section_id;
  END IF;
  FOR v_quote_id IN
    SELECT DISTINCT x.id FROM (VALUES (NEW.quote_id), (v_section_quote_id)) AS x(id)
    WHERE x.id IS NOT NULL
    ORDER BY x.id
  LOOP
    SELECT q.quote_number, q.status INTO v_quote FROM public.quotes q WHERE q.id = v_quote_id FOR SHARE;
    IF FOUND AND v_quote.status IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short') THEN
      RAISE EXCEPTION 'BOOKING_CLOSED: booking % is %, so a spray job cannot be scheduled from it.',
        v_quote.quote_number, v_quote.status
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- A section moving at the same moment: wait for it, then refuse if it no longer belongs to the booking
  -- checked above (Luna HIGH, #1959). Its own trigger refuses the move once this job is committed.
  IF NEW.quote_section_id IS NOT NULL THEN
    PERFORM 1 FROM public.quote_sections qs
    WHERE qs.id = NEW.quote_section_id AND qs.quote_id IS NOT DISTINCT FROM v_section_quote_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BOOKING_CLOSED: the booking section changed while this spray job was being scheduled. Try again.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._enforce_job_live_on_open_booking() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._enforce_job_live_on_open_booking() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER jobs_live_on_open_booking
  BEFORE INSERT OR UPDATE OF quote_id, quote_section_id, status, deleted_at ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_job_live_on_open_booking();

-- 1c. A section's booking decides a section-linked job's booking, so a section with a live job cannot move to
--     another booking (Sol HIGH, #1959): the move would leave a live job on a closed booking, or empty the old
--     one so it could close, without touching either trigger above. Nothing in the app moves sections today.
CREATE FUNCTION public._enforce_section_with_live_job_stays()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job_number text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.quote_id IS NOT DISTINCT FROM OLD.quote_id THEN
      RETURN NEW;
    END IF;
    SELECT j.job_number INTO v_job_number
    FROM public.jobs j
    WHERE j.quote_section_id = OLD.id AND j.deleted_at IS NULL AND j.status <> 'cancelled'
    ORDER BY j.job_number, j.id
    LIMIT 1;
  ELSE
    -- INSERT: the section FK is deferred, so save_quote can delete and re-insert a section with a job under
    -- the same id. A live job already pointing at the new id must stay on the booking it was scheduled from
    -- (Sol HIGH r3; Mason 2026-11-18, "close it"): the job's own booking, or, for a job linked by section
    -- only, any booking that is not closed.
    SELECT j.job_number INTO v_job_number
    FROM public.jobs j
    WHERE j.quote_section_id = NEW.id AND j.deleted_at IS NULL AND j.status <> 'cancelled'
      AND (j.quote_id IS DISTINCT FROM NEW.quote_id)
      AND (j.quote_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM public.quotes q
        WHERE q.id = NEW.quote_id
          AND q.status IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short')))
    ORDER BY j.job_number, j.id
    LIMIT 1;
  END IF;
  IF FOUND THEN
    RAISE EXCEPTION 'BOOKING_HAS_JOB: spray job % was made from this section, so the section cannot move to another booking.',
      v_job_number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._enforce_section_with_live_job_stays() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._enforce_section_with_live_job_stays() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER quote_sections_live_job_stays
  BEFORE INSERT OR UPDATE OF quote_id ON public.quote_sections
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_section_with_live_job_stays();

-- 2. The nightly expiry skips a booking with a live job and alerts its rep instead.
CREATE OR REPLACE FUNCTION public.auto_expire_quotes()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_quote record;
  v_expired_count integer := 0;
  v_holds_released integer := 0;
  v_hold_count integer;
  v_actor uuid;
BEGIN
  FOR v_quote IN
    SELECT q.* FROM public.quotes q
    WHERE q.expires_at < CURRENT_DATE
      AND q.status IN ('sent', 'revised')
      AND q.deleted_at IS NULL
      -- A5 (2026-06-10): a quote with partial draw-downs is an open season
      -- booking — being past its quote-expiry date is normal business, not an
      -- expired quote. Never auto-expire it (the undrawn balance would be
      -- destroyed: 'expired' is terminal and releases the booking's holds).
      AND NOT EXISTS (
        SELECT 1 FROM public.quote_product_draws d
        WHERE d.quote_id = q.id AND d.quantity_drawn > 0
      )
      -- #5 (2026-06-13, owner gate G-AE = Option 1): Planned Programs are
      -- deliberate season commitments that reserve inventory on purpose — never
      -- silently auto-expire them (that would release the booking's holds out
      -- from under the forecast). Staff close planned quotes by hand if needed.
      AND q.is_planned = false
      -- #1959 (Mason 2026-11-17): a booking with a live spray job cannot expire; the
      -- quotes_booking_live_job_rules trigger would refuse it and fail the whole batch.
      AND NOT EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE (j.quote_id = q.id
               OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = q.id))
          AND j.deleted_at IS NULL AND j.status <> 'cancelled'
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    -- #1959: a job committed after the loop's snapshot but before this row was locked is not in the
    -- filter above; re-check under the lock (fresh snapshot) and skip it rather than fail the night.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE (j.quote_id = v_quote.id
             OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = v_quote.id))
        AND j.deleted_at IS NULL AND j.status <> 'cancelled'
    );
    -- M1 (2026-06-10): release holds BEFORE the status flip so the AFTER
    -- UPDATE trigger finds 0 active holds and its FK-fragile log insert does
    -- not run. End state identical.
    UPDATE public.inventory_holds SET is_active = false, updated_at = now()
      WHERE source_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;
    v_holds_released := v_holds_released + v_hold_count;

    UPDATE public.quotes SET status = 'expired', updated_at = now() WHERE id = v_quote.id;
    v_expired_count := v_expired_count + 1;

    INSERT INTO public.notifications (
      user_id, title, message, notification_type, related_entity_type, related_entity_id
    )
    SELECT
      v_quote.created_by,
      'Quote expired',
      'Quote ' || v_quote.quote_number || ' expired',
      'quote_expired',
      'quote',
      v_quote.id
    FROM public.profiles p
    WHERE v_quote.created_by IS NOT NULL
      AND p.id = v_quote.created_by
      AND p.is_active = true;
  END LOOP;

  -- SEASON END (20261029100000, Mason 2026-10-26): a part-drawn booking stays open past its date
  -- (A5 above), so its rep gets one alert per expiry date to re-check it with the grower. A
  -- re-send sets a new date, which can alert again once it passes. #1959: so does a booking kept
  -- open by a live spray job.
  INSERT INTO public.notifications (
    user_id, title, message, notification_type, related_entity_type, related_entity_id
  )
  SELECT
    q.created_by,
    'Booking past its date',
    'Booking ' || q.quote_number || ' passed its expiry date (' || to_char(q.expires_at, 'Mon DD, YYYY')
      || CASE WHEN EXISTS (
                SELECT 1 FROM public.quote_product_draws d
                WHERE d.quote_id = q.id AND d.quantity_drawn > 0)
              THEN ') with product still to draw. Re-check it with the grower.'
              ELSE ') with a spray job made from it, so it stays open. Re-check it with the grower.'
         END,
    'booking_past_expiry',
    'quote',
    q.id
  FROM public.quotes q
  JOIN public.profiles p ON p.id = q.created_by AND p.is_active = true
  WHERE q.expires_at < CURRENT_DATE
    AND q.status IN ('sent', 'revised')
    AND q.deleted_at IS NULL
    AND q.is_planned = false
    AND (
      EXISTS (
        SELECT 1 FROM public.quote_product_draws d
        WHERE d.quote_id = q.id AND d.quantity_drawn > 0
      )
      OR EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE (j.quote_id = q.id
               OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = q.id))
          AND j.deleted_at IS NULL AND j.status <> 'cancelled'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.related_entity_id = q.id
        AND n.notification_type = 'booking_past_expiry'
        AND n.created_at >= q.expires_at
    );

  IF v_expired_count > 0 THEN
    v_actor := (
      SELECT id
      FROM public.profiles
      WHERE role = 'admin' AND is_active = true
      ORDER BY created_at
      LIMIT 1
    );

    -- Best-effort summary row using a real active admin actor when one exists;
    -- logging must never cancel the expiry work it summarizes.
    IF v_actor IS NOT NULL THEN
      BEGIN
        INSERT INTO public.activity_feed (event_type, description, performed_by)
        VALUES (
          'quotes_auto_expired',
          'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
          v_actor
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object('expired_count', v_expired_count, 'holds_released', v_holds_released);
END;
$function$;

DO $postflight$
DECLARE
  v_p pg_proc%ROWTYPE;
  v_g record;
BEGIN
  FOR v_g IN SELECT * FROM (VALUES
      ('public._enforce_booking_live_job_rules()', 'public.quotes', 'quotes_booking_live_job_rules'),
      ('public._enforce_job_live_on_open_booking()', 'public.jobs', 'jobs_live_on_open_booking'),
      ('public._enforce_section_with_live_job_stays()', 'public.quote_sections', 'quote_sections_live_job_stays')) AS g(fn, tbl, tg)
  LOOP
    SELECT * INTO v_p FROM pg_proc WHERE oid = v_g.fn::regprocedure;
    IF v_p.proowner <> 'postgres'::regrole OR NOT v_p.prosecdef
       OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR EXISTS (SELECT 1 FROM aclexplode(v_p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 'postgres'::regrole) THEN
      RAISE EXCEPTION 'POSTFLIGHT_LIVE_JOB_GUARD: % is not postgres-owned, definer, pinned search_path, no outside EXECUTE', v_g.fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_g.tbl::regclass
                    AND tgname = v_g.tg AND tgenabled = 'O' AND tgfoid = v_g.fn::regprocedure) THEN
      RAISE EXCEPTION 'POSTFLIGHT_LIVE_JOB_GUARD: trigger % is missing or disabled', v_g.tg;
    END IF;
  END LOOP;
  SELECT * INTO v_p FROM pg_proc WHERE oid = 'public.auto_expire_quotes()'::regprocedure;
  IF v_p.proowner <> 'postgres'::regrole OR NOT v_p.prosecdef
     OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(v_p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres', 'service_role']
     OR position('quotes_booking_live_job_rules' IN v_p.prosrc) = 0
     OR (SELECT count(*) FROM pg_proc WHERE proname = 'auto_expire_quotes'
           AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_AUTO_EXPIRE: auto_expire_quotes body, overloads, owner, mode, search_path or grants wrong';
  END IF;
END
$postflight$;
