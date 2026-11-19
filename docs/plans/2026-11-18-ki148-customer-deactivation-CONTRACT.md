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
| Invoice | `invoices.status IN ('posted','overdue')`, `deleted_at IS NULL` (today's rule, now for every role) | `_customer_has_open_invoice_20261013` |

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
`CUSTOMER_HAS_OPEN_WORK: nothing was deactivated. <farm name> still has <n open order(s), ...>. Finish or cancel its orders, deliveries and quotes, release its holds and settle or void its invoices first`.
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
   today), draft/sent/revised quote, posted invoice, overdue invoice. Several kinds name every count.
4. When the work is closed (order fulfilled/cancelled/voided/deleted, delivery completed/cancelled/
   voided, hold inactive or expired yesterday, quote declined/expired/cancelled/closed_*/accepted
   with its order or a deleted draft, invoice draft/unposted/paid/voided/cancelled), then deactivation succeeds.
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
