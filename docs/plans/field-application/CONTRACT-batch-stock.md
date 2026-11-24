# Behavior contract: loads and stock

**Master copy (2026-11-24).** Newest answers only; earlier drafts are in git history. Design: `SPEC.md` stage 4. Cases: `SCENARIOS.md` S11–S15, S17–S19, S35 (S16 is proved in the review-checks PR). Grants, retry keys and rollout: `CONTRACT-who-pays.md` › Rules for every package. Order and gates: `BUILD-PLAN.md`.

## Facts (checked in code at `origin/staging`; re-check read-only before building)

- Stock for a job leaves today in `complete_job` → `_complete_job_replay_impl_20261015`; newest wrapper and trigger in `20270227170000_job_completion_missing_stock_rows.sql` (merged and applied on staging, not live; slice 0 confirms). It deducts **planned** `job_chemicals.quantity` from `Main Warehouse`, skips `customer_supplied`, allows short stock with `inventory_transactions.requires_review = true`, and writes the ledger row with `job_id`.
- Lock order today: the job row, then the application-record number advisory lock, then stock rows (existing in product order, then each missing row created at zero and locked in product order). `trg_zz_lock_job_stock_rows` also locks the job's stock rows on the status change to `completed`.
- The job's whole hold is released by `_sync_job_holds` through the jobs lifecycle trigger on `completed`/`cancelled`. `inventory_holds` and `_sync_job_holds` are Taha's until 2026-12-15; this PR does not change them.
- `job_chemicals` has `customer_supplied` (boolean) and `vendor` (free text). `vendors` exists.
- KI-187 (open, HIGH): a blend ticket's application record and the linked job's completion can each take the same stock. Production has no blend tickets.
- Applicator access to jobs follows PR #1650 (`20261217100000`): only jobs where they are `jobs.applicator_id` or dispatched; it ends 7 days after `completed_at`.
- No load table or RPC exists.
- **Check read-only before building:** which body of `complete_job`, its wrapper and triggers production and staging run; the full trigger chain on `jobs` status changes; the stock-location key. The build follows what is deployed. The PR's proof runs on two baselines: staging as it is, and production plus every pending staging migration in release order.

## Decisions this rests on

Stock leaves once, at load confirmation, from the confirmed amounts [D1]. A vendor-sourced line takes no CRX stock [2026-11-24 h]. Short stock saves, goes below zero and flags the office [Sol 32]. Each load keeps its own mix [Sol 4/5]. The mixer can change a load's mix; that flags office review [Q2]. Leftover gallons on a load show as carried in on the rig's next load [GR2]. Jobs with no tablet load use the same load record, entered by whoever loaded it or the office [2026-11-24 j]. No extra crew steps; flags, not blocks. Holds are released whole when the job closes, as today.

## 1. Outcome and authority

- **Result:** a load (one rig, one tank, one or more jobs) is confirmed; CRX records what went in and takes that stock once. Jobs on the batch path never take stock at completion.
- **Stock path per job:** `jobs.stock_path` = `at_completion` (today) or `batch`, set when the job is created by **every** creation route (`save_job`, quote-to-job, booking-to-job): `batch` while `app_settings` `field_batch_stock_enabled` is on, else `at_completion`; never changed. Every stock writer reads it: load confirmation refuses `at_completion` jobs; `complete_job`'s body **and** its stock triggers take no stock for `batch` jobs (status still moves to `completed`, so the hold trigger releases the hold once, as today); blend tickets take no stock for `batch` jobs; a direct status write is guarded the same way.
- **Product source:** `job_chemicals.source_vendor_id` (null = CRX stock; else a `vendors` row) replaces `customer_supplied` for batch-path jobs; `customer_supplied` stays for old-path jobs only.
- **Records** (RLS per the shared matrix; no direct writes):
  - `field_loads`: load id (made by the screen before confirming, unique), rig, mixed-by name, confirmed by (signed-in account), confirmed at, finished and water gallons, `carried_in_from_load_id` and `carried_in_gallons` (set at confirmation), leftover gallons and where it went (one of `ran_dry`, `carried`, `to_tote`, or `none`, which only a load with no water may use), status, current revision.
  - `field_load_jobs`: which jobs the load serves.
  - `field_load_revisions`: one row per confirm, add or correction (who, when, reason, kind, the revision it corrects), each holding the load's **full contents** after it, meaning what CRX put in (confirm, adds, corrections); carried-in gallons are kept only on the load (`carried_in_*`), never inside a revision: product, per-acre rate, amount in the product's stock unit, the job product line it comes from, sourced from (read from that line; an unplanned add names no line and is CRX stock), stock location (warehouse: defaults to the line's warehouse; the mixer may pick another active one), substitute-for. The same product may appear twice only with a different source or stock location.
  - Ledger rows in `inventory_transactions` point to the load and revision: the **signed difference** from the previous revision per product and stock location, at the location stored on the input row. `job_id` is set only for a single-job load; job reports read `field_job_usage` (review-checks PR), not the ledger.
- **RPCs** (`p_idempotency_key` required): `confirm_field_load`, `add_to_field_load`, `correct_field_load` (typo fix with a reason; names the revision it corrects; may set an amount to 0; an admin may also move linked work to another load in the same call), `record_field_load_leftover` (ran dry, gallons carried, gallons to a tote, none; allowed on a load whose jobs have ended or closed, until they are invoiced; a leftover larger than the tank held is saved and flagged), and the read function `get_mixable_jobs()` (open batch-path jobs, with acres left shown as the proposal, not used as a filter; their latest mix and the rig's last load; mixer access without widening job RLS).
- **Who may act:** confirm, add and leftover: admin, sales rep (entering a load for a no-tablet job), any active applicator (a mixer without the tablet account signs in with their own applicator login), and the mix-site account (an applicator-role account). The mixer works any open batch-path job (the mix site serves every rig); every job on a shared load is checked. Correct: the same people while no work entry links to the load; after that admin only. Driver, entity_recipient, anon and inactive users are refused. The mixed-by name must be an active `ground_crew_members` name or active applicator profile; the name is stored as text with the profile id, so it survives later roster changes.
- **Locators only:** the server checks each job is open (leftover excepted, above) and on the `batch` path, products exist, each named job product line belongs to a job on the load, the stock location is an active warehouse, amounts are positive in the stock unit (a correction may be 0); it derives the source (from the named line), actor, time and ledger rows. Amounts convert from the rate unit to the stock unit through the product's unit and `unit_conversions`; a missing conversion is never guessed: the entered amount and unit are saved with a flag and no stock row, and the office's correction adds the stock row once a conversion exists.

## 2. State and failure

- Load, revision, inputs and ledger rows save in one transaction. The ledger is never edited.
- **Short stock:** saves, goes below zero, `requires_review`, the office sees it (S12).
- **Mix changes:** saved on that load's revision; the job's recipe stays; the next load's proposal starts from the job's latest mix; the job is flagged; a substitute with no price is flagged. Jobs group on one load when their latest mix (products and per-acre rates) matches; a difference shows as a flag.
- **Carry-in (S15):** at confirmation, under a lock on the rig's row, the server reads the rig's last confirmed load; if its leftover is `carried` and not yet taken, the new load records it as carried in. Only one load takes it; a second gets 0 and a flag. The confirm screen shows the source load's mix. The carried amount of each product = carried gallons × that product's amount **in the source load's whole tank** (its final revision contents plus what it carried in itself, so X carried L1 → L2 still reaches L3 when L2 adds only Y) ÷ the source load's finished gallons (whole-tank average; a water top-up is a note, so it is an estimate and labelled so). No stock moves for carried gallons.
- **Used:** per load and product, used = final contents + carried in − carried out − to tote, never below 0 (an impossible leftover is flagged, not billed as a credit). A load shared by jobs splits its used amount across them by acres sprayed (Q11). Billing and the 5% check read this through `field_job_usage`.
- **Work links:** each work-entry segment names the load revision that was in the tank; a correction never relinks it; the legal record reads the corrected amounts of that revision. Billing uses the load's used amount, so revision links never change money.
- **Corrections downstream:** a correction to a load whose work is on a draft or posted invoice flags those invoices; nothing else changes by itself.
- **Timing:** all load mutations and work-segment attachment take the load row lock and send the revision they read; an older one is refused ("someone else changed this load"). The same key from the same actor with the same request returns the saved result; the same load id or key with a different request is refused. Lock order for every load RPC: the rig row (confirm only), the load's job rows in id order, the load row (a save touching several loads locks them in load id order), then stock keys through one helper that inserts any missing (warehouse, product) row with `ON CONFLICT DO NOTHING` and locks each key in one global (warehouse, product id) order; `complete_job`, `trg_zz_lock_job_stock_rows` and every other stock-locking trigger, and receiving use the same helper, so they queue instead of deadlocking (the race proof runs through the deployed entry points). Cancel, confirm and end take the same job-row lock.
- **Load confirmed twice by mistake:** an admin corrects it to zero with a reason, moving its linked work to the real load in the same call (reversing stock rows; affected invoices flagged).
- **Rained out after mixing (M4):** the job ends (`completed`, nothing billed); the load and its stock movement stay; its leftover can still be recorded after the end.
- **Rollback:** turning `field_batch_stock_enabled` off stops new jobs getting the `batch` path; existing `batch` jobs keep it, their loads, and close without stock at completion. An `at_completion` job is never billed in CRX: it is finished and billed in Chem Man (`CONTRACT-field-billing.md` B14).
- **Closing:** from the work-entries PR on, `complete_job` refuses a batch-path job; the office close (and the rained-out end) is its only route to `completed`, so no batch job skips review or the legal record.

## 3. Delivery

One database PR in slice 2 (tables, RPCs, `jobs.stock_path` on every creation route, `job_chemicals.source_vendor_id`, `complete_job`/trigger and blend-ticket changes, ledger rows), compatible with the deployed app, built on top of `20270227170000` (which releases first, slice 0). Its quote-to-job and booking-to-job changes are Taha's areas: after 2026-12-15, with his review. `field_batch_stock_enabled` stays off until the mixer screen, the phone's work entries and the office close are live on staging; turning it on in production is in the slice 2 Mason batch.

## 4. Proof cases (two-session SQL tests as the real roles, on a database migrated to the staging schema; never production)

In this PR (admin, sales rep, applicator, inactive applicator, driver, entity_recipient, anon):
1. S11: one confirm, one stock row; same key again returns it; same key or load id with different amounts refused; null key refused.
2. Two sessions confirm the same load id: one load, one stock movement.
3. S12 short stock; a receipt brings it positive; the flag stays.
4. A vendor-sourced line (from the job line, not the request) writes no stock row; a request marking a CRX-stock line as vendor-sourced is ignored.
5. S13 substitution; S14 add (full contents 61, delta row 3) vs correct (full contents 55, reversing 3, names revision 1); two corrections from the same revision: second refused; correction to zero by admin.
6. S15: carry-in recorded on the rig's next load; two loads racing for one carry: one gets it, the other 0 and a flag; no stock row for it.
7. S18 stock paths from every creation route: old-path job refuses a load and completes as before (same rows as the unchanged function on the same data); batch-path job completes with no stock rows and no missing stock rows created; its hold releases once on close, on rained-out end and on a retried close.
8. S19 blend ticket before and after a load on a batch-path job: no stock.
9. A load and a completion on the same job, and on different jobs sharing products in opposite orders, with a missing stock row: no deadlock, consistent result.
10. Two jobs from different warehouses on one load: each input leaves its own warehouse; a correction reverses there.
11. S35: a sales rep enters a dry-product load with leftover `none`; `none` on a load with water is refused.
12. A leftover larger than the tank held: saved, flagged, used never below 0. A product with no unit conversion: saved with a flag, no stock row. The mixer picks another warehouse: stock leaves there.

In later PRs: mix-site account access (mixer-account PR); correction after a work entry refused for an applicator and allowed for admin, and load/entry races (work-entries PR).

## Spring (agreed, not February)

Partial hold release per load (needs Taha's review of `inventory_holds`); leftover tracked as a claim with flags when the carried mix differs from the receiving job's recipe or customer (`field_load_carry`); exact carried composition after water top-ups; a "possible duplicate load" flag (same rig and jobs within 30 minutes); tender, sprayer and tote balances. **Cost of waiting:** a held product stays held until the job closes, so a long job can show less available than is really on the shelf; a carried mix used on a different recipe is caught only by the office's mix-differs review.
