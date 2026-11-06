-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261122100000_revoke_truncate_trigger_maintain.md.
-- Re-read the live ledger before applying.
--
-- WHAT (permissions; follow-up to 20261116100000_permission_tightening, KI-07):
--   1. Signed-in (authenticated) and anonymous (anon) users lose TRUNCATE, TRIGGER and MAINTAIN on
--      every public table and view. Read live 2026-11-06: authenticated held TRIGGER on 119, TRUNCATE
--      on 104 and MAINTAIN on 125 relations; anon held MAINTAIN on 114; all granted by postgres on
--      postgres-owned relations. TRUNCATE empties a whole table and skips row-level security; TRIGGER
--      attaches automatic code to a table or view; MAINTAIN allows VACUUM / ANALYZE / REINDEX / CLUSTER /
--      REFRESH MATERIALIZED VIEW / LOCK TABLE. No browser code, Edge Function, cron job or invoker
--      function uses them (Edge Functions run as service_role and cron as postgres, both untouched).
--   2. The default privileges of role postgres in schema public (the role every migration creates
--      tables as) stop handing those three to authenticated and anon, so new tables do not get them.
--
-- NOT CHANGED: SELECT / INSERT / UPDATE / DELETE / REFERENCES grants; service_role, postgres and every
-- other role; column grants; policies, functions, triggers; no rows. The default privileges of role
-- supabase_admin (Supabase platform and extension objects) cannot be changed by postgres (not a member)
-- and stay; every app table is postgres-owned, which the preflight checks.
--
-- ROLLBACK (its own reviewed migration): the exact GRANT list read live before the apply, in
-- docs/reference/migrations.d/20261122100000_revoke_truncate_trigger_maintain.md; the real-schema proof
-- (scripts/smoke/prove-revoke-truncate-trigger-maintain-real-schema.mjs) shows it restores every grant.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE revoke_ttm_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.revoke_ttm_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.revoke_ttm_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'REVOKE_TTM_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF current_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'REVOKE_TTM_PREFLIGHT: apply as postgres (the grantor and the default-privilege owner), not %', current_user;
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('authenticated', 'anon')) <> 2 THEN
    RAISE EXCEPTION 'REVOKE_TTM_PREFLIGHT: roles authenticated and anon must exist';
  END IF;
  -- A REVOKE by postgres removes only grants postgres made; every public relation must be its own.
  IF EXISTS (SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND c.relowner IS DISTINCT FROM 'postgres'::regrole) THEN
    RAISE EXCEPTION 'REVOKE_TTM_PREFLIGHT: a public table or view is not owned by postgres';
  END IF;
  -- Privileges inherited through a role membership would survive the revoke (read live 2026-11-06: none).
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.member IN ('authenticated'::regrole, 'anon'::regrole)) THEN
    RAISE EXCEPTION 'REVOKE_TTM_PREFLIGHT: authenticated or anon is a member of another role';
  END IF;
END
$preflight$;

-- Every table-level grant on public relations before the change, so the postflight can prove that
-- only the three privileges for the two roles changed.
CREATE TEMP TABLE revoke_ttm_before ON COMMIT DROP AS
SELECT c.oid AS rel, a.grantee, a.grantor, a.privilege_type, a.is_grantable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f');

REVOKE TRUNCATE, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM authenticated, anon;

-- New tables created by migrations (run as postgres) must not get them back.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, TRIGGER, MAINTAIN ON TABLES FROM authenticated, anon;

DO $postflight$
BEGIN
  -- Effective access, not just direct grants: catches a direct grant, a grant to PUBLIC, one
  -- inherited through a role membership, or ownership.
  IF EXISTS (SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              CROSS JOIN (VALUES ('authenticated'), ('anon')) AS r(rolname)
              CROSS JOIN (VALUES ('TRUNCATE'), ('TRIGGER'), ('MAINTAIN')) AS p(privilege)
              WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND has_table_privilege(r.rolname, c.oid, p.privilege)) THEN
    RAISE EXCEPTION 'REVOKE_TTM_POSTFLIGHT: authenticated or anon still has TRUNCATE, TRIGGER or MAINTAIN on a public relation';
  END IF;
  -- Nothing else changed: the grants now equal the grants before, minus exactly those removed.
  IF EXISTS (
       (SELECT rel, grantee, grantor, privilege_type, is_grantable FROM revoke_ttm_before
         WHERE NOT (grantee IN ('authenticated'::regrole, 'anon'::regrole)
                    AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'MAINTAIN'))
        EXCEPT
        SELECT c.oid, a.grantee, a.grantor, a.privilege_type, a.is_grantable
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))
       UNION ALL
       (SELECT c.oid, a.grantee, a.grantor, a.privilege_type, a.is_grantable
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        EXCEPT
        SELECT rel, grantee, grantor, privilege_type, is_grantable FROM revoke_ttm_before)
     ) THEN
    RAISE EXCEPTION 'REVOKE_TTM_POSTFLIGHT: a grant other than TRUNCATE/TRIGGER/MAINTAIN for authenticated/anon changed';
  END IF;
  -- New-table defaults (this schema's and any all-schemas entry of postgres): the three are gone for
  -- the two roles and PUBLIC; the everyday four are kept for authenticated, SELECT for anon.
  IF EXISTS (SELECT 1
               FROM pg_default_acl d
               CROSS JOIN LATERAL aclexplode(d.defaclacl) a
              WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype = 'r'
                AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
                AND a.grantee IN (0::oid, 'authenticated'::regrole::oid, 'anon'::regrole::oid)
                AND a.privilege_type IN ('TRUNCATE', 'TRIGGER', 'MAINTAIN')) THEN
    RAISE EXCEPTION 'REVOKE_TTM_POSTFLIGHT: the default privileges still hand out TRUNCATE, TRIGGER or MAINTAIN';
  END IF;
  IF (SELECT string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text, a.privilege_type)
        FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype = 'r'
         AND d.defaclnamespace = 'public'::regnamespace
         AND a.grantee IN ('authenticated'::regrole, 'anon'::regrole)
         AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
     IS DISTINCT FROM 'anon:SELECT,authenticated:DELETE,authenticated:INSERT,authenticated:SELECT,authenticated:UPDATE' THEN
    RAISE EXCEPTION 'REVOKE_TTM_POSTFLIGHT: the everyday default grants for authenticated/anon changed';
  END IF;
END
$postflight$;
