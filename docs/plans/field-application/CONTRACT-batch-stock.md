# Behavior contract: batches and stock (wave items 1.3 and 3.4)

**Status: DRAFT, Sol round 1 folded in (2026-11-24).** Follows `.claude/commands/plan-contract.md`. Design source: `SPEC.md` stage 4 and sections 9b/9c. Cases: `SCENARIOS.md` S11–S19. Read at `origin/staging` `b3e7c85e8`. Sol finding numbers are in `SOL-KIT-REVIEW.md`.

## Facts (with sources)

- Stock for a job leaves today in `complete_job` → `_complete_job_replay_impl_20261015`. The newest wrapper and trigger are in `20270227170000_job_completion_missing_stock_rows.sql` (staging only, not applied live). It deducts **planned** `job_chemicals.quantity` from the `Main Warehouse` row, skips `customer_supplied`, allows short stock with `inventory_transactions.requires_review = true`, and writes the ledger row with `job_id`.
- Lock order today: the job row, then the application-record number advisory lock, then stock rows: existing rows in product order first, then each missing row created at zero (`ON CONFLICT DO NOTHING`) and locked, in product order (same file; delivery completion does the same, #1942). A trigger (`trg_zz_lock_job_stock_rows`) also locks the job's stock rows on the status change.
- The job's whole hold is released by `_sync_job_holds` through the jobs lifecycle trigger. `inventory_holds` is Taha's table until 2026-12-15.
- KI-187 (open, HIGH): a blend ticket's application record and the linked job's completion can each take the same stock. Production has no blend tickets.
- Applicator access to jobs follows PR #1650 (merged 2026-11-09): access ends with the job.
- No batch table or RPC exists (GAP-CHECK row 27).
- **UNVERIFIED, must be checked read-only before 1.3 is designed in code:** which body of `complete_job`, its wrapper and triggers production and staging run; the full trigger chain on `jobs` status changes; the stock-location key. The build follows what is really deployed (Sol 026).

## Decisions this rests on

Stock leaves once, at batch confirmation, from the confirmed amounts [D1]. Grower-supplied and "already paid" product takes no company stock [Sol 34]. Short stock saves, goes below zero and flags the office [Sol 32]. Only the used part of the hold is released [Sol 49]. Each load keeps its own mix [Sol 4/5]. The mixer can change a load's mix; that flags office review [Q2]. Leftover carries into the rig's next batch [GR2]. The tablet stays signed in and the mixer picks their name [GR4]. No extra crew steps; flags, not blocks (2026-11-24).

## 1. Outcome and authority

- **Result:** the mixer confirms a load (one rig, one tank, serving one or more jobs); CRX records what went in and takes that stock once. Jobs on the batch path never take stock at completion.
- **Stock path per job (Sol 021):** each job has a stock path, `at_completion` (today) or `batch`, set when the job is created: `batch` once the batch switch is on, `at_completion` for every job that already exists. It is fixed at creation and never changes, so earlier paper loads on an old job are always deducted at completion (Sol r2 021). Every stock writer reads it: batch confirmation refuses `at_completion` jobs; completion and blend tickets take no stock for `batch` jobs.
- **Records (Sol 045, 133):** RLS in the same migration; office reads all; applicators and the tablet read only jobs they may work under the #1650 policies; nobody writes directly; RPCs only.
  - `field_loads`: load id (made by the screen before confirming, unique), rig, mixed-by person, confirmed by (signed-in account), confirmed at, finished and water gallons, status, current revision.
  - `field_load_jobs`: which jobs the load serves.
  - `field_load_revisions`: one row per confirm, add or correction (who, when, reason, kind), each with its products: product, per-acre rate, amount in the product's stock unit, customer-supplied (copied from the job's product line, never from the screen), supplying customer, substitute-for.
  - `field_load_carry`: a carry-out from a load (finished gallons, composition, status `open`, `claimed`, `to_tote`), and the load that claimed it.
  - Ledger rows in `inventory_transactions` point to the load and revision.
- **RPCs** (all `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `p_idempotency_key text` **required** for new writes (null refused), granted to `authenticated`, roles checked inside):
  - `confirm_field_load` (new load), `add_to_field_load` (product really added later: new revision, its own stock row), `correct_field_load` (typo fix: new revision with delta stock rows and a reason; must name the revision it corrects, `p_expected_revision`), `record_field_load_leftover` (ran dry, gallons left as a carry-out, or gallons to a tote).
- **Who may act (Sol 031):** confirm, add and leftover: admin, active applicators on the job, the mixer tablet account (wave 2.2). Correct: the same people while no work entry links to the load; after that, admin only. Sales reps and customers are refused for all. The mixed-by name must be on the active mixer and applicator list; both the name and the signed-in account are kept.
- **Locators only:** job ids, product ids, amounts, rig, load id, mixed-by person. The server checks each job is open and on the `batch` path, products exist, amounts are positive in the product's stock unit, no product appears twice, and derives customer-supplied, the actor, the time, the ledger rows and the hold release.

## 2. State and failure

- **Automatic record changes:** a confirm or add writes one stock-out row per company product (Main Warehouse) and, from item 3.4 (after 2026-12-15, Taha's review), reduces holds: the load's product use is shared across its jobs by each job's planned need, each job's release capped at its own held amount, released only for the product actually used (Sol 034). A correction moves stock and holds by the difference between revisions (Sol 035, 041). Authorized by D1 and Sol 49.
- **One transaction:** load, revision, products, ledger rows and hold changes save together or not at all. The ledger is never edited.
- **Short stock:** saves, goes below zero, `requires_review` on the row, the office sees it (S12).
- **Mix changes:** saved on that load's revision; the job's original recipe stays; the next load's proposal starts from the job's latest mix (Sol 033); the job is flagged; a substitute with no price is flagged.
- **Carry-out and carry-in (Sol 036–039):** the leftover is recorded on the source load (`record_field_load_leftover`). A batch claims an open carry-out for its rig under a row lock; a carry-out is claimed once. No stock moves for carried-in gallons. The source job counts it as moved, not used. A carried-in mix whose products differ from the receiving job's recipe, or customer-supplied product from a different customer, flags the receiving job. A carry-out never claimed by the time the source job closes is shown on the review screen; the office records it as carried or to a tote (no new step for a clean job).
- **Mixed, used, billed (Sol 040):** used = mixed − carried out − to tote. The review screen shows mixed, used and billed separately (S17).
- **Possible duplicate load (Sol 028):** a second load for the same rig and jobs within 30 minutes is flagged, not blocked.
- **Corrections downstream (Sol 043):** a correction to a load whose work or carry-out is already on a draft or posted invoice flags those invoices and the receiving loads; nothing else changes by itself.
- **Timing (Sol 024, 025, 027, 042):**
  - Same key again: returns the saved result before any state check, so a retry after the job closed still gets its receipt. The key is bound to the operation, the user and the request; the same key with a different request is refused.
  - Same load id from two tablets: unique; the second gets the first's result.
  - Lock order for every load RPC: the load's job rows in id order, then stock rows as `complete_job` does (existing in product order, then missing ones created and locked in product order). Completion takes the job row first too, so a load and a completion on the same job queue instead of deadlocking.
  - Two corrections at once: the second names an old revision and is refused ("someone else changed this load").
- **Duplicate load (Sol r2 145):** a load confirmed twice by mistake is reversed by an admin correction to zero with a reason (stock returns by a reversing row; linked work moves to the real load first).
- **Rollback (Sol 044):** turning the switch off stops new jobs from getting the `batch` path; existing `batch` jobs stay on it and keep their loads. Nothing is dropped.

## 3. Delivery

- **1.3**: one database PR (tables, RPCs, stock path on jobs, `complete_job` and blend-ticket changes, ledger record), compatible with the deployed app (the switch is off until 2.4 and 2.2 are live on staging).
- **3.4** (after 2026-12-15, Taha reviews): partial hold release. Required before February: without it, holds for batch jobs are released only at completion.
- The mixer screen (2.4) merges only after 1.3 and 2.2 are live on staging.

## 4. Proof cases (two-session SQL tests as the real roles, on a database migrated to the staging schema; never production)

1. S11: one confirm, one stock row; same key again returns it; same key with different amounts refused; null key refused.
2. Two sessions confirm the same load id: one load, one stock movement.
3. S12 short stock; then a receipt brings it positive; the flag stays.
4. Customer-supplied product (from the job line, not the request) writes no stock row; a request marking company X as customer-supplied is ignored.
5. S13 substitution; S14 add vs correct; two corrections from the same revision: second refused; correction after a work entry by an applicator: refused; by admin: allowed.
6. S15 carry-out claimed once under two concurrent claims; flags for a different recipe and a different supplying customer.
7. S18 stock paths: old-path job refuses a load and completes as before (same rows as the unchanged function on the same data); batch-path job completes with no stock rows and no missing stock rows created.
8. S19 blend ticket before and after a load on a batch-path job: no stock.
9. A load and a completion on the same job, and a load and a completion on different jobs sharing products in opposite orders: no deadlock, consistent result.
10. Roles: sales rep, customer, an applicator not on the job: refused; applicator on the job and admin: allowed. The tablet account case is proven in 2.2, which creates that role (Sol r2 151).
11. 3.4: a load serving two jobs with 58 gal held each releases 58 gal in total, shared by planned need; a substitution releases no X hold; a correction moves the hold by the difference.

## Open business decisions

- **M4** answered 2026-11-24: a rained-out job after mixing ends with nothing billed; the load stays mixed and its contents are carried or put in a tote; no stock returns.
