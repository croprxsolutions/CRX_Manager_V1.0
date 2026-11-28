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
| 2 | Go for slice 2's database work into staging | Yes | **Yes** (2026-11-25, "Yes, split it"): database work into `staging` only. Codex owns the Google Maps build (design steps 0–1, `docs/research/2026-11-24-google-maps-design.md`); slice 2's dispatch and phone map screens wait for that engine swap. No slice 2 migration merges until the applicator data-access fix (database half of #2574, Field Setup lane) is in staging |
| 2 | Applicator extra-field permission; the mix-site account; Taha's reviews booked after 12-15 | Yes to each (asked 2026-11-25) | **Yes, all three** (Mason, 2026-11-25): extra field allowed (field name and acres only, flagged for the office); one applicator-role mix-site account; Taha's reviews of FP-4, FP-3 and the posting window booked for the week of 12-15 |
| 2 (at release) | `field_batch_stock_enabled` on in production; the `main` merge; each live apply; any production smoke write; who watches errors the first day | Asked at release, not before | |
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
| FP-1 field splits + payer notes | MERGED | #2487 (`20270305190000_field_split_versions`), follow-up #2539 (`20270307150000_field_owner_change_refreshes_copy`); staging applies passed (db-apply runs 45629192766, 45672118827) | Screen half #2498 + #2558 merged. VERIFIED waits on the scenario re-run on staging (thin end-to-end check, slice 2 database lane) |
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

Staging check 2026-11-24 (staging.croprxsolutions.app, test job JOB-2026-0016 on two TEST fields; downloads approved by Mason):

- PASS 1 safety sheet: the option is off by default. Turned on, page 2 reads "Safety — Signal Word, REI, PHI · From product records on 11/24/2026", with "See label" for blank values. Turned off, there is no safety page.
- PASS 4 directions: "Directions to each field", Stop 1 and Stop 2 with "Open directions", in route order.
- PASS 5 loader panel: 300 gal finished and 295 gal water to add per tank (2,4-D at 640 fl oz = 5 gal), plus "Dry products are not counted as volume in water to add."
- PASS 2 refusal: on a job with no maps, Map pages only says "This job has no field maps to print."
- NOT SEEN 2 and 3 map pages: staging has no `VITE_MAPBOX_TOKEN` (the console says it skips maps), so no map page renders on staging. Proven by local renders before merge. Needs the staging map token (environment setting, Mason's call).

Paperwork follow-ups (logged, not fixed; none touches money, stock or data):

- Map pages only is hidden on a saved job that has mapped fields but no chemical lines yet (the button sits in the chemical-gated print group). Codex P2 on #2458.
- #2468 MED: a tab left open across the deploy can save print options without the safety choice (reads as off, the safe default).
- #2468 MED: in a batch print, a failed safety read shows only inside that job's PDF, not as a toast.
- #2468 LOW: safety continuation pages don't repeat the record date.
- #2468 LOW: the 40-row test checks table rows, not a rendered page 2 (covered by a render before merge).

## Slice 1 · Field Setup screen

| Item | State | Proof / link | Note |
|---|---|---|---|
| FP-1 screen half (split versions, history, payer notes, retry key) | BUILT, WAITING ON FP-1 | Luna clean of BLOCKER/HIGH at `8c46c5094` (round 7) | Branch `feat/field-1.1-setup-screen`, not pushed. Next: stack on the FP-1 branch once pushed, Sol, browser proof on staging. Merges only after FP-1 is VERIFIED on staging, rebased on fresh `origin/staging` and re-proved in the browser |
| Set Primary removed; main payer is the database rule (owner if paying, else largest share) | DONE (Mason, 2026-11-24) | | PR body must say it reaches live in the SAME release as FP-1 |
| Split changes start today; start-date picker removed | DONE (Mason, 2026-11-24) | | Until FP-4; payer notes are office only (read from `field_payer_notes`) |
| Save locks the page and reloads fresh | DONE (Mason, 2026-11-24) | | Replaced keep-editing-and-merge after the save/reload logic drew a HIGH in Luna rounds 2, 4 and 5 |
| Different product and application shares | DEFERRED to FP-4 | | Screen shows both columns but refuses unequal shares with the database's plain message until FP-4 |
| Note edited on a payer then removed before save | DONE | | Sent when that payer already has a saved note on the field (FP-1 keeps those editable) |

## Slice 2

Briefs (2026-11-25, from the merged slice 1 code): `docs/loops/field-app-s2-db.md`, `field-app-s2-crew.md`, `field-app-s2-office.md`. No lane is running yet.

| Item | State | Note |
|---|---|---|
| Start gate: applicator data-access fix (database half of #2574) | BLOCKED (Field Setup lane building it) | Only database writer until it merges into staging; every slice 2 applicator read follows its safe-column shape |
| 2.1 Loads and stock | NOT STARTED | Can merge before 12-15 if `jobs.stock_path` is set by a `jobs` insert trigger (no quote or booking writer edited) and vendor lines keep `customer_supplied = true` (so Taha's holds and purchasing-plan readers stay right untouched) |
| 2.2 Work entries and statuses | NOT STARTED | New `ready_for_review` status must count as open work in the customer-deactivation guard Taha's #2526 rewrites; extra-field read function waits on Mason's yes |
| 2.3 Application services | NOT STARTED | Must not change commission writers (Taha's #2525) |
| 2.4 FP-4 jobs carry splits | PARKED until after 2026-12-15 | Quote-to-job writer (Taha); needs FP-2 |
| 2.5 Review checks | NOT STARTED | |
| 2.6 FP-3 archive fields | PARKED until after 2026-12-15 | Taha reviews (BUILD-PLAN) |
| 2.7 Mixer account | NOT STARTED | Mason said yes 2026-11-25; created after loads and stock is on staging |
| Crew and office screens | NOT STARTED | Dispatch board and phone maps wait for the Google Maps engine swap (Codex, steps 0–1) |

## Needs another lane

| Asked by | Owning lane | What | Done? |
|---|---|---|---|
| Paperwork (group 6) | Database | A product value that says "this product is EPA-registered" (so a registered product with no number prints "Unknown" and an unregistered one prints a dash, KI-206). Today nothing tells the two apart | |

## Disputed review findings (for the slice batch)

The repo is public: one-line summaries only, no customer data, and no exploit detail for an open access bug (AGENTS.md › Public security write-ups).

| PR | Sol run (head sha) | Finding | Lane's position | Disposition / follow-up |
|---|---|---|---|---|
