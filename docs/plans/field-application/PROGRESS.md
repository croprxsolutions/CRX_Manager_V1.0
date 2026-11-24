# Field application: progress

Each lane writes only its own section; a slice 2 or 3 lane adds its own section when it starts. The shared lines (lease, Mason batches, release state) are written by the database lane. States (`BUILD-PLAN.md` › Rules 5): NOT STARTED, IN PROGRESS, IN REVIEW (PR open), MERGED (in staging), VERIFIED (applied on staging, scenarios re-run there), READY FOR RELEASE, LIVE, PARKED (reason), BLOCKED (on what), WAITING ON MASON.

`JobDetail.tsx` lease: none.

## Kit

| Item | State | Note |
|---|---|---|
| Master copies (SPEC, contracts, scenarios, build plan) | IN REVIEW | Draft PR #2415; Sol rounds 1 and 2 and the Opus buildability review resolved 2026-11-24 |
| Mason's go-ahead to start slice 0 / 1 | GO (staging only) | Mason 2026-11-24: "Yes, all four" (slice 0–1 batch). Slices 2–3 need their own go; nothing goes live without his yes at that time |
| Chem Man import | WAITING ON MASON | Export not made yet (2026-11-24). Mention once in the first captain digest, then again only when FP-1 is VERIFIED on staging and the import is next. Does not block slice 0 or FP-1 |

## Mason batches (one message per slice; Claude's recommendation first)

Every slice batch also asks, for its release: the merge into `main` (Taha or Mason), each live migration apply, any production smoke write, and who watches errors the first day (`BUILD-PLAN.md` › Release owner).

| Slice | Ask | Recommendation | Answer |
|---|---|---|---|
| 0–1 | Go for slices 0 and 1 (M7) | Yes, once the kit is merged into staging | **Yes** (2026-11-24): kit merge, tooling PR, FP-1, into staging only |
| 0–1 | Date for Taha's live reset (#2407), and the yes to fill, re-stamp and apply it | A date before mid-December, agreed with Taha | **Done**: already applied live 2026-11-24 07:09 UTC (see Slice 0) |
| 0–1 (added later) | Any staging-only migration that changes today's live billing (only if slice 0 finds one; asked before the release that carries it, not before the go) | Per slice 0 step 3, with the before-and-after customer effect | |
| 0–1 | Drop the kit's extra `I approve` for non-destructive field migrations (FP-1, FP-3, FP-4, engine grants) | Yes | **Yes** (2026-11-24). Mason 2026-11-24 (slice 0–1 batch): no extra kit `I approve` for non-destructive field migrations; they apply under AGENTS.md › Autonomous landing (Taha's `Ready to merge`, the migration-apply proof gate). Mason's yes stays for anything the repo's guard classes as destructive (it asks him itself), Taha's reset, logins and roles, Edge Function deploys, production switches, `field_billing_start_date` and the live Chem Man import. |
| 0–1 | Where the Chem Man export file lives (private, outside the repo), and the yes for the one live import after the reset | A private folder Mason names | **Later**: no export yet; asked again when FP-1 is VERIFIED (see Chem Man import above) |
| 0–1 | Staging test login for any role missing from `docs/reference/qa-testing.md` | Create only what is missing | **Yes** (2026-11-24): missing roles only, staging only |
| 2 | Go for slice 2; applicator extra-field permission; the mix-site account; `field_batch_stock_enabled` on in production at release; book the posting window with Taha | Yes to each | |
| 3 | Go for slice 3; Edge Function deploy; at release, in order: the billing switch-on date and the pilot job (chosen from the open-job list), the pilot draft checked by hand, posting on for the pilot set only, then (after the pilot is checked on statements) posting on for everyone | Yes to each, in that order | |

## Slice 0

| Item | State | Note |
|---|---|---|
| Kit merged into staging (pre-build checklist, before any session) | NOT STARTED | docs-only PR from #2415 |
| Tooling: registry and types from staging | NOT STARTED | before any field migration merges |
| Taha's live reset (#2407) | LIVE | `20270301100000_live_test_data_reset` applied live 2026-11-24 07:09 UTC (ledger version `20261124070916`). Read-only check that day: live has 0 jobs, 0 invoices, 5 fields; no `field_billing_defaults.price_override_cents` set; none of the six staging-only migrations applied live |
| Read-only facts in the contracts | NOT STARTED | |

**Staging-only migrations** (slice 0 step 3):

| Migration | In source | Applied on staging | Applied live | Fits the kit? | Action |
|---|---|---|---|---|---|
| `20270224110000_retire_per_acre_field_pricing` | yes | | | | |
| `20270224130000_split_save_refuses_blend_billed_job` | yes | | | | |
| `20270226150000_job_transfer_below_cost_whole_line` | yes | | | | |
| `20270205100000_field_app_refuses_payer_change` | yes | | | | |
| `20270228200000_field_app_save_refuses_other_editors` | yes | | | | |
| `20270227170000_job_completion_missing_stock_rows` | yes | | | | |

## Slice 1 · DB

| Item | State | Proof / link | Note |
|---|---|---|---|
| FP-1 field splits + payer notes | NOT STARTED | | |
| Chem Man field import | NOT STARTED | | trial on a local copy; live after the reset |
| FP-2 billable acres | NOT STARTED | | after 2026-12-15, Taha reviews |

## Slice 1 · paperwork

| Item | State | Proof / link | Note |
|---|---|---|---|
| 1 Safety on every page | PARKED | `feat/field-paper-1` (not pushed) | Strip on every page (map pages too); Custom config can no longer hide REI/PHI. Parked: Terra HIGH (a 35+ product mix cannot fit the strip on every page) survived 2 fix rounds; asked Mason 2026-11-24 to allow 'see the safety table on page 1' past that size |
| 2 Map pages only print | PARKED (menu entry) | `feat/field-paper-2` (stacked on 1): print library `mapsOnly` option, rendered one-field and multi-field, Terra CLEAN | Maps only, safety on every page, no blank first page; a job with no maps refuses plainly. The one `JobDetail.tsx` print-menu entry waits for the lease (asked below) and needs Sol (JobDetail is on the Sol list) |
| 3 Spray-order numbers on maps | PARKED (stacked on 1) | `feat/field-paper-3`; Terra CLEAN on its own diff | Overview labels `N · acres`; per-field page title `Stop N`; numbers restart per job (test) |
| 4 Directions link per field | PARKED (stacked on 3) | `feat/field-paper-4`; Terra 2 MED + 1 LOW, fixed or refuted | Tappable Google Maps link per mapped field, in stop order, under the field table |
| 5 Loader water to add + finished gallons | IN REVIEW | `feat/field-paper-5` (own branch from staging); rendered: tank loads, condensed, one batch, overfill, unknown unit, missing amount; Terra 2 LOW fixed | Loader PDF and job-page panel show Finished gallons and Water to add in loader units ("58 GL 7.68 FL OZ"), per tank and as one batch. Dry adds no volume; overfill prints 0 + warning; a product it cannot size is named, never guessed |
| 6 EPA dash / Unknown | PARKED ("Unknown" half) | dash: already prints for any blank number (`applicatorSheetPdf.test.ts`, blank and null rows) | No product value says a product is EPA-registered (`products.epa_registration` is the number only; `epa_registrations` is keyed by the number). "Unknown" needs that flag: asked below |

## Needs another lane

| Asked by | Owning lane | What | Done? |
|---|---|---|---|
| Paperwork (group 6) | Database | A product value that says "this product is EPA-registered" (so a registered product with no number prints "Unknown" and an unregistered one prints a dash, KI-206). Today nothing tells the two apart | |
| Paperwork (group 1) | Office screens (SettingsPage) | The Custom applicator sheet REI/PHI checkboxes no longer hide anything (safety always prints): remove or relabel them | |
| Paperwork (group 2) | Database (lease holder) | The `JobDetail.tsx` lease, for one print-menu entry: "Map pages only" | |

## Disputed review findings (for the slice batch)

The repo is public: one-line summaries only, no customer data, and no exploit detail for an open access bug (AGENTS.md › Public security write-ups).

| PR | Sol run (head sha) | Finding | Lane's position | Disposition / follow-up |
|---|---|---|---|---|
