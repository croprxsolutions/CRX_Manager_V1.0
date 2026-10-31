# Product Master work: START HERE

**Status: PLANNED AND READY, NOT STARTED.** On 2026-10-28 Mason planned the Product Master (product setup) improvements and the weight-per-gallon and active-ingredient work. He had a Sol review settle the game plan, then set up an overnight build. He decided not to start it yet ("let's not actually start the build yet") and asked for everything to be saved so the work can be picked up later. Nothing is built.

**To start the work:** open a new Code session in the CRX Manager project (new worktree) and paste the prompt in section 4. Do the checks in section 3 first.

---

## 1. The documents (all on `main`)

| What | File | Read it for |
|---|---|---|
| **The grand plan (2026-10-29)** | `docs/plans/2026-10-29-product-GRAND-PLAN.md` | All product work in one order: this Product Master work is Stage 1; weight, chemistry, brands, rates, comparison, use guidance, families, clean-up and images follow. Sol-reviewed; it revised the build sheet's order |
| The 43 items | `docs/plans/2026-10-28-product-master-setup-edits-BACKLOG.md` | What's wrong or missing on product setup: Mason's requests (items 1–2) and the review's findings (items 3–43) |
| **The game plan** | `docs/plans/2026-10-28-product-master-BUILD-SHEET.md` | 21 queue entries, including both halves of WP-PM-15: approach, "Done when", size, database impact, Sol's notes, the final order (section 4) and the Sol review record (section 6) |
| **The build loop** | `docs/plans/2026-10-28-product-master-loop-MISSION.md` | How a session builds it: Codex builds, Claude checks and proves, one draft PR per package, nothing merged or applied live. Passes `node scripts/validate-mission-doc.mjs` |
| Weight per gallon and active ingredients | `docs/plans/2026-10-28-product-data-model-REFRESH.md` | The larger feature that follows (To-Do row 2.9), refreshed from the August plan |
| Mason's decisions | `docs/manual/DECISION_LOG.md`, the three 2026-10-28 entries (Product Master backlog; product data model) | Every business answer, so the build needs no owner input |
| To-Do list | `docs/manual/TO_DO_LIST.md`, row 2.9 | Where the weight/ingredient work ranks (SHOULD, after the before-delivery work) |

The old branch `loop/product-master-2026-10` holds a superseded first draft of the mission file; ignore it. The `main` copy above is the one to use.

## 2. What was decided (summary; the decision log is authoritative)

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
  3. "Search EPA labels" link
  4. pricing page
  5. sales sheet and list
  6. change history
  7. turning products off safely
  8. setup checks in the database
  9. forms, units and containers
  10. data clean-up review lists (forms, SKUs, duplicates)
  11. Use Timing
  12. the Unit audit
  13. new-product flow and basic Duplicate
  14. one cost path and the tier-order warning
  15. vendors on the product page
  16. setup workbook and the "Lock rates" switch
  17. bulk import
  18. list editing
  19. corrections to existing records
  20. reorder display
- **Pace:** an 8-hour run will probably finish 6–10 packages properly; the rest queue for another run.
- **Parked for Mason:**
  - the Unit back-fill: Sol's BLOCKER, so audit only, and Mason sees the mismatch list first;
  - the data clean-up itself: Mason types the missing SKUs and approves each fix. Dependent packages may be parked until their prerequisites are available and the data step is done;
  - the vendor-link review and live data transition before the preferred-vendor copy rule is enabled;
  - average purchase-cost tracking for shop-filled totes until the separate inventory-costing foundation has been reviewed, approved where required and activated; the quantity-only first release is planned after PAR-2;
  - any migration that changes grants on `products`, which needs his `I approve`.
- **The morning report** lists, per package: the PR, the proof, what's still owed (including real app proof and applicable Sol gate), and a suggested merge order. CodeRabbit is required only when labeled.
