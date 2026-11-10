-- predicate: browser-table-maintenance
-- Invariant (20261122100000, KI-07 follow-up): the browser roles (anon, authenticated) hold no
-- TRUNCATE, TRIGGER or MAINTAIN on any public table, view, materialized view or foreign table,
-- by any route (direct grant, PUBLIC, role membership, ownership), and belong to no other role.
-- Would have caught: the 462 such grants found live read-only 2026-11-06, and any later route the
-- repo guard (src/__tests__/browserTableMaintenanceGrants.test.ts) cannot see from migration text:
-- a privilege list built in dynamic SQL, a role membership such as pg_maintain, or a table that
-- reached public outside the migrations.
-- Contract: EXPECT ZERO rows once 20261122100000 is applied (before it, every one of the 462 shows).
-- Emits catalog names only, never row data.

SELECT 'relation:' || c.relname || ':' || r.role || ':' || p.privilege AS violation_key
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
 CROSS JOIN (VALUES ('TRUNCATE'), ('TRIGGER'), ('MAINTAIN')) AS p(privilege)
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND has_table_privilege(r.role, c.oid, p.privilege)

UNION ALL

SELECT 'membership:' || m.member::regrole::text || ':' || m.roleid::regrole::text AS violation_key
  FROM pg_auth_members m
 WHERE m.member IN ('anon'::regrole, 'authenticated'::regrole)
 ORDER BY 1;
