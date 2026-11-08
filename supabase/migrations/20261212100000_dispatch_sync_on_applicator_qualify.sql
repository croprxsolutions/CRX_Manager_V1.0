-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261212100000_dispatch_sync_on_applicator_qualify.md. Re-read the live ledger before applying.
--
-- WHY (KI-28): the two dispatch-sync triggers from 20260707020000_assignment_unification
--   (_sync_job_location_dispatch_on_field_insert, _sync_job_location_dispatch_on_applicator_change) skip a job
--   whose assigned person is not an active applicator at that moment, and nothing re-fires them later. A job
--   assigned to someone who is inactive or not yet role 'applicator' therefore never reaches the Dispatch Board,
--   even after the person is re-activated or given the applicator role. Detection sweep:
--   scripts/db-invariant-sweeps/predicates/dispatch-sync-nonqualifying-profile.sql (0 rows live 2026-11-08,
--   so this is preventive).
--
-- WHAT: one trigger, AFTER UPDATE OF is_active, role ON profiles, firing only when a person BECOMES an active
--   applicator (was not one before). For each of that person's live jobs (applicator_id = them, status
--   scheduled or in_progress, not soft-deleted) it adds a 'dispatched' job_location_dispatches row for every
--   location that has NO dispatch row at all: the rows the field-insert trigger writes for a qualifying
--   applicator. Unlike that trigger it also re-checks the license (below), because time has passed since
--   _enforce_applicator_license checked it at assignment.
--   dispatched_by follows the existing triggers: auth.uid() (the person making the change), else the job's
--   updated_by, else created_by.
--
-- DELIBERATELY LEFT ALONE:
--   * a location that already has any dispatch row (dispatched, completed or cancelled): a Dispatch Board
--     split or a deliberate undispatch stays as it is (ON CONFLICT DO NOTHING as well, for races);
--   * a person whose active licenses are all expired (the same test as _enforce_applicator_license, Chicago
--     date; the admin-override bypass is not consulted): the job stays undispatched and the board's own
--     dispatch (with its license override) decides. Renewing the license later does not re-fire this trigger,
--     and the KI-28 sweep no longer lists the location once the person qualifies: a known, documented gap;
--   * deactivation or a role change away from applicator: unchanged, as today;
--   * a job ASSIGNED (or created) for the person in another transaction at the same instant as the
--     activation: neither side can see the other's uncommitted change, so that job can stay undispatched
--     and is dispatched from the Dispatch Board, as today. Closing it would need every job assignment and
--     location insert to lock the person's profile row, which can deadlock against save paths that lock the
--     job first (a visible error instead of a rare, visible undispatched job). A location ADDED to an
--     already-assigned job concurrently is covered: see the job lock below.
--
-- NOT CHANGED: every existing function, trigger, table and row (no backfill: 0 affected rows live). A trigger
--   function, not an RPC, so it takes no idempotency key; re-running it adds nothing (NOT EXISTS + ON CONFLICT).
--
-- ROLLBACK (its own reviewed migration):
--   DROP TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify ON public.profiles;
--   DROP FUNCTION public._sync_job_location_dispatch_on_applicator_qualify();
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.jobs') IS NULL
     OR to_regclass('public.job_fields') IS NULL OR to_regclass('public.job_location_dispatches') IS NULL
     OR to_regclass('public.applicator_licenses') IS NULL THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: a table this trigger reads or writes is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_location_dispatches'::regclass
                  AND conname = 'job_location_dispatches_job_field_id_key') THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: job_location_dispatches has no one-row-per-location key';
  END IF;
  IF to_regprocedure('public._sync_job_location_dispatch_on_applicator_qualify()') IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: _sync_job_location_dispatch_on_applicator_qualify() already exists';
  END IF;
END
$preflight$;

CREATE FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_has_licenses boolean;
  v_latest_expiry date;
BEGIN
  -- Same license test as _enforce_applicator_license: only a person with active licenses, all expired, is held back.
  SELECT count(*) > 0, max(expiry_date) INTO v_has_licenses, v_latest_expiry
    FROM applicator_licenses WHERE profile_id = NEW.id AND is_active = true;
  IF v_has_licenses AND v_latest_expiry < (now() AT TIME ZONE 'America/Chicago')::date THEN
    RETURN NEW;
  END IF;

  -- Lock the person's live jobs FIRST, in its own statement (as dispatch_job_locations locks a job). A location
  -- being added concurrently holds its job's FK KEY SHARE lock, so this waits for that insert to commit; the
  -- INSERT below is a new statement with a fresh snapshot (READ COMMITTED) and sees it. A location added after
  -- this lock waits for this transaction instead, and the field-insert trigger then sees an active applicator.
  -- A concurrent complete, cancel or unassign is waited for and re-checked, never left with a stray row.
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
ALTER FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() OWNER TO postgres;
-- Trigger-only function (no .rpc() caller); triggers fire regardless of EXECUTE grants.
REVOKE ALL ON FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify
  AFTER UPDATE OF is_active, role ON public.profiles
  FOR EACH ROW
  WHEN (NEW.is_active AND NEW.role = 'applicator' AND NOT (OLD.is_active AND OLD.role = 'applicator'))
  EXECUTE FUNCTION public._sync_job_location_dispatch_on_applicator_qualify();

DO $postflight$
DECLARE
  v_fn constant regprocedure := 'public._sync_job_location_dispatch_on_applicator_qualify()'::regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.prosecdef
                  AND p.proowner = 'postgres'::regrole AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_POSTFLIGHT: function owner or settings are wrong';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_POSTFLIGHT: a client role can execute the trigger function';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.profiles'::regclass
                  AND t.tgname = 'trg_sync_job_location_dispatch_on_applicator_qualify'
                  AND t.tgfoid = v_fn AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_POSTFLIGHT: the profiles trigger is missing or disabled';
  END IF;
END
$postflight$;
