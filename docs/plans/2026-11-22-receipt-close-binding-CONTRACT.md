# Behavior contract: close only the receipt the screen saw (#2251)

Read at staging `47b378731` (PR #2256 merged). Plan-contract pilot.

## 1. Outcome and authority

- **Result:** "Mark handled" (office list) and the close after a hand Email Confirmation act only on the customer receipt the screen was showing. If the delivery's receipt was queued again since (delivery voided and completed again), the server refuses with `DELIVERY_RECEIPT_CHANGED` and changes nothing; the new receipt stays owed and listed.
- **Smallest change:** one new migration re-creating `close_delivery_receipt` with a fourth argument `p_expected_queued_at timestamptz DEFAULT NULL`. Same body otherwise. Screens pass the receipt's `created_at` (list row) or the pause answer's `queued_at` (Email Confirmation) and drop the screen-side re-read (`receiptQueuedAt`/`sameReceipt`, the shortcut #2251 names). No new table, lock or flag.
- **Files:** `supabase/migrations/<stamp>_close_delivery_receipt_expected.sql`, its ledger record, prover `scripts/smoke/prove-ki25-receipt-screens-real-schema.mjs` (DB PR); `src/lib/receiptsToCheck.ts`, `src/pages/DeliveryDetail.tsx`, `src/components/deliveries/ReceiptsToCheck.tsx`, `src/types/supabase.ts`, their tests (screen PR).
- **Who:** unchanged. Active admin or sales rep (`profiles` FOR SHARE); drivers refused. SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE to `authenticated` only.
- **Locators:** `p_delivery_id` and `p_expected_queued_at` are locators only. The server re-reads the queue row under `FOR UPDATE` and compares; it trusts nothing else from the screen. A wrong or forged `queued_at` can only make the call refuse, never close another delivery's receipt (the row is found by `delivery_id`).

## 2. State and failure

- **Automatic record changes:** none new. The call can only cancel or pause the one row it already could; the new argument only adds a refusal.
- **Rule that always holds:** a close carrying an expected receipt never changes a row whose `created_at` differs (including no row). Checked in the same transaction as the update, under the row lock `confirm_delivery_receipt_send` also takes.
- **Existing rows:** no row changes at apply. Old callers (the deployed app sends three named arguments) resolve to the new function with `p_expected_queued_at = NULL` = today's behavior. Old saved idempotency keys keep working: the fingerprint adds `expected_queued_at` only when it is not NULL, so a NULL call fingerprints exactly as today.
- **Timing:**
  - Re-queue between the screen's read and the close: server refuses `DELIVERY_RECEIPT_CHANGED`; screen keeps the row listed and says a new receipt was queued (Email Confirmation) or reloads the list with that message (Mark handled).
  - Retry after a timeout: same key + same expected value = same request; the existing retry rule (re-check now, refuse on a changed generation) still applies. Same key with a different expected value is a different request and is refused by `check_idempotency_intent`.
  - Double click: unchanged (`savingRef`, key reuse).
  - Two office users: both bound to their own seen receipt; whichever commits first wins, the second gets `none` (cancelled) or `DELIVERY_RECEIPT_CHANGED`.
- **Email Confirmation with nothing queued** (`paused.queued_at` NULL): the screen skips the handled close (there is nothing it paused). A receipt queued during the send stays owed.
- **Undo/history:** unchanged (`last_error` note names who closed it).

## 3. Delivery

- **PR 1 (database):** migration + ledger + prover cases, to `staging`; works with the app already deployed (NULL default). Staging DB job applies it on merge.
- **PR 2 (screens):** passes the expected value; merges only after PR 1 is live on staging. Prepared in parallel.
- **Rollback:** a reviewed migration re-creating the three-argument function from `20261221100000` (the screen PR must be reverted first).

## 4. Proof cases (prover, real migrated database, test data)

1. When an office user closes `handled` with the row's own `created_at`, then the row is `cancelled`, outcome `closed`, `queued_at` equals it.
2. When the expected value differs from the row's `created_at` (re-queued), then `DELIVERY_RECEIPT_CHANGED`, the row is unchanged and nothing is saved under the key.
3. When an expected value is given and the delivery has no receipt row, then `DELIVERY_RECEIPT_CHANGED`.
4. When called with three arguments (deployed app), then behavior equals today (proof cases of PR #2256 pass unchanged).
5. When a key first used without an expected value is retried with one (or with a different one), then refused as a different request.
6. When `manual_send` is called with a stale expected value, then refused and the row is not paused.
7. When a driver calls it with a correct expected value, then `INSUFFICIENT_ROLE`.
8. Screen (vitest + browser on staging after both PRs): Mark handled on a row whose receipt was re-queued shows the "queued again" message and the row stays listed.

## Open business decisions

None. The refusal matches the settled rule (DECISION_LOG 2026-11-09, "Email Confirmation stays a hand send"; Sol r8 `DELIVERY_RECEIPT_CHANGED`). Remaining Sol r3 MED/LOW items in #2251 not covered here stay listed on #2251.

## Challenge (Astra gpt-6.2-astra high, 2026-11-22, FINDINGS 26) and settlement

Facts used: `delivery_receipt_queue.created_at` is `NOT NULL DEFAULT now()` (20261113140000:159); the only writers that set it are the first insert and `_enqueue_delivery_receipt`'s conflict branch, which fires only on a `cancelled` row never authorized to send (20270109100000:159-163). So a pending/sending/needs_check/sent receipt is never replaced in place; a replacement needs a close, a void and a new completion, three separate transactions, so `now()` differs. Keys (`useIdempotencyKey`) live in memory per mounted screen, one per scope.

- 7, 23 (signatures, rollback): corrected. The migration DROPs the three-argument function and CREATEs the four-argument one in the same transaction; the postflight refuses unless exactly one `close_delivery_receipt` exists, so no overload ambiguity. Rollback = drop the four-argument function and re-create the three-argument body, grants and comment of 20261221100000 (not re-running that file, whose preflight refuses).
- 9 (distinct generation): disproved by the facts above. Prover case R1 re-queues through `_enqueue_delivery_receipt` and asserts a new `created_at` on the same row id.
- 4 (replacement not listed): corrected wording. A replacement is a fresh owed receipt and follows the normal path: the server sends it, and it is listed only if it fails or waits over an hour. A refused close changes nothing.
- 6, 18 (messages): corrected. Both screens get a specific branch on `DELIVERY_RECEIPT_CHANGED` (matched by message text, not SQLSTATE): "This receipt changed since the page loaded. Nothing was closed." The list closes its dialog and reloads; the delivery page does not tell the office to mark it handled. `DELIVERY_NOT_COMPLETED` keeps its existing message.
- 8, 24 (old tabs, rollout): protection starts when a tab loads the new screen; an old tab keeps today's screen-side re-check. Order: database first (staging DB job, then the release applies the migration before the app deploys). If the database is rolled back while a new tab is open, the four-argument call fails with an error and is never retried without the expected value.
- 10 (missing values): list rows always have `created_at` (NOT NULL). The delivery page skips the final close only when the pause answer's `queued_at` is NULL (no row); any other answer passes its own `queued_at`.
- 13 (lost response): corrected. The key scope becomes delivery + reason + expected receipt, so a re-selected receipt gets its own key and a retry of the same one reuses its key.
- 14, 17 (key and two-user wording): corrected. "Different request refused" applies only when the earlier call committed; a refused first call saves nothing, so the same key may be used again. Two `manual_send` calls on one receipt may both answer `paused` (accepted 2026-11-09); only two `handled` closes on one receipt give `closed` then `none`.
- 16 (precision): the screen passes the server's string unchanged (never through `Date`); the fingerprint uses `extract(epoch)` text, independent of session time zone. Prover case R4 retries with the same instant written in another offset.
- 19, 20 (orderings, real re-queue): added prover cases R1 (re-queue commits before close -> refused), R2 (re-queue transaction holds the row lock while the close waits -> close refused after it commits), R3 (ineligible row, e.g. needs_check, is not replaced by `_enqueue_delivery_receipt` and keeps its generation, so the close succeeds).
- 11, 25 (authority, history): unchanged by this change (same callers, same `last_error` note); out of scope.
- 12, 15 (live starting point, old keys): the preflight refuses unless the installed body's md5 equals 20261221100000's and it is the only overload; old keys: a NULL call fingerprints exactly as before (prover case R5 replays a key saved by the old function).
- 21, 22 (screen proof): vitest covers the changed branch, the NULL-skip and the key scope on both screens; browser check on staging after both PRs (Mark handled and Email Confirmation on a test receipt). A forced re-queue during a hand send cannot be staged by hand; the prover covers it.
- 26 (separate RPC): declined. One function with a defaulted argument and no second overload is smaller; requiring the value for `handled` would break the deployed app.
- 1, 2, 3, 5 (DECISION): sent to Mason below.

## Mason decision (asked 2026-11-22)

Q: Email Confirmation picks the receipt when it pauses it (today), not when the page was opened. In the rare case where, while the page sat open, the receipt was marked handled, the delivery voided and completed again, the hand email uses the page's older details and covers the newer receipt. Recommendation: keep it (needs three other actions in between; reload fixes it). Alternative: bind the pause to the receipt shown when the page loaded and refuse otherwise (more screen work, one more refusal message).

**Answer (Mason, 2026-11-22): keep as is.** Email Confirmation binds to the receipt it pauses; the rare stale-page case stays (reload fixes it).
