-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261212100000_dispatch_sync_on_applicator_qualify.md. Re-read the live ledger before applying.
--
-- WHY (KI-28): the two dispatch-sync triggers from 20260707020000_assignment_unification
--   (_sync_job_location_dispatch_on_field_insert, _sync_job_location_dispatch_on_applicator_change) skip a job
--   whose assigned person is not an active applicator at that moment, and nothing re-fires them later. A job
--   assigned to someone who is inactive or not yet role 'applicator' therefore never reaches the Dispatch Board,
--   even after the person is re-activated or given the applicator role. Detection sweep:
--   scripts/db-invariant-sweeps/predicates/dispatch-sync-nonqualifying-profile.sql (0 rows live 2026-11-08).
--
-- WHAT: a trigger, AFTER UPDATE OF is_active, role ON profiles, firing only when a person BECOMES an active
--   applicator. For each of that person's live jobs (applicator_id = them, status scheduled or in_progress, not
--   soft-deleted) it adds a 'dispatched' job_location_dispatches row for every location that has NO dispatch row
--   at all: the rows the field-insert trigger writes for a qualifying applicator. dispatched_by follows the
--   existing triggers: auth.uid() (the person making the change), else the job's updated_by, else created_by.
--   The license is NOT re-checked, exactly like the field-insert trigger (Mason, 2026-11-08, DECISION_LOG): it
--   is checked when the job is assigned (_enforce_applicator_license), and the Expiring Licenses card warns.
--   The same insert also runs once at apply time (BACKFILL below), for any job already in that state.
--
-- CONCURRENCY (each case is proved with two live sessions in the prover, in both orders):
--   * A location added to the person's job at the same instant: the activation locks the person's open jobs
--     (FOR UPDATE, as dispatch_job_locations does) in its own statement, and the new location holds its job's FK
--     KEY SHARE lock, so one waits for the other; the activation then reads locations in a fresh statement, or
--     the field-insert trigger sees the committed active applicator. A concurrent complete, cancel or unassign
--     is waited for and re-checked too.
--   * A job assigned to the person at the same instant: BEFORE triggers on jobs (INSERT with an applicator,
--     UPDATE OF applicator_id) share-lock the person's profile row, which the activation holds, so one waits for
--     the other; the activation then sees the committed assignment, or the existing assignment trigger re-reads
--     the profile and sees the person active.
--   * No deadlock: the assignment locks the job being assigned, which is not yet the person's in the activation's
--     snapshot, so the activation never waits on it. One transaction that first locks one of the person's open
--     jobs and then assigns them another job could still deadlock with an activation of the same person (an
--     error and retry, nothing lost); no app path does that.
--
-- DELIBERATELY LEFT ALONE:
--   * a location that already has any dispatch row (dispatched, completed or cancelled): a Dispatch Board
--     split or a deliberate undispatch (which keeps a 'cancelled' row) stays as it is;
--   * deactivation or a role change away from applicator: unchanged, as today.
--
-- NOT CHANGED: every existing function, trigger and table. Trigger functions, not RPCs, so they take no
--   idempotency key; re-running adds nothing (NOT EXISTS + ON CONFLICT DO NOTHING).
--
-- ROLLBACK (its own reviewed migration; backfilled rows are ordinary dispatches and stay):
--   DROP TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify ON public.profiles;
--   DROP TRIGGER trg_lock_applicator_profile_on_job_insert ON public.jobs;
--   DROP TRIGGER trg_lock_applicator_profile_on_job_assign ON public.jobs;
--   DROP FUNCTION public._sync_job_location_dispatch_on_applicator_qualify();
--   DROP FUNCTION public._lock_assigned_applicator_profile();
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.jobs') IS NULL
     OR to_regclass('public.job_fields') IS NULL OR to_regclass('public.job_location_dispatches') IS NULL THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: a table these triggers read or write is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_location_dispatches'::regclass
                  AND conname = 'job_location_dispatches_job_field_id_key') THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: job_location_dispatches has no one-row-per-location key';
  END IF;
  IF to_regprocedure('public._sync_job_location_dispatch_on_applicator_qualify()') IS NOT NULL
     OR to_regprocedure('public._lock_assigned_applicator_profile()') IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: a KI-28 function already exists';
  END IF;
END
$preflight$;

CREATE FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  -- Lock the person's open jobs first, in their own statement; the INSERT below then reads their locations
  -- from a fresh snapshot (see CONCURRENCY in the header).
  PERFORM 1
    FROM jobs j
   WHERE j.applicator_id = NEW.id
     AND j.status IN ('scheduled', 'in_progress')
     AND j.deleted_at IS NULL
     FOR UPDATE;

  INSERT INTO job_location_dispatches
    (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
  SELECT jf.id, j.id, NEW.id, NULL, now(), 'dispatched', COALESCE(auth.uid(), j.updated_by, j.created_by)
    FROM jobs j
    JOIN job_fields jf ON jf.job_id = j.id
   WHERE j.applicator_id = NEW.id
     AND j.status IN ('scheduled', 'in_progress')
     AND j.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM job_location_dispatches d WHERE d.job_field_id = jf.id)
  ON CONFLICT (job_field_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- BEFORE trigger on jobs: share-lock the assigned person's profile row, so an activation of that person is
-- serialized with this assignment (see CONCURRENCY).
CREATE FUNCTION public._lock_assigned_applicator_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM 1 FROM profiles WHERE id = NEW.applicator_id FOR SHARE;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() OWNER TO postgres;
ALTER FUNCTION public._lock_assigned_applicator_profile() OWNER TO postgres;
-- Trigger-only functions (no .rpc() caller); triggers fire regardless of EXECUTE grants.
REVOKE ALL ON FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._lock_assigned_applicator_profile() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify
  AFTER UPDATE OF is_active, role ON public.profiles
  FOR EACH ROW
  WHEN (NEW.is_active AND NEW.role = 'applicator' AND NOT (OLD.is_active AND OLD.role = 'applicator'))
  EXECUTE FUNCTION public._sync_job_location_dispatch_on_applicator_qualify();

CREATE TRIGGER trg_lock_applicator_profile_on_job_insert
  BEFORE INSERT ON public.jobs
  FOR EACH ROW
  WHEN (NEW.applicator_id IS NOT NULL)
  EXECUTE FUNCTION public._lock_assigned_applicator_profile();

CREATE TRIGGER trg_lock_applicator_profile_on_job_assign
  BEFORE UPDATE OF applicator_id ON public.jobs
  FOR EACH ROW
  WHEN (NEW.applicator_id IS NOT NULL AND NEW.applicator_id IS DISTINCT FROM OLD.applicator_id)
  EXECUTE FUNCTION public._lock_assigned_applicator_profile();

-- BACKFILL: any open-job location whose assigned person is already an active applicator and that has no dispatch
-- row at all (a job whose person qualified before this file was applied). 0 such rows live 2026-11-08; the same
-- predicate as the trigger, so the apply leaves none behind. dispatched_by: the job's last editor, else creator.
INSERT INTO public.job_location_dispatches
  (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
SELECT jf.id, j.id, j.applicator_id, NULL, now(), 'dispatched', COALESCE(j.updated_by, j.created_by)
  FROM public.jobs j
  JOIN public.job_fields jf ON jf.job_id = j.id
  JOIN public.profiles p ON p.id = j.applicator_id
 WHERE p.is_active = true AND p.role = 'applicator'
   AND j.status IN ('scheduled', 'in_progress')
   AND j.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.job_location_dispatches d WHERE d.job_field_id = jf.id)
ON CONFLICT (job_field_id) DO NOTHING;

DO $postflight$
DECLARE
  v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._sync_job_location_dispatch_on_applicator_qualify()'::regprocedure,
    'public._lock_assigned_applicator_profile()'::regprocedure] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.prosecdef
                    AND p.proowner = 'postgres'::regrole AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_POSTFLIGHT: % owner or settings are wrong', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_POSTFLIGHT: a client role can execute %', v_fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgenabled = 'O' AND (t.tgrelid, t.tgname) IN (
         ('public.profiles'::regclass, 'trg_sync_job_location_dispatch_on_applicator_qualify'),
         ('public.jobs'::regclass, 'trg_lock_applicator_profile_on_job_insert'),
         ('public.jobs'::regclass, 'trg_lock_applicator_profile_on_job_assign'))) <> 3 THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_POSTFLIGHT: a KI-28 trigger is missing or disabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.jobs j
      JOIN public.job_fields jf ON jf.job_id = j.id
      JOIN public.profiles p ON p.id = j.applicator_id
     WHERE p.is_active = true AND p.role = 'applicator'
       AND j.status IN ('scheduled', 'in_progress') AND j.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.job_location_dispatches d WHERE d.job_field_id = jf.id)) THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_POSTFLIGHT: an open-job location of an active applicator still has no dispatch row';
  END IF;
END
$postflight$;
