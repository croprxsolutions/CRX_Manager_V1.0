-- #2196: only an admin may delete a completed job, on every path (Mason, 2026-11-21).
-- Contract: docs/plans/2026-11-22-completed-job-delete-admin-only-CONTRACT.md
--
-- edit_jobs already skips a rep's delete of a completed job, but jobs_update RLS still lets a sales
-- rep set deleted_at directly, and this guard returned early for any
-- status but invoiced/cancelled. A soft-deleted completed job silently leaves Unbilled Jobs.
--
-- Change: one block before the early return refuses a non-admin write that deletes a job which is or
-- becomes completed in that write (even if it also moves it on to invoiced), or completes a deleted job. Everything else
-- is the 20260629120000 body unchanged; trigger unchanged.
-- Admins and the app.admin_override hatch pass as before. Restores (non-NULL -> NULL) are untouched.
-- Sales reps are the only non-admins with direct UPDATE (jobs_update, 20260430180000); applicators use
-- start_job / complete_job, which this guard now also covers.
--
-- Rollback: re-run the CREATE OR REPLACE FUNCTION from 20260629120000_guard_billed_job_immutability_invoice_id.sql.

-- Preflight: the guard is still the reviewed 20260629120000 body (live read 2026-11-22) on its one BEFORE UPDATE trigger.
DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._enforce_billed_job_immutability()'))
       IS DISTINCT FROM 'dca314dda06380191d55054120c3ba9c'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'enforce_billed_job_immutability'
                      AND t.tgtype = 19 AND t.tgenabled = 'O' AND t.tgqual IS NULL
                      AND t.tgfoid = 'public._enforce_billed_job_immutability()'::regprocedure) THEN
    RAISE EXCEPTION 'PREFLIGHT_BILLED_JOB_GUARD_DRIFT: _enforce_billed_job_immutability or its trigger is not the reviewed 20260629120000 shape; re-read live first';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._enforce_billed_job_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- #2196: a completed job is billable work; only an admin may delete it, whatever the path. Covers
  -- deleting a job that is or becomes completed in that write (whatever status it moves to), and
  -- completing a deleted job.
  -- coalesce: _is_admin_override() is NULL when the setting was never set. The hatch is the same one
  -- this guard already honours below: signed-in users reach the database only through the API, which
  -- cannot set it; only SECURITY DEFINER flows SET LOCAL it, inside their own transaction.
  IF NEW.deleted_at IS NOT NULL
     AND ((OLD.deleted_at IS NULL AND 'completed' IN (OLD.status, NEW.status))
          OR (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'))
     AND NOT coalesce(is_admin() OR _is_admin_override(), false) THEN
    RAISE EXCEPTION 'A completed job is billable work and only an admin can delete it (job %).',
      OLD.job_number
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only billed/terminal jobs are immutable. A live job edits exactly as before.
  IF OLD.status NOT IN ('invoiced', 'cancelled') THEN
    RETURN NEW;
  END IF;

  -- Admins may correct billed history; the definer-flow override hatch (set by
  -- SECURITY DEFINER RPCs via SET LOCAL app.admin_override='true') is honored so
  -- sanctioned server-side flows (e.g. transfer_invoice_to_job) still work.
  IF is_admin() OR _is_admin_override() THEN
    RETURN NEW;
  END IF;

  -- (a) Most severe hole: block a non-admin soft-delete of a billed job.
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A % job is billed history and cannot be deleted by a non-admin (job %).',
      OLD.status, OLD.job_number
      USING ERRCODE = 'check_violation';
  END IF;

  -- (b) Block a non-admin rewrite of any billed-relevant column. Allow the row
  -- through only when every NON-exempt column is unchanged. New columns are
  -- protected by default (they are not in the exempt set below).
  IF NOT (
       NEW.id                     IS NOT DISTINCT FROM OLD.id
   AND NEW.job_number             IS NOT DISTINCT FROM OLD.job_number
   AND NEW.customer_id            IS NOT DISTINCT FROM OLD.customer_id
   AND NEW.job_date               IS NOT DISTINCT FROM OLD.job_date
   AND NEW.scheduled_time         IS NOT DISTINCT FROM OLD.scheduled_time
   AND NEW.applicator_id          IS NOT DISTINCT FROM OLD.applicator_id
   AND NEW.vehicle_id             IS NOT DISTINCT FROM OLD.vehicle_id
   AND NEW.recipe_id              IS NOT DISTINCT FROM OLD.recipe_id
   AND NEW.notes                  IS NOT DISTINCT FROM OLD.notes
   AND NEW.tags                   IS NOT DISTINCT FROM OLD.tags
   AND NEW.batch_id               IS NOT DISTINCT FROM OLD.batch_id
   AND NEW.season                 IS NOT DISTINCT FROM OLD.season
   AND NEW.total_acres            IS NOT DISTINCT FROM OLD.total_acres
   AND NEW.total_cost_cents       IS NOT DISTINCT FROM OLD.total_cost_cents
   AND NEW.total_price_cents      IS NOT DISTINCT FROM OLD.total_price_cents
   AND NEW.created_by             IS NOT DISTINCT FROM OLD.created_by
   AND NEW.deleted_at             IS NOT DISTINCT FROM OLD.deleted_at
   AND NEW.created_at             IS NOT DISTINCT FROM OLD.created_at
   AND NEW.priority               IS NOT DISTINCT FROM OLD.priority
   AND NEW.estimated_hours        IS NOT DISTINCT FROM OLD.estimated_hours
   AND NEW.quote_id               IS NOT DISTINCT FROM OLD.quote_id
   AND NEW.quote_section_id       IS NOT DISTINCT FROM OLD.quote_section_id
   AND NEW.application_service_id IS NOT DISTINCT FROM OLD.application_service_id
   AND NEW.call_date              IS NOT DISTINCT FROM OLD.call_date
   AND NEW.date_proposed          IS NOT DISTINCT FROM OLD.date_proposed
   AND NEW.time_proposed          IS NOT DISTINCT FROM OLD.time_proposed
   AND NEW.schedule_date          IS NOT DISTINCT FROM OLD.schedule_date
   AND NEW.date_expires           IS NOT DISTINCT FROM OLD.date_expires
   AND NEW.consultant_id          IS NOT DISTINCT FROM OLD.consultant_id
   AND NEW.loader_comment         IS NOT DISTINCT FROM OLD.loader_comment
   AND NEW.additional_info        IS NOT DISTINCT FROM OLD.additional_info
   AND NEW.internal_memo          IS NOT DISTINCT FROM OLD.internal_memo
   AND NEW.ground_crew_id         IS NOT DISTINCT FROM OLD.ground_crew_id
   AND NEW.batch_ref              IS NOT DISTINCT FROM OLD.batch_ref
   AND NEW.carrier_rate_gpa       IS NOT DISTINCT FROM OLD.carrier_rate_gpa
   AND NEW.loader_tank_capacity   IS NOT DISTINCT FROM OLD.loader_tank_capacity
   -- P1 remediation: invoice_id is NOW protected (was exempt). A non-admin can
   -- no longer detach (->NULL) or repoint a billed job's invoice via direct PATCH.
   -- The two legitimate writers still pass: transfer_job_to_invoice writes it on a
   -- 'completed' job (guard early-returns), transfer_invoice_to_job clears it under
   -- the admin_override hatch (early-returns above the column check).
   AND NEW.invoice_id             IS NOT DISTINCT FROM OLD.invoice_id
   -- EXEMPT (intentionally NOT checked — see header): status, deleted_at*,
   -- applied_acres, remaining_acres (GENERATED), printed_at, last_printed_by,
   -- updated_at, updated_by.
   -- (*deleted_at's NULL->non-NULL case is already blocked above; an unchanged
   --  value passes the IS NOT DISTINCT FROM check we DO run on it.)
  ) THEN
    RAISE EXCEPTION 'A % job is billed history; a non-admin cannot edit its billed-relevant fields (job %).',
      OLD.status, OLD.job_number
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public._enforce_billed_job_immutability() IS
  'DB guard for job delete and billed-history immutability. For a non-admin (and without the '
  'app.admin_override hatch): a completed job cannot be soft-deleted (#2196); an invoiced/cancelled '
  'job cannot be soft-deleted nor have its billed-relevant columns rewritten, invoice_id included. '
  'Exempt: status (status-enforcer), applied_acres (recompute), printed_at/last_printed_by (print '
  'audit), updated_at/updated_by. Admins and sanctioned SECURITY DEFINER flows (override hatch) are unaffected.';
