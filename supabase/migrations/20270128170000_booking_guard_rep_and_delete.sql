-- PR-D1, release v0.1.0 (#1990): two booking guard gaps Sol found in 20270127120000_booking_live_job_guard.
--
-- WHY (Mason cannot owner-accept these, so they are fixed before go-live):
--   Sol 3 (:178): the jobs trigger returns early on a status-only change of an already-linked live job, and
--     jobs_update lets any sales rep update any job. A rep could mark another rep's booked job completed; a
--     completed job keeps the booking from being declined or cancelled, and only an admin can clear it.
--   Sol 4 (:141): the quotes trigger fires on UPDATE OF status, customer_id only, so a soft delete (deleted_at)
--     skipped it and a booking could be deleted with a spray job still scheduled or in progress from it.
--
-- WHAT:
--   1. _enforce_job_live_on_open_booking(): once a job is linked to a booking (quote_id or quote_section_id), a
--      signed-in sales rep who is not that booking's rep (quotes.created_by) cannot move it from a live status
--      (scheduled, in_progress, or cancelled through an override) to completed or invoiced (BOOKING_NOT_YOURS;
--      Mason 2026-11-19). completed -> invoiced is billing and is not checked: the job already holds the booking,
--      and the invoicing functions bill any rep's job. Admins and system sessions are exempt.
--      Applicators are not checked: they reach this only through complete_job, which already allows only the
--      job's assigned applicator or its sole dispatchee, and jobs_update refuses them a direct write.
--   2. _enforce_booking_live_job_rules(): a soft delete of a booking (deleted_at set) is refused BOOKING_HAS_JOB
--      while a scheduled or in-progress job comes from the booking or one of its sections. A completed or
--      cancelled job does not block; closing as applied stays allowed by design (20260703200000:369).
--      Its trigger quotes_booking_live_job_rules now fires on UPDATE OF status, customer_id, deleted_at.
--      A soft delete at REPEATABLE READ or SERIALIZABLE is refused (BOOKING_DELETE_NEEDS_READ_COMMITTED; Sol r1): there the
--      check would read the transaction's first snapshot and could miss a job scheduled meanwhile. The app runs READ COMMITTED.
--   Rule 1 checks the rep against every booking a job names (its quote_id and its section's booking; Sol r1), with
--      those bookings locked FOR SHARE (Sol r2). A job reopened from completed or invoiced (an admin override) on a
--      deleted booking, or one closed short, declined, expired or cancelled, is refused BOOKING_CLOSED (Sol HIGH r2, r3).
--   Postflight refuses the apply if a booking deleted earlier still has a scheduled or in-progress job (Sol HIGH r3).
--   Pre- and postflight pin both triggers' timing, events, columns, function and absence of a WHEN clause (Sol r1).
--   Every other line of both functions is its 20270127120000 body (pinned below by md5).
--
-- NOT CHANGED: _enforce_section_with_live_job_stays, auto_expire_quotes, complete_job, start_job, save_quote,
--   grants and row policies. No row changes: a booking already deleted with a live job, or a job already completed
--   by another rep, stays as it is (the triggers fire only on a change).
--
-- ROLLBACK (its own reviewed migration; stores no data): re-create both functions from their 20270127120000
--   bodies after checking the live bodies still match this file's, and re-create quotes_booking_live_job_rules
--   as BEFORE UPDATE OF status, customer_id. That reopens both gaps.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_booking_live_job_rules()'))
       IS DISTINCT FROM 'f1469138008d7c047f63998208520435'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_job_live_on_open_booking()'))
       IS DISTINCT FROM '88d20c67d9b32cf11ac192bf0b451748' THEN
    RAISE EXCEPTION 'PREFLIGHT_LIVE_JOB_GUARD_DRIFT: the booking live-job guard functions are not the reviewed 20270127120000 bodies; re-read live first';
  END IF;
  -- Both triggers exactly as 20270127120000 made them (Sol r1): event, timing, columns, function, no WHEN clause.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.quotes'::regclass AND t.tgname = 'quotes_booking_live_job_rules'
                   AND t.tgtype = 19 AND t.tgenabled = 'O' AND t.tgqual IS NULL
                   AND t.tgfoid = 'public._enforce_booking_live_job_rules()'::regprocedure
                   AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                         WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)) = ARRAY['customer_id', 'status'])
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_live_on_open_booking'
                   AND t.tgtype = 23 AND t.tgenabled = 'O' AND t.tgqual IS NULL
                   AND t.tgfoid = 'public._enforce_job_live_on_open_booking()'::regprocedure
                   AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                         WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr))
                       = ARRAY['customer_id', 'deleted_at', 'quote_id', 'quote_section_id', 'status']) THEN
    RAISE EXCEPTION 'PREFLIGHT_LIVE_JOB_GUARD_DRIFT: quotes_booking_live_job_rules or jobs_live_on_open_booking is not as 20270127120000 made it';
  END IF;
END
$preflight$;

-- 1. A booked job moves to completed or invoiced only by its booking's rep or an admin (Sol 3).
CREATE OR REPLACE FUNCTION public._enforce_job_live_on_open_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_section_quote_id uuid;
  v_quote record;
  v_hide boolean;
BEGIN
  -- Mason 2026-11-18 ("A"): a job's booking links are fixed once set, whatever its status, so a job cannot be
  -- cancelled, re-pointed and revived on another booking. Nothing in the app changes them; both FKs are NO ACTION.
  IF TG_OP = 'UPDATE' AND (OLD.quote_id IS NOT NULL OR OLD.quote_section_id IS NOT NULL)
     AND (NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.quote_section_id IS DISTINCT FROM OLD.quote_section_id) THEN
    RAISE EXCEPTION 'BOOKING_HAS_JOB: spray job % stays linked to the booking it was scheduled from. To move it, cancel it and schedule a new one.',
      NEW.job_number
      USING ERRCODE = 'P0001';
  END IF;
  -- PR-D1 (#1990 Sol 3; Mason 2026-11-19): a completed job holds its booking open until an admin clears it, and
  -- any sales rep may update any job (jobs_update), so a rep could block another rep's booking. Once a job is
  -- linked to a booking, only that booking's rep (quotes.created_by, the owner the quotes row policy uses) or an
  -- admin moves it out of a live status into completed (or invoiced, reachable from there only by an override).
  -- completed -> invoiced is billing: the job already holds the booking, so that move is not checked (Luna r1).
  -- Applicators get here only through complete_job, which already limits them to their own job, so only sales
  -- reps are checked; system sessions (no auth.uid()) stay exempt. Checked before the deleted/cancelled return, so
  -- completing and soft-deleting in one statement is refused too (attack F1).
  IF TG_OP = 'UPDATE' AND NEW.status IN ('completed', 'invoiced') AND OLD.status NOT IN ('completed', 'invoiced')
     AND (NEW.quote_id IS NOT NULL OR NEW.quote_section_id IS NOT NULL)
     AND auth.uid() IS NOT NULL AND NOT public.is_admin() AND public.is_sales_rep() THEN
    -- Both links are checked (Sol HIGH r1): a legacy row whose quote_id and section disagree is refused unless the
    -- caller is the rep of every booking it names. The bookings are locked first (Sol MED r2), so an owner change
    -- committed meanwhile is waited for, or at REPEATABLE READ fails to serialize, rather than read stale.
    PERFORM 1 FROM public.quotes q
    WHERE q.id IN (NEW.quote_id, (SELECT qs.quote_id FROM public.quote_sections qs WHERE qs.id = NEW.quote_section_id))
    ORDER BY q.id
    FOR SHARE;
    SELECT q.quote_number INTO v_quote
    FROM public.quotes q
    WHERE q.id IN (NEW.quote_id, (SELECT qs.quote_id FROM public.quote_sections qs WHERE qs.id = NEW.quote_section_id))
      AND q.created_by IS DISTINCT FROM auth.uid()
    ORDER BY q.quote_number
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'BOOKING_NOT_YOURS: spray job % comes from booking %, which is another rep''s, so only that rep or an admin can mark it %.',
        NEW.job_number, v_quote.quote_number, NEW.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- Sol HIGH r2, r3: a booking can now be deleted once its job is completed, and closed short, declined, expired or
  -- cancelled (each releases its holds); an override that reopens that job (completed or invoiced back to scheduled
  -- or in progress) must not leave live work on such a booking. The bookings are locked first (in id order), so a
  -- delete or close running at the same time is waited for, and then refused because the job is live.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('completed', 'invoiced') AND NEW.status IN ('scheduled', 'in_progress')
     AND (NEW.quote_id IS NOT NULL OR NEW.quote_section_id IS NOT NULL) THEN
    PERFORM 1 FROM public.quotes q
    WHERE q.id IN (NEW.quote_id, (SELECT qs.quote_id FROM public.quote_sections qs WHERE qs.id = NEW.quote_section_id))
    ORDER BY q.id
    FOR SHARE;
    SELECT q.quote_number, CASE WHEN q.deleted_at IS NOT NULL THEN 'deleted' ELSE q.status END AS state INTO v_quote
    FROM public.quotes q
    WHERE q.id IN (NEW.quote_id, (SELECT qs.quote_id FROM public.quote_sections qs WHERE qs.id = NEW.quote_section_id))
      AND (q.deleted_at IS NOT NULL OR q.status IN ('closed_short', 'declined', 'expired', 'cancelled'))
    ORDER BY q.quote_number
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'BOOKING_CLOSED: booking % is %, so spray job % cannot be reopened.',
        v_quote.quote_number, v_quote.state, NEW.job_number
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- Sol HIGH r5: this trigger runs before the jobs row policy, so for a signed-in caller who is neither admin
  -- nor sales rep (who cannot read bookings) every refusal below is replaced by the row policy's own refusal,
  -- revealing no booking number or status. The checks still run for them (fail closed).
  v_hide := auth.uid() IS NOT NULL AND NOT (public.is_admin() OR public.is_sales_rep());
  BEGIN
  -- A live job that stays live with the same links and customer needs no re-check; one first gaining a link does (Luna HIGH).
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND OLD.status <> 'cancelled'
     AND NEW.quote_id IS NOT DISTINCT FROM OLD.quote_id AND NEW.quote_section_id IS NOT DISTINCT FROM OLD.quote_section_id
     AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN
    RETURN NEW;
  END IF;
  -- Sol HIGH r6: a job first becoming live on a booking (inserted, linked, un-cancelled or un-deleted) starts as
  -- scheduled, as the scheduler makes it, so any sales rep can cancel it; a rep cannot plant a job in a later
  -- status that holds another rep's booking open. Admins (who restore jobs) and system sessions are exempt.
  IF (NEW.quote_id IS NOT NULL OR NEW.quote_section_id IS NOT NULL) AND NEW.status <> 'scheduled'
     AND (TG_OP = 'INSERT' OR OLD.deleted_at IS NOT NULL OR OLD.status = 'cancelled'
          OR (OLD.quote_id IS NULL AND OLD.quote_section_id IS NULL))
     AND auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'JOB_NEEDS_BOOKING: spray job % must start as scheduled to be linked to a booking. Schedule it from the booking.',
      NEW.job_number
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.quote_id IS NOT NULL THEN
    SELECT q.quote_number, q.status, q.customer_id, q.deleted_at INTO v_quote FROM public.quotes q WHERE q.id = NEW.quote_id FOR SHARE;
    -- Sol MED r6: a booking not visible yet (a concurrent insert) or soft-deleted cannot take a live job.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'JOB_NEEDS_BOOKING: spray job % names a booking that does not exist.', NEW.job_number
        USING ERRCODE = 'P0001';
    END IF;
    IF v_quote.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'BOOKING_CLOSED: booking % is deleted, so a spray job cannot be scheduled from it.',
        v_quote.quote_number
        USING ERRCODE = 'P0001';
    END IF;
    IF v_quote.status IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short') THEN
      RAISE EXCEPTION 'BOOKING_CLOSED: booking % is %, so a spray job cannot be scheduled from it.',
        v_quote.quote_number, v_quote.status
        USING ERRCODE = 'P0001';
    END IF;
    -- Sol HIGH r5: a live job is for its booking's customer, as the scheduler always sets it, so another
    -- customer's job cannot hold someone else's booking open.
    IF NEW.customer_id IS DISTINCT FROM v_quote.customer_id THEN
      RAISE EXCEPTION 'JOB_NEEDS_BOOKING: spray job % is for a different customer than booking %.',
        NEW.job_number, v_quote.quote_number
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- Mason 2026-11-18 ("Require both"): a job made from a section also names that section's booking, as the
  -- scheduler always does. The section row is checked under a lock taken after the booking's (the order
  -- save_quote locks in), so a section moving at the same moment is waited for, then refused (Luna HIGH).
  IF NEW.quote_section_id IS NOT NULL THEN
    SELECT qs.quote_id INTO v_section_quote_id FROM public.quote_sections qs WHERE qs.id = NEW.quote_section_id;
    PERFORM 1 FROM public.quote_sections qs
    WHERE qs.id = NEW.quote_section_id AND qs.quote_id = NEW.quote_id
    FOR SHARE;
    IF NOT FOUND THEN
      IF NEW.quote_id IS NOT NULL AND v_section_quote_id IS NOT DISTINCT FROM NEW.quote_id THEN
        RAISE EXCEPTION 'BOOKING_CLOSED: the booking section changed while this spray job was being scheduled. Try again.'
          USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'JOB_NEEDS_BOOKING: spray job % comes from a booking section, so it must also name that section''s booking.',
        NEW.job_number
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  EXCEPTION WHEN raise_exception THEN
    IF v_hide THEN
      RAISE EXCEPTION 'new row violates row-level security policy for table "jobs"' USING ERRCODE = '42501';
    END IF;
    RAISE;
  END;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._enforce_job_live_on_open_booking() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._enforce_job_live_on_open_booking() FROM PUBLIC, anon, authenticated, service_role;

-- 2. A booking with a scheduled or in-progress job cannot be soft-deleted (Sol 4).
CREATE OR REPLACE FUNCTION public._enforce_booking_live_job_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job record;
BEGIN
  -- PR-D1 (#1990 Sol 4): a soft delete skipped this trigger (it fired on status and customer_id only), so a
  -- booking could be deleted with a spray job still scheduled or in progress from it. Refused while one comes
  -- from the booking or one of its sections; a completed or cancelled job does not block.
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    -- Sol HIGH r1: at REPEATABLE READ or SERIALIZABLE the check below reads the transaction's first snapshot, so a
    -- job committed meanwhile by a scheduler that only locked this booking would be missed. The app always runs
    -- READ COMMITTED, where the check sees it once the booking row lock is granted.
    IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
      RAISE EXCEPTION 'BOOKING_DELETE_NEEDS_READ_COMMITTED: delete booking % in a READ COMMITTED transaction, so a spray job scheduled meanwhile is seen.',
        NEW.quote_number
        USING ERRCODE = 'P0001';
    END IF;
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

DROP TRIGGER quotes_booking_live_job_rules ON public.quotes;
CREATE TRIGGER quotes_booking_live_job_rules
  BEFORE UPDATE OF status, customer_id, deleted_at ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_booking_live_job_rules();

DO $postflight$
DECLARE
  v_p pg_proc%ROWTYPE;
  v_g record;
BEGIN
  FOR v_g IN SELECT * FROM (VALUES
      ('public._enforce_booking_live_job_rules()', 'public.quotes', 'quotes_booking_live_job_rules', 'cannot be deleted. Cancel or complete the job first.', '9845ed22d07de03c8b3c7afe5356352c'),
      ('public._enforce_job_live_on_open_booking()', 'public.jobs', 'jobs_live_on_open_booking', 'BOOKING_NOT_YOURS', '0b9c1774f2602bc299fb54ebc2c6e756')) AS g(fn, tbl, tg, marker, body_md5)
  LOOP
    SELECT * INTO v_p FROM pg_proc WHERE oid = v_g.fn::regprocedure;
    IF v_p.proowner <> 'postgres'::regrole OR NOT v_p.prosecdef
       OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR EXISTS (SELECT 1 FROM aclexplode(v_p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 'postgres'::regrole)
       OR position(v_g.marker IN v_p.prosrc) = 0
       OR md5(replace(v_p.prosrc, chr(13), '')) <> v_g.body_md5 THEN
      RAISE EXCEPTION 'POSTFLIGHT_LIVE_JOB_GUARD: % is not the new body, postgres-owned, definer, pinned search_path, no outside EXECUTE', v_g.fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_g.tbl::regclass
                    AND tgname = v_g.tg AND tgenabled = 'O' AND tgfoid = v_g.fn::regprocedure) THEN
      RAISE EXCEPTION 'POSTFLIGHT_LIVE_JOB_GUARD: trigger % is missing or disabled', v_g.tg;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.quotes'::regclass AND t.tgname = 'quotes_booking_live_job_rules'
                   AND t.tgtype = 19 AND t.tgqual IS NULL
                   AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                         WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)) = ARRAY['customer_id', 'deleted_at', 'status'])
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_live_on_open_booking'
                   AND t.tgtype = 23 AND t.tgqual IS NULL
                   AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                         WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr))
                       = ARRAY['customer_id', 'deleted_at', 'quote_id', 'quote_section_id', 'status']) THEN
    RAISE EXCEPTION 'POSTFLIGHT_LIVE_JOB_GUARD: a guard trigger does not fire on its events and columns (quotes: BEFORE UPDATE OF status, customer_id, deleted_at; jobs: BEFORE INSERT OR UPDATE OF quote_id, quote_section_id, customer_id, status, deleted_at), or has a WHEN clause';
  END IF;
  -- Sol HIGH r3: no booking deleted before this migration may still have a scheduled or in-progress job (quotes is
  -- locked by the trigger re-create above, so no booking is deleted in between); if one exists, re-read live first.
  IF EXISTS (SELECT 1 FROM public.jobs j JOIN public.quotes q
               ON q.id = j.quote_id OR q.id = (SELECT qs.quote_id FROM public.quote_sections qs WHERE qs.id = j.quote_section_id)
             WHERE q.deleted_at IS NOT NULL AND j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')) THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELETED_BOOKING_LIVE_JOB: a deleted booking still has a scheduled or in-progress spray job; re-read live first';
  END IF;
END
$postflight$;
