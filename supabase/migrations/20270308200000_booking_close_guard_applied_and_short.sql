-- Booking close guard: closing as applied waits for live spray jobs, and only the booking's rep or an admin closes a
-- booking short. Release #1990 known issues (Sol r54 on ff46f6ca5, Mason 2026-11-20: fix before the next release).
--
-- Written 2026-11-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270308200000_booking_close_guard_applied_and_short.md. Re-read the live ledger first.
--
-- WHY:
--   Sol r54 HIGH 2 (`20270129150000:282`): _enforce_booking_live_job_rules() refuses closing short (and accepting,
--     declining, expiring, cancelling) while a spray job from the booking is scheduled or in progress, but not closing
--     as applied. close_quote_as_applied only counts those jobs ("informational, never blocks", 20260703200000:369), so
--     a booking could close as applied with a live job: its holds and the purchasing plan's remaining demand are
--     released while the job still needs the product.
--   #2065 (Mason 2026-11-21): a sent booking may be closed short only by the booking's own sales rep or an admin.
--     close_quote_as_short is SECURITY DEFINER and accepts any active sales rep, so a rep could close another rep's
--     booking short (the quotes row policy already stops a direct update of another rep's booking). Closing as
--     applied releases the same holds through close_quote_as_applied, also SECURITY DEFINER for any rep, so it gets
--     the same rule (Taha 2026-11-25; attack run).
--
-- WHAT (one function re-emitted from 20270129150000, body md5 pinned; nothing else in it changes):
--   1. Closing as applied (status -> closed_by_application) is refused BOOKING_HAS_JOB while a spray job made from the
--      booking or one of its sections is scheduled or in progress ("Cancel or complete the job first"), exactly as
--      closing short is. A completed or cancelled job does not block (the normal close-as-applied case).
--   2. Closing as applied joins the closes refused at REPEATABLE READ or SERIALIZABLE (BOOKING_NEEDS_READ_COMMITTED),
--      where the job check would read a stale snapshot. The app runs READ COMMITTED.
--   3. Closing short or as applied (status -> closed_short, closed_by_application) by a signed-in user who is neither
--      an active admin nor the booking's rep (OLD.created_by, the owner the quotes row policy and the #2026 job rule
--      use) as an active sales rep is refused BOOKING_NOT_YOURS. System sessions (no auth.uid()) stay exempt.
--   Both closes run through this trigger whether they come from the RPC or a direct update, and the RPC's whole call
--   rolls back on a refusal (nothing released, no activity row).
--   No auth.uid() is a system session (cron, the service role): anon cannot reach either close, because both RPCs
--   refuse AUTH_REQUIRED and neither is executable by anon or PUBLIC (the postflight checks the grants).
--   Concurrency (READ COMMITTED): a job scheduled, linked or reopened on a booking locks that booking FOR SHARE and
--   refuses a closed one, closed_by_application included (_enforce_job_live_on_open_booking, 20270129150000), so it
--   and a close serialize on the booking row: whichever commits first, the other waits, then sees it and is refused.
--   The prover runs both orders in two sessions.
--
-- NOT CHANGED: close_quote_as_applied, close_quote_as_short, the jobs trigger, the trigger definition
--   (BEFORE UPDATE OF status, customer_id, deleted_at), grants, row policies and every row.
--
-- ROLLBACK (its own reviewed migration; stores no data): re-create _enforce_booking_live_job_rules() from its
--   20270129150000 body (md5 9beb84454834da47d80e2c2a05a8a25d) after checking live still has this file's body. Text:
--   scripts/smoke/booking-close-guard-reverse.sql. That reopens both gaps.
--
-- ORDERING: after 20270129150000. Not re-runnable (the preflight refuses a second apply). Apply at READ COMMITTED
--   (the preflight refuses another level). The preflight also pins the jobs and sections triggers this rule relies on.

SET LOCAL lock_timeout = '5s';
-- Hold off booking and job writes for the apply (a few hundred ms), so a close in flight under the old body
-- finishes first and none lands between the preflight, the replacement and the postflight scan.
LOCK TABLE public.quotes, public.jobs IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  -- Sol r1 MED 2: at REPEATABLE READ the checks below would read the snapshot taken before the locks above.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PREFLIGHT_BOOKING_CLOSE_GUARD_ISOLATION: apply this migration at READ COMMITTED (the default), not %',
      current_setting('transaction_isolation');
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_booking_live_job_rules()'))
       IS DISTINCT FROM '9beb84454834da47d80e2c2a05a8a25d' THEN
    RAISE EXCEPTION 'PREFLIGHT_BOOKING_CLOSE_GUARD_DRIFT: _enforce_booking_live_job_rules() is not the reviewed 20270129150000 body (missing, drifted or already replaced); re-read live first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.quotes'::regclass AND t.tgname = 'quotes_booking_live_job_rules'
                   AND t.tgtype = 19 AND t.tgenabled = 'O' AND t.tgqual IS NULL
                   AND t.tgfoid = 'public._enforce_booking_live_job_rules()'::regprocedure
                   AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                         WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)) = ARRAY['customer_id', 'deleted_at', 'status']) THEN
    RAISE EXCEPTION 'PREFLIGHT_BOOKING_CLOSE_GUARD_TRIGGER: quotes_booking_live_job_rules is not BEFORE UPDATE OF status, customer_id, deleted_at on quotes, enabled, with no WHEN clause';
  END IF;
  -- Sol r1 HIGH: the other half of the rule is the jobs trigger, which locks the booking and refuses a closed one
  -- (closed_by_application included) when a job is scheduled, linked or reopened. Pinned as 20270129150000 left it.
  -- Sol r2 MED 3: its attributes too (a STABLE function could not take the FOR SHARE lock the rule relies on).
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_job_live_on_open_booking()'))
       IS DISTINCT FROM '08a8fed5fb807e1763cf40886078fc4c'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_job_live_on_open_booking()')
                      AND p.provolatile = 'v' AND p.prosecdef AND p.proowner = 'postgres'::regrole
                      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[])
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_live_on_open_booking'
                      AND t.tgtype = 23 AND t.tgenabled = 'O' AND t.tgqual IS NULL
                      AND t.tgfoid = 'public._enforce_job_live_on_open_booking()'::regprocedure
                      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                            WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr))
                          = ARRAY['customer_id', 'deleted_at', 'quote_id', 'quote_section_id', 'status']) THEN
    RAISE EXCEPTION 'PREFLIGHT_BOOKING_CLOSE_GUARD_JOBS_TRIGGER: jobs_live_on_open_booking is not the reviewed 20270129150000 trigger (BEFORE INSERT OR UPDATE OF quote_id, quote_section_id, customer_id, status, deleted_at, enabled, no WHEN clause); re-read live first';
  END IF;
  -- Sol r3 HIGH: the job check reaches section-linked jobs through quote_sections.quote_id, so a section with a live
  -- job must not move to another booking (a closed one included). quote_sections_live_job_stays refuses that move;
  -- pinned as 20270127120000 made it.
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_section_with_live_job_stays()'))
       IS DISTINCT FROM 'c5618a112f035d08972359aa289ac0db'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_section_with_live_job_stays()')
                      AND p.prosecdef AND p.proowner = 'postgres'::regrole)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.quote_sections'::regclass AND t.tgname = 'quote_sections_live_job_stays'
                      AND t.tgtype = 23 AND t.tgenabled = 'O' AND t.tgqual IS NULL
                      AND t.tgfoid = 'public._enforce_section_with_live_job_stays()'::regprocedure
                      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                            WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)) = ARRAY['id', 'quote_id']) THEN
    RAISE EXCEPTION 'PREFLIGHT_BOOKING_CLOSE_GUARD_SECTIONS_TRIGGER: quote_sections_live_job_stays is not the reviewed 20270127120000 trigger (BEFORE INSERT OR UPDATE OF id, quote_id, enabled, no WHEN clause); re-read live first';
  END IF;
END
$preflight$;

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
      OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_short', 'closed_by_application'))
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
  -- #2065 (Mason 2026-11-21): a booking is closed short only by its own rep (quotes.created_by, the owner the quotes
  -- row policy uses) or an admin; closing as applied releases the same holds, so it follows the same rule (Taha
  -- 2026-11-25). close_quote_as_short and close_quote_as_applied are SECURITY DEFINER and let any sales rep close any
  -- booking. The owner is read from OLD, so changing it in the same update does not count, and must still be an
  -- active sales rep (Sol r1 MED 3). System sessions (no auth.uid()) stay exempt.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('closed_short', 'closed_by_application')
     AND auth.uid() IS NOT NULL AND NOT public.is_admin()
     AND (NOT public.is_sales_rep() OR OLD.created_by IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'BOOKING_NOT_YOURS: booking % is another rep''s, so only that rep or an admin can close it %.',
      NEW.quote_number, CASE NEW.status WHEN 'closed_short' THEN 'short' ELSE 'as applied' END
      USING ERRCODE = 'P0001';
  END IF;
  -- Sol HIGH (#1959): closing short releases the booking's holds. The existing rule (20261105160000) refuses
  -- it only for scheduled/in-progress jobs linked by quote_id; a job linked through a section counts too.
  -- Release #1990 Sol r54 HIGH 2: closing as applied releases the holds and the plan's remaining demand too, and
  -- close_quote_as_applied only counted live jobs ("informational, never blocks", 20260703200000:369), so it is
  -- refused the same way. A completed or cancelled job does not block: that is the normal close-as-applied case.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('closed_short', 'closed_by_application') THEN
    SELECT j.job_number INTO v_job
    FROM public.jobs j
    WHERE (j.quote_id = NEW.id
           OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = NEW.id))
      AND j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')
    ORDER BY j.job_number, j.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'BOOKING_HAS_JOB: spray job % was made from this booking, so the booking cannot be %. Cancel or complete the job first.',
        v_job.job_number, CASE NEW.status WHEN 'closed_short' THEN 'closed short' ELSE 'closed as applied' END
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

DO $postflight$
DECLARE
  v_p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM pg_proc WHERE oid = 'public._enforce_booking_live_job_rules()'::regprocedure;
  IF v_p.proowner <> 'postgres'::regrole OR NOT v_p.prosecdef
     OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR EXISTS (SELECT 1 FROM aclexplode(v_p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 'postgres'::regrole)
     OR md5(replace(v_p.prosrc, chr(13), '')) <> '02d3233a58743b0f0b892d2cc1996c3b' THEN
    RAISE EXCEPTION 'POSTFLIGHT_BOOKING_CLOSE_GUARD: _enforce_booking_live_job_rules() is not the new body, postgres-owned, definer, pinned search_path, no outside EXECUTE';
  END IF;
  -- Luna r3: the owner rule exempts sessions with no auth.uid() (cron, the service role). That is safe only while
  -- neither close RPC can be run by anon or PUBLIC (both also refuse AUTH_REQUIRED without a signed-in user).
  -- Sol r2 MED 4: every overload, and EXECUTE however anon gets it (PUBLIC, a direct grant or a group role).
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('close_quote_as_applied', 'close_quote_as_short')
               AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTFLIGHT_BOOKING_CLOSE_GUARD_GRANTS: close_quote_as_applied or close_quote_as_short is executable by anon or PUBLIC';
  END IF;
  -- No booking closed as applied before this migration may still have a scheduled or in-progress spray job (quotes is
  -- locked above, so none closes in between); if one exists, re-read live and settle it with Mason first. The scan
  -- starts from the bookings closed as applied, the only rows it can match (Sol r1 MED 5: it runs under the write lock).
  IF EXISTS (SELECT 1 FROM public.quotes q
             WHERE q.status = 'closed_by_application'
               AND EXISTS (SELECT 1 FROM public.jobs j
                           WHERE (j.quote_id = q.id
                                  OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = q.id))
                             AND j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress'))) THEN
    RAISE EXCEPTION 'POSTFLIGHT_APPLIED_BOOKING_LIVE_JOB: a booking closed as applied still has a scheduled or in-progress spray job; re-read live first';
  END IF;
END
$postflight$;
