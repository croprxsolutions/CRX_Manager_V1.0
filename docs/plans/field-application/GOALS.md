# Field application: goal briefs

A **goal session** is one Claude session given one lane of one wave (`WAVES.md`) and left to run until that lane's definition of done. Each is launched with `/run-loop docs/loops/field-app-<wave>-<lane>.md`, which checks the five slots (driver, granularity, worktree, definition of done, delivery gate) and that no other session owns the worktree.

**Mason starts each goal.** Nothing in this kit starts one by itself.

## Rules every goal follows

1. **Read first:** `AGENTS.md`, Mason's answers in `MORNING-QUESTIONS.md`, the build sheet as folded in by 0.3, this folder's `SPEC.md`, `SCENARIOS.md`, the item's contract, and your own section of `PROGRESS.md`.
2. **What the kit is vs what the code is (Sol 122).** The kit describes the **desired** behavior; current code and live read-only evidence describe **today**. A difference the kit already names (planned vs sprayed acres, flat fees, the leftover cent) is the work, not a reason to stop. A difference the kit does not name, or a fact marked UNVERIFIED that turns out different, stops that item: record it in `PROGRESS.md` and move to the next independent item.
3. **Own only your files.** The brief lists them. A change you need elsewhere goes in `PROGRESS.md` under "Needs another lane" **with the owning lane named** (`WAVES.md` rule 3); the owner confirms it is done before your dependent item merges (Sol 125).
4. **One PR per item** (or a database PR then a screen PR for an item with screens; the next migration may start once the database PR is verified; Sol r2 107), into `staging`, from your own worktree. Money, stock, data, permission or lifecycle items: plan-contract first (the contracts here count once Sol has challenged them and Mason has answered their open decisions), answering every "must address" Sol ID in `WAVES.md`; then Luna until clean; then Sol before the PR opens; then every `ship.md` gate.
5. **Proof by environment (Sol 126):** database items run each covered scenario as SQL against a database migrated to the staging schema, **as the real roles** (admin, sales rep, applicator, tablet, customer), including the upgrade from current staging, never as the owner only. Screen items are checked on the real screen in the browser against staging. Expected vs observed goes in the PR. Tests you wrote yourself are not enough on their own. Never production.
6. **States (Sol 123):** each item is **merged** (in `staging`), **verified** (merged, applied on staging, its scenarios re-run there), **parked** (stopped with reason and both positions), or **blocked** (waiting on a named item or on Mason). A wave is done only when every item is **verified**. An item never starts while an item it depends on is parked or blocked.
7. **Stop at once, no retry (Sol 124):** the same BLOCKER or HIGH survives two fix rounds; any change to live data you did not intend; a gate needs Mason; ownership of a file or function is unclear; a migration cannot be rolled back as its contract says; a guard refuses and the reason is not understood. Write it in `PROGRESS.md`, as `NEEDS MASON - ...` where Mason must act, and say it in the session's closing message too: an approval never waits only in a file (Sol r2 124). A proof that is older than the current head is refreshed, not a stop.
8. **Mason's field rule:** flags and notes, not blocks. A finding that would add a crew or office step goes to Mason, not into code.
9. **Update your own section of `PROGRESS.md`** at the end of every item (PR link, proof, state).

## Delivery gate (all goals)

- **Allowed without asking:** branches, commits, pushes of feature branches **after the item's local checks and Luna pass on that head** (Sol r2 119), PRs into `staging`, and merging into `staging` **only** under AGENTS.md › Autonomous landing: a clean Sol proof covering the PR's current head (when on the Sol list), Luna clean, every required check green, no review asking for changes, and the Taha hold rules in `ship.md` (Sol 119).
- **Never without Mason's explicit yes in his own conversation (Sol 120, 128):** every `I approve` gate in the fields-who-pays build sheet (FP-1's delete foreign-key change and revoked grants, FP-4 and FP-5a grant changes), any login, role or permission change **even inside a reviewed migration** (the tablet account), anything into `main`, applying a migration to production, deleting or rewriting live data, deploying an Edge Function (the invoice PDF), turning on the batch or posting switch in production, changing secrets, force-push.
- **Never:** pushing to Taha's PRs; touching Taha's areas before 2026-12-15 (holds, shared posting, credit memos, quotes, bookings).

## Release evidence (Sol 130)

A wave's release to production records: the release PR and its merge commit; each migration's name and the live ledger showing it applied; the deployed app version; the Edge Function version if changed; a smoke run of the wave's main path as a real role; the rollback point; and who watches errors for the first day. Taha or Mason merges; Claude applies migrations only through the apply-proof gate.

## The goals

| Wave | Lane | Mission doc | Items | Can run beside |
|---|---|---|---|---|
| 1 | DB | `docs/loops/field-app-w1-db.md` | 1.1 FP-1 → 1.2 FP-2 → 1.3 batches and stock | W1 paperwork |
| 1 | UI-A | `docs/loops/field-app-w1-paperwork.md` | 1.4 paperwork fixes | W1 DB |
| 2 | DB | written when wave 1 ends | 2.1 → 2.2 → 2.3 | W2 mixer, W2 phone |
| 2 | UI-A | written when wave 1 ends | 2.4 mixer tablet | W2 DB, W2 phone |
| 2 | UI-B | written when wave 1 ends | 2.5 applicator phone | W2 DB, W2 mixer |
| 3–6 | | written at the end of the previous wave, from `WAVES.md` | | |

Later briefs are written at the end of the wave before, so they start from what was really built, not from this plan's guesses.
