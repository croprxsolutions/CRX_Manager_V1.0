# Field application: build plan

**Master copy (2026-11-24); replaces the earlier wave and goal files (git history). Nothing here authorizes building: Mason starts each slice (M7 on 2026-11-24 was "not yet").** Design: `SPEC.md`. Contracts: `CONTRACT-who-pays.md`, `CONTRACT-batch-stock.md`, `CONTRACT-field-billing.md`. Numbers: `SCENARIOS.md`. Progress: `PROGRESS.md`.

**Deadline:** the core flow live by **February 1, 2027** [GR1]; tenders, balances, offline phones and totes before the April rush. No reporting features until Mason asks [GR12].

## Go live in slices (Mason, 2026-11-24)

Each slice is released to production on its own, so the crew uses CRX before billing depends on it. **Chem Man keeps billing field work until slice 3's switch-on date** [M5].

| Slice | Target | What goes live | Database PRs | Screens |
|---|---|---|---|---|
| **0 Clear the ground** | before any real field job exists | Taha's one-time live reset (PR #2407, `20270301100000`: backs up, then deletes a wide set of live test records, field data among them; date set by Taha and Mason, Mason's yes). Decide each of the five staging-only field-billing migrations below, and whether `20270227170000_job_completion_missing_stock_rows` (staging only) releases first or rides with the loads PR. Confirm the read-only facts the contracts list | — | — |
| **1 Who pays + paperwork** | mid-December | Field splits with history and two share sets; billable acres; paperwork fixes; Chem Man fields imported | FP-1, FP-2 | Field Setup split history; paperwork (no database change): safety info on every page, hide tank contents, map pages only, spray-order numbers on maps, directions link, loader water vs finished gallons in loader units, loader views (one batch or tank-sized loads), a dash for a product with no EPA number |
| **2 Crew on CRX** | early January | Jobs carry splits; mixer confirms loads (stock leaves at the load for new jobs); applicators log acres; office review closes jobs; fields archived not deleted. **No CRX billing yet** | loads and stock; work entries and statuses; mixer account; FP-4; review checks; FP-3 | mixer tablet; applicator phone; scheduling (field picker by any payer share, daily board by rig, rig carrier default); office review screen with mixed / used / billed view |
| **3 Billing** | the switch-on date Mason picks after staging passes | Per-payer invoices the chemical-sale way, posting as a set, corrections, PDF and email; work before the switch-on date stays billed in Chem Man | billing engine; posting | unposted invoice review (field sections, your share, Shared with, per-line override, invoice date); per-payer PDF and email (Edge Function deploy: Mason's yes) |

**About ten database PRs**, one after another in the database lane: FP-1, FP-2, loads and stock, work entries, mixer account, FP-4, review checks, FP-3, billing engine, posting. The database lane is the critical path; more screen lanes do not speed it up.

**Thin end-to-end check, December 20 on staging:** one test job created and printed, one load confirmed on the tablet (stock leaves once), acres logged on the phone, the job closes. If it slips, screens wait and the slice gets the lanes.

### Database PR details

| PR | Contract | Needs first | Scenarios it proves |
|---|---|---|---|
| FP-1 field splits | who-pays FP-1 | slice 0; Mason's `I approve` (foreign key, revoked grants) | fixture set |
| FP-2 billable acres | who-pays FP-2 | FP-1 live on staging; after 2026-12-15 (its quote-to-job change, Taha reviews) | S20 |
| Loads and stock | batch-stock | read-only facts confirmed | S11–S15, S18, S19 |
| Work entries and statuses | SPEC stages 6–7: entry linked to a load revision, Ready for review / Applied, cancel only at zero acres (Q9, Sol 11), rained out ends with nothing billed (M4), own-entry edits end at close, `jobs.priority` dropped, rig default gal/acre | loads and stock | S21, S27 |
| Mixer account | SPEC section 2 (GR4); `/security-review`; Mason's yes for the role. If late, mixers use their own logins and this PR waits | — | role cases |
| FP-4 jobs carry splits | who-pays FP-4 | FP-1; `I approve` (grants) | S7 (planned split) |
| Review checks | SPEC stage 8: missing vs zero, leftover recorded (5% gauge gap), 5% rate check per load, label max warning with note, close remaining acres, shared-load wait | work entries | S16, S17, S20 |
| FP-3 archive fields | who-pays FP-3 | FP-1; `I approve` (grants) | archive cases |
| Billing engine | field-billing (all but posting) | FP-2, FP-4, review checks; `I approve` (grants) | S1–S4b, S6–S10, S20, S23, S26, S29–S31 |
| Posting | field-billing › Authority and timing (posting), Posting switch, B9–B11 | billing engine; window agreed with Mason and Taha for the one refusal in the shared post functions; Taha reviews | S22, S24, S25, S28 |

**Five staging-only field-billing migrations** (marked "LOCAL CANDIDATE — NOT APPLIED"): `20270224110000_retire_per_acre_field_pricing`, `20270224130000_split_save_refuses_blend_billed_job`, `20270226150000_job_transfer_below_cost_whole_line`, `20270205100000_field_app_refuses_payer_change`, `20270228200000_field_app_save_refuses_other_editors`. Slice 0 records one decision each (release now, hold for the billing engine, or replace) with what it changes for today's billing; any release goes in a normal release PR.

## Moved to spring (2026-11-24)

| Item | Why it can wait | Cost of waiting |
|---|---|---|
| Partial hold release per load | Needs Taha's `inventory_holds`; holds release whole at job close as today | A long job shows less available than is on the shelf |
| Leftover tracked as a claim, with mix and customer flags | The rig's next load shows the leftover as carried in; the office's mix-differs review catches a mismatch | A carried mix used on a different recipe is caught by review, not flagged at once |
| One-click "bill actual used" (G5, S5) | The office keeps planned or edits quantities with a reason | One more manual edit when a load is over 5% |
| Possible-duplicate-load flag | Retry keys already stop double taps | Two tablets confirming one tank is caught at review |
| Per-payer prices on one field (M2) | One price per product per job in February | — |
| Tenders, sprayer balances, totes, offline phones | GR1 | Paper fallback on the tablet |
| Blend-ticket billing on the engine; orders and deliveries reading field shares; final boundary check | Not on the February path | — |
| Crop-coloured map toggle; map print window and ink saver | Nice to have | — |

## How the work stays safe

1. **Foundation first.** A screen may be built against an accepted contract before its database PR lands, but it **merges** only after the database PRs it needs are live on staging and the registry and generated types are refreshed.
2. **One database lane.** Migrations go one after another, each through staging apply and `regen-schema-registry` before the next starts. Shared database functions have one owner at a time.
3. **Screen lanes beside it**, each owning its own files, **at most three sessions at once** (the database lane plus two screen lanes). Shared files: `src/pages/JobDetail.tsx` (one lane at a time, named in `PROGRESS.md`), `src/App.tsx` (one route line per page lane, rebased before merge), `src/types/index.ts` and `.claude/schema-registry.json` (database lane only), `docs/manual/*` ledgers (database lane). Each lane writes only its own `PROGRESS.md` section.
4. **Each lane is one session in its own worktree** under `C:\CRX_wt\field-<lane>`, branched from current `origin/staging`, PRs into `staging`. Briefs live in `docs/loops/field-app-*.md`; later briefs are written when the slice before ends, from what was really built.
5. **Money, stock, data and permission PRs:** plan-contract (these contracts count once Sol has challenged them), then Luna until clean, then Sol once before the PR, then every `ship.md` gate. Sol is capped at two rounds per plan; leftovers go to Mason [M6]. A reviewer finding that adds a crew or office step goes to Mason, not into code.
6. **Taha's areas are not touched before 2026-12-15:** job holds (`inventory_holds`, `_sync_job_holds`), quotes, bookings, chemical billing (`order_shares`, `order_item_shares`, the Bill Split card), the shared posting functions, credit memos, month close. Items needing them come after that date with his review.

## Rules every session follows

1. **Read first:** `AGENTS.md`, `SPEC.md`, `SCENARIOS.md`, the PR's contract, its own `PROGRESS.md` section.
2. **The kit is the desired behavior; code and live read-only evidence are today.** A difference the kit names (planned vs sprayed acres, flat fees, the rounding rule) is the work. One it does not name, or a fact that turns out different, stops that PR: record it in `PROGRESS.md` and move to the next independent one.
3. **Own only your files.** A change needed elsewhere goes in `PROGRESS.md` › Needs another lane, naming the owner.
4. **Proof:** database PRs run each scenario they cover as SQL on a database migrated to the staging schema, **as the real roles** (admin, sales rep, applicator, mixer, customer), including the upgrade from current staging. Screens are checked in the browser against staging. Expected vs observed goes in the PR. Never production.
5. **States:** NOT STARTED, IN PROGRESS, IN REVIEW (PR open), MERGED (in `staging`), VERIFIED (applied on staging, scenarios re-run there), LIVE, PARKED (reason), BLOCKED (on what), WAITING ON MASON. A slice is done only when every PR is verified.
6. **Stop at once, no retry:** the same BLOCKER or HIGH survives two fix rounds; an unintended live-data change; a gate needs Mason; unclear ownership; a migration that cannot roll back as its contract says; a guard refusal not understood. Write `NEEDS MASON - ...` in `PROGRESS.md` **and** say it in the session's closing message.
7. **Mason's field rule:** flags and notes, not blocks; no extra crew or office steps.

## Delivery gate

- **Allowed without asking:** branches, commits, feature-branch pushes after local checks and Luna pass on that head, PRs into `staging`, and merging into `staging` only under AGENTS.md › Autonomous landing (Sol proof on the current head where required, Luna clean, checks green, no changes requested, the Taha hold rules in `ship.md`).
- **Never without Mason's explicit yes in his own conversation:** every `I approve` gate (FP-1 foreign key and grants, FP-3, FP-4 and billing-engine grants), any login, role or permission change even inside a reviewed migration (the mixer account), anything into `main`, applying a migration to production, deleting or rewriting live data (the slice 0 reset), deploying an Edge Function (the invoice PDF), turning on the batch or posting switch in production, setting the billing switch-on date, changing secrets, force-push.
- **Never:** pushing to Taha's PRs; touching Taha's areas before 2026-12-15.

## Release evidence (each slice)

The release PR and its merge commit; each migration's name and the live ledger showing it applied; the deployed app version; the Edge Function version if changed; a smoke run of the slice's main path as a real role; the rollback point; who watches errors for the first day. Taha or Mason merges to `main`; Claude applies migrations only through the apply-proof gate.

**Slice 3 extra:** every `SCENARIOS.md` case run on staging as the real roles with expected vs observed recorded; posting switched on in production only with Mason's yes; the first real multi-payer job checked by hand with the checklist before its invoices are sent [D12].

## Open questions for Mason

1. **Posting window.** The posting PR adds one refusal to the shared post functions Taha owns: agree a window with Taha (after 2026-12-15).
2. **Reset date.** When Taha's live reset (#2407) runs; slice 1's field import waits for it.
