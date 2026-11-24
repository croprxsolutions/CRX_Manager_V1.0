# Field application: build plan

**Master copy (2026-11-24). Nothing here authorizes building: Mason starts each slice (M7).** Design: `SPEC.md`. Contracts: `CONTRACT-who-pays.md`, `CONTRACT-batch-stock.md`, `CONTRACT-field-billing.md`. Numbers: `SCENARIOS.md`. Progress and Mason batches: `PROGRESS.md`.

**Deadline:** the core flow live by **February 1, 2027** [GR1]; tenders, balances, offline phones and totes before the April rush.

## Go-live order (Mason, 2026-11-24)

Taha's one-time live reset → slice 1 → slice 2 (Taha's areas only after 2026-12-15, with his review) → slice 3 → first real multi-payer job drafted, checked by hand, posted → billing on for everyone. **Chem Man bills field work until Mason sets the billing switch-on date after slice 3 is live** [M5].

**Hard rule:** no field-app migration is applied live until Taha's reset (`20270301100000`, PR #2407, merged into staging) has been filled, re-stamped and applied live with Mason's yes. Its preflight refuses if the live table set or DELETE triggers change, so FP-1 live first would block it for good. Field migrations are built and merged into staging freely.

| Slice | Target | What goes live | Database PRs (in order) | Screens |
|---|---|---|---|---|
| **0 Clear the ground** | before slice 1 builds | Nothing new for users | tooling PR (registry and types from staging) | — |
| **1 Who pays + paperwork** | mid-December | Field splits with history and two share sets, payer notes; billable acres; paperwork fixes; Chem Man fields imported | FP-1, Chem Man import, FP-2 (after 12-15) | Field Setup split history and notes; paperwork (no database change) |
| **2 Crew on CRX** | early-mid January | Jobs carry splits; loads take stock for new jobs; applicators log acres; office review closes jobs; application services billed or not; product "sourced from"; season acres and blend reports; fields archived not deleted. **No CRX billing yet** | loads and stock; work entries and statuses; application services; FP-4; review checks; FP-3; mixer account (account only) | see slice 2 brief outline |
| **3 Billing** | live by Feb 1; switch-on date set by Mason after | Per-payer invoices the chemical-sale way, posting as a set, corrections, PDFs and email | billing engine; posting | see slice 3 brief outline |

### Slice 0 steps (database lane, in this order)

1. **Merge this kit into `staging`** (docs-only PR from PR #2415; no Sol needed). No build session starts before it is in `origin/staging`.
2. **Tooling PR:** `scripts/regenerate-schema-registry.mjs` and `regen-schema-registry` gain a `--staging` mode (reads the staging project), and types are generated from staging the same way; then `node scripts/sync-agent-workflows.mjs --write`, `npm run test:agent-workflows`, `npm run agent-health`. Until it lands, no field migration merges into staging. After every staging apply the database lane runs the staging mode and commits the registry and `src/types/index.ts` in its next PR; a production regeneration after each live apply as today.
3. **Staging-only migrations, read-only check.** For each of `20270224110000_retire_per_acre_field_pricing`, `20270224130000_split_save_refuses_blend_billed_job`, `20270226150000_job_transfer_below_cost_whole_line` (largest remainder, not SPEC §9; replaced by the engine for batch jobs), `20270205100000_field_app_refuses_payer_change`, `20270228200000_field_app_save_refuses_other_editors` and `20270227170000_job_completion_missing_stock_rows`, record in `PROGRESS.md`: in the source tree (yes/no), applied on the staging database (ledger), applied live (ledger), and whether it fits this kit. All are in `staging`, so they ride the next normal staging → main release unless replaced. One that fits rides it (expected: all, `20270224110000` because FP-1 keeps payer notes in `field_payer_notes`, not on `field_billing_defaults`). One that conflicts gets a replacement migration in the database lane before that release. Mason is asked only if one changes today's live billing behavior.
4. **Read-only facts** the contracts list (`complete_job` body and triggers on staging and live, `jobs` trigger chain, stock-location key, #1650 access).
5. **Slice 0–1 Mason batch** in `PROGRESS.md` (reset date with Taha, FP-1 `I approve`, Chem Man file location and live import yes, staging test logins for any missing role).

### Database PR details

| PR | Contract / scope | Needs first | Scenarios it proves |
|---|---|---|---|
| FP-1 field splits + notes | who-pays FP-1 | slice 0 | fixture set |
| Chem Man import | who-pays › Chem Man field import | FP-1 on staging; live after the reset | counts + office list |
| FP-2 billable acres | who-pays FP-2 | FP-1; after 2026-12-15, Taha reviews | FP-2 cases |
| Loads and stock | batch-stock | FP-1; `20270227170000` released; does not touch `inventory_holds` or `_sync_job_holds` (if it must, after 12-15 with Taha) | S11–S15, S17–S19, S35 |
| Work entries and statuses | SPEC stages 6–7: **extend** `job_applied_records` / `_fields` (load segments, gauge, entry kind, Central spray date, restricted-use values as entered); add `ready_for_review` (Applied = `completed`, inventory every reader of job statuses); legal `application_records` written per field at office close, not in `complete_job`; Job done; cancel only at zero acres and no load; rained-out end; own-entry edits end at close; applicator access via #1650 unchanged (`completed_at` still on `completed`); an applicator may add an extra field from fields its job's payers pay on (permission change: slice 2 batch); restricted-use field settings per state. `jobs.priority` is kept | loads and stock | S20, S21, S27, load/entry races |
| Application services | `application_services` gains `bills_customer` and `outside_vendor_id` (`vendors`); `vehicles` gains a default carrier gal/acre; the job copies the flag and vendor when its service is picked; service picks the rig from `application_services.vehicle_id` when set; read-only season acres and blend report queries | work entries | S32–S34 |
| FP-4 jobs carry splits | who-pays FP-4 | FP-1, FP-2; after 12-15, Taha reviews | S7 (planned split) |
| Review checks | SPEC stage 8; builds the read-only `field_job_usage(job)` (used per load, job, field, product) that the engine prices from; settle a load by hand | work entries, loads | S16, S17, S20, S24 flag |
| FP-3 archive fields | who-pays FP-3 | FP-1; after 12-15, Taha reviews | archive cases |
| Mixer account | No new role: one applicator-role account for the mix site, created with Mason's yes (slice 2 batch); stays signed in on the normal session refresh | loads and stock | mix-site access cases |
| Billing engine | field-billing (all but posting); creates `field_billing_start_date` | FP-2, FP-4, review checks, loads, application services | S1–S10, S20, S23, S26, S29–S33 |
| Posting | field-billing › Authority and timing, Switches, After posting, B9–B11, B16 | billing engine; window agreed with Mason and Taha (after 12-15); Taha reviews | S22, S24, S25, S28 |

**Stacking:** while PR n waits on review, a hold or a Mason answer, PR n+1 may be built and proved on a branch stacked on PR n; merges into `staging` stay in order, and PR n+1 is rebased and re-proved after PR n lands.

**Thin end-to-end check on staging:** once FP-1, loads and stock, and work entries are verified on staging (target December 20): one test job created and printed, one load confirmed on the tablet (stock leaves once), acres logged on the phone, the job closed. Run by the database lane; pass or miss recorded in `PROGRESS.md`. On a miss, the slice 2 screen lanes keep building against the contracts but do not merge until it passes.

## Brief outlines (full briefs are written by the database lane as the last item of the slice before, from what was really built)

**Slice 2** (Mason's go: M7)
- *Database lane* `C:\CRX_wt\field-db`: loads and stock → work entries and statuses → application services → FP-4 → review checks → FP-3 → mixer account. Owns migrations, `src/types/index.ts`, the registry, `docs/changelog.d/`, `docs/reference/migrations.d/`, `docs/manual/*` ledgers. Holds the `JobDetail.tsx` lease for FP-2 and FP-4's Job Detail changes (recorded in `PROGRESS.md`), plus `SelectLocationsModal.tsx` and `chemicalApplicationReportFetch.ts`. Done when: every PR VERIFIED on staging and the thin check passed.
- *Crew screens lane* `C:\CRX_wt\field-crew`: mixer tablet (`get_mixable_jobs`, confirm/add/correct/leftover, office load entry for no-tablet jobs), applicator phone (work entries, segments, gauge, Now buttons, weather, extra field, restricted-use fields, Job done), spray record print per field. Inputs: loads and work-entries PRs on staging. Done when: S11–S15 and S27 observed in the browser on staging as applicator and the mix-site account.
- *Office screens lane* `C:\CRX_wt\field-office`: job creation (field picker by any payer, product "sourced from", application service with prefill from `customers.default_application_service_id`, rig carrier default), `DispatchBoard` list by rig with drag-and-drop spray order, `ApplicationServices.tsx` / `ApplicationServiceDetail.tsx` (billed flag, outside company), office review screen (planned / mixed / billed, flags, settle load, close), season acres and blend reports (the "billed by CRX" column shows the service flag; actual invoices are proved in slice 3). Inputs: application services, review checks, FP-3, FP-4 on staging. Done when: S16, S17, S20, S21, S33, S34 observed on staging as admin and sales rep.
- *Mason batch at the start:* go (M7); `I approve` for FP-3 and FP-4 grants; the applicator extra-field permission; the mix-site account; turning on `field_batch_stock_enabled` in production at release; Taha's reviews booked after 12-15.

**Slice 3** (Mason's go)
- *Database lane* `C:\CRX_wt\field-db`: billing engine → posting. Done when: every money scenario run on staging as the real roles, expected vs observed in the PRs.
- *Billing screens lane* `C:\CRX_wt\field-billing-ui`: unposted invoice review (field sections, your share, Shared with, per-line override, price and quantity edits, notes, invoice date, refresh, flags), post as a set, corrections, both invoice PDF builders with a parity test, the job-done email (off by default). Inputs: engine and posting on staging. Done when: the ledger journey observed on staging and both PDFs match.
- *Mason batch at the start:* go (M7); engine grants `I approve`; the posting window with Taha (ask at slice 2 start so it is booked); the Edge Function deploy; at release: posting switch on in production for the pilot, the switch-on date.

## Moved to spring (2026-11-24)

| Item | Why it can wait | Cost of waiting |
|---|---|---|
| Partial hold release per load | Needs Taha's `inventory_holds`; holds release whole at job close as today | A long job shows less available than is on the shelf |
| Leftover tracked as a claim, with mix and customer flags; exact carried composition after water top-ups | The rig's next load shows the leftover and its mix as carried in; the office's mix-differs review catches a mismatch | A carried mix used on a different recipe is caught by review, not flagged at once |
| Possible-duplicate-load flag | Retry keys already stop double taps | Two tablets confirming one tank under two ids is caught at review |
| Per-payer prices on one field (M2) | One price per product per job in February | — |
| Tenders, sprayer balances, totes, offline phones | GR1 | Paper fallback on the tablet |
| Blend-ticket billing on the engine; orders and deliveries reading field shares; final boundary check | Not on the February path | — |
| Crop-coloured map toggle; map print window and ink saver | Nice to have | — |
## How the work stays safe

1. **Foundation first.** A screen may be built against an accepted contract before its database PR lands, but it **merges** only after the database PRs it needs are verified on staging and the registry and types are refreshed (slice 0 step 2).
2. **One database lane.** Migrations merge one after another; shared database functions have one owner at a time.
3. **Screen lanes beside it**, each owning its own files, **at most three sessions at once**. Shared files: `src/pages/JobDetail.tsx` (one lease at a time, named in `PROGRESS.md`), `src/App.tsx` (one route line per page lane, rebased before merge), `src/types/index.ts` and the registry (database lane only), `docs/manual/*` ledgers (database lane). Each lane writes only its own `PROGRESS.md` section.
4. **Each lane is one session in its own worktree** under `C:\CRX_wt\field-<lane>`, branched from current `origin/staging` (which has this kit after slice 0 step 1), PRs into `staging`. Briefs live in `docs/loops/field-app-*.md`.
5. **Reviews follow `ship.md` Step 6:** money, stock, data and permission PRs (the Sol list): plan-contract (these contracts count once Sol has challenged them), Luna until clean, Sol once before the PR, every `ship.md` gate; other code gets one Terra final review. The lane fixes review findings itself; it brings to Mason, in the slice batch, only findings it disputes or that add a crew or office step. Sol is capped at two rounds per plan [M6].
6. **Taha's areas are not touched before 2026-12-15:** job holds (`inventory_holds`, `_sync_job_holds`), quotes (including the quote-to-job writer), bookings, chemical billing (`order_shares`, `order_item_shares`, the Bill Split card), the shared posting and invoice mutation functions, credit memos, month close. Work touching them comes after that date with his review.

## Rules every session follows

1. **Read first:** `AGENTS.md`, `SPEC.md`, `SCENARIOS.md`, the PR's contract, its own `PROGRESS.md` section.
2. **The kit is the desired behavior; code and live read-only evidence are today.** A difference the kit names is the work. A fact that turns out different: if the fix stays inside the PR's contract and changes no business rule, fix the contract text in the same PR and re-prove; otherwise park that PR (`PROGRESS.md`, both positions) and move to the next independent one.
3. **Own only your files.** A change needed elsewhere goes in `PROGRESS.md` › Needs another lane, naming the owner.
4. **Proof:** database PRs run each scenario they cover as SQL on a database migrated to the staging schema, as the real roles (admin, sales_rep, applicator, inactive applicator, driver, entity_recipient, anon; the mix-site account once it exists), including the upgrade from current staging. Screens are checked in the browser on staging with the role test accounts in `docs/reference/qa-testing.md` › Role-Based Test Accounts (never the Browser pane's production session). Expected vs observed goes in the PR. Test writes never touch production; the release smoke is separate (Release evidence).
5. **States:** NOT STARTED, IN PROGRESS, IN REVIEW (PR open), MERGED (in `staging`), VERIFIED (applied on staging, scenarios re-run there), READY FOR RELEASE (every PR in the slice verified, evidence pack written), LIVE, PARKED (reason), BLOCKED (on what), WAITING ON MASON. A builder's slice ends at READY FOR RELEASE; LIVE is set after Mason or Taha releases it.
6. **Park, don't halt:** the same BLOCKER or HIGH surviving two fix rounds, a gate needing Mason, unclear ownership, or a guard refusal not understood parks **that PR** (`PROGRESS.md`) and the session continues with other unblocked items. The whole session stops only on an unintended live-data change, a failed live apply, or Mason saying stop. Anything for Mason goes in the slice batch **and** the session's closing message.
7. **Mason's field rule:** flags and notes, not blocks; no extra crew or office steps.

## Delivery gate

- **Allowed without asking:** branches, commits, feature-branch pushes after the review route passes on that head, PRs into `staging`, and merging into `staging` under AGENTS.md › Autonomous landing (Sol proof where required, checks green, no changes requested, the Taha hold rules in `ship.md`). Staging merges need no `I approve`.
- **Never without Mason's explicit yes in his own conversation** (asked in the slice batch, not one at a time): every `I approve` (FP-1 foreign key and grants, FP-3, FP-4 and billing-engine grants) before its live apply; any login, role or permission change (the applicator extra field, the mix-site account); anything into `main`; applying a migration to production; the reset; the live Chem Man import; deploying an Edge Function; turning on `field_batch_stock_enabled` or `split_field_invoice_posting_enabled` in production; setting `field_billing_start_date`; changing secrets; force-push.
- **Never:** pushing to Taha's PRs; touching Taha's areas before 2026-12-15.

## Release evidence (each slice)

The release PR and its merge commit; each migration's name and the live ledger showing it applied; the post-apply read-only checks the contracts name (for example FP-1's version-1 count); the deployed app version; the Edge Function version if changed; a smoke run of the slice's main path in production as a real role, with Mason's yes for any write; the rollback point; who watches errors for the first day (Mason names them). Taha or Mason merges to `main`; Claude applies migrations only through the apply-proof gate.

**Slice 3 extra:** every `SCENARIOS.md` case run on staging as the real roles with expected vs observed recorded; the production pilot in `CONTRACT-field-billing.md` › Switches.
