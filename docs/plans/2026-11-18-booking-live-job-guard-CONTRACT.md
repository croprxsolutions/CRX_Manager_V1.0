# Behavior contract: the live-job booking rules hold for every write path (#1959)

Read at origin/staging 8646625b6 (2026-11-18). Follow-up to PR #1947 (Bookings Phase A, PR 1a).

## 1. Outcome and authority

**Business result.** A booking with a live spray job (a job on the booking or on one of its sections
that is not cancelled and not deleted) cannot be marked accepted, declined or expired, and its customer
cannot change, whatever path writes the booking. Today only `save_quote` enforces this (rules g and i in
`20270125110000_save_quote_keeps_section_ids.sql`). Established decisions: DECISION_LOG 2026-11-17
"Bookings with a spray job: section edits warn, accept/decline/expire blocked"; 2026-11-18 Mason accepted
Sol's three bypass findings on #1947 on the condition that this database guard follows.

**Paths that bypass save_quote today (facts):**
- The booking screen's Decline and Cancel buttons update `quotes.status` directly under RLS
  (`src/pages/QuoteBuilder.tsx` `setTerminalStatus`).
- `convert_quote_to_order` marks a sent booking accepted when it converts it, and only refuses bookings with
  draws (`20261027080400`), not a scheduled job with no draws yet.
- `auto_expire_quotes` (nightly) marks past-date sent/revised, undrawn, unplanned bookings expired
  (`20261029100000`), one UPDATE per booking inside one transaction.
- Any direct `UPDATE quotes SET customer_id` a client is allowed to make.

**Smallest change.** One new migration:
1. A `BEFORE UPDATE OF status, customer_id ON public.quotes` row trigger. It refuses, with the same
   `BOOKING_HAS_JOB` text `save_quote` uses:
   - status changing to accepted, declined or expired while a live job exists;
   - customer_id changing while a live job exists.
   Its function is `SECURITY DEFINER`, owned by postgres, `search_path = public, pg_temp`, no EXECUTE grant,
   so a rep whose RLS hides a job still gets the refusal.
   It also refuses `cancelled` (Mason, 2026-11-18). One exception (Mason, 2026-11-18, "Let it close"): `accepted`
   goes through once every booked product is fully drawn onto orders (`quote_product_draws`), which is how
   `draw_down_quote` closes a booking on its last draw (`20261029110000`); a booking with nothing booked does not
   count as drawn. Convert to Order refuses any booking with draws, so it cannot use this. `closed_by_application` and `closed_short` stay allowed:
   job-driven closures set them.
1b. The other side of the same rule (added after the Astra challenge): a `BEFORE INSERT OR UPDATE OF quote_id,
   quote_section_id, status, deleted_at ON public.jobs` row trigger. When a job becomes live on a booking (new,
   re-linked, un-cancelled or un-deleted), it locks that booking row `FOR SHARE` and refuses `BOOKING_CLOSED` if
   the booking is accepted, declined, expired, cancelled, closed_by_application or closed_short (the scheduler's
   own refusal list). Without it, a direct job insert or re-link could put a live job on a closed booking, and a
   job created while a decline was in flight could slip past both checks. Same function settings as item 1.
2. `auto_expire_quotes` re-emitted with one more filter: it skips a booking with a live job, so the trigger
   never fires inside the nightly batch and one booking cannot fail the whole run. Its rep gets the existing
   "Booking past its date" alert once per expiry date, with wording that names the spray job.
`save_quote` and `get_purchasing_plan` are not touched (open PR 1b re-emits them). Rule i in save_quote stays;
it fires first and gives the same message.

**Files:** `supabase/migrations/<stamp>_booking_live_job_guard.sql`, its ledger record, a smoke chain and a
real-schema prover under `scripts/smoke/`, this contract, DECISION_LOG.

**Who may act.** Unchanged: whoever may update a quote today. The trigger only removes outcomes.

## 2. State and failure

**Rules that always hold.** After any committed statement: no quote moved into accepted/declined/expired, and
no quote changed customer, while a live job pointed at it or its sections.

**Existing rows.** The trigger only fires on a change, so a quote already accepted/declined/expired with a live
job is left as it is; only a later customer change on it is refused. No row is rewritten.

**Timing.** Both orders serialize on the booking row. The quote trigger runs after the row is locked; the
scheduler locks the booking `FOR UPDATE` and the jobs trigger locks it `FOR SHARE`, so a job being created makes
a decline wait and then refuse, and a decline in flight makes a job insert wait and then refuse `BOOKING_CLOSED`.
Proven both ways (proof case 7). The app runs READ COMMITTED, so each check sees the other side's commit.

**Undo.** Cancelling the job lifts the block; nothing else changes.

## 3. Delivery

Database only. No screen change: the screen already shows a database message as written
(`src/lib/errorSanitizer.ts` passes it through). PR to `staging`.

## 4. Proof cases (real migrated database, prover container)

1. When a booking has a scheduled job and the screen's direct update sets status declined, then it is refused
   BOOKING_HAS_JOB naming the job; with the job cancelled, it goes through.
2. Same for accepted and expired set by a direct UPDATE.
3. When `convert_quote_to_order` converts a sent booking that has a scheduled job, then it is refused and
   nothing (order, status) is written.
4. When a direct UPDATE changes the customer of a booking with a live job, then it is refused; with no live job,
   it goes through.
5. When `auto_expire_quotes` runs with two past-date bookings, one with a live job, then the other expires and
   the one with the job stays sent; the run does not fail.
6. A completed or invoiced job blocks too; a cancelled or deleted job does not; a job on a section counts.
7. Concurrency, both orders: a job inserted under the booking lock while a decline arrives (decline waits, is
   refused, booking stays sent with one job); a decline held open while a job insert arrives (insert waits, is
   refused `BOOKING_CLOSED`, booking stays declined with no job).
8. Status changes not in the list (sent, revised, and edits that keep the status) still go through with a live job.
9. Every existing chain that writes jobs or quote statuses, converts or auto-expires (37 chains) ends exactly as
   before. Result 2026-11-18: 38 chains; 11 run end to end, the rest stop at their own fixture setup on the
   prover database, the same way before and after.
10. On an expired booking, a live job cannot be inserted (by quote or by section), re-linked to it, or
    un-deleted onto it (`BOOKING_CLOSED` naming the booking); a cancelled job can still be recorded, and an
    existing live job elsewhere can still move between its own statuses.
11. With a live job, a Partial Order of part of the booking keeps it sent; the Partial Order that draws the last
    booked unit closes it as accepted and the job stays live.

## Challenge (Astra, gpt-6-astra high, 2026-11-18): settled

- Fixed: the jobs-side gap (item 1b), races in both orders with final state asserted (case 7), the alert wording
  for a live-job booking, the rollback text.
- Refuted with evidence: `authenticated` holds UPDATE on `quotes.updated_at`; `jobs.status` is NOT NULL; the app
  runs READ COMMITTED; the migration applies as one transaction; sections are protected by save_quote rule c and
  the deferred section FK.
- Existing behavior, unchanged here: planned bookings (the only kind the scheduler makes jobs from) are never
  auto-expired, so the nightly skip covers jobs linked by other paths. Other auto-expire points Astra raised predate
  this change and are follow-ups: job-level draws not counted as draws, alert de-dup keyed by time not date, two
  concurrent runs able to double-alert, the alert going to the booking's creator, an alert insert failure rolling
  back the night, and `CURRENT_DATE` following the session time zone.
- Out of scope, follow-ups: soft-deleting a booking that has a live job (a Mason decision); a job's own customer
  following a booking customer change; save_quote wording (PR 1b re-emits save_quote).

## Business decisions (settled)

**Mason, 2026-11-18 (relayed from the Phase A session, his words: "yes to both"):** 1 = (a) skip and alert the
rep once; 2 = block Cancel too. Built that way.

1. **Nightly auto-expire and a booking with a live job.** Options: (a) skip it, and alert its rep once per
   expiry date with the existing "Booking past its date" notice; (b) skip it silently; (c) let the trigger refuse
   (one such booking would stop every expiry that night). Recommend (a): the booking stays open like a part-drawn
   one, and the rep is told. Consequence of (b): nobody notices a stale booking.
2. **Cancel.** The booking screen's Cancel button sets status `cancelled` directly; Mason's rule lists accepted,
   declined and expired only. Cancelling releases the booking's holds just as declining does, and a job cannot be
   scheduled from a cancelled booking. Recommend: block cancel too while a live job exists (same message).
   Consequence of not blocking: a job keeps running from a cancelled booking.
