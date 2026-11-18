-- Security batch (contract: docs/plans/2026-11-18-security-batch-ki121-124-CONTRACT.md)
--   KI-121  the last active admin can no longer stop being one by a ROLE change (deactivation was already refused).
--   KI-122  signed-in users can no longer write the server-only auth_password_reset* activity rows.
--   KI-123  the signed-out role (anon) loses every read on public tables, views and sequences (and its leftover
--           sequence write rights), and objects postgres creates later no longer grant it any.
-- Non-destructive: no row is changed or deleted. Rollback: scripts/smoke/security-batch-ki123-reverse.sql (exact live grants
-- read 2026-11-18) plus the KI-121 body restore in the same file.

-- profiles is read by almost every RLS check: fail fast rather than queue every request behind the trigger swap.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Preflight: the guard is the body this file was written against.
-- ---------------------------------------------------------------------------
DO $preflight$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._guard_last_active_admin()'::regprocedure)
       IS DISTINCT FROM '411de704268c49ac63b2755486b61ad5' THEN
    RAISE EXCEPTION 'SECURITY_BATCH_PREFLIGHT: _guard_last_active_admin() is not the expected body';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_policy
        WHERE polrelid = 'public.activity_feed'::regclass
          AND polname = 'activity_insert'
          AND polcmd = 'a'
          AND polroles = ARRAY['authenticated'::regrole]::oid[]
          AND polqual IS NULL
          -- The original check, or this file's (the rollback keeps the reset-row lock on purpose).
          AND pg_get_expr(polwithcheck, polrelid) IN (
                '(performed_by = ( SELECT auth.uid() AS uid))',
                '((performed_by = ( SELECT auth.uid() AS uid)) AND (event_type !~~ ''auth\_password\_reset%''::text))')) THEN
    RAISE EXCEPTION 'SECURITY_BATCH_PREFLIGHT: activity_insert is not the expected policy';
  END IF;
  -- Rows of those types may be genuine server records (written while an earlier apply was live) or rows any
  -- signed-in user wrote before the lock; nothing here can tell them apart, so a person decides (Mason,
  -- 2026-11-18: refuse, never relabel). Live had none on 2026-11-18.
  IF EXISTS (SELECT 1 FROM public.activity_feed WHERE event_type LIKE 'auth\_password\_reset%') THEN
    RAISE EXCEPTION 'SECURITY_BATCH_PREFLIGHT: auth_password_reset activity rows already exist; review them before applying';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- KI-121: refuse any update that leaves no active admin, by deactivation or by role change.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._guard_last_active_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_others integer;
BEGIN
  -- A payout-only profile never gains a usable login (20260516090000), so it can never count as an
  -- admin, and a person's profile never becomes one: its role is fixed both ways.
  IF (OLD.role = 'entity_recipient') IS DISTINCT FROM (NEW.role = 'entity_recipient') THEN
    RAISE EXCEPTION 'PAYOUT_PROFILE_ROLE: a payout-only profile keeps its role, and no other profile can take it'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.role = 'admin' AND OLD.is_active = true
     AND (NEW.role IS DISTINCT FROM 'admin' OR NEW.is_active IS DISTINCT FROM true)
  THEN
    -- Two admins removing each other at once would each still see the other as admin.
    -- The lock makes the second wait until the first commits.
    PERFORM pg_advisory_xact_lock(hashtext('crx_last_active_admin'));
    IF current_setting('transaction_isolation') = 'read committed' THEN
      -- A new statement after the lock: it sees the first's commit. No row locks, so two
      -- removals on different admin rows cannot deadlock (the app's RPCs run here).
      SELECT count(*) INTO v_others
        FROM public.profiles p
       WHERE p.role = 'admin'
         AND p.is_active = true
         AND p.id <> NEW.id;
    ELSE
      -- The snapshot predates the lock. Locking an admin row another transaction changed
      -- raises a serialization error, so a stale count cannot pass (fails closed).
      SELECT count(*) INTO v_others
        FROM (SELECT 1
                FROM public.profiles p
               WHERE p.role = 'admin'
                 AND p.is_active = true
                 AND p.id <> NEW.id
                 FOR UPDATE) admins;
    END IF;
    IF v_others = 0 THEN
      RAISE EXCEPTION 'LAST_ACTIVE_ADMIN: cannot remove or deactivate the only active admin'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public._guard_last_active_admin() IS
  'Refuses to deactivate or demote the last active admin, which would lock the account out of its own app (KI-121), and any role change into or out of the payout-only entity_recipient role.';

REVOKE ALL ON FUNCTION public._guard_last_active_admin() FROM PUBLIC, anon, authenticated;

-- Replaced in place: there is no moment without the guard, even if statements were run one by one.
CREATE OR REPLACE TRIGGER trg_guard_last_active_admin
  BEFORE UPDATE OF is_active, role ON public.profiles
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public._guard_last_active_admin();

-- ---------------------------------------------------------------------------
-- KI-122: the Edge Functions (service role, which bypasses RLS) write the auth_password_reset rows;
-- a signed-in user may still log their own activity, but not under those server-only event types.
-- ---------------------------------------------------------------------------
ALTER POLICY activity_insert ON public.activity_feed
  WITH CHECK (performed_by = (SELECT auth.uid()) AND event_type NOT LIKE 'auth\_password\_reset%');

-- ---------------------------------------------------------------------------
-- KI-123: the signed-out role reads nothing in public.
-- No signed-out screen reads a table (login, forgot and reset password only call Supabase Auth),
-- and no signed-out path uses a sequence.
-- Both REVOKEs are needed: later migrations granted anon column-level SELECT, and this states
-- their removal explicitly rather than relying on the table-level REVOKE to clear them.
-- ---------------------------------------------------------------------------
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

DO $revoke_anon_columns$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel,
           string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) AS cols
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND has_column_privilege('anon', c.oid, a.attnum, 'SELECT')
     GROUP BY c.oid
  LOOP
    EXECUTE format('REVOKE SELECT (%s) ON %s FROM anon', r.cols, r.rel);
  END LOOP;
END
$revoke_anon_columns$;

-- Objects postgres (the migration role) creates later no longer grant anon anything readable
-- (the table write grants went in 20260526151856). supabase_admin's own defaults are out of reach:
-- postgres is not a member of supabase_admin.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_left integer;
BEGIN
  WITH rels AS MATERIALIZED (
    SELECT c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f'))
  SELECT count(*) INTO v_left
    FROM rels r
   WHERE has_table_privilege('anon', r.oid, 'SELECT') OR has_any_column_privilege('anon', r.oid, 'SELECT');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'SECURITY_BATCH_POSTFLIGHT: anon can still read % public relation(s)', v_left;
  END IF;

  -- MATERIALIZED: the planner may otherwise call has_sequence_privilege on non-sequences, which errors.
  WITH seqs AS MATERIALIZED (
    SELECT c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S')
  SELECT count(*) INTO v_left
    FROM seqs s
   WHERE has_sequence_privilege('anon', s.oid, 'SELECT')
      OR has_sequence_privilege('anon', s.oid, 'UPDATE')
      OR has_sequence_privilege('anon', s.oid, 'USAGE');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'SECURITY_BATCH_POSTFLIGHT: anon still holds rights on % public sequence(s)', v_left;
  END IF;

  IF EXISTS (
       SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) x
        WHERE d.defaclrole = 'postgres'::regrole
          AND d.defaclnamespace IN ('public'::regnamespace, 0)
          AND d.defaclobjtype IN ('r', 'S')
          AND x.grantee IN ('anon'::regrole, 0)) THEN
    RAISE EXCEPTION 'SECURITY_BATCH_POSTFLIGHT: postgres still grants anon or PUBLIC rights on new tables or sequences';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_policy
        WHERE polrelid = 'public.activity_feed'::regclass
          AND polname = 'activity_insert'
          AND strpos(pg_get_expr(polwithcheck, polrelid), 'event_type !~~ ''auth\_password\_reset%''::text') > 0) THEN
    RAISE EXCEPTION 'SECURITY_BATCH_POSTFLIGHT: activity_insert does not refuse the server-only reset rows';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.profiles'::regclass
          AND t.tgname = 'trg_guard_last_active_admin'
          AND t.tgenabled = 'O'
          AND t.tgfoid = 'public._guard_last_active_admin()'::regprocedure
          AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF is_active, role ON public.profiles%'
          AND pg_get_triggerdef(t.oid) LIKE '%(old.role IS DISTINCT FROM new.role)%') THEN
    RAISE EXCEPTION 'SECURITY_BATCH_POSTFLIGHT: last-admin trigger does not cover role changes';
  END IF;
END
$postflight$;
