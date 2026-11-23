-- F06 / KI-187 (#2178): one spray takes its chemicals out of stock once.
-- Contract: docs/plans/2026-11-23-f06-job-blend-stock-once-CONTRACT.md. Mason, 2026-11-23: when a spray job has a blend
-- ticket linked to it, the JOB takes the stock (its completion records the spray, as today).
--   * A ticket linked to a job that can still complete, or that already recorded, cannot make its own application
--     record (BLEND_TICKET_JOB_RECORDS). A cancelled or deleted job that never recorded cannot complete, so its linked
--     ticket records as before.
--   * The job takes exactly what is on its own chemical list, even when that list is empty or short (Mason,
--     2026-11-23, after Luna round 4: "Job's list always counts"; supersedes the no-chemicals refusal).
--   * A job whose linked ticket already has its own record cannot record again (JOB_BLEND_TICKET_ALREADY_RECORDED);
--     only old rows can reach this, as the link rules below stop new ones.
--   * A ticket with its own record cannot be linked to a job (BLEND_TICKET_RECORDED_NO_JOB).
--   * A ticket cannot leave a job that already recorded the spray (BLEND_TICKET_COMPLETED_JOB_KEEPS_TICKET), so it
--     cannot be unlinked and then recorded a second time.
--   * A ticket can only be linked to a job of its own customer (BLEND_TICKET_JOB_OTHER_CUSTOMER), as save_blend_ticket
--     already requires; this also covers new tickets, direct office table updates and a later customer change.
-- Both posting functions (job completion, Create App Record) are unchanged: application_records has no write policy
-- (only these definer functions insert it), and the link is guarded on the table because office users may update
-- blend_tickets directly. Old rows are not touched: production has no blend tickets (read-only, 2026-11-23); staging
-- keeps its synthetic doubled pair. Accepted gap (as KI-93; Mason, 2026-11-23): a ticket never linked to its job, or
-- unlinked before the job completed, is invisible here.
-- Locks: ticket path locks the ticket, then its job; job path locks only the job; a link change holds the ticket row,
-- then locks old and new job in one statement in id order (NO KEY UPDATE, so a foreign-key check never waits on it).
-- Nothing locks a ticket after a job, so no lock cycle. Each check is its own statement after its lock, so under
-- READ COMMITTED it sees the other side's committed rows.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._f06_application_record_one_deduction()') IS NOT NULL
     OR to_regprocedure('public._f06_blend_ticket_link_keeps_stock_once()') IS NOT NULL THEN
    RAISE EXCEPTION 'F06_PREFLIGHT: already applied';
  END IF;
END
$preflight$;

CREATE FUNCTION public._f06_application_record_one_deduction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_job uuid;
BEGIN
  IF NEW.source_type = 'blend_ticket' THEN
    -- Create App Record already holds this lock; it also serializes with a link change on the same ticket.
    SELECT bt.job_id INTO v_job FROM public.blend_tickets bt WHERE bt.id = NEW.source_id FOR UPDATE;
    IF v_job IS NOT NULL THEN
      -- Ticket, then job: the same order as a link change. Cancelling a job waits here, so the status read next is current.
      PERFORM 1 FROM public.jobs j WHERE j.id = v_job FOR NO KEY UPDATE;
      -- A job counts while it can still complete, or once it has recorded (even if cancelled or deleted later).
      IF EXISTS (SELECT 1 FROM public.jobs j
                  WHERE j.id = v_job AND j.deleted_at IS NULL AND j.status <> 'cancelled')
         OR EXISTS (SELECT 1 FROM public.application_records ar
                     WHERE ar.source_type = 'job' AND ar.source_id = v_job) THEN
        RAISE EXCEPTION 'BLEND_TICKET_JOB_RECORDS: this blend ticket is linked to a spray job. Completing the job records the spray and takes the stock, so the ticket does not make its own application record. If that job has not been completed and will not be, cancel it or unlink the ticket from it first.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSIF NEW.source_type = 'job' THEN
    PERFORM 1 FROM public.jobs j WHERE j.id = NEW.source_id FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1
                 FROM public.blend_tickets bt
                 JOIN public.application_records ar ON ar.source_type = 'blend_ticket' AND ar.source_id = bt.id
                WHERE bt.job_id = NEW.source_id) THEN
      RAISE EXCEPTION 'JOB_BLEND_TICKET_ALREADY_RECORDED: a blend ticket linked to this job already recorded the spray and took the stock. Ask an admin to reverse that ticket''s application record, then complete the job.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
ALTER FUNCTION public._f06_application_record_one_deduction() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._f06_application_record_one_deduction() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER application_record_one_deduction_f06
  BEFORE INSERT ON public.application_records
  FOR EACH ROW EXECUTE FUNCTION public._f06_application_record_one_deduction();

CREATE FUNCTION public._f06_blend_ticket_link_keeps_stock_once()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Every ticket save names job_id and customer_id; only a real change is checked.
  IF TG_OP = 'UPDATE' AND NEW.job_id IS NOT DISTINCT FROM OLD.job_id AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN
    RETURN NEW;
  END IF;
  -- Old and new job locked in one statement in id order, so two tickets swapping jobs cannot deadlock; the checks
  -- below read the jobs after the lock.
  PERFORM 1 FROM public.jobs j
   WHERE j.id IN (CASE WHEN TG_OP = 'UPDATE' THEN OLD.job_id END, NEW.job_id)
   ORDER BY j.id FOR NO KEY UPDATE;
  IF NEW.job_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.jobs j
                      WHERE j.id = NEW.job_id AND j.customer_id IS NOT DISTINCT FROM NEW.customer_id) THEN
    RAISE EXCEPTION 'BLEND_TICKET_JOB_OTHER_CUSTOMER: a blend ticket can only be linked to a spray job for the same customer.'
      USING ERRCODE = 'P0001';
  END IF;
  -- A new ticket has no record yet and no old job.
  IF TG_OP = 'INSERT' OR NEW.job_id IS NOT DISTINCT FROM OLD.job_id THEN
    RETURN NEW;
  END IF;
  IF NEW.job_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.application_records ar
                  WHERE ar.source_type = 'blend_ticket' AND ar.source_id = NEW.id) THEN
    RAISE EXCEPTION 'BLEND_TICKET_RECORDED_NO_JOB: this blend ticket already has its own application record and took the stock, so it can''t be linked to a spray job. Ask an admin to reverse the ticket''s record first.'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.job_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.application_records ar
                  WHERE ar.source_type = 'job' AND ar.source_id = OLD.job_id) THEN
    RAISE EXCEPTION 'BLEND_TICKET_COMPLETED_JOB_KEEPS_TICKET: this blend ticket''s spray job is already completed and took the stock, so the ticket can''t be unlinked or moved to another job.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$fn$;
ALTER FUNCTION public._f06_blend_ticket_link_keeps_stock_once() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._f06_blend_ticket_link_keeps_stock_once() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER blend_ticket_link_keeps_stock_once_f06
  BEFORE INSERT OR UPDATE OF job_id, customer_id ON public.blend_tickets
  FOR EACH ROW EXECUTE FUNCTION public._f06_blend_ticket_link_keeps_stock_once();

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid IN (to_regprocedure('public._f06_application_record_one_deduction()'),
                       to_regprocedure('public._f06_blend_ticket_link_keeps_stock_once()'))
         AND p.prosecdef
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 2 THEN
    RAISE EXCEPTION 'F06_POSTFLIGHT: guard functions security, owner, search_path or grants are not as reviewed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND ((t.tgrelid = 'public.application_records'::regclass AND t.tgname = 'application_record_one_deduction_f06'
               AND t.tgfoid = to_regprocedure('public._f06_application_record_one_deduction()'))
           OR (t.tgrelid = 'public.blend_tickets'::regclass AND t.tgname = 'blend_ticket_link_keeps_stock_once_f06'
               AND t.tgfoid = to_regprocedure('public._f06_blend_ticket_link_keeps_stock_once()')))) <> 2 THEN
    RAISE EXCEPTION 'F06_POSTFLIGHT: guard triggers missing or disabled';
  END IF;
END
$postflight$;
