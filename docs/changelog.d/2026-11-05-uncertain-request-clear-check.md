## 2026-11-05 — Server check, and retire, before clearing a stuck request (KI-27, database half)

- New migration `20261107150000_uncertain_request_clear_check.sql` (record in `docs/reference/migrations.d/`):
  `retire_uncertain_request(p_request_key text, p_row_keys text[] DEFAULT NULL, p_first_check_token text DEFAULT NULL, p_idempotency_key text DEFAULT NULL)`,
  plus the one-row table `uncertain_request_clear_check_key` (RLS on, deny-all policy, no client grants) holding a
  random signing key generated inside the database.
  PR #1485's "clear this" button will call it before it removes anything, so a wrong device clock can no longer
  clear a request that might still save. It looks at the request key and, for a batch, each row key the batch sent
  (`<request key>:<row uuid>`; a batch never records its own key). Answers:
  - `in_progress` (refused): a transaction holds the `crx:idempotency:` lock of one of the keys (the lock
    `check_idempotency_intent` and the receipt insert guard take), so something is being saved, or an expired
    receipt removed, right now; ask again shortly.
  - `recorded` (safe): the request key is in `idempotency_keys` under the operation its prefix names, or a row key
    is recorded (this actor, when the receipt records one). A request-key receipt under another operation is not
    trusted and falls through to the wait.
  - `first_check` / `waiting` (refused): nothing recorded; the first check returns `first_check_token`, the server's
    time signed for that request and its row keys, and the caller must ask again 15+ minutes later with it. A
    missing, forged, future or other-request token starts a new wait. `authenticated` statements stop after 8
    seconds (checked live in `pg_roles` on 2026-11-05: `authenticated` statement_timeout=8s), so by then the request
    can no longer commit.
  - `not_recorded_after_wait` (safe), or `retired` (safe; an earlier safe answer already retired it).
- Every safe answer retires each key that still has no receipt: a `retire_uncertain_request` receipt (30 days) is
  written under that key's lock, so a late send of the key from any tab is refused by the database
  (`IDEMPOTENCY_CROSS_OP_KEY_REUSE`) and cannot save after the clear (Sol finding). Keys that already have a receipt
  never save again while it lasts, but the next send deletes an expired receipt, so every receipt of the request
  (expired ones included) is kept 30 days from the safe answer (Codex review finding). The receipt rows are locked
  first, so a bulk cleanup of expired receipts that skips the advisory lock (`allocate_payment` does one) either
  finishes first or waits and then finds them renewed; a final check refuses (`CLEAR_BARRIER_MISSING`) unless every
  key has a 30-day barrier (Codex review finding).
- Idempotency: the request key is the call's idempotency key; `p_idempotency_key`, if sent, must equal it, and a
  repeat answers `retired` (it only renews the 30-day barrier).
- Times come from `clock_timestamp()`, not the transaction-start `now()`, so a long-open transaction cannot
  shorten the wait (Sol finding).
- Only the caller's own keys (`<operation>:<auth.uid()>:<uuid>`, the format `generateIdempotencyKey` makes) and
  row keys that extend them are accepted; at most 500 row keys. `request_actor_id` is not used for ownership because
  older receipts leave it NULL.
- SECURITY DEFINER because `idempotency_keys` and the signing-key table deny all direct access;
  `search_path = public, pg_temp`; EXECUTE for `authenticated` only.
- Proof before apply, on the local test database (`crx-local-app`), every case inside a rolled-back transaction: a
  second session holding a batch row key's lock -> `in_progress` with nothing written, and `first_check` once it
  is released; a second session deleting an expired receipt without the advisory lock (as that cleanup does) ->
  the check waits for it, sees the receipt gone and answers `first_check`, never a stale `recorded`. The self-seeding smoke chain `scripts/smoke/smoke-uncertain-request-clear-check.sql` passed there
  (`SMOKE_PASS_ROLLBACK`): recorded -> safe; a receipt under another operation -> wait; no, forged, borrowed,
  other-row-keys and future tokens -> `first_check`; its own fresh token -> `waiting`; 5 minutes -> `waiting`,
  16 minutes -> safe with the key retired; asking again -> `retired`; a batch with one saved row -> `recorded` with
  the base key and the unsaved row retired; an expired receipt -> `recorded` and kept 30 more days, so a later send
  of it -> `IDEMPOTENCY_CONCURRENT_REPLAY_RETRY`; a later send of a retired key -> `IDEMPOTENCY_CROSS_OP_KEY_REUSE`;
  another user's key, a row key outside the request -> `REQUEST_KEY_NOT_OWNED`; a wrong idempotency key ->
  `IDEMPOTENCY_KEY_MISMATCH`; signed out -> `AUTH_REQUIRED`.
- Not verified yet: the live apply and the live smoke run.
