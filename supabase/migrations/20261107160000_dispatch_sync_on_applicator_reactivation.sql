-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261107160000_dispatch_sync_on_applicator_reactivation.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-28): the two dispatch-sync triggers from 20260707020000
--   (_sync_job_location_dispatch_on_field_insert, _sync_job_location_dispatch_on_applicator_change) only
--   put a job's locations on the dispatch board when its assigned person is, at that moment, an active
--   profile with role 'applicator'. A job assigned to someone inactive (or not yet an applicator) was
--   skipped, and nothing re-ran the sync when that person later became an active applicator: the job sat
--   off the board for good.
--   This adds one AFTER UPDATE trigger on profiles. When a profile BECOMES an active applicator (it was
--   not one before the update), every location of that person's open jobs (scheduled / in_progress, not
--   deleted) that has no dispatch row yet gets one, exactly as the field-insert trigger would have written
--   it: the job's applicator, no crew, 'dispatched', dispatched_by = the signed-in actor, else the job's
--   last editor or creator. ON CONFLICT (job_field_id) DO NOTHING: an existing row (a wizard split to
--   someone else, a cancelled or completed row) is never touched, and re-running the update adds nothing.
--   A person whose tracked active licenses have ALL expired is skipped, the same rule dispatch_job_locations
--   enforces (no license on file = allowed); those jobs stay undispatched for the Dispatch Board wizard
--   and its admin license override.
--
-- NOT CHANGED: both existing sync triggers and their functions, dispatch_job_locations, every table,
--   column, row and existing grant. Live read-only 2026-11-05: 0 open-job locations missing a dispatch row
--   (either shape), so no backfill is needed and this file writes no rows when applied.
--
-- KNOWN LEFTOVER (not this file): if a job dispatched to B is reassigned to an inactive A, the
--   applicator-change trigger skips and B's rows stay; re-activating A then leaves them (DO NOTHING), because
--   they look exactly like a wizard split. Tracked under KI-28 in KNOWN_ISSUES.md.
--
-- GRANTS: the new trigger function is EXECUTE postgres-only (PUBLIC, anon, authenticated, service_role revoked; a
--   trigger fires regardless of EXECUTE grants). It is SECURITY DEFINER like its two siblings, so it can
--   write job_location_dispatches under RLS when an admin reactivates a person.
--
-- ROLLBACK (its own reviewed migration): DROP TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify
--   ON public.profiles; DROP FUNCTION public._sync_job_location_dispatch_on_applicator_qualify();
--
-- ORDERING: apply after 20260707020000.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE dispatch_sync_qualify_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.dispatch_sync_qualify_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.dispatch_sync_qualify_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DISPATCH_SYNC_QUALIFY_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname = '_sync_job_location_dispatch_on_applicator_qualify')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass
              AND tgname = 'trg_sync_job_location_dispatch_on_applicator_qualify') THEN
    RAISE EXCEPTION 'PREFLIGHT_DISPATCH_SYNC_QUALIFY_EXISTS: the reactivation sync is already installed';
  END IF;
  -- ON CONFLICT (job_field_id) below needs the unique key on job_location_dispatches.job_field_id.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.job_location_dispatches'::regclass AND i.indisunique
       AND i.indisvalid AND i.indimmediate
       AND i.indnkeyatts = 1 AND i.indpred IS NULL
       AND i.indkey[0] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'public.job_location_dispatches'::regclass AND attname = 'job_field_id')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_DISPATCH_SYNC_QUALIFY_DRIFT: job_location_dispatches.job_field_id is not uniquely keyed';
  END IF;
END
$preflight$;

CREATE FUNCTION public._sync_job_location_dispatch_on_applicator_qualify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_has_licenses  boolean;
  v_latest_expiry date;
BEGIN
  -- The trigger's WHEN clause already limits this to "became an active applicator"; re-check so a
  -- direct call or a future trigger edit cannot widen it.
  IF NOT (NEW.is_active IS TRUE AND NEW.role = 'applicator')
     OR (OLD.is_active IS TRUE AND OLD.role IS NOT DISTINCT FROM 'applicator') THEN
    RETURN NEW;
  END IF;

  -- Same license rule as dispatch_job_locations: tracked active licenses, all expired = do not dispatch.
  SELECT count(*) > 0, max(expiry_date)
    INTO v_has_licenses, v_latest_expiry
    FROM applicator_licenses
   WHERE profile_id = NEW.id
     AND is_active = true;
  IF v_has_licenses AND v_latest_expiry < CURRENT_DATE THEN
    RETURN NEW;
  END IF;

  -- Lock this person's open jobs first (as dispatch_job_locations does), so a job closed concurrently
  -- cannot end up with a fresh 'dispatched' row the close-on-terminal trigger never saw. The INSERT
  -- below is a new statement and re-reads the committed status.
  PERFORM 1 FROM jobs
   WHERE applicator_id = NEW.id AND status IN ('scheduled', 'in_progress') AND deleted_at IS NULL
   ORDER BY id
     FOR UPDATE;

  -- The field-insert trigger's whole-job fallback, for every location it skipped while this person
  -- did not qualify. Existing rows are left alone.
  INSERT INTO job_location_dispatches
    (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
  SELECT jf.id, j.id, j.applicator_id, NULL, now(), 'dispatched',
         COALESCE(auth.uid(), j.updated_by, j.created_by)
    FROM jobs j
    JOIN job_fields jf ON jf.job_id = j.id
   WHERE j.applicator_id = NEW.id
     AND j.status IN ('scheduled', 'in_progress')
     AND j.deleted_at IS NULL
  ON CONFLICT (job_field_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify
  AFTER UPDATE OF is_active, role ON public.profiles
  FOR EACH ROW
  WHEN (NEW.is_active IS TRUE AND NEW.role = 'applicator'
        AND NOT (OLD.is_active IS TRUE AND OLD.role IS NOT DISTINCT FROM 'applicator'))
  EXECUTE FUNCTION public._sync_job_location_dispatch_on_applicator_qualify();

-- caller-analysis: _sync_job_location_dispatch_on_applicator_qualify :: trigger-only fn (no .rpc() caller).
REVOKE EXECUTE ON FUNCTION public._sync_job_location_dispatch_on_applicator_qualify() FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._sync_job_location_dispatch_on_applicator_qualify()');
  IF NOT FOUND
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR has_function_privilege('anon', p.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass
                     AND tgname = 'trg_sync_job_location_dispatch_on_applicator_qualify'
                     AND tgfoid = p.oid AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTFLIGHT: the reactivation sync lost its owner, mode, search_path, grants or trigger';
  END IF;
END
$postflight$;
