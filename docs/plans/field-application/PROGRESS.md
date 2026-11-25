# Field application: progress

Each lane writes only its own section; a slice 2 or 3 lane adds its own section when it starts. The shared lines (lease, Mason batches, release state) are written by the database lane. States (`BUILD-PLAN.md` › Rules 5): NOT STARTED, IN PROGRESS, IN REVIEW (PR open), MERGED (in staging), VERIFIED (applied on staging, scenarios re-run there), READY FOR RELEASE, LIVE, PARKED (reason), BLOCKED (on what), WAITING ON MASON.

`JobDetail.tsx` lease: free. The paperwork lane released it 2026-11-24 when #2458 merged into staging.

## Kit

| Item | State | Note |
|---|---|---|
| Master copies (SPEC, contracts, scenarios, build plan) | IN REVIEW | Draft PR #2415; Sol rounds 1 and 2 and the Opus buildability review resolved 2026-11-24 |
| Mason's go-ahead to start slice 0 / 1 | GO (staging only) | Mason 2026-11-24: "Yes, all four" (slice 0–1 batch). Slices 2–3 need their own go; nothing goes live without his yes at that time |
| Chem Man import | DEFERRED until the field build is done (Mason, 2026-11-24) | Mason: not doing the export now; wait until the build is done. Do not ask for the export file until then |
| Test data | 10 TEST fields on staging | Testing uses the 10 fake TEST fields set up on staging (2026-11-24), not a Chem Man import |

## Mason batches (one message per slice; Claude's recommendation first)

Every slice batch also asks, for its release: the merge into `main` (Taha or Mason), each live migration apply, any production smoke write, and who watches errors the first day (`BUILD-PLAN.md` › Release owner).

| Slice | Ask | Recommendation | Answer |
|---|---|---|---|
| 0–1 | Go for slices 0 and 1 (M7) | Yes, once the kit is merged into staging | **Yes** (2026-11-24): kit merge, tooling PR, FP-1, into staging only |
| 0–1 | Date for Taha's live reset (#2407), and the yes to fill, re-stamp and apply it | A date before mid-December, agreed with Taha | **Done**: already applied live 2026-11-24 07:09 UTC (see Slice 0) |
| 0–1 (added later) | Any staging-only migration that changes today's live billing (only if slice 0 finds one; asked before the release that carries it, not before the go) | Per slice 0 step 3, with the before-and-after customer effect | |
| 0–1 | Drop the kit's extra `I approve` for non-destructive field migrations (FP-1, FP-3, FP-4, engine grants) | Yes | **Yes** (2026-11-24). Mason 2026-11-24 (slice 0–1 batch): no extra kit `I approve` for non-destructive field migrations; they apply under AGENTS.md › Autonomous landing (Taha's `Ready to merge`, the migration-apply proof gate). Mason's yes stays for anything the repo's guard classes as destructive (it asks him itself), Taha's reset, logins and roles, Edge Function deploys, production switches, `field_billing_start_date` and the live Chem Man import. |
| 0–1 | Where the Chem Man export file lives (private, outside the repo), and the yes for the one live import after the reset | A private folder Mason names | **Deferred** until the field build is done (Mason, 2026-11-24; see Chem Man import above) |
| 0–1 | Staging test login for any role missing from `docs/reference/qa-testing.md` | Create only what is missing | **Yes** (2026-11-24): missing roles only, staging only |
| 2 | Go for slice 2; applicator extra-field permission; the mix-site account; `field_batch_stock_enabled` on in production at release; book the posting window with Taha | Yes to each | |
| 3 | Go for slice 3; Edge Function deploy; at release, in order: the billing switch-on date and the pilot job (chosen from the open-job list), the pilot draft checked by hand, posting on for the pilot set only, then (after the pilot is checked on statements) posting on for everyone | Yes to each, in that order | |

## Slice 0

| Item | State | Note |
|---|---|---|
| Kit merged into staging (pre-build checklist, before any session) | MERGED | #2415 merged 2026-11-24 (head `dfe7837fd`) |
| Tooling: registry and types from staging | MERGED | #2439 (`b47e63c9e`): `regenerate-schema-registry.mjs --live --staging [--types]` writes `.claude/schema-registry.staging.json`; the live registry stays live. Follow-up (other lanes): staging-generated `src/types/supabase.ts` breaks 45 call sites (invoices, reports, orders, cockpit), so it is not committed yet; migrations add their own type entries until that drift is fixed |
| Taha's live reset (#2407) | LIVE | `20270301100000_live_test_data_reset` applied live 2026-11-24 07:09 UTC (ledger version `20261124070916`). Read-only check that day: live has 0 jobs, 0 invoices, 5 fields; no `field_billing_defaults.price_override_cents` set; none of the six staging-only migrations applied live |
| Read-only facts in the contracts | VERIFIED | Read-only 2026-11-24. `field_billing_defaults`: live 5 fields / 6 rows, staging 0; 0 per-acre prices or notes; every primary payer is the field owner; save_field is its only database writer and the app never writes it directly. Readers: 18 database functions live (+ `_job_transfer_shares_20270207` on staging); screens `SelectLocationsModal`, applicator sheet, billed-customers lookup, chemical application report, loader worksheet, Field Setup, Job Detail, Order Detail. `fields.customer_id` ON DELETE CASCADE on both; no customer-delete flow in the app. `jobs` triggers: 17 live, 18 staging (`zz_inactive_customer_new_work_20270129`). `complete_job` differs (staging carries `20270227170000`). 9 pg_cron jobs on each |

**Staging-only migrations** (slice 0 step 3):

| Migration | In source | Applied on staging | Applied live | Fits the kit? | Action |
|---|---|---|---|---|---|
| `20270224110000_retire_per_acre_field_pricing` | yes | yes (20261123031639) | no | yes (FP-1 relies on it) | ships in the next release |
| `20270224130000_split_save_refuses_blend_billed_job` | yes | yes (20261123053153) | no | yes | ships in the next release |
| `20270226150000_job_transfer_below_cost_whole_line` | yes | yes (20261123153401) | no | yes (changes live transfer quantities; Mason decided 2026-11-21/22) | ships in the next release; no new ask |
| `20270205100000_field_app_refuses_payer_change` | yes | yes (20261121221854) | no | yes | ships in the next release |
| `20270228200000_field_app_save_refuses_other_editors` | yes | yes (20261124080322) | no | yes | ships in the next release |
| `20270227170000_job_completion_missing_stock_rows` | yes | yes (20261124042000) | no | yes | ships in the next release |

## Slice 1 · DB

| Item | State | Proof / link | Note |
|---|---|---|---|
| FP-1 field splits + payer notes | IN PROGRESS | branch `feat/field-1.1-fp1-splits` | migration `20270303120000_field_split_versions`; Docker proof, Luna, Sol, then the PR. Field Setup screen PR: owned by the Field Setup screen lane (`feat/field-1.1-setup-screen`); merges only after FP-1 is VERIFIED on staging |
| Chem Man field import | DEFERRED | | until the field build is done (Mason, 2026-11-24); then his export (private folder he names), a trial on a local copy, live after his yes. Testing meanwhile uses the 10 TEST fields on staging |
| FP-2 billable acres | PARKED | | until after 2026-12-15 (its quote-to-job change is in Taha's quotes area); then with Taha's review |

## Slice 1 · paperwork

| Item | State | Proof / link | Note |
|---|---|---|---|
| 1 Safety sheet (off by default) | MERGED | #2468 (fd3206e53); rendered: off (no safety page), on with 3 products, on with 38 products (all 38 rows, flowing onto a second safety page) | **Mason decision 2026-11-24:** "were not going to print safety info by defualt it will normally be off but if selected it all print on its own sheet". Replaces "safety on every page". New print option "Print safety sheet" (off); a saved preference from before reads as off. Lists exactly the job order's product lines; every safety value (EPA no., signal word, REI, PHI) read at print time from that line's own product record (by id; Job Detail now passes the line's product id, orchestrator 2026-11-24). **Mason 2026-11-24, "Yes, today's records":** the safety sheet shows today's product records and says "From product records on <print date>"; the job order itself keeps its own saved REI/PHI; a # column gives each row's job order line; a missing value prints "See label"; a failed read prints "could not be loaded". Touches `JobDetail.tsx` (Sol). The Enhanced/Custom tank-mix table keeps its existing REI/PHI columns. **Mason 2026-11-24, "Today's only, no flag":** no flag when a job's saved interval is longer than today's record (Sol finding skipped by Mason; `docs/manual/decision-log.d/2026-11-24-pr2468-*`) |
| 2 Map pages only print | MERGED | #2458 (652da1d25) | Maps only; a job with no maps refuses plainly. `JobDetail.tsx` lease released on merge |
| 3 Spray-order numbers on maps | MERGED | #2455 (5f375e8be) | Overview labels `N · acres`; per-field page title `Stop N`; numbers restart per job (test) |
| 4 Directions link per field | MERGED | #2456 (66061d332) | Tappable Google Maps link per mapped field, in stop order, under the field table |
| 5 Loader water to add + finished gallons | MERGED | #2466 (b634db721); rendered: tank loads, condensed, one batch, overfill, and a dash with its note for a form not on file, a liquid sold by weight, and a missing amount | **Mason 2026-11-24: "Yes, only when known".** Water to add shows only when every product record says liquid or dry and every liquid sizes to gallons; otherwise a dash and "set liquid/dry on the product" (or the amount/unit reason). No guessing from the unit |
| 6 EPA dash / Unknown | PARKED ("Unknown" half) | dash: already prints for any blank number (`applicatorSheetPdf.test.ts`, blank and null rows) | No product value says a product is EPA-registered (`products.epa_registration` is the number only; `epa_registrations` is keyed by the number). "Unknown" needs that flag: asked below |

Paperwork follow-ups (logged, not fixed; none touches money, stock or data):

- Map pages only is hidden on a saved job that has mapped fields but no chemical lines yet (the button sits in the chemical-gated print group). Codex P2 on #2458.
- #2468 MED: a tab left open across the deploy can save print options without the safety choice (reads as off, the safe default).
- #2468 MED: in a batch print, a failed safety read shows only inside that job's PDF, not as a toast.
- #2468 LOW: safety continuation pages don't repeat the record date.
- #2468 LOW: the 40-row test checks table rows, not a rendered page 2 (covered by a render before merge).

## Needs another lane

| Asked by | Owning lane | What | Done? |
|---|---|---|---|
| Paperwork (group 6) | Database | A product value that says "this product is EPA-registered" (so a registered product with no number prints "Unknown" and an unregistered one prints a dash, KI-206). Today nothing tells the two apart | |

## Disputed review findings (for the slice batch)

The repo is public: one-line summaries only, no customer data, and no exploit detail for an open access bug (AGENTS.md › Public security write-ups).

| PR | Sol run (head sha) | Finding | Lane's position | Disposition / follow-up |
|---|---|---|---|---|
