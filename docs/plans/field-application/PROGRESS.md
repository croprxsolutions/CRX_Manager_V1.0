# Field application: progress

Each lane writes only its own section. States (`BUILD-PLAN.md` › Rules 5): NOT STARTED, IN PROGRESS, IN REVIEW (PR open), MERGED (in staging), VERIFIED (applied on staging, scenarios re-run there), READY FOR RELEASE, LIVE, PARKED (reason), BLOCKED (on what), WAITING ON MASON.

`JobDetail.tsx` lease: none.

## Kit

| Item | State | Note |
|---|---|---|
| Master copies (SPEC, contracts, scenarios, build plan) | IN REVIEW | Draft PR #2415; Sol round 1 and the Opus buildability review resolved 2026-11-24 |
| Mason's go-ahead to start slice 0 / 1 | WAITING ON MASON | M7: "not yet" |

## Mason batches (one message per slice; Claude's recommendation first)

| Slice | Ask | Recommendation | Answer |
|---|---|---|---|
| 0–1 | Go for slices 0 and 1 (M7) | Yes, once the kit is merged into staging | |
| 0–1 | Date for Taha's live reset (#2407), and the yes to fill, re-stamp and apply it | A date before mid-December, agreed with Taha | |
| 0–1 | Any staging-only migration that changes today's live billing (only if slice 0 finds one) | Per slice 0 step 3 | |
| 0–1 | FP-1 `I approve` (customer foreign key to restrict; revoked writes on `field_billing_defaults`) before its live apply | Yes | |
| 0–1 | Where the Chem Man export file lives (private, outside the repo), and the yes for the one live import after the reset | A private folder Mason names | |
| 0–1 | Staging test login for any role missing from `docs/reference/qa-testing.md` | Create only what is missing | |
| 2 | Go for slice 2; FP-3 and FP-4 `I approve`; applicator extra-field permission; the mix-site account; `field_batch_stock_enabled` on in production at release; book the posting window with Taha | Yes to each | |
| 3 | Go for slice 3; engine grants `I approve`; Edge Function deploy; at release: posting switch on for the pilot, then the billing switch-on date | Yes to each, in that order | |

## Slice 0

| Item | State | Note |
|---|---|---|
| Kit merged into staging | NOT STARTED | docs-only PR |
| Tooling: registry and types from staging | NOT STARTED | before any field migration merges |
| Taha's live reset (#2407) | WAITING ON MASON | merged into staging; live apply needs the batch yes |
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
| Paperwork fixes | NOT STARTED | | |

## Needs another lane

| Asked by | Owning lane | What | Done? |
|---|---|---|---|

## Disputed review findings (for the slice batch)

| PR | Finding | Lane's position |
|---|---|---|
