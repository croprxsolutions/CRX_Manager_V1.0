# F06 / KI-187 — one spray takes stock once (job vs linked blend ticket) — behavior contract

Read at `origin/staging` `c2a85624e` (2026-11-23). Issue #2178. Tracker row F06. Owner: Mason (field-app work), built by Claude.

## Facts (with source)

- Job completion (`_complete_job_replay_impl_20261015`, newest body `20261217100000` ~L480-960) locks the job row, sets it `completed`, inserts one `application_records` row (`source_type='job'`, `source_id=job`), then inserts one `job_applied` ledger row per non-customer-supplied chemical and lowers `inventory.quantity_available`. It never looks at blend tickets.
- "Create App Record" on a ticket (`_create_app_record_from_bt_replay_impl_20261015`, body `20260713060200`, wrapped in `20261016140000` ~L776) locks the ticket, refuses a second record for the same ticket, inserts one `application_records` row (`source_type='blend_ticket'`), then deducts each ticket product (`job_applied`). It never looks at `blend_tickets.job_id`.
- Those are the only two writers of `job_applied` today (search of `supabase/migrations/` for `'job_applied'`).
- `application_records.source_type` allows only `job` and `blend_ticket` (`20260214220000` L21).
- `reverse_application_record` (admin only, `20260713060500`) reverses only `blend_ticket` records: it puts the stock back and deletes the record. A job record cannot be reversed.
- A ticket is linked to a job by `blend_tickets.job_id`, written only through `save_blend_ticket` from Blend Ticket Detail. An existing trigger already guards that column (`blend_ticket_billed_keeps_job_20270129`: a billed ticket keeps its job).
- Production, read-only 2026-11-23: 0 blend tickets, 0 linked tickets, 0 ticket records, 1 job record, 0 jobs recorded both ways. Staging has the audit's doubled pair JOB-2026-0010 / BT-2026-0002 (synthetic).
- Precedent: #2063 (DECISION_LOG 2026-11-22) — when a job and its blend ticket could both bill, the first bill wins and the second is refused with plain words.

## Outcome and authority

**Rule:** for any one job, stock for the spray is taken either by the job's own completion record or by its linked tickets' records — never both. Whichever is recorded first wins; the second is refused and says why and what to do. No stock, record, invoice or job status changes on a refusal.

Smallest change: one new migration, no change to either big function (avoids colliding with open #2170, which rewrites job completion):

1. `BEFORE INSERT` trigger on `application_records`:
   - `blend_ticket` record whose ticket has a `job_id`: lock that job row (`FOR UPDATE`); refuse `BLEND_TICKET_JOB_ALREADY_RECORDED` if a `job` record exists for it.
   - `job` record: (job row is already locked by completion; lock again is harmless) refuse `JOB_BLEND_TICKET_ALREADY_RECORDED` if any ticket with `job_id` = this job has a `blend_ticket` record.
2. Extend link guarding with a new `BEFORE UPDATE OF job_id` trigger on `blend_tickets`: when the ticket has a record, refuse `BLEND_TICKET_RECORDED_KEEPS_JOB` if (a) it is being moved off a job or to another job, or (b) it is being linked to a job that already has a `job` record. Linking a recorded, unlinked ticket to a job that has no record yet is allowed (completion of that job will then be refused).
3. Plain-words messages for all three codes in `src/lib/errorSanitizer.ts`.

Who may act is unchanged: both RPCs keep their role checks; triggers only add refusals. Triggers run as the table owner inside the caller's transaction; they trust nothing the screen sends (they read ticket, job and records from the database).

## State and failure

- **No automatic record changes.** Refuse only.
- **Locking:** every check locks the job row first. Completion: job → (trigger) job. Ticket record: ticket → job. Link change: ticket (row update) → job. No path locks a ticket after a job, so no lock cycle. Under READ COMMITTED the check query after the lock sees the other side's committed record.
- **Two tickets on one job:** both may record (two loads); the job then cannot complete-with-stock.
- **Existing rows:** triggers fire only on new inserts/updates; the staging pair stays as is (synthetic). Production has none.
- **Retry:** a refused call writes nothing; the idempotency receipt is bound only after success, so a retry is refused again the same way.
- **Undo:** admin reverses the ticket record (stock back, record deleted) → job completion is then allowed. A job record can't be undone, so a ticket of a completed job stays refused.
- **Accepted gap (as KI-93):** a ticket never linked to its job (job number typed as text only) is invisible to the database.

## Delivery

One database PR to `staging` (migration + sanitizer messages + ledger + docs). The screens already show RPC errors through the sanitizer; no screen depends on new database shape.

## Proof cases (disposable Postgres prover, real migrations)

1. Linked ticket, job completed first → Create App Record refused `BLEND_TICKET_JOB_ALREADY_RECORDED`; ledger and on-hand unchanged.
2. Linked ticket recorded first → job completion refused `JOB_BLEND_TICKET_ALREADY_RECORDED`; job stays `in_progress`; ledger unchanged.
3. Case 2, then admin reverses the ticket record → completion succeeds; exactly one set of `job_applied` rows net.
4. Recorded ticket: unlink or move to another job → refused; unrecorded ticket can still move.
5. Recorded unlinked ticket linked to a completed job → refused; to an uncompleted job → allowed.
6. Unlinked ticket and unrelated job → both record and deduct as today.
7. Two sessions at once (ticket record vs job completion, same job) → one succeeds, the other refused; no deadlock.
8. Staging browser check: the refusal reads in plain words on Blend Ticket Detail.

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-23): FINDINGS 61

The draft "first record wins" design does not converge. Settled so far:
- DEFECT 1 (BLOCKER): complete the job, unlink the unrecorded ticket, record the ticket: two deductions. Any design must stop a ticket leaving a job that already recorded.
- DEFECT 15: trigger functions run as the caller; RLS can hide the conflicting row. The guard functions must be `SECURITY DEFINER`, owned by postgres, `search_path = public, pg_temp`, EXECUTE revoked.
- DEFECT 27: lock the job in its own statement, then check in a later statement (fresh READ COMMITTED snapshot).
- DEFECT 24: the link guard returns at once when `job_id` did not change (ordinary saves name the column).
- DEFECT 5: a ticket record with no stock lines must not count as "took the stock".
- DECISIONs 3, 4, 6-11: which record owns the stock decides field closeout, quantities, grower-supplied products, lots and weather on the logbook record, holds and invoicing. Sent to Mason as one combined question below.
The rest are re-checked against the design Mason picks (full output kept outside the repo, in the session scratchpad).

## Open business decisions

1. **When a spray job has a blend ticket linked to it, which one takes the chemicals out of stock?**
   - **(A, recommended) The job.** Closing the job in the field always works and takes the stock, as today. "Create App Record" on a ticket linked to a job is refused ("completing the job records this spray"). A ticket cannot leave a job once the job is completed, and a ticket that already has its own record cannot be linked to a job. The ticket stays the blend paperwork and its billing source (#2063). Consequence: stock comes out at the job's chemical amounts, not the ticket's measured amounts; the ticket's lot numbers are not copied onto the spray record; a ticket linked to the wrong completed job needs an admin to fix by hand (production has no tickets yet).
   - **(B) The ticket.** The job still closes but takes no stock when a linked ticket was recorded. Consequence: rewrites job completion (collides with open #2170), larger review, and the spray record must say which ticket took the stock.
   - **(C) Whichever is recorded first.** Consequence: if the office records the ticket first, the applicator cannot close the job in the field until an admin undoes the ticket record.
