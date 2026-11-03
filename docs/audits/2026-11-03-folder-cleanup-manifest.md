# Folder cleanup manifest — 2026-11-03 (PHASE 1: inventory only)

**Status:** SAFE LIST EXECUTED 2026-11-03 on Mason's approval ("Yes, safe list"); see "Execution result" at the end. The other lists are untouched. Nothing was changed on the live database.
**Taken:** 2026-11-03, about 10:00–10:45 AM Central, from `origin/main` at `5c121e0b2`, after `git fetch --prune`.

## Summary

| Count | What |
|---|---|
| 61 | registered git worktrees (including `C:\CRX_Manager` itself) |
| 1 | standalone clone that is not a worktree (`C:\CRX_apply_1181`) |
| 49 | **SAFE TO DELETE** (work fully landed; table below) |
| 5 | **LIVE — do not touch** (a running session or the main checkout) |
| 5 | **SAFE ONLY AFTER** their idle-but-open session is archived |
| 3 | **KEEP / ACTION FIRST** (uncommitted work or notes, or a folder other sessions depend on) |
| 0 | git stashes (the shared stash list is empty) |
| 1 | migration that exists only in a folder and is not applied (`20261104150000`, open PR #1342, live session) |
| 31,097 | leftover test folders `%TEMP%\crx-*` (not worktrees; 1 exception listed in the safe table) |

**How "landed" was proven (not by git ancestry):** every GitHub PR (1,353) was pulled in one call. For 43 named branches, the folder's HEAD commit is *exactly* the final commit of a merged PR, so the squash merge carried everything committed there. For the 10 folders with no PR of their own, GitHub's "which PR contains this commit" lookup plus a local ancestry check shows each HEAD sits inside a merged PR's final commit. Uncommitted, untracked and git-ignored files were listed for every folder (`git status --porcelain --ignored`).

**The 3 things Mason must decide**

1. **Approve the deletion batch** (the 49 SAFE folders, then the 5 after their sessions are archived), using the backup-first plan at the end. Recommendation: yes.
2. **One unshipped wording fix** in `C:\CRX_apply_guidance`: a finished but never committed change that makes the Codex guard and the contract say a permission change always needs your approval, even when it looks routine. Recommendation: let an agent commit it and ship it as a small PR (it matches the rule already in force).
3. **The 31,097 leftover test folders in `%TEMP%`.** Recommendation: approve a careful removal script (skips any link/junction) plus a follow-up fix so the tests clean up after themselves.

## LIVE — do not touch

| Folder | Why |
|---|---|
| `C:\CRX_Manager` | Main checkout, behind `origin/main` (2 commits at the start of the audit, 4 by the end). 4 uncommitted files: `.codex/config.toml` (re-enables 4 Codex MCP server entries — a local machine setting; leave it) and 3 docs whose only difference is line endings. Never delete. |
| `C:\CRX_Manager\.claude\worktrees\ponytail-audit-simplify-799e9f` | This audit. |
| `C:\CRX_Manager\.claude\worktrees\crx-ki-10-ki-75-batch-4-af3f1a` | Parent session and the "48-hour Claude coaching review" session. |
| `C:\CRX_Manager\.claude\worktrees\pr-auto-merge-8e37ad` | Running session on **open PR #1342** (WP-PM-9). Holds the only copy outside GitHub of candidate migration `20261104150000_product_forms_seed_each.sql` — **not applied live** (checked the live migration list). Never delete. |
| `C:\CRX_Manager\.claude\worktrees\quizzical-wing-6e4e27` | Running session. Its PR #1345 merged at 10:03 AM Central today; its migration `20261104140000` was applied live at 10:02 AM Central (see Undocumented item 1). |

## SAFE ONLY AFTER the session is archived

All five have nothing unique committed, but an open (idle) app session still points at the folder. Archive the session first, then treat the folder as SAFE.

| Folder | Session | Evidence |
|---|---|---|
| `C:\CRX_Manager\.claude\worktrees\wonderful-herschel-f7386b` | "1345-Product Master Wave 2 completion" (idle) | detached HEAD inside merged #1345; has a `node_modules` junction to `C:\CRX_Manager\node_modules` |
| `C:\CRX_Manager\.claude\worktrees\goofy-gauss-3449d8` | "Wave 1/2 manual work before wave 3" (idle) | HEAD already in main |
| `C:\CRX_Manager\.claude\worktrees\zealous-dewdney-029159` | "Taha PR review" (idle; reviews Taha's open PR #1350) | HEAD already in main |
| `C:\CRX_Manager\.claude\worktrees\adoring-feynman-d9d31d` | "1365-WP-PM-12b corrections…" (idle) | HEAD = final head of #1366 (merged) |
| `C:\CRX_order_concurrency` | "Check #crx-alerts went quiet" (idle since 10-30) | HEAD = final head of #1191 (merged) |

## KEEP / ACTION FIRST

| Folder | What is unique | Last session's state | Exact step |
|---|---|---|---|
| `C:\CRX_apply_guidance` (branch `codex/reconcile-apply-guidance`, no PR) | 5 modified files (`AGENTS.md`, `.claude/commands/ship.md`, `.codex/hooks/production-action-guard.mjs`, `docs/manual/OWNER_PLAYBOOK.md`, `docs/reference/agent-guardrails.md`) + 1 new changelog note. None of it is in main (main still has the old sentence). | **Finished but never shipped.** Codex (11-01) reported the guard test passing and the wording done, then stopped; nothing was committed. Not recorded anywhere. | Commit on its branch, push the branch as a backup, open a small PR (guard + guidance change: off the Sol list; Luna + green checks). Then the folder is SAFE. |
| `C:\CRX_review_thread_reply` (branch `codex/review-thread-replies-20261030`, no PR) | 3 modified files + 1 new changelog note: a narrow guard exception letting Codex post a reply on a review comment. Not in main. | **Abandoned mid-task** (the 10-30 session ended in a context "thrashing" error after a reviewer listed missing negative tests). **Superseded by policy:** since 10-29 a reply on a review thread is optional, so the reason for the exception is gone. | Save the patch (`git diff` + untracked file) into the backup folder; no PR. Then SAFE. |
| `C:\CRX_harness_parity` (detached, in main) | 22 ignored `harness-*.local` working notes from merged PR #1222 (up to 1.1 MB each). | Finished and landed. A memory note records that sessions *started* in this folder run their guards from it, and an earlier session said not to delete it while such sessions exist. No open session uses it today. | Zip the notes into the backup (the standard plan does this), confirm no open session lists this folder, then SAFE. |

## SAFE TO DELETE (49)

All clean (no uncommitted or untracked files) unless stated, no stash, no unique migration. "Ignored extras" are git-ignored files that will go into the backup zip first; `.claude/session-state/`, `.claude/tmp/`, `.codex/agents/` and `.impeccable/hook.cache.json` exist in most folders and are also zipped.

| Folder | Branch | Evidence it landed | Tree | Ignored extras |
|---|---|---|---|---|
| `C:\CRX_agents_contract` | `codex/tighten-agents-contract-20261029` | HEAD = final head of #1217 (merged) | clean | INV-2026-0002.pdf |
| `C:\CRX_baseline_proof` | `(detached)` | HEAD already in main | clean | INV-2026-0002.pdf |
| `C:\CRX_baseline_push` | `claude/baseline-push-steps` | HEAD = final head of #1244 (merged) | clean | - |
| `C:\CRX_chicago_document_numbers` | `claude/post-land-1179-1181` | HEAD = final head of #1228 (merged) | clean | .playwright-cli/, INV-2026-0002.pdf, output/ |
| `C:\CRX_chicago_payment_date` | `codex/chicago-payment-date-20261028` | SUPERSEDED, 2 commits on no remote: an earlier draft (84% similar) of the migration that shipped as 20261029160200 in #1179 and is applied live; its audit doc and smoke script are in main. Never apply its 20261028175551 file | clean | - |
| `C:\CRX_clean_merge_review` | `claude/clean-merge-needs-completed-review` | HEAD = final head of #1213 (merged) | clean | - |
| `C:\CRX_codex_harness_check` | `(detached)` | HEAD already in main | clean | INV-2026-0002.pdf |
| `C:\CRX_driver_exception` | `(detached)` | no PR of its own; HEAD inside #1178 final head (merged) | clean | .playwright-cli/, INV-2026-0002.pdf |
| `C:\CRX_false_unsaved_prompt` | `claude/fix-false-unsaved-prompt` | HEAD = final head of #1243 (merged) | clean | INV-2026-0002.pdf |
| `C:\CRX_faster_hooks` | `claude/faster-hooks-20261102` | HEAD = final head of #1311 (merged) | clean | - |
| `C:\CRX_field_new_retry` | `claude/field-new-retry-no-duplicate` | HEAD = final head of #1249 (merged) | clean | INV-2026-0002.pdf |
| `C:\CRX_harness_reduce` | `claude/reduce-harness-20261030` | HEAD = final head of #1224 (merged) | clean | - |
| `C:\CRX_inventory_flake` | `claude/fix-inventory-retry-flake` | HEAD = final head of #1211 (merged) | clean | - |
| `C:\CRX_invoice_delivered_caps` | `codex/invoice-delivered-caps-20261028` | HEAD = final head of #1174 (merged) | clean | INV-2026-0002.pdf, output/ |
| `C:\CRX_ki95_ar_aging` | `claude/ki95-applied-docs` | HEAD = final head of #1322 (merged) | clean | - |
| `C:\CRX_land_1165` | `codex/land-pr1165` | no PR of its own; HEAD inside #1187 final head (merged; replaced closed #1165) | clean | - |
| `C:\CRX_land_1167` | `codex/land-pr1167` | no PR of its own; HEAD inside #1167 final head (merged) | clean | - |
| `C:\CRX_local_app_port` | `claude/local-app-frontend-port` | HEAD = final head of #1309 (merged) | clean | scripts/local-app/.state/ |
| `C:\CRX_major_work_20261101` | `claude/major-work-20261101` | HEAD already in main | clean | - |
| `C:\CRX_Manager\.claude\worktrees\batch4b-followups` | `claude/stale-prover-last-migration-asserts` | HEAD = final head of #1339 (merged) | clean | - |
| `C:\CRX_Manager\.claude\worktrees\codex-land-1165-final` | `codex/land-pr1165-final` | no PR of its own; HEAD inside #1187 final head (merged) | clean | - |
| `C:\CRX_Manager\.claude\worktrees\codex-land-1167-fix` | `codex/land-pr1167-fix` | no PR of its own; HEAD inside #1167 final head (merged) | clean | - |
| `C:\CRX_Manager\.claude\worktrees\great-heyrovsky-547a0b` | `(detached)` | HEAD already in main | clean | - |
| `C:\CRX_Manager\.claude\worktrees\pm5-land` | `chore/pm5-registry-refresh` | HEAD = final head of #1343 (merged) | clean | - |
| `C:\CRX_Manager\.claude\worktrees\pr-1316-status-bbcf4d` | `(detached)` | detached; HEAD = #1358 final head (merged) | clean | - |
| `C:\CRX_Manager\.claude\worktrees\smoke-pricing-free` | `claude/smoke-pricing-free-products` | HEAD = final head of #1308 (merged) | clean | output/ |
| `C:\CRX_order_sweep_guard` | `codex/order112-sweep-guard-fix-20261028` | HEAD = final head of #1186 (merged) | clean | - |
| `C:\CRX_payment1179_landing` | `codex/chicago-payment-retry-intent-20261028` | HEAD = final head of #1179 (merged) | clean | output/ |
| `C:\CRX_payment_retry_intent` | `codex/driver-exception-details-20261028` | HEAD = final head of #1178 (merged) | clean | INV-2026-0002.pdf, docs/audits/2026-10-29-codex-to-claude-five-pr-landing-handoff.md, output/ |
| `C:\CRX_pm_land` | `pm/wp-pm-11b-list-editing` | HEAD = final head of #1255 (merged) | clean | INV-2026-0002.pdf, scripts/local-app/.state/ |
| `C:\CRX_PMBuild` | `pm/wp-pm-3-lows` | HEAD = final head of #1321 (merged) | clean | INV-2026-0002.pdf, scripts/local-app/.state/ |
| `C:\CRX_PMBuild_w2r2` | `(detached)` | detached; HEAD inside #1316 final head (merged) | clean | INV-2026-0002.pdf |
| `C:\CRX_PMDb` | `pm/wp-pm-3-db-guard` | HEAD = final head of #1315 (merged) | clean | INV-2026-0002.pdf |
| `C:\CRX_precommit_deps` | `claude/precommit-deps-fail-fast` | HEAD = final head of #1312 (merged) | clean | - |
| `C:\CRX_product_master_launch` | `claude/product-master-launch-setup` | HEAD = final head of #1236 (merged) | clean | - |
| `C:\CRX_product_plan_review` | `codex/product-plan-final-answers-20261030` | HEAD = final head of #1227 (merged) | clean | - |
| `C:\CRX_quote_csv` | `codex/quote-order-quoted-fields` | HEAD = final head of #1177 (merged) | clean | .playwright-cli/, output/ |
| `C:\CRX_relax_gates` | `claude/relax-review-gates-20261029` | HEAD = final head of #1206 (merged) | clean | - |
| `C:\CRX_shared_docs` | `(detached)` | HEAD already in main | clean | - |
| `C:\CRX_ship_wait` | `claude/ship-wait-for-clean-review` | HEAD = final head of #1261 (merged) | clean | - |
| `C:\CRX_SlackAlerts` | `claude/sentry-free-alerts` | HEAD = final head of #1219 (merged) | clean | - |
| `C:\CRX_takeover_1179` | `codex/takeover-1179-20261031` | no PR of its own; HEAD inside #1179 final head (merged) | clean | INV-2026-0002.pdf |
| `C:\CRX_takeover_1181` | `codex/takeover-1181-20261031` | no PR of its own; HEAD inside #1181 final head (merged) | clean | INV-2026-0002.pdf |
| `C:\CRX_vercel_skip` | `ship/vercel-skip-docs-builds` | HEAD = final head of #1175 (merged) | clean | - |
| `C:\CRX_workflow_map` | `claude/workflow-map-stable-date` | HEAD = final head of #1212 (merged) | clean | - |
| `C:\CRX_wp_pm_0` | `claude/wp-pm-0-local-app` | HEAD = final head of #1241 (merged) | clean | INV-2026-0002.pdf, scripts/local-app/.state/ |
| `C:\Projects\crx-impeccable-gitignore` | `chore/impeccable-gitignore` | HEAD = final head of #1199 (merged) | clean | - |
| `C:\Users\mason\AppData\Local\Temp\crx-plugin-note` | `docs/claude-user-plugins-note` | HEAD = final head of #1204 (merged) | clean | - |
| `C:\CRX_apply_1181` | `codex/chicago-document-numbers-20261028` | standalone clone (own .git, not a worktree); only branch is inside #1181 final head; no stash | clean | - |

Notes on the safe list:

- `C:\CRX_chicago_payment_date` is the only safe folder holding commits that exist nowhere else (its GitHub branch was deleted). They are superseded, and the git bundle keeps them anyway.
- `C:\CRX_payment_retry_intent` holds an ignored handoff doc (`docs/audits/2026-10-29-codex-to-claude-five-pr-landing-handoff.md`) that is not in main. All five PRs it hands over (#1174, #1177, #1178, #1179, #1181) merged, so it is history only; the zip keeps it.
- `INV-2026-0002.pdf` sits in 24 folders and every copy is different (generated invoice PDFs, ignored by `.gitignore`). Treat them as possibly holding customer data: keep the backup zip on this PC only, never in a repo.
- The fleet report's "PARKED STATE UNKNOWN" flag names `CRX_major_work_20261101`, `CRX_PMBuild` and `CRX_wp_pm_0`. None of the three has a migration file on disk that is missing from `origin/main`, so they hold no parked SQL; the flag is about the record cross-check, not about these folders.

## Other folders found (not CRX worktrees)

| Folder | What it is | Recommendation |
|---|---|---|
| `C:\CRX_record_1174_1178` | Empty folder | Safe to remove (empty). |
| `C:\Users\mason\.claude\worktrees\gauntlet-runner`, `...\proof-timeout` (July) | Each holds only `CRX_Manager\node_modules`, a **junction to the live `C:\CRX_Manager\node_modules`** | Safe, but only by removing the junction first (`cmd /c rmdir`), never a recursive delete. |
| `C:\Users\mason\.codex\worktrees\codex-guard-false-blocks`, `slim-agent-contract`, `todo-completed-cleanup`, `farmrx-v2-backlog` | Empty Codex leftovers (a name file or empty folder) | Safe to remove. |
| `C:\Users\mason\.codex\worktrees\hermes-v1-*` (29 folders, Aug 31) | Codex experiments with a small sample project; not CRX | Out of scope; leave unless Mason wants them gone. |
| `C:\Projects\REA`, `C:\Projects\_external\mimik`, `C:\Projects\dot-work-notes-proposal`, `C:\Projects\ChemMan-Walkthroughs` | Separate projects or notes (one active today) | Out of scope; leave. |

## Migrations that live only in a folder

| Migration | Where | Live status (read-only check of the live migration list today) | Action |
|---|---|---|---|
| `20261104150000_product_forms_seed_each.sql` | `pr-auto-merge-8e37ad` + open PR #1342 | Not applied | Keep; owned by the running WP-PM-9 session. |
| `20261028175551_chicago_payment_business_date.sql` | `C:\CRX_chicago_payment_date` | Never applied; its replacement `20261029160200` is applied | Superseded. Never apply. Kept in the bundle only. |

No other folder has a `.sql` under `supabase/migrations/` or `scripts/.staging-migrations/` that is missing from `origin/main`. The six old `scripts/.staging-migrations/` drafts the fleet report lists are in `origin/main` and untouched by this cleanup.

## Remote branches on GitHub (37, after prune)

- **Delete later (PR merged):** `claude/reduce-harness-20261030` (#1224), `claude/vendor-bill-overage-test-flake-20261021` (#994), and `pm/wp-pm-7-cost-path` (#1345, merged today; wait until its running session ends).
- **Leave (PR closed unmerged, 17):** `claude/audit-brace-expansion-fast-uri`, `claude/autopilot-recursive-delete-alias-20260907`, `claude/invoice-screen-safety-20261009`, `claude/invoicing-admin-only-db-20261010`, `claude/last-charged-prices-applied-records`, `claude/pricing-audit-strategy-jym8rr`, `claude/rep-scope-order-invoices`, `claude/return-credit-chain-applied-2026-09-01`, `claude/sweep-rekey-batch4b`, `claude/wonderful-banach-755ecb`, `claude/work-efficiency-analysis-e8d5a2`, `codex/actor-binding-mixed-notation-repair-20260810`, `codex/pr389-coderabbit-fixes`, `gk/return-credit-prover-baseline`, `ops/integrity-report-2026-11-01`, `pr1165-current`, `taha/alerts-ready-prs-and-previews`.
- **Leave (no PR, 11):** `backup/pr432-multitarget-20260825`, `claude/adjust-inventory-control-char-keys-20260920`, `claude/amazing-perlman-6a5fe2`, `claude/autopilot-recursive-delete-alias-local-a56fef0`, `claude/control-file-coverage-a41c`, `claude/invoicing-admin-only-20261009`, `claude/pr364-guard-commits-local-20260831`, `codex/land-pr1167-fix`, `loop/product-master-2026-10`, `loop/product-master-w1-r1-2026-11-01`, `loop/product-master-w2-r2-2026-11-02`.
- **Open PRs:** #1342 (Mason, session live). Taha's #1350, #1360, #1362 and #1363 have no folder here because Taha works on his own machine; owner known, nothing to do.

Local branches are not touched by `git worktree remove`; the cleanup hook reports 169 local branches it keeps. A local-branch sweep is a separate job.

## Docker (report only; never prune)

Running: the local app stack `crx-local-app-*` (5 containers), the `supabase_*_crxpicker` stack (7) and `portainer`. Stopped test databases: `crx-cc-freeze-56080-mvzkqzou`, `crx-order-cap-edge-regression-20261030`, `crx-order-cap-7564-mvuhg9ys`, `crx-order-cap-13208-mvugyws3`, `crx-order-cap-25996-mvugg0gu`. These five could be removed one by one by name later, with Mason's OK.

## UNDOCUMENTED ITEMS (add to docs or memory)

1. **Migration `20261104140000_pricing_tier_order_warning` is applied live (10:02 AM Central today, ledger version `20261103160227`), but `origin/main` still records it as "LOCAL CANDIDATE — NOT APPLIED"** (`docs/reference/migrations.d/20261104140000_pricing_tier_order_warning.md` and the SQL header). The WP-PM-7 session is still running and may be recording it now; if not, a record PR is needed. The schema registry is also behind the applied `20261104120000` (session-staleness warning) and needs `regen-schema-registry`.
2. **Unshipped guard wording fix in `C:\CRX_apply_guidance`** (decision 2 above). Not in KNOWN_ISSUES, CURRENT_STATE or memory.
3. **Abandoned review-comment-reply exception in `C:\CRX_review_thread_reply`**: superseded by the 10-29 "reply is optional" rule. Record that it was dropped on purpose.
4. **Test temp-folder leak:** 31,097 `%TEMP%\crx-*` folders from the last 8 days, mainly `crx-factory-owner` (16,466) and `crx-applylib` (10,727), git repos made by tests that never delete them. Some prefixes (`crx-jctparent`, `crx-linked`, `crx-sibling`) suggest junction fixtures, so a plain recursive delete is unsafe. Not recorded anywhere.
5. **Chained `node_modules` junctions between worktrees:** `C:\CRX_PMDb` points at `C:\CRX_PMBuild\node_modules`, `C:\CRX_ship_wait` at `C:\CRX_field_new_retry\node_modules`, and `wonderful-herschel-f7386b` at the live `C:\CRX_Manager\node_modules`. The memory note only mentions junctions to `C:\CRX_Manager`.
6. **Generated invoice PDFs in folder roots** (`INV-2026-0002.pdf`, 24 different copies). Ignored by git, but they spread with every worktree.
7. **The worktree-cleanup hook deleted a local branch during this read-only audit** (`claude/hungry-knuth-421942`, merged; recover with `git branch claude/hungry-knuth-421942 e6e950689`). Known behaviour; noted so nobody thinks this audit deleted it.
8. **`C:\CRX_apply_1181` is a full separate clone**, not a worktree, so `git worktree list` and the fleet report never show it. Its remote branch list is stale.

## Deletion plan for later (needs Mason's yes in this session)

Order: SAFE list first; the five "after archive" folders once their sessions are archived; ACTION FIRST folders only after their step is done. For each folder, in order:

1. **Re-check it is unchanged since this manifest** (counts here are a snapshot: `origin/main` moved 4 commits during the audit): same HEAD commit, `git status --porcelain` empty (or the same known files), no session lists it as its folder.
2. **Back up** into `C:\CRX_Backups\cleanup-2026-11-03\<folder-name>\`:
   - Named branch: `git -C <folder> bundle create <backup>\repo.bundle HEAD <branch>`. Detached folder: `... bundle create <backup>\repo.bundle HEAD` (no branch name). Then `git bundle verify`; a failure stops that folder.
   - A zip of every uncommitted, untracked and ignored file except `node_modules`, `dist` and build caches. First write the file list (`files.txt`), then compare the zip's contents against it. Any missing file stops that folder's deletion. This matters most for `C:\CRX_payment_retry_intent` (ignored handoff doc), the `INV-*.pdf` copies and the `harness-*.local` notes.
   - For `C:\CRX_review_thread_reply` and `C:\CRX_apply_guidance`: also `git diff > changes.patch`.
3. **Remove any `node_modules` link first** with `cmd /c rmdir <folder>\node_modules` (removes only the link). Remove `CRX_PMDb` before `CRX_PMBuild` and `CRX_ship_wait` before `CRX_field_new_retry`.
4. **Registered worktrees:** `git -C C:\CRX_Manager worktree remove <folder>` (never `--force` on a dirty tree, never `rm -rf`). Do **not** run `git worktree prune` in this batch: it acts on all 61 registrations, not just the one removed. Look into any orphaned registration separately.
5. **Non-worktree folders** (`C:\CRX_apply_1181`, the empty leftovers): after the bundle, Mason deletes the folder himself (a guard blocks agent recursive deletes by design).
6. **Never** run `git clean`, bare `git stash`, `docker * prune`, or delete a remote branch whose PR is not merged.
7. **Remote branches:** only the three merged ones listed above, after Mason's OK.
8. **`%TEMP%\crx-*`:** separate script that skips every reparse point (junction or symlink) and only deletes folders older than 1 day; dry-run count first.

## Sol review

Codex `gpt-6-sol`, high effort, read-only, on 2026-11-03. Its brief was to find any folder marked safe that still holds unique work. Sol ran status checks on all 49 safe folders, the 5 archive-first folders, every detached or no-PR folder, the stash list, junction targets and the "Other folders" table. **No BLOCKER: it found no safe-listed folder holding unique work** beyond what this manifest already discloses.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | HIGH | The plan verified the git bundle but not the zip of ignored files (handoff doc, invoice PDFs). | **Fixed:** step 2 now lists the files first and checks the zip against the list; a mismatch stops that folder. |
| 2 | MED | `bundle create HEAD <branch>` has no branch for detached folders. | **Fixed:** step 2 gives the detached form (`HEAD` only) and requires `git bundle verify`. |
| 3 | MED | `git worktree prune` after each removal acts on every registration. | **Fixed:** prune removed from step 4. |
| 4 | LOW | The Chicago draft is an 84%-similar earlier draft, not an identical re-stamp. | **Fixed:** wording corrected; still superseded and kept in its bundle. |
| 5 | LOW | Counts are a snapshot: `origin/main` moved 4 commits during the audit, and there are 24 invoice PDF copies (the first count only scanned `C:\CRX_*`). | **Fixed:** counts corrected; step 1 re-checks every folder right before deletion. |

Sol could not run `gh` inside its sandbox, so it did not repeat the PR head checks or session ownership. Both were done in this session from GitHub's own data: every PR's final commit compared with each folder's HEAD, plus GitHub's commit-to-PR lookup for no-PR heads, and the app's live session list. Step 1 of the deletion plan re-checks both right before removal.

**Final status: READY FOR APPROVAL.** Nothing is deleted until Mason says yes in the audit session.

## Execution result (2026-11-03, about 10:45–11:30 AM Central)

Mason approved the SAFE list in the audit session. Steps 1–4 of the deletion plan ran per folder. A dry run came first; it caught a script bug where "stop" did not stop, which was fixed before anything ran. A one-folder trial came next.

- **Removed (46 worktrees)**, each with `git worktree remove`, without `--force`, prune, `git clean` or stash: every SAFE row except the three below.
- **Pulled from the batch at re-check (2):** `great-heyrovsky-547a0b` and `pr-1316-status-bbcf4d`. After the audit, new guard-fix sessions moved into them (new branches, uncommitted work). They are live and were left alone.
- **Backed up only:** `C:\CRX_apply_1181`, a standalone clone. Mason deletes the folder himself.
- **Backups:** `C:\CRX_Backups\cleanup-2026-11-03\<folder>\` holds 47 folders, 1.9 GB in all. Each has a `repo.bundle` (all pass `git bundle verify`) and, where there were ignored files, `ignored.zip` plus `files.txt`, with the zip listing matching the file list for every folder. Keep these on this PC only: they include generated invoice PDFs.
- **Live `C:\CRX_Manager\node_modules`:** 540 entries before and after. The `node_modules` links in `CRX_PMDb` and `CRX_ship_wait` were unlinked before their folders were removed, and their targets after.
- **Restore one folder:** `git clone <backup>\repo.bundle <new-folder>`, then unzip `ignored.zip` into it.

Still not done (separate approvals): the "after archive", "action first" and "other folders" lists, the three merged remote branches, Docker, and `%TEMP%\crx-*`.
