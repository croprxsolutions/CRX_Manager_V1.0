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

## Outcome and authority (Mason, 2026-11-23: "The job (A)")

**Rule:** when a spray job has a blend ticket linked to it, the **job** takes the chemicals out of stock (its completion records the spray, as today). The linked ticket never takes them a second time. Every refusal says why and what to do; no stock, record, invoice or job status changes on a refusal.

Smallest change: one new migration (`20270225200000_f06_job_owns_linked_blend_stock.sql`), no change to either posting function (avoids colliding with open #2170, which rewrites job completion):

1. `BEFORE INSERT` trigger on `application_records` (definer function):
   - `blend_ticket` record whose ticket (locked `FOR UPDATE`) has a `job_id` → refuse `BLEND_TICKET_JOB_RECORDS`.
   - `job` record: lock the job row, then (next statement) refuse `JOB_BLEND_TICKET_ALREADY_RECORDED` if a ticket linked to this job has its own record. Only old rows can reach this; the link rules stop new ones.
2. `BEFORE UPDATE OF job_id` trigger on `blend_tickets` (definer function), returning at once when `job_id` did not change:
   - linking a ticket that has its own record → refuse `BLEND_TICKET_RECORDED_NO_JOB`;
   - moving or unlinking a ticket whose old job is already recorded (old job locked first) → refuse `BLEND_TICKET_COMPLETED_JOB_KEEPS_TICKET`.
3. Plain-words messages for all four codes in `src/lib/errorSanitizer.ts` (server sentence shown after "Nothing was saved.").

Who may act is unchanged: both RPCs keep their role checks; triggers only add refusals. `application_records` has only a SELECT policy (checked live, read-only), so only the definer posting functions insert it; the link is guarded on the table because office users update `blend_tickets` directly. Guard functions are `SECURITY DEFINER`, owned by postgres, `search_path = public, pg_temp`, EXECUTE revoked from every app role; the postflight pins this.

## State and failure

- **No automatic record changes.** Refuse only.
- **Locking:** ticket path locks only the ticket; job path locks only the job; a link change holds the ticket row, then locks the old job. Nothing locks a ticket after a job, so no lock cycle. Each check runs in its own statement after its lock, so under READ COMMITTED it sees the other side's committed record.
- **Two tickets on one job:** neither records on its own; the job's completion takes the stock once.
- **Existing rows:** triggers fire only on new inserts/updates. Production has no blend tickets (read-only check, 2026-11-23); staging keeps its synthetic doubled pair.
- **Retry:** a refused call writes nothing; the idempotency receipt is bound only after success, so a retry is refused again the same way.
- **Undo for an old doubled pair:** an admin reverses the ticket record (stock back), then the job completes.
- **Accepted gap (as KI-93):** a ticket never linked to its job, or unlinked before the job completed, is invisible to the database.
- **Consequences Mason accepted with (A):** stock comes out at the job's chemical amounts, not the ticket's measured amounts; ticket lot numbers are not copied onto the spray record; a ticket linked to the wrong completed job needs an admin to fix by hand.

## Delivery

One database PR to `staging` (migration + sanitizer messages + ledger + docs). The screens already show RPC errors through the sanitizer; no screen depends on new database shape. Re-run the prover after #2170 merges (it redefines job completion).

## Proof cases (`scripts/smoke/prove-f06-job-owns-linked-blend-stock-real-schema.mjs`)

0. Before the candidate: linked job and ticket both deduct (the bug).
1. Linked ticket, job completed first → Create App Record refused; on-hand unchanged.
2. Linked ticket, record before the job completes → refused; the job then completes and takes the stock once.
3. Legacy pair (ticket recorded, then linked) → completion refused; status, stock, ledger, records unchanged; after an admin reverses the ticket, completion nets one deduction.
4. Completed job: unlink or move its ticket → refused; an edit that keeps the job saves; before completion the link can still change.
5. Recorded ticket → linking refused; unrelated ticket and job each record as before.
6. The internal ticket-record body is guarded too (trigger on the table).
7. Two-session races: completion vs unlink (unlink waits on the lock, then refused); record vs link (link refused).
8. Mutation: drop the link guard → the unlink goes through. Rollback script restores the old behaviour.
9. Staging browser check after merge: the refusal reads in plain words on Blend Ticket Detail.

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-23): FINDINGS 61

The first-wins design did not converge. Settled and carried into design A:
- DEFECT 1 (BLOCKER, unlink-then-record double): fixed by `BLEND_TICKET_COMPLETED_JOB_KEEPS_TICKET` (case 4, race A, mutation).
- DEFECT 15: guard functions are definer functions (postflight).
- DEFECT 27: lock and check are separate statements.
- DEFECT 24: no-change return when `job_id` is unchanged.
- DEFECT 5: not applicable (a linked ticket never records under A).
- Findings 17-18 disproved: `application_records` has only a SELECT policy (live, read-only).
- DECISIONs 3, 4, 6-11: answered by Mason's (A) below.
Full output kept outside the repo, in the session scratchpad.

## Business decisions

1. **When a spray job has a blend ticket linked to it, which one takes the chemicals out of stock?** Mason, 2026-11-23: **(A) the job.** (Rejected: (B) the ticket, which rewrites job completion; (C) whichever is recorded first, which can block the applicator from closing the job.)
