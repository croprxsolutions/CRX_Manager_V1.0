# Inactive customer refuses new work (#2000) — behavior contract

Read at `origin/staging` c0b544a23 (2026-11-19). Live read-only checks the same day.

## 1. Outcome and authority

**Decision carried out.** Mason, 2026-11-19 (issue #2000): an inactive customer must be made
active again before any new work is done for them. This also closes the split-second gap the KI-148
deactivation check accepted (`2026-11-18-ki148-customer-deactivation-CONTRACT.md` §2 Timing).

**In scope:** orders, deliveries, inventory holds, spray jobs (`jobs`).
**Deferred (Taha's quote, invoice and booking work until 2026-12-15):** quotes, invoices, bookings and
their payer rules (split payers, field billing defaults, blend tickets). A quote, invoice or booking
can still be created for an inactive customer until that work lands; where such a flow itself writes
an order, hold or job row, this guard refuses that row.

**Rule.** A row of `orders`, `deliveries`, `inventory_holds` or `jobs` may not *become open work* for a
customer whose `customers.is_active` is false. "Becomes open work" means:

| Table | Refused when | "Open" (same as KI-148) |
|---|---|---|
| orders | any INSERT; an UPDATE where (the row is open afterwards and was not open before) or its `customer_id` changed (open or closed) | `status IN ('confirmed','partially_fulfilled')`, `deleted_at IS NULL` |
| deliveries | any INSERT; an UPDATE where (open afterwards and not before) or its `customer_id` or `order_id` changed | `status IN ('scheduled','in_progress')`, `deleted_at IS NULL` |
| inventory_holds (every hold, any type or source; Mason 2026-11-19) | any INSERT; an UPDATE where (open afterwards and not before, counting a dated expiry pushed later or cleared as "not before") or its `customer_id` changed | `is_active` and not expired (`expires_at` null or ≥ today, Chicago) |
| jobs | any INSERT; an UPDATE where (open afterwards and not before) or its `customer_id` changed | `status IN ('scheduled','in_progress')`, or `completed` with no `invoice_id`; `deleted_at IS NULL` |

The customer checked is the row's `customer_id`; for a delivery also its order's `customer_id`
(KI-148 counts a delivery by either). Moving any row, open or closed, onto an inactive customer is
refused (Astra #12: else a delivery could be added to a closed order while it is moved). Moves are
admin or sales rep only for signed-in users (`WORK_CUSTOMER_MOVE_NOT_ALLOWED`). A null
`customer_id` is not checked: only `inventory_holds.customer_id` is nullable, and live it is null only
on 20 switched-off manual holds with no source (2026-11-19). A hold with a source (built from a job or
quote) must name its customer: CHECK `inventory_holds_source_needs_customer`.

INSERT is refused whatever its status: a new row for an inactive customer is new work by definition
(this includes a bulk import of a closed order; reactivate first). Closing, cancelling, voiding,
deleting, releasing, editing an already-open row, and every change that leaves a row closed stay
allowed, so existing work of an inactive customer can still be finished down or cleaned up.

**Smallest change.** One new migration: one trigger function
`guard_inactive_customer_new_work_20270129()` (SECURITY DEFINER, owner postgres,
`search_path = public, pg_temp`, EXECUTE revoked from everyone, like the KI-148 guard) and four
`AFTER INSERT OR UPDATE ... FOR EACH ROW` triggers named `zz_inactive_customer_new_work_20270129`
(AFTER, so every BEFORE trigger and the row-level policy check run first; Sol r1 #1). It reuses the existing
pattern of `guard_inactive_manual_hold` / `guard_order_reopen_inactive_product` (inactive product:
`SELECT ... FOR SHARE`, refuse with a code). Files: the migration, `docs/reference/migrations.d/<stem>.md`,
`docs/changelog.d/…`, `scripts/smoke/prove-inactive-customer-new-work-real-schema.mjs`,
`src/lib/errorSanitizer.ts` (+ test), `docs/manual/KNOWN_ISSUES.md` (KI-148 note), this contract.

**Who.** Every role and path (admin, rep, driver, applicator, `service_role`, `postgres`, every RPC
and direct write). The guard reads `customers` with owner rights, so RLS cannot hide the flag.

**Locator values.** The guard derives everything from the row and `customers`; the screen sends nothing new.

**Refusal.** A fixed sentence: `CUSTOMER_INACTIVE_NEW_WORK: nothing was saved. This customer is
inactive. An admin or sales rep must reactivate the customer before new orders, deliveries, stock
holds or spray jobs are added`. It names no customer: row-level policy checks run after BEFORE
triggers, and a delivery's order may belong to a customer the caller cannot read (Astra #25), and
only admins and reps can reactivate (Astra #30). `errorSanitizer.ts` maps the code to the same
fixed text. A preflight refuses the migration unless KI-148's guard is installed (Astra #47).

## 2. State and failure

- **Rule that always holds (with KI-148):** an inactive customer never gains open orders,
  deliveries, holds or jobs. Together with KI-148's deactivation check it means a customer only goes
  inactive with none, and stays that way, except legacy rows (below).
- **Closing the gap (locking).** Before checking, the guard takes `SELECT is_active FROM customers
  WHERE id = … FOR SHARE`. `FOR SHARE` conflicts with the row lock a deactivation UPDATE holds, so:
  (a) deactivation first: the work write waits, then re-reads the committed row (READ COMMITTED takes
  a new snapshot per statement in a volatile function) and is refused; (b) work first: the
  deactivation UPDATE waits for the work transaction to commit, then KI-148's BEFORE trigger counts
  with a fresh snapshot and sees the new work, and refuses. The already-present FK lock
  (`FOR KEY SHARE`) does not conflict with a non-key UPDATE, which is why the guard adds `FOR SHARE`.
  For a delivery both customers are locked in id order.
  - Deadlock check (live `pg_proc`, 2026-11-19): no function that inserts into the four tables
    updates `customers` (prepay, payment, save_customer and rep-assignment functions are the only
    `UPDATE customers` writers, and none creates work). So two work transactions sharing the
    customer's `FOR SHARE` lock never both upgrade it. A transaction that creates work for several
    customers while a bulk deactivation locks them in another order can still deadlock; Postgres
    aborts one with an error and nothing is half-saved. Rare (two admin bulk actions at once); accepted.
  - Cost: other customer edits (prepay, save_customer) wait for in-flight work transactions on the
    same customer to commit; these are short.
- **Existing rows (live, 2026-11-19).** 3 inactive customers. Orders/deliveries/holds/jobs:
  (0,0,0,0), (0,0,0,0), (2 confirmed orders,0,0,0). The two confirmed orders stay as they are
  (To-Do decision 23, no data change) and stay editable, cancellable and part-fillable. **Delivering
  them needs a new delivery row, so the customer must be reactivated first** (Mason's 2026-11-19
  rule; the KI-148 contract named this exact consequence when it raised the question).
  Query: `select … from customers where is_active = false` with per-table counts (run 2026-11-19).
- **Already-deployed app during rollout.** No screen change is required: a refusal reaches the
  screen as an error; the old sanitizer shows its generic message until the new one ships.
- **Timing.** Double click / retry: a refused write saves nothing; a retry is refused again. RPC
  idempotency keys are untouched (a trigger raises inside the RPC's transaction, so the key is not
  stored). Reactivate then retry works.
- **Undo.** Nothing is recorded by the guard. Reactivating the customer lifts it.

- **Isolation.** The guarantee holds for READ COMMITTED (every app path: PostgREST and RPCs). A
  REPEATABLE READ deactivation would count from its older snapshot (Astra #14); none exists.
- **Scope of the closed gap.** Only the four kinds here. Quotes, invoices, returns and prepay keep
  KI-148's point-in-time limit until Taha's work (Astra #10).

## 3. Delivery

One PR to `staging`, draft until release #1990 lands. Screens call nothing new; the only frontend
change is the sanitizer sentence, which is safe before or after the migration.

## 4. Proof cases (real-schema prover, disposable PostgreSQL, synthetic rows)

1. When an admin inserts an order / delivery / hold / job for an inactive customer, then refused
   `CUSTOMER_INACTIVE_NEW_WORK`, nothing saved. Same as `postgres`, `service_role` and a sales rep.
   A closed new row (fulfilled order, cancelled job) is refused too.
2. When an UPDATE reopens a closed row of an inactive customer (order cancelled→confirmed, delivery
   cancelled→scheduled where transitions allow, hold inactive→active, expired hold extended, job
   cancelled→scheduled, soft-deleted delivery or job undeleted), then refused. Restoring a deleted order is already
   refused by `refuse_deleted_order_status_change`, so that route does not exist.
3. When an UPDATE moves a row (customer_id, or a delivery's order_id) onto an inactive
   customer, open or closed, then refused.
4. When an inactive customer's existing open order is edited, part-filled, cancelled or deleted, or
   its hold released, then allowed.
5. When the same writes target an active customer, then allowed (no regression); after
   reactivation the refused insert succeeds.
6. A delivery whose own `customer_id` is active but whose order's customer is inactive is refused.
7. Locking: session A deactivates and holds its transaction; session B inserts an order → B waits,
   then is refused after A commits. Reverse: B inserts and holds; A's deactivation waits, then is
   refused `CUSTOMER_HAS_OPEN_WORK` after B commits. A deactivation that rolls back lets the
   waiting order through.
8. Fail-first: before the migration case 1 succeeds; after, refused. Second apply refused by preflight.
9. Sanitizer unit test shows the sentence.

## Cold challenge (Astra `gpt-6.2-astra` high, 2026-11-19, 55 findings): how it was settled

- **Changed the design:** #12 (closed-order move race) → any move onto an inactive customer is
  refused; #25, #30, #31, #53 (disclosure, dead-end wording, raw text) → fixed sentence, no farm
  name; #47 → preflight requires KI-148; #8 → rule parenthesised; #10, #14 → limits stated above.
- **Population evidence (live, 2026-11-19), settling #1, #2, #3, #4, #5, #9, #11, #36, #39, #42:**
  inactive customers have 0 quotes, 0 holds, 0 jobs, 0 deliveries; only one has open work (2
  confirmed orders, To-Do decision 23). Going forward KI-148 refuses deactivation while any of these
  four kinds is open, and this guard refuses creating them, so "growing existing open work" or an
  internal hold rebuild for an inactive customer can only touch that one legacy customer, whose
  orders stay as they are by decision 23. A quote or booking hold for an inactive customer is
  refused at the reservation step (Mason, 2026-11-19, Sol r1 #5); named in the PR for Taha. No `INSERT INTO inventory_holds … ON CONFLICT` writer
  exists live (#36). Voiding or deleting an invoice clears `jobs.invoice_id`
  (`_void_invoice_split_provenance_impl_20260719`, `_delete_invoices_split_provenance_impl_20260719`,
  `_transfer_invoice_to_job_replay_impl_20261015`), reopening a completed job: for an inactive
  customer that is refused, which matches the rule (unbilled work for an inactive customer is what
  KI-148 forbids); reactivate first (#9).
- **Refuted by schema:** #6, #13, #22 (`orders/deliveries/jobs.customer_id`, `deliveries.order_id`
  and `customers.is_active` are NOT NULL; all four have FKs to customers); #20 (the lock query locks
  every id, active or not, then reads); #21 (one Chicago date per call, `expires_at` is a date).
- **Proof cases added:** #15, #16, #40, #43, #44 → race in both orders plus a rolled-back
  deactivation, two sessions, timed waits; reopen by undelete, hold on, expiry pushed out; closed
  order moved; delivery with either customer inactive. #26, #27: driver and applicator cannot insert
  these rows directly; the trigger does not depend on the role, proved as admin, rep, postgres and
  service_role.
- **Accepted, with reason:** #17, #18, #19 (no work-creating function updates customers; the contact
  sync trigger fires on contact edits, which work saves do not make; a rare deadlock aborts one
  side with nothing half-saved); #23, #24 (KI-148's own behaviour, unchanged here); #28 (other
  guards may answer first, which is fine); #29, #32, #50 (no screen change; the refusal surfaces
  through the existing error path, generic text on an old client); #34, #35, #37, #38 (a trigger
  error aborts the caller's transaction as every other refusal does; retries behave as for any
  refusal); #33 (postflight checks owner, SECURITY DEFINER, search_path and grants; same as KI-148);
  #41 (query: per-table counts for `customers.is_active = false`, run 2026-11-19); #46, #49 (the
  migration and its rollback exist now); #48, #51 (one transactional migration; postflight checks all
  four triggers); #52 (deferral owner: Taha, by 2026-12-15, issue #2000); #54 (covered by #12 fix);
  #55 (see the population evidence).

## Sol round 1 settlement (2026-11-19)

- #1 HIGH (disclosure: a BEFORE trigger ran ahead of the row-level policy check) → AFTER triggers;
  a driver adding a job gets the same permission error for an active and an inactive customer (proved).
- #2 HIGH (order moved under a new delivery) → the delivery's order is locked FOR SHARE before its
  customer is read; race 4 proves the move waits, then the lineage guard refuses it. Deadlock check:
  `create_delivery_with_items` already locks the order FOR UPDATE; quick delivery creates its own
  order; follow-up delivery never updates the order.
- #3 MED (customer row not visible) → refused unless every named customer is found and locked.
- #4 MED (REPEATABLE READ) → accepted, as before (no app path uses it).
- #5 MED (job start rebuilds its holds) → **business decision, Mason 2026-11-19: "Refuse all
  holds".** Three tries at an exception for job-built holds each drew a new Luna HIGH (a type-only,
  a source-only, then a same-customer-job rule), so per the round cap the exception was dropped and
  Mason chose: every new or reopened hold for an inactive customer is refused, any type or source.
  Starting an inactive customer's old spray job that reserves stock, and a quote or booking
  reservation, need the customer reactivated first. Cost today: none (live 2026-11-19: no inactive
  customer has a spray job, quote or hold; KI-148 stops deactivating a customer with open jobs).
  Named for Taha in the PR.
- Luna r5 MED (multi-customer deadlock with a bulk deactivation in another order) → accepted, as
  in #17-#19: Postgres aborts one side with nothing half-saved and the user retries. Luna r5 LOWs →
  the "already installed" check looks only at the four tables; the permission proof covers the
  applicator as well as the driver.
- Luna r4 LOW (race proof used a fixed delay) → each race now checks the first session is asleep
  holding its locks before the second starts.
- Luna r3 LOW (prover rolls back "allowed" writes) → refuted: AFTER ROW triggers fire at the end of
  each statement, before the rollback, so a statement that succeeds has passed the guard; the race
  cases commit and count the saved rows. This also
  takes quote holds out of scope (Taha's).
- #6 MED → preflight also requires KI-148's trigger attached and enabled.
- #7 MED → triggers added orders, deliveries, jobs, then inventory_holds.
- #8 LOW → the rollback race checks the first session too.
- #9 LOW → New Delivery shows the error through `sanitizeError`.

## Sol round 2 settlement (2026-11-19)

- #1 HIGH (a driver changes an assigned delivery's customer to learn whether another customer is
  active) → moving any order, delivery, hold or job to another customer or order is refused for
  anyone signed in who is not an admin or sales rep (`WORK_CUSTOMER_MOVE_NOT_ALLOWED`), before the
  customer is looked at, so the answer is the same for an active and an inactive customer (proved
  with the driver's own in-progress delivery). No screen lets a non-admin move work today; the only
  live writer that moves a customer (`_save_job_cost_step2_impl`) is admin/rep only.
- #2 MED (pushing a dated hold's expiry later, across midnight) → pushing an expiry later or
  clearing it counts as opening the hold, so it is refused for an inactive customer (proved).
- #3 MED (KNOWN_ISSUES omitted the REPEATABLE READ limit) → KI-148's note now names it.
- #4 MED (adding lines to a legacy confirmed order) → accepted: decision 23 keeps existing orders
  editable, and order lines are outside the four tables.
- #5 MED (voiding a completed delivery reopens its order, which is then refused) → accepted:
  correcting closed history that reopens a row needs the customer reactivated first (documented in
  the migration header and changelog).
- #6 MED (creating the triggers can deadlock with a delivery being completed) → accepted: live paths
  write orders and deliveries in both orders, so no trigger order avoids it. Apply at a quiet time;
  lock_timeout bounds the wait; a deadlock aborts one transaction whole.
- #7 LOW (New Delivery could show an empty error) → falls back to "Failed to create delivery".

- Luna r6 HIGH (a hold with no customer skips the check) and r7 HIGH (an open customer-less hold
  gains a source without a move) → after the Luna round cap, a fresh simplicity review replaced the
  trigger branch with one CHECK constraint: `inventory_holds_source_needs_customer` (`source_id IS
  NULL OR customer_id IS NOT NULL`), on every write path. Jobs and quotes require a customer and
  every builder copies it; live 2026-11-19: 0 violating rows. A manual hold with no source and no
  customer (20 live, none active) belongs to no customer and stays allowed. No source lookup, so
  the round-capped exemption mechanism is not revived. The same review merged the two customer
  reads into one locked count.
- Accepted LOW (simplicity review R1): definer code or a server role could save a hold whose
  customer differs from its source job's customer; the guard checks the hold's own customer, which
  is what KI-148 counts. Every live builder copies the job's or quote's customer.
- Luna r7 MED (service_role can move work) → refuted: the move rule stops signed-in non-staff from
  learning a customer's status (Sol r2 #1). Server roles bypass row-level security already, see
  everything, and are not signed-in users; every move they make still gets the inactive-customer
  check (proved as service_role for inserts). The changelog now says "for signed-in users".

## Sol round 3 settlement (2026-11-19)

- #1 HIGH (a hold names an active customer but its source is an inactive customer's job or quote)
  → **accepted by Mason, 2026-11-19** ("this case cannot happen in our business"; DECISION_LOG).
- #2 MED (REPEATABLE READ) → accepted, as in Sol r1 #4 (no app path uses it).
- #3 MED (a driver reopens a delivery whose order belongs to a customer they cannot see) → reopening
  a delivery is admin or sales rep only for signed-in users, with the same fixed refusal as a move.
  No function reopens a delivery (grep 2026-11-19); proved for undelete. Completed → in progress is
  already refused by the older delivery state machine for everyone but an admin override (proved).
- #4 MED (the hold constraint blocks a customer delete that clears a released hold's customer) →
  the constraint applies to active holds only; switching a customer-less sourced hold back on is
  still refused (proved). The app never hard-deletes customers.
- #5 MED (cancelling one of a legacy inactive customer's two jobs on a booking rebuilds the other's
  hold) → refuted: live 2026-11-19, no inactive customer has any spray job, and KI-148 refuses
  deactivating a customer with open jobs, so such a pair cannot arise. Reactivate first if it did.
- #6 MED (raising an open hold's quantity) → counts as opening (proved; lowering stays allowed).
- #7 MED (applying outside a transaction) → refuted: `scripts/apply-migration-file.mjs` wraps the
  file in one transaction, and the prover applies it with `-1`.
- #8 LOW → the preflight also requires KI-148's trigger to have no WHEN clause.
- #9 LOW → each race waits (up to 10 s) for the first session to be inside `pg_sleep`.
- #10 LOW → the hold RPC proof commits, so deferred checks run.
- #11 LOW → the screen matches the constraint error itself, not the name anywhere in a message.

## Open business decisions

None. The scope (four tables), the legacy customer's consequence and the deferred parts follow
Mason's 2026-11-19 decision and the task brief.
