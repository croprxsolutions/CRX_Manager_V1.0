# KI-148 — Deactivating a customer checks open work — behavior contract

Read at `origin/staging` a93fb9e85 (2026-11-18). Live read-only checks the same day.

## 1. Outcome and authority

**Outcome.** No one (admin, rep, the server roles) can switch a customer from active to inactive
while it still has open work. "Open work" is:

| Kind | Counted when | Source |
|---|---|---|
| Order | `orders.status IN ('confirmed','partially_fulfilled')`, `deleted_at IS NULL` | registry `orders.status` |
| Delivery | `deliveries.status IN ('scheduled','in_progress')`, `deleted_at IS NULL`, on the customer's row **or** on one of its orders | registry `deliveries.status` |
| Hold | `inventory_holds.is_active` and not expired (`expires_at` null or ≥ today, Chicago), any hold type | live table; every hold writer sets `customer_id`; the purchasing plan never counts an expired hold |
| Quote | `quotes.status IN ('draft','sent','revised')`, `deleted_at IS NULL`, or `accepted` with no undeleted order (`orders.quote_id`), the purchasing plan's rule (Sol r2, r3). A converted quote's open part is its order | `QUOTE_TO_DELIVERY.md` lines 13, 64 |
| Invoice | `invoices.status IN ('draft','unposted','posted','overdue')`, `deleted_at IS NULL` (draft and unposted added by Mason, 2026-11-19, on Taha's review: they still bill) | registry `invoices.status` |
| Spray job | `jobs.status IN ('scheduled','in_progress')`, or `completed` with no `invoice_id` (not yet billed; `invoiced` is billed), `deleted_at IS NULL` (Mason, 2026-11-19) | registry `jobs.status` |
| Return | `returns.status IN ('approved','received')` (waiting for its credit), `deleted_at IS NULL` (Mason, 2026-11-19) | registry `returns.status` |
| Prepay | `customers.prepay_balance_cents <> 0` (Mason, 2026-11-19: the prepay runs skip inactive customers) | live column |

Not blocking (Mason, 2026-11-19): a farm-group parent with active children; a return still `requested`.
Why the 2026-11-19 additions: finance charges and the prepay apply/reconcile runs read only active
customers, so unbilled work or unapplied prepay on an inactive customer would leave those runs.
(Corrected for issue #2000, Sol r5: statements are not among them. The AR Aging statement picker
searches every customer, inactive included, `ARagingStatement.paging.test.tsx`.)

**Decisions it carries out.**
- To-Do decision 20 (admins skip the open-invoice check): answered in the task brief from the parent
  session for Mason, 2026-11-18: "for every role. Admins are included." So admins are refused too,
  for invoices as well (the Customers list already refused admins on invoices; the edit page did not).
- To-Do decision 23 (the inactive customer with 2 confirmed orders): leave it as it is. No data change.

**Smallest change.** One new migration adds a second BEFORE trigger on `customers`,
`customers_open_work_on_deactivate_20270128` (`BEFORE UPDATE OF is_active`; the name sorts after the
rep guard, so a rep's forbidden edit keeps its own error). Its function
`guard_customer_deactivation_open_work_20270128` is `SECURITY DEFINER`, owner `postgres`,
`search_path = public, pg_temp`, EXECUTE revoked from everyone (a trigger function needs no grant to
fire; the existing guard has the same ACL). It acts only when `OLD.is_active IS TRUE AND NEW.is_active
IS NOT TRUE`, counts each kind with owner rights, and refuses with
`CUSTOMER_HAS_OPEN_WORK: nothing was deactivated. <farm name> still has <n open order(s), ...>. Finish or cancel that work, bill it, credit its returns and use up or refund its prepay first`.
The existing rep guard `guard_customer_rep_edit_20261013` is **not** re-emitted; its rep-only invoice
check stays (a rep with open invoices still sees `CUSTOMER_HAS_OPEN_INVOICES` first).

Why not edit the existing guard: it is SECURITY INVOKER on purpose (its prepay rule tests
`current_user = 'authenticated'`), and it returns early for admins.

**Paths covered** (all write `customers.is_active` through UPDATE, so the trigger sees them all):
Customers bulk Deactivate (direct update), customer edit page (`save_customer`), direct API. (Bulk
Customer Import only inserts new customers, active, so it never deactivates.) No live function sets customers inactive (live `pg_proc` search, 2026-11-18); no other
customers trigger changes `is_active`. `customers.is_active` is `NOT NULL DEFAULT true` (live).
Reactivating and every other edit of an already-inactive customer are untouched.

**Screen.** `Customers.tsx` is unchanged: it keeps its invoice pre-check (so a new screen never meets
an old database with less protection), then the update reaches the trigger. `errorSanitizer.ts`
passes the `CUSTOMER_HAS_OPEN_WORK` sentence through (edit page and list both use it). The bulk update
is one statement, so one refused customer refuses the whole batch; the message says nothing was
deactivated and names the first blocked customer met.

**Who sees the counts.** Only admins and sales reps may update customers (live policy
`customers_update`: `is_admin() OR is_sales_rep()`), and both read every customer's work
(`20261013220000_reps_work_any_customer`), so naming counts reveals nothing new. Invoices are named
without a count; a rep who cannot read another rep's posted invoice already gets the rep guard's
open-invoice refusal first, so that existing disclosure is unchanged (Sol r2 LOW).

Files: the migration, `docs/reference/migrations.d/<stem>.md`, `docs/changelog.d/…`,
`scripts/smoke/prove-ki148-customer-deactivation-real-schema.mjs`, `src/lib/errorSanitizer.ts`
(+ test), `docs/manual/KNOWN_ISSUES.md`, `docs/manual/TO_DO_LIST.md`, this contract.

## 2. State and failure

- **Rule (going forward):** a customer that becomes inactive has no open work visible at that moment.
  Existing inactive customers are not re-checked.
- **Existing rows.** Live: 3 inactive customers. Read-only check with the exact five predicates
  (orders, deliveries, holds, quotes, invoices): (0,0,0,0,0), (0,0,0,0,0), (2,0,0,0,0). The third stays
  as is (decision 23) and stays editable; finishing its two orders is today's situation, out of scope.
- **Already-deployed app during rollout:** unchanged screen; its error shows through `sanitizeError`
  (a generic message until the new sanitizer ships). No break.
- **Timing.** Double click / retry: a refused deactivation changes nothing and a repeat is refused
  again; a repeated success is inactive→inactive and not checked. **Concurrency:** all five kinds are counted in one
  statement, so one snapshot (Sol r1: separate queries could see different moments). The guard takes no
  row locks. Waiting for in-flight work with `FOR UPDATE` (rounds 1-3) drew deadlocks with payments,
  billing and delivery work (Sol r2, r3); **Mason chose 2026-11-19 to remove the lock** and accept the
  point-in-time gap. **Remaining limit (Mason accepted 2026-11-18 and 2026-11-19):** work created or
  reopened by a transaction not yet committed when the check runs, and work added after the
  deactivation, are not caught. Closing that fully means "an inactive customer can never get open work": a guard on five tables that
  would also stop the legacy customer's two orders from being delivered. That is a separate business
  decision, raised to Mason as a follow-up. No idempotency key: this is a trigger, not an RPC.
  Indexes on `customer_id` exist for all five tables.
- **Undo.** Reactivate as today; nothing is recorded by the guard.

## 3. Delivery

One PR to `staging`. The screen does not change and calls nothing new. The staging DB job applies the
migration after merge; production follows the release flow (migration applied before merge).

## 4. Proof cases (real-schema prover, disposable PostgreSQL, synthetic rows)

1. When an admin deactivates an active customer with one open order, then refused
   `CUSTOMER_HAS_OPEN_WORK` naming 1 open order; the row stays active.
2. Same for a sales rep, for a direct update as `postgres`, and as `service_role`: refused.
3. Each kind alone refuses: part-filled order, scheduled delivery, in-progress delivery, a delivery
   whose row names another customer but whose order is this one, active hold (also one expiring
   today), draft/sent/revised quote, draft/unposted/posted/overdue invoice, scheduled/in-progress job,
   completed job with no invoice, approved/received return, prepay balance. Several kinds name every count.
4. When the work is closed (order fulfilled/cancelled/voided/deleted, delivery completed/cancelled/
   voided, hold inactive or expired yesterday, quote declined/expired/cancelled/closed_*/accepted
   with its order or a deleted draft, invoice paid/voided/cancelled or deleted, job cancelled/invoiced/completed
   with an invoice or deleted, return requested/credited/rejected/cancelled or deleted, zero prepay), then deactivation succeeds.
5. Bulk: one statement deactivating two customers, one blocked → refused, both stay active.
6. An inactive customer with open orders can still be edited by an admin and a rep, and reactivated;
   deactivating it again is checked.
7. RLS cannot hide work: SECURITY DEFINER, owner postgres (postflight-checked); only admins and reps
   reach it and both see all customer work.
8. Before the migration, case 1 succeeds (fail-first); after it, refused. A second apply is refused by
   the preflight (`KI148_PREFLIGHT`).
9. Screen: the sanitizer unit test proves the sentence; on staging after the DB job applies the
   migration, the Customers page bulk Deactivate shows it and leaves the customer active.

## Cold challenge (Astra `gpt-6.2-astra` high, 2026-11-18, 45 findings): how it was settled

- Race and later reopen (1–7): kept as the stated point-in-time limit; the stronger rule is a business
  choice raised to Mason as a follow-up. No server function deactivates customers, so no
  in-transaction ordering case exists.
- Accepted quotes (5, 8–11, 16): dropped from "open" (conversion sets `accepted`); Sol r2 then
  brought back an accepted quote with no order, matching the purchasing plan.
- Expired holds (15): not counted. Delivery ownership (13): counted by row or by order.
- Invoice helper role gate (20): not used; the predicate is inline for every role.
- Error precedence (21): trigger named to fire after the rep guard. Disclosure (22): refuted (policy facts).
- Rollout and rollback (38, 40): screen pre-check kept, so the screen never weakens.
- Re-run (41): preflight refuses. Null state (25): column is NOT NULL. Indexes (44): present.
- Proof matrix gaps (10, 18, 42): added to cases 2–4.
- Bulk partial update through RLS, retry wording, undo of a mistaken bulk deactivation (29, 30, 36):
  existing behavior, unchanged by this fix.

## Open business decisions

None blocking. Decisions 20 and 23 are answered (above). Follow-up for Mason (not built here): should
an inactive customer be refused any *new* order, quote, delivery or hold, closing the race?
Recommendation: not now; it would also block finishing the legacy customer's two orders (decision 23).

## Follow-up (issue #2000), 2026-11-19

Read at `origin/staging` 62ccaeaa2. Migration `20270129170000_customer_deactivation_open_work_followups.sql`
re-emits only the guard function (same owner, mode, search_path, ACL, trigger; still one snapshot, no
locks). Its preflight requires the exact `20270128140000` body (md5, carriage returns ignored), so it never
overwrites a different later version. Both migrations ship in the same release (neither is live), so no
deactivation lands between them.

| Change | Rule | Source |
|---|---|---|
| Split payers | An order counts for every customer named in `order_shares` for it or in `order_item_shares` for one of its lines, as well as its owner; so do its undelivered deliveries. Being named is enough (the CHECK keeps every share above 0%). Deliberately the stricter side: a payer whose line share overrides the order share, or whose own line already shipped, still blocks until the order closes | registry `order_shares`, `order_item_shares` |
| Hold | `is_active = true` (the partial index's form) and `quantity > 0`; one Chicago date per check | `idx_inventory_holds_customer`; registry |
| Wording | "open or unbilled spray job(s)"; a farm name over 60 characters shows its first 59 and "…" | Taha; Sol r4, r5 |

Which spray jobs count is unchanged from `20270128140000` (scheduled, in progress, or completed with no
`invoice_id`).

Not done here (Taha owns quotes, bookings, invoices, billing, prepay and credits until 2026-12-15):
prepay recorded as credits with a zero cached total; a fully applied credit memo still `posted`; showing
a rep only the invoices that rep can see; the voided-then-deleted order that reopens an accepted quote
(the purchasing plan's quote rule); a completed field-allocated delivery whose split invoices are not
made yet. Also moved there after Sol's 2026-11-19 review (round 1, five HIGH findings), because each needs
the billing rule for who is billed for a spray job or blend ticket: field-split job owners (a job's payers
also come from field billing defaults with no `job_field_shares` row), approved unbilled blend tickets (a
ticket's grower can be billed by split through field billing), and when a completed job counts as billed
(split invoices where one is cancelled, jobs with several tickets, a stale `invoiced` status, a job billed
through its blend ticket). A first version that guessed these rules was built, cold-challenged and
withdrawn.

Proof cases (prover phase 2, `KI148_FOLLOWUP_PROOF_PASS`; each refused case is a customer with only that
blocker): before the follow-up, a split payer of an open order, of an order line and of an undelivered
delivery all deactivate, and an active hold for zero blocks; after it, each split payer is refused (admin,
rep, service_role), every phase-1 kind is still refused by the replacement body (jobs with the new
wording), and an active zero hold and a share of a cancelled order do not block (admin and rep). A
108-character farm name appears as 59 characters plus "…". A second apply is refused. The prover waits
out the 10 minutes before Chicago midnight so its "expires today" hold keeps its day (Sol r4).

**Cold challenge (Astra `gpt-6.2-astra` high, 2026-11-19, 36 findings) on the first, wider version.**
Kept from it: one Chicago date per check (#27), exact name cut (#22), rollback text that can run (#29),
exact-predecessor preflight and a marker instead of a wording check (#31), isolated proof cases (#35).
#12 (0% shares) is settled by the CHECK. The job, ticket and field-share findings (#1–#11) left with that
scope. Timing (#24–#26) stays the accepted point-in-time limit. Disclosure (#19–#20): reps read every
customer's orders (`20261013220000_reps_work_any_customer`), and the counts name no other customer.
Rollout (#30): both migrations land in one release. Legacy rows (#18): inactive customers are never
re-checked, by design. Cost (#34): the trigger runs only when a customer is deactivated. Runner (#32):
the release apply runs the file as one transaction, which the prover mirrors (`psql -1`).

Open business decision (unchanged, for Mason): should an inactive customer refuse any new work?
