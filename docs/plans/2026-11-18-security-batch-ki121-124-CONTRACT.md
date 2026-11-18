# Security batch KI-121, KI-122, KI-123, KI-124 — behavior contract

Read at `origin/staging` b7b0d9c66 (2026-11-18). Live read-only checks on `rhyzpcqhnizqbxphqdkr` the same day.

## 1. Outcome and authority

| KI | Business result |
|---|---|
| KI-121 | Nobody can leave the company with zero active admins by changing a role (today only deactivation is blocked). |
| KI-122 | When an admin sets someone's password, that person's existing sign-ins end, and the server records which admin reset whose password. |
| KI-123 | The signed-out (`anon`) role can read no `public` table or view. Login, forgot-password and reset-password pages make no table reads before sign-in. |
| KI-124 | End-to-end tests read the public key from the environment, not from 5 hard-coded copies. |

**Files expected:** one migration `supabase/migrations/<stamp>_security_batch_ki121_123.sql` + ledger record + changelog line; `supabase/functions/create-user/index.ts`, `supabase/functions/reset-user-password/index.ts`; `src/pages/SettingsPage.tsx` (error text and drop the client-side reset log); the 5 e2e files; `docs/manual/KNOWN_ISSUES.md`.

### KI-121
- Facts: `_guard_last_active_admin()` (only definition: `20260727174805`, live md5 `411de704…`) fires `BEFORE UPDATE OF is_active … WHEN is_active changed`. A role change goes through `admin_update_profile` → `UPDATE profiles SET role` (also `trg_guard_profile_role_lock` restricts who may change role/is_active to active admins). 5 active admins today.
- Change: re-emit the function to refuse when the row is currently an active admin (`OLD.role='admin' AND OLD.is_active`) and stops being one (`NEW.role<>'admin' OR NOT NEW.is_active`) and no other active admin exists. Trigger becomes `BEFORE UPDATE OF is_active, role` with `WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.role IS DISTINCT FROM NEW.role)`. Same error code `42501`, message prefix `LAST_ACTIVE_ADMIN`.
- Two admins demoting each other at once: each trigger's `NOT EXISTS` sees the other as still admin under READ COMMITTED, so both could pass. Lock: the function takes `pg_advisory_xact_lock(hashtext('crx_last_active_admin'))` before its check, and the second waits, then re-reads with a fresh snapshot (READ COMMITTED takes a new snapshot per statement; the check is a new statement inside the trigger after the lock), and is refused.
- Profile DELETE: out of scope (profiles are deactivated, not deleted; no app path deletes a profile). Named, not fixed.

### KI-122
- Facts: both paths (`create-user` action `reset_password`, used by Settings; and `reset-user-password`, no current screen caller) check an active-admin caller via `requireActiveProfile(…, ['admin'])`, refuse `entity_recipient` targets, then `auth.admin.updateUserById(user_id,{password})`. Supabase Auth has no admin "sign out user X by id" call; deactivation ends sessions in SQL (`DELETE FROM auth.refresh_tokens / auth.sessions`, `20260727174805`).
- Change: new `public.admin_password_reset_followup(p_target_user_id uuid, p_actor_id uuid, p_idempotency_key text DEFAULT NULL)`, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, EXECUTE granted to `service_role` only (revoked from PUBLIC, anon, authenticated). It deletes the target's `auth.refresh_tokens` and `auth.sessions` and inserts one `activity_feed` row (`event_type 'user_password_reset'`, `performed_by = p_actor_id`, `related_entity_type 'profile'`, `related_entity_id = target`). Idempotency: same key → no second audit row (the session delete is naturally repeatable). The actor id comes from the Edge Function's verified JWT, never from the request body.
- Both Edge Functions call it right after a successful password update. If it fails, they return 500 "Password changed, but existing sign-ins could not be ended" (Sentry captured), so the admin knows.
- Settings screen stops writing its own client-side `user_password_reset` row (the server row replaces it).
- Rollout: the Edge Functions change only after the migration is live on production (release), and each deploy needs Mason's approval. Until then the old functions keep working unchanged. The screen's own log line is removed in the same release; between the release and the Edge deploy, resets are not logged (a short, named gap; the Edge deploy is part of the release checklist).

### KI-123
- Facts (live): anon holds table-level SELECT on ~95 public tables/views plus 1411 column SELECT grants (later migrations kept copying `GRANT SELECT (col) … TO anon`). Default privileges: `postgres` grants `anon=r` on new tables; `supabase_admin` grants anon full rights on new tables. RLS blocks every anon read today. No signed-out screen reads a table: the routes outside `ProtectedRoute` are Login, Forgot password, Reset password; `AuthContext` reads `profiles` only with a session. Edge Functions use the anon key only to build a caller client carrying the user's JWT.
- Change: `REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon` plus a DO block revoking every remaining column-level SELECT for anon (both REVOKEs are needed: reviewers will not accept that a table REVOKE clears column grants), and `ALTER DEFAULT PRIVILEGES [FOR ROLE postgres] IN SCHEMA public REVOKE SELECT ON TABLES FROM anon`. `supabase_admin` default privileges cannot be changed by the migration role: named, not fixed (new tables are created by `postgres` in our migrations).
- Postflight in the migration: zero rows where `has_table_privilege('anon', c.oid, 'SELECT')` or `has_any_column_privilege('anon', c.oid, 'SELECT')` over `public` relations of kind r, v, m, p, f.
- Guard: a test fails if any migration after this stamp contains `GRANT … TO anon` on a table or column.

### KI-124
- `playwright.config.ts` already sets `process.env.VITE_SUPABASE_ANON_KEY` from the E2E config. The 5 files use `process.env.VITE_SUPABASE_ANON_KEY` as `workflow-admin-full-lifecycle.spec.ts` does.

## 2. State and failure
- KI-121: old rows unaffected. The deployed screen already shows a LAST_ACTIVE_ADMIN error; its text becomes "You cannot remove the only active admin…".
- KI-122: the sessions end in the same transaction as the audit row. The password change itself is in Auth, outside it; a retry of the whole request sets the same password again and ends sessions again (harmless), with a new idempotency key from the Edge Function per request → at most one audit row per request.
- KI-123: no rows change. Rollback: re-grant (a recorded down-statement in the ledger record).

## 3. Delivery
One PR to `staging`. The migration is compatible with the deployed app: the new function has no app caller until the Edge Functions deploy, and the revoke affects only the signed-out role. Edge deploy = Mason's later approval, after the migration is live on production.

## 4. Proof cases (local prover / real migrated database, test data)
1. When the only active admin is demoted to sales_rep, the update is refused with LAST_ACTIVE_ADMIN. With two admins, demoting one works.
2. When two admins demote each other in two concurrent sessions, one succeeds and the other is refused.
3. When the only admin is deactivated, still refused (regression).
4. When `admin_password_reset_followup` runs as service_role, the target's sessions and refresh tokens are gone, other users' remain, and one activity_feed row names the actor; a repeat with the same key adds no row. As `authenticated` or `anon`, the call is denied.
5. As `anon`, `SELECT` on every public table/view is refused (permission denied); as an active staff user, reads are unchanged (sample: profiles, customers, products).
6. A new table created by `postgres` after the migration gives anon no SELECT.
7. E2E files contain no `eyJ` literal; typecheck passes.

## Open business decisions
None.

## 5. Cold challenge (Astra `gpt-6.2-astra` high, 2026-11-18, FINDINGS 59) — how each was settled

Corrections to sections 1–4 above (these win where they differ):

- **KI-122 shrinks to the two Edge Functions; no migration, no new RPC.** Live Auth is GoTrue `v2.198.0` (read from
  `/auth/v1/health`). Its admin update calls `user.UpdatePassword(tx, nil)`, which runs `Logout(tx, u.ID)` inside the
  password transaction (`internal/api/admin.go:268`, `internal/models/user.go:519-521` at tag v2.198.0). So existing
  sign-ins already end on an admin reset; the KI's "sessions stay open" half was read from our code only and is
  refuted (settles #12, #14, #18 second half, #24). Remaining gap: no server-written record of which admin reset
  whose password. Each Edge Function now (a) requires the target profile to load without error, exist, and not be
  `entity_recipient` before calling Auth (fail closed, settles #20); (b) writes an `activity_feed` row with
  `performed_by = <verified caller id>`, `related_entity_type 'profile'`, `related_entity_id = target` **before**
  calling Auth and refuses the reset if that insert fails (so no password changes without a record: settles #15,
  #51); (c) on an Auth failure, writes a second row saying the reset failed. Rows are `auth_password_reset`
  ("started") and `auth_password_reset_failed`; the migration makes the `activity_insert` policy refuse those two
  event types from signed-in users, so only the server (service role) can write them (Sol round 1, 2026-11-18). The screen keeps its own client log line for now (no unlogged
  window during rollout; it keeps the `user_password_reset` type, so it stays apart from the server rows): settles #51, #52, #53. Removing the
  client line is a follow-up after Mason approves and the deploy is verified.
- **KI-121 lock (revised after review, 2026-11-18).** The guard takes `pg_advisory_xact_lock(hashtext('crx_last_active_admin'))`
  only when an active admin loses that status (#11). Under READ COMMITTED (what PostgREST RPCs use) it then counts the
  other active admins with no row locks: the count is a new statement, so a second removal waits on the lock and then
  sees the first's commit, and two removals on different admin rows cannot deadlock (both reviewers showed that the
  first design, `FOR UPDATE` in every mode, deadlocked them). Under REPEATABLE READ or SERIALIZABLE it counts
  `FOR UPDATE`, so locking an admin row another transaction changed raises a serialization error (fails closed).
  Settles #1. `role` and `is_active` are NOT NULL live, and the body uses `IS DISTINCT FROM` anyway (#3). The
  migration sets `lock_timeout = 5s` so the trigger swap cannot queue every request behind it.
- **KI-121 facts.** Live: all 5 active admins have a usable Auth user (not banned, not deleted) (#4, technical, not a
  decision). `admin_update_profile` → `_admin_update_profile_replay_impl_20261015` has no exception handler, so
  `LAST_ACTIVE_ADMIN` reaches the screen as an RPC error and the existing regex shows it (#7); a refused save stores
  no receipt, so the kept key can be reused for a corrected save (#9).
- **KI-123** also removes anon's rights on public **sequences** (live: anon holds SELECT, UPDATE, USAGE on 9, e.g.
  `invoice_number_seq`) and the postgres default for new sequences. The rollback is no longer "re-grant":
  `scripts/smoke/security-batch-ki123-reverse.sql` restores exactly the live inventory read 2026-11-18 (95 tables and
  views with table SELECT, 13 with column-only SELECT, 9 sequences, both default ACLs) (#35, #46). The text guard
  test is dropped; the postflight asserts the effective state (#40).

Not settled here, named (out of scope for these KIs; none is a business decision):
- `supabase_admin`'s default privileges still grant anon on objects *it* creates. Our migrations run as `postgres`,
  which is not a member of `supabase_admin` and cannot change them (#32, #33). New tables from our migrations are
  covered.
- Indirect reads through functions anon can execute (#37) were handled by `20260728231350`; not re-audited here.
- Profile deletion, a bulk same-statement admin hand-off (refused, fail-safe), and a pre-existing zero-admin state
  (#5, #10).
- `activity_feed` rows can be written by any active user as themselves (`activity_insert` policy); the server row
  is attributed correctly but is not tamper-proof (#26).
- Access tokens already issued stay valid until expiry after a reset, as after deactivation (#13, #30).
- E2E specs are not run against staging here: no staging E2E credentials in this checkout (#49, #50). Type-checked.
