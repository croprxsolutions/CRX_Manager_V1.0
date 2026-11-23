# KI-160 remainder: start a stock count in one server step — behavior contract

Read at `origin/staging` 84e8df019 (2026-11-22). Lane E, bug sprint.

## Facts
- `src/pages/CycleCounts.tsx` `handleCreate` (~L274-347) makes three writes from the browser: `next_cycle_count_number()` RPC,
  a direct `cycle_counts` insert, then a direct `cycle_count_items` insert of every `inventory` row at the chosen location
  (`expected_qty` = `quantity_available`). If the line insert fails, the empty count stays `in_progress`.
- `20270119130000_one_open_count_per_stock_row.sql`: partial unique index `cycle_counts_one_open_per_warehouse`
  (one `in_progress` count per warehouse), so that empty count blocks a new count at the warehouse until an admin
  cancels it; trigger `trg_cycle_count_item_one_open_row` refuses a stock row already on another open count and a row
  that is not the line's product at the count's warehouse.
- Who may start a count today: RLS `cycle_counts_insert` = `is_admin()`; `cycle_count_items_insert` = `is_admin()` and
  parent `in_progress`; `next_cycle_count_number()` (`20260908140000`) = active admin. Screens: admin only.
- Number: `next_cycle_count_number()` takes advisory lock 8675309 and returns `CC-<Chicago year>-<5 digits>`.
- `initiated_by` defaults to `auth.uid()`.

## Outcome and authority
- Business result: starting a count either fully happens (count + every line) or nothing is saved.
- Smallest change: one new `SECURITY DEFINER` RPC `create_cycle_count(p_warehouse text, p_notes text, p_performed_by uuid,
  p_idempotency_key text)` doing the same three writes in one transaction; the screen calls it instead. No new table,
  lock or flag (it reuses `next_cycle_count_number()` and its lock, the unique index and the line trigger).
- Who: an active admin only (same check as `next_cycle_count_number`). `p_performed_by`, if sent, must equal the caller.
- Screen sends only the warehouse name and notes. The server derives actor, number, status `in_progress`, and every line
  (product, stock row, expected quantity) from `inventory` at that location. Warehouse must be non-blank; notes blank -> null.
- Activity log stays in the browser after success, as today (a lost log row does not change stock).

## State and failure
- Always true: a count is never saved without its lines. No stock row at the location -> `NO_INVENTORY`, nothing saved.
  Any line refused by the trigger (row on another open count) -> whole call rolls back.
- Existing rows: none touched. No data migration. Direct-insert grants stay for now: the already-deployed app still uses
  them until the screen PR ships. Removing them is a named follow-up after the screen is live everywhere.
- Timing:
  - Double click / retry with the same key after a timeout: replay returns the first result (same count id/number); no
    second count. Key minted per warehouse+notes attempt, reset on success (same `idem` helper as cancel).
  - Two admins start a count at one warehouse at once: the unique index lets exactly one commit; the other gets
    `COUNT_ALREADY_OPEN: <warehouse> already has open count <number>` and the screen refreshes the list.
  - Same key, different warehouse/notes: refused by the fingerprint binding (`check_idempotency_intent`).
- Undo: unchanged — Cancel on the Cycle Counts screen (`cancel_cycle_count`).

## Delivery
- PR 1 (database): additive migration with the RPC + ledger record. Compatible with the deployed app (nothing removed).
- PR 2 (screen): `handleCreate` calls the RPC. Merges only after PR 1 is live on staging.

## Proof cases (local Supabase DB, test data; as the real caller via `SET ROLE authenticated` + JWT claims)
1. Admin, warehouse with 3 stock rows -> one `in_progress` count, 3 lines with expected = on-hand, number `CC-YYYY-#####`.
2. Admin, warehouse with no stock -> `NO_INVENTORY`, zero counts saved.
3. Sales rep / inactive admin / anon -> refused, nothing saved.
4. Warehouse already has an open count -> `COUNT_ALREADY_OPEN`, nothing new saved.
5. One stock row of the warehouse already on another open count (only possible via a stale row move) -> whole call
   rolls back: no count left behind. (Forced by putting the row on an open count at another warehouse is impossible due
   to the place check; proved by making the line trigger fail on a row and checking no count row remains.)
6. Same key twice -> same result, one count. Same key with another warehouse -> refused.
7. Browser: start a count on the local app; it appears with its lines.

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-22, 28 findings) — how each was settled
- Signature (2, 28): `create_cycle_count(p_warehouse, p_notes, p_performed_by, p_idempotency_key)`, all defaulted; the key
  is required non-blank by the server; `p_performed_by` kept for parity with `cancel_cycle_count` and must equal the caller.
  Result `{cycle_count_id, count_number, warehouse, line_count}` (21).
- Empty count by race (8): no separate stock precheck; the RPC counts the rows its one insert wrote and refuses 0.
  Membership and expected quantity are what that one INSERT ... SELECT reads (9); expected is recomputed when a line
  is saved anyway (20270119130000 comment 5). Null on-hand -> 0, as the screen did (10).
- Conflict message (15): an up-front lookup names the open count; a lost race is mapped to `COUNT_ALREADY_OPEN` only when
  the violated constraint is `cycle_counts_one_open_per_warehouse`, else re-raised.
- Same key at once (16): `check_idempotency_intent` takes a per-key advisory lock (20260811130000), so the second waits and
  replays. Replay is checked before any open-count or stock check, so a retry after the count was cancelled or completed
  still returns the original count (19).
- Key lifetime (18): per-attempt key from `useIdempotencyKey` (scope warehouse + notes), reset on success. A reload after a
  lost reply mints a new key and gets `COUNT_ALREADY_OPEN` naming the count it already made: no duplicate.
- Authority (3, 4, 7): `is_admin()` = active admin profile, same as this RPC and `next_cycle_count_number`; reads are
  unchanged (no read path changes). Admins can already read all inventory.
- Warehouse identity (6): matched exactly as stored, as the screen does today (picker sends stored names); only blank refused.
  Not a new rule, so no decision.
- Legacy rows (11): live read-only 2026-11-22: 17 counts, all cancelled, 0 empty, 17 distinct numbers. Nothing to dispose.
- Old clients (1, 5, 13, 25): direct inserts stay until every client runs the new screen (the PWA can serve an old bundle).
  Until then an old tab can still leave an empty count (today's behavior, Cancel clears it) and an old and a new start
  can share a number (already possible between two old tabs; numbers have no unique constraint). **Follow-up PR 3:** after
  the screen is live in production, revoke INSERT on `cycle_counts` and `cycle_count_items` from authenticated and prove
  both direct paths refused.
- Rollback order (26): revert the screen first, then drop the function; the index and triggers stay.
- Lock hold (20): the number lock is held through the line insert; one warehouse has at most a few hundred rows. Accepted.
- Logging (22): `logActivity` catches its own errors, so a failed log never shows a failed create.
- Proof gaps (12, 17, 23): proof case 5 uses a real stock-row move (location change) after a count opens; case 6 covers
  replay, key reuse elsewhere, forged actor and blank key. Browser check covers the real form.
- Undo (24): unchanged Cancel / Reverse paths; not touched here.

## Open business decisions
None.
