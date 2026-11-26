# MISSION: field application, slice 2 database lane

You build slice 2's database: loads and stock, work entries and statuses, application services, FP-4, review checks, FP-3 and the mixer account. Read `docs/plans/field-application/BUILD-PLAN.md` (rules every session follows) and `PROGRESS.md` › Slice 2 before anything else. Written 2026-11-25 from the merged slice 1 code (#2487, #2498, #2558, #2539), not from the plan alone.

## Start gate (check before the first migration)

1. **Mason's go:** given 2026-11-25 ("Yes, split it") for slice 2's database work into `staging` only. Nothing goes live, and no production switch turns on, without his yes at release.
2. **No migration until the applicator data-access fix is merged into staging.** That is the database half of #2574 (`jobs_crew` / `job_chemicals_crew` views, applicator branches removed from the `jobs`, `job_chemicals`, `job_field_shares` and `field_billing_defaults` read policies, ~15 ripple policies moved to `_is_job_applicator` / `_is_dispatched_to_me`), owned by the Field Setup lane (`local_cc34d909`). Until it merges that lane is the only database writer; this lane may write contracts, proof scripts and stacked branches, but merges no migration. Every slice 2 table, view and RPC an applicator reads must follow the shape that fix lands (safe columns only; no price, cost, memo, commission or split %).
3. One database writer at a time (`BUILD-PLAN.md` › How the work stays safe 2). Take the next migration stamp with `npm run next-migration-stamp`; the merge captain restamps at merge time if staging moved.

## What slice 1 actually built (facts to build on)

- **Who pays** (`20270305190000_field_split_versions`): `field_billing_split_versions` + `field_billing_split_payers` (append-only, two share sets in micro-percent, 100,000,000 = 100%), `field_payer_notes` (office only). Writers: `set_field_billing_split` (office; today only, `FIELD_SPLIT_STARTS_TODAY_UNTIL_FP4`; equal shares, `FIELD_SPLIT_SHARES_MUST_MATCH_UNTIL_FP4`) and `save_field` (through `_set_field_billing_split_20270303`). Reader: `field_split_as_of(p_field_ids uuid[], p_on_date date)` (office only). Internal: `_field_split_in_force_20270303`, `_refresh_field_billing_defaults_copy_20270303`, nightly `_refresh_all_field_billing_copies_20270303`.
- **`field_billing_defaults`** is now a read-only copy of today's split (product shares, no notes), refreshed by the writer, by an owner change (`20270307150000_field_owner_change_refreshes_copy`, trigger `fields_owner_change_refreshes_copy`) and nightly. Every screen still reads it. Browser writes are revoked.
- Deleting a field that has a split is refused until FP-3 (archive); deleting a customer who owns or pays on a field is refused.
- Field Setup (`FieldSetup.tsx`, `src/lib/fieldSplit.ts`, `fieldSplitLoad.ts`, `FieldSplitHistory.tsx`) saves splits, history and payer notes; main payer is automatic (owner if paying, else the largest share).
- **Newer than the batch-stock contract's facts:** `20270303110000_close_direct_job_writes` removed every browser write on `jobs` and `job_fields`; all job writes go through RPCs (`save_job`, `edit_jobs`, `complete_job`, …). So "a direct status write is guarded the same way" (batch-stock §1) is already true for the browser; guard the RPCs. `20270303100000_job_invoice_kept_epa` also re-emitted invoice functions after `20270227170000`. Re-read the deployed `complete_job` chain read-only before building (contract › Facts).
- Staging proof of FP-1 and its follow-up: db-apply runs 45629192766 and 45672118827 (applied, schema match passed). Thin end-to-end check not yet run.

## Items, in order (one PR each; screens are other lanes)

| # | PR | Contract | Needs first | Taha |
|---|---|---|---|---|
| 2.1 | Loads and stock | `CONTRACT-batch-stock.md` | the #2574 database half merged; `20270227170000` released | see "Keeping out of Taha's areas" |
| 2.2 | Work entries and statuses | `BUILD-PLAN.md` › Database PR details | 2.1 | `ready_for_review` must be counted as open work by `guard_customer_deactivation_open_work_20270128`, which Taha's #2526 rewrites: rebase on it, change nothing in it before 12-15; if it needs a change, park the item and ask Taha |
| 2.3 | Application services | same | 2.2 | `bills_customer` must not change commission writers (`_insert_commissions_for_job`, Taha's #2525 commission work) before 12-15 |
| 2.4 | FP-4 jobs carry splits | `CONTRACT-who-pays.md` FP-4 | FP-2 (parked to after 12-15) | **after 12-15**: the planned split copy is in the quote-to-job writer |
| 2.5 | Review checks (`field_job_usage`) | SPEC stage 8 | 2.2, 2.1 | none |
| 2.6 | FP-3 archive fields | `CONTRACT-who-pays.md` FP-3 | FP-1 | **after 12-15**, Taha reviews (BUILD-PLAN) |
| 2.7 | Mixer account | BUILD-PLAN › Mixer account | 2.1; Mason's yes (slice 2 batch) | none |

While 2.4 and 2.6 wait for 12-15, build 2.1 → 2.2 → 2.3 → 2.5 → 2.7 in that order (stacking allowed, merges in order).

## Keeping out of Taha's areas until 2026-12-15 (checked 2026-11-25)

- **`jobs.stock_path` on every creation route:** set it in a `BEFORE INSERT` trigger on `jobs` (reads `app_settings.field_batch_stock_enabled`), not inside `save_job`, `create_job_from_quote_section` or the booking-to-job writers. Then 2.1 edits no quote or booking function and can merge before 12-15. Never let `edit_jobs` or `save_job` change it after insert. If the trigger shape fails review, park 2.1's creation-route part until 12-15 rather than editing a quote or booking writer.
- **Vendor-sourced lines:** `_sync_job_holds` (holds) and the purchasing plan's booking reservations (`20270228210000`) skip a line only when `job_chemicals.customer_supplied` is true. If 2.1 marks vendor lines with `source_vendor_id` alone, those Taha readers would hold and plan CRX stock for them. Keep `customer_supplied = true` whenever `source_vendor_id` is set (constraint or trigger), so his readers stay right untouched. Fix the contract text in 2.1's PR (`BUILD-PLAN.md` › Rules 2: no business rule changes).
- Do not touch `inventory_holds`, `_sync_job_holds`, quotes, bookings, `order_shares` / `order_item_shares`, posting, invoice mutation functions, credit memos or month close. Holds still release whole at job close.
- Before each PR opens, re-run `gh pr list --author TahaKhanAbdalli` and diff his open migrations' functions against yours; Taha's open PRs on 2026-11-25 (#2525, #2526, #2537, #2556, #2591) touch none of 2.1's objects.

## Applicator access (all items)

FP-1 made split versions and payer notes office only. The applicator's extra-field picker (2.2) cannot read `field_billing_split_payers`; give it a narrow read function that returns field id, name and acres only for fields a payer on the applicator's own job pays on (share above 0 on either side), no shares and no notes. Its grant is the applicator extra-field permission: Mason said yes 2026-11-25.

## Worktree and files

`C:\CRX_wt\field-db`, branch per item `feat/field-2.<n>-<slug>` from current `origin/staging`. Owns: new files under `supabase/migrations/`, `src/types/index.ts`, the registry, `docs/changelog.d/`, `docs/reference/migrations.d/`, `docs/manual/*` ledgers, proof scripts under `scripts/smoke/`, and `PROGRESS.md` › Slice 2 · DB plus its shared lines. Not `FieldSetup.tsx`, not map files (`src/components/map/*`, `jobMapImages.ts`), not print or loader files. `JobDetail.tsx` only under the lease in `PROGRESS.md`.

## Review route and done

Each item: plan-contract (the kit contracts count) → Docker proof as the real roles on two baselines (staging as it is; production plus pending staging migrations) → Luna until clean → Sol once (every item is on the Sol list) → PR into `staging` → READY line to the merge captain. Done when every item is VERIFIED on staging and the thin end-to-end check (`BUILD-PLAN.md`) passed. `field_batch_stock_enabled` stays off in production.
