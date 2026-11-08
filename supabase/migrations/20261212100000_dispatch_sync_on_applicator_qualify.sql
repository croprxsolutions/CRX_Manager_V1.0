-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261212100000_dispatch_sync_on_applicator_qualify.md. Re-read the live ledger before applying.
--
-- WHY (KI-28): the two dispatch-sync triggers from 20260707020000_assignment_unification
--   (_sync_job_location_dispatch_on_field_insert, _sync_job_location_dispatch_on_applicator_change) skip a job
--   whose assigned person is not an active applicator at that moment, and nothing re-fires them later. A job
--   assigned to someone who is inactive or not yet role 'applicator' therefore never reaches the Dispatch Board,
--   even after the person is re-activated or given the applicator role. Detection sweep:
--   scripts/db-invariant-sweeps/predicates/dispatch-sync-nonqualifying-profile.sql (0 rows live 2026-11-08,
--   so this is preventive). Live 2026-11-08: 0 open-job locations of a QUALIFYING applicator lack a dispatch
--   row either, so the license trigger below has nothing old to pick up.
--
-- WHAT: one helper, _dispatch_open_job_locations_to_applicator(person), that (only for an active applicator
--   whose active licenses are not all expired) adds a 'dispatched' job_location_dispatches row for every
--   location of that person's live jobs (applicator_id = them, status scheduled or in_progress, not
--   soft-deleted) that has NO dispatch row at all: the rows the field-insert trigger writes for a qualifying
--   applicator. It runs:
--   * when a person BECOMES an active applicator (AFTER UPDATE OF is_active, role ON profiles);
--   * when one of their licenses is added, renewed, re-activated or moved to them (AFTER INSERT OR UPDATE OF
--     is_active, expiry_date, profile_id ON applicator_licenses), so a job held back by an expired license
--     reaches the board once the license is renewed.
--   dispatched_by follows the existing triggers: auth.uid() (the person making the change), else the job's
--   updated_by, else created_by.
--
-- CONCURRENCY (each case is proved with two live sessions in the prover):
--   * The person's profile row is the meeting point. Activation holds it (its own UPDATE). A license insert or
--     edit, and a job assignment (jobs INSERT with an applicator, or UPDATE OF applicator_id), take FOR SHARE
--     on that profile row in a BEFORE trigger, i.e. before they lock their own row. Whichever commits second
--     sees the other's committed change: the activation's helper reads in fresh statements after the wait, and
--     the existing assignment trigger re-reads the profile after it.
--   * Activation then locks the person's license rows (FOR SHARE) and re-reads them, so a license expired at
--     the same instant is honoured; then locks the person's open jobs (FOR UPDATE, as dispatch_job_locations
--     does) and reads their locations in a new statement, so a location added at the same instant (which holds
--     its job's FK KEY SHARE lock) is waited for and seen. A concurrent complete, cancel or unassign is waited
--     for and re-checked too.
--   * Lock order everywhere is profile, then license, then job, so these paths cannot deadlock each other. One
--     transaction that first locks an open job of the person and then assigns them another job could still
--     deadlock with an activation of the same person (an error and retry, nothing lost); no app path does that.
--
-- DELIBERATELY LEFT ALONE:
--   * a location that already has any dispatch row (dispatched, completed or cancelled): a Dispatch Board
--     split or a deliberate undispatch (which keeps a 'cancelled' row) stays as it is;
--   * a person whose active licenses are all expired (the same test as _enforce_applicator_license, Chicago
--     date; the admin-override bypass is not consulted): the job stays undispatched until a license is renewed
--     or the board dispatches it with its own override;
--   * deactivation or a role change away from applicator: unchanged, as today.
--
-- NOT CHANGED: every existing function, trigger, table and row (no backfill: 0 affected rows live). Trigger and
--   helper functions, not RPCs, so they take no idempotency key; re-running adds nothing (NOT EXISTS + ON
--   CONFLICT DO NOTHING).
--
-- ROLLBACK (its own reviewed migration):
--   DROP TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify ON public.profiles;
--   DROP TRIGGER trg_sync_job_location_dispatch_on_license_change ON public.applicator_licenses;
--   DROP TRIGGER trg_lock_applicator_profile_on_license_write ON public.applicator_licenses;
--   DROP TRIGGER trg_lock_applicator_profile_on_job_insert ON public.jobs;
--   DROP TRIGGER trg_lock_applicator_profile_on_job_assign ON public.jobs;
--   DROP FUNCTION public._sync_job_location_dispatch_on_applicator_qualify();
--   DROP FUNCTION public._sync_job_location_dispatch_on_license_change();
--   DROP FUNCTION public._lock_assigned_applicator_profile();
--   DROP FUNCTION public._dispatch_open_job_locations_to_applicator(uuid);
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.jobs') IS NULL
     OR to_regclass('public.job_fields') IS NULL OR to_regclass('public.job_location_dispatches') IS NULL
     OR to_regclass('public.applicator_licenses') IS NULL THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: a table these triggers read or write is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_location_dispatches'::regclass
                  AND conname = 'job_location_dispatches_job_field_id_key') THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: job_location_dispatches has no one-row-per-location key';
  END IF;
  IF to_regprocedure('public._dispatch_open_job_locations_to_applicator(uuid)') IS NOT NULL
     OR to_regprocedure('public._sync_job_location_dispatch_on_applicator_qualify()') IS NOT NULL
     OR to_regprocedure('public._sync_job_location_dispatch_on_license_change()') IS NOT NULL
     OR to_regprocedure('public._lock_assigned_applicator_profile()') IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_PREFLIGHT: a KI-28 function already exists';
  END IF;
END
$preflight$;

-- The shared work. Callers hold the person's profile row (activation) or a FOR SHARE lock on it.
CREATE FUNCTION public._dispatch_open_job_locations_to_applicator(p_profile_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_has_licenses boolean;
  v_latest_expiry date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_profile_id AND is_active = true AND role = 'applicator') THEN
    RETURN;
  END IF;

  -- Same license test as _enforce_applicator_license: only a person with active licenses, all expired, is held back.
  SELECT count(*) > 0, max(expiry_date) INTO v_has_licenses, v_latest_expiry
    FROM applicator_licenses WHERE profile_id = p_profile_id AND is_active = true;
  IF v_has_licenses AND v_latest_expiry < (now() AT TIME ZONE 'America/Chicago')::date THEN
    RETURN;
  END IF;

  -- Lock the person's open jobs first, in their own statement; the INSERT below then reads their locations
  -- from a fresh snapshot (see CONCURRENCY in the header).
  PERFORM 1
    FROM jobs j
   WHERE j.applicator_id = p_profile_id
     AND j.status IN ('scheduled', 'in_progress')
     AND j.deleted_at IS NULL
     FOR UPDATE;

  INSERT INTO job_location_dispatches
    (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
  SELECT jf.id, j.id, p_profile_id, NULL, now(), 'dispatched', COALESCE(auth.uid(), j.updated_by, j.created_by)
    FROM jobs j
    JOIN job_fields jf ON jf.job_id = j.id
   WHERE j.applicator_id = p_profile_id
     AND j.status IN ('scheduled', 'in_progress')
     AND j.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM job_location_dispatches d WHERE d.job_field_id = jf.id)
  ON CONFLICT (job_field_id) DO NOTHING;
END;
$function$;

CREATE FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  -- Wait for any concurrent edit of this person's licenses, so the helper reads them as committed.
  PERFORM 1 FROM applicator_licenses WHERE profile_id = NEW.id FOR SHARE;
  PERFORM _dispatch_open_job_locations_to_applicator(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public._sync_job_location_dispatch_on_license_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM _dispatch_open_job_locations_to_applicator(NEW.profile_id);
  RETURN NEW;
END;
$function$;

-- BEFORE trigger on jobs and applicator_licenses: share-lock the person's profile row before this row is
-- locked, so an activation of the same person is serialized with this write (see CONCURRENCY).
CREATE FUNCTION public._lock_assigned_applicator_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_profile_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'jobs' THEN
    v_profile_id := NEW.applicator_id;
  ELSE
    v_profile_id := NEW.profile_id;
  END IF;
  IF v_profile_id IS NOT NULL THEN
    PERFORM 1 FROM profiles WHERE id = v_profile_id FOR SHARE;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._dispatch_open_job_locations_to_applicator(uuid) OWNER TO postgres;
ALTER FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() OWNER TO postgres;
ALTER FUNCTION public._sync_job_location_dispatch_on_license_change() OWNER TO postgres;
ALTER FUNCTION public._lock_assigned_applicator_profile() OWNER TO postgres;
-- Trigger-only functions and an internal helper (no .rpc() caller); triggers fire regardless of EXECUTE grants.
REVOKE ALL ON FUNCTION public._dispatch_open_job_locations_to_applicator(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._sync_job_location_dispatch_on_license_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._lock_assigned_applicator_profile() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify
  AFTER UPDATE OF is_active, role ON public.profiles
  FOR EACH ROW
  WHEN (NEW.is_active AND NEW.role = 'applicator' AND NOT (OLD.is_active AND OLD.role = 'applicator'))
  EXECUTE FUNCTION public._sync_job_location_dispatch_on_applicator_qualify();

CREATE TRIGGER trg_sync_job_location_dispatch_on_license_change
  AFTER INSERT OR UPDATE OF is_active, expiry_date, profile_id ON public.applicator_licenses
  FOR EACH ROW
  WHEN (NEW.is_active)
  EXECUTE FUNCTION public._sync_job_location_dispatch_on_license_change();

CREATE TRIGGER trg_lock_applicator_profile_on_license_write
  BEFORE INSERT OR UPDATE OF is_active, expiry_date, profile_id ON public.applicator_licenses
  FOR EACH ROW
  EXECUTE FUNCTION public._lock_assigned_applicator_profile();

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

DO $postflight$
DECLARE
  v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._dispatch_open_job_locations_to_applicator(uuid)'::regprocedure,
    'public._sync_job_location_dispatch_on_applicator_qualify()'::regprocedure,
    'public._sync_job_location_dispatch_on_license_change()'::regprocedure,
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
         ('public.applicator_licenses'::regclass, 'trg_sync_job_location_dispatch_on_license_change'),
         ('public.applicator_licenses'::regclass, 'trg_lock_applicator_profile_on_license_write'),
         ('public.jobs'::regclass, 'trg_lock_applicator_profile_on_job_insert'),
         ('public.jobs'::regclass, 'trg_lock_applicator_profile_on_job_assign'))) <> 5 THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_POSTFLIGHT: a KI-28 trigger is missing or disabled';
  END IF;
END
$postflight$;
