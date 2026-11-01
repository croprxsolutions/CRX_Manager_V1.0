# Product Master work: START HERE

**Status: PLANNED AND READY, NOT STARTED.** On 2026-10-28 Mason planned the Product Master (product setup) improvements and the weight-per-gallon and active-ingredient work. He had a Sol review settle the game plan, then set up an overnight build. He decided not to start it yet ("let's not actually start the build yet") and asked for everything to be saved so the work can be picked up later. Nothing is built.

**To start the work:** do Mason's checklist in section 3. Wave 0 comes first; then open a new Code session in the CRX Manager project (new worktree) and paste the prompt in section 4.

---

## 1. The documents (all on `main`)

| What | File | Read it for |
|---|---|---|
| **The grand plan (2026-10-29)** | `docs/plans/2026-10-29-product-GRAND-PLAN.md` | All product work in one order: this Product Master work is Stage 1; weight, chemistry, brands, rates, comparison, use guidance, families, clean-up and images follow. Sol-reviewed; it revised the build sheet's order |
| The 43 items | `docs/plans/2026-10-28-product-master-setup-edits-BACKLOG.md` | What's wrong or missing on product setup: Mason's requests (items 1–2) and the review's findings (items 3–43) |
| **The game plan** | `docs/plans/2026-10-28-product-master-BUILD-SHEET.md` | 21 queue entries, including both halves of WP-PM-15: approach, "Done when", size, database impact, Sol's notes, the final order (section 4) and the Sol review record (section 6) |
| **The build loop** | `docs/plans/2026-10-28-product-master-loop-MISSION.md` | How a session builds it: Codex builds, Claude checks and proves, one draft PR per package, nothing merged or applied live. Passes `node scripts/validate-mission-doc.mjs` |
| Weight per gallon and active ingredients | `docs/plans/2026-10-28-product-data-model-REFRESH.md` | The larger feature that follows (To-Do row 2.9), refreshed from the August plan |
| Mason's decisions | `docs/manual/DECISION_LOG.md`: the product entries from 2026-10-28 through 2026-10-30, the 2026-10-30 and 2026-11-01 harness cuts, and the 2026-11-01 run setup | Every business answer, so the build needs no owner input |
| To-Do list | `docs/manual/TO_DO_LIST.md`, rows 2.9 and 2.10 | Where this work ranks (SHOULD, after the before-delivery work) |

The old branch `loop/product-master-2026-10` holds a superseded first draft of the mission file; ignore it. The `main` copy above is the one to use.

## 2. What was decided (summary; the decision log is authoritative)

- **Run setup, 2026-11-01:** a private test copy of the app is built and landed first, so agents can really save and check their work on invented data. After that, one run builds one wave of the queue, and `/goal` keeps the session working. Opus runs it, Codex builds, and Sonnet helpers do searches and doc updates. Larger PRs get a CodeRabbit review. Its free one-time fix is used only on low-risk PRs; Codex fixes everything touching money, inventory or the database (mission section 4a).
- **Sol, 2026-11-01:** Sol covers only the database, logins and permissions, and money and inventory.
- **Rollout decisions, 2026-10-30:** prepare and prove a reviewed everyday-product list first while retaining the full catalog scope and visible remaining data work. Defer complicated duplicate merges or give them a separately reviewed procedure, preserving future returns and history. Build comparison after its required data, trusted rates and relevant use guidance; optional images, groupings and return-policy editing do not delay it.
- **Bulk/tote selling prices:** chemical prices generally match; fertilizer prices can differ. Keep prices independent per size and test both cases. Quantity-first tote filling remains the plan.
- **Chemical comparison:** match a premix's active pounds with selected single-ingredient generics, sum their same-tier per-acre prices, and show savings and equivalent-premix-gallon pricing. Select several premixes or an entire category in one sortable comparison view. Keep each row's rate, component choices and missing-data warnings visible; fertilizer nutrient comparison is withdrawn.
- **Admin company view:** toggle cost-versus-cost or selling price (Tier 1 by default, with tier selection). Show each program's cost, selling price, profit per acre and margin, with internal cost, customer-price and company-profit differences separately labeled. Costs and derived profitability are admin-only; changing comparison mode never changes saved prices.
- **Approved comparison safeguards:** positive comparison rates, shared chosen generic references with marked overrides, active-reference rechecks and separate eligibility/ranking for cost, selling price, profit and margin. Unknown price dates stay unknown.
- **Final business answers, 2026-10-30:** admins may complete missing formulation facts and correct verified mistakes through the evidence-backed, reasoned, version-checked correction in grand-plan overlap 13; genuinely different formulations remain separate, wrongly grouped sizes need reviewed moves, and history/posted amounts stay intact. Inactive products and their stock remain visible internally; new sales require deliberate admin reactivation, while legitimate historical returns/corrections do not reactivate them. See build-sheet WP-PM-3.
- **Broader review disposition:** the two business questions above are answered. Staged parent/brand activation, the PM-8/PM-6a dependency boundary, a safe Use Timing transition and duplicate-lifecycle proof are explicit package requirements, not unanswered owner policy. The affected packages still need their detailed designs, independent review, applicable data approvals and observed proof before activation. No product build has started.

- **Use Timing:** several timings per product. Add Post-Emerge Corn, Post-Emerge Soybeans and Pre-Emerge; keep the generic Post-Emergence. Only Herbicide and Foliar Fertilizer products keep a timing.
- **New products** stay active and open for pricing straight after creation; they don't start turned off.
- **Turning a product off:**
  - blocked by open orders, including delivered orders not yet invoiced;
  - warns, but allows, for open quotes, stock on hand, crop programs and scheduled jobs.
- **Tier order:** Tier 1 has the lowest margin, so a tier priced below the one before it is flagged.
- **New product forms:** seed and each/unit, beside liquid and dry.
- **Corrections:** when a product's REI/PHI or EPA number is corrected, open jobs offer to update. Posted invoices never change.
- **Return-policy editor:** later.
- **Weight and ingredients:**
  - weight per gallon is built first, shown on the loader worksheet and the blend ticket;
  - one value per generic;
  - an admin-only cost-per-lb-of-active comparison.
- **Build setup** (Mason's choice "A"):
  - Codex builds and Claude orchestrates;
  - each package goes on its own branch as a draft PR, and nothing merges during a run; Mason picks what lands between waves;
  - database changes are proven only on a local Docker copy, never live.

## 3. Mason's checklist before starting

**Before the first run:**

0. **The test app (Wave 0).** Its commands and rules are in `scripts/local-app/README.md`. A run needs it on `main` before Wave 1 starts.
1. **Check the CodeRabbit dashboard.** Switch to the `croprxsolutions` organization and confirm the trial end date (last seen 2026-11-11). Confirm there's no per-file review charge, and leave the agent minutes add-on off, so paid fixes stay refused. On the personal `masonwells1` organization, don't click "Remove cancellation". If charges are possible, tell the session to skip CodeRabbit.
2. **Docker Desktop is running.** The database work and the test copy of the app need it. Without Docker, the database packages park.
3. **The PC stays awake**, plugged in with the lid open. The session asks the app to keep it awake, but a closed lid still sleeps.
4. **Context size is automatic; nothing to do.** Your normal setting is 300K. Wave runs need 800K, because one session carries every package's review and proof notes. A session that builds or lands one package, and ordinary work, is fine at 300K. Sonnet helpers, Codex and Sol keep their own separate context.
   - **Starting:** the run checks the setting first. If it's at 300K, it switches to 800K and asks you to open a new session and paste the same prompt, because the change only reaches new sessions.
   - **Finishing:** after the morning report, the run sets it back to 300K. The setting applies to every session, so if a run crashes, say "deep mode off".
   - **By hand:** say "deep mode on", "deep mode off" or "deep mode status". Avoid `/autocompact`: it saves a hidden model-specific value that overrides these switches.
5. **Codex has usage left.** The builder runs on Codex (`gpt-6-sol` for money and database packages, `gpt-6-luna` for screen-only ones).

**To start each run:**

6. **Start it in the desktop app**, in a new session in the CRX Manager project with a new worktree. A session can't be started over Remote Control.
7. **Choose Auto mode for that session before pasting.** `/goal` keeps the turns coming, but without Auto mode the run halts at each permission prompt.
8. **Paste the prompt in section 4.** Pasting it is your go.

**After each run:**

9. **If a run goes quiet,** open it. A usage limit or error can pause or clear `/goal`: send a message or paste the prompt again, and it resumes from the ledger.
10. **Read the morning report** and say which drafted packages should land, ideally within 24 hours, while the Sol reviews are still current.
11. **Your data steps, when the reports ask for them.** The real product lists are in your private vault under `Products\Product Master review`, never on GitHub. Check the screens the report lists as owed, approve the unit mismatch list, type the missing SKUs, approve product fixes and vendor links, choose the everyday-product list, and reply `I approve` when a migration needs it. Wave 2 produces the lists you approve, so it can start first. Work that depends on your approval parks until you give it, and Wave 3 waits as the mission's wave table says.

## 4. The prompt to paste

For a later wave, change all three `1`s to that wave's number.

```text
/goal Build Wave 1 of the mission in docs/plans/2026-10-28-product-master-loop-MISSION.md, start to finish, through .claude/commands/run-loop.md: validate the doc, check for collisions, echo the 3-line summary, then execute without waiting. This message is Mason's go. The overview is docs/plans/2026-10-29-product-master-START-HERE.md.

Follow the mission's Step 0, including its staleness check, and ask the app to keep the PC awake (request_keep_awake, until session_idle). Decisions come from the decision-log entries the mission's contract names.

This goal is met only when your latest message shows the mission's closing line beginning "WAVE 1 FINISHED:", gives every Wave 1 package its final status with its PR link or evidence, and shows the pushed commit of docs/loops/product-master-morning-report.md. Any early end the mission authorizes, or a blocker only Mason can clear, also meets it, once that same message gives every package's status, says "ended early:" and why, and shows the report pushed or its local path. If Step 0 asks Mason for a new session, this goal is met once you have said so.

Never: merge a PR, mark a PR ready, push to main, apply a migration live, write live data, deploy, or touch hooks or .env. Never start the next wave.
```

**To build one package at a time instead of overnight:** in a normal session, say for example "build WP-PM-1 (dropdowns) from the Product Master build sheet". It then goes through the usual ship process to a PR that can merge.

## 5. What to expect

- **Wave 0:** the private test copy of the app (`scripts/local-app/`), built and landed in a normal session.
- **Wave 1:** dropdowns, RUP "known incomplete" notice, "Search EPA labels" link, pricing page, sales sheet and list, reorder display, list editing, then change history if time remains.
- **Wave 2:** turning products off safely, setup checks in the database, forms, units and containers, data clean-up review lists, Use Timing, the Unit audit, new-product flow and basic Duplicate, one cost path and the tier-order warning, the vendor proposal tool, corrections to existing records.
- **Wave 3:** vendor enforcement, setup workbook and the "Lock rates" switch, bulk import. It starts only after the vendor data step and your data clean-up.
- **Size:** 22 queue entries in all: the test copy plus the build sheet's 21.
- **Pace:** an 8-hour run will probably finish 6–10 packages properly. Stage 1 will take several runs, with your data steps between them. Stages 2 to 9 each need a build sheet and review before they can run.
- **Parked for Mason:**
  - the Unit back-fill: Sol's BLOCKER, so audit only, and Mason sees the mismatch list first;
  - the data clean-up itself: Mason types the missing SKUs and approves each fix. Dependent packages may be parked until their prerequisites are available and the data step is done;
  - the vendor-link review and live data transition before the preferred-vendor copy rule is enabled;
  - average purchase-cost tracking for shop-filled totes until the separate inventory-costing foundation has been reviewed, approved where required and activated; the quantity-only first release is planned after PAR-2;
  - any migration that changes grants on `products`, which needs his `I approve`.
- **The morning report** lists, per package: the PR, the proof, what's still owed (including real app proof and applicable Sol gate), when its Sol review expires, what CodeRabbit found, and a suggested merge order. CodeRabbit is required only when labeled.
