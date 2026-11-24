# Field application: build waves

**Status: PLAN, Sol round 1 folded in (2026-11-24). Nothing here authorizes building; Mason starts each wave.** Design: `SPEC.md`. What exists today: `GAP-CHECK.md`. Money and stock cases: `SCENARIOS.md`. Progress: `PROGRESS.md`. Goal briefs: `GOALS.md` and `docs/loops/field-app-*.md`. Sol finding numbers: `SOL-KIT-REVIEW.md`.

**Deadline:** the core flow is live by **February 1, 2027** [GR1]: create job, print sheets, mixer confirms the load (stock leaves), applicator logs acres, office review, invoices per payer. Tenders, sprayer balances, offline phones and totes come before the April rush. No reporting features until the system is built [GR12].

## How the waves stay safe

1. **Foundation first.** The database and the billing math go in before the screens that use them. A screen may be **built** against an accepted contract before its database PR lands, but it **merges** only after the database items it needs are live on staging and the registry and generated types are refreshed (Sol 101). Each item below names its merge gates.
2. **One database lane.** Every migration PR goes through a single lane, one after another, each through staging apply and `regen-schema-registry` before the next starts (Sol 107). Shared database functions have one owner per wave (named in the item); no other item re-emits them.
3. **Screen lanes run beside it** when each owns its own files. Each goal brief lists the files it **owns**. Shared files and their owner: `src/pages/JobDetail.tsx` (wave 1: 1.4 may add one entry to the existing print menu and nothing else; wave 2: 2.3's screen PR for the FP-4 readers; wave 3: 3.2; Sol r2 105, 106), `src/App.tsx` routes (the lane adding a page, one route line, rebased before merge), `src/types/index.ts` and `.claude/schema-registry.json` (database lane only), `docs/manual/*` ledgers (database lane). `PROGRESS.md`: each lane writes only its own section (Sol 105, 106).
4. **Each lane = one goal session in its own worktree** under `C:\CRX_wt\field-<lane>`, branch from current `origin/staging`, PRs into `staging`. **At most three at once:** the database lane plus two screen lanes. More, and review becomes the bottleneck.
5. **Money, stock, data and permission items follow plan-contract** before code, then Luna and Sol on the PR, then every `ship.md` gate. Each item's contract must answer the Sol IDs listed for it below ("must address").
6. **Taha's areas are not touched before 2026-12-15:** job holds (`inventory_holds`, `_sync_job_holds`), quotes, bookings, the shared posting functions, credit memos and month close. Items needing them are scheduled after that date and Taha reviews them. "Needs Taha's eyes" never means "may touch early" (Sol 099).
7. **Mason's rules for the field:** flags and notes, not blocks; no extra crew or office steps. Review flags are worked out from saved loads and work entries and shown on the existing review screen, not new queues (Sol 136). A reviewer finding that adds friction is brought to Mason, not built by default.
8. **Mason's yes in the conversation is needed for** every `I approve` gate in the build sheet (FP-1's delete foreign-key change and revoked grants, FP-4 and FP-5a grant changes), any login or permission change (the tablet account, 2.2), any Edge Function deploy (the invoice PDF, 5.2), deleting data, and every release to production (Sol 096, 120, 128). A reviewed migration is not that yes.

## Wave 0: settle before building (this kit; no app code)

| # | Item | Output | Done when |
|---|---|---|---|
| 0.1 | Spec, scenarios, waves, contracts, goal briefs | This folder, reviewed by Sol | Sol rounds closed, disputes listed |
| 0.2 | Mason's morning answers | `MORNING-QUESTIONS.md` answered and folded in | M1–M9 answered |
| 0.3 | Fold the kit into the fields-who-pays build sheet: per-field pricing (FP-5a's 10.01 pin → 5.01 + 5.01), leftover-cent rule (M1), no flat fees on job drafts, dated work-entry splits, precedence table, added-under grower, route table | One docs PR | Sheet and kit agree; nothing left saying "primary payer" |
| 0.4 | The five staging-only field-billing migrations (GAP-CHECK §1): **one decision per migration** (release now, hold for 4.1, or replace), each with what it changes for today's billing (Sol 095) | A table in `GAP-CHECK.md`; any release goes in a normal release PR (Taha or Mason merges) | Each of the five has a decision |
| 0.5 | Read-only facts the contracts mark UNVERIFIED: which `complete_job` body and triggers each database runs; PR #1650's policies are live (Sol 097); the importer's payer support (Sol 113) | Notes in the contracts | Each fact confirmed or the contract changed |

**Wave 1 does not start until 0.2 and 0.3 are done and Mason says start** (Sol 094; M7 on 2026-11-24 was "not yet"): goals must not build on conflicting instructions.

## Wave 1: foundation (late November → mid December)

| Lane | Item | Gap rows | Size | Tags | Merge gates | Must address (Sol IDs) |
|---|---|---|---|---|---|---|
| DB | **1.1 FP-1** field split groups with history; store the grower each field was added under | 2, 4 | L | DB $ | 0.3; Mason's `I approve` for the foreign key and grants | 070, 096, 132 |
| DB | **1.2 FP-2** billable acres and acre rules (blank is not zero) | 5 | S–M | DB $ | 1.1 live | 053 |
| DB | **1.3 Batches and stock** (`CONTRACT-batch-stock.md`): loads, revisions, carry-out, stock path per job, KI-187 closed for batch jobs | 27, 30 | L | DB $ | 0.5 facts | 021–046, 048, 133 |
| UI-A | **1.4 Paperwork fixes** (no database change): REI/PHI on every page, tank contents hidden, map pages only, spray order on maps, directions link, loader water vs finished in the loader's units | 12–16, 9a | M | | none | 111, 131 |

## Wave 2: the crew screens (December)

| Lane | Item | Gap rows | Size | Tags | Merge gates | Must address |
|---|---|---|---|---|---|---|
| DB | **2.1 Work entries and statuses**: work entry linked to a load revision, Applied and Ready for review, cancel rules (M4), own-entry edits end at close, `jobs.priority` dropped, rig default gal/acre, EPA "not registered" flag (shown on the as-sprayed record) | 32–38, 47, 48, 7, 17 | M | DB $ | 1.3 live | 047, 049–056, 061, 112 |
| DB | **2.2 Tablet sign-in** (mixer-only account; `/security-review`) | 31 | S | DB 🔒 | Mason's yes | (security review) |
| DB | **2.3 FP-4** jobs carry the field's split snapshot | 4 | M–L | DB $ | 1.1 live; #1650 live; `I approve` grants | 069, 070, 097 |
| UI-A | **2.4 Mixer tablet screen**: queue, solution needed, carried-in leftover, per-load mix edits with office flag, name pick | 24–26, 31 | M–L | $ | **1.3 and 2.2 live** (Sol 100) | 028, 036, 062 |
| UI-B | **2.5 Applicator phone**: Now buttons, gauge reading, pause note, Job done, add extra field, duplicate warning | 32–37 | M–L | | 2.1 live | 050, 052, 054, 063, 065 |

**Thin end-to-end slice (Sol 135), target December 20 on staging:** one test job created and printed, one load confirmed on the tablet (stock leaves once), acres logged on the phone, the job closes. No billing yet. If this slips, wave 3 screens wait and the slice gets the lanes.

## Wave 3: office review and job close (late December → early January)

| Lane | Item | Gap rows | Size | Tags | Merge gates | Must address |
|---|---|---|---|---|---|---|
| DB | **3.1 Review checks**: missing vs zero, solution accounted for, 5% check per load, label max as a warning with a note, close remaining acres | 39–47 | M | DB $ | 2.1 live | 053, 057–060, 062, 064 |
| DB | **3.4 Partial hold release** for batch jobs (Taha's holds; his review) | 27 | M | DB $ | after 2026-12-15; 1.3 live | 034, 035 |
| UI-C | **3.2 Office review screen** and the mixed / used / billed view (owns `JobDetail.tsx`) | 39–48a | M–L | $ | 3.1 live | 040, 064, 065 |
| UI-A | **3.3 Scheduling**: field picker by any payer share, rig carrier default, daily board by rig, job-level multiple applicators, mid-job rig change, warehouse default (Sol 112). No `JobDetail.tsx` edits | 2, 6–11, 17 | M | | 2.1 and 2.3 live | 112 |

## Wave 4: one billing calculation (January)

| Lane | Item | Gap rows | Size | Tags | Merge gates | Must address |
|---|---|---|---|---|---|---|
| DB | **4.1 FP-5a + field rules** (`CONTRACT-field-billing.md`): the one engine, route table, refusals, posting-switch entry points (owns the `post_invoice` guards; Sol 103), credit-hold behavior for field billing (Sol 118) | 49–53, 55, 56, 58, 62 | L | DB $ | 1.2, 2.3, 3.1 live; `I approve` grants | 066–078, 082, 090, 091, 118, 132, 134 |
| UI-B | **4.2 Draft review screens**: field sections, "your share", "Shared with", per-line override, invoice date | 54, 55 | M | $ | 4.1 live | 092 |

## Wave 5: posting, statements, corrections (January, after 2026-12-15)

| Lane | Item | Gap rows | Size | Tags | Merge gates | Must address |
|---|---|---|---|---|---|---|
| DB | **5.1 FP-5c + posting**: set posting, any rep posts field sets, commission per payer, unpost/repost "Corrected", credit and rebill. Taha reviews | 59, 61 | M–L | DB $ | 4.1 live | 079–089, 093 |
| UI-A | **5.2 Invoice PDF and email** per payer (each payer's document built from their own invoice only). Starts after 4.1 fixes the draft shape; Edge Function deploy needs Mason's yes (Sol 104, 128) | 54, 57 | M | | 5.1 live; Mason's yes to deploy | 092, 128 |

## Wave 6: go-live (January 16–31)

1. **Integration window, January 16–31** (Sol 108, 109): the database lane is done by about **January 15**; only fixes merge in this window.
2. Every SCENARIOS case on staging, as the real roles, expected vs observed recorded (Sol 126).
3. Field import from the Chem Man export, only after step 5's live reset has run (Sol r2 114): a staging dry run in wave 3, then production with Mason's yes, a reconciliation count and a repeat-safe rerun (Sol 113).
4. **Chem Man cut-off** (Sol 115, r2 157): decided **per work entry's spray date**, not per job: work sprayed through December 31 is billed in Chem Man; CRX bills work sprayed from January 1, even on a job that spans both.
5. Test data: Taha's one-time live reset (PR #2407) is merged to staging but **not applied live**; it backs up and then deletes a wide set of live records, field data among them, so it must run **before any real field job exists** (Taha and Mason set the date; GAP-CHECK row 61a). Any further cleanup is listed item by item for Mason's yes; real jobs are **archived**, never deleted (Sol 114, 117). The archive path (FP-3) is built in wave 3 or 4, not spring.
6. Release to production (Taha or Mason merges), with the evidence in `GOALS.md` › Release evidence (Sol 130).
7. **Pilot:** posting is switched on; the first real multi-payer job is checked by hand with the checklist [D12] before its invoices are sent (Sol 127).

## Spring (February → April)

Tender and sprayer balances and fills, totes, offline phones, crop-coloured maps and neighbour toggle, map/ink print options, FP-5b blend tickets on the same engine, per-payer prices on one field (M2), FP-6 orders (after Taha's #1524 and #1534 are live), FP-7 (slot and owner set in February). Reporting stays unbuilt until Mason asks [GR12].

## If wave 4 or 5 is late (Sol 116)

`MORNING-QUESTIONS.md` M5. Recommended: keep billing field work in Chem Man until CRX's field billing passes wave 6; never fall back to planned acres.

## What can run at the same time

| Weeks (approx.) | DB lane | Screen lane A | Screen lane B/C |
|---|---|---|---|
| Nov 25 – Dec 6 | (0.2, 0.3 first) 1.1 → 1.2 | 1.4 paperwork | — |
| Dec 7 – Dec 20 | 1.3 → 2.2 → 2.1 | 2.4 mixer (merges after 1.3 + 2.2) | 2.5 phone (merges after 2.1) |
| Dec 21 – Jan 3 | 2.3 → 3.1 → 3.4 | 3.3 scheduling | 3.2 review |
| Jan 4 – Jan 15 | 4.1 → 5.1 | 5.2 PDF (after 4.1) | 4.2 drafts |
| Jan 16 – Jan 31 | fixes only | wave 6 checks | wave 6 checks |

The database lane is the critical path: about eleven PRs (1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.4, 4.1, 5.1, FP-3), each through plan-contract, Luna, Sol and the staging apply. **This calendar is tight** (Sol 109): 4.1 and 5.1 in under two weeks is the biggest risk. If the database lane slips, screens wait; more screen lanes do not help. M5 is the fallback.
