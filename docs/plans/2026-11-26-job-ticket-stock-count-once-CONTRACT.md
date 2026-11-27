# Behavior contract: a job and its blend tickets take stock out once

Read at `origin/staging` d6f58581e (2026-11-26). Mason decision 2026-11-26: **A, count once, flag** (over B skip, C refuse).

## Facts
- `create_application_record_from_blend_ticket` (wrapper 20261016140000; body `_create_app_record_from_bt_replay_impl_20261015` = 20260713060200 body) files a `blend_ticket` application record and takes every product line out of Main Warehouse. It never reads `blend_tickets.job_id`.
- `complete_job` (wrapper 20270227170000; body `_complete_job_replay_impl_20261015` latest in 20261217100000) files a `job` application record and takes every non-customer-supplied `job_chemicals` line out. It never reads blend tickets.
- `BlendTicketDetail.tsx` offers Create App Record on any approved ticket, linked or not. So either order takes the same product out twice.
- Both RPCs take `pg_advisory_xact_lock(hashtext('next_application_record_number'))` before any stock row (complete_job explicitly, the ticket body via `next_application_record_number()`, live definition read 2026-11-26).
- `reverse_application_record` (20260713060500, admin only, no screen caller) credits back each ticket ledger row found by note text; before this change it took no number lock (it now does, see Reversal).
- Ledger writes: `inventory_transactions` INSERT/UPDATE/DELETE are revoked from PUBLIC, anon and authenticated (20261027080000); only definer functions write it. No CHECK on `quantity` (live constraint list 2026-11-26), so a 0 row is allowed.
- Direct job status writes are closed (20270303110000); a job reaches completed only through `complete_job`.
- `blend_tickets.job_id` changes by direct table update from the ticket screen (sends `job_id` on every save). Once a ticket has an application record, `trg_linked_blend_ticket_header_lock` (20260714230100, live and enabled 2026-11-26) already refuses any `job_id` change (`BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED`), so a filed ticket can never change job; before filing it moves freely.
- Production today: 0 jobs, 0 application records, 0 job-linked tickets (read-only query 2026-11-26).
- Settled: Mason D1 2026-11-23, field stock leaves once, at the blend ticket (mixer screen not built; this is the interim rule). Mason 2026-11-24: flags and notes over blocks for field work.

## Outcome
For one job and one product, the total taken out of stock is the larger of what the job claimed and what its filed tickets claimed together, never the sum. Each later posting takes only the difference.

Mechanism (stored facts, nothing re-derived):
- Two new nullable columns on `inventory_transactions`: `application_record_id` (plain uuid, no foreign key: the ledger is write-once, `trg_guard_inventory_transactions_immutable` refuses every UPDATE/DELETE, so a cascading FK action would make reversal fail) and `already_counted` (numeric, the part of this line's claim another posting already took). A line's **claim** = `quantity + coalesce(already_counted, 0)`, frozen at posting in the inventory unit actually used.
- The **group** for a job J and product P is every `job_applied` row whose `application_record_id` is J's `job` record or the record of a ticket whose `job_id` = J (read at posting time, under the number lock).
- For each line, in a fixed order (`sort_order`/`sequence_order`, then id): read the group's job claims `CJ`, ticket claims `CT` and amount taken `T` (rows already inserted earlier in the same posting are visible). With this line's claim `c`: job line moves `max(0, max(CJ + c, CT) − T)`; ticket line moves `max(0, max(CJ, CT + c) − T)`. Moved is capped at `c` (a line never takes more than it claims, even if an older group left a gap). `already_counted = c − moved`, stored as NULL when 0. Its CHECK is NULL or nonzero, because a smart-undo kept row on the job record is negative; a ticket or job posting is never negative by construction (moved is capped at `c`). An unlinked ticket moves its full claim as today.
- Any line with `already_counted > 0` gets `requires_review = true` and a note ("N already counted by job X / blend ticket(s)"). The short-stock flag only counts lines that moved something.
- Conversion, the ticket's unconvertible-unit refusal, the job's raw fallback and its flag, customer-supplied skip, holds, receipts and both legal records are unchanged. Ticket lines are always company stock (as today).
- Existing rows: cannot be backfilled (write-once ledger), so rows posted before this migration have no link. The group still counts them, found the way they always were: a job's rows by `job_id`, a ticket's rows by the application record named in their note (as `reverse_application_record` does). A job or ticket half posted before the migration and its other half after therefore still counts once (Luna r1 HIGH). The migration prints a NOTICE with the count of jobs whose both halves were posted before it (left as they are).

Files: one migration (two columns + index, re-emitted job body, ticket body and reversal, pre/postflight pins), changelog ledger record, rollback script, real-schema prover, `src/types/supabase.ts` columns. No screen change.

## Authority
Unchanged. Same roles, grants, wrappers and idempotency keys. New group helper: owner-only, EXECUTE revoked from PUBLIC/anon/authenticated/service_role. The new columns are written only by definer bodies (table INSERT already revoked from app roles). Nothing the screen sends is trusted beyond ids it already sends.

## State and failure
- Automatic change: the later posting moves less stock and flags the line. Authorized by Mason 2026-11-26 (A).
- Relink: no new rule. The existing header lock freezes a filed ticket's job; group membership is read at posting time, so an unfiled ticket moved between jobs counts toward the job it is on when filed.
- Reversal (smart undo, Mason 2026-11-26 "Yes, smart undo"; replaces the earlier refusal): takes the number lock first, then re-reads. A ticket counted with its completed job (same customer) reverses: every line is credited in full, then, per product, what the job still needs without this ticket (max(job claims, other tickets' claims) − what the others took, capped at this ticket's take) goes back out as a `job_applied` row on the job record with `already_counted` = −that amount, so the job's claim is unchanged and the stock stays counted. If other tickets took more than the job now needs because of this ticket, that extra comes back too, as a positive `adjusted` row (to Main Warehouse) linked to the job record (no one's claim, flagged for review), so the group's amount taken drops and later postings see it returned (Sol r4 MED 1; a positive `adjusted` row since Sol r5). A ticket with an active invoice is refused (Sol r5). The deleted record's number is retired and never handed out again (Sol r6). Unlinked tickets, other customers and open jobs reverse as today; the record is deleted, so its rows leave the group and the ticket can be re-filed or relinked.
- Timing: the number lock serializes completion, filing and reversal; every group read is a new statement after it (READ COMMITTED, fresh snapshot). Lock order, no cycles: completion = job row, number lock, stock rows; filing = ticket row, number lock, stock rows; reversal = number lock, record row, ticket row (FOR UPDATE, for the invoice check, Sol r5), ledger rows, stock rows (never the job row). Retries return the saved receipt before any lock (unchanged wrappers).
- Rollback before first use: the rollback script restores the three old bodies and drops the two helpers (columns stay, unused). After first use: forward fix only; the old reversal would refuse a zero row safely.

## Delivery
Database only, one PR to `staging`. The deployed app calls the same RPCs with the same arguments.

## Proof cases (real migrated database, prover, as the real callers)
1. Ticket 6 then job 10: job moves 4, `already_counted` 6, flagged; warehouse −10.
2. Ticket 12 then job 10: job row 0, flagged, commits; warehouse −12.
3. Job 10 then ticket 7: ticket moves 0; then ticket 6 on the same job moves 3; warehouse −13.
4. Job 10 then one ticket with two lines of P (6 and 7): moves 0 then 3.
5. Two job lines of P (4, 6) after ticket 5: first line 0, second 5 (credit-first in line order); warehouse −10.
6. Unlinked ticket, and ticket on an open job: full move, no flag.
7. Pints on a gallons product: claims in gallons.
8. Customer-supplied job line: no row, no credit used.
9. A filed ticket cannot change job (existing header lock); an unfiled ticket moved from open job A (2) to open job B (10) then filed: 12 out.
10. Smart undo: a counted ticket reverses and the job keeps what it still needs (ticket 6, job 10: nothing comes back; re-filing takes nothing more); an unlinked one reverses in full; a reversed ticket leaves the group (job completed afterwards moves its full claim). Sol's 10 + 12 example ends at 22 out.
11. Migration applies over a database that already has an unlinked old pair, printing the NOTICE; immutability guard untouched.
11b. Straddles: a ticket filed before the migration and its job completed after (job moves 4 of 10); a job completed before and its ticket filed after (ticket moves 0 of 7).
12. After every case, independently: warehouse change from its opening balance equals the expected total, and equals ledger history. Grants: the group helper is not executable by API roles; wrappers' grants unchanged.

## Challenge (Astra gpt-6.2-astra high, 2026-11-26, 39 findings) disposition
- Fixed by the stored-claim design: 2, 3, 4, 5, 6, 7, 12, 23, 29, 39 (adopted), 30 (short flag only on moved lines).
- Fixed by locking order: 1 (reversal takes the number lock then re-checks), 13, 14 (`IS DISTINCT FROM`), 18 (all four paths: row lock, then number lock, then stock).
- Disproved: 22 (20270303110000 closes direct job writes); 21 (ledger writes revoked 20261027080000; `application_records` has a SELECT policy only); 27 (only `approved` passes `!=`; NULL makes the test NULL and the IF does not raise, but the screen never offers it: pre-existing, out of scope); 28 (wrappers not re-emitted; grants asserted in prover).
- Settled by Mason's decisions: 10, 11 (D1: a linked ticket is part of that job's spray; separate work is a separate job or unlinked), 8 (raw-fallback lines are already flagged for review), 9 (ticket lines are company stock, as today), 19/20 (refusal with the existing admin adjustment as the correction route; rare, admin-only).
- Accepted, pre-existing, out of scope (follow-ups): 15, 16, 17, 24, 25, 26, 31 (holds release at completion as today), 32 (two legal records, billing unchanged), 38 (indexed lookups per line; the lock is already shared).
- 33/34/35: rows from before the migration are outside the rule (cannot be backfilled; production has none; NOTICE counts staging ones); rollback split into before/after first use.

## Accepted limits (follow-ups, not this change)
- Wrong job link discovered after completion: smart undo (`reverse_application_record`) reverses the ticket's record, the job keeps what it still needs, and the ticket can be re-filed against the right job. A hand adjustment alone is not the route: it leaves the ticket's claim in the wrong job's group.
- A product whose inventory unit changes between the two postings compares claims in different units. Only the second posting is flagged (as counted); the first, posted in full, is not. Rare; follow-up if units become editable on stocked products.
- Two legal application records (job and ticket) still exist for the same spray; billing unchanged. Follow-up.
- Pairs whose both halves were posted before this migration stay as they are (write-once ledger; production has none).

## Challenge re-check (Astra, 12 findings) disposition
- 4 (a line could move more than it claims): fixed, `LEAST(c, …)` cap in both bodies. Hard ticket delete is not reachable from the app (no DELETE policy on `blend_tickets`).
- 5 (stale read after a lock wait), 11 (missing cases): prover adds two races (filing and reversal while a completion holds the lock), a multi-product ticket and an open-job move before filing. The relink guard trigger was dropped: building the prover showed the existing header lock already freezes a filed ticket's job (confirmed live).
- 6 (lock order): written out above.
- 7 (trigger cannot see records): moot, the relink trigger was removed (existing lock covers it).
- 10 (rounding): disproved, `quantity` and `quantity_available` are unconstrained numeric (live, 2026-11-26).
- 1, 3: accepted limits above. 2, 8, 9: moot (no backfill, no foreign key). 12: wording fixed ("rows posted before this migration").

## Open business decisions
None left (Mason answered A on 2026-11-26).

## Luna round 1 (2026-11-26)
- HIGH: a half posted before the migration was invisible to the group, so its other half took the full amount. Fixed: the group also finds unlinked rows by `job_id` / note; prover straddle cases.

## Luna round 2 (2026-11-26)
- HIGH reversal-after-zero-ticket and MED ledger mismatch: refuted. On an open job every ticket line moves its full claim (no job record, so CJ = 0 and CT = T); a ticket row is credited only once the job record exists, which reversal refuses. Prover case added (two tickets, first reversed, job 4 moves 0).
- HIGH unit fallback mismatch: refuted for real data. `inventory_unit` is NOT NULL, 0 of 606 live products blank, `validate_product_units` rejects invalid units; raw fallback lines are already flagged.

## Luna round 3 (2026-11-26)
- MED deadlock between completion and reversal: refuted. The `complete_job` wrapper (`20270227170000`, the body's only caller) locks the job row, then takes the shared number lock, and only then calls the body, so the status update and its hold-release trigger run with the number lock held. Reversal takes the same lock first, so the two never wait on each other in a cycle. A direct table status change runs no stock deduction and never takes the lock, so it cannot form a cycle either. Prover race (f) runs a reversal during a completion.

## Sol round 1 (2026-11-26, head 6ca4b10e9)
- HIGH (fixed): a ticket linked to a job that later moved to another customer was counted with that job. Count once now groups a ticket with its job only when the ticket's customer matches the job's customer: the customer on the job's record once it is completed, else the job's current customer (`_job_stock_customer_20270310`). Ticket filing, job completion and the reversal refusal all use it. Prover: both orders (ticket first, then job moved; job completed for farm B, then a farm-A ticket filed) take full claims, and the ticket stays reversible.
- MED 2 (deferred, named follow-up): stock corrected by an adjustment after a duplicate ticket still leaves that ticket's claim in the group, so a later linked ticket can be over-taken. The correction route for counted lines is the existing follow-up "a route for correcting a wrong job link after filing"; every counted line is flagged for office review.
- MED 3 (fixed): the rollback takes the number lock before its guard, so no counted posting can commit between the check and the swap.
- MED 4 (fixed in part, residual accepted): the migration takes the number lock first, so it waits out any posting that holds it. A call already blocked inside an old body when the migration commits still runs the old body. Production has no jobs or application records yet (read-only check 2026-11-26), so apply at a quiet time.
- MED 5 (refuted for real data): old raw-unit ticket rows need an application record before this migration; production has 0 application records, and raw-fallback lines were already flagged for review.
- MED 6 (fixed): only the two helpers mark the migration applied; the columns and index use IF NOT EXISTS, so it re-applies after a rollback. Proven.
- LOW 7 (fixed): the rollback file sets ON_ERROR_STOP itself; the prover runs the documented command and sees a non-zero exit.
- LOW 8 (fixed): the race cases start the second session only after the completion holds the number lock (polled in pg_locks), not after a fixed delay.

## Sol round 2 (2026-11-26, head 1ad95c12a)
- HIGH (fixed by Mason's decision "Yes, smart undo"): the hand-adjustment correction left a wrongly linked ticket's claim in the job's group. Reversal now undoes a counted ticket and keeps on the job's books only what the job still needs (see Reversal above). Prover: Sol's 10 + 12 example ends at 22 out; ticket 6 + job 10 undone keeps 10; re-filing takes nothing more; the race reverses cleanly.
- MED reversal blocked for a ticket with a different product: resolved, the refusal is gone.
- MED in-flight old body across deployment: accepted residual (settled, round 1).
- LOW race proof: the second session starts only after the completion holds the number lock; a stall after that still runs inside the window the overlap assertion checks.
- LOW contract said rollback drops a trigger: fixed (drops the two helpers).

## Luna round 5 (2026-11-26, head fb3a81610)
- HIGH (fixed): the rollback guard looked only at counted rows, so a ticket that took its full claim under the new rule did not block it, and the restored old job body could then take that stock again. The guard now refuses once any row carries `application_record_id` (every posting under the new bodies). Prover: an uncounted linked posting alone refuses the rollback.

## Luna round 6 (2026-11-26, head f5e8765f9)
- MED (fixed): two same-key reversals at once: the second missed the first's uncommitted receipt, waited on the number lock, then answered differently. The reversal re-reads its receipt after taking the lock (READ COMMITTED: the first has committed) and replays it. Prover: two same-key reversals race and return the same answer.
- LOW (fixed): proof case 10 above described the old refusal.

## Sol round 4 (2026-11-26, head 8faeadc8d)
- HIGH (fixed, Mason "fix high issue"): a wrong job link had no undo on screen, and the changelog pointed staff to an adjustment, which left the ticket's claim in the job's group. Blend Ticket Detail now has an admin-only Undo Filing button that runs the smart undo; the changelog points there. Walked through locally (job 10 completed, wrong 12-gallon ticket filed, undone, unlinked and re-filed, real 10-gallon ticket filed): stock 78, the real ticket took 0, flagged.
- MED 1 (fixed): smart undo left another ticket's over-take out and told staff to adjust, which later postings ignored. The undo now returns that extra on the job's books (see Reversal). Prover: job 10, tickets 7 and 6, undo the 7, a later 5 takes 1 (11 out).
- MED 2 (accepted): undo and invoicing the same job at the same moment can deadlock through the `job_id` foreign-key check. PostgreSQL aborts one transaction whole (nothing half-written) and the user retries; it needs an admin undoing a ticket while someone invoices that same job.
- MED 3 (refuted for real data): early `delivered` ticket deductions from `20260609142548` are not in the group. Live (read-only, 2026-11-26): 0 application records, 0 completed jobs, 0 such rows, and `inventory_transactions` has no `reference_id` column.
- MED 4 (accepted residual, settled round 1): a call already inside an old body when the migration commits runs the old body; production has no jobs or application records yet.
- LOW race assertion (settled round 2): the second session starts only after the completion holds the number lock; a stall after that still runs inside the overlap window.
- LOW changelog and contract wording: fixed.

## Sol round 5 (2026-11-26, head 15c5458d1)
- HIGH 1 (fixed, Mason "Yes, fix and run 6"): Undo Filing ran on a billed ticket whose invoice then kept the job link. `reverse_application_record` now locks the ticket and refuses while it is billed or has a live invoice (same test as `_blend_ticket_billed_keeps_job_20270129`); invoicing locks the ticket first too, so billing cannot start mid-undo. The button is disabled with that reason. Prover: billed status refuses, a live draft invoice on an unbilled ticket refuses, a cancelled invoice allows it.
- HIGH 2 (fixed by warning, Mason): undo and refile lose lot corrections saved in Application Records. The confirmation says so and asks staff to re-enter them; not blocked (field workflow: flags and notes, not blocks).
- MED over-take return read as a deduction (fixed): the return is a positive `adjusted` row, `to_location` Main Warehouse, `application_record_id` the job record; `_job_stock_group_20270310.taken` subtracts such linked `adjusted` rows and they are no one's claim. The prover's ledger check now uses production's sign rule (job_applied always subtracts). Prover: job 10, tickets 7 and 6, undo the 7: the +3 adjusted row, no negative job_applied row, a later 5 takes 1.
- MED refund to a retired warehouse row (fixed): the over-take return upserts the Main Warehouse row like the credit loop. Prover: 13 on hand, filings empty it, the row is deleted, undo recreates it with 3.
- MED confirmation could switch tickets (fixed): the record id is captured when the dialog opens and used on Confirm; the dialog hides if the page shows another record.
- MED undo vs job invoicing deadlock: accepted (Sol r4, settled). MED in-flight old body across deployment: accepted residual (settled r1).
- LOWs (fixed): success message names returned stock; the no-op message says "Refreshing the page" instead of claiming it already did; Create App Record no longer says filing cannot be undone; the race cases now assert the second session was seen queued on the number lock (`pg_locks`, not granted), not just started before the completion ended.

## Luna round 7 (2026-11-26, head 58995d9b8; round cap lifted on Mason's "Yes, fix and run 6")
- HIGH (refuted): a ticket with `review_status` NULL passes the approval check. `blend_tickets.review_status` is `NOT NULL DEFAULT 'unreviewed'` (20260206203908) and no later migration relaxes it; the check is the unchanged pre-existing body.
- MED (refuted): a product's stock unit changing between a ticket filing and its job's completion. `_refuse_stock_unit_change_with_history` (20270201130000) refuses any stock-unit change once the product has stock movements, and the first filing writes one.

## Sol round 6 (2026-11-26, head f8d7eeb4f; Mason "yes fix and run 7")
- HIGH (fixed): undoing the newest filing deleted its record, and `next_application_record_number()` took the next number from surviving records only, so the next filing reused the number and two legal records could carry it. An `AFTER DELETE` trigger on `application_records` now keeps every deleted record's number in `application_record_numbers_retired` (RLS on, admins read, no API role writes), and the generator counts retired numbers too (same grants: service_role only). The rollback restores the old generator and refuses while any number is retired. Prover: undo the newest filing, the next filing gets the next number; a rep reads none; an admin cannot insert or delete.
- MED (fixed): a late Create App Record reply set its record on another ticket opened meanwhile; the reply now applies only while the same ticket is on screen.
- MED (fixed): an undo that moved nothing (the job had already counted the ticket) said the stock was back; it now says no stock changed.
- MEDs accepted (decision `docs/manual/decision-log.d/2026-11-26-pr2679-record-numbers-round7.md`): a retry replayed from another device; a cycle count between filing and undo; undo vs invoicing deadlock; the deploy window; the database-only rollback window.
- LOWs: note-text lookups (accepted, indexed by product, small per job); stale contract text (fixed here); the same-key test's second receipt read (accepted, covered by the replay race).

## Luna round 8 (2026-11-27, head 135c41116)
- MED (fixed): Undo Filing reset the screen-wide filing key even after the admin moved to another ticket whose filing was pending; it now resets it only while the same ticket is on screen (test asserts no reset after a move).
- LOW (fixed): the on-screen ticket marker now updates in a layout effect, in the same commit as the route change, so a late reply cannot see the previous ticket as current.
