-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261107160000_dispatch_sync_on_applicator_reactivation.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-28): the two dispatch-sync triggers from 20260707020000
--   (_sync_job_location_dispatch_on_field_insert, _sync_job_location_dispatch_on_applicator_change) only
--   put a job's locations on the dispatch board when its assigned person is, at that moment, an active
--   profile with role 'applicator'. A job assigned to someone inactive (or not yet an applicator) was
--   skipped, and nothing re-ran the sync when that person later became an active applicator: the job sat
--   off the board for good. Worse, reassigning a dispatched job to such a person left the OLD holder's
--   rows active, so the old holder kept seeing and working a job that was no longer theirs.
--
--   1) NEW trigger on profiles: when a profile BECOMES an active applicator (it was not one before the
--      update), each location of that person's open jobs (scheduled / in_progress, not deleted) is put on
--      their board: a location with no dispatch row gets one, written exactly as the field-insert trigger
--      writes it; a location whose row is 'cancelled' AND held by this person is re-dispatched to them.
--      Rows held by anyone else (a wizard split), active rows and completed rows are never touched, so a
--      repeat of the update changes nothing. A person whose tracked active licenses have ALL expired is
--      skipped, the same rule dispatch_job_locations enforces (no license on file = allowed); those jobs
--      stay for the Dispatch Board wizard and its admin license override.
--   2) _sync_job_location_dispatch_on_applicator_change: reassigning an open job to someone who does not
--      qualify now hands every ACTIVE location row to the new assignee as 'cancelled' (off every board),
--      instead of leaving the old holders working it. (1) re-dispatches them once that person qualifies.
--      A qualifying reassignment already overwrote every location; this is the same scope.
--   3) Both existing triggers read the assignee's profile row with FOR SHARE (locked by id). A concurrent
--      reactivation then either commits first and is seen, or waits for this job's transaction to commit,
--      after which its own sync (new statements, fresh snapshot) sees the job. Without the lock, a job and
--      a reactivation saved at the same instant could both miss each other.
--   Everything else in both functions is byte-for-byte the 20260707020000 body (the preflight checks
--   the live bodies are still exactly those).
--
-- ACCEPTED LIMITS (KNOWN_ISSUES KI-28):
--   - A location the dispatcher deliberately undispatched from a person, on that person's own open job, is
--     re-dispatched to them if they are later deactivated and re-activated: it reads exactly like a
--     location held for them by (2).
--   - An applicator skipped for expired licenses is not re-synced when a license is renewed.
--   - Saving one of a person's jobs at the exact instant that person is re-activated can deadlock; Postgres
--     cancels one of the two saves with an error and the user saves again. No data is left half-written.
--
-- NOT CHANGED: dispatch_job_locations, undispatch_job_locations, every table, column, row and existing grant
--   (CREATE OR REPLACE keeps the two existing functions' grants). Live read-only 2026-11-05: 0 open-job
--   locations missing a dispatch row, so no backfill is needed and this file writes no rows when applied.
--
-- GRANTS: the new trigger function is EXECUTE postgres-only (PUBLIC, anon, authenticated, service_role revoked; a
--   trigger fires regardless of EXECUTE grants). It is SECURITY DEFINER like its two siblings, so it can
--   write job_location_dispatches under RLS when an admin reactivates a person.
--
-- ROLLBACK (its own reviewed migration): DROP TRIGGER trg_sync_job_location_dispatch_on_applicator_qualify
--   ON public.profiles; DROP FUNCTION public._sync_job_location_dispatch_on_applicator_qualify(); then
--   re-create the two existing functions from 20260707020000 verbatim.
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
  -- The two functions this file replaces must still be exactly the 20260707020000 bodies (live 2026-11-05).
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public._sync_job_location_dispatch_on_field_insert()'))
       IS DISTINCT FROM '789e0087cffa5e1819b7cb35448f28ac'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public._sync_job_location_dispatch_on_applicator_change()'))
       IS DISTINCT FROM '338a2b7ac06bb8b509ece0570ab3aa3f' THEN
    RAISE EXCEPTION 'PREFLIGHT_DISPATCH_SYNC_QUALIFY_DRIFT: an existing dispatch-sync function changed since 20260707020000';
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

-- ── 1) New: sync a person's open jobs when they become an active applicator ──────────────────────
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
  -- cannot end up with a fresh 'dispatched' row the close-on-terminal trigger never saw. NO KEY UPDATE,
  -- not UPDATE: it still waits for a status change, but not for a job_fields insert's foreign-key lock.
  -- The INSERT below is a new statement and re-reads the committed status.
  PERFORM 1 FROM jobs
   WHERE applicator_id = NEW.id AND status IN ('scheduled', 'in_progress') AND deleted_at IS NULL
   ORDER BY id
     FOR NO KEY UPDATE;

  -- The field-insert trigger's whole-job fallback, for every location it skipped while this person did
  -- not qualify; plus re-dispatch of a location held for this person as 'cancelled' (step 2 below).
  INSERT INTO job_location_dispatches
    (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
  SELECT jf.id, j.id, j.applicator_id, NULL, now(), 'dispatched',
         COALESCE(auth.uid(), j.updated_by, j.created_by)
    FROM jobs j
    JOIN job_fields jf ON jf.job_id = j.id
   WHERE j.applicator_id = NEW.id
     AND j.status IN ('scheduled', 'in_progress')
     AND j.deleted_at IS NULL
  ON CONFLICT (job_field_id) DO UPDATE
    SET applicator_id   = EXCLUDED.applicator_id,
        crew_id         = NULL,
        dispatched_at   = now(),
        dispatch_status = 'dispatched',
        dispatched_by   = EXCLUDED.dispatched_by
  WHERE job_location_dispatches.dispatch_status = 'cancelled'
    AND job_location_dispatches.applicator_id = NEW.id;

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

-- ── 2) + 3) Reassignment to a non-qualifying person; locked profile read ─────────────────────────
CREATE OR REPLACE FUNCTION public._sync_job_location_dispatch_on_applicator_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jf record;
  v_qualifies boolean;
BEGIN
  -- Clearing the whole-job applicator (Codex R2 P1): cancel the ACTIVE dispatch
  -- rows that belonged to the OLD whole-job applicator — otherwise the UI and
  -- jobs.applicator_id say "unassigned" while the old applicator still sees and
  -- can work the job, and the Needs-Dispatch surfaces won't flag it. Deliberate
  -- SPLIT rows are preserved: only rows held by OLD.applicator_id are touched
  -- (a crew-only or other-applicator split is not silently undone by clearing
  -- an unrelated job-level field).
  IF NEW.applicator_id IS NULL THEN
    IF OLD.applicator_id IS NOT NULL THEN
      UPDATE job_location_dispatches
         SET dispatch_status = 'cancelled',
             updated_at      = now()
       WHERE job_id = NEW.id
         AND applicator_id = OLD.applicator_id
         AND dispatch_status = 'dispatched';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('scheduled', 'in_progress') THEN RETURN NEW; END IF;

  -- KI-28: read the assignee locked (by id, FOR SHARE) so a concurrent reactivation is either seen or
  -- waits for this transaction, whose job its own sync then sees.
  SELECT p.is_active IS TRUE AND p.role = 'applicator'
    INTO v_qualifies
    FROM profiles p
   WHERE p.id = NEW.applicator_id
     FOR SHARE;
  IF v_qualifies IS NOT TRUE THEN
    -- KI-28: the job is no longer the old holders'. Every active location goes to the new assignee as
    -- 'cancelled' (off every board), the same scope a qualifying reassignment overwrites below; the
    -- reactivation sync re-dispatches them once this person qualifies.
    UPDATE job_location_dispatches
       SET applicator_id   = NEW.applicator_id,
           crew_id         = NULL,
           dispatch_status = 'cancelled',
           updated_at      = now()
     WHERE job_id = NEW.id
       AND dispatch_status = 'dispatched';
    RETURN NEW;
  END IF;

  -- "Reassign via JobDetail replaces the whole-job dispatch" (mission brief):
  -- every CURRENT location on this job is overwritten to the new applicator,
  -- including one previously split to a different applicator/crew via the
  -- Dispatch Board wizard. Re-split via the wizard after this if needed.
  FOR v_jf IN SELECT id FROM job_fields WHERE job_id = NEW.id LOOP
    INSERT INTO job_location_dispatches
      (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
    VALUES
      (v_jf.id, NEW.id, NEW.applicator_id, NULL, now(), 'dispatched',
       -- RLS review M1: same auth.uid()-first attribution as trigger 1 — the
       -- assign_job_applicator path never stamps jobs.updated_by, so without
       -- auth.uid() the row would credit the job's last editor, not the assigner.
       COALESCE(auth.uid(), NEW.updated_by, NEW.created_by))
    ON CONFLICT (job_field_id) DO UPDATE
      SET applicator_id   = EXCLUDED.applicator_id,
          crew_id         = NULL,
          job_id          = EXCLUDED.job_id,
          dispatched_at   = now(),
          dispatch_status = 'dispatched',
          dispatched_by   = EXCLUDED.dispatched_by;
  END LOOP;

  RETURN NEW;
END;
$$;

-- ── 3) Locked profile read in the field-insert sync ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._sync_job_location_dispatch_on_field_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_stash job_dispatch_preservation%ROWTYPE;
  v_qualifies boolean;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = NEW.job_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_job.status NOT IN ('scheduled', 'in_progress') THEN RETURN NEW; END IF;

  -- Codex R3 P1: restore a stashed per-location assignee FIRST (save_job's
  -- delete+recreate cycle — the BEFORE DELETE trigger above stashed it under
  -- the stable (job_id, field_id) key moments ago in this same transaction).
  -- A wizard split survives an unrelated notes/chemicals edit byte-for-byte.
  -- Stash rows older than 1 hour are ignored AND purged (a field re-added to
  -- the job much later is a new decision, not a restore).
  DELETE FROM job_dispatch_preservation
   WHERE job_id = NEW.job_id AND preserved_at < now() - interval '1 hour';

  SELECT * INTO v_stash
    FROM job_dispatch_preservation
   WHERE job_id = NEW.job_id AND field_id = NEW.field_id;

  IF FOUND THEN
    INSERT INTO job_location_dispatches
      (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
    VALUES
      (NEW.id, NEW.job_id, v_stash.applicator_id, v_stash.crew_id,
       COALESCE(v_stash.dispatched_at, now()), 'dispatched', v_stash.dispatched_by)
    ON CONFLICT (job_field_id) DO NOTHING;

    DELETE FROM job_dispatch_preservation
     WHERE job_id = NEW.job_id AND field_id = NEW.field_id;

    RETURN NEW;
  END IF;

  -- No stash entry → fall back to the whole-job applicator (the original #15
  -- fix). No whole-job applicator to sync to, or the job isn't in a
  -- dispatchable lifecycle state (mirrors dispatch_job_locations's own gate) —
  -- leave the location undispatched; the Dispatch Board wizard is the tool for that.
  IF v_job.applicator_id IS NULL THEN RETURN NEW; END IF;

  -- Defensive mirror of dispatch_job_locations's INVALID_APPLICATOR check.
  -- License expiry is NOT re-checked: enforce_applicator_license (BEFORE
  -- INSERT/UPDATE OF applicator_id ON jobs) already validated it before this
  -- job_fields row could exist with this applicator_id.
  -- KI-28: read locked (by id, FOR SHARE) so a concurrent reactivation is either seen or waits for this
  -- transaction, whose job its own sync then sees.
  SELECT p.is_active IS TRUE AND p.role = 'applicator'
    INTO v_qualifies
    FROM profiles p
   WHERE p.id = v_job.applicator_id
     FOR SHARE;
  IF v_qualifies IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- NEW.id is a freshly gen_random_uuid()'d job_fields row, so no existing
  -- job_location_dispatches row can already reference it — ON CONFLICT DO
  -- NOTHING is defensive belt-and-suspenders, not a live code path.
  INSERT INTO job_location_dispatches
    (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
  VALUES
    (NEW.id, NEW.job_id, v_job.applicator_id, NULL, now(), 'dispatched',
     -- RLS review M1: auth.uid() is the real session actor for every
     -- authenticated-invoked path (assign_job_applicator / direct .update()
     -- don't stamp jobs.updated_by, so the fallbacks alone could name the
     -- job's LAST editor as the dispatcher). Fallbacks cover owner/service runs.
     COALESCE(auth.uid(), v_job.updated_by, v_job.created_by))
  ON CONFLICT (job_field_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
  v_fn text;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._sync_job_location_dispatch_on_applicator_qualify()');
  IF NOT FOUND
     OR p.proowner <> 'postgres'::regrole
     OR has_function_privilege('anon', p.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass
                     AND tgname = 'trg_sync_job_location_dispatch_on_applicator_qualify'
                     AND tgfoid = p.oid AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTFLIGHT: the reactivation sync lost its owner, grants or trigger';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['_sync_job_location_dispatch_on_applicator_qualify',
                              '_sync_job_location_dispatch_on_applicator_change',
                              '_sync_job_location_dispatch_on_field_insert'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.' || v_fn || '()');
    IF NOT FOUND OR NOT p.prosecdef
       OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR has_function_privilege('anon', p.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT: % lost SECURITY DEFINER, its search_path or its anon revoke', v_fn;
    END IF;
  END LOOP;
END
$postflight$;
