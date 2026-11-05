## 2026-11-05 — Server check before clearing a stuck request (KI-27, database half)

- New migration `20261107150000_uncertain_request_clear_check.sql` (record in `docs/reference/migrations.d/`):
  read-only `check_uncertain_request_clearable(p_request_key text, p_first_check_token text DEFAULT NULL)`, plus the
  one-row table `uncertain_request_clear_check_key` (RLS on, deny-all policy, no client grants) holding a random
  signing key generated inside the database.
  PR #1485's "clear this" button will call it before it removes anything, so a wrong device clock can no longer
  clear a request that might still save. Answers:
  - `recorded` (safe): the key is in `idempotency_keys`, so the request saved.
  - `in_progress` (refused): a transaction holds the key's `crx:idempotency:` lock, the one
    `check_idempotency_intent` takes, so the request is being saved right now.
  - `first_check` / `waiting` (refused): not recorded; the first check returns `first_check_token`, the server's time
    signed for that key, and the caller must ask again 15+ minutes later with it. A missing, forged, future or
    other-request token starts a new wait, so neither the device clock nor an invented time can shorten it. `authenticated` statements stop after 8 seconds (checked live in `pg_roles` on 2026-11-05: `authenticated` statement_timeout=8s), so by then the request can no longer commit.
  - `not_recorded_after_wait` (safe).
- Only the caller's own keys can be checked (`<operation>:<auth.uid()>:<uuid>`, the format
  `generateIdempotencyKey` makes); `request_actor_id` is not used because older receipts leave it NULL.
- SECURITY DEFINER because `idempotency_keys` and the signing-key table deny all direct access; `search_path = public, pg_temp`; EXECUTE
  for `authenticated` only. No table writes, so no `p_idempotency_key` (the rule covers mutating RPCs).
- Proof before apply, on the local test database (`crx-local-app`), every case inside a rolled-back
  transaction: recorded -> safe; a second session holding the key's lock -> `in_progress`; no token, a forged token, another
  request's token and a future token -> `first_check`; its own fresh token -> `waiting`; a genuine token 5 minutes
  old -> `waiting`, 16 minutes -> safe; no client role can reach the signing-key table; another user's key and a
  derived row key -> `REQUEST_KEY_NOT_OWNED`; signed out -> `AUTH_REQUIRED`; anon -> permission denied. The new
  smoke chain `scripts/smoke/smoke-uncertain-request-clear-check.sql` passed there (`SMOKE_PASS_ROLLBACK`).
- Not verified yet: the live apply and the live smoke run.
