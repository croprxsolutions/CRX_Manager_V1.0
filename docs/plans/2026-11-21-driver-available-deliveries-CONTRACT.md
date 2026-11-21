# Behavior contract: drivers see and take open deliveries (#2018)

Read at `origin/staging` dab22364c (2026-11-21).

## Facts (with sources)

- The driver Deliveries screen shows an "Available Deliveries" card with a "Take This Delivery" button (`src/pages/Deliveries.tsx`, the `isDriver` effect and the `my-available` section). It reads `deliveries` directly where `assigned_driver IS NULL` and `status = 'scheduled'`, the 20 soonest by `scheduled_date` (ascending).
- The read rule `del_select` lets a driver read only rows where `assigned_driver = auth.uid()` (`20261129100000_deliveries_read_rules_check_role_once.sql`). So the card's read always returns nothing for a driver. That is the bug.
- `reassign_delivery` (wrapper `20261110160000`, body `_reassign_delivery_replay_impl_20261015` from `20260511010000`) already lets an active driver assign a delivery whose `assigned_driver IS NULL`. The check runs before the row lock, and it does not require the new driver to be the caller.
- Delivery statuses: scheduled, in_progress, completed, cancelled, voided (`.claude/schema-registry.json`).
- Farm group shown in lists is the TOP parent (#2032, `20270201110000_farm_group_top_parent_lists.sql`).

## Established decisions

- Mason, 2026-11-21 (in chat, this session): **every active driver may see all open, unassigned scheduled deliveries and take one.**

## Outcome and authority

- Result: the card lists open deliveries for a driver, and "Take This Delivery" assigns one to that driver.
- Smallest change: one new read function, `get_available_deliveries_for_driver()`, `SECURITY DEFINER`, `STABLE`, `search_path = public, pg_temp`, executable by `authenticated` (and `service_role`, as every app function is granted; never `anon`). It returns every open delivery (no cap: Mason said all), soonest scheduled date first, then delivery number, then id: `id, delivery_number, scheduled_date, customer_name, farm_group_name (top parent)`. Nothing else (no address, notes, items, prices). Reason it cannot reuse the list: the list function is `SECURITY INVOKER`, so the read rule hides these rows; widening `del_select` would also expose items, notes and addresses.
- Who may call it: an active profile with role `driver` (checked inside the function from `auth.uid()`; anyone else gets an error). It takes no arguments, so the screen sends nothing the server must trust.
- Rows: `assigned_driver IS NULL AND status = 'scheduled' AND deleted_at IS NULL`.
- Take hardening (same migration, `reassign_delivery` wrapper only): when the caller is a driver (not admin or sales rep), the server requires an active driver not denied the Deliveries page and `p_new_driver = caller`, checks the idempotency key (a bound same-key replay returns its stored result only while the delivery is still the caller's), then locks the delivery row and requires it scheduled, not deleted and unassigned (one already the caller's gets "already assigned to you"), then re-checks the driver's access holding their profile row. A stale row gets "This delivery was already taken or changed. Refresh the list.", not a permission error. A driver can therefore only take an open delivery for themself, and two drivers cannot both take it. Admin and sales rep behavior is unchanged.
- Files: new migration, ledger note, `src/pages/Deliveries.tsx` (screen PR), a real-schema prover, `smoke-specs` entry if required.

## State and failure

- Nothing is written by the read. No existing rows change.
- Timing: two drivers tap Take on the same delivery. The first wins; the second waits on the row lock, re-reads it as taken, and gets "already taken or changed". One driver's double tap with the same key: the second call waits, then replays the first result (one assignment, one notification). A lost-reply retry replays. A delivery assigned, started, cancelled or deleted after the card loaded: refused with "already taken or changed".
- The screen reloads the Available list on entry, after a take succeeds, and after a take is refused, and shows a load failure as an error, not an empty list.
- Existing callers of `reassign_delivery` (Deliveries take button, DeliveryDetail "Take This Delivery") both assign the caller, so the driver restriction keeps them working; admin and sales rep paths are unchanged.
- Other ways a driver could set `assigned_driver`: `del_update` lets a driver update only rows already assigned to them in progress or completed (`20261129100000` header); unchanged.
- Rollout: the old screen never calls the new function, and its only driver call to `reassign_delivery` assigns the caller. Rollback order: screen first, then `DROP FUNCTION get_available_deliveries_for_driver()`. The `reassign_delivery` hardening is corrected forward, never rolled back (rolling back reopens the race).
- Known limit, unchanged: a driver who took the wrong delivery asks the office, who reassigns it; nobody can put a delivery back to "unassigned" today.

## Delivery

1. Database PR (migration + prover + ledger) into `staging`. Sol required.
2. Screen PR switches the card to the new function and closes #2018. It merges only after the staging database has the function.

## Proof cases (local Docker real-schema prover, never live)

All in `scripts/smoke/prove-driver-available-deliveries-real-schema.mjs`:
1. When an active driver calls the read, then they get exactly every open delivery in order (29 seeded: 4 named + 25), only the five fields, and none assigned, started or deleted.
2. When an admin, sales rep, applicator, inactive driver or a driver denied the Deliveries page calls it, then it is refused; anon has no execute.
3. When the customer is C in A > B > C, then `farm_group_name` is A; with no parent it is null; with a forced loop the read still returns (direct parent).
4. When a driver takes an open delivery for themself, then it becomes theirs and leaves the list; assigning someone else, an inactive driver, a driver denied the Deliveries page, an applicator are refused; a fresh key on a delivery already theirs gets "already assigned to you"; taken, started, deleted deliveries get "already taken or changed"; a same-key retry replays.
5. When two drivers take the same delivery at once, then the second waits for the first, is refused, and the first owns it. A same-driver double tap notifies once.
6. When an admin or sales rep reassigns a scheduled or in-progress delivery, then it still works.
7. Browser (screen PR): a driver on a local run sees the card with deliveries, takes one, and it moves to their list.

## Astra challenge (gpt-6.2-astra, high, 2026-11-21): 50 findings, settled

- Fixed: cap removed (#1), order wording (#2), retry replays (#14), take requires scheduled (#15), deleted refused (#16), clear stale message (#32), exact-list, five-key, loop, waiting, double-tap and inactive/applicator proofs (#9, #11, #13, #18, #21, #26), rollback order (#43, #44), screen refresh and error state planned for the screen PR (#30, #31, #33, #37).
- Settled by evidence: top parent (#4) is the #2032 follow-up on this issue; hidden ancestor name (#5) is covered by Mason's yes to showing farm name and top farm group; existing callers (#41) both self-assign; other write routes (#29) via `del_update`; NOT NULL on number, date, status (#12, #17) from the schema registry; replay binding unchanged (#19, #20); the prover builds every migration (#39).
- Declined: live refresh while the page is open (#34), account-switch state (#35, the page unmounts on sign-out), paging (#48, open queues are small), dispatch "unassign" (#45, existing limit, noted above).

## Open business decisions

None. Mason, 2026-11-21: "Yes, show them" (drivers see open deliveries with farm name, top farm group and date).

## Luna (gpt-6-luna xhigh, head 7c54df20a): 2 findings

- MED, refuted: a driver's same-key retry after the office reassigned or deleted the delivery gets "already taken or changed", not the stored success. Intended: the stored success no longer says who owns the delivery (Astra #22), so the current state wins and the screen reloads the list.
- LOW, fixed here: the contract now names the `service_role` grant, which matches every app function.

## Sol round 1 (gpt-6.2-sol high, head f302c5b): 1 HIGH, 2 MED, 5 LOW, all fixed

- HIGH: a driver an admin denied the Deliveries page could still list and take open deliveries. Both the read and the driver take now refuse a driver whose `denied_pages` holds `deliveries` (the app's page key, `src/appPages.tsx`); proven.
- MED: lock order. A driver took the row lock before the idempotency key lock, the reverse of admin and sales rep. The driver path now checks the key (and returns a bound replay) first, then locks the row. So a driver's same-key retry after the office moved the delivery now replays its stored success, like every other replayed call (this supersedes the Luna MED note above); the screen reloads the list either way.
- MED: the SQL header's rollback now matches the ledger (screen first, then drop the read; the take hardening is corrected forward).
- LOW: a fresh key on a delivery already the caller's now says "already assigned to you", not a permission error.
- LOW: the race proof measures the second driver's time inside the database call (at least 1 s of lock wait), not from process launch.
- LOW: the post-take list check now requires the list call to succeed.
- LOW: the changelog names the replay condition (same key, caller and request). LOW: the seeded count is 29.

## Sol round 2 (gpt-6.2-sol high, head 45bbdecd9): 1 HIGH, 3 MED, 4 LOW, all fixed

- HIGH: a take waiting on the row lock could commit after an admin denied the driver Deliveries. After the lock the take now re-checks access and holds the driver's profile row (`FOR SHARE`) until commit; proven.
- MED: a driver's same-key replay is returned only while the delivery is still theirs; otherwise "already taken or changed" (the Luna MED position again; Sol round 1's note above is superseded).
- MED: preflight and postflight refuse more than one `reassign_delivery` overload.
- MED: the double-tap proof now requires that one tap waited on the other (both overlap), and both race proofs are order-independent.
- LOW: the denied-page test is null-safe (`array_position`), so a stray null entry does not lock a driver out; proven.
- LOW: "already assigned to you" only while the delivery is still scheduled; otherwise "already taken or changed".
- LOW: the list proof adds a delivery whose number sorts first but date last, and checks dates and ids.
- LOW: the take-hardening rule above now states the implemented order.

## Luna (gpt-6-luna xhigh, commit 28bc36eb4): 1 MED, fixed

- MED: a driver's same-key retry that waited on the key lock could replay success after an admin denied Deliveries. The replay path now re-checks the driver's access holding their profile row, as the fresh path does. Not separately proven (the window needs three interleaved sessions); the full prover still passes.
