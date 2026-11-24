# Behavior contract: loads and stock

**Master copy (2026-11-24).** Newest answers only; earlier drafts are in git history. Design: `SPEC.md` stage 4. Cases: `SCENARIOS.md` S11–S15, S18, S19 (S16 and S17 are proved in the review-checks PR). Order and gates: `BUILD-PLAN.md`.

## Facts (checked in code at `origin/staging` `b3e7c85e8`)

- Stock for a job leaves today in `complete_job` → `_complete_job_replay_impl_20261015`; newest wrapper and trigger in `20270227170000_job_completion_missing_stock_rows.sql` (staging only, not live). It deducts **planned** `job_chemicals.quantity` from `Main Warehouse`, skips `customer_supplied`, allows short stock with `inventory_transactions.requires_review = true`, and writes the ledger row with `job_id`.
- Lock order today: the job row, then the application-record number advisory lock, then stock rows (existing in product order, then each missing row created at zero and locked in product order). `trg_zz_lock_job_stock_rows` also locks the job's stock rows on the status change.
- The job's whole hold is released by `_sync_job_holds` through the jobs lifecycle trigger. `inventory_holds` is Taha's table until 2026-12-15.
- KI-187 (open, HIGH): a blend ticket's application record and the linked job's completion can each take the same stock. Production has no blend tickets.
- Applicator access to jobs follows PR #1650: access ends with the job.
- No load table or RPC exists.
- **Check read-only before building:** which body of `complete_job`, its wrapper and triggers production and staging really run; the full trigger chain on `jobs` status changes; the stock-location key. The build follows what is deployed.

## Decisions this rests on

Stock leaves once, at load confirmation, from the confirmed amounts [D1]. Customer's own / already paid product takes no company stock [Sol 34]. Short stock saves, goes below zero and flags the office [Sol 32]. Each load keeps its own mix [Sol 4/5]. The mixer can change a load's mix; that flags office review [Q2]. Leftover gallons on a load show as carried in on the rig's next load [GR2]. The tablet stays signed in and the mixer picks their name; if that account is late, mixers use their own logins [GR4, 2026-11-24]. No extra crew steps; flags, not blocks. Holds are released whole when the job closes, as today (partial release per load is spring, 2026-11-24).

## 1. Outcome and authority

- **Result:** the mixer confirms a load (one rig, one tank, one or more jobs); CRX records what went in and takes that stock once. Jobs on the batch path never take stock at completion.
- **Stock path per job:** `at_completion` (today) or `batch`, set when the job is created (`batch` once the batch switch is on; every existing job stays `at_completion`) and never changed. Every stock writer reads it: load confirmation refuses `at_completion` jobs; completion and blend tickets take no stock for `batch` jobs.
- **Records** (RLS in the same migration; office reads all; applicators and the mixer read only jobs they may work under the #1650 policies; no direct writes, RPCs only):
  - `field_loads`: load id (made by the screen before confirming, unique), rig, mixed-by person, confirmed by (signed-in account), confirmed at, finished and water gallons, **leftover gallons and where it went** (`ran_dry`, `carried`, `to_tote`), status, current revision.
  - `field_load_jobs`: which jobs the load serves.
  - `field_load_revisions`: one row per confirm, add or correction (who, when, reason, kind), each with its products: product, per-acre rate, amount in the product's stock unit, customer-supplied (copied from the job's product line, never from the screen), supplying customer, substitute-for.
  - Ledger rows in `inventory_transactions` point to the load and revision.
- **RPCs** (`SECURITY DEFINER`, `SET search_path = public, pg_temp`, `p_idempotency_key` required, granted to `authenticated`, roles checked inside): `confirm_field_load`, `add_to_field_load` (product really added later: new revision, its own stock row), `correct_field_load` (typo fix: new revision with difference rows and a reason; names the revision it corrects), `record_field_load_leftover` (ran dry, gallons carried to the rig's next load, or gallons to a tote).
- **Who may act:** confirm, add and leftover: admin, any active applicator (a mixer without the tablet account signs in with their own applicator login and picks the job), the mixer account. Correct: the same people while no work entry links to the load; after that admin only. Sales reps and customers are refused. The mixed-by name must be on the active mixer and applicator list; both the name and the signed-in account are kept.
- **Locators only:** the server checks each job is open and on the `batch` path, products exist, amounts are positive in the stock unit, no product twice; it derives customer-supplied, the actor, the time and the ledger rows.

## 2. State and failure

- A confirm or add writes one stock-out row per company product from the job's warehouse (Main Warehouse today). A correction moves stock by the difference between revisions. Load, revision, products and ledger rows save in one transaction. The ledger is never edited.
- **Short stock:** saves, goes below zero, `requires_review`, the office sees it (S12).
- **Mix changes:** saved on that load's revision; the job's recipe stays; the next load's proposal starts from the job's latest mix; the job is flagged; a substitute with no price is flagged.
- **Leftover (S15):** recorded on the load as a number. The next load proposed for that rig shows those gallons as carried in and proposes that much less; no stock moves for carried gallons; the source load counts them as carried, not used. Unusable leftover is recorded as to a tote and handled outside CRX.
- **Mixed, used, billed:** used = mixed − carried − to tote. The review screen shows mixed, used and billed (S17).
- **Corrections downstream:** a correction to a load whose work is already on an invoice flags those invoices; nothing else changes by itself.
- **Timing:** the same key again returns the saved result before any state check (bound to operation, user and request; same key with a different request refused). The same load id from two tablets: the second gets the first's result. Lock order for every load RPC: the load's job rows in id order, then stock rows as `complete_job` does, so a load and a completion queue instead of deadlocking. Two corrections from the same revision: the second is refused ("someone else changed this load").
- **Load confirmed twice by mistake:** an admin corrects it to zero with a reason (a reversing stock row; linked work moves to the real load first).
- **Rained out after mixing (M4):** the job ends with nothing billed; the load and its stock movement stay; its contents are carried or to a tote.
- **Rollback:** turning the batch switch off stops new jobs getting the `batch` path; existing `batch` jobs keep it and their loads.

## 3. Delivery

One database PR (tables, RPCs, stock path on jobs, `complete_job` and blend-ticket changes, ledger rows), compatible with the deployed app; the batch switch stays off until the mixer screen is live on staging. The mixer screen merges after that PR is live on staging.

## 4. Proof cases (two-session SQL tests as the real roles, on a database migrated to the staging schema; never production)

1. S11: one confirm, one stock row; same key again returns it; same key with different amounts refused; null key refused.
2. Two sessions confirm the same load id: one load, one stock movement.
3. S12 short stock; a receipt brings it positive; the flag stays.
4. Customer-supplied product (from the job line, not the request) writes no stock row; a request marking company stock as customer-supplied is ignored.
5. S13 substitution; S14 add vs correct; two corrections from the same revision: second refused; correction after a work entry by an applicator refused, by admin allowed.
6. S15 leftover recorded on L1 shows as carried in on the rig's next proposal; no stock row for it.
7. S18 stock paths: old-path job refuses a load and completes as before (same rows as the unchanged function on the same data); batch-path job completes with no stock rows and no missing stock rows created.
8. S19 blend ticket before and after a load on a batch-path job: no stock.
9. A load and a completion on the same job, and on different jobs sharing products in opposite orders: no deadlock, consistent result.
10. Roles: sales rep, customer, an inactive applicator: refused; any active applicator, the mixer account and admin: allowed.

## Spring (agreed, not February)

Partial hold release per load (needs Taha's review of `inventory_holds`; until then holds release whole at job close); leftover tracked as a claim used once by one load, with flags when the carried mix differs from the receiving job's recipe or customer (`field_load_carry`); a "possible duplicate load" flag (same rig and jobs within 30 minutes); tender, sprayer and tote balances. **Cost of waiting:** a held product stays held until the job closes, so a long job can show less available than is really on the shelf; leftover carried to a different job's recipe is caught only by the office's mix-differs review.
