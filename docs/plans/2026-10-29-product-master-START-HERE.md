# Product Master work: START HERE

**Status: PLANNED AND READY, NOT STARTED.** On 2026-10-28 Mason planned the Product Master (product setup) improvements and the weight-per-gallon and active-ingredient work. He had a Sol review settle the game plan, then set up an overnight build. He decided not to start it yet ("let's not actually start the build yet") and asked for everything to be saved so the work can be picked up later. Nothing is built.

**To start the work:** open a new Code session in the CRX Manager project (new worktree) and paste the prompt in section 4. Do the checks in section 3 first.

---

## 1. The documents (all on `main`)

| What | File | Read it for |
|---|---|---|
| **The grand plan (2026-10-29)** | `docs/plans/2026-10-29-product-GRAND-PLAN.md` | All product work in one order: this Product Master work is Stage 1; weight, chemistry, brands, rates, comparison, use guidance, families, clean-up and images follow. Sol-reviewed; it revised the build sheet's order |
| The 43 items | `docs/plans/2026-10-28-product-master-setup-edits-BACKLOG.md` | What's wrong or missing on product setup: Mason's requests (items 1–2) and the review's findings (items 3–43) |
| **The game plan** | `docs/plans/2026-10-28-product-master-BUILD-SHEET.md` | 18 work packages (16 on 2026-10-28, plus WP-PM-14 and DM-0 from the grand plan; see its section 2a): approach, "Done when", size, database impact, Sol's notes, the final order (section 4) and the Sol review record (section 6) |
| **The build loop** | `docs/plans/2026-10-28-product-master-loop-MISSION.md` | How a session builds it: Codex builds, Claude checks and proves, one draft PR per package, nothing merged or applied live. Passes `node scripts/validate-mission-doc.mjs` |
| Weight per gallon and active ingredients | `docs/plans/2026-10-28-product-data-model-REFRESH.md` | The larger feature that follows (To-Do row 2.9), refreshed from the August plan |
| Mason's decisions | `docs/manual/DECISION_LOG.md`, the three 2026-10-28 entries (Product Master backlog; product data model) | Every business answer, so the build needs no owner input |
| To-Do list | `docs/manual/TO_DO_LIST.md`, row 2.9 | Where the weight/ingredient work ranks (SHOULD, after the before-delivery work) |

The old branch `loop/product-master-2026-10` holds a superseded first draft of the mission file; ignore it. The `main` copy above is the one to use.

## 2. What was decided (summary; the decision log is authoritative)

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
  - each package goes on its own branch as a draft PR, and nothing merges until Mason picks what to merge;
  - database changes are proven only on a local Docker copy, never live.

## 3. Before starting

1. **Docker Desktop is running.** The database packages are proven on a local PostgreSQL 17 copy. Without Docker, they park and only the screen packages get built.
2. **The PC stays awake**, plugged in with the lid open. The session asks the app to keep it awake, but a closed lid still sleeps.
3. **Auto-summarize is set for a long run.** In a `claude` terminal, run `/autocompact 800000`; it takes effect for the next session. Set it back to `300000` afterwards.
4. **Codex has usage left.** The builder runs on Codex (`gpt-6-sol` for money and database packages, `gpt-6-luna` for screen-only ones).
5. **Start it from the desktop app.** A session can't be started over Remote Control.
6. **The grand plan's questions are answered** (Mason, 2026-10-29; `docs/plans/2026-10-29-product-GRAND-PLAN.md` section 10). Check for any later changes Mason sends after reading the plan.

## 4. The prompt to paste

```text
Run the mission loop in docs/plans/2026-10-28-product-master-loop-MISSION.md start to finish, using the project's run-loop launcher (.claude/commands/run-loop.md): validate the doc, check for collisions, echo the 3-line summary, then execute without waiting. This message is Mason's go.

Step 0: git fetch origin, then create your coordinator branch loop/product-master-<today's date> from origin/main (ignore the old loop/product-master-2026-10 branch). Push ledger and morning-report commits to it. Do the mission's staleness check: main has moved since the plan was written on 2026-10-28. Ask the app to keep the PC awake for the run (request_keep_awake, until session_idle).

The scope is docs/plans/2026-10-28-product-master-BUILD-SHEET.md (its section 4 is the order). Mason's decisions are in docs/manual/DECISION_LOG.md (the 2026-10-28 Product Master entries). The overview is docs/plans/2026-10-29-product-master-START-HERE.md.

Done: every package DRAFTED (its own pm/* branch, pushed, draft PR to main, PROOF line in docs/loops/product-master-ledger.md) or PARKED with a reason; docs/loops/product-master-morning-report.md pushed on the loop branch; a plain-English summary leading with status and one next step.

Never: merge, mark a PR ready, push to main, apply a migration live, write live data, deploy, or touch hooks or .env. Never stage untracked .agents/skills/source-command-* folders.
```

**To build one package at a time instead of overnight:** in a normal session, say for example "build WP-PM-1 (dropdowns) from the Product Master build sheet". It then goes through the usual ship process to a PR that can merge.

## 5. What to expect

- **Order:**
  1. dropdowns
  2. RUP "known incomplete" notice
  3. pricing page
  4. sales sheet and list
  5. change history
  6. turning products off safely
  7. setup checks in the database
  8. forms, units and containers
  9. data clean-up review lists (forms, SKUs, duplicates)
  10. Use Timing
  11. the Unit audit
  12. new-product flow and basic Duplicate
  13. one cost path and the tier-order warning
  14. bulk import
  15. detail workbook
  16. list editing
  17. corrections to existing records
  18. reorder display
- **Pace:** an 8-hour run will probably finish 6–10 packages properly; the rest queue for another run.
- **Parked for Mason:**
  - the Unit back-fill: Sol's BLOCKER, so audit only, and Mason sees the mismatch list first;
  - the data clean-up itself: Mason types the missing SKUs and approves each fix. Bulk import and the detail workbook stay as draft PRs until it is done;
  - any migration that changes grants on `products`, which needs his `I approve`.
- **The morning report** lists, per package: the PR, the proof, what's still owed (Mason's click-through on the preview, the Sol merge gate, CodeRabbit for money packages) and a suggested merge order.
