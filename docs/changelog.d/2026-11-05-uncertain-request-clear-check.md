## 2026-11-05 — Server check, and retire, before clearing a stuck request (KI-27, database half)

- New migration `20261107150000_uncertain_request_clear_check.sql` (record in `docs/reference/migrations.d/`):
  `retire_uncertain_request(p_request_key text, p_first_check_token text DEFAULT NULL, p_idempotency_key text DEFAULT NULL)`,
  admins only (the "clear this" button is already admin-only), plus two tables with RLS on, a deny-all policy and
  no client grants: `uncertain_request_clear_check_key` (one row: a random signing key generated inside the
  database) and `retired_uncertain_requests` (requests an admin cleared).
  PR #1485's "clear this" button will call it before it removes anything, so a wrong device clock can no longer
  clear a request that might still save. Answers:
  - `in_progress` (refused): a transaction holds the request's `crx:idempotency:` lock, so the request, or a row
    of a batch request, is being saved right now; ask again shortly.
  - `recorded` (safe): the request key is in `idempotency_keys` under the operation its prefix names, or, for an
    inventory batch (`adjust_inventory_batch`, which never records its own key), a row `<request key>:<uuid>` is
    recorded under `adjust_inventory` (this actor, when the receipt records one). A receipt under any other
    operation is not trusted and falls through to the wait.
  - `first_check` / `waiting` (refused): nothing recorded; the first check returns `first_check_token`, the server's
    time signed for that request, and the caller must ask again 15+ minutes later with it. A missing, forged,
    future or other-request token starts a new wait. `authenticated` statements stop after 8 seconds (checked live
    in `pg_roles` on 2026-11-05: `authenticated` statement_timeout=8s), so by then the request can no longer commit.
  - `not_recorded_after_wait` (safe), or `retired` (safe; an earlier safe answer already retired it).
- Every safe answer retires the request in `retired_uncertain_requests`, under the request's lock. The receipt
  insert guard `_guard_idempotency_key_insert` is re-issued (otherwise identical to `20260716160000`) to refuse any
  later receipt of a retired request key, or of any row key under it, with `IDEMPOTENCY_REQUEST_RETIRED`. That covers
  rows the browser never knew about, sends from other tabs, and expired receipts (the check runs before an expired
  receipt is removed). A row's receipt insert takes its batch's lock shared, so a retire waits for an in-flight row
  and a row sent during a retire waits and is then refused. Every saving RPC writes its receipt in the same
  transaction as its work, so the refusal rolls the work back (Sol findings).
- Idempotency: the request key is the call's idempotency key and its `retired_uncertain_requests` row is the
  receipt; `p_idempotency_key`, if sent, must equal it, and a repeat answers `retired` without writing.
- Times come from `clock_timestamp()`, not the transaction-start `now()`, so a long-open transaction cannot
  shorten the wait (Sol finding).
- Only the caller's own request keys (`<operation>:<auth.uid()>:<uuid>`, the format `generateIdempotencyKey`
  makes) are accepted. `request_actor_id` is not used for ownership because older receipts leave it NULL.
- SECURITY DEFINER because `idempotency_keys` and both new tables deny all direct access;
  `search_path = public, pg_temp`; EXECUTE for `authenticated` only.
- Proof before apply, on the local test database (`crx-local-app`): a second session inserting a batch row
  receipt -> `in_progress`; a retire holding the lock -> a row receipt sent meanwhile waits, then
  `IDEMPOTENCY_REQUEST_RETIRED`; a signed-in non-admin -> `NOT_AUTHORIZED`. The self-seeding smoke chain
  `scripts/smoke/smoke-uncertain-request-clear-check.sql` passed there (`SMOKE_PASS_ROLLBACK`): recorded and expired
  -> safe; a receipt under another operation -> wait; no, forged, borrowed and future tokens -> `first_check`; its
  own fresh token -> `waiting`; 5 minutes -> `waiting`, 16 minutes -> safe; asking again -> `retired`; a batch with a
  row saved under `adjust_inventory` -> `recorded`, under another operation -> wait; then a late save of the request,
  of an unknown row under it and of the expired key -> `IDEMPOTENCY_REQUEST_RETIRED`, while an unrelated key saves;
  another user's key or a row key -> `REQUEST_KEY_NOT_OWNED`; a wrong idempotency key -> `IDEMPOTENCY_KEY_MISMATCH`;
  signed out -> `AUTH_REQUIRED`.
- Not verified yet: the live apply and the live smoke run.
