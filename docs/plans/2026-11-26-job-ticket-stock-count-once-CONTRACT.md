# Behavior contract: a job and its blend tickets take stock out once

Read at `origin/staging` d6f58581e (2026-11-26). Mason decision 2026-11-26: **A, count once, flag** (over B skip, C refuse).

## Facts
- `create_application_record_from_blend_ticket` (wrapper 20261016140000; body `_create_app_record_from_bt_replay_impl_20261015` = 20260713060200 body) files a `blend_ticket` application record and takes every product line out of Main Warehouse. It never reads `blend_tickets.job_id`.
- `complete_job` (wrapper 20270227170000; body `_complete_job_replay_impl_20261015` latest in 20261217100000) files a `job` application record and takes every non-customer-supplied `job_chemicals` line out. It never reads blend tickets.
- `BlendTicketDetail.tsx` offers Create App Record on any approved ticket, linked or not. So either order takes the same product out twice.
- Both RPCs take `pg_advisory_xact_lock(hashtext('next_application_record_number'))` before any stock row (complete_job explicitly, the ticket body via `next_application_record_number()`, live definition read 2026-11-26).
- `reverse_application_record` (20260713060500, admin only, no screen caller) credits back each ticket ledger row found by note text; it takes no number lock.
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
- For each line, in a fixed order (`sort_order`/`sequence_order`, then id): read the group's job claims `CJ`, ticket claims `CT` and amount taken `T` (rows already inserted earlier in the same posting are visible). With this line's claim `c`: job line moves `max(0, max(CJ + c, CT) − T)`; ticket line moves `max(0, max(CJ, CT + c) − T)`. Moved is capped at `c` (a line never takes more than it claims, even if an older group left a gap). `already_counted = c − moved`; its CHECK (> 0 or NULL) makes any arithmetic slip fail loudly instead of posting. An unlinked ticket moves its full claim as today.
- Any line with `already_counted > 0` gets `requires_review = true` and a note ("N already counted by job X / blend ticket(s)"). The short-stock flag only counts lines that moved something.
- Conversion, the ticket's unconvertible-unit refusal, the job's raw fallback and its flag, customer-supplied skip, holds, receipts and both legal records are unchanged. Ticket lines are always company stock (as today).
- Existing rows: cannot be backfilled (write-once ledger), so rows posted before this migration have no link and are not in any group. Production has no jobs or application records (2026-11-26) and old jobs are deleted before go-live (Mason D12), so no real group straddles the cutover. The migration prints a NOTICE with the count of jobs that already have both a job record and a linked ticket record (staging test data), and does not fail on them.

Files: one migration (two columns + index, re-emitted job body, ticket body and reversal, pre/postflight pins), changelog ledger record, rollback script, real-schema prover, `src/types/supabase.ts` columns. No screen change.

## Authority
Unchanged. Same roles, grants, wrappers and idempotency keys. New group helper: owner-only, EXECUTE revoked from PUBLIC/anon/authenticated/service_role. The new columns are written only by definer bodies (table INSERT already revoked from app roles). Nothing the screen sends is trusted beyond ids it already sends.

## State and failure
- Automatic change: the later posting moves less stock and flags the line. Authorized by Mason 2026-11-26 (A).
- Relink: no new rule. The existing header lock freezes a filed ticket's job; group membership is read at posting time, so an unfiled ticket moved between jobs counts toward the job it is on when filed.
- Reversal: takes the number lock first, then re-reads; refuses `APPLICATION_RECORD_COUNTED_WITH_JOB` for a ticket record whose job has its `job` record. Correction route there: an admin stock adjustment (existing). Unlinked tickets and open jobs reverse as today; after reversal the record is deleted, so its rows no longer join to a record and leave the group.
- Timing: the number lock serializes completion, filing and reversal; every group read is a new statement after it (READ COMMITTED, fresh snapshot). Lock order, no cycles: completion = job row, number lock, stock rows; filing = ticket row, number lock, stock rows; reversal = number lock, record and ledger rows, stock rows (never the ticket or job row). Retries return the saved receipt before any lock (unchanged wrappers).
- Rollback before first use: the rollback script restores the three old bodies and drops the trigger (columns stay, unused). After first use: forward fix only; the old reversal would refuse a zero row safely.

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
10. Reversal refused for a counted ticket; allowed for an unlinked one; reversed ticket leaves the group (job completed afterwards moves its full claim).
11. Migration applies over a database that already has an unlinked old pair, printing the NOTICE; immutability guard untouched.
12. After every case, independently: warehouse change from its opening balance equals the expected total, and equals ledger history. Grants: the group helper is not executable by API roles; wrappers' grants unchanged.

## Challenge (Astra gpt-6.2-astra high, 2026-11-26, 39 findings) disposition
- Fixed by the stored-claim design: 2, 3, 4, 5, 6, 7, 12, 23, 29, 39 (adopted), 30 (short flag only on moved lines).
- Fixed by locking order: 1 (reversal takes the number lock then re-checks), 13, 14 (`IS DISTINCT FROM`), 18 (all four paths: row lock, then number lock, then stock).
- Disproved: 22 (20270303110000 closes direct job writes); 21 (ledger writes revoked 20261027080000; `application_records` has a SELECT policy only); 27 (only `approved` passes `!=`; NULL makes the test NULL and the IF does not raise, but the screen never offers it: pre-existing, out of scope); 28 (wrappers not re-emitted; grants asserted in prover).
- Settled by Mason's decisions: 10, 11 (D1: a linked ticket is part of that job's spray; separate work is a separate job or unlinked), 8 (raw-fallback lines are already flagged for review), 9 (ticket lines are company stock, as today), 19/20 (refusal with the existing admin adjustment as the correction route; rare, admin-only).
- Accepted, pre-existing, out of scope (follow-ups): 15, 16, 17, 24, 25, 26, 31 (holds release at completion as today), 32 (two legal records, billing unchanged), 38 (indexed lookups per line; the lock is already shared).
- 33/34/35: rows from before the migration are outside the rule (cannot be backfilled; production has none; NOTICE counts staging ones); rollback split into before/after first use.

## Accepted limits (follow-ups, not this change)
- Wrong job link discovered after completion: the filed ticket cannot be moved; the office corrects stock with an adjustment (existing route). A proper "fix the link" route is a follow-up.
- A product whose inventory unit changes between the two postings compares claims in different units; rare, already flagged by both postings' review lines. Follow-up if units become editable on stocked products.
- Two legal application records (job and ticket) still exist for the same spray; billing unchanged. Follow-up.
- Rows posted before this migration have no link and stay outside the rule (write-once ledger; production has none).

## Challenge re-check (Astra, 12 findings) disposition
- 4 (a line could move more than it claims): fixed, `LEAST(c, …)` cap in both bodies. Hard ticket delete is not reachable from the app (no DELETE policy on `blend_tickets`).
- 5 (stale read after a lock wait), 11 (missing cases): prover adds two races (filing and reversal while a completion holds the lock), a multi-product ticket and an open-job move before filing. The relink guard trigger was dropped: building the prover showed the existing header lock already freezes a filed ticket's job (confirmed live).
- 6 (lock order): written out above.
- 7 (trigger cannot see records): moot, the relink trigger was removed (existing lock covers it).
- 10 (rounding): disproved, `quantity` and `quantity_available` are unconstrained numeric (live, 2026-11-26).
- 1, 3: accepted limits above. 2, 8, 9: moot (no backfill, no foreign key). 12: wording fixed ("rows posted before this migration").

## Open business decisions
None left (Mason answered A on 2026-11-26).
